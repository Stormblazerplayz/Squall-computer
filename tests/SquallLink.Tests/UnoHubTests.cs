using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Tasks;
using Anthropic.Models.Messages;
using Squall.Link.Uno;
using Xunit;

namespace Squall.Link.Tests
{
    /// <summary>A hub with fake Docker and a fake model. The key below is a test fixture, not a real key.</summary>
    internal sealed class UnoRig : IAsyncDisposable
    {
        public const string Key = "sk-ant-api03-TESTKEY-abcdefghijklmnopqrstuvwxyz-Q9z8";
        public readonly TempDir Dir;
        private readonly bool _ownsDir;
        public readonly FakeDocker Docker = new();
        public readonly FakeModel Model = new();
        public readonly UnoHub Hub;
        public string? Env = Key;
        public readonly ConcurrentQueue<UnoEvent> Pushed = new();
        public int ChangedCount;

        public UnoRig(TempDir? dir = null, TimeSpan? frameInterval = null)
        {
            _ownsDir = dir == null;
            Dir = dir ?? new TempDir();
            Hub = new UnoHub(Dir.Sub("uno"), new UnoHubOptions
            {
                Runner = Docker, Model = Model, EnvKey = () => Env,
                FrameInterval = frameInterval ?? TimeSpan.FromMilliseconds(50),
                ComputerReadyPoll = TimeSpan.FromMilliseconds(1),
                ShotDelay = TimeSpan.FromMilliseconds(30),
            });
            Hub.EventAdded += e => Pushed.Enqueue(e);
            Hub.Changed += () => System.Threading.Interlocked.Increment(ref ChangedCount);
        }

        public Task<JsonObject> Do(string json, bool fromPage = true) => Hub.HandleAsync((JsonObject)JsonNode.Parse(json)!, fromPage);

        public async Task<string> Start(string task = "Open Firefox", string agent = "chief")
        {
            var r = await Do("{\"op\":\"start\",\"agentId\":\"" + agent + "\",\"agentName\":\"Chief\",\"task\":" + JsonSerializer.Serialize(task) + "}");
            Assert.True((bool)r["ok"]!, r.ToJsonString());
            return (string)r["sessionId"]!;
        }

        public async Task<JsonObject> Session(string id)
        {
            var st = await Do("{\"op\":\"state\"}");
            return (JsonObject)((JsonArray)st["sessions"]!).First(s => (string?)s!["id"] == id)!;
        }

        public List<UnoEvent> Events(string sessionId) => Pushed.Where(e => e.SessionId == sessionId).ToList();

        public async ValueTask DisposeAsync()
        {
            await Hub.DisposeAsync();
            if (_ownsDir) Dir.Dispose();
        }
    }

    public class UnoHubTests
    {
        private static JsonArray Content(JsonArray messages, int i) => (JsonArray)messages[i]!["content"]!;

