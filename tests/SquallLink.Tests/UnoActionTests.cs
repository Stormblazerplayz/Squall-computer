using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Squall.Link.Uno;
using Xunit;

namespace Squall.Link.Tests
{
    public class UnoActionTests
    {
        private static Dictionary<string, JsonElement> In(string json) =>
            JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(json)!;

        private static ComputerAction P(string name, string json = "{}") => ComputerActions.Parse(name, In(json), 1280, 800);

        private static string X(string name, string json = "{}") => string.Join(" ", ComputerActions.XdotoolArgs(P(name, json))!);

        private static string Bad(string name, string json) => Assert.Throws<UnoToolException>(() => P(name, json)).Message;

        [Fact]
        public void ClicksBecomeXdotoolChains()
        {
            Assert.Equal("mousemove 412 230 click 1", X("left_click", "{\"coordinate\":[412,230]}"));
            Assert.Equal("click 1", X("left_click"));
            Assert.Equal("mousemove 5 6 click 3", X("right_click", "{\"coordinate\":[5,6]}"));
            Assert.Equal("mousemove 5 6 click 2", X("middle_click", "{\"coordinate\":[5,6]}"));
            Assert.Equal("mousemove 5 6 click --repeat 2 --delay 80 1", X("double_click", "{\"coordinate\":[5,6]}"));
            Assert.Equal("mousemove 5 6 click --repeat 3 --delay 80 1", X("triple_click", "{\"coordinate\":[5,6]}"));
            // keys held during the click, released in reverse order
            Assert.Equal("mousemove 5 6 keydown shift keydown ctrl click 1 keyup ctrl keyup shift", X("left_click", "{\"coordinate\":[5,6],\"text\":\"shift+ctrl\"}"));
            Assert.Equal("keydown super click 1 keyup super", X("left_click", "{\"text\":\"cmd\"}"));
            // numbers come rounded, and a point on the edge stays on the screen
            Assert.Equal("mousemove 13 799 click 1", X("left_click", "{\"coordinate\":[12.6,800]}"));
            Assert.Equal("mousemove 1279 0 click 1", X("left_click", "{\"coordinate\":[1280,-0.2]}"));
        }

        [Fact]
        public void DragMoveAndButtons()
        {
            Assert.Equal("mousemove 10 20 mousedown 1 sleep 0.1 mousemove 55 70 sleep 0.1 mousemove 100 120 sleep 0.1 mouseup 1",
                X("left_click_drag", "{\"start_coordinate\":[10,20],\"coordinate\":[100,120]}"));
            Assert.Equal("mousemove 10 20 keydown alt mousedown 1 sleep 0.1 mousemove 55 70 sleep 0.1 mousemove 100 120 sleep 0.1 mouseup 1 keyup alt",
                X("left_click_drag", "{\"start_coordinate\":[10,20],\"coordinate\":[100,120],\"text\":\"alt\"}"));
            Assert.Equal("mousemove 640 400", X("mouse_move", "{\"coordinate\":[640,400]}"));
            Assert.Equal("mousedown 1", X("left_mouse_down"));
            Assert.Equal("mouseup 1", X("left_mouse_up"));
            Assert.Contains("start_coordinate is missing", Bad("left_click_drag", "{\"coordinate\":[1,2]}"));
            Assert.Contains("coordinate is missing", Bad("mouse_move", "{}"));
        }

        [Fact]
        public void ScrollUsesWheelButtons()
        {
            Assert.Equal("mousemove 300 400 click --repeat 3 --delay 40 5", X("scroll", "{\"coordinate\":[300,400],\"scroll_direction\":\"down\",\"scroll_amount\":3}"));
            Assert.Equal("click --repeat 2 --delay 40 4", X("scroll", "{\"scroll_direction\":\"up\",\"scroll_amount\":2}"));
            Assert.Equal("click --repeat 1 --delay 40 6", X("scroll", "{\"scroll_direction\":\"left\",\"scroll_amount\":1}"));
            Assert.Equal("keydown shift click --repeat 5 --delay 40 7 keyup shift", X("scroll", "{\"scroll_direction\":\"right\",\"scroll_amount\":5,\"text\":\"shift\"}"));
            Assert.Equal("click --repeat 30 --delay 40 5", X("scroll", "{\"scroll_direction\":\"down\",\"scroll_amount\":500}"));
            Assert.Contains("scroll_direction", Bad("scroll", "{\"scroll_direction\":\"sideways\",\"scroll_amount\":1}"));
            Assert.Contains("1 or more", Bad("scroll", "{\"scroll_direction\":\"down\",\"scroll_amount\":0}"));
            Assert.Contains("number", Bad("scroll", "{\"scroll_direction\":\"down\",\"scroll_amount\":\"lots\"}"));
        }

