using System;
using System.Security.Cryptography;
using System.Text;

namespace Squall.Link.Pairing
{
    /// <summary>What happened when a phone tried a pairing code. Each one maps to an answer in docs/pairing.md.</summary>
    public enum CodeCheck
    {
        /// <summary>The code was right. It is used up now (one code, one phone).</summary>
        Ok,
        /// <summary>The Pair a phone screen isn't open, or its code was already used (409 not_listening).</summary>
        NotListening,
        /// <summary>The code ran out of time (410 code_expired).</summary>
        Expired,
        /// <summary>Too many wrong tries; the code is cancelled until a new one is made (429 too_many_tries).</summary>
        TooManyTries,
        /// <summary>Wrong code (401 wrong_code).</summary>
        Wrong,
    }

    /// <summary>A pairing code and when it stops working.</summary>
    public sealed record PairingCode(string Code, DateTimeOffset ExpiresAt);

    /// <summary>
    /// The Pair a phone screen's code: 6 random digits from a secure source, good for <see cref="Lifetime"/> and one
    /// phone, cancelled after <see cref="MaxWrongTries"/> wrong tries, and only while the screen is open.
    /// Making a new code cancels the old one. Thread-safe.
    /// </summary>
    public sealed class PairingWindow
    {
        public TimeSpan Lifetime { get; }
        public int MaxWrongTries { get; }

        private readonly Func<DateTimeOffset> _clock;
        private readonly Func<int> _sixDigits;
        private readonly object _lock = new();
        private bool _open;
        private string? _code;
        private DateTimeOffset _expires;
        private int _wrong;
        private bool _lockedOut;

        public PairingWindow(TimeSpan? lifetime = null, int maxWrongTries = 5, Func<DateTimeOffset>? clock = null, Func<int>? randomSixDigits = null)
        {
            Lifetime = lifetime ?? TimeSpan.FromMinutes(2);
            if (Lifetime <= TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(lifetime));
            if (maxWrongTries < 1) throw new ArgumentOutOfRangeException(nameof(maxWrongTries));
            MaxWrongTries = maxWrongTries;
            _clock = clock ?? (() => DateTimeOffset.UtcNow);
            _sixDigits = randomSixDigits ?? (() => RandomNumberGenerator.GetInt32(0, 1_000_000));
        }

        /// <summary>True while the Pair a phone screen is open.</summary>
        public bool IsOpen { get { lock (_lock) return _open; } }

        /// <summary>The code to show, or null when there's none (screen closed, code used, run out or cancelled).</summary>
        public PairingCode? Current
        {
            get
            {
                lock (_lock)
                {
                    if (!_open || _code == null || _lockedOut || _clock() >= _expires) return null;
                    return new PairingCode(_code, _expires);
                }
            }
        }

        /// <summary>Opens the screen (or keeps it open) with a brand-new code. The old code stops working.</summary>
        public PairingCode Open()
        {
            lock (_lock)
            {
                int n = _sixDigits();
                if (n < 0 || n > 999_999) throw new InvalidOperationException("The code source must give 0 to 999999.");
                _open = true;
                _code = n.ToString("D6");
                _expires = _clock() + Lifetime;
                _wrong = 0;
                _lockedOut = false;
                return new PairingCode(_code, _expires);
            }
        }

        /// <summary>Closes the screen. No code works until it opens again.</summary>
        public void Close()
        {
            lock (_lock)
            {
                _open = false;
                _code = null;
                _wrong = 0;
                _lockedOut = false;
            }
        }

        /// <summary>Checks a code a phone sent. A right code is used up at once.</summary>
        public CodeCheck Try(string? code)
        {
            lock (_lock)
            {
                if (!_open) return CodeCheck.NotListening;
                if (_lockedOut) return CodeCheck.TooManyTries;
                if (_code == null) return CodeCheck.NotListening;
                if (_clock() >= _expires) return CodeCheck.Expired;
                if (!SameCode(code, _code))
                {
                    _wrong++;
                    if (_wrong >= MaxWrongTries)
                    {
                        _lockedOut = true;
                        return CodeCheck.TooManyTries;
                    }
                    return CodeCheck.Wrong;
                }
                _code = null;   // one code, one phone
                return CodeCheck.Ok;
            }
        }

        /// <summary>Compares in constant time, so timing doesn't give away digits.</summary>
        private static bool SameCode(string? given, string want)
        {
            byte[] a = SHA256.HashData(Encoding.UTF8.GetBytes((given ?? "").Trim()));
            byte[] b = SHA256.HashData(Encoding.UTF8.GetBytes(want));
            return CryptographicOperations.FixedTimeEquals(a, b);
        }
    }
}