        [Fact]
        public async Task ASessionRunsToolsAndEchoesEveryBlock()
        {
            await using var rig = new UnoRig();
            rig.Model.Reply("tool_use", FakeModel.Thinking("sig-1"), FakeModel.Text("Let me look."),
                FakeModel.Tool("tu_1", "screenshot"), FakeModel.Tool("tu_2", "left_click", "{\"coordinate\":[412,230]}"));
            rig.Model.Reply("end_turn", FakeModel.Text("I opened Firefox for you."));

            var r = await rig.Do("{\"op\":\"start\",\"agentId\":\"Chief Bot!\",\"agentName\":\"Chief\",\"task\":\"Open Firefox\"}");
            Assert.True((bool)r["ok"]!);
            string sid = (string)r["sessionId"]!;
            Assert.Matches("^uno-[0-9a-f]{12}$", sid);
            Assert.Equal("pc-chief-bot-", (string?)r["computerId"]);
            await rig.Hub.RunTask(sid);

            var s = await rig.Session(sid);
            Assert.Equal("done", (string?)s["state"]);
            Assert.Equal(2, (int)s["steps"]!);
            Assert.Equal("I opened Firefox for you.", (string?)s["lastText"]);
            Assert.Equal(210, (long)s["inputTokens"]!);
            Assert.Equal(20, (long)s["outputTokens"]!);
            Assert.NotNull(s["endedAt"]);
            Assert.Null(s["error"]);

            // the first request: the task, the toolset, adaptive thinking, Squall Uno's prompt
            var p = rig.Model.Params[0];
            string req = JsonSerializer.Serialize(p.Tools);
            Assert.Contains("computer_toolset_20260801", req);
            Assert.Equal("claude-opus-5-5", p.Model.ToString().Trim('"'));
            Assert.Contains("adaptive", JsonSerializer.Serialize(p.Thinking));
            string system = p.RawBodyData["system"].GetString()!;
            Assert.Contains("Squall Uno", system);
            Assert.Contains("Chief's own computer", system);
            Assert.Contains("passwords", system);
            Assert.Contains("12", system);
            Assert.Equal(UnoRig.Key, rig.Model.Keys[0]);
            var first = rig.Model.Request(0);
            Assert.Single(first);
            Assert.Equal("Open Firefox", (string?)Content(first, 0)[0]!["text"]);

            // the second request echoes every assistant block (thinking with its signature) and answers each tool_use
            var second = rig.Model.Request(1);
            Assert.Equal(3, second.Count);
            var asst = Content(second, 1);
            Assert.Equal("assistant", (string?)second[1]!["role"]);
            Assert.Equal(new[] { "thinking", "text", "tool_use", "tool_use" }, asst.Select(b => (string)b!["type"]!));
            Assert.Equal("sig-1", (string?)asst[0]!["signature"]);
            Assert.Equal("computer", (string?)asst[2]!["toolset_name"]);
            Assert.Equal("left_click", (string?)asst[3]!["name"]);
            Assert.Equal(412, (int)asst[3]!["input"]!["coordinate"]![0]!);
            var results = Content(second, 2);
            Assert.Equal(2, results.Count);
            Assert.All(results, b => Assert.Equal("computer", (string?)b!["toolset_name"]));
            Assert.Equal("tu_1", (string?)results[0]!["tool_use_id"]);
            var img = results[0]!["content"]![0]!;
            Assert.Equal("image", (string?)img["type"]);
            Assert.Equal("image/jpeg", (string?)img["source"]!["media_type"]);
            Assert.Equal(Convert.ToBase64String(FakeDocker.Jpeg), (string?)img["source"]!["data"]);
            Assert.Equal("tu_2", (string?)results[1]!["tool_use_id"]);
            Assert.Equal("OK", (string?)results[1]!["content"]);
            Assert.True(results[1]!["is_error"] == null || !(bool)results[1]!["is_error"]!);

            Assert.Contains(rig.Docker.XdotoolActions(), a => string.Join(" ", a) == "xdotool mousemove 412 230 click 1");

            var events = rig.Events(sid);
            Assert.Equal(new[] { "start", "say", "screenshot", "click", "say", "done" }, events.Select(e => e.Kind));
            Assert.Equal(new[] { "system", "uno", "uno", "uno", "uno", "system" }, events.Select(e => e.Who));
            var click = events[3];
            Assert.Equal("Clicked at (412, 230)", click.Text);
            Assert.Equal((412, 230, 2), (click.X!.Value, click.Y!.Value, click.Step!.Value));
            Assert.Equal("Took a screenshot", events[2].Text);
            Assert.True(events.Zip(events.Skip(1)).All(z => z.Second.Seq > z.First.Seq));

            var state = await rig.Do("{\"op\":\"state\"}");
            Assert.Equal(210, (long)state["settings"]!["tokensToday"]!["input"]!);
            var computer = (JsonObject)((JsonArray)state["computers"]!)[0]!;
            Assert.Equal("on", (string?)computer["state"]);
            Assert.Equal("Chief's computer", (string?)computer["name"]);
            Assert.Equal(1280, (int)computer["width"]!);
            Assert.Null(computer["sessionId"]);
        }