        [Fact]
        public void TypingAndKeys()
        {
            Assert.Equal(new[] { "type", "--delay", "12", "--", "-rf hello \"there\"; rm *" },
                ComputerActions.XdotoolArgs(P("type", "{\"text\":\"-rf hello \\\"there\\\"; rm *\"}")));
            Assert.Equal("type --delay 12 -- line1\nline2", X("type", "{\"text\":\"line1\\r\\nline2\\u0007\"}"));
            Assert.Contains("needs some text", Bad("type", "{\"text\":\"\"}"));
            Assert.Contains("too long", Bad("type", "{\"text\":\"" + new string('a', 5001) + "\"}"));
            Assert.Contains("must be text", Bad("type", "{\"text\":5}"));

            Assert.Equal("key --delay 60 Return", X("key", "{\"text\":\"Return\"}"));
            Assert.Equal("key --delay 60 ctrl+s", X("key", "{\"text\":\"ctrl+s\"}"));
            Assert.Equal("key --delay 60 Return", X("key", "{\"text\":\"Enter\"}"));
            Assert.Equal("key --delay 60 ctrl+shift+t Tab", X("key", "{\"text\":\"Control+Shift+t Tab\"}"));
            Assert.Equal("key --delay 60 Page_Down Page_Down Page_Down", X("key", "{\"text\":\"PageDown\",\"repeat\":3}"));
            Assert.Equal("key --delay 60 F5 plus minus", X("key", "{\"text\":\"f5 + -\"}"));
            Assert.Contains("isn't a key name", Bad("key", "{\"text\":\"ctrl+s; rm -rf /\"}"));
            Assert.Contains("isn't a key name", Bad("key", "{\"text\":\"$(reboot)\"}"));
            Assert.Contains("isn't a key name", Bad("key", "{\"text\":\"ctrl++\"}"));
            Assert.Contains("needs a key", Bad("key", "{\"text\":\"   \"}"));

            Assert.Equal("keydown shift sleep 2 keyup shift", X("hold_key", "{\"text\":\"shift\",\"duration\":2}"));
            Assert.Equal("keydown ctrl+a sleep 10 keyup ctrl+a", X("hold_key", "{\"text\":\"ctrl+a\",\"duration\":60}"));
            Assert.Contains("one key", Bad("hold_key", "{\"text\":\"a b\",\"duration\":1}"));
            Assert.Contains("more than 0", Bad("hold_key", "{\"text\":\"a\",\"duration\":0}"));
            Assert.Contains("isn't a key to hold", Bad("left_click", "{\"text\":\"banana\"}"));
        }

        [Fact]
        public void ScreenActionsAreNotXdotool()
        {
            foreach (var n in new[] { "screenshot", "cursor_position" }) Assert.Null(ComputerActions.XdotoolArgs(P(n)));
            Assert.Null(ComputerActions.XdotoolArgs(P("wait", "{\"duration\":2}")));
            Assert.Null(ComputerActions.XdotoolArgs(P("zoom", "{\"region\":[0,0,640,400]}")));
            Assert.Equal(30, P("wait", "{\"duration\":999}").Seconds);
            Assert.Contains("can't do", Bad("launch_rockets", "{}"));
            Assert.All(ComputerActions.Members, m => Assert.DoesNotContain("can't do", Record.Exception(() => ComputerActions.Parse(m, In("{}"), 1280, 800))?.Message ?? ""));
        }

        [Fact]
        public void ZoomKeepsTheShape()
        {
            var a = P("zoom", "{\"region\":[100,50,500,150]}");
            Assert.Equal((100, 50, 500, 150), a.Region!.Value);
            Assert.Equal(new[] { "import", "-display", ":1", "-window", "root", "-crop", "400x100+100+50", "+repage", "-resize", "1280x800", "-quality", "80", "jpeg:-" },
                DockerDesktops.ZoomArgs(a.Region.Value));
            Assert.DoesNotContain(DockerDesktops.ZoomArgs(a.Region.Value), s => s.Contains('!') || s.Contains('>'));
            Assert.Contains("x1 > x0", Bad("zoom", "{\"region\":[500,50,100,150]}"));
            Assert.Contains("[x0, y0, x1, y1]", Bad("zoom", "{\"region\":[1,2,3]}"));
            Assert.Contains("off the screen", Bad("zoom", "{\"region\":[0,0,2000,100]}"));
        }

