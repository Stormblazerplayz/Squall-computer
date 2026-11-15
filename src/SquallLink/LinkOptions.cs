using System;
using System.IO;
using Squall.Link.Pairing;

namespace Squall.Link
{
    /// <summary>Settings for Squall's phone link and updater. The defaults are what Squall uses.</summary>
    public sealed class LinkOptions
    {
        /// <summary>The port the phone API listens on (docs/pairing.md: 47615).</summary>
        public int Port { get; set; } = PairingLink.DefaultPort;

        /// <summary>Only listen on 127.0.0.1 (tests). Squall listens on every network so the phone can reach it.</summary>
        public bool LoopbackOnly { get; set; }

        /// <summary>The name the phone shows for this computer.</summary>
        public string ComputerName { get; set; } = Environment.MachineName;

        /// <summary>Where paired phones, this computer's id and update downloads are kept.</summary>
        public string Folder { get; set; } = DefaultFolder;

        /// <summary>%LOCALAPPDATA%\Squall\link on Windows (the same idea elsewhere).</summary>
        public static string DefaultFolder =>
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Squall", "link");

        /// <summary>How long a pairing code works (docs/pairing.md: 2 minutes).</summary>
        public TimeSpan CodeLifetime { get; set; } = TimeSpan.FromMinutes(2);

        /// <summary>Wrong codes before the code is cancelled (docs/pairing.md: 5).</summary>
        public int MaxWrongTries { get; set; } = 5;

        /// <summary>How long a phone action waits for the Squall window.</summary>
        public TimeSpan ActionTimeout { get; set; } = TimeSpan.FromSeconds(15);

        /// <summary>How long a voice turn waits for Chief (the phone gives up at 45 s).</summary>
        public TimeSpan VoiceTimeout { get; set; } = TimeSpan.FromSeconds(40);

        /// <summary>A state snapshot older than this means the Squall window stopped answering.</summary>
        public TimeSpan StateMaxAge { get; set; } = TimeSpan.FromSeconds(15);

        /// <summary>The biggest request body a phone may send.</summary>
        public long MaxBodyBytes { get; set; } = 1_000_000;
    }
}
