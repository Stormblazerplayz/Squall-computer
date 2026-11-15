using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.Json;
using QRCoder;

namespace Squall.Link.Pairing
{
    /// <summary>The squall://pair link that goes in the QR code (docs/pairing.md, "The QR code").</summary>
    public static class PairingLink
    {
        public const int DefaultPort = 47615;
        public const int ProtocolVersion = 1;

        /// <summary>squall://pair?v=1&amp;host=192.168.1.20&amp;port=47615&amp;code=482913&amp;name=Storm-PC (spaces as %20).</summary>
        public static string Build(string host, int port, string code, string? name)
        {
            if (string.IsNullOrWhiteSpace(host)) throw new ArgumentException("The computer needs an address.", nameof(host));
            if (port is < 1 or > 65535) throw new ArgumentOutOfRangeException(nameof(port));
            var sb = new StringBuilder("squall://pair?v=").Append(ProtocolVersion)
                .Append("&host=").Append(Uri.EscapeDataString(host.Trim()))
                .Append("&port=").Append(port)
                .Append("&code=").Append(Uri.EscapeDataString(code));
            if (!string.IsNullOrWhiteSpace(name)) sb.Append("&name=").Append(Uri.EscapeDataString(name.Trim()));
            return sb.ToString();
        }

        /// <summary>Reads a squall://pair link back into its parts (used by the tests and the self-check). Null if it isn't one.</summary>
        public static IReadOnlyDictionary<string, string>? Parse(string link)
        {
            const string head = "squall://pair?";
            if (link == null || !link.StartsWith(head, StringComparison.Ordinal)) return null;
            var parts = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var pair in link.Substring(head.Length).Split('&', StringSplitOptions.RemoveEmptyEntries))
            {
                int eq = pair.IndexOf('=');
                if (eq <= 0) return null;
                parts[pair.Substring(0, eq)] = Uri.UnescapeDataString(pair.Substring(eq + 1));
            }
            return parts;
        }
    }

    /// <summary>QR codes for the pairing link, as SVG (for the Squall window) or a PNG data URI.</summary>
    public static class QrImage
    {
        /// <summary>An SVG QR code, black on white with the quiet zone, that scales to any size.</summary>
        public static string Svg(string text, int pixelsPerModule = 8)
        {
            using var gen = new QRCodeGenerator();
            using var data = gen.CreateQrCode(text, QRCodeGenerator.ECCLevel.M);
            return new SvgQRCode(data).GetGraphic(pixelsPerModule, "#000000", "#ffffff", true);
        }

        /// <summary>A PNG QR code as a data: URI, ready for an img tag.</summary>
        public static string PngDataUri(string text, int pixelsPerModule = 10)
        {
            using var gen = new QRCodeGenerator();
            using var data = gen.CreateQrCode(text, QRCodeGenerator.ECCLevel.M);
            byte[] png = new PngByteQRCode(data).GetGraphic(pixelsPerModule);
            return "data:image/png;base64," + Convert.ToBase64String(png);
        }

        /// <summary>The QR code's dark and light squares (true = dark), without the quiet zone. For tests and checks.</summary>
        public static bool[][] Modules(string text)
        {
            using var gen = new QRCodeGenerator();
            using var data = gen.CreateQrCode(text, QRCodeGenerator.ECCLevel.M);
            var rows = new List<bool[]>();
            foreach (var row in data.ModuleMatrix)
            {
                var r = new bool[row.Length];
                for (int i = 0; i < row.Length; i++) r[i] = row[i];
                rows.Add(r);
            }
            return rows.ToArray();
        }
    }

    /// <summary>This computer's lasting pairing identity: a random id made once and kept in computer.json.</summary>
    public static class ComputerIdentity
    {
        public const string FileName = "computer.json";

        public static string Id(string folder)
        {
            string path = Path.Combine(folder, FileName);
            try
            {
                if (File.Exists(path))
                {
                    using var doc = JsonDocument.Parse(File.ReadAllText(path));
                    if (doc.RootElement.TryGetProperty("computerId", out var id) && id.GetString() is { Length: >= 16 } s) return s;
                }
            }
            catch (Exception) { }
            string fresh = Guid.NewGuid().ToString("D");
            try
            {
                Directory.CreateDirectory(folder);
                File.WriteAllText(path, JsonSerializer.Serialize(new Dictionary<string, string> { ["computerId"] = fresh }));
            }
            catch (Exception) { }
            return fresh;
        }
    }
}