        [Fact]
        public void BadCoordinatesAreToolErrors()
        {
            Assert.Contains("off the screen", Bad("left_click", "{\"coordinate\":[1500,20]}"));
            Assert.Contains("off the screen", Bad("left_click", "{\"coordinate\":[10,-5]}"));
            Assert.Contains("must be [x, y]", Bad("left_click", "{\"coordinate\":[10]}"));
            Assert.Contains("must be [x, y]", Bad("left_click", "{\"coordinate\":\"10,20\"}"));
            Assert.Contains("must be a number", Bad("left_click", "{\"coordinate\":[\"a\",2]}"));
            Assert.Contains("must be a number", Bad("mouse_move", "{\"coordinate\":[null,2]}"));
        }

        [Fact]
        public void FeedWordsArePlain()
        {
            Assert.Equal("Clicked at (412, 230)", ComputerActions.Describe(P("left_click", "{\"coordinate\":[412,230]}")));
            Assert.Equal("Clicking at (412, 230)", ComputerActions.Describe(P("left_click", "{\"coordinate\":[412,230]}"), doing: true));
            Assert.Equal("Typed \"hello\"", ComputerActions.Describe(P("type", "{\"text\":\"hello\"}")));
            Assert.Equal("Pressed ctrl+s", ComputerActions.Describe(P("key", "{\"text\":\"ctrl+s\"}")));
            Assert.Equal("Took a screenshot", ComputerActions.Describe(P("screenshot")));
            Assert.Equal("Scrolled down 3", ComputerActions.Describe(P("scroll", "{\"scroll_direction\":\"down\",\"scroll_amount\":3}")));
            Assert.Equal("Waited 2 seconds", ComputerActions.Describe(P("wait", "{\"duration\":2}")));
            Assert.Equal("Waited 1 second", ComputerActions.Describe(P("wait", "{\"duration\":1}")));
            Assert.Equal("Dragged from (1, 2) to (3, 4)", ComputerActions.Describe(P("left_click_drag", "{\"start_coordinate\":[1,2],\"coordinate\":[3,4]}")));
            Assert.Equal("click", ComputerActions.Kind(P("left_click")));
            Assert.Equal("drag", ComputerActions.Kind(P("left_click_drag", "{\"start_coordinate\":[1,2],\"coordinate\":[3,4]}")));
            Assert.Equal("cursor", ComputerActions.Kind(P("cursor_position")));
            Assert.Equal((10, 20), DockerDesktops.ParseMouse("X=10\r\nY=20\nSCREEN=0\n"));
            Assert.Null(DockerDesktops.ParseMouse("nothing"));
        }
    }

    public class UnoDockerTests
    {
        private static DockerDesktops Make(FakeDocker fake, string folder) => new(fake, folder) { ReadyPoll = TimeSpan.FromMilliseconds(1) };

        [Fact]
        public async Task DockerReadinessHasFriendlyWords()
        {
            using var dir = new TempDir();
            var fake = new FakeDocker();
            var d = Make(fake, dir.Path);
            Assert.Equal((true, "Docker is running."), await d.CheckAsync());
            Assert.Equal(new[] { "docker", "version", "--format", "{{.Server.Version}}" }, fake.Calls.Last());
            fake.Running = false;
            Assert.Equal((false, "Docker is installed but not running. Start Docker Desktop."), await d.CheckAsync());
            fake.Installed = false;
            Assert.Equal((false, "Install Docker Desktop and start it, then try again."), await d.CheckAsync());
        }

