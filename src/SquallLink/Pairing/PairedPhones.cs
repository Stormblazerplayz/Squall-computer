using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Squall.Link.Pairing
{
    /// <summary>What a phone says about itself when it pairs (the "device" object in POST /api/v1/pair).</summary>
    public sealed class PhoneInfo
    {
        [JsonPropertyName("deviceId")] public string DeviceId { get; set; } = "";
        [JsonPropertyName("deviceName")] public string DeviceName { get; set; } = "";
        [JsonPropertyName("platform")] public string Platform { get; set; } = "";
        [JsonPropertyName("systemVersion")] public string SystemVersion { get; set; } = "";
        [JsonPropertyName("appVersion")] public string AppVersion { get; set; } = "";

        /// <summary>Reads the phone's "device" object (missing or odd fields become "").</summary>
        public static PhoneInfo From(System.Text.Json.Nodes.JsonObject? o)
        {
            string F(string k) => o?[k] is System.Text.Json.Nodes.JsonValue v && v.GetValueKind() == JsonValueKind.String ? v.ToString() : "";
            return new PhoneInfo
            {
                DeviceId = F("deviceId"), DeviceName = F("deviceName"), Platform = F("platform"),
                SystemVersion = F("systemVersion"), AppVersion = F("appVersion"),
            }.Clean();
        }

        /// <summary>Cuts every field to a sane length and drops control characters, since a phone could send anything.</summary>
        public PhoneInfo Clean() => new()
        {
            DeviceId = Tidy(DeviceId, 80),
            DeviceName = Tidy(DeviceName, 80),
            Platform = Tidy(Platform, 30),
            SystemVersion = Tidy(SystemVersion, 30),
            AppVersion = Tidy(AppVersion, 30),
        };

        private static string Tidy(string? s, int max)
        {
            var sb = new StringBuilder();
            foreach (char c in (s ?? "").Trim())
            {
                if (char.IsControl(c)) continue;
                if (sb.Length >= max) break;
                sb.Append(c);
            }
            return sb.ToString();
        }
    }

    /// <summary>A paired phone as the computer remembers it: the phone's info and the SHA-256 of its token, never the token.</summary>
    public sealed class PairedPhone
    {
        [JsonPropertyName("tokenHash")] public string TokenHash { get; set; } = "";
        [JsonPropertyName("device")] public PhoneInfo Device { get; set; } = new();
        [JsonPropertyName("pairedAt")] public DateTimeOffset PairedAt { get; set; }
        [JsonPropertyName("lastSeen")] public DateTimeOffset LastSeen { get; set; }
    }

    /// <summary>
    /// The phones paired with this computer, kept in paired-phones.json in Squall's link folder. Only token hashes are
    /// saved, so the file is useless to anyone who copies it. Thread-safe.
    /// </summary>
    public sealed class PairedPhones
    {
        public const string FileName = "paired-phones.json";
        private static readonly TimeSpan SaveSeenEvery = TimeSpan.FromMinutes(1);

        private readonly string _path;
        private readonly Func<DateTimeOffset> _clock;
        private readonly object _lock = new();
        private readonly List<PairedPhone> _phones;
        private DateTimeOffset _lastSeenSave = DateTimeOffset.MinValue;

        /// <summary>Raised (on any thread) after a phone is added or removed.</summary>
        public event Action? Changed;

        public PairedPhones(string folder, Func<DateTimeOffset>? clock = null)
        {
            Directory.CreateDirectory(folder);
            _path = Path.Combine(folder, FileName);
            _clock = clock ?? (() => DateTimeOffset.UtcNow);
            _phones = Load(_path);
        }

        /// <summary>A copy of the list, newest pairing first.</summary>
        public IReadOnlyList<PairedPhone> All
        {
            get { lock (_lock) return _phones.OrderByDescending(p => p.PairedAt).Select(Copy).ToList(); }
        }

        public int Count { get { lock (_lock) return _phones.Count; } }

        /// <summary>Makes a new token for a phone and remembers it. Pairing the same phone again replaces its old token.</summary>
        public string Add(PhoneInfo device)
        {
            var info = (device ?? new PhoneInfo()).Clean();
            string token = Tokens.New();
            var now = _clock();
            lock (_lock)
            {
                if (info.DeviceId.Length > 0) _phones.RemoveAll(p => p.Device.DeviceId == info.DeviceId);
                _phones.Add(new PairedPhone { TokenHash = Tokens.Hash(token), Device = info, PairedAt = now, LastSeen = now });
                Save();
            }
            Changed?.Invoke();
            return token;
        }

        /// <summary>The phone a token belongs to (and notes that it was seen), or null.</summary>
        public PairedPhone? Find(string? token)
        {
            if (string.IsNullOrEmpty(token)) return null;
            string hash = Tokens.Hash(token);
            lock (_lock)
            {
                var p = _phones.FirstOrDefault(x => Tokens.SameHash(x.TokenHash, hash));
                if (p == null) return null;
                var now = _clock();
                p.LastSeen = now;
                if (now - _lastSeenSave >= SaveSeenEvery) { _lastSeenSave = now; Save(); }
                return Copy(p);
            }
        }

        /// <summary>Forgets the phone with this token. True if it was paired.</summary>
        public bool Remove(string? token)
        {
            if (string.IsNullOrEmpty(token)) return false;
            string hash = Tokens.Hash(token);
            return RemoveWhere(p => Tokens.SameHash(p.TokenHash, hash));
        }

        /// <summary>Forgets a phone by its device id (the Unpair button on the computer).</summary>
        public bool RemoveDevice(string deviceId) =>
            !string.IsNullOrEmpty(deviceId) && RemoveWhere(p => p.Device.DeviceId == deviceId);

        /// <summary>Forgets every phone.</summary>
        public int RemoveAll() => RemoveWhereCount(_ => true);

        private bool RemoveWhere(Predicate<PairedPhone> match) => RemoveWhereCount(match) > 0;

        private int RemoveWhereCount(Predicate<PairedPhone> match)
        {
            int n;
            lock (_lock)
            {
                n = _phones.RemoveAll(match);
                if (n > 0) Save();
            }
            if (n > 0) Changed?.Invoke();
            return n;
        }

        private static PairedPhone Copy(PairedPhone p) => new()
        {
            TokenHash = p.TokenHash,
            Device = new PhoneInfo
            {
                DeviceId = p.Device.DeviceId, DeviceName = p.Device.DeviceName, Platform = p.Device.Platform,
                SystemVersion = p.Device.SystemVersion, AppVersion = p.Device.AppVersion,
            },
            PairedAt = p.PairedAt,
            LastSeen = p.LastSeen,
        };

        private static List<PairedPhone> Load(string path)
        {
            try
            {
                if (!File.Exists(path)) return new List<PairedPhone>();
                var list = JsonSerializer.Deserialize(File.ReadAllText(path), LinkJson.Default.ListPairedPhone) ?? new List<PairedPhone>();
                return list.Where(p => p != null && Tokens.LooksLikeHash(p.TokenHash)).Select(p => { p.Device ??= new PhoneInfo(); return p; }).ToList();
            }
            catch (Exception)
            {
                // A broken file: keep it for a look, and start with no phones (they pair again).
                try { File.Copy(path, path + ".broken", overwrite: true); } catch (Exception) { }
                return new List<PairedPhone>();
            }
        }

        /// <summary>Writes the list to a temp file and swaps it in, so a crash never leaves half a file.</summary>
        private void Save()
        {
            try
            {
                string tmp = _path + ".tmp";
                File.WriteAllText(tmp, JsonSerializer.Serialize(_phones, LinkJson.Default.ListPairedPhone));
                File.Move(tmp, _path, overwrite: true);
            }
            catch (Exception) { }
        }
    }

    /// <summary>Phone tokens: 32 random bytes as base64url, stored only as a SHA-256 hash.</summary>
    public static class Tokens
    {
        public static string New() => Base64Url(RandomNumberGenerator.GetBytes(32));

        public static string Hash(string token) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token))).ToLowerInvariant();

        public static bool LooksLikeHash(string? s) =>
            s != null && s.Length == 64 && s.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f');

        public static bool SameHash(string a, string b) =>
            a.Length == b.Length && CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(a), Encoding.ASCII.GetBytes(b));

        public static string Base64Url(byte[] bytes) =>
            Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

        /// <summary>The token from an "Authorization: Bearer xyz" header, or null.</summary>
        public static string? FromHeader(string? header)
        {
            if (string.IsNullOrWhiteSpace(header)) return null;
            string h = header.Trim();
            if (!h.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)) return null;
            string t = h.Substring(7).Trim();
            return t.Length is > 0 and <= 200 ? t : null;
        }
    }

    /// <summary>Source-generated JSON for the saved files, so it also works in a trimmed build.</summary>
    [JsonSourceGenerationOptions(WriteIndented = true)]
    [JsonSerializable(typeof(List<PairedPhone>))]
    internal partial class LinkJson : JsonSerializerContext { }
}
