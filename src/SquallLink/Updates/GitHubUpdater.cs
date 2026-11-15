using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net.Http;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace Squall.Link.Updates
{
    /// <summary>A GitHub release with a Squall build in it.</summary>
    public sealed record ReleaseInfo(Version Version, string Tag, string Name, string ZipUrl, string ShaUrl, string Notes);

    /// <summary>A new version that is downloaded, checked and unzipped, waiting to be installed.</summary>
    public sealed record StagedUpdate(Version Version, string Folder, string Exe, ReleaseInfo Release);

    /// <summary>Where Squall's releases are and what they're called. The defaults are Squall's.</summary>
    public sealed class UpdaterOptions
    {
        /// <summary>The GitHub repo with Squall's releases.</summary>
        public string Repo { get; set; } = "Stormblazerplayz/Squall-computer";
        /// <summary>The release file with the app in it (the release workflow makes it), and its SHA-256 file.</summary>
        public string AssetName { get; set; } = "Squall-win-x64.zip";
        public string ShaName => AssetName + ".sha256";
        /// <summary>The program that swaps the files while Squall is closed.</summary>
        public string SwapExe { get; set; } = "SquallSwap.exe";
        /// <summary>The app's program names, newest first.</summary>
        public string[] AppNames { get; set; } = { "Squall" };
        /// <summary>Where downloads, the backup and the update log go.</summary>
        public string Folder { get; set; } = Path.Combine(LinkOptions.DefaultFolder, "updates");
        /// <summary>The installed app's folder (the files that get replaced).</summary>
        public string InstallFolder { get; set; } = AppContext.BaseDirectory;
        /// <summary>This copy's version. Null reads it from the running program.</summary>
        public Version? CurrentVersion { get; set; }
        /// <summary>Also take pre-releases (betas).</summary>
        public bool Beta { get; set; }
        /// <summary>How often to look for a new version.</summary>
        public TimeSpan Every { get; set; } = TimeSpan.FromHours(6);
        /// <summary>For tests: how HTTP is done.</summary>
        public HttpMessageHandler? Http { get; set; }
    }

    /// <summary>
    /// Keeps Squall up to date from GitHub Releases, the same way Ace for PC does: it checks the newest release,
    /// downloads its zip, checks it against the release's SHA-256 file, unzips it, then hands over to SquallSwap,
    /// which swaps the files while Squall is closed, keeps a backup and rolls back if the new version doesn't start.
    /// </summary>
    public sealed class GitHubUpdater
    {
        /// <summary>Versions keep a 4th number so betas sort right: 2.1.0-beta.3 is 2.1.0.3 and the real 2.1.0 is 2.1.0.FinalRevision.</summary>
        public const int FinalRevision = int.MaxValue;
        private const long MaxDownload = 1_500_000_000;

        private readonly UpdaterOptions _o;
        private readonly HttpClient _http;
        private int _busy;
        private SavedState? _state;

        /// <summary>Raised (on any thread) when Status changes.</summary>
        public event Action? Changed;
        /// <summary>What the updater is doing or found last ("You're up to date").</summary>
        public string Status { get; private set; } = "";
        /// <summary>A newer version that is downloaded and checked, waiting for a good moment to install.</summary>
        public StagedUpdate? Ready { get; private set; }
        public bool Busy => Volatile.Read(ref _busy) == 1;

        public GitHubUpdater(UpdaterOptions? options = null)
        {
            _o = options ?? new UpdaterOptions();
            _http = _o.Http != null ? new HttpClient(_o.Http, disposeHandler: false) : new HttpClient();
            _http.Timeout = TimeSpan.FromMinutes(10);
            _http.DefaultRequestHeaders.UserAgent.ParseAdd("Squall-Updater/1.0");
            _http.DefaultRequestHeaders.Accept.ParseAdd("application/vnd.github+json");
        }

        public UpdaterOptions Options => _o;
        public string LogPath => Path.Combine(_o.Folder, "updater.log");
        private string StatePath => Path.Combine(_o.Folder, "update-state.json");

        // ===================================================================== Versions

        /// <summary>This copy's version (the release workflow sets it from the tag, like v1.2.0 → 1.2.0).</summary>
        public Version Current
        {
            get
            {
                if (_o.CurrentVersion != null) return Norm(_o.CurrentVersion);
                var asm = Assembly.GetEntryAssembly() ?? typeof(GitHubUpdater).Assembly;
                string? info = asm.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
                return ParseVersion(info ?? "") ?? Norm(asm.GetName().Version ?? new Version(0, 0, 0));
            }
        }

        public string CurrentText => Text(Current);

        public static bool IsBeta(Version v) => v.Revision >= 0 && v.Revision < FinalRevision;

        public static string Text(Version v) =>
            $"{v.Major}.{v.Minor}.{Math.Max(0, v.Build)}" + (IsBeta(v) ? "-beta" + (v.Revision > 0 ? "." + v.Revision : "") : "");

        /// <summary>"v1.0.1" → 1.0.1, "1.1" → 1.1.0, "v1.2.0-beta.3" → the 3rd beta of 1.2.0, "1.0.0+8f1c2a" → 1.0.0. Null if it isn't a version.</summary>
        public static Version? ParseVersion(string tag)
        {
            var m = Regex.Match((tag ?? "").Trim(), @"^[vV]?(\d+)\.(\d+)(?:\.(\d+))?(?:\.\d+)?(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$");
            if (!m.Success) return null;
            try
            {
                int rev = FinalRevision;
                if (m.Groups[4].Success)
                {
                    var n = Regex.Match(m.Groups[4].Value, @"(\d+)(?!.*\d)");
                    rev = n.Success && int.TryParse(n.Groups[1].Value, out int b) ? Math.Min(b, FinalRevision - 1) : 0;
                }
                return new Version(int.Parse(m.Groups[1].Value), int.Parse(m.Groups[2].Value),
                                   m.Groups[3].Success ? int.Parse(m.Groups[3].Value) : 0, rev);
            }
            catch (OverflowException) { return null; }
        }

        private static Version Norm(Version v) => new(v.Major, v.Minor, Math.Max(0, v.Build), v.Revision is >= 0 and < FinalRevision ? v.Revision : FinalRevision);

        // ===================================================================== Saved state

        internal sealed class SavedState
        {
            public DateTime LastCheck { get; set; }
            public string LastRunVersion { get; set; } = "";
            public string UpdatedFrom { get; set; } = "";
            public DateTime UpdatedAt { get; set; }
            public string AppliedShownFor { get; set; } = "";
            public string NotesFor { get; set; } = "";
            public string Notes { get; set; } = "";
        }

        private SavedState State
        {
            get
            {
                if (_state != null) return _state;
                try { if (File.Exists(StatePath)) _state = JsonSerializer.Deserialize(File.ReadAllText(StatePath), UpdateJson.Default.SavedState); }
                catch (Exception) { }
                return _state ??= new SavedState();
            }
        }

        private void SaveState()
        {
            try { Directory.CreateDirectory(_o.Folder); File.WriteAllText(StatePath, JsonSerializer.Serialize(State, UpdateJson.Default.SavedState)); }
            catch (Exception) { }
        }

        public DateTime LastCheck => State.LastCheck;
        public bool CheckDue => DateTime.Now - State.LastCheck >= _o.Every;

        /// <summary>The file the new version writes once it has started fine; SquallSwap waits for it.</summary>
        public string OkFile(Version v) => Path.Combine(_o.Folder, $"started-{Text(v)}.ok");

        /// <summary>
        /// Call once Squall's window is up: tells SquallSwap (if it's waiting) that this version works. Returns the
        /// version it was updated from, when this is the first start after an update (for the "Squall updated" card), or null.
        /// </summary>
        public (string From, string Notes)? MarkStartedOk()
        {
            try
            {
                Directory.CreateDirectory(_o.Folder);
                File.WriteAllText(OkFile(Current), DateTime.Now.ToString("o"));
                string now = CurrentText;
                (string, string)? fresh = null;
                if (State.LastRunVersion.Length > 0 && State.LastRunVersion != now && ParseVersion(State.LastRunVersion) is { } old && old < Current)
                {
                    State.UpdatedFrom = State.LastRunVersion;
                    State.UpdatedAt = DateTime.Now;
                    fresh = (State.UpdatedFrom, State.NotesFor == now ? State.Notes : "");
                }
                State.LastRunVersion = now;
                SaveState();
                return fresh;
            }
            catch (Exception) { return null; }
        }

        /// <summary>
        /// True when Squall runs from a build folder (bin\Debug or bin\Release next to a .csproj). Swapping those files
        /// wouldn't stick, so updates are only installed into a copy made from a release zip.
        /// </summary>
        public bool RunningFromSource => FromSource(_o.InstallFolder);

        public static bool FromSource(string baseDir)
        {
            try
            {
                var dir = new DirectoryInfo(baseDir.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
                bool sawBin = false;
                for (int i = 0; i < 6 && dir != null; i++, dir = dir.Parent)
                {
                    if (dir.Name.Equals("bin", StringComparison.OrdinalIgnoreCase)) sawBin = true;
                    else if (sawBin && dir.GetFiles("*.csproj").Length > 0) return true;
                }
            }
            catch (Exception) { }
            return false;
        }

        private void SetStatus(string s) { Status = s; try { Changed?.Invoke(); } catch (Exception) { } }

        // ===================================================================== GitHub

        /// <summary>The newest usable release, or null (with why in Status).</summary>
        public async Task<ReleaseInfo?> LatestAsync(CancellationToken ct)
        {
            string url = _o.Beta ? $"https://api.github.com/repos/{_o.Repo}/releases?per_page=30" : $"https://api.github.com/repos/{_o.Repo}/releases/latest";
            HttpResponseMessage res;
            try { res = await _http.GetAsync(url, ct).ConfigureAwait(false); }
            catch (Exception ex) when (ex is HttpRequestException || (ex is TaskCanceledException && !ct.IsCancellationRequested))
            {
                SetStatus("Couldn't reach GitHub. I'll try again later.");
                return null;
            }
            using (res)
            {
                int code = (int)res.StatusCode;
                if (code == 404) { SetStatus("There's no Squall release on GitHub yet."); return null; }
                if (code is 403 or 429) { SetStatus("GitHub says to slow down. I'll try again later."); return null; }
                if (!res.IsSuccessStatusCode) { SetStatus($"GitHub answered with an error ({code}). I'll try again later."); return null; }
                string json = await res.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
                var rel = _o.Beta ? NewestRelease(json, true) : ParseRelease(json);
                if (rel == null) SetStatus($"The newest release doesn't have {_o.AssetName} and {_o.ShaName} in it yet.");
                return rel;
            }
        }

        /// <summary>Reads one release from GitHub's JSON. Null if it has no version tag, zip or SHA-256 file, or is a beta (unless includeBetas).</summary>
        public ReleaseInfo? ParseRelease(string json, bool includeBetas = false)
        {
            try { using var doc = JsonDocument.Parse(json); return ReadRelease(doc.RootElement, includeBetas); }
            catch (JsonException) { return null; }
        }

        /// <summary>The newest usable release in GitHub's list of releases.</summary>
        public ReleaseInfo? NewestRelease(string listJson, bool includeBetas)
        {
            try
            {
                using var doc = JsonDocument.Parse(listJson);
                if (doc.RootElement.ValueKind != JsonValueKind.Array) return null;
                ReleaseInfo? best = null;
                foreach (var el in doc.RootElement.EnumerateArray())
                    if (ReadRelease(el, includeBetas) is { } r && (best == null || r.Version > best.Version)) best = r;
                return best;
            }
            catch (JsonException) { return null; }
        }

        private ReleaseInfo? ReadRelease(JsonElement root, bool includeBetas)
        {
            if (root.ValueKind != JsonValueKind.Object) return null;
            if (root.TryGetProperty("draft", out var d) && d.ValueKind == JsonValueKind.True) return null;
            bool pre = root.TryGetProperty("prerelease", out var p) && p.ValueKind == JsonValueKind.True;
            if (pre && !includeBetas) return null;
            string tag = Str(root, "tag_name");
            var version = ParseVersion(tag);
            if (version == null || (IsBeta(version) && !includeBetas)) return null;
            string zip = "", sha = "";
            if (root.TryGetProperty("assets", out var assets) && assets.ValueKind == JsonValueKind.Array)
                foreach (var a in assets.EnumerateArray())
                {
                    if (a.ValueKind != JsonValueKind.Object) continue;
                    string name = Str(a, "name"), url = Str(a, "browser_download_url");
                    if (!SafeDownloadUrl(url)) continue;
                    if (name.Equals(_o.AssetName, StringComparison.OrdinalIgnoreCase)) zip = url;
                    else if (name.Equals(_o.ShaName, StringComparison.OrdinalIgnoreCase)) sha = url;
                }
            if (zip.Length == 0 || sha.Length == 0) return null;
            string title = Str(root, "name");
            return new ReleaseInfo(version, tag, title.Length > 0 ? title : tag, zip, sha, Str(root, "body"));
        }

        private static string Str(JsonElement o, string key) =>
            o.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";

        /// <summary>Only downloads from GitHub itself (release files live on github.com and redirect to its storage).</summary>
        public static bool SafeDownloadUrl(string url) =>
            Uri.TryCreate(url, UriKind.Absolute, out var u) && u.Scheme == Uri.UriSchemeHttps &&
            (u.Host.Equals("github.com", StringComparison.OrdinalIgnoreCase) || u.Host.EndsWith(".githubusercontent.com", StringComparison.OrdinalIgnoreCase));

        // ===================================================================== Download, check and unzip

        /// <summary>
        /// Checks the zip against the SHA-256 text ("hash" or "hash  file.zip"), unzips it into stageDir and returns the
        /// folder that holds the app. Null with the reason in error if not.
        /// </summary>
        public string? VerifyAndExtract(string zipPath, string shaText, string stageDir, out string error)
        {
            error = "";
            var want = Regex.Match(shaText ?? "", @"\b[0-9a-fA-F]{64}\b");
            if (!want.Success) { error = "The SHA-256 file is empty or broken."; return null; }
            string got;
            using (var fs = File.OpenRead(zipPath)) got = Convert.ToHexString(SHA256.HashData(fs));
            if (!got.Equals(want.Value, StringComparison.OrdinalIgnoreCase)) { error = "The download didn't match its SHA-256, so I didn't install it."; return null; }
            try
            {
                if (Directory.Exists(stageDir)) Directory.Delete(stageDir, recursive: true);
                Directory.CreateDirectory(stageDir);
                ZipFile.ExtractToDirectory(zipPath, stageDir);   // refuses entries that point outside the folder
            }
            catch (Exception ex) { error = "Couldn't unzip the update: " + ex.Message; return null; }
            string? app = FindApp(stageDir);
            if (app == null) error = "The update zip doesn't have Squall in it.";
            else if (!File.Exists(Path.Combine(app, _o.SwapExe))) { error = $"The update zip is missing {_o.SwapExe}, so I didn't install it."; return null; }
            return app;
        }

        private string? FindApp(string dir)
        {
            if (AppExeIn(dir) != null) return dir;
            foreach (var sub in Directory.GetDirectories(dir))
            {
                if (AppExeIn(sub) != null) return sub;
                foreach (var sub2 in Directory.GetDirectories(sub)) if (AppExeIn(sub2) != null) return sub2;
            }
            return null;
        }

        /// <summary>The program in a folder ("Squall.exe"), or null.</summary>
        public string? AppExeIn(string dir)
        {
            foreach (var name in _o.AppNames)
                if (File.Exists(Path.Combine(dir, name + ".exe"))) return name + ".exe";
            return null;
        }

        private async Task DownloadAsync(string url, string path, CancellationToken ct, Action<double>? progress)
        {
            using var res = await _http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
            res.EnsureSuccessStatusCode();
            if (res.RequestMessage?.RequestUri is { } final && !SafeDownloadUrl(final.ToString()))
                throw new HttpRequestException("The download went somewhere other than GitHub.");
            long total = res.Content.Headers.ContentLength ?? -1;
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            await using var src = await res.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
            await using var dst = File.Create(path);
            var buf = new byte[81920];
            long done = 0;
            int n;
            while ((n = await src.ReadAsync(buf, ct).ConfigureAwait(false)) > 0)
            {
                await dst.WriteAsync(buf.AsMemory(0, n), ct).ConfigureAwait(false);
                done += n;
                if (total > 0) progress?.Invoke((double)done / total);
                if (done > MaxDownload) throw new IOException("The download is way too big.");
            }
        }

        // ===================================================================== The whole thing

        /// <summary>
        /// Checks GitHub and, if there's a newer Squall, downloads, checks and unzips it so it's <see cref="Ready"/>.
        /// It doesn't install anything: call <see cref="Install"/> when Squall isn't busy. Anything that goes wrong
        /// leaves this version exactly as it is. Returns the staged update, or null.
        /// </summary>
        public async Task<StagedUpdate?> CheckAsync(CancellationToken ct = default)
        {
            if (Interlocked.Exchange(ref _busy, 1) == 1) return Ready;
            try
            {
                SetStatus("Checking GitHub for a new Squall…");
                var rel = await LatestAsync(ct).ConfigureAwait(false);
                if (rel == null) return Ready;
                State.LastCheck = DateTime.Now;
                SaveState();
                if (rel.Version <= Current)
                {
                    Ready = null;
                    SetStatus($"You're up to date (Squall {CurrentText}).");
                    return null;
                }
                if (RunningFromSource)
                {
                    SetStatus($"Squall {Text(rel.Version)} is out. You're running from the source code, so I can't swap the files. " +
                              $"Download {_o.AssetName} from the GitHub release once, and that copy updates itself.");
                    return null;
                }
                if (Ready != null && Ready.Version == rel.Version && Directory.Exists(Ready.Folder)) return Ready;

                string dir = Path.Combine(_o.Folder, "v" + Text(rel.Version));
                string stage = Path.Combine(dir, "new");
                string verified = Path.Combine(dir, "verified");
                string? app = File.Exists(verified) && Directory.Exists(stage) ? FindApp(stage) : null;
                if (app == null)
                {
                    string zip = Path.Combine(dir, _o.AssetName);
                    SetStatus($"Downloading Squall {Text(rel.Version)}…");
                    await DownloadAsync(rel.ZipUrl, zip, ct, f => SetStatus($"Downloading Squall {Text(rel.Version)}… {f:P0}")).ConfigureAwait(false);
                    string sha = await _http.GetStringAsync(rel.ShaUrl, ct).ConfigureAwait(false);
                    app = VerifyAndExtract(zip, sha, stage, out string error);
                    try { File.Delete(zip); } catch (Exception) { }
                    if (app == null) { SetStatus(error); return null; }
                    File.WriteAllText(verified, DateTime.Now.ToString("o"));
                }
                CleanOld(rel.Version);
                State.NotesFor = Text(rel.Version);
                State.Notes = rel.Notes.Length > 4000 ? rel.Notes.Substring(0, 4000) : rel.Notes;
                SaveState();
                Ready = new StagedUpdate(rel.Version, app, AppExeIn(app)!, rel);
                SetStatus($"Squall {Text(rel.Version)} is ready to install.");
                return Ready;
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { SetStatus("Update check stopped."); return null; }
            catch (Exception ex) { SetStatus("The update didn't download: " + ex.Message); return null; }
            finally { Interlocked.Exchange(ref _busy, 0); }
        }

        /// <summary>Deletes downloads of other versions (the backup folder stays).</summary>
        private void CleanOld(Version keep)
        {
            try
            {
                foreach (var d in Directory.GetDirectories(_o.Folder, "v*"))
                    if (!Path.GetFileName(d).Equals("v" + Text(keep), StringComparison.OrdinalIgnoreCase))
                        try { Directory.Delete(d, recursive: true); } catch (Exception) { }
            }
            catch (Exception) { }
        }

        /// <summary>The command line SquallSwap gets for an update.</summary>
        public string[] SwapArguments(StagedUpdate up, int pid) => new[]
        {
            "--pid", pid.ToString(),
            "--source", up.Folder,
            "--target", _o.InstallFolder.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar),
            "--backup", Path.Combine(_o.Folder, "backup"),
            "--exe", up.Exe,
            "--ok", OkFile(up.Version),
            "--log", LogPath,
        };

        /// <summary>
        /// Starts SquallSwap from the new files (so it isn't one of the files being replaced). When this returns null,
        /// SquallSwap is waiting: close Squall right away and it swaps the files and starts the new version.
        /// Otherwise it says why nothing happened.
        /// </summary>
        public string? Install(Func<string, IEnumerable<string>, Process?>? start = null)
        {
            var up = Ready;
            if (up == null) return "There's no update ready.";
            if (RunningFromSource) return "Squall is running from the source code, so it can't update itself.";
            string runner = Path.Combine(up.Folder, _o.SwapExe);
            if (!File.Exists(runner)) return $"The update is missing {_o.SwapExe}, so I didn't install it.";
            start ??= (exe, args) =>
            {
                var psi = new ProcessStartInfo(exe) { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = up.Folder };
                foreach (var a in args) psi.ArgumentList.Add(a);
                return Process.Start(psi);
            };
            try
            {
                var p = start(runner, SwapArguments(up, Environment.ProcessId));
                if (p == null) return "Couldn't start the updater.";
                SetStatus($"Updating to Squall {Text(up.Version)}. Squall will be right back!");
                return null;
            }
            catch (Exception ex) { return "Couldn't start the updater: " + ex.Message; }
        }
    }

    [JsonSerializable(typeof(GitHubUpdater.SavedState))]
    internal partial class UpdateJson : JsonSerializerContext { }
}