        [Fact]
        public async Task StartingAComputerRunsTheContainerAndWaitsForTheScreen()
        {
            using var dir = new TempDir();
            var fake = new FakeDocker { ImageBuilt = false };
            var d = Make(fake, dir.Path);
            Assert.False(await d.ImageReadyAsync());
            await d.BuildImageAsync();
            var build = fake.Calls.First(c => c[1] == "build");
            Assert.Equal(new[] { "docker", "build", "--tag", "squall-uno-desktop:1", "--label", "squall.uno=1" }, build.Take(6));
            string ctx = build[^1];
            string dockerfile = File.ReadAllText(Path.Combine(ctx, "Dockerfile"));
            Assert.Contains("FROM debian:bookworm-slim", dockerfile);
            Assert.Contains("useradd", dockerfile);
            foreach (var pkg in new[] { "xvfb", "xdotool", "imagemagick", "openbox", "tint2", "xterm", "firefox-esr", "fonts-dejavu", "fonts-noto-color-emoji", "x11-utils" })
                Assert.Contains(pkg, dockerfile);
            string start = File.ReadAllText(Path.Combine(ctx, "start.sh"));
            Assert.DoesNotContain("\r", start);
            Assert.Contains("Xvfb :1 -screen 0 1280x800x24", start);
            Assert.True(File.Exists(Path.Combine(ctx, "policies.json")));

            await d.StartAsync("pc-chief");
            var run = fake.Calls.First(c => c[1] == "run");
            Assert.Equal(new[] { "docker", "run", "-d", "--name", "squall-uno-pc-chief", "--label", "squall.uno=1", "--label", "squall.uno.computer=pc-chief",
                                 "--shm-size", "512m", "--memory", "2g", "--security-opt", "no-new-privileges", "squall-uno-desktop:1" }, run);
            var probe = fake.Calls.Last();
            Assert.Equal(new[] { "docker", "exec", "-e", "DISPLAY=:1", "-e", "LANG=C.UTF-8", "squall-uno-pc-chief", "xdotool", "getdisplaygeometry" }, probe);

            // a stopped computer is started, not created again
            fake.Containers["squall-uno-pc-chief"] = "stopped";
            await d.StartAsync("pc-chief");
            Assert.Equal(new[] { "docker", "start", "squall-uno-pc-chief" }, fake.Calls.First(c => c[1] == "start"));

            Assert.Equal(new[] { "pc-chief" }, await d.RunningAsync());
            await d.RemoveAsync("pc-chief");
            Assert.Equal(new[] { "docker", "rm", "-f", "squall-uno-pc-chief" }, fake.Calls.Last());
            Assert.Equal("none", await d.ContainerStateAsync("pc-chief"));
        }

        [Fact]
        public async Task AScreenThatNeverComesOnIsAPlainError()
        {
            using var dir = new TempDir();
            var fake = new FakeDocker();
            fake.Answer = a => a[0] == "exec" ? new CommandResult(1, Array.Empty<byte>(), "Can't open display") : null;
            var d = Make(fake, dir.Path);
            d.ReadyTimeout = TimeSpan.FromMilliseconds(50);
            var ex = await Assert.ThrowsAsync<UnoException>(() => d.StartAsync("pc-x"));
            Assert.Equal("The computer started but its screen didn't come on. Turn it off and try again.", ex.Message);
        }

        [Fact]
        public async Task ActionsRunInsideTheComputer()
        {
            using var dir = new TempDir();
            var fake = new FakeDocker();
            fake.Containers["squall-uno-pc-chief"] = "running";
            var d = Make(fake, dir.Path);
            var click = ComputerActions.Parse("left_click", new Dictionary<string, JsonElement> { ["coordinate"] = JsonSerializer.SerializeToElement(new[] { 1, 2 }) }, 1280, 800);
            await d.RunAsync("pc-chief", click);
            Assert.Equal(new[] { "docker", "exec", "-e", "DISPLAY=:1", "-e", "LANG=C.UTF-8", "squall-uno-pc-chief", "xdotool", "mousemove", "1", "2", "click", "1" }, fake.Calls.Last());

            Assert.Equal(FakeDocker.Jpeg, await d.CaptureAsync("pc-chief", 70));
            Assert.Equal(new[] { "import", "-display", ":1", "-window", "root", "-quality", "70", "jpeg:-" }, fake.Calls.Last().Skip(7));
            Assert.Equal((10, 20), await d.CursorAsync("pc-chief"));

            // xdotool ignores unknown key names, so Squall Uno hears about it
            fake.Answer = a => a.Contains("key") ? new CommandResult(0, Array.Empty<byte>(), "(symbol) No such key name 'Rturn'. Ignoring it.") : null;
            var key = ComputerActions.Parse("key", new Dictionary<string, JsonElement> { ["text"] = JsonSerializer.SerializeToElement("Rturn") }, 1280, 800);
            var kex = await Assert.ThrowsAsync<UnoToolException>(() => d.RunAsync("pc-chief", key));
            Assert.Contains("Rturn", kex.Message);

            fake.Answer = null;
            fake.Containers["squall-uno-pc-chief"] = "stopped";
            await Assert.ThrowsAsync<UnoComputerGoneException>(() => d.RunAsync("pc-chief", click));
            fake.Containers.TryRemove("squall-uno-pc-chief", out _);
            await Assert.ThrowsAsync<UnoComputerGoneException>(() => d.CaptureAsync("pc-chief", 80));

            fake.Containers["squall-uno-pc-chief"] = "running";
            fake.Answer = a => a[0] == "exec" ? new CommandResult(1, Array.Empty<byte>(), "xdo error") : null;
            var tex = await Assert.ThrowsAsync<UnoToolException>(() => d.RunAsync("pc-chief", click));
            Assert.Equal("Clicking at (1, 2) didn't work: xdo error.", tex.Message);
        }

