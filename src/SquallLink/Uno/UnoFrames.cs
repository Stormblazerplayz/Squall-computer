using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading;
using System.Threading.Tasks;

namespace Squall.Link.Uno
{
    /// <summary>
    /// Live pictures of the computers' screens. Per computer it captures about 4 frames a second, but only while
    /// someone needs them (the hub says who: a running session, the window watching, or a phone that asked lately).
    /// Only the newest frame is kept. Squall Uno's own screenshots count as frames too.
    /// </summary>
    internal sealed class UnoFrames : IDisposable
    {
        private readonly DockerDesktops _docker;
        private readonly Func<string, bool> _needed;
        private readonly Action<string, UnoFrame> _onFrame;
        private readonly Func<DateTimeOffset> _clock;
        private readonly TimeSpan _interval;
        private readonly object _lock = new();
        private readonly Dictionary<string, UnoFrame> _latest = new();
        private readonly HashSet<string> _loops = new();
        private readonly CancellationTokenSource _stop = new();
        private long _seq;

        /// <param name="docker">Takes the pictures.</param>
        /// <param name="needed">Whether a computer's screen is wanted right now. Called outside the hub's lock.</param>
        /// <param name="onFrame">Called (outside any lock) with each new frame.</param>
        /// <param name="clock">The time.</param>
        /// <param name="interval">Time between frames.</param>
        public UnoFrames(DockerDesktops docker, Func<string, bool> needed, Action<string, UnoFrame> onFrame, Func<DateTimeOffset> clock, TimeSpan interval)
        {
            _docker = docker;
            _needed = needed;
            _onFrame = onFrame;
            _clock = clock;
            _interval = interval;
            // Frame numbers keep going up across restarts, so a phone's "after" from before never hides new frames.
            _seq = clock().ToUnixTimeMilliseconds();
        }

        public UnoFrame? Latest(string computerId)
        {
            lock (_lock) return _latest.TryGetValue(computerId, out var f) ? f : null;
        }

        /// <summary>True while a capture loop runs for that computer (for tests).</summary>
        public bool Streaming(string computerId)
        {
            lock (_lock) return _loops.Contains(computerId);
        }

        /// <summary>Starts capturing that computer if it is needed and not already streaming.</summary>
        public void Poke(string computerId)
        {
            if (_stop.IsCancellationRequested || !_needed(computerId)) return;
            lock (_lock)
            {
                if (!_loops.Add(computerId)) return;
            }
            _ = Task.Run(() => LoopAsync(computerId));
        }

        /// <summary>Keeps a screenshot Squall Uno took as the newest frame.</summary>
        public UnoFrame Offer(string computerId, byte[] jpeg, int cursorX, int cursorY)
        {
            UnoFrame f;
            lock (_lock)
            {
                f = new UnoFrame(++_seq, jpeg, cursorX, cursorY, _clock());
                _latest[computerId] = f;
            }
            try { _onFrame(computerId, f); } catch (Exception) { }
            return f;
        }

        /// <summary>Forgets a computer's frames (it was turned off).</summary>
        public void Clear(string computerId)
        {
            lock (_lock) _latest.Remove(computerId);
        }

        private async Task LoopAsync(string computerId)
        {
            int failures = 0;
            bool unneeded = false;
            try
            {
                while (!_stop.IsCancellationRequested)
                {
                    if (!_needed(computerId)) { unneeded = true; break; }
                    var sw = Stopwatch.StartNew();
                    try
                    {
                        byte[] jpeg = await _docker.CaptureAsync(computerId, 70, _stop.Token).ConfigureAwait(false);
                        (int x, int y) = (0, 0);
                        try { (x, y) = await _docker.CursorAsync(computerId, _stop.Token).ConfigureAwait(false); }
                        catch (UnoToolException) { }
                        Offer(computerId, jpeg, x, y);
                        failures = 0;
                    }
                    catch (OperationCanceledException) { break; }
                    catch (UnoComputerGoneException) { break; }
                    catch (UnoException)
                    {
                        if (++failures >= 5) break;
                        await Task.Delay(TimeSpan.FromSeconds(1), _stop.Token).ConfigureAwait(false);
                        continue;
                    }
                    var rest = _interval - sw.Elapsed;
                    if (rest > TimeSpan.Zero) await Task.Delay(rest, _stop.Token).ConfigureAwait(false);
                }
            }
            catch (OperationCanceledException) { }
            finally
            {
                lock (_lock) _loops.Remove(computerId);
            }
            // Someone may have started needing it again just as this loop stopped.
            if (unneeded && !_stop.IsCancellationRequested && _needed(computerId)) Poke(computerId);
        }

        public void Dispose()
        {
            _stop.Cancel();
        }
    }
}
