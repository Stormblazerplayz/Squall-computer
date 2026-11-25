using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace Squall.Link.Uno
{
    /// <summary>Settings for <see cref="UnoHub"/>. The defaults are what Squall uses; tests swap in fakes.</summary>
    public sealed class UnoHubOptions
    {
        /// <summary>Runs docker (default: a real process).</summary>
        public ICommandRunner? Runner { get; set; }
        /// <summary>The Messages API (default: the Anthropic SDK).</summary>
        public IUnoModel? Model { get; set; }
        public Func<DateTimeOffset>? Clock { get; set; }
        /// <summary>Reads SQUALL_UNO_KEY (default: the environment).</summary>
        public Func<string?>? EnvKey { get; set; }
        public string DockerProgram { get; set; } = "docker";
        public string ModelName { get; set; } = UnoHub.DefaultModel;
        /// <summary>Time between live frames (about 4 a second).</summary>
        public TimeSpan FrameInterval { get; set; } = TimeSpan.FromMilliseconds(250);
        /// <summary>How long a phone's frame request keeps the screen streaming.</summary>
        public TimeSpan PhoneWatch { get; set; } = TimeSpan.FromSeconds(15);
        public TimeSpan ComputerReadyTimeout { get; set; } = TimeSpan.FromSeconds(90);
        public TimeSpan ComputerReadyPoll { get; set; } = TimeSpan.FromMilliseconds(500);
        /// <summary>Stop (not remove) the computers when Squall closes, so they don't use memory in the background.</summary>
        public bool StopComputersOnDispose { get; set; } = true;
    }

    /// <summary>
    /// Squall Uno: the agents' own computers and the computer-use sessions running on them. One request format for the
    /// Squall window and the phone (docs/squall-uno.md): <see cref="HandleAsync"/> answers every op with a JSON object;
    /// a failed op answers {ok:false, error:"plain sentence"}. Pushes for the window come out of the events below.
    /// </summary>
    public sealed partial class UnoHub : IAsyncDisposable
    {
        public const string DefaultModel = "claude-opus-5-5";
        public const int MaxTaskChars = 4000;
        public const int RecentConversations = 10;

        private readonly object _lock = new();
        private readonly UnoHubOptions _o;
        private readonly Func<DateTimeOffset> _clock;
        private readonly IUnoModel _model;
        private readonly bool _ownsModel;
        private readonly UnoStore _store;
        private readonly UnoEventLog _log;
        private readonly UnoFrames _frames;
        private readonly Dictionary<string, Run> _runs = new();
        private readonly Dictionary<string, DateTimeOffset> _phoneAsked = new();
        private readonly Dictionary<string, SemaphoreSlim> _gates = new();
        private string? _watched;
        private bool _dockerReady;
        private string _dockerText = "Checking Docker…";
        private bool _imageReady;
        private DateTimeOffset _dockerAt = DateTimeOffset.MinValue;
        private Task? _refreshing;
        private bool _disposed;

        public DockerDesktops Docker { get; }
        public UnoKeyStore Keys { get; }

        /// <summary>Every new event (push "uno").</summary>
        public event Action<UnoEvent>? EventAdded;
        /// <summary>A computer, session or setting changed (push "unoState").</summary>
        public event Action? Changed;
        /// <summary>A new frame of the computer the window watches (push "unoFrame").</summary>
        public event Action<string, UnoFrame>? WatchedFrame;

        public UnoHub(string folder, UnoHubOptions? options = null)
        {
            _o = options ?? new UnoHubOptions();
            _clock = _o.Clock ?? (() => DateTimeOffset.UtcNow);
            if (_o.Model != null) _model = _o.Model;
            else { _model = new AnthropicUnoModel(); _ownsModel = true; }
            Docker = new DockerDesktops(_o.Runner ?? new ProcessCommandRunner(), folder, _o.DockerProgram)
            {
                ReadyTimeout = _o.ComputerReadyTimeout,
                ReadyPoll = _o.ComputerReadyPoll,
            };
            Keys = new UnoKeyStore(folder, _o.EnvKey);
            _store = new UnoStore(folder);
            _store.Load(NowMs);
            _log = new UnoEventLog(NowMs);
            _frames = new UnoFrames(Docker, FramesNeeded, OnFrame, _clock, _o.FrameInterval);
        }

        private long NowMs => _clock().ToUnixTimeMilliseconds();

        // ===================================================================== Ids

        /// <summary>"pc-" + agentId, lower-cased, anything outside [a-z0-9-] turned into "-", at most 40 characters.</summary>
        public static string ComputerIdFor(string agentId)
        {
            var sb = new StringBuilder("pc-");
            foreach (char c in (agentId ?? "").ToLowerInvariant())
                sb.Append((c is >= 'a' and <= 'z') || (c is >= '0' and <= '9') || c == '-' ? c : '-');
            string id = sb.ToString();
            return id.Length > 40 ? id.Substring(0, 40) : id;
        }

        private static string NewSessionId() => "uno-" + Convert.ToHexString(RandomNumberGenerator.GetBytes(6)).ToLowerInvariant();

        // ===================================================================== Ops

        /// <summary>Answers one op (docs/squall-uno.md). fromPage is true for the Squall window, false for a phone.</summary>
        public async Task<JsonObject> HandleAsync(JsonObject request, bool fromPage, CancellationToken ct = default)
        {
            if (request == null) return Fail("That request was broken.");
            string op = Str(request, "op");
            try
            {
                if (_disposed) throw new UnoException("Squall is closing.");
                if (op != "check") RefreshDockerIfOld();
                switch (op)
                {
                    case "state": return StateOp(request);
                    case "start": return await StartOp(request, ct).ConfigureAwait(false);
                    case "message": return await MessageOp(request, ct).ConfigureAwait(false);
                    case "stop": return StopOp(request);
                    case "stopAll": return new JsonObject { ["ok"] = true, ["stopped"] = StopAll("Stopped.") };
                    case "takeover": return TakeoverOp(request);
                    case "input": return await InputOp(request, ct).ConfigureAwait(false);
                    case "handback": return HandbackOp(request);
                    case "computerOff": return await ComputerOffOp(request, ct).ConfigureAwait(false);
                    case "saveKey":
                        Keys.Save(Str(request, "key"));
                        RaiseChanged();
                        return new JsonObject { ["ok"] = true, ["settings"] = Settings() };
                    case "removeKey":
                        Keys.Remove();
                        RaiseChanged();
                        return new JsonObject { ["ok"] = true, ["settings"] = Settings() };
                    case "check": return await CheckOp(ct).ConfigureAwait(false);
                    case "setMaxSteps": return SetMaxStepsOp(request);
                    case "watch": return WatchOp(request, fromPage);
                    default: return Fail("Squall Uno doesn't know that request.");
                }
            }
            catch (UnoException ex) { return Fail(ex.Message); }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { return Fail("That was cancelled."); }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                return Fail("Something went wrong: " + ComputerActions.Short(ex.Message, 140));
            }
        }

        private static JsonObject Fail(string error) => new() { ["ok"] = false, ["error"] = error };

        private static JsonObject Ok() => new() { ["ok"] = true };

        private static string Str(JsonObject o, string key) => UnoSession.Str(o, key);

        private JsonObject StateOp(JsonObject req)
        {
            long since = UnoSession.Long(req, "since") ?? 0;
            string sid = Str(req, "sessionId");
            var (events, last) = _log.Since(since, sid.Length > 0 ? sid : null, 300);
            var evs = new JsonArray();
            foreach (var e in events) evs.Add(e.ToJson());
            var o = new JsonObject { ["ok"] = true, ["settings"] = Settings() };
            lock (_lock)
            {
                o["computers"] = ComputersJson();
                o["sessions"] = SessionsJson();
            }
            o["events"] = evs;
            o["lastSeq"] = last;
            return o;
        }

        private async Task<JsonObject> StartOp(JsonObject req, CancellationToken ct)
        {
            string agentId = Str(req, "agentId").Trim();
            string agentName = Str(req, "agentName").Trim();
            string task = Str(req, "task").Trim();
            if (agentId.Length == 0 || agentId.Length > 64) return Fail("Pick which agent's computer to use.");
            if (task.Length == 0) return Fail("Say what Squall Uno should do.");
            if (task.Length > MaxTaskChars) return Fail($"That task is too long. Keep it under {MaxTaskChars} characters.");
            if (agentName.Length == 0) agentName = agentId == "chief" ? "Chief" : agentId;
            agentName = ComputerActions.Short(agentName, 40);
            if (!Keys.HasKey) return Fail("Add an Anthropic API key in Squall Uno's settings first.");
            await RequireDockerAsync(ct).ConfigureAwait(false);

            string cid = ComputerIdFor(agentId);
            Run run;
            lock (_lock)
            {
                var computer = _store.Computers.FirstOrDefault(c => c.Id == cid);
                if (computer == null)
                {
                    computer = new UnoComputer { Id = cid, AgentId = agentId, AgentName = agentName };
                    _store.Computers.Add(computer);
                }
                computer.AgentName = agentName;
                if (ActiveSessionOn(computer) != null) return Fail($"{computer.Name} is busy with another task. Stop it first, or send it a message.");
                var s = new UnoSession
                {
                    Id = NewSessionId(), ComputerId = cid, AgentId = agentId, AgentName = agentName, Task = task,
                    State = "starting", StartedAt = NowMs, Now = "Getting the computer ready",
                };
                _store.Sessions.Add(s);
                computer.SessionId = s.Id;
                run = new Run(s);
                run.Pending.Enqueue(task);
                _runs[s.Id] = run;
                TrimRunsLocked();
                _store.Save();
            }
            Log(run.S, "system", "start", "Started: " + ComputerActions.Short(task, 120));
            StartRun(run);
            RaiseChanged();
            return new JsonObject { ["ok"] = true, ["sessionId"] = run.S.Id, ["computerId"] = cid };
        }

        private async Task<JsonObject> MessageOp(JsonObject req, CancellationToken ct)
        {
            string sid = Str(req, "sessionId");
            string text = Str(req, "text").Trim();
            if (text.Length == 0) return Fail("Write a message first.");
            if (text.Length > MaxTaskChars) return Fail($"That message is too long. Keep it under {MaxTaskChars} characters.");
            Run? old;
            lock (_lock)
            {
                var s = Session(sid) ?? throw new UnoException("That task wasn't found.");
                _runs.TryGetValue(sid, out old);
                if (s.Active && old != null)
                {
                    old.Pending.Enqueue(text);
                    old.Touched = _clock();
                }
                else old = null;
            }
            if (old != null)
            {
                Log(Session(sid)!, "you", "message", text);
                RaiseChanged();
                return Ok();
            }

            // The session ended: carry on with the same conversation.
            if (!Keys.HasKey) return Fail("Add an Anthropic API key in Squall Uno's settings first.");
            await RequireDockerAsync(ct).ConfigureAwait(false);
            Run? previous;
            lock (_lock) _runs.TryGetValue(sid, out previous);
            if (previous != null)
            {
                try { await previous.Task.WaitAsync(TimeSpan.FromSeconds(15), ct).ConfigureAwait(false); }
                catch (TimeoutException) { return Fail("Squall Uno is still stopping. Try again in a moment."); }
            }
            Run run;
            bool fresh;
            lock (_lock)
            {
                var s = Session(sid) ?? throw new UnoException("That task wasn't found.");
                if (s.Active) throw new UnoException("That task is already running again.");
                var computer = _store.Computers.FirstOrDefault(c => c.Id == s.ComputerId);
                if (computer == null)
                {
                    computer = new UnoComputer { Id = s.ComputerId, AgentId = s.AgentId, AgentName = s.AgentName };
                    _store.Computers.Add(computer);
                }
                if (ActiveSessionOn(computer) != null) throw new UnoException($"{computer.Name} is busy with another task. Stop it first.");
                fresh = !_runs.TryGetValue(sid, out var kept) || kept.Messages.Count == 0;
                if (fresh)
                {
                    run = new Run(s);
                    _runs[sid] = run;
                    var sb = new StringBuilder();
                    sb.Append("Earlier you worked on this task: \"").Append(s.Task).Append("\"\n");
                    if (s.LastText.Length > 0) sb.Append("Last time you said: \"").Append(s.LastText).Append("\"\n");
                    sb.Append("\nNow the user says: ").Append(text);
                    run.Pending.Enqueue(sb.ToString());
                }
                else
                {
                    run = kept!;
                    run.Pending.Enqueue(text);
                }
                run.Touched = _clock();
                s.State = "starting";
                s.EndedAt = null;
                s.Error = null;
                s.Now = "Getting the computer ready";
                computer.SessionId = s.Id;
                TrimRunsLocked();
                _store.Save();
            }
            Log(run.S, "you", "message", text);
            if (fresh)
                Log(run.S, "system", "message", "Squall Uno doesn't have this task's earlier steps anymore (Squall restarted), so it starts fresh with the task as a reminder.");
            StartRun(run);
            RaiseChanged();
            return Ok();
        }

        private JsonObject StopOp(JsonObject req)
        {
            string sid = Str(req, "sessionId");
            Run? run;
            lock (_lock)
            {
                var s = Session(sid) ?? throw new UnoException("That task wasn't found.");
                if (!s.Active) return Ok();
                _runs.TryGetValue(sid, out run);
            }
            if (run != null) StopRun(run, "Stopped.");
            return Ok();
        }

        /// <summary>Stops every running session (computers stay on). Returns how many.</summary>
        private int StopAll(string why)
        {
            List<Run> active;
            lock (_lock) active = _runs.Values.Where(r => r.S.Active).ToList();
            int n = 0;
            foreach (var r in active)
                if (StopRun(r, why)) n++;
            return n;
        }

        private bool StopRun(Run run, string why)
        {
            bool ended = EndSession(run, "stopped", null, why);
            try { run.Cts.Cancel(); } catch (ObjectDisposedException) { }
            lock (_lock) run.HandBack.TrySetResult();
            return ended;
        }

        private JsonObject TakeoverOp(JsonObject req)
        {
            string sid = Str(req, "sessionId");
            UnoSession s;
            lock (_lock)
            {
                s = Session(sid) ?? throw new UnoException("That task wasn't found.");
                if (!s.Active || !_runs.TryGetValue(sid, out var run)) throw new UnoException("That task isn't running.");
                if (s.State == "you") return Ok();
                if (s.State == "starting") throw new UnoException("The computer is still starting. Wait a moment, then take over.");
                s.State = "you";
                s.Now = "Waiting for you to give the computer back";
                run.YouDid.Clear();
                run.HandBack = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            }
            Log(s, "you", "takeover", "You took over the computer.");
            RaiseChanged();
            return Ok();
        }

        private JsonObject HandbackOp(JsonObject req)
        {
            string sid = Str(req, "sessionId");
            string note = Str(req, "note").Trim();
            if (note.Length > MaxTaskChars) note = note.Substring(0, MaxTaskChars);
            UnoSession s;
            lock (_lock)
            {
                s = Session(sid) ?? throw new UnoException("That task wasn't found.");
                if (!s.Active || !_runs.TryGetValue(sid, out var run)) throw new UnoException("That task isn't running.");
                if (s.State != "you") throw new UnoException("You don't have the computer right now.");
                var sb = new StringBuilder();
                if (run.YouDid.Count == 0) sb.Append("The user took over the computer for a bit and didn't do anything on it.");
                else
                {
                    sb.Append("The user took over the computer and did this:\n");
                    foreach (var d in run.YouDid) sb.Append("- ").Append(d).Append('\n');
                }
                if (note.Length > 0) sb.Append("\nTheir note: ").Append(note);
                sb.Append("\n\nThe computer is yours again. Take a screenshot to see the screen now, then carry on with the task.");
                run.Pending.Enqueue(sb.ToString().Trim());
                run.YouDid.Clear();
                s.State = "running";
                s.Now = "Looking at the screen";
                run.HandBack.TrySetResult();
            }
            Log(s, "you", "handback", note.Length > 0 ? "You gave the computer back: " + ComputerActions.Short(note, 120) : "You gave the computer back.");
            RaiseChanged();
            return Ok();
        }

        private async Task<JsonObject> InputOp(JsonObject req, CancellationToken ct)
        {
            string cid = Str(req, "computerId");
            string action = Str(req, "action");
            Run? youRun = null;
            string? sessionId = null;
            lock (_lock)
            {
                var computer = _store.Computers.FirstOrDefault(c => c.Id == cid);
                if (computer == null || computer.State != "on") throw new UnoException("That computer is off.");
                var active = ActiveSessionOn(computer);
                if (active != null)
                {
                    if (active.State != "you") throw new UnoException("Squall Uno is using this computer. Take over first.");
                    _runs.TryGetValue(active.Id, out youRun);
                    sessionId = active.Id;
                }
            }

            var input = new Dictionary<string, JsonElement>();
            JsonElement Num(string key) => req[key] is JsonValue v ? JsonSerializer.SerializeToElement(v) : default;
            JsonElement Point() => JsonSerializer.SerializeToElement(new JsonArray(req["x"]?.DeepClone(), req["y"]?.DeepClone()));
            switch (action)
            {
                case "left_click":
                case "double_click":
                case "right_click":
                    if (req["x"] is not JsonValue || req["y"] is not JsonValue) throw new UnoException("Tap a spot on the screen first.");
                    input["coordinate"] = Point();
                    break;
                case "scroll":
                    if (req["x"] is JsonValue && req["y"] is JsonValue) input["coordinate"] = Point();
                    input["scroll_direction"] = JsonSerializer.SerializeToElement(Str(req, "direction"));
                    input["scroll_amount"] = req["amount"] is JsonValue ? Num("amount") : JsonSerializer.SerializeToElement(3);
                    break;
                case "type":
                case "key":
                    input["text"] = JsonSerializer.SerializeToElement(Str(req, "text"));
                    break;
                default:
                    throw new UnoException("You can click, double-click, right-click, type, press a key or scroll.");
            }
            ComputerAction a;
            try { a = ComputerActions.Parse(action, input, DockerDesktops.Width, DockerDesktops.Height); }
            catch (UnoToolException ex) { throw new UnoException(ex.Message); }
            try { await Docker.RunAsync(cid, a, ct).ConfigureAwait(false); }
            catch (UnoComputerGoneException ex)
            {
                MarkComputerOff(cid);
                throw new UnoException(ex.Message);
            }
            string text = ComputerActions.Describe(a);
            if (youRun != null)
                lock (_lock) youRun.YouDid.Add(text);
            LogRaw(sessionId, cid, "you", ComputerActions.Kind(a), text, a.X, a.Y, null, null, null);
            _frames.Poke(cid);
            return Ok();
        }

        private async Task<JsonObject> ComputerOffOp(JsonObject req, CancellationToken ct)
        {
            string cid = Str(req, "computerId");
            Run? run;
            lock (_lock)
            {
                var computer = _store.Computers.FirstOrDefault(c => c.Id == cid) ?? throw new UnoException("That computer wasn't found.");
                var active = ActiveSessionOn(computer);
                run = active != null && _runs.TryGetValue(active.Id, out var r) ? r : null;
                computer.StateText = "Turning off…";
            }
            if (run != null) StopRun(run, "Stopped because the computer was turned off.");
            RaiseChanged();
            try { await Docker.RemoveAsync(cid, ct).ConfigureAwait(false); }
            catch (UnoException ex)
            {
                lock (_lock)
                {
                    var computer = _store.Computers.FirstOrDefault(c => c.Id == cid);
                    if (computer != null) computer.StateText = ex.Message;
                }
                RaiseChanged();
                throw;
            }
            MarkComputerOff(cid);
            LogRaw(null, cid, "system", "stopped", "Turned the computer off.", null, null, null, null, null);
            return Ok();
        }

        private async Task<JsonObject> CheckOp(CancellationToken ct)
        {
            await RefreshDockerAsync(ct).ConfigureAwait(false);
            bool ready, image;
            string dockerText;
            lock (_lock) { ready = _dockerReady; image = _imageReady; dockerText = _dockerText; }
            string api;
            var key = Keys.Current.Key;
            if (key == null) api = "Add an Anthropic API key to use Squall Uno.";
            else
            {
                try
                {
                    string name = await _model.CheckAsync(key, _o.ModelName, ct).ConfigureAwait(false);
                    api = $"The API key works and {name} is ready.";
                }
                catch (UnoException ex) { api = ex.Message; }
            }
            string docker = !ready ? dockerText
                : image ? "Docker is running and the computer is set up."
                : "Docker is running. The computer gets set up the first time a task starts (a few minutes).";
            RaiseChanged();
            return new JsonObject { ["ok"] = true, ["text"] = api + " " + docker, ["settings"] = Settings() };
        }

        private JsonObject SetMaxStepsOp(JsonObject req)
        {
            long? v = UnoSession.Long(req, "value");
            if (v is null or < 10 or > 300) return Fail("Pick a number from 10 to 300.");
            lock (_lock)
            {
                _store.MaxSteps = (int)v.Value;
                _store.Save();
            }
            RaiseChanged();
            return new JsonObject { ["ok"] = true, ["settings"] = Settings() };
        }

        private JsonObject WatchOp(JsonObject req, bool fromPage)
        {
            if (!fromPage) return Fail("Only the Squall window can watch a computer this way. Use the frame address instead.");
            string cid = Str(req, "computerId");
            lock (_lock)
            {
                if (cid.Length > 0 && !_store.Computers.Any(c => c.Id == cid)) throw new UnoException("That computer wasn't found.");
                _watched = cid.Length > 0 ? cid : null;
            }
            if (cid.Length > 0)
            {
                _frames.Poke(cid);
                var f = _frames.Latest(cid);
                if (f != null) RaiseWatchedFrame(cid, f);
            }
            return Ok();
        }

        // ===================================================================== Frames

        /// <summary>For GET /api/v1/uno/frame: 404 when the computer is off, 204 when nothing newer than after, else 200 and the frame.</summary>
        public (int Status, UnoFrame? Frame) PhoneFrame(string computerId, long after)
        {
            lock (_lock)
            {
                var computer = _store.Computers.FirstOrDefault(c => c.Id == computerId);
                if (computer == null || computer.State is not ("on" or "starting")) return (404, null);
                _phoneAsked[computerId] = _clock();
            }
            _frames.Poke(computerId);
            var f = _frames.Latest(computerId);
            if (f == null || f.Seq == after) return (204, null);
            // A bigger "after" came from another computer's frames (seq numbers are shared), so it gets the newest one.
            return (200, f);
        }

        /// <summary>The newest frame of a computer (null if none yet).</summary>
        public UnoFrame? LatestFrame(string computerId) => _frames.Latest(computerId);

        private bool FramesNeeded(string computerId)
        {
            lock (_lock)
            {
                if (_disposed) return false;
                var computer = _store.Computers.FirstOrDefault(c => c.Id == computerId);
                if (computer == null || computer.State != "on") return false;
                if (ActiveSessionOn(computer) != null) return true;
                if (_watched == computerId) return true;
                return _phoneAsked.TryGetValue(computerId, out var at) && _clock() - at < _o.PhoneWatch;
            }
        }

        private void OnFrame(string computerId, UnoFrame f)
        {
            bool watched;
            lock (_lock)
            {
                var computer = _store.Computers.FirstOrDefault(c => c.Id == computerId);
                if (computer != null) computer.FrameSeq = f.Seq;
                watched = _watched == computerId;
            }
            if (watched) RaiseWatchedFrame(computerId, f);
        }

        private void RaiseWatchedFrame(string computerId, UnoFrame f)
        {
            try { WatchedFrame?.Invoke(computerId, f); } catch (Exception) { }
        }

        /// <summary>The window's "unoFrame" push for a frame.</summary>
        public static JsonObject FrameJson(string computerId, UnoFrame f) => new()
        {
            ["computerId"] = computerId,
            ["seq"] = f.Seq,
            ["width"] = f.Width,
            ["height"] = f.Height,
            ["cursorX"] = f.CursorX,
            ["cursorY"] = f.CursorY,
            ["jpeg"] = Convert.ToBase64String(f.Jpeg),
        };

        // ===================================================================== State for the app

        /// <summary>The settings object (docs/squall-uno.md). Never contains the key.</summary>
        public JsonObject Settings()
        {
            var (key, source) = Keys.Current;
            lock (_lock)
            {
                var tok = _store.TokensOn(_clock());
                return new JsonObject
                {
                    ["hasKey"] = key != null,
                    ["keySource"] = source,
                    ["keyHint"] = UnoKeyStore.HintFor(key),
                    ["dockerReady"] = _dockerReady,
                    ["dockerText"] = _dockerText,
                    ["imageReady"] = _imageReady,
                    ["model"] = _o.ModelName,
                    ["maxSteps"] = _store.MaxSteps,
                    ["tokensToday"] = new JsonObject { ["input"] = tok.Input, ["output"] = tok.Output },
                };
            }
        }

        /// <summary>The window's "unoState" push: computers, sessions (newest first, 30) and settings.</summary>
        public JsonObject PushState()
        {
            var o = new JsonObject();
            lock (_lock)
            {
                o["computers"] = ComputersJson();
                o["sessions"] = SessionsJson();
            }
            o["settings"] = Settings();
            return o;
        }

        private JsonArray ComputersJson()
        {
            var arr = new JsonArray();
            foreach (var c in _store.Computers) arr.Add(c.ToJson());
            return arr;
        }

        private JsonArray SessionsJson()
        {
            var arr = new JsonArray();
            for (int i = _store.Sessions.Count - 1, n = 0; i >= 0 && n < 30; i--, n++) arr.Add(_store.Sessions[i].ToJson());
            return arr;
        }

        private UnoSession? Session(string id) => id.Length == 0 ? null : _store.Sessions.LastOrDefault(s => s.Id == id);

        private UnoSession? ActiveSessionOn(UnoComputer c)
        {
            if (c.SessionId == null) return null;
            var s = Session(c.SessionId);
            return s != null && s.Active ? s : null;
        }

        private void MarkComputerOff(string cid)
        {
            lock (_lock)
            {
                var computer = _store.Computers.FirstOrDefault(c => c.Id == cid);
                if (computer != null)
                {
                    computer.State = "off";
                    computer.StateText = "";
                    computer.FrameSeq = 0;
                    if (ActiveSessionOn(computer) == null) computer.SessionId = null;
                }
            }
            _frames.Clear(cid);
            RaiseChanged();
        }

        // ===================================================================== Docker status

        private async Task RequireDockerAsync(CancellationToken ct)
        {
            var (ready, text) = await Docker.CheckAsync(ct).ConfigureAwait(false);
            lock (_lock)
            {
                _dockerReady = ready;
                _dockerText = text;
            }
            if (!ready)
            {
                RaiseChanged();
                throw new UnoException(text);
            }
        }

        private void RefreshDockerIfOld()
        {
            lock (_lock)
                if (_refreshing != null || _clock() - _dockerAt < TimeSpan.FromSeconds(30)) return;
            _ = RefreshDockerAsync(CancellationToken.None);
        }

        /// <summary>Checks Docker, the image and which computers are really running (one check at a time).</summary>
        private Task RefreshDockerAsync(CancellationToken ct)
        {
            lock (_lock)
            {
                if (_refreshing != null) return _refreshing;
                _dockerAt = _clock();
                _refreshing = Task.Run(() => DoRefreshAsync(ct), CancellationToken.None);
                return _refreshing;
            }
        }

        private async Task DoRefreshAsync(CancellationToken ct)
        {
            var turnedOn = new List<string>();
            try
            {
                var (ready, text) = await Docker.CheckAsync(ct).ConfigureAwait(false);
                bool image = ready && await Docker.ImageReadyAsync(ct).ConfigureAwait(false);
                var running = ready ? await Docker.RunningAsync(ct).ConfigureAwait(false) : Array.Empty<string>();
                lock (_lock)
                {
                    _dockerReady = ready;
                    _dockerText = text;
                    _imageReady = image;
                    _dockerAt = _clock();
                    foreach (var c in _store.Computers)
                    {
                        bool up = running.Contains(c.Id);
                        if (up && c.State is "off" or "error")
                        {
                            c.State = "on";
                            c.StateText = "";
                            turnedOn.Add(c.Id);
                        }
                        else if (!up && c.State == "on" && ActiveSessionOn(c) == null && ready)
                        {
                            c.State = "off";
                            c.StateText = "";
                        }
                    }
                }
            }
            catch (Exception) { }
            finally
            {
                lock (_lock) _refreshing = null;
            }
            RaiseChanged();
            foreach (var id in turnedOn) _frames.Poke(id);
        }

        // ===================================================================== Events

        private void Log(UnoSession s, string who, string kind, string text, ComputerAction? a = null, int? step = null)
            => LogRaw(s.Id, s.ComputerId, who, kind, text, a?.X ?? a?.Region?.X0, a?.Y ?? a?.Region?.Y0, a?.X2 ?? a?.Region?.X1, a?.Y2 ?? a?.Region?.Y1, step);

        private void LogRaw(string? sessionId, string computerId, string who, string kind, string text, int? x, int? y, int? x2, int? y2, int? step)
        {
            var e = _log.Add(new UnoEvent
            {
                At = NowMs, SessionId = sessionId, ComputerId = computerId, Who = who, Kind = kind,
                Text = ComputerActions.Short(text, 2000), X = x, Y = y, X2 = x2, Y2 = y2, Step = step,
            });
            try { EventAdded?.Invoke(e); } catch (Exception) { }
        }

        private void RaiseChanged()
        {
            try { Changed?.Invoke(); } catch (Exception) { }
        }

        // ===================================================================== Shutdown

        public async ValueTask DisposeAsync()
        {
            List<Run> runs;
            List<string> on;
            lock (_lock)
            {
                if (_disposed) return;
                _disposed = true;
                runs = _runs.Values.ToList();
                on = _store.Computers.Where(c => c.State is "on" or "starting").Select(c => c.Id).ToList();
            }
            foreach (var r in runs.Where(r => r.S.Active)) StopRun(r, "Stopped because Squall closed.");
            try { await Task.WhenAll(runs.Select(r => r.Task)).WaitAsync(TimeSpan.FromSeconds(5)).ConfigureAwait(false); }
            catch (Exception) { }
            _frames.Dispose();
            if (_o.StopComputersOnDispose && on.Count > 0)
            {
                try { await Docker.StopAsync(on).ConfigureAwait(false); }
                catch (Exception) { }
            }
            lock (_lock)
            {
                foreach (var c in _store.Computers) { c.State = "off"; c.StateText = ""; c.SessionId = null; c.FrameSeq = 0; }
                _store.Save();
            }
            if (_ownsModel && _model is IDisposable d) d.Dispose();
        }
    }
}