        [Fact]
        public async Task BadToolInputIsAToolErrorAndTheSessionGoesOn()
        {
            await using var rig = new UnoRig();
            rig.Model.Reply("tool_use", FakeModel.Tool("t1", "left_click", "{\"coordinate\":[5000,1]}"), FakeModel.Tool("t2", "zoom", "{\"region\":[0,0,640,400]}"),
                FakeModel.Tool("t3", "cursor_position"), FakeModel.Tool("t4", "fly"));
            rig.Model.Reply("max_tokens", FakeModel.Text("Hmm"));
            string sid = await rig.Start();
            await rig.Hub.RunTask(sid);
            var results = Content(rig.Model.Request(1), 2);
            Assert.True((bool)results[0]!["is_error"]!);
            Assert.Contains("off the screen", (string?)results[0]!["content"]);
            Assert.Equal("image", (string?)results[1]!["content"]![0]!["type"]);
            Assert.Equal("[10, 20]", (string?)results[2]!["content"]);
            Assert.True((bool)results[3]!["is_error"]!);
            Assert.Equal("done", (string?)(await rig.Session(sid))["state"]);
            Assert.Contains(rig.Events(sid), e => e.Kind == "error" && e.Text.Contains("off the screen"));
            Assert.Contains(rig.Events(sid), e => e.Kind == "zoom" && e.X == 0 && e.X2 == 640);
        }

        [Fact]
        public void AToolUseTheSdkCannotReadIsStillAnswered()
        {
            var asst = new List<ContentBlockParam>();
            var calls = new List<UnoHub.ToolCall>();
            var json = JsonDocument.Parse("{\"type\":\"tool_use\",\"id\":\"tu_9\",\"name\":\"type\",\"toolset_name\":\"computer\",\"input\":{\"text\":\"hi\"}}").RootElement;
            UnoHub.EchoRaw(json, asst, calls);
            Assert.Single(calls);
            Assert.Equal("tu_9", calls[0].Id);
            Assert.Equal("type", calls[0].Name);
            Assert.Equal("hi", calls[0].Input["text"].GetString());
            string echoed = JsonSerializer.Serialize(asst);
            Assert.Contains("\"toolset_name\":\"computer\"", echoed);
            Assert.Contains("\"id\":\"tu_9\"", echoed);

            // unknown block types are kept as they came
            UnoHub.EchoRaw(JsonDocument.Parse("{\"type\":\"future_block\",\"x\":1}").RootElement, asst, calls);
            Assert.Contains("future_block", JsonSerializer.Serialize(asst));
            Assert.Single(calls);
        }

        [Fact]
        public async Task PauseTurnResendsAndRefusalEndsPlainly()
        {
            await using var rig = new UnoRig();
            rig.Model.Reply("pause_turn", FakeModel.Text("Working on it"));
            rig.Model.Reply("end_turn", FakeModel.Text("Done!"));
            string sid = await rig.Start();
            await rig.Hub.RunTask(sid);
            var again = rig.Model.Request(1);
            Assert.Equal(2, again.Count);
            Assert.Equal("assistant", (string?)again[1]!["role"]);
            Assert.Equal("done", (string?)(await rig.Session(sid))["state"]);

            rig.Model.Reply("refusal");
            string sid2 = await rig.Start("Do something bad");
            await rig.Hub.RunTask(sid2);
            var s2 = await rig.Session(sid2);
            Assert.Equal("error", (string?)s2["state"]);
            Assert.Equal("Squall Uno won't do this task. Try asking for something different.", (string?)s2["error"]);
            Assert.Equal("error", rig.Events(sid2).Last().Kind);
        }

        [Fact]
        public async Task StopIsPromptAndStopAllCounts()
        {
            await using var rig = new UnoRig();
            string sid = await rig.Start();   // no reply queued: the model "thinks" until stopped
            await Wait.Until(() => rig.Model.Count == 1, "the first model call");
            var r = await rig.Do("{\"op\":\"stop\",\"sessionId\":\"" + sid + "\"}");
            Assert.True((bool)r["ok"]!);
            Assert.Equal("stopped", (string?)(await rig.Session(sid))["state"]);
            await rig.Hub.RunTask(sid).WaitAsync(TimeSpan.FromSeconds(3));
            Assert.Single(rig.Events(sid), e => e.Kind == "stopped");
            Assert.True((bool)(await rig.Do("{\"op\":\"stop\",\"sessionId\":\"" + sid + "\"}"))["ok"]!);

            string a = await rig.Start("one", "scout");
            string b = await rig.Start("two", "chief");
            await Wait.Until(() => rig.Model.Count == 3, "both sessions to call the model");
            var all = await rig.Do("{\"op\":\"stopAll\"}");
            Assert.Equal(2, (int)all["stopped"]!);
            await Task.WhenAll(rig.Hub.RunTask(a), rig.Hub.RunTask(b)).WaitAsync(TimeSpan.FromSeconds(3));
            Assert.Equal("stopped", (string?)(await rig.Session(a))["state"]);
        }

