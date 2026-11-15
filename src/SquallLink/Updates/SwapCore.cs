using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;

namespace Squall.Link.Updates
{
    /// <summary>What SquallSwap was asked to do (from its command line).</summary>
    public sealed class SwapJob
    {
        /// <summary>Squall's process id. SquallSwap waits for it to close before touching any file.</summary>
        public int Pid;
        /// <summary>The new version's files (unzipped and checked by Squall).</summary>
        public string Source = "";
        /// <summary>Where Squall is installed (the files that get replaced).</summary>
        public string Target = "";
        /// <summary>Where the old version is copied first, so it can be put back.</summary>
        public string Backup = "";
        /// <summary>The program to start afterwards, like Squall.exe.</summary>
        public string Exe = "";
        /// <summary>The file the new version writes once it started fine. Empty skips the check.</summary>
        public string OkFile = "";
        public string Log = "";
        public TimeSpan WaitForExit = TimeSpan.FromSeconds(90);
        public TimeSpan WaitForOk = TimeSpan.FromSeconds(60);

        /// <summary>Files Storm owns that an update must never overwrite, even if a zip has them.</summary>
        public static readonly string[] KeepFiles = { "team.json", "state.json", "window.json" };
        /// <summary>Folders Storm owns that an update must never touch.</summary>
        public static readonly string[] KeepFolders = { "workspace" };

        /// <summary>Reads "--pid 1234 --source ... --target ... --backup ... --exe Squall.exe --ok ... --log ...". Null if broken.</summary>
        public static SwapJob? Parse(string[] args)
        {
            var job = new SwapJob();
            if (args.Length % 2 != 0) return null;
            for (int i = 0; i + 1 < args.Length; i += 2)
            {
                string v = args[i + 1];
                switch (args[i].ToLowerInvariant())
                {
                    case "--pid": if (!int.TryParse(v, out job.Pid)) return null; break;
                    case "--source": job.Source = v; break;
                    case "--target": job.Target = v; break;
                    case "--backup": job.Backup = v; break;
                    case "--exe": job.Exe = v; break;
                    case "--ok": job.OkFile = v; break;
                    case "--log": job.Log = v; break;
                    case "--wait-ok": if (int.TryParse(v, out int s) && s > 0) job.WaitForOk = TimeSpan.FromSeconds(s); else return null; break;
                    default: return null;
                }
            }
            if (job.Source.Length == 0 || job.Target.Length == 0 || job.Backup.Length == 0 || job.Exe.Length == 0) return null;
            if (!PlainExe(job.Exe)) return null;   // the program to start must be a plain file name inside the install folder
            return job;
        }

        public static bool PlainExe(string exe) =>
            exe == Path.GetFileName(exe) && !exe.Contains('/') && !exe.Contains('\\') && !exe.Contains("..") &&
            exe.EndsWith(".exe", StringComparison.OrdinalIgnoreCase);

        /// <summary>True for a path (relative to the install folder) that an update must leave alone.</summary>
        public static bool Kept(string relativePath)
        {
            string rel = relativePath.Replace('\\', '/').TrimStart('/');
            string first = rel.Split('/')[0];
            if (rel.IndexOf('/') < 0 && KeepFiles.Any(f => f.Equals(rel, StringComparison.OrdinalIgnoreCase))) return true;
            return rel.IndexOf('/') >= 0 && KeepFolders.Any(f => f.Equals(first, StringComparison.OrdinalIgnoreCase));
        }
    }

    /// <summary>
    /// Swaps Squall's files for a new version: waits for Squall to close, backs up the old files, copies the new ones in,
    /// starts Squall again and waits for it to say it started fine. If anything goes wrong it puts the old files back and
    /// starts the old version. Files that aren't in the new version are never deleted, and Storm's own files
    /// (team.json, state.json, window.json, workspace\) are never touched.
    /// </summary>
    public static class SwapCore
    {
        public enum Result { Updated, RolledBack, NothingChanged }

