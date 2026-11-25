using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Squall.Link.Uno
{
    /// <summary>
    /// The newest events (a ring of 5000) for the "WHAT IT DID" feed. Seq numbers start from the clock in
    /// milliseconds when Squall starts, so they keep going up across restarts (a client just passes the last one back).
    /// </summary>
    public sealed class UnoEventLog
    {
        public const int Capacity = 5000;
        private readonly object _lock = new();
        private readonly LinkedList<UnoEvent> _events = new();
        private long _seq;

        public UnoEventLog(long firstSeq = 0) { _seq = firstSeq; }

        public long LastSeq { get { lock (_lock) return _seq; } }

        /// <summary>Numbers the event and keeps it.</summary>
        public UnoEvent Add(UnoEvent e)
        {
            lock (_lock)
            {
                e.Seq = ++_seq;
                _events.AddLast(e);
                while (_events.Count > Capacity) _events.RemoveFirst();
                return e;
            }
        }

        /// <summary>
        /// Events after since (oldest first, at most max), only one session's if sessionId is set, and the seq to pass
        /// as since next time. A since from before a restart (bigger than anything here) starts from the beginning.
        /// </summary>
        public (List<UnoEvent> Events, long LastSeq) Since(long since, string? sessionId, int max)
        {
            lock (_lock)
            {
                if (since > _seq) since = 0;
                var list = new List<UnoEvent>();
                foreach (var e in _events)
                {
                    if (e.Seq <= since) continue;
                    if (sessionId != null && e.SessionId != sessionId) continue;
                    list.Add(e);
                    if (list.Count >= max) return (list, e.Seq);
                }
                return (list, _seq);
            }
        }

        public int Count { get { lock (_lock) return _events.Count; } }
    }

    /// <summary>
    /// What Squall Uno keeps between runs, in uno/state.json: settings, the computers, the sessions (newest 200) and
    /// tokens used per day. No screenshots, no conversations and never the API key.
    /// </summary>
    internal sealed class UnoStore
    {
        public const int MaxSessions = 200;
        private readonly string _path;

        public int MaxSteps = 80;
        public readonly Dictionary<string, (long Input, long Output)> Tokens = new();
        public readonly List<UnoComputer> Computers = new();
        /// <summary>Oldest first.</summary>
        public readonly List<UnoSession> Sessions = new();

        public UnoStore(string folder) { _path = Path.Combine(folder, "state.json"); }

        /// <summary>Reads state.json; sessions that were running when Squall closed become "stopped".</summary>
        public void Load(long nowMs)
        {
            JsonObject? root = null;
            try { if (File.Exists(_path)) root = JsonNode.Parse(File.ReadAllText(_path)) as JsonObject; }
            catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException || ex is JsonException) { root = null; }
            if (root == null) return;
            if (UnoSession.Long(root, "maxSteps") is long ms && ms is >= 10 and <= 300) MaxSteps = (int)ms;
            if (root["tokens"] is JsonObject tok)
                foreach (var kv in tok)
                    if (kv.Value is JsonObject day)
                        Tokens[kv.Key] = (UnoSession.Long(day, "input") ?? 0, UnoSession.Long(day, "output") ?? 0);
            if (root["computers"] is JsonArray comps)
                foreach (var c in comps.OfType<JsonObject>())
                {
                    string id = UnoSession.Str(c, "id");
                    if (id.Length == 0 || Computers.Any(x => x.Id == id)) continue;
                    Computers.Add(new UnoComputer { Id = id, AgentId = UnoSession.Str(c, "agentId"), AgentName = UnoSession.Str(c, "agentName") });
                }
            if (root["sessions"] is JsonArray sess)
                foreach (var s in sess.OfType<JsonObject>())
                {
                    var one = UnoSession.FromJson(s);
                    if (one == null || Sessions.Any(x => x.Id == one.Id)) continue;
                    if (one.Active)
                    {
                        one.State = "stopped";
                        one.EndedAt ??= nowMs;
                        if (one.Now.Length == 0) one.Now = "Stopped when Squall closed.";
                    }
                    Sessions.Add(one);
                }
            Trim();
        }

        private void Trim()
        {
            while (Sessions.Count > MaxSessions) Sessions.RemoveAt(0);
            if (Tokens.Count > 14)
                foreach (var k in Tokens.Keys.OrderBy(k => k, StringComparer.Ordinal).Take(Tokens.Count - 14).ToList()) Tokens.Remove(k);
        }

        /// <summary>Writes state.json (a temp file, then a rename). Best effort: a full disk doesn't stop Squall Uno.</summary>
        public void Save()
        {
            Trim();
            var tokens = new JsonObject();
            foreach (var kv in Tokens) tokens[kv.Key] = new JsonObject { ["input"] = kv.Value.Input, ["output"] = kv.Value.Output };
            var comps = new JsonArray();
            foreach (var c in Computers) comps.Add(new JsonObject { ["id"] = c.Id, ["agentId"] = c.AgentId, ["agentName"] = c.AgentName });
            var sess = new JsonArray();
            foreach (var s in Sessions) sess.Add(s.ToJson());
            var root = new JsonObject { ["version"] = 1, ["maxSteps"] = MaxSteps, ["tokens"] = tokens, ["computers"] = comps, ["sessions"] = sess };
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
                string tmp = _path + ".tmp";
                File.WriteAllText(tmp, root.ToJsonString(new JsonSerializerOptions { WriteIndented = true }), new UTF8Encoding(false));
                File.Move(tmp, _path, overwrite: true);
            }
            catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException) { }
        }

        public static string Day(DateTimeOffset now) => now.ToLocalTime().ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

        public void AddTokens(DateTimeOffset now, long input, long output)
        {
            string d = Day(now);
            Tokens.TryGetValue(d, out var t);
            Tokens[d] = (t.Input + input, t.Output + output);
        }

        public (long Input, long Output) TokensOn(DateTimeOffset now) => Tokens.TryGetValue(Day(now), out var t) ? t : (0, 0);
    }
}