        [Fact]
        public async Task TakeoverPausesAndHandbackTellsWhatYouDid()
        {
            await using var rig = new UnoRig();
            var gate = new TaskCompletionSource();
            rig.Model.Reply(async ct =>
            {
                await gate.Task.WaitAsync(ct);
                return FakeModel.Msg("tool_use", FakeModel.Tool("tu_1", "left_click", "{\"coordinate\":[100,100]}"));
            });
            string sid = await rig.Start();
            await Wait.Until(() => rig.Model.Count == 1, "the first model call");

            var busy = await rig.Do("{\"op\":\"input\",\"computerId\":\"pc-chief\",\"action\":\"left_click\",\"x\":5,\"y\":6}");
            Assert.False((bool)busy["ok"]!);
            Assert.Equal("Squall Uno is using this computer. Take over first.", (string?)busy["error"]);

            Assert.True((bool)(await rig.Do("{\"op\":\"takeover\",\"sessionId\":\"" + sid + "\"}"))["ok"]!);
            Assert.Equal("you", (string?)(await rig.Session(sid))["state"]);
            Assert.True((bool)(await rig.Do("{\"op\":\"input\",\"computerId\":\"pc-chief\",\"action\":\"left_click\",\"x\":5,\"y\":6}", fromPage: false))["ok"]!);
            Assert.True((bool)(await rig.Do("{\"op\":\"input\",\"computerId\":\"pc-chief\",\"action\":\"type\",\"text\":\"hi\"}"))["ok"]!);
            Assert.True((bool)(await rig.Do("{\"op\":\"input\",\"computerId\":\"pc-chief\",\"action\":\"scroll\",\"x\":50,\"y\":60,\"direction\":\"down\"}"))["ok"]!);
            var bad = await rig.Do("{\"op\":\"input\",\"computerId\":\"pc-chief\",\"action\":\"left_click\"}");
            Assert.Equal("Tap a spot on the screen first.", (string?)bad["error"]);

            gate.SetResult();
            await Task.Delay(200);
            Assert.Equal(1, rig.Model.Count);   // paused before the next model call
            Assert.DoesNotContain(rig.Docker.XdotoolActions(), a => string.Join(" ", a).Contains("mousemove 100 100"));   // the step it was on wasn't done

            rig.Model.Reply("end_turn", FakeModel.Text("All done."));
            Assert.True((bool)(await rig.Do("{\"op\":\"handback\",\"sessionId\":\"" + sid + "\",\"note\":\"I closed the popup\"}"))["ok"]!);
            await rig.Hub.RunTask(sid).WaitAsync(TimeSpan.FromSeconds(3));

            var content = Content(rig.Model.Request(1), 2);
            Assert.Equal("tool_result", (string?)content[0]!["type"]);
            Assert.True((bool)content[0]!["is_error"]!);
            Assert.Contains("took over", (string?)content[0]!["content"]);
            string told = (string)content[1]!["text"]!;
            Assert.Contains("Clicked at (5, 6)", told);
            Assert.Contains("Typed \"hi\"", told);
            Assert.Contains("Scrolled down 3 at (50, 60)", told);
            Assert.Contains("I closed the popup", told);

            var mine = rig.Events(sid).Where(e => e.Who == "you").Select(e => e.Kind).ToList();
            Assert.Equal(new[] { "takeover", "click", "type", "scroll", "handback" }, mine);
            Assert.Equal("done", (string?)(await rig.Session(sid))["state"]);
            Assert.Contains(rig.Docker.XdotoolActions(), a => string.Join(" ", a) == "xdotool mousemove 5 6 click 1");

            // with no session running, input works straight away
            Assert.True((bool)(await rig.Do("{\"op\":\"input\",\"computerId\":\"pc-chief\",\"action\":\"key\",\"text\":\"ctrl+l\"}"))["ok"]!);
            Assert.Contains(rig.Pushed, e => e.Who == "you" && e.Kind == "key" && e.SessionId == null);
        }

