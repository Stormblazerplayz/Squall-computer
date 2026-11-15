using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Squall.Link.Updates;
using Xunit;

namespace Squall.Link.Tests
{
    /// <summary>Answers HTTP requests from a table, like GitHub would, for the updater tests.</summary>
    internal sealed class FakeGitHub : HttpMessageHandler
    {
        public readonly Dictionary<string, Func<HttpResponseMessage>> Routes = new();
        public readonly List<string> Asked = new();

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            string url = request.RequestUri!.ToString();
            Asked.Add(url);
            var res = Routes.TryGetValue(url, out var make) ? make() : new HttpResponseMessage(HttpStatusCode.NotFound);
            res.RequestMessage = request;
            return Task.FromResult(res);
        }

        public static HttpResponseMessage Text(string s) => new(HttpStatusCode.OK) { Content = new StringContent(s, Encoding.UTF8) };
        public static HttpResponseMessage Bytes(byte[] b) => new(HttpStatusCode.OK) { Content = new ByteArrayContent(b) };
    }

    public class VersionTests
    {
        [Theory]
        [InlineData("v1.0.1", "1.0.1")]
        [InlineData("1.1", "1.1.0")]
        [InlineData("V2.3.4", "2.3.4")]
        [InlineData("v1.2.0-beta.3", "1.2.0-beta.3")]
        [InlineData("1.0.0+8f1c2a", "1.0.0")]
        [InlineData("1.2.0-beta", "1.2.0-beta")]
        public void ParsesTags(string tag, string text) => Assert.Equal(text, GitHubUpdater.Text(GitHubUpdater.ParseVersion(tag)!));

        [Theory]
        [InlineData("")]
        [InlineData("latest")]
        [InlineData("v1")]
        [InlineData("1.2.3.4.5")]
        [InlineData("v99999999999.0.0")]
        public void RefusesNonVersions(string tag) => Assert.Null(GitHubUpdater.ParseVersion(tag));

        [Fact]
        public void BetasSortBeforeTheRealThing()
        {
            var b1 = GitHubUpdater.ParseVersion("1.2.0-beta.1")!;
            var b2 = GitHubUpdater.ParseVersion("1.2.0-beta.2")!;
            var real = GitHubUpdater.ParseVersion("1.2.0")!;
            var next = GitHubUpdater.ParseVersion("1.2.1-beta.1")!;
            Assert.True(b1 < b2 && b2 < real && real < next);
            Assert.True(GitHubUpdater.IsBeta(b1));
            Assert.False(GitHubUpdater.IsBeta(real));
        }

        [Fact]
        public void OnlyGitHubDownloadsAreAllowed()
        {
            Assert.True(GitHubUpdater.SafeDownloadUrl("https://github.com/Stormblazerplayz/Squall-computer/releases/download/v1.0.0/Squall-win-x64.zip"));
            Assert.True(GitHubUpdater.SafeDownloadUrl("https://objects.githubusercontent.com/x"));
            Assert.False(GitHubUpdater.SafeDownloadUrl("http://github.com/x"));
            Assert.False(GitHubUpdater.SafeDownloadUrl("https://github.com.evil.example/x"));
            Assert.False(GitHubUpdater.SafeDownloadUrl("https://evilgithubusercontent.com/x"));
            Assert.False(GitHubUpdater.SafeDownloadUrl("not a url"));
        }

        [Fact]
        public void ReleaseNotesBecomeShortLines()
        {
            const string notes = "## What's Changed\n* Pair the phone with a QR code by @Stormblazerplayz in https://github.com/Stormblazerplayz/Squall-computer/pull/1\n" +
                                 "- **Faster** updates\n* See [the docs](https://example.com/docs)\n\n**Full Changelog**: https://github.com/x/compare/v1...v2";
            var lines = ReleaseNotes.Bullets(notes);
            Assert.Equal(new[] { "Pair the phone with a QR code", "Faster updates", "See the docs" }, lines);
            Assert.Empty(ReleaseNotes.Bullets(null));
        }
    }

    public class UpdaterTests
    {
        private const string Api = "https://api.github.com/repos/Stormblazerplayz/Squall-computer/releases/latest";
        private const string ZipUrl = "https://github.com/Stormblazerplayz/Squall-computer/releases/download/v1.3.0/Squall-win-x64.zip";
        private const string ShaUrl = ZipUrl + ".sha256";

        private static string ReleaseJson(string tag = "v1.3.0", bool pre = false, string zipUrl = ZipUrl, string shaUrl = ShaUrl) =>
            "{\"tag_name\":\"" + tag + "\",\"name\":\"Squall " + tag + "\",\"draft\":false,\"prerelease\":" + (pre ? "true" : "false") +
            ",\"body\":\"* Pair with a QR code\",\"assets\":[" +
            "{\"name\":\"Squall-win-x64.zip\",\"browser_download_url\":\"" + zipUrl + "\"}," +
            "{\"name\":\"Squall-win-x64.zip.sha256\",\"browser_download_url\":\"" + shaUrl + "\"}]}";

        /// <summary>A zip shaped like a real Squall release (made in the test; nothing here ships).</summary>
        private static byte[] MakeZip(bool withSwap = true, bool withApp = true, string top = "")
        {
            using var ms = new MemoryStream();
            using (var zip = new ZipArchive(ms, ZipArchiveMode.Create, leaveOpen: true))
            {
                void Add(string name, string content)
                {
                    var e = zip.CreateEntry(top + name);
                    using var w = new StreamWriter(e.Open());
                    w.Write(content);
                }
                if (withApp) Add("Squall.exe", "new exe");
                if (withSwap) Add("SquallSwap.exe", "swap");
                Add("web/index.html", "<html>new</html>");
            }
            return ms.ToArray();
        }

        private static string Sha(byte[] b) => Convert.ToHexString(SHA256.HashData(b)).ToLowerInvariant();

        private static (GitHubUpdater U, FakeGitHub Gh) Make(TempDir dir, string current = "1.2.0", bool beta = false)
        {
            var gh = new FakeGitHub();
            Directory.CreateDirectory(dir.Sub("install"));
            var u = new GitHubUpdater(new UpdaterOptions
            {
                Folder = dir.Sub("updates"), InstallFolder = dir.Sub("install"),
                CurrentVersion = GitHubUpdater.ParseVersion(current), Http = gh, Beta = beta,
            });
            return (u, gh);
        }

        [Fact]
        public async Task DownloadsChecksAndStagesANewerVersion()
        {
            using var dir = new TempDir();
            var (u, gh) = Make(dir);
            byte[] zip = MakeZip();
            gh.Routes[Api] = () => FakeGitHub.Text(ReleaseJson());
            gh.Routes[ZipUrl] = () => FakeGitHub.Bytes(zip);
            gh.Routes[ShaUrl] = () => FakeGitHub.Text(Sha(zip) + "  Squall-win-x64.zip\n");

            var ready = await u.CheckAsync();
            Assert.NotNull(ready);
            Assert.Equal("1.3.0", GitHubUpdater.Text(ready!.Version));
            Assert.Equal("Squall.exe", ready.Exe);
            Assert.Equal("new exe", File.ReadAllText(Path.Combine(ready.Folder, "Squall.exe")));
            Assert.False(File.Exists(Path.Combine(dir.Sub("updates", "v1.3.0"), "Squall-win-x64.zip")));   // the zip is cleaned up
            Assert.Contains("ready", u.Status);

            // checking again reuses the download
            gh.Asked.Clear();
            Assert.Same(ready, await u.CheckAsync());
            Assert.DoesNotContain(ZipUrl, gh.Asked);

            // what SquallSwap will be told
            var args = u.SwapArguments(ready, 1234);
            Assert.Equal(new[] { "--pid", "1234" }, args.Take(2));
            Assert.Equal("Squall.exe", args[Array.IndexOf(args, "--exe") + 1]);
            Assert.Equal(dir.Sub("install"), args[Array.IndexOf(args, "--target") + 1]);

            string? startedExe = null;
            IEnumerable<string>? startedArgs = null;
            Assert.Null(u.Install((exe, a) => { startedExe = exe; startedArgs = a; return System.Diagnostics.Process.GetCurrentProcess(); }));
            Assert.Equal(Path.Combine(ready.Folder, "SquallSwap.exe"), startedExe);
            Assert.Contains("--ok", startedArgs!);
        }

        [Fact]
        public async Task UpToDateAndMissingReleases()
        {
            using var dir = new TempDir();
            var (u, gh) = Make(dir, "1.3.0");
            gh.Routes[Api] = () => FakeGitHub.Text(ReleaseJson());
            Assert.Null(await u.CheckAsync());
            Assert.Contains("up to date", u.Status);
            Assert.Equal("There's no update ready.", u.Install());

            gh.Routes.Remove(Api);
            Assert.Null(await u.CheckAsync());
            Assert.Contains("no Squall release", u.Status);

            gh.Routes[Api] = () => new HttpResponseMessage((HttpStatusCode)403);
            Assert.Null(await u.CheckAsync());
            Assert.Contains("slow down", u.Status);
        }

        [Fact]
        public async Task ABadDownloadIsNeverInstalled()
        {
            using var dir = new TempDir();
            var (u, gh) = Make(dir);
            byte[] zip = MakeZip();
            gh.Routes[Api] = () => FakeGitHub.Text(ReleaseJson());
            gh.Routes[ZipUrl] = () => FakeGitHub.Bytes(zip);
            gh.Routes[ShaUrl] = () => FakeGitHub.Text(new string('0', 64));
            Assert.Null(await u.CheckAsync());
            Assert.Contains("didn't match", u.Status);
            Assert.Null(u.Ready);
        }

        [Fact]
        public void ReleasesWithoutTheRightFilesAreSkipped()
        {
            using var dir = new TempDir();
            var (u, _) = Make(dir);
            Assert.NotNull(u.ParseRelease(ReleaseJson()));
            Assert.Null(u.ParseRelease(ReleaseJson(pre: true)));
            Assert.NotNull(u.ParseRelease(ReleaseJson(pre: true), includeBetas: true));
            Assert.Null(u.ParseRelease(ReleaseJson("v1.3.0-beta.1")));   // a beta tag without the pre-release tick still waits for beta
            Assert.Null(u.ParseRelease(ReleaseJson(zipUrl: "https://evil.example/Squall-win-x64.zip")));
            Assert.Null(u.ParseRelease(ReleaseJson("nightly")));
            Assert.Null(u.ParseRelease("{\"tag_name\":\"v1.3.0\",\"assets\":[]}"));
            Assert.Null(u.ParseRelease("{\"tag_name\":\"v1.3.0\",\"draft\":true}"));
            Assert.Null(u.ParseRelease("not json"));
            var list = "[" + ReleaseJson("v1.3.0") + "," + ReleaseJson("v1.4.0-beta.2", pre: true) + "," + ReleaseJson("v1.2.9") + "]";
            Assert.Equal("1.4.0-beta.2", GitHubUpdater.Text(u.NewestRelease(list, true)!.Version));
            Assert.Equal("1.3.0", GitHubUpdater.Text(u.NewestRelease(list, false)!.Version));
        }

        [Fact]
        public void VerifyFindsTheAppInASubfolderAndNeedsSquallSwap()
        {
            using var dir = new TempDir();
            var (u, _) = Make(dir);
            byte[] zip = MakeZip(top: "Squall/");
            File.WriteAllBytes(dir.Sub("a.zip"), zip);
            string? app = u.VerifyAndExtract(dir.Sub("a.zip"), Sha(zip), dir.Sub("stage"), out string err);
            Assert.Equal(dir.Sub("stage", "Squall"), app);
            Assert.Equal("", err);

            byte[] noSwap = MakeZip(withSwap: false);
            File.WriteAllBytes(dir.Sub("b.zip"), noSwap);
            Assert.Null(u.VerifyAndExtract(dir.Sub("b.zip"), Sha(noSwap), dir.Sub("stage2"), out err));
            Assert.Contains("SquallSwap.exe", err);

            byte[] noApp = MakeZip(withApp: false);
            File.WriteAllBytes(dir.Sub("c.zip"), noApp);
            Assert.Null(u.VerifyAndExtract(dir.Sub("c.zip"), Sha(noApp), dir.Sub("stage3"), out err));
            Assert.Contains("doesn't have Squall", err);

            Assert.Null(u.VerifyAndExtract(dir.Sub("a.zip"), "nonsense", dir.Sub("stage4"), out err));
            Assert.Contains("broken", err);
        }

        [Fact]
        public void StartedOkNoticesAnUpdate()
        {
            using var dir = new TempDir();
            var (old, _) = Make(dir, "1.2.0");
            Assert.Null(old.MarkStartedOk());   // first run ever
            Assert.True(File.Exists(old.OkFile(old.Current)));
            var (fresh, _) = Make(dir, "1.3.0");
            var applied = fresh.MarkStartedOk();
            Assert.NotNull(applied);
            Assert.Equal("1.2.0", applied!.Value.From);
            Assert.Null(fresh.MarkStartedOk());   // only once
        }

        [Fact]
        public void BuildFoldersAreRecognised()
        {
            using var dir = new TempDir();
            Directory.CreateDirectory(dir.Sub("proj", "bin", "Release", "net8.0-windows"));
            File.WriteAllText(dir.Sub("proj", "Squall.csproj"), "<Project/>");
            Assert.True(GitHubUpdater.FromSource(dir.Sub("proj", "bin", "Release", "net8.0-windows")));
            Assert.False(GitHubUpdater.FromSource(dir.Path));
        }
    }

    public class SwapTests
    {
        private static void Write(string path, string text)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.WriteAllText(path, text);
        }

        private static (SwapJob Job, TempDir Dir) Setup()
        {
            var dir = new TempDir();
            Write(dir.Sub("install", "Squall.exe"), "old exe");
            Write(dir.Sub("install", "web", "index.html"), "old page");
            Write(dir.Sub("install", "team.json"), "Storm's team");
            Write(dir.Sub("install", "workspace", "Chip", "notes.md"), "Chip's notes");
            Write(dir.Sub("install", "old-only.txt"), "keep me");
            Write(dir.Sub("new", "Squall.exe"), "new exe");
            Write(dir.Sub("new", "web", "index.html"), "new page");
            Write(dir.Sub("new", "web", "link.js"), "new file");
            Write(dir.Sub("new", "team.json"), "a default team that must not land");
            Write(dir.Sub("new", "workspace", "Chip", "notes.md"), "must not land");
            var job = new SwapJob
            {
                Pid = 0, Source = dir.Sub("new"), Target = dir.Sub("install"), Backup = dir.Sub("backup"),
                Exe = "Squall.exe", OkFile = dir.Sub("started.ok"), Log = dir.Sub("swap.log"),
                WaitForOk = TimeSpan.FromSeconds(3),
            };
            return (job, dir);
        }

        [Fact]
        public void SwapsTheFilesAndLeavesStormsFilesAlone()
        {
            var (job, dir) = Setup();
            using (dir)
            {
                var started = new List<string>();
                var result = SwapCore.Run(job, exe => { started.Add(exe); File.WriteAllText(job.OkFile, "ok"); return () => false; }, _ => false);
                Assert.Equal(SwapCore.Result.Updated, result);
                Assert.Equal("new exe", File.ReadAllText(dir.Sub("install", "Squall.exe")));
                Assert.Equal("new page", File.ReadAllText(dir.Sub("install", "web", "index.html")));
                Assert.Equal("new file", File.ReadAllText(dir.Sub("install", "web", "link.js")));
                Assert.Equal("Storm's team", File.ReadAllText(dir.Sub("install", "team.json")));
                Assert.Equal("Chip's notes", File.ReadAllText(dir.Sub("install", "workspace", "Chip", "notes.md")));
                Assert.Equal("keep me", File.ReadAllText(dir.Sub("install", "old-only.txt")));
                Assert.Equal("old exe", File.ReadAllText(dir.Sub("backup", "Squall.exe")));
                Assert.Single(started);
                Assert.Contains("Update done", File.ReadAllText(job.Log));
            }
        }

        [Fact]
        public void PutsTheOldVersionBackWhenTheNewOneCloses()
        {
            var (job, dir) = Setup();
            using (dir)
            {
                var started = new List<string>();
                var result = SwapCore.Run(job, exe => { started.Add(File.ReadAllText(exe)); return () => true; }, _ => false);
                Assert.Equal(SwapCore.Result.RolledBack, result);
                Assert.Equal("old exe", File.ReadAllText(dir.Sub("install", "Squall.exe")));
                Assert.Equal("old page", File.ReadAllText(dir.Sub("install", "web", "index.html")));
                Assert.False(File.Exists(dir.Sub("install", "web", "link.js")));
                Assert.Equal(new[] { "new exe", "old exe" }, started);   // tried the new one, then started the old one again
            }
        }

        [Fact]
        public void PutsTheOldVersionBackWhenTheNewOneWontStart()
        {
            var (job, dir) = Setup();
            using (dir)
            {
                int calls = 0;
                var result = SwapCore.Run(job, _ => ++calls == 1 ? null : () => false, _ => false);
                Assert.Equal(SwapCore.Result.RolledBack, result);
                Assert.Equal("old exe", File.ReadAllText(dir.Sub("install", "Squall.exe")));
                Assert.Equal(2, calls);
            }
        }

        [Fact]
        public void KeepsANewVersionThatRunsButNeverChecksIn()
        {
            var (job, dir) = Setup();
            using (dir)
            {
                job.WaitForOk = TimeSpan.FromMilliseconds(400);
                Assert.Equal(SwapCore.Result.Updated, SwapCore.Run(job, _ => () => false, _ => false));
                Assert.Equal("new exe", File.ReadAllText(dir.Sub("install", "Squall.exe")));
            }
        }

        [Fact]
        public void WaitsForSquallToCloseFirst()
        {
            var (job, dir) = Setup();
            using (dir)
            {
                job.Pid = 4242;
                int checks = 0;
                var result = SwapCore.Run(job, _ => { File.WriteAllText(job.OkFile, "ok"); return () => false; }, pid => ++checks < 3);
                Assert.Equal(SwapCore.Result.Updated, result);
                Assert.Equal(3, checks);

                job.WaitForExit = TimeSpan.FromMilliseconds(300);
                Assert.Equal(SwapCore.Result.NothingChanged, SwapCore.Run(job, _ => () => false, _ => true));
            }
        }

        [Fact]
        public void RefusesBrokenJobs()
        {
            var (job, dir) = Setup();
            using (dir)
            {
                File.Delete(dir.Sub("new", "Squall.exe"));
                var started = new List<string>();
                Assert.Equal(SwapCore.Result.NothingChanged, SwapCore.Run(job, exe => { started.Add(exe); return () => false; }, _ => false));
                Assert.Equal("old exe", File.ReadAllText(dir.Sub("install", "Squall.exe")));
                Assert.Single(started);   // the old Squall was started again

                var (job2, dir2) = Setup();
                using (dir2)
                {
                    job2.Backup = dir2.Sub("install");   // deleting the backup would delete Squall
                    Assert.Equal(SwapCore.Result.NothingChanged, SwapCore.Run(job2, _ => () => false, _ => false));
                    Assert.True(File.Exists(dir2.Sub("install", "Squall.exe")));
                    job2.Backup = dir2.Sub("backup");
                    job2.Source = dir2.Sub("install");
                    Assert.Equal(SwapCore.Result.NothingChanged, SwapCore.Run(job2, _ => () => false, _ => false));
                }
            }
        }

        [Fact]
        public void ParsesItsCommandLine()
        {
            var job = SwapJob.Parse(new[] { "--pid", "12", "--source", "a", "--target", "b", "--backup", "c", "--exe", "Squall.exe", "--ok", "d", "--log", "e", "--wait-ok", "30" });
            Assert.NotNull(job);
            Assert.Equal(12, job!.Pid);
            Assert.Equal(TimeSpan.FromSeconds(30), job.WaitForOk);
            Assert.Null(SwapJob.Parse(new[] { "--pid", "x" }));
            Assert.Null(SwapJob.Parse(new[] { "--source", "a", "--target", "b", "--backup", "c", "--exe", "..\\evil.exe" }));
            Assert.Null(SwapJob.Parse(new[] { "--source", "a", "--target", "b", "--backup", "c", "--exe", "Squall.bat" }));
            Assert.Null(SwapJob.Parse(new[] { "--source", "a", "--target", "b", "--backup", "c" }));
            Assert.Null(SwapJob.Parse(new[] { "--what", "a" }));
            Assert.Null(SwapJob.Parse(new[] { "--pid" }));
        }

        [Theory]
        [InlineData("team.json", true)]
        [InlineData("TEAM.JSON", true)]
        [InlineData("state.json", true)]
        [InlineData("workspace/Chip/x.md", true)]
        [InlineData("workspace\\Chip\\x.md", true)]
        [InlineData("web/team.json", false)]
        [InlineData("web/index.html", false)]
        [InlineData("Squall.exe", false)]
        public void KnowsStormsFiles(string path, bool kept) => Assert.Equal(kept, SwapJob.Kept(path));
    }
}
