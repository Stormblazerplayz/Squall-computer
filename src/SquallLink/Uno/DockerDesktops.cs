using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Squall.Link.Uno
{
    /// <summary>
    /// The agents' computers: one Docker container each, made from the squall-uno-desktop:1 image (built from the
    /// Uno/Desktop files embedded in SquallLink). Every docker call goes through <see cref="ICommandRunner"/> with an
    /// argument list. Errors are <see cref="UnoException"/>s with plain sentences.
    /// </summary>
    public sealed class DockerDesktops
    {
        public const string Image = "squall-uno-desktop:1";
        public const int Width = 1280;
        public const int Height = 800;
        public const string Label = "squall.uno=1";
        public const string NotInstalledText = "Install Docker Desktop and start it, then try again.";
        public const string NotRunningText = "Docker is installed but not running. Start Docker Desktop.";
        public const string RunningText = "Docker is running.";
        private const string ResourcePrefix = "Squall.Link.Uno.Desktop.";

        private readonly ICommandRunner _run;
        private readonly string _folder;
        private readonly string _docker;
        private readonly SemaphoreSlim _build = new(1, 1);

        /// <summary>How long a new container may take before its screen answers.</summary>
        public TimeSpan ReadyTimeout { get; set; } = TimeSpan.FromSeconds(90);
        /// <summary>The pause between checks while a container's screen starts.</summary>
        public TimeSpan ReadyPoll { get; set; } = TimeSpan.FromMilliseconds(500);

        public DockerDesktops(ICommandRunner runner, string folder, string docker = "docker")
        {
            _run = runner;
            _folder = folder;
            _docker = docker;
        }

        public static string ContainerName(string computerId) => "squall-uno-" + computerId;

        private static readonly TimeSpan Quick = TimeSpan.FromSeconds(15);

        private Task<CommandResult> Docker(TimeSpan timeout, CancellationToken ct, params string[] args) => _run.RunAsync(_docker, args, timeout, ct);

        // ===================================================================== Docker itself

        /// <summary>Is Docker installed and its engine running? Text is what to tell the user.</summary>
        public async Task<(bool Ready, string Text)> CheckAsync(CancellationToken ct = default)
        {
            var r = await Docker(TimeSpan.FromSeconds(10), ct, "version", "--format", "{{.Server.Version}}").ConfigureAwait(false);
            if (r.Missing) return (false, NotInstalledText);
            if (!r.Ok || r.Text.Trim().Length == 0) return (false, NotRunningText);
            return (true, RunningText);
        }

        /// <summary>Has the desktop image been built?</summary>
        public async Task<bool> ImageReadyAsync(CancellationToken ct = default)
        {
            var r = await Docker(Quick, ct, "image", "inspect", "--format", "{{.Id}}", Image).ConfigureAwait(false);
            return r.Ok;
        }

        /// <summary>Builds the desktop image from the embedded files (a few minutes the first time).</summary>
        public async Task BuildImageAsync(CancellationToken ct = default)
        {
            await _build.WaitAsync(ct).ConfigureAwait(false);
            try
            {
                if (await ImageReadyAsync(ct).ConfigureAwait(false)) return;
                string dir = ExtractBuildFiles();
                var r = await Docker(TimeSpan.FromMinutes(30), ct, "build", "--tag", Image, "--label", Label, dir).ConfigureAwait(false);
                if (!r.Ok)
                {
                    string why = r.TimedOut ? "it took too long" : ComputerActions.Short(r.LastErrorLine, 160);
                    throw new UnoException("Setting up the computer didn't work" + (why.Length > 0 ? " (" + why + ")" : "") + ". Check that Docker Desktop is running and the internet works, then try again.");
                }
            }
            finally { _build.Release(); }
        }

        /// <summary>Writes the embedded Dockerfile and friends to uno/desktop-image (new lines made Unix-style).</summary>
        internal string ExtractBuildFiles()
        {
            string dir = Path.Combine(_folder, "desktop-image");
            Directory.CreateDirectory(dir);
            var asm = typeof(DockerDesktops).Assembly;
            int count = 0;
            foreach (var name in asm.GetManifestResourceNames())
            {
                if (!name.StartsWith(ResourcePrefix, StringComparison.Ordinal)) continue;
                string file = name.Substring(ResourcePrefix.Length);
                if (file.Length == 0 || file.Contains('/') || file.Contains('\\') || file.Contains("..")) continue;
                using var s = asm.GetManifestResourceStream(name)!;
                using var reader = new StreamReader(s, Encoding.UTF8);
                string text = reader.ReadToEnd().Replace("\r\n", "\n");
                File.WriteAllText(Path.Combine(dir, file), text, new UTF8Encoding(false));
                count++;
            }
            if (count == 0 || !File.Exists(Path.Combine(dir, "Dockerfile")))
                throw new UnoException("Squall is missing the files for the computer. Reinstall Squall.");
            return dir;
        }

        // ===================================================================== Containers

        /// <summary>"running", "stopped" or "none".</summary>
        public async Task<string> ContainerStateAsync(string computerId, CancellationToken ct = default)
        {
            var r = await Docker(Quick, ct, "container", "inspect", "--format", "{{.State.Running}}", ContainerName(computerId)).ConfigureAwait(false);
            if (!r.Ok) return "none";
            return r.Text.Trim().Equals("true", StringComparison.OrdinalIgnoreCase) ? "running" : "stopped";
        }

        /// <summary>The computer ids of Squall Uno containers that are running now.</summary>
        public async Task<IReadOnlyList<string>> RunningAsync(CancellationToken ct = default)
        {
            var r = await Docker(Quick, ct, "ps", "--filter", "label=" + Label, "--format", "{{.Names}}").ConfigureAwait(false);
            if (!r.Ok) return Array.Empty<string>();
            return r.Text.Replace("\r", "").Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Where(n => n.StartsWith("squall-uno-", StringComparison.Ordinal))
                .Select(n => n.Substring("squall-uno-".Length)).ToList();
        }

        /// <summary>Starts the computer (creating its container if needed) and waits until its screen answers.</summary>
        public async Task StartAsync(string computerId, CancellationToken ct = default)
        {
            string name = ContainerName(computerId);
            string state = await ContainerStateAsync(computerId, ct).ConfigureAwait(false);
            CommandResult r;
            if (state == "stopped") r = await Docker(TimeSpan.FromSeconds(60), ct, "start", name).ConfigureAwait(false);
            else if (state == "none")
                r = await Docker(TimeSpan.FromSeconds(120), ct, "run", "-d", "--name", name, "--label", Label,
                    "--label", "squall.uno.computer=" + computerId, "--shm-size", "512m", "--memory", "2g",
                    "--security-opt", "no-new-privileges", Image).ConfigureAwait(false);
            else r = new CommandResult(0, Array.Empty<byte>(), "");
            if (!r.Ok)
                throw new UnoException("The computer didn't start" + (r.LastErrorLine.Length > 0 ? " (" + ComputerActions.Short(r.LastErrorLine, 160) + ")" : "") + ". Check that Docker Desktop is running, then try again.");

            var until = DateTimeOffset.UtcNow + ReadyTimeout;
            while (true)
            {
                ct.ThrowIfCancellationRequested();
                var probe = await Exec(computerId, TimeSpan.FromSeconds(10), ct, "xdotool", "getdisplaygeometry").ConfigureAwait(false);
                if (probe.Ok) return;
                if (DateTimeOffset.UtcNow >= until)
                    throw new UnoException("The computer started but its screen didn't come on. Turn it off and try again.");
                await Task.Delay(ReadyPoll, ct).ConfigureAwait(false);
            }
        }

        /// <summary>Turns the computer off for good: the container and everything in it are removed.</summary>
        public async Task RemoveAsync(string computerId, CancellationToken ct = default)
        {
            var r = await Docker(TimeSpan.FromSeconds(60), ct, "rm", "-f", ContainerName(computerId)).ConfigureAwait(false);
            if (!r.Ok && !r.Stderr.Contains("No such container", StringComparison.OrdinalIgnoreCase))
                throw new UnoException(r.Missing ? NotInstalledText : "The computer didn't turn off. Check that Docker Desktop is running, then try again.");
        }

        /// <summary>Stops computers without removing them (when Squall closes); they start again next time.</summary>
        public async Task StopAsync(IEnumerable<string> computerIds, CancellationToken ct = default)
        {
            var names = computerIds.Select(ContainerName).ToList();
            if (names.Count == 0) return;
            var args = new List<string> { "stop", "--time", "2" };
            args.AddRange(names);
            await _run.RunAsync(_docker, args, TimeSpan.FromSeconds(15), ct).ConfigureAwait(false);
        }

        // ===================================================================== Inside a computer

        private Task<CommandResult> Exec(string computerId, TimeSpan timeout, CancellationToken ct, params string[] command)
        {
            var args = new List<string> { "exec", "-e", "DISPLAY=:1", "-e", "LANG=C.UTF-8", ContainerName(computerId) };
            args.AddRange(command);
            return _run.RunAsync(_docker, args, timeout, ct);
        }

        /// <summary>Throws the right exception for a failed docker exec.</summary>
        private static void Check(CommandResult r, string what)
        {
            if (r.Ok) return;
            if (r.Missing) throw new UnoException(NotInstalledText);
            string err = r.Stderr;
            if (err.Contains("No such container", StringComparison.OrdinalIgnoreCase) || err.Contains("is not running", StringComparison.OrdinalIgnoreCase))
                throw new UnoComputerGoneException();
            if (err.Contains("Cannot connect to the Docker daemon", StringComparison.OrdinalIgnoreCase) || err.Contains("docker daemon is not running", StringComparison.OrdinalIgnoreCase)
                || err.Contains("error during connect", StringComparison.OrdinalIgnoreCase))
                throw new UnoException(NotRunningText);
            string why = r.TimedOut ? "it took too long" : ComputerActions.Short(r.LastErrorLine, 120);
            throw new UnoToolException(what + " didn't work" + (why.Length > 0 ? ": " + why : "") + ".");
        }

        /// <summary>A JPEG of the whole screen (quality 70 for live frames, 80 for Squall Uno).</summary>
        public async Task<byte[]> CaptureAsync(string computerId, int quality, CancellationToken ct = default)
        {
            var r = await Exec(computerId, TimeSpan.FromSeconds(15), ct, "import", "-display", ":1", "-window", "root",
                "-quality", Math.Clamp(quality, 10, 95).ToString(CultureInfo.InvariantCulture), "jpeg:-").ConfigureAwait(false);
            Check(r, "Taking a screenshot");
            if (!IsJpeg(r.Stdout)) throw new UnoToolException("Taking a screenshot didn't work: the picture was empty.");
            return r.Stdout;
        }

        /// <summary>
        /// A JPEG of one area of the screen, scaled to fit inside 1280x800 with its shape kept ("1280x800" in
        /// ImageMagick geometry fits the image inside the box, making small areas bigger; no "!" so the aspect stays).
        /// </summary>
        public async Task<byte[]> ZoomAsync(string computerId, (int X0, int Y0, int X1, int Y1) region, CancellationToken ct = default)
        {
            var r = await Exec(computerId, TimeSpan.FromSeconds(15), ct, ZoomArgs(region)).ConfigureAwait(false);
            Check(r, "Zooming in");
            if (!IsJpeg(r.Stdout)) throw new UnoToolException("Zooming in didn't work: the picture was empty.");
            return r.Stdout;
        }

        internal static string[] ZoomArgs((int X0, int Y0, int X1, int Y1) region)
        {
            int w = region.X1 - region.X0, h = region.Y1 - region.Y0;
            string crop = string.Create(CultureInfo.InvariantCulture, $"{w}x{h}+{region.X0}+{region.Y0}");
            return new[] { "import", "-display", ":1", "-window", "root", "-crop", crop, "+repage",
                           "-resize", Width.ToString(CultureInfo.InvariantCulture) + "x" + Height.ToString(CultureInfo.InvariantCulture),
                           "-quality", "80", "jpeg:-" };
        }

        /// <summary>Where the mouse pointer is.</summary>
        public async Task<(int X, int Y)> CursorAsync(string computerId, CancellationToken ct = default)
        {
            var r = await Exec(computerId, TimeSpan.FromSeconds(10), ct, "xdotool", "getmouselocation", "--shell").ConfigureAwait(false);
            Check(r, "Finding the mouse");
            return ParseMouse(r.Text) ?? throw new UnoToolException("Finding the mouse didn't work.");
        }

        internal static (int X, int Y)? ParseMouse(string text)
        {
            int? x = null, y = null;
            foreach (var line in text.Replace("\r", "").Split('\n'))
            {
                if (line.StartsWith("X=", StringComparison.Ordinal) && int.TryParse(line.AsSpan(2), NumberStyles.Integer, CultureInfo.InvariantCulture, out int vx)) x = vx;
                else if (line.StartsWith("Y=", StringComparison.Ordinal) && int.TryParse(line.AsSpan(2), NumberStyles.Integer, CultureInfo.InvariantCulture, out int vy)) y = vy;
            }
            return x != null && y != null ? (x.Value, y.Value) : null;
        }

        /// <summary>Runs a mouse or keyboard action with xdotool. screenshot, zoom, wait and cursor_position have their own calls.</summary>
        public async Task RunAsync(string computerId, ComputerAction a, CancellationToken ct = default)
        {
            var x = ComputerActions.XdotoolArgs(a) ?? throw new UnoToolException($"{a.Name} isn't a mouse or keyboard action.");
            var cmd = new List<string> { "xdotool" };
            cmd.AddRange(x);
            var timeout = TimeSpan.FromSeconds(20) + TimeSpan.FromMilliseconds(a.Text.Length * 25) + TimeSpan.FromSeconds(a.Seconds);
            var r = await Exec(computerId, timeout, ct, cmd.ToArray()).ConfigureAwait(false);
            Check(r, ComputerActions.Describe(a, doing: true));
            // xdotool skips key names it doesn't know (and still exits 0), so say so instead of pretending it worked.
            var unknown = System.Text.RegularExpressions.Regex.Match(r.Stderr, @"No such key name '([^']*)'");
            if (unknown.Success)
                throw new UnoToolException($"The key name \"{ComputerActions.Short(unknown.Groups[1].Value, 30)}\" isn't known, so it wasn't pressed. Use names like Return, Tab, Escape, ctrl+s.");
        }

        internal static bool IsJpeg(byte[] b) => b.Length > 100 && b[0] == 0xFF && b[1] == 0xD8;
    }
}