        [Fact]
        public async Task MessagesJoinTheRunningTaskAndContinueAnEndedOne()
        {
            await using var rig = new UnoRig();
            var gate = new TaskCompletionSource();
            rig.Model.Reply(async ct =>
            {
                await gate.Task.WaitAsync(ct);
                return FakeModel.Msg("tool_use", FakeModel.Tool("tu_1", "screenshot"));
            });
            rig.Model.Reply("end_turn", FakeModel.Text("It is sunny."));
            string sid = await rig.Start("Open the weather");
            await Wait.Until(() => rig.Model.Count == 1, "the first model call");
            Assert.True((bool)(await rig.Do("{\"op\":\"message\",\"sessionId\":\"" + sid + "\",\"text\":\"also check Paris\"}"))["ok"]!);
            gate.SetResult();
            await rig.Hub.RunTask(sid);
            var content = Content(rig.Model.Request(1), 2);
            Assert.Equal(new[] { "tool_result", "text" }, content.Select(b => (string)b!["type"]!));
            Assert.Equal("also check Paris", (string?)content[1]!["text"]);

            rig.Model.Reply("end_turn", FakeModel.Text("Closed."));
            Assert.True((bool)(await rig.Do("{\"op\":\"message\",\"sessionId\":\"" + sid + "\",\"text\":\"now close it\"}"))["ok"]!);
            await Wait.Until(() => rig.Model.Count == 3, "the follow-up call");
            await rig.Hub.RunTask(sid);
            var third = rig.Model.Request(2);
            Assert.Equal(5, third.Count);
            Assert.Equal("now close it", (string?)Content(third, 4)[0]!["text"]);
            var s = await rig.Session(sid);
            Assert.Equal("done", (string?)s["state"]);
            Assert.Equal("Closed.", (string?)s["lastText"]);
            Assert.Equal(2, rig.Events(sid).Count(e => e.Kind == "message" && e.Who == "you"));
        }

        [Fact]
        public async Task TheStepLimitEndsWithAPlainSentence()
        {
            await using var rig = new UnoRig();
            Assert.Equal("Pick a number from 10 to 300.", (string?)(await rig.Do("{\"op\":\"setMaxSteps\",\"value\":5}"))["error"]);
            var set = await rig.Do("{\"op\":\"setMaxSteps\",\"value\":10}");
            Assert.Equal(10, (int)set["settings"]!["maxSteps"]!);
            for (int i = 0; i < 10; i++) rig.Model.Reply("tool_use", FakeModel.Tool("t" + i, "wait", "{\"duration\":0.01}"));
            string sid = await rig.Start();
            await rig.Hub.RunTask(sid);
            var s = await rig.Session(sid);
            Assert.Equal("error", (string?)s["state"]);
            Assert.StartsWith("Squall Uno took 10 steps and stopped before it finished.", (string?)s["error"]);
            Assert.Equal(10, rig.Model.Count);

            // carrying on answers the last tool_use first
            rig.Model.Reply("end_turn", FakeModel.Text("Finished."));
            Assert.True((bool)(await rig.Do("{\"op\":\"message\",\"sessionId\":\"" + sid + "\",\"text\":\"keep going\"}"))["ok"]!);
            await Wait.Until(() => rig.Model.Count >= 11, "the follow-up call");
            await rig.Hub.RunTask(sid);
            Assert.Equal(11, rig.Model.Count);
            var last = rig.Model.Request(10);
            var tail = Content(last, last.Count - 1);
            Assert.Equal(new[] { "tool_result", "text" }, tail.Select(b => (string)b!["type"]!));
            Assert.Equal("t9", (string?)tail[0]!["tool_use_id"]);
        }

        [Fact]
        public async Task HistorySurvivesARestartButTheConversationStartsFresh()
        {
            using var dir = new TempDir();
            string sid;
            await using (var rig = new UnoRig(dir))
            {
                rig.Model.Reply("end_turn", FakeModel.Text("Hi there."));
                sid = await rig.Start("Say hi");
                await rig.Hub.RunTask(sid);
            }
            string saved = File.ReadAllText(Path.Combine(dir.Sub("uno"), "state.json"));
            Assert.Contains("Say hi", saved);
            Assert.DoesNotContain(UnoRig.Key, saved);

            await using (var rig = new UnoRig(dir))
            {
                var s = await rig.Session(sid);
                Assert.Equal("done", (string?)s["state"]);
                Assert.Equal("Hi there.", (string?)s["lastText"]);
                rig.Model.Reply("end_turn", FakeModel.Text("Hi again."));
                Assert.True((bool)(await rig.Do("{\"op\":\"message\",\"sessionId\":\"" + sid + "\",\"text\":\"again\"}"))["ok"]!);
                await Wait.Until(() => rig.Model.Count == 1, "the fresh call");
                await rig.Hub.RunTask(sid);
                var req = rig.Model.Request(0);
                Assert.Single(req);
                string text = (string)Content(req, 0)[0]!["text"]!;
                Assert.Contains("Earlier you worked on this task: \"Say hi\"", text);
                Assert.Contains("Last time you said: \"Hi there.\"", text);
                Assert.Contains("Now the user says: again", text);
                Assert.Contains(rig.Events(sid), e => e.Who == "system" && e.Text.Contains("starts fresh"));
            }
        }

