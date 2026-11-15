using System;
using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace Squall.Link.Server
{
    /// <summary>
    /// The go-between for the phone API and the Squall window. The window (web/link.js) is where the team, its chats
    /// and approvals live, so:
    ///   - the window pushes the phone's state here every couple of seconds (<see cref="SetState"/>);
    ///   - a phone action or voice turn is posted to the window as {"event":"linkAsk","rid":..,"kind":..,"body":..}
    ///     and the window answers through the bridge (<see cref="Answer"/>).
    /// The host gives it one function: how to post a JSON message to the page (CoreWebView2.PostWebMessageAsJson,
    /// called on the UI thread).
    /// </summary>
    public sealed class PageRelay
    {
        private Action<string>? _post;
        private readonly ConcurrentDictionary<string, TaskCompletionSource<JsonElement>> _waiting = new();
        private readonly object _stateLock = new();
        private string? _stateJson;
        private DateTimeOffset _stateAt;
        private readonly Func<DateTimeOffset> _clock;
        private long _seq;

        public PageRelay(Func<DateTimeOffset>? clock = null) { _clock = clock ?? (() => DateTimeOffset.UtcNow); }

        /// <summary>True once the host has said how to reach the page.</summary>
        public bool Attached => Volatile.Read(ref _post) != null;

        /// <summary>Connects the page. post gets one JSON object as text.</summary>
        public void Attach(Action<string> post) => Volatile.Write(ref _post, post ?? throw new ArgumentNullException(nameof(post)));

        /// <summary>Disconnects the page; anything waiting on it gets no answer.</summary>
        public void Detach()
        {
            Volatile.Write(ref _post, null);
            foreach (var key in _waiting.Keys)
                if (_waiting.TryRemove(key, out var tcs)) tcs.TrySetCanceled();
            lock (_stateLock) { _stateJson = null; }
        }

        /// <summary>Posts an event to the page ({"event": name, ...fields}). False if the page isn't attached or posting failed.</summary>
        public bool Tell(string eventName, JsonObject? fields = null)
        {
            var post = Volatile.Read(ref _post);
            if (post == null) return false;
            var msg = new JsonObject { ["event"] = eventName };
            if (fields != null)
                foreach (var kv in fields) msg[kv.Key] = kv.Value?.DeepClone();
            try { post(msg.ToJsonString()); return true; }
            catch (Exception) { return false; }
        }

        /// <summary>
        /// Asks the page something and waits for its answer. Null when the page isn't attached, didn't answer in time,
        /// or the wait was cancelled.
        /// </summary>
        public async Task<JsonElement?> AskAsync(string kind, JsonNode? body, TimeSpan timeout, CancellationToken ct = default)
        {
            if (!Attached) return null;
            string rid = "r" + Interlocked.Increment(ref _seq).ToString() + "-" + Guid.NewGuid().ToString("N").Substring(0, 8);
            var tcs = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
            _waiting[rid] = tcs;
            try
            {
                if (!Tell("linkAsk", new JsonObject { ["rid"] = rid, ["kind"] = kind, ["body"] = body?.DeepClone() })) return null;
                using var timer = CancellationTokenSource.CreateLinkedTokenSource(ct);
                timer.CancelAfter(timeout);
                using (timer.Token.Register(() => tcs.TrySetCanceled()))
                {
                    try { return await tcs.Task.ConfigureAwait(false); }
                    catch (OperationCanceledException) { return null; }
                }
            }
            finally { _waiting.TryRemove(rid, out _); }
        }

        /// <summary>The page's answer to an ask. False if nobody is waiting for that id (late or unknown).</summary>
        public bool Answer(string? rid, JsonElement result)
        {
            if (string.IsNullOrEmpty(rid) || !_waiting.TryRemove(rid, out var tcs)) return false;
            return tcs.TrySetResult(result.Clone());
        }

        /// <summary>The page's newest snapshot for GET /api/v1/state. Must be a JSON object.</summary>
        public bool SetState(JsonElement state)
        {
            if (state.ValueKind != JsonValueKind.Object) return false;
            string json = state.GetRawText();
            lock (_stateLock) { _stateJson = json; _stateAt = _clock(); }
            return true;
        }

        /// <summary>The newest snapshot and how old it is, or null if there's none yet.</summary>
        public (string Json, TimeSpan Age)? State
        {
            get
            {
                lock (_stateLock)
                    return _stateJson == null ? null : (_stateJson, _clock() - _stateAt);
            }
        }

        /// <summary>How many asks are waiting for the page (for tests and the status line).</summary>
        public int Waiting => _waiting.Count;
    }
}
