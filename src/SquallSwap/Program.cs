using System;
using System.Diagnostics;
using System.IO;

namespace Squall.Link.Updates
{
    public static class Program
    {
        /// <summary>
        /// SquallSwap --pid 1234 --source "new files" --target "install folder" --backup "backup folder"
        ///            --exe Squall.exe --ok "started.ok" --log "updater.log"
        /// </summary>
        public static int Main(string[] args)
        {
            var job = SwapJob.Parse(args);
            if (job == null)
            {
                Console.Error.WriteLine("SquallSwap is started by Squall when it updates itself. You don't need to run it.");
                return 1;
            }
            var result = SwapCore.Run(job, Start, IsRunning, Console.WriteLine);
            return result == SwapCore.Result.Updated ? 0 : 2;
        }

        private static Func<bool>? Start(string exe)
        {
            var p = Process.Start(new ProcessStartInfo(exe) { UseShellExecute = true, WorkingDirectory = Path.GetDirectoryName(exe)! });
            if (p == null) return null;
            return () => p.HasExited;
        }

        private static bool IsRunning(int pid)
        {
            try
            {
                using var p = Process.GetProcessById(pid);
                return !p.HasExited;
            }
            catch (ArgumentException) { return false; }   // no process with that id
            catch (InvalidOperationException) { return false; }
        }
    }
}