        [Fact]
        public async Task SessionsRunningWhenSquallClosedComeBackStopped()
        {
            using var dir = new TempDir();
            Directory.CreateDirectory(dir.Sub("uno"));
            File.WriteAllText(Path.Combine(dir.Sub("uno"), "state.json"),
                "{\"maxSteps\":42,\"computers\":[{\"id\":\"pc-chief\",\"agentId\":\"chief\",\"agentName\":\"Chief\"}],\"sessions\":[{\"id\":\"uno-aaaaaaaaaaaa\",\"computerId\":\"pc-chief\",\"agentId\":\"chief\",\"agentName\":\"Chief\",\"task\":\"t\",\"state\":\"running\",\"startedAt\":5}]}");
            await using var rig = new UnoRig(dir);
            var st = await rig.Do("{\"op\":\"state\"}");
            var s = (JsonObject)((JsonArray)st["sessions"]!)[0]!;
            Assert.Equal("stopped", (string?)s["state"]);
            Assert.NotNull(s["endedAt"]);
            Assert.Equal(42, (int)st["settings"]!["maxSteps"]!);
            Assert.Equal("off", (string?)st["computers"]![0]!["state"]);
        }

        [Fact]
        public async Task StateFiltersEventsBySeqAndSession()
        {
            await using var rig = new UnoRig();
            rig.Model.Reply("end_turn", FakeModel.Text("One."));
            string a = await rig.Start("first");
            await rig.Hub.RunTask(a);
            rig.Model.Reply("end_turn", FakeModel.Text("Two."));
            string b = await rig.Start("second");
            await rig.Hub.RunTask(b);

            var all = await rig.Do("{\"op\":\"state\"}");
            var events = (JsonArray)all["events"]!;
            Assert.Equal(6, events.Count);
            long last = (long)all["lastSeq"]!;
            Assert.Equal(last, (long)events[^1]!["seq"]!);
            Assert.Equal(b, (string?)all["sessions"]![0]!["id"]);   // newest first

            long mid = (long)events[2]!["seq"]!;
            var after = await rig.Do("{\"op\":\"state\",\"since\":" + mid + "}");
            Assert.Equal(3, ((JsonArray)after["events"]!).Count);
            Assert.All((JsonArray)after["events"]!, e => Assert.True((long)e!["seq"]! > mid));

            var none = await rig.Do("{\"op\":\"state\",\"since\":" + last + "}");
            Assert.Empty((JsonArray)none["events"]!);
            Assert.Equal(last, (long)none["lastSeq"]!);

            var onlyA = await rig.Do("{\"op\":\"state\",\"sessionId\":\"" + a + "\"}");
            Assert.All((JsonArray)onlyA["events"]!, e => Assert.Equal(a, (string?)e!["sessionId"]));
            Assert.Equal(3, ((JsonArray)onlyA["events"]!).Count);

            // a since from before a restart (bigger than anything) starts over
            var old = await rig.Do("{\"op\":\"state\",\"since\":" + (last + 1_000_000) + "}");
            Assert.Equal(6, ((JsonArray)old["events"]!).Count);
        }

