using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Squall.Link.Uno
{
    /// <summary>What a program printed and how it ended.</summary>
    public sealed class CommandResult
    {
        public CommandResult(int exitCode, byte[] stdout, string stderr, bool timedOut = false, bool missing = false)
        {
            ExitCode = exitCode;
            Stdout = stdout ?? Array.Empty<byte>();
            Stderr = stderr ?? "";
            TimedOut = timedOut;
            Missing = missing;
        }

        public int ExitCode { get; }
        public byte[] Stdout { get; }
        public string Stderr { get; }
        /// <summary>It ran longer than allowed and was killed.</summary>
        public bool TimedOut { get; }
        /// <summary>The program isn't installed (or isn't on the PATH).</summary>
        public bool Missing { get; }

        public bool Ok => ExitCode == 0 && !TimedOut && !Missing;
        public string Text => Encoding.UTF8.GetString(Stdout);

        /// <summary>The last non-empty line of stderr, for short error messages.</summary>
        public string LastErrorLine
        {
            get
            {
                var lines = Stderr.Replace("\r", "").Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
                return lines.Length == 0 ? "" : lines[^1];
            }
        }
    }

    /// <summary>
    /// Runs a program with a list of arguments (never a shell string, so nothing in an argument is ever interpreted).
    /// Squall Uno runs every docker command through this, so tests can stand in for Docker.
    /// </summary>
    public interface ICommandRunner
    {
        /// <summary>
        /// Runs program with args and waits for it to end or for timeout (then it is killed and TimedOut is true).
        /// Cancelling ct kills it too and throws OperationCanceledException.
        /// </summary>
        Task<CommandResult> RunAsync(string program, IReadOnlyList<string> args, TimeSpan timeout, CancellationToken ct = default, byte[]? stdin = null);
    }

    /// <summary>The real runner: System.Diagnostics.Process with ArgumentList.</summary>
    public sealed class ProcessCommandRunner : ICommandRunner
    {
        /// <summary>The most stdout kept (a screenshot is far smaller).</summary>
        public const int MaxStdoutBytes = 64 * 1024 * 1024;

        public async Task<CommandResult> RunAsync(string program, IReadOnlyList<string> args, TimeSpan timeout, CancellationToken ct = default, byte[]? stdin = null)
        {
            ct.ThrowIfCancellationRequested();
            var psi = new ProcessStartInfo(program)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                RedirectStandardInput = stdin != null,
            };
            foreach (var a in args) psi.ArgumentList.Add(a);
            using var p = new Process { StartInfo = psi };
            try
            {
                if (!p.Start()) return new CommandResult(-1, Array.Empty<byte>(), program + " didn't start.", missing: true);
            }
            catch (Win32Exception ex) { return new CommandResult(-1, Array.Empty<byte>(), ex.Message, missing: true); }
            catch (FileNotFoundException ex) { return new CommandResult(-1, Array.Empty<byte>(), ex.Message, missing: true); }

            using var limit = CancellationTokenSource.CreateLinkedTokenSource(ct);
            limit.CancelAfter(timeout);
            var stdout = new MemoryStream();
            var outTask = CopyLimitedAsync(p.StandardOutput.BaseStream, stdout, limit.Token);
            var errTask = p.StandardError.ReadToEndAsync(limit.Token);
            try
            {
                if (stdin != null)
                {
                    await p.StandardInput.BaseStream.WriteAsync(stdin, limit.Token).ConfigureAwait(false);
                    p.StandardInput.Close();
                }
                await p.WaitForExitAsync(limit.Token).ConfigureAwait(false);
                await Task.WhenAll(outTask, errTask).ConfigureAwait(false);
                return new CommandResult(p.ExitCode, stdout.ToArray(), errTask.Result);
            }
            catch (Exception ex) when (ex is OperationCanceledException || ex is IOException)
            {
                Kill(p);
                ct.ThrowIfCancellationRequested();
                if (ex is IOException && !limit.IsCancellationRequested)
                    return new CommandResult(-1, stdout.ToArray(), ex.Message);
                return new CommandResult(-1, stdout.ToArray(), program + " took too long.", timedOut: true);
            }
        }

        private static async Task CopyLimitedAsync(Stream from, MemoryStream to, CancellationToken ct)
        {
            var buf = new byte[81920];
            int n;
            while ((n = await from.ReadAsync(buf, ct).ConfigureAwait(false)) > 0)
            {
                if (to.Length + n > MaxStdoutBytes) throw new IOException("The program printed too much.");
                to.Write(buf, 0, n);
            }
        }

        private static void Kill(Process p)
        {
            try { if (!p.HasExited) p.Kill(entireProcessTree: true); }
            catch (Exception) { }
        }
    }
}