        [Fact]
        public async Task TheRealRunnerUsesAnArgumentList()
        {
            var r = new ProcessCommandRunner();
            var missing = await r.RunAsync("squall-no-such-program-" + Guid.NewGuid().ToString("N"), Array.Empty<string>(), TimeSpan.FromSeconds(5));
            Assert.True(missing.Missing);
            Assert.False(missing.Ok);
            if (OperatingSystem.IsWindows()) return;
            var echo = await r.RunAsync("printf", new[] { "%s|%s", "a b; echo hacked", "$(whoami)" }, TimeSpan.FromSeconds(5));
            Assert.True(echo.Ok);
            Assert.Equal("a b; echo hacked|$(whoami)", echo.Text);
            var slow = await r.RunAsync("sleep", new[] { "5" }, TimeSpan.FromMilliseconds(200));
            Assert.True(slow.TimedOut);
            using var cts = new System.Threading.CancellationTokenSource(200);
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => r.RunAsync("sleep", new[] { "5" }, TimeSpan.FromSeconds(10), cts.Token));
        }
    }

    public class UnoKeyStoreTests
    {
        private const string Key = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789-wxyzA1b2";

        [Fact]
        public void TheEnvironmentWinsAndOnlyAHintComesOut()
        {
            using var dir = new TempDir();
            string? env = null;
            var keys = new UnoKeyStore(dir.Path, () => env);
            Assert.False(keys.HasKey);
            Assert.Equal("none", keys.Source);
            Assert.Equal("", keys.Hint);

            keys.Save("  " + Key + "\n");
            Assert.Equal("saved", keys.Source);
            Assert.Equal("sk-ant-…A1b2", keys.Hint);
            string file = File.ReadAllText(Path.Combine(dir.Path, "key.dat"));
            Assert.DoesNotContain(Key, file);
            if (!OperatingSystem.IsWindows())
                Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(Path.Combine(dir.Path, "key.dat")));

            // a new store (Squall restarted) reads it back
            var again = new UnoKeyStore(dir.Path, () => env);
            Assert.Equal(Key, again.Current.Key);

            env = "sk-ant-env-0000000000000000000000000000000000Zz99";
            Assert.Equal("env", again.Source);
            Assert.Equal("sk-ant-…Zz99", again.Hint);
            Assert.Equal(env, again.Current.Key);

            env = null;
            again.Remove();
            Assert.False(again.HasKey);
            Assert.False(File.Exists(Path.Combine(dir.Path, "key.dat")));
        }

        [Fact]
        public void BadKeysAreRefusedInPlainWords()
        {
            using var dir = new TempDir();
            var keys = new UnoKeyStore(dir.Path, () => null);
            Assert.Equal("Paste your Anthropic API key first.", Assert.Throws<UnoException>(() => keys.Save("")).Message);
            Assert.Contains("start with sk-ant-", Assert.Throws<UnoException>(() => keys.Save("hello-world-this-is-not-a-key-at-all")).Message);
            Assert.Contains("wrong length", Assert.Throws<UnoException>(() => keys.Save("sk-ant-short")).Message);
            Assert.Contains("spaces", Assert.Throws<UnoException>(() => keys.Save("sk-ant-abc def ghijklmnopqrstuvwxyz0123456789")).Message);
            Assert.False(keys.HasKey);
            Assert.Equal("…", UnoKeyStore.HintFor("sk-ant-x"));
        }
    }
}