        [Fact]
        public async Task ProblemsAreAnsweredWithPlainSentences()
        {
            await using var rig = new UnoRig();
            async Task<string> Err(string json, bool page = true)
            {
                var r = await rig.Do(json, page);
                Assert.False((bool)r["ok"]!);
                return (string)r["error"]!;
            }
            Assert.Equal("Squall Uno doesn't know that request.", await Err("{\"op\":\"fly\"}"));
            Assert.Equal("Say what Squall Uno should do.", await Err("{\"op\":\"start\",\"agentId\":\"chief\",\"task\":\"  \"}"));
            Assert.Equal("Pick which agent's computer to use.", await Err("{\"op\":\"start\",\"task\":\"x\"}"));
            Assert.Equal("That task wasn't found.", await Err("{\"op\":\"stop\",\"sessionId\":\"uno-000000000000\"}"));
            Assert.Equal("That task wasn't found.", await Err("{\"op\":\"message\",\"sessionId\":\"nope\",\"text\":\"hi\"}"));
            Assert.Equal("Write a message first.", await Err("{\"op\":\"message\",\"sessionId\":\"nope\",\"text\":\"\"}"));
            Assert.Equal("That computer is off.", await Err("{\"op\":\"input\",\"computerId\":\"pc-chief\",\"action\":\"type\",\"text\":\"x\"}"));
            Assert.Equal("That computer wasn't found.", await Err("{\"op\":\"computerOff\",\"computerId\":\"pc-nobody\"}"));
            Assert.StartsWith("Only the Squall window", await Err("{\"op\":\"watch\",\"computerId\":\"pc-chief\"}", page: false));

            rig.Env = null;
            Assert.Equal("Add an Anthropic API key in Squall Uno's settings first.", await Err("{\"op\":\"start\",\"agentId\":\"chief\",\"task\":\"x\"}"));
            rig.Env = UnoRig.Key;
            rig.Docker.Running = false;
            Assert.Equal("Docker is installed but not running. Start Docker Desktop.", await Err("{\"op\":\"start\",\"agentId\":\"chief\",\"task\":\"x\"}"));
            rig.Docker.Installed = false;
            Assert.Equal("Install Docker Desktop and start it, then try again.", await Err("{\"op\":\"start\",\"agentId\":\"chief\",\"task\":\"x\"}"));
            rig.Docker.Installed = true;
            rig.Docker.Running = true;

            string sid = await rig.Start();
            await Wait.Until(() => rig.Model.Count == 1, "the model call");
            Assert.Equal("Chief's computer is busy with another task. Stop it first, or send it a message.", await Err("{\"op\":\"start\",\"agentId\":\"chief\",\"task\":\"x\"}"));
            Assert.Equal("You don't have the computer right now.", await Err("{\"op\":\"handback\",\"sessionId\":\"" + sid + "\"}"));
            await rig.Do("{\"op\":\"stop\",\"sessionId\":\"" + sid + "\"}");
            Assert.Equal("That task isn't running.", await Err("{\"op\":\"takeover\",\"sessionId\":\"" + sid + "\"}"));
        }

        [Fact]
        public async Task TheComputerFailingToStartIsAPlainError()
        {
            await using var rig = new UnoRig();
            rig.Docker.ImageBuilt = false;
            rig.Docker.Answer = a => a[0] == "build" ? new CommandResult(1, Array.Empty<byte>(), "step 2\nE: Unable to fetch some archives") : null;
            string sid = await rig.Start();
            await rig.Hub.RunTask(sid);
            var s = await rig.Session(sid);
            Assert.Equal("error", (string?)s["state"]);
            Assert.StartsWith("Setting up the computer didn't work (E: Unable to fetch some archives).", (string?)s["error"]);
            var st = await rig.Do("{\"op\":\"state\"}");
            Assert.Equal("error", (string?)st["computers"]![0]!["state"]);
            Assert.Equal(0, rig.Model.Count);
        }

