using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Squall.Link.Pairing;
using Squall.Link.Server;
using Squall.Link.Uno;
using Squall.Link.Updates;

namespace Squall.Link
{
    /// <summary>
    /// Everything Squall.exe needs for the phone app and for updates, in one object. The host does three things
    /// (see docs/desktop-link.md):
    ///   1. new SquallDesktopLink(), AttachPage(json => webView.CoreWebView2.PostWebMessageAsJson(json)) on the UI thread,
    ///      set RequestExit, then await StartAsync().
    ///   2. For the bridge command "link", answer with await HandlePageCommandAsync(args).
    ///   3. In its "updateRestart" handler, first call InstallUpdateIfReady(); if it returns true, Squall is closing.
    /// </summary>
    public sealed class SquallDesktopLink : IAsyncDisposable
    {
        public LinkOptions Options { get; }
        public PairingWindow Pairing { get; }
        public PairedPhones Phones { get; }
        public PageRelay Page { get; }
        public LinkServer Server { get; }
        public GitHubUpdater Updates { get; }
        /// <summary>Squall Uno: the agents' own computers and live computer use (docs/squall-uno.md).</summary>
        public UnoHub Uno { get; }
        public string ComputerId { get; }

        /// <summary>Closes Squall (on the UI thread). Called right after the updater has started.</summary>
        public Action? RequestExit { get; set; }

        private Timer? _updateTimer;
        private (string From, string Notes)? _applied;
        private string _announced = "";
        private bool _pageHello;

        public SquallDesktopLink(LinkOptions? options = null, UpdaterOptions? updates = null, UnoHubOptions? uno = null)
        {
            Options = options ?? new LinkOptions();
            ComputerId = ComputerIdentity.Id(Options.Folder);
            Pairing = new PairingWindow(Options.CodeLifetime, Options.MaxWrongTries);
            Phones = new PairedPhones(Options.Folder);
            Page = new PageRelay();
            Uno = new UnoHub(System.IO.Path.Combine(Options.Folder, "uno"), uno);
            Server = new LinkServer(Options, Pairing, Phones, Page, ComputerId, Uno);
            Updates = new GitHubUpdater(updates ?? new UpdaterOptions { Folder = System.IO.Path.Combine(Options.Folder, "updates") });
            Server.Paired += p =>
            {
                Pairing.Close();
                Page.Tell("linkPaired", new JsonObject { ["deviceName"] = p.Device.DeviceName, ["platform"] = p.Device.Platform });
            };
            Phones.Changed += () => Page.Tell("linkPhones", new JsonObject { ["phones"] = PhonesJson() });
            Updates.Changed += () => Page.Tell("linkUpdate", UpdateJson());
            // Pushes arrive in the page as {"event": name, ...payload}, so no payload uses the key "event".
            Uno.EventAdded += e => Page.Tell("uno", new JsonObject { ["ev"] = e.ToJson() });
            Uno.Changed += () => Page.Tell("unoState", Uno.PushState());
            Uno.WatchedFrame += (id, f) => Page.Tell("unoFrame", UnoHub.FrameJson(id, f));
        }

        /// <summary>Connects the Squall window. post must be safe to call from any thread (dispatch to the UI thread).</summary>
        public void AttachPage(Action<string> post) => Page.Attach(post);

        /// <summary>
        /// Starts the phone API (so paired phones can connect), tells a waiting updater this version started fine,
        /// and checks GitHub for updates a minute from now and every few hours after.
        /// </summary>
        public async Task<bool> StartAsync(bool checkForUpdates = true)
        {
            _applied = Updates.MarkStartedOk();
            bool ok = await Server.StartAsync().ConfigureAwait(false);
            if (checkForUpdates && _updateTimer == null)
                _updateTimer = new Timer(_ => { if (Updates.CheckDue) _ = CheckForUpdateAsync(); }, null, TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(30));
            return ok;
        }

        /// <summary>Checks GitHub now; when a new version is staged, the Squall window shows its Update chip.</summary>
        public async Task<StagedUpdate?> CheckForUpdateAsync(CancellationToken ct = default)
        {
            var ready = await Updates.CheckAsync(ct).ConfigureAwait(false);
            if (ready != null) AnnounceUpdate(ready);
            return ready;
        }

