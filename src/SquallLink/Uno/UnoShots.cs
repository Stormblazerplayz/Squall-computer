using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json.Nodes;

namespace Squall.Link.Uno
{
    /// <summary>One real picture of a computer's screen during a session: a screenshot Squall Uno took, or the screen
    /// right after one of its clicks, typing or keys. The replay filmstrip shows these.</summary>
    public sealed class UnoShot
    {
        public UnoShot(long id, string sessionId, string computerId, int step, long eventSeq, long at, string kind, string text, byte[] jpeg, int cursorX, int cursorY, long frameSeq)
        {
            Id = id;
            SessionId = sessionId;
            ComputerId = computerId;
            Step = step;
            EventSeq = eventSeq;
            At = at;
            Kind = kind;
            Text = text;
            Jpeg = jpeg;
            CursorX = cursorX;
            CursorY = cursorY;
            FrameSeq = frameSeq;
        }

        public long Id { get; }
        public string SessionId { get; }
        public string ComputerId { get; }
        /// <summary>The session's step number (tool calls so far) this picture belongs to.</summary>
        public int Step { get; }
        /// <summary>The seq of the event it shows (0 when none).</summary>
        public long EventSeq { get; }
        public long At { get; }
        /// <summary>The event kind it shows ("screenshot", "click", "type", …).</summary>
        public string Kind { get; }
        /// <summary>The feed sentence for that step ("Clicked at (412, 230)").</summary>
        public string Text { get; }
        public byte[] Jpeg { get; }
        public int CursorX { get; }
        public int CursorY { get; }
        /// <summary>The live frame it came from, so the same frame isn't kept twice.</summary>
        public long FrameSeq { get; }
        public int Width => DockerDesktops.Width;
        public int Height => DockerDesktops.Height;

        /// <summary>Everything but the picture (docs/squall-uno.md "Shot").</summary>
        public JsonObject ToJson() => new()
        {
            ["id"] = Id,
            ["sessionId"] = SessionId,
            ["computerId"] = ComputerId,
            ["step"] = Step,
            ["seq"] = EventSeq,
            ["at"] = At,
            ["kind"] = Kind,
            ["text"] = Text,
            ["width"] = Width,
            ["height"] = Height,
            ["cursorX"] = CursorX,
            ["cursorY"] = CursorY,
            ["bytes"] = Jpeg.Length,
        };
    }

    /// <summary>
    /// The replay pictures, kept in memory only (they are gone after Squall restarts). Each session keeps its newest
    /// <see cref="PerSession"/> pictures, and all sessions together stay under <see cref="ByteBudget"/>: when it is
    /// full, the oldest pictures of the session that was used longest ago go first.
    /// </summary>
    internal sealed class UnoShots
    {
        private readonly object _lock = new();
        private readonly Dictionary<string, List<UnoShot>> _bySession = new();
        private readonly Dictionary<string, long> _lastUsed = new();
        private long _bytes;
        private long _nextId;
        private long _use;

        public UnoShots(long firstId, int perSession = 120, long byteBudget = 64L * 1024 * 1024)
        {
            _nextId = firstId;
            PerSession = Math.Max(1, perSession);
            ByteBudget = Math.Max(1, byteBudget);
        }

        public int PerSession { get; }
        public long ByteBudget { get; }

        /// <summary>Bytes of pictures kept right now (for tests).</summary>
        public long Bytes { get { lock (_lock) return _bytes; } }

        /// <summary>Keeps a picture. Returns null when it is the same frame as that session's newest picture or empty.</summary>
        public UnoShot? Add(string sessionId, string computerId, int step, long eventSeq, long at, string kind, string text, byte[] jpeg, int cursorX, int cursorY, long frameSeq)
        {
            if (string.IsNullOrEmpty(sessionId) || jpeg == null || jpeg.Length == 0) return null;
            lock (_lock)
            {
                if (!_bySession.TryGetValue(sessionId, out var list)) _bySession[sessionId] = list = new List<UnoShot>();
                if (frameSeq > 0 && list.Count > 0 && list[^1].FrameSeq == frameSeq) return null;
                var shot = new UnoShot(++_nextId, sessionId, computerId, step, eventSeq, at, kind ?? "", text ?? "", jpeg, cursorX, cursorY, frameSeq);
                list.Add(shot);
                _bytes += jpeg.Length;
                _lastUsed[sessionId] = ++_use;
                while (list.Count > PerSession) RemoveAt(list, 0);
                Trim(sessionId);
                return list.Count > 0 && list[^1] == shot ? shot : null;
            }
        }

        /// <summary>A session's pictures, oldest first.</summary>
        public List<UnoShot> For(string sessionId)
        {
            lock (_lock) return _bySession.TryGetValue(sessionId ?? "", out var list) ? list.ToList() : new List<UnoShot>();
        }

        public UnoShot? Get(string sessionId, long id)
        {
            lock (_lock)
            {
                if (!_bySession.TryGetValue(sessionId ?? "", out var list)) return null;
                return list.FirstOrDefault(s => s.Id == id);
            }
        }

        /// <summary>The newest picture of a session (null when none).</summary>
        public UnoShot? Latest(string sessionId)
        {
            lock (_lock) return _bySession.TryGetValue(sessionId ?? "", out var list) && list.Count > 0 ? list[^1] : null;
        }

        private void RemoveAt(List<UnoShot> list, int index)
        {
            _bytes -= list[index].Jpeg.Length;
            list.RemoveAt(index);
        }

        /// <summary>Stays under the byte budget, taking from the sessions used longest ago first (the newest one last).</summary>
        private void Trim(string keep)
        {
            while (_bytes > ByteBudget)
            {
                string? victim = _lastUsed.Where(kv => kv.Key != keep && _bySession.TryGetValue(kv.Key, out var l) && l.Count > 0)
                    .OrderBy(kv => kv.Value).Select(kv => kv.Key).FirstOrDefault();
                victim ??= keep;
                var list = _bySession[victim];
                if (list.Count == 0) break;
                // the newest picture of the session being added to always stays
                if (victim == keep && list.Count == 1) break;
                RemoveAt(list, 0);
                if (list.Count == 0)
                {
                    _bySession.Remove(victim);
                    _lastUsed.Remove(victim);
                }
            }
        }
    }
}
