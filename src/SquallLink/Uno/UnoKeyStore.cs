using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;

namespace Squall.Link.Uno
{
    /// <summary>
    /// The Anthropic API key Squall Uno uses. The user environment variable SQUALL_UNO_KEY wins; otherwise the key saved
    /// from Squall's Uno settings. Only the hint ("sk-ant-…a1b2") ever leaves this class for the app.
    /// </summary>
    public sealed class UnoKeyStore
    {
        public const string EnvName = "SQUALL_UNO_KEY";
        private const string FileName = "key.dat";
        private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("Squall Uno API key");

        private readonly string _folder;
        private readonly Func<string?> _env;
        private readonly object _lock = new();
        private string? _saved;
        private bool _loaded;

        /// <param name="folder">Where the saved key file lives (the uno folder).</param>
        /// <param name="env">Reads SQUALL_UNO_KEY (tests pass their own).</param>
        public UnoKeyStore(string folder, Func<string?>? env = null)
        {
            _folder = folder;
            _env = env ?? ReadEnvironment;
        }

        private string FilePath => Path.Combine(_folder, FileName);

        /// <summary>The process environment, then (on Windows) the user's saved environment, so a key set while Squall runs works too.</summary>
        private static string? ReadEnvironment()
        {
            string? v = Environment.GetEnvironmentVariable(EnvName);
            if (string.IsNullOrWhiteSpace(v) && OperatingSystem.IsWindows())
            {
                try { v = Environment.GetEnvironmentVariable(EnvName, EnvironmentVariableTarget.User); }
                catch (Exception) { v = null; }
            }
            return string.IsNullOrWhiteSpace(v) ? null : v.Trim();
        }

        /// <summary>The key to use and where it came from: "env", "saved" or "none".</summary>
        internal (string? Key, string Source) Current
        {
            get
            {
                string? env = _env();
                if (!string.IsNullOrWhiteSpace(env)) return (env.Trim(), "env");
                string? saved = Saved();
                return saved != null ? (saved, "saved") : (null, "none");
            }
        }

        public bool HasKey => Current.Key != null;
        public string Source => Current.Source;

        /// <summary>"sk-ant-…a1b2": the first 7 and last 4 characters. Never the key.</summary>
        public string Hint => HintFor(Current.Key);

        internal static string HintFor(string? key)
        {
            if (string.IsNullOrEmpty(key)) return "";
            if (key.Length < 16) return "…";
            return key.Substring(0, 7) + "…" + key.Substring(key.Length - 4);
        }

        /// <summary>Checks a key's shape. Null when it looks right, otherwise a plain sentence.</summary>
        public static string? Problem(string? key)
        {
            key = (key ?? "").Trim();
            if (key.Length == 0) return "Paste your Anthropic API key first.";
            if (!key.StartsWith("sk-ant-", StringComparison.Ordinal)) return "That doesn't look like an Anthropic API key. It should start with sk-ant-.";
            if (key.Length < 30 || key.Length > 400) return "That key is the wrong length. Copy the whole key and paste it again.";
            foreach (char c in key)
                if (char.IsWhiteSpace(c) || char.IsControl(c) || c > 126) return "That key has spaces or odd characters in it. Copy it again.";
            return null;
        }

        /// <summary>Saves the key for this Windows user (DPAPI). Throws UnoException with a plain sentence if it can't.</summary>
        public void Save(string key)
        {
            key = (key ?? "").Trim();
            string? problem = Problem(key);
            if (problem != null) throw new UnoException(problem);
            byte[] plain = Encoding.UTF8.GetBytes(key);
            string content;
            if (OperatingSystem.IsWindows())
                content = "dpapi:" + Convert.ToBase64String(ProtectedData.Protect(plain, Entropy, DataProtectionScope.CurrentUser));
            else
                // Not encrypted on this system (no DPAPI); the file is readable by this user only (mode 600).
                content = "plain:" + Convert.ToBase64String(plain);
            lock (_lock)
            {
                try
                {
                    Directory.CreateDirectory(_folder);
                    string tmp = FilePath + ".tmp";
                    WritePrivate(tmp, content);
                    File.Move(tmp, FilePath, overwrite: true);
                }
                catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException)
                {
                    throw new UnoException("Squall couldn't save the key on this computer.");
                }
                _saved = key;
                _loaded = true;
            }
        }

        private static void WritePrivate(string path, string content)
        {
            if (File.Exists(path)) File.Delete(path);
            var opts = new FileStreamOptions { Mode = FileMode.CreateNew, Access = FileAccess.Write };
            if (!OperatingSystem.IsWindows()) opts.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
            using var fs = new FileStream(path, opts);
            var bytes = Encoding.UTF8.GetBytes(content);
            fs.Write(bytes, 0, bytes.Length);
        }

        /// <summary>Forgets the saved key (the environment variable, if set, still works).</summary>
        public void Remove()
        {
            lock (_lock)
            {
                try { if (File.Exists(FilePath)) File.Delete(FilePath); }
                catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException)
                {
                    throw new UnoException("Squall couldn't remove the saved key.");
                }
                _saved = null;
                _loaded = true;
            }
        }

        private string? Saved()
        {
            lock (_lock)
            {
                if (_loaded) return _saved;
                _loaded = true;
                _saved = null;
                try
                {
                    if (!File.Exists(FilePath)) return null;
                    string text = File.ReadAllText(FilePath).Trim();
                    byte[]? plain = null;
                    if (text.StartsWith("dpapi:", StringComparison.Ordinal))
                    {
                        if (OperatingSystem.IsWindows())
                            plain = ProtectedData.Unprotect(Convert.FromBase64String(text.Substring(6)), Entropy, DataProtectionScope.CurrentUser);
                    }
                    else if (text.StartsWith("plain:", StringComparison.Ordinal))
                        plain = Convert.FromBase64String(text.Substring(6));
                    if (plain == null) return null;
                    string key = Encoding.UTF8.GetString(plain).Trim();
                    _saved = Problem(key) == null ? key : null;
                }
                catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException || ex is FormatException || ex is CryptographicException)
                {
                    _saved = null;
                }
                return _saved;
            }
        }
    }
}