        private void AnnounceUpdate(StagedUpdate ready)
        {
            string v = GitHubUpdater.Text(ready.Version);
            var bullets = new JsonArray();
            foreach (var b in ReleaseNotes.Bullets(ready.Release.Notes)) bullets.Add(b);
            if (Page.Tell("update", new JsonObject { ["newer"] = true, ["build"] = v, ["summary"] = bullets, ["source"] = "github" }))
                _announced = v;
        }

        /// <summary>
        /// For the host's "updateRestart": if a GitHub update is staged, starts SquallSwap and asks Squall to close.
        /// False means there was no GitHub update (or it couldn't start), so the host carries on as before.
        /// </summary>
        public bool InstallUpdateIfReady()
        {
            if (Updates.Ready == null) return false;
            string? why = Updates.Install();
            if (why != null)
            {
                var u = UpdateJson();
                u["status"] = why;
                Page.Tell("linkUpdate", u);
                return false;
            }
            RequestExit?.Invoke();
            return true;
        }

        // ===================================================================== The bridge command "link"

        /// <summary>
        /// Answers the page's Bridge.call('link', {do: ...}). Unknown requests throw ArgumentException, which the host
        /// reports to the page as an error like any other bridge command.
        /// </summary>
        public async Task<JsonNode?> HandlePageCommandAsync(JsonElement args)
        {
            string what = args.ValueKind == JsonValueKind.Object && args.TryGetProperty("do", out var d) && d.ValueKind == JsonValueKind.String ? d.GetString() ?? "" : "";
            switch (what)
            {
                case "hello":
                    _pageHello = true;
                    if (_applied is { } ap)
                    {
                        _applied = null;
                        var bullets = new JsonArray();
                        foreach (var b in ReleaseNotes.Bullets(ap.Notes)) bullets.Add(b);
                        Page.Tell("applied", new JsonObject { ["build"] = Updates.CurrentText, ["from"] = ap.From, ["summary"] = bullets });
                    }
                    if (Updates.Ready is { } r && _announced != GitHubUpdater.Text(r.Version)) AnnounceUpdate(r);
                    return Status();
                case "state":
                    return new JsonObject { ["ok"] = args.TryGetProperty("data", out var data) && Page.SetState(data) };
                case "answer":
                    {
                        string rid = args.TryGetProperty("rid", out var ridEl) && ridEl.ValueKind == JsonValueKind.String ? ridEl.GetString() ?? "" : "";
                        var result = args.TryGetProperty("result", out var res) ? res : default;
                        return new JsonObject { ["ok"] = result.ValueKind != JsonValueKind.Undefined && Page.Answer(rid, result) };
                    }
                case "status":
                    return Status();
                case "pairOpen":
                    return await PairScreenAsync().ConfigureAwait(false);
                case "pairClose":
                    Pairing.Close();
                    return Status();
                case "unpair":
                    {
                        string id = args.TryGetProperty("deviceId", out var idEl) && idEl.ValueKind == JsonValueKind.String ? idEl.GetString() ?? "" : "";
                        Phones.RemoveDevice(id);
                        return Status();
                    }
                case "unpairAll":
                    Phones.RemoveAll();
                    return Status();
                case "updateCheck":
                    await CheckForUpdateAsync().ConfigureAwait(false);
                    return Status();
                case "updateInstall":
                    return new JsonObject { ["ok"] = InstallUpdateIfReady(), ["status"] = Updates.Status };
                case "uno":
                    {
                        // The same ops as POST /api/v1/uno, plus "watch" (docs/squall-uno.md).
                        var request = JsonNode.Parse(args.GetRawText()) as JsonObject ?? new JsonObject();
                        request.Remove("do");
                        return await Uno.HandleAsync(request, fromPage: true).ConfigureAwait(false);
                    }
                default:
                    throw new ArgumentException("Unknown link request: " + what);
            }
        }