        /// <summary>
        /// Runs the swap. start(path) starts a program and returns a check that says whether it has closed again (null
        /// if it didn't start); isRunning(pid) says if a process is still open.
        /// </summary>
        public static Result Run(SwapJob job, Func<string, Func<bool>?> start, Func<int, bool> isRunning, Action<string>? log = null)
        {
            void Log(string s)
            {
                string line = $"{DateTime.Now:yyyy-MM-dd HH:mm:ss}  {s}";
                log?.Invoke(line);
                if (job.Log.Length > 0) try { File.AppendAllText(job.Log, line + Environment.NewLine); } catch (Exception) { }
            }

            string source = Path.GetFullPath(job.Source), target = Path.GetFullPath(job.Target), backup = Path.GetFullPath(job.Backup);
            Log($"Update from {source} into {target}.");
            if (!File.Exists(Path.Combine(source, job.Exe)))
            {
                Log($"The new version has no {job.Exe}. Nothing changed.");
                StartOld();
                return Result.NothingChanged;
            }
            // Never let deleting the backup folder, or copying the new files, reach the install or the new files themselves.
            if (Inside(target, backup) || Inside(target, source) || Inside(source, backup) || Inside(backup, source))
            {
                Log("The folders overlap. Nothing changed.");
                StartOld();
                return Result.NothingChanged;
            }

            // 1. Wait for Squall to close.
            var until = DateTime.Now + job.WaitForExit;
            while (job.Pid > 0 && isRunning(job.Pid))
            {
                if (DateTime.Now > until) { Log("Squall didn't close, so nothing changed."); return Result.NothingChanged; }
                Thread.Sleep(250);
            }
            Thread.Sleep(300);   // let Windows let go of the files

            // 2. Back up the old version (only what the new version will overwrite).
            try
            {
                if (Directory.Exists(backup)) Directory.Delete(backup, recursive: true);
                Directory.CreateDirectory(backup);
                foreach (var file in Directory.EnumerateFiles(source, "*", SearchOption.AllDirectories))
                {
                    string rel = Path.GetRelativePath(source, file);
                    if (SwapJob.Kept(rel)) continue;
                    string old = Path.Combine(target, rel);
                    if (!File.Exists(old)) continue;
                    string dest = Path.Combine(backup, rel);
                    Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
                    Retry(() => File.Copy(old, dest, overwrite: true));
                }
                Log($"Backed up the old version to {backup}.");
            }
            catch (Exception ex)
            {
                Log("Couldn't back up the old version: " + ex.Message + ". Nothing changed.");
                StartOld();
                return Result.NothingChanged;
            }

            // 3. Copy the new files in.
            var written = new List<(string Path, bool Existed)>();
            try
            {
                CopyTree(source, target, written);
                Log($"Copied {written.Count} files.");
            }
            catch (Exception ex)
            {
                Log("Copying failed: " + ex.Message + ". Rolling back.");
                Rollback();
                return Result.RolledBack;
            }

            // 4. Start the new version and wait for it to say it's fine.
            try { if (job.OkFile.Length > 0 && File.Exists(job.OkFile)) File.Delete(job.OkFile); } catch (Exception) { }
            Func<bool>? hasExited;
            try { hasExited = start(Path.Combine(target, job.Exe)); }
            catch (Exception ex) { Log("Couldn't start the new version: " + ex.Message + ". Rolling back."); Rollback(); return Result.RolledBack; }
            if (hasExited == null) { Log("The new version didn't start. Rolling back."); Rollback(); return Result.RolledBack; }
            if (job.OkFile.Length > 0)
            {
                var okUntil = DateTime.Now + job.WaitForOk;
                while (!File.Exists(job.OkFile))
                {
                    bool exited;
                    try { exited = hasExited(); } catch (Exception) { exited = false; }
                    if (exited && !File.Exists(job.OkFile))
                    {
                        Log("The new version closed right after starting. Rolling back.");
                        Rollback();
                        return Result.RolledBack;
                    }
                    if (DateTime.Now > okUntil) { Log("The new version is running but didn't check in. Keeping it."); break; }
                    Thread.Sleep(300);
                }
            }
            Log("Update done.");
            return Result.Updated;

            void Rollback()
            {
                int restored = 0, removed = 0;
                foreach (var (path, existed) in written.AsEnumerable().Reverse())
                {
                    try
                    {
                        if (existed)
                        {
                            string from = Path.Combine(backup, Path.GetRelativePath(target, path));
                            if (File.Exists(from)) { Retry(() => File.Copy(from, path, overwrite: true)); restored++; }
                        }
                        else if (File.Exists(path)) { Retry(() => File.Delete(path)); removed++; }
                    }
                    catch (Exception ex) { Log("Rollback trouble with " + path + ": " + ex.Message); }
                }
                Log($"Rolled back: put back {restored} files, removed {removed} new ones.");
                StartOld();
            }

            void StartOld()
            {
                try
                {
                    string old = Path.Combine(target, job.Exe);
                    if (File.Exists(old)) start(old);
                }
                catch (Exception ex) { Log("Couldn't start Squall again: " + ex.Message); }
            }
        }

        /// <summary>Copies every file under from into to (overwriting), skipping Storm's own files, noting each file written.</summary>
        public static void CopyTree(string from, string to, List<(string Path, bool Existed)>? written)
        {
            Directory.CreateDirectory(to);
            foreach (var file in Directory.EnumerateFiles(from, "*", SearchOption.AllDirectories))
            {
                string rel = Path.GetRelativePath(from, file);
                if (SwapJob.Kept(rel)) continue;
                string dest = Path.Combine(to, rel);
                if (!Inside(dest, to)) throw new IOException("A file path points outside the folder: " + rel);
                Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
                bool existed = File.Exists(dest);
                // note it before copying, so a half-written file is put back too
                written?.Add((dest, existed));
                Retry(() => File.Copy(file, dest, overwrite: true));
            }
        }

        /// <summary>True when path is the folder or inside it.</summary>
        public static bool Inside(string path, string folder)
        {
            string p = Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            string f = Path.GetFullPath(folder).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            var cmp = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
            return p.Equals(f, cmp) || p.StartsWith(f + Path.DirectorySeparatorChar, cmp);
        }

        /// <summary>Files can stay locked for a moment after a program closes; try a few times.</summary>
        private static void Retry(Action a)
        {
            for (int i = 0; ; i++)
            {
                try { a(); return; }
                catch (IOException) when (i < 20) { Thread.Sleep(500); }
                catch (UnauthorizedAccessException) when (i < 20) { Thread.Sleep(500); }
            }
        }
    }
}