        [Fact]
        public async Task TheKeyNeverComesBack()
        {
            await using var rig = new UnoRig();
            rig.Env = null;
            const string key = "sk-ant-api03-SAVEDKEY-zyxwvutsrqponmlkjihgfedcba-K7k7";
            var saved = await rig.Do("{\"op\":\"saveKey\",\"key\":\"" + key + "\"}");
            Assert.True((bool)saved["ok"]!);
            Assert.Equal("saved", (string?)saved["settings"]!["keySource"]);
            Assert.Equal("sk-ant-…K7k7", (string?)saved["settings"]!["keyHint"]);
            Assert.True((bool)saved["settings"]!["hasKey"]!);
            Assert.DoesNotContain(key, saved.ToJsonString());

            var check = await rig.Do("{\"op\":\"check\"}");
            Assert.Equal("The API key works and Claude Opus 5.5 is ready. Docker is running and the computer is set up.", (string?)check["text"]);
            Assert.DoesNotContain(key, check.ToJsonString());
            Assert.DoesNotContain(key, (await rig.Do("{\"op\":\"state\"}")).ToJsonString());
            Assert.DoesNotContain(key, (await rig.Hub.HandleAsync(new JsonObject { ["op"] = "state" }, false)).ToJsonString());
            Assert.DoesNotContain(key, rig.Hub.PushState().ToJsonString());

            var bad = await rig.Do("{\"op\":\"saveKey\",\"key\":\"sk-ant-bad-key-0000000000000000000000000000\"}");
            Assert.True((bool)bad["ok"]!);
            Assert.StartsWith("The API key didn't work.", (string?)(await rig.Do("{\"op\":\"check\"}"))["text"]);
            Assert.Contains("start with sk-ant-", (string?)(await rig.Do("{\"op\":\"saveKey\",\"key\":\"hello\"}"))["error"]);

            var removed = await rig.Do("{\"op\":\"removeKey\"}");
            Assert.False((bool)removed["settings"]!["hasKey"]!);
            Assert.Equal("none", (string?)removed["settings"]!["keySource"]);
            rig.Docker.Running = false;
            Assert.Equal("Add an Anthropic API key to use Squall Uno. Docker is installed but not running. Start Docker Desktop.", (string?)(await rig.Do("{\"op\":\"check\"}"))["text"]);
        }

        [Fact]
        public async Task FramesStreamOnlyWhileSomeoneNeedsThem()
        {
            await using var rig = new UnoRig();
            rig.Model.Reply("end_turn", FakeModel.Text("Hi."));
            string sid = await rig.Start();
            await rig.Hub.RunTask(sid);
            await Wait.Until(() => !rig.Hub.Streaming("pc-chief"), "streaming to stop once the session ended");
            int imports = rig.Docker.Calls.Count(c => c.Contains("import"));
            await Task.Delay(200);
            Assert.Equal(imports, rig.Docker.Calls.Count(c => c.Contains("import")));

            var frames = new ConcurrentQueue<(string Id, UnoFrame F)>();
            rig.Hub.WatchedFrame += (id, f) => frames.Enqueue((id, f));
            Assert.True((bool)(await rig.Do("{\"op\":\"watch\",\"computerId\":\"pc-chief\"}"))["ok"]!);
            await Wait.Until(() => frames.Count >= 2, "frames for the watched computer");
            var (fid, frame) = frames.Last();
            Assert.Equal("pc-chief", fid);
            Assert.Equal(FakeDocker.Jpeg, frame.Jpeg);
            Assert.Equal((10, 20), (frame.CursorX, frame.CursorY));
            var push = UnoHub.FrameJson(fid, frame);
            Assert.Equal(Convert.ToBase64String(FakeDocker.Jpeg), (string?)push["jpeg"]);
            Assert.Null(push["event"]);

            Assert.True((bool)(await rig.Do("{\"op\":\"watch\",\"computerId\":null}"))["ok"]!);
            await Wait.Until(() => !rig.Hub.Streaming("pc-chief"), "streaming to stop when nobody watches");

            Assert.Equal(404, rig.Hub.PhoneFrame("pc-nobody", 0).Status);
            var (status, f) = rig.Hub.PhoneFrame("pc-chief", 0);
            Assert.Equal(200, status);   // the newest frame is kept
            Assert.Equal(FakeDocker.Jpeg, f!.Jpeg);
            await Wait.Until(() => rig.Hub.Streaming("pc-chief") || rig.Hub.LatestFrame("pc-chief")!.Seq > f.Seq, "a phone's request to start streaming");

            Assert.True((bool)(await rig.Do("{\"op\":\"computerOff\",\"computerId\":\"pc-chief\"}"))["ok"]!);
            Assert.Contains(rig.Docker.Calls, c => string.Join(" ", c) == "docker rm -f squall-uno-pc-chief");
            var st = await rig.Do("{\"op\":\"state\"}");
            Assert.Equal("off", (string?)st["computers"]![0]!["state"]);
            Assert.Equal(0, (long)st["computers"]![0]!["frameSeq"]!);
            Assert.Equal(404, rig.Hub.PhoneFrame("pc-chief", 0).Status);
        }
    }
}