        /// <summary>Opens the Pair a phone screen: a fresh code, the QR code and the address to show.</summary>
        public async Task<JsonObject> PairScreenAsync()
        {
            if (!Server.Running) await Server.StartAsync().ConfigureAwait(false);
            var lan = LanAddresses.All();
            string? host = Options.LoopbackOnly ? "127.0.0.1" : lan.FirstOrDefault()?.Address;
            if (!Server.Running || host == null)
            {
                Pairing.Close();
                var st = Status();
                st["ok"] = false;
                st["error"] = !Server.Running ? (Server.Error.Length > 0 ? Server.Error : "The phone link couldn't start.")
                                              : "This computer isn't on a network. Connect it to the same Wi-Fi as your phone.";
                return st;
            }
            var code = Pairing.Open();
            string link = PairingLink.Build(host, Server.Port, code.Code, Options.ComputerName);
            var o = Status();
            o["ok"] = true;
            o["code"] = code.Code;
            o["expiresAt"] = code.ExpiresAt.ToUnixTimeMilliseconds();
            o["seconds"] = (int)Math.Round(Options.CodeLifetime.TotalSeconds);
            o["link"] = link;
            o["qrSvg"] = QrImage.Svg(link);
            o["address"] = host;
            var others = new JsonArray();
            foreach (var c in lan.Skip(1).Take(4)) others.Add(c.Address);
            o["otherAddresses"] = others;
            return o;
        }

        /// <summary>What the Settings screen shows: is the link on, the paired phones, and the update status.</summary>
        public JsonObject Status() => new()
        {
            ["running"] = Server.Running,
            ["port"] = Server.Running ? Server.Port : Options.Port,
            ["error"] = Server.Error,
            ["computerName"] = Options.ComputerName,
            ["listening"] = Pairing.IsOpen,
            ["phones"] = PhonesJson(),
            ["pageHello"] = _pageHello,
            ["update"] = UpdateJson(),
        };

        /// <summary>The update part of Status(), also sent to the page as "linkUpdate" whenever it changes.</summary>
        private JsonObject UpdateJson() => new()
        {
            ["current"] = Updates.CurrentText,
            ["status"] = Updates.Status,
            ["ready"] = Updates.Ready == null ? null : GitHubUpdater.Text(Updates.Ready.Version),
            ["busy"] = Updates.Busy,
        };

        private JsonArray PhonesJson()
        {
            var arr = new JsonArray();
            foreach (var p in Phones.All)
                arr.Add(new JsonObject
                {
                    ["deviceId"] = p.Device.DeviceId,
                    ["deviceName"] = p.Device.DeviceName,
                    ["platform"] = p.Device.Platform,
                    ["appVersion"] = p.Device.AppVersion,
                    ["pairedAt"] = p.PairedAt.ToUnixTimeMilliseconds(),
                    ["lastSeen"] = p.LastSeen.ToUnixTimeMilliseconds(),
                });
            return arr;
        }

        public async ValueTask DisposeAsync()
        {
            _updateTimer?.Dispose();
            _updateTimer = null;
            Page.Detach();
            await Server.DisposeAsync().ConfigureAwait(false);
            await Uno.DisposeAsync().ConfigureAwait(false);
        }
    }

    /// <summary>Turns GitHub's release notes into a few short lines for the Update chip and the "Squall updated" card.</summary>
    public static class ReleaseNotes
    {
        public static IReadOnlyList<string> Bullets(string? notes, int max = 6)
        {
            var list = new List<string>();
            foreach (var raw in (notes ?? "").Split('\n'))
            {
                var m = Regex.Match(raw.Trim(), @"^[-*]\s+(.+)$");
                if (!m.Success) continue;
                string s = m.Groups[1].Value;
                s = Regex.Replace(s, @"\[([^\]]+)\]\([^)]+\)", "$1");                 // [text](link) → text
                s = Regex.Replace(s, @"\s+by\s+@[\w-]+(\s+in\s+\S+)?\s*$", "");      // "… by @someone in https://…/pull/3"
                s = Regex.Replace(s, @"\s*\(?https?://\S+\)?\s*$", "");               // a trailing link
                s = s.Replace("**", "").Replace("`", "").Trim();
                if (s.Length == 0 || s.StartsWith("Full Changelog", StringComparison.OrdinalIgnoreCase)) continue;
                if (s.Length > 120) s = s.Substring(0, 119) + "…";
                list.Add(s);
                if (list.Count >= max) break;
            }
            return list;
        }
    }
}
