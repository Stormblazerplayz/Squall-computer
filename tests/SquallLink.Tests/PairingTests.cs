using System;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.NetworkInformation;
using Squall.Link.Pairing;
using Xunit;

namespace Squall.Link.Tests
{
    /// <summary>A temp folder that cleans itself up.</summary>
    public sealed class TempDir : IDisposable
    {
        public string Path { get; } = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "squall-test-" + Guid.NewGuid().ToString("N"));
        public TempDir() { Directory.CreateDirectory(Path); }
        public string Sub(params string[] parts) => System.IO.Path.Combine(new[] { Path }.Concat(parts).ToArray());
        public void Dispose() { try { Directory.Delete(Path, recursive: true); } catch (Exception) { } }
    }

    public class PairingWindowTests
    {
        private DateTimeOffset _now = new(2026, 11, 15, 12, 0, 0, TimeSpan.Zero);
        private int _next = 482913;

        private PairingWindow Make() => new(TimeSpan.FromMinutes(2), 5, () => _now, () => _next);

        [Fact]
        public void CodeIsSixDigitsAndWorksOnce()
        {
            var w = Make();
            Assert.Equal(CodeCheck.NotListening, w.Try("482913"));   // screen not open yet
            var code = w.Open();
            Assert.Equal("482913", code.Code);
            Assert.Equal(_now + TimeSpan.FromMinutes(2), code.ExpiresAt);
            Assert.Equal(CodeCheck.Ok, w.Try("482913"));
            Assert.Equal(CodeCheck.NotListening, w.Try("482913"));   // one code, one phone
            Assert.Null(w.Current);
            Assert.True(w.IsOpen);
        }

        [Fact]
        public void SmallNumbersKeepLeadingZeros()
        {
            _next = 42;
            var w = Make();
            Assert.Equal("000042", w.Open().Code);
            Assert.Equal(CodeCheck.Wrong, w.Try("42"));
            Assert.Equal(CodeCheck.Ok, w.Try(" 000042 "));
        }

        [Fact]
        public void FiveWrongTriesCancelTheCode()
        {
            var w = Make();
            w.Open();
            for (int i = 0; i < 4; i++) Assert.Equal(CodeCheck.Wrong, w.Try("111111"));
            Assert.Equal(CodeCheck.TooManyTries, w.Try("222222"));
            Assert.Equal(CodeCheck.TooManyTries, w.Try("482913"));   // even the right code is refused now
            Assert.Null(w.Current);
            _next = 123456;
            w.Open();                                                  // a new code starts fresh
            Assert.Equal(CodeCheck.Ok, w.Try("123456"));
        }

        [Fact]
        public void CodeRunsOutAfterTwoMinutes()
        {
            var w = Make();
            w.Open();
            _now += TimeSpan.FromSeconds(119);
            Assert.NotNull(w.Current);
            _now += TimeSpan.FromSeconds(1);
            Assert.Null(w.Current);
            Assert.Equal(CodeCheck.Expired, w.Try("482913"));
        }

        [Fact]
        public void NewCodeCancelsTheOldOne()
        {
            var w = Make();
            w.Open();
            _next = 777777;
            w.Open();
            Assert.Equal(CodeCheck.Wrong, w.Try("482913"));
            Assert.Equal(CodeCheck.Ok, w.Try("777777"));
        }

        [Fact]
        public void ClosingTheScreenStopsTheCode()
        {
            var w = Make();
            w.Open();
            w.Close();
            Assert.False(w.IsOpen);
            Assert.Equal(CodeCheck.NotListening, w.Try("482913"));
            Assert.Equal(CodeCheck.NotListening, w.Try(null));
        }

        [Fact]
        public void RealCodesAreRandomSixDigitStrings()
        {
            var w = new PairingWindow();
            var seen = Enumerable.Range(0, 40).Select(_ => w.Open().Code).ToList();
            Assert.All(seen, c => Assert.Matches("^[0-9]{6}$", c));
            Assert.True(seen.Distinct().Count() > 30);
        }
    }

    public class PairedPhonesTests
    {
        private static PhoneInfo Ipad(string id = "6F1C-1") => new()
        {
            DeviceId = id, DeviceName = "Storm's iPad", Platform = "iPadOS", SystemVersion = "18.1", AppVersion = "0.1.0",
        };

        [Fact]
        public void TokensAreLongRandomAndOnlyTheHashIsSaved()
        {
            using var dir = new TempDir();
            var phones = new PairedPhones(dir.Path);
            string token = phones.Add(Ipad());
            Assert.Matches("^[A-Za-z0-9_-]{43}$", token);   // 32 bytes, base64url, no padding
            string file = File.ReadAllText(dir.Sub(PairedPhones.FileName));
            Assert.DoesNotContain(token, file);
            Assert.Contains(Tokens.Hash(token), file);
            Assert.Contains("iPadOS", file);
        }

        [Fact]
        public void FindsRemembersAcrossRestartsAndForgets()
        {
            using var dir = new TempDir();
            var phones = new PairedPhones(dir.Path);
            string token = phones.Add(Ipad());
            Assert.Equal("Storm's iPad", phones.Find(token)!.Device.DeviceName);
            Assert.Null(phones.Find("nope"));
            Assert.Null(phones.Find(null));

            var again = new PairedPhones(dir.Path);   // Squall restarted
            Assert.Equal("iPadOS", again.Find(token)!.Device.Platform);
            Assert.True(again.Remove(token));
            Assert.False(again.Remove(token));
            Assert.Null(new PairedPhones(dir.Path).Find(token));
        }

        [Fact]
        public void PairingTheSamePhoneAgainReplacesItsOldToken()
        {
            using var dir = new TempDir();
            var phones = new PairedPhones(dir.Path);
            string first = phones.Add(Ipad());
            string second = phones.Add(Ipad());
            Assert.Equal(1, phones.Count);
            Assert.Null(phones.Find(first));
            Assert.NotNull(phones.Find(second));
            phones.Add(Ipad("other-phone"));
            Assert.Equal(2, phones.Count);
            Assert.True(phones.RemoveDevice("other-phone"));
            Assert.Equal(1, phones.Count);
            Assert.Equal(1, phones.RemoveAll());
            Assert.Equal(0, phones.Count);
        }

        [Fact]
        public void OddDeviceInfoIsCleanedUp()
        {
            using var dir = new TempDir();
            var phones = new PairedPhones(dir.Path);
            string token = phones.Add(new PhoneInfo { DeviceName = "  Bad\u0007Name" + new string('x', 200), DeviceId = "id\n1" });
            var p = phones.Find(token)!;
            Assert.StartsWith("BadName", p.Device.DeviceName);
            Assert.Equal(80, p.Device.DeviceName.Length);
            Assert.Equal("id1", p.Device.DeviceId);
        }

        [Fact]
        public void ABrokenFileStartsEmptyAndIsKeptForALook()
        {
            using var dir = new TempDir();
            File.WriteAllText(dir.Sub(PairedPhones.FileName), "{ not json");
            var phones = new PairedPhones(dir.Path);
            Assert.Equal(0, phones.Count);
            Assert.True(File.Exists(dir.Sub(PairedPhones.FileName + ".broken")));
            string token = phones.Add(Ipad());
            Assert.NotNull(new PairedPhones(dir.Path).Find(token));
        }

        [Fact]
        public void BearerHeaderIsRead()
        {
            Assert.Equal("abc", Tokens.FromHeader("Bearer abc"));
            Assert.Equal("abc", Tokens.FromHeader("bearer  abc "));
            Assert.Null(Tokens.FromHeader("Basic abc"));
            Assert.Null(Tokens.FromHeader(""));
            Assert.Null(Tokens.FromHeader(null));
            Assert.Null(Tokens.FromHeader("Bearer " + new string('a', 300)));
        }
    }

    public class PairingLinkTests
    {
        [Fact]
        public void LinkMatchesTheContract()
        {
            string link = PairingLink.Build("192.168.1.20", 47615, "482913", "Storm-PC");
            Assert.Equal("squall://pair?v=1&host=192.168.1.20&port=47615&code=482913&name=Storm-PC", link);
        }

        [Fact]
        public void SpacesInTheNameAreEncodedAsPercent20()
        {
            string link = PairingLink.Build("storm-pc.local", 47615, "000001", "Storm's Gaming PC");
            Assert.Contains("name=Storm%27s%20Gaming%20PC", link);
            Assert.DoesNotContain("+", link);
            var parts = PairingLink.Parse(link)!;
            Assert.Equal("Storm's Gaming PC", parts["name"]);
            Assert.Equal("storm-pc.local", parts["host"]);
            Assert.Equal("1", parts["v"]);
        }

        [Fact]
        public void NameIsOptional()
        {
            Assert.Equal("squall://pair?v=1&host=10.0.0.5&port=5000&code=123456", PairingLink.Build("10.0.0.5", 5000, "123456", "  "));
            Assert.Throws<ArgumentException>(() => PairingLink.Build("", 47615, "1", null));
            Assert.Throws<ArgumentOutOfRangeException>(() => PairingLink.Build("h", 0, "1", null));
            Assert.Null(PairingLink.Parse("https://example.com"));
        }

        [Fact]
        public void QrCodeIsMadeAsSvgAndPng()
        {
            string link = PairingLink.Build("192.168.1.20", 47615, "482913", "Storm-PC");
            string svg = QrImage.Svg(link);
            Assert.StartsWith("<svg", svg.TrimStart());
            Assert.Contains("</svg>", svg);
            string png = QrImage.PngDataUri(link);
            Assert.StartsWith("data:image/png;base64,", png);
            byte[] bytes = Convert.FromBase64String(png.Substring("data:image/png;base64,".Length));
            Assert.Equal(new byte[] { 0x89, 0x50, 0x4E, 0x47 }, bytes.Take(4).ToArray());
            var modules = QrImage.Modules(link);
            Assert.True(modules.Length >= 21);
            Assert.All(modules, row => Assert.Equal(modules.Length, row.Length));   // square
        }

        [Fact]
        public void ComputerIdIsKept()
        {
            using var dir = new TempDir();
            string a = ComputerIdentity.Id(dir.Path);
            string b = ComputerIdentity.Id(dir.Path);
            Assert.Equal(a, b);
            Assert.True(Guid.TryParse(a, out _));
        }
    }

    public class LanAddressesTests
    {
        [Fact]
        public void HomeWifiBeatsVirtualAdapters()
        {
            var ranked = LanAddresses.Rank(new[]
            {
                new LanCandidate("172.24.160.1", "vEthernet (WSL)", "Hyper-V Virtual Ethernet Adapter", NetworkInterfaceType.Ethernet, false),
                new LanCandidate("192.168.56.1", "Ethernet 2", "VirtualBox Host-Only Ethernet Adapter", NetworkInterfaceType.Ethernet, false),
                new LanCandidate("100.101.5.9", "Tailscale", "Tailscale Tunnel", NetworkInterfaceType.Unknown, false),
                new LanCandidate("192.168.1.20", "Wi-Fi", "Intel(R) Wi-Fi 6 AX201", NetworkInterfaceType.Wireless80211, true),
                new LanCandidate("169.254.10.10", "Ethernet", "Realtek PCIe GbE", NetworkInterfaceType.Ethernet, false),
                new LanCandidate("127.0.0.1", "Loopback", "Loopback", NetworkInterfaceType.Loopback, false),
            });
            Assert.Equal("192.168.1.20", ranked[0].Address);
            Assert.DoesNotContain(ranked, c => c.Address == "169.254.10.10" || c.Address == "127.0.0.1");
            Assert.Equal(4, ranked.Count);
        }

        [Fact]
        public void WiredHomeNetworkWorksToo()
        {
            var ranked = LanAddresses.Rank(new[]
            {
                new LanCandidate("10.0.0.42", "Ethernet", "Realtek PCIe GbE", NetworkInterfaceType.Ethernet, true),
                new LanCandidate("172.17.0.1", "docker0", "Docker bridge", NetworkInterfaceType.Ethernet, false),
            });
            Assert.Equal("10.0.0.42", ranked[0].Address);
        }

        [Theory]
        [InlineData("192.168.1.5", true)]
        [InlineData("10.1.2.3", true)]
        [InlineData("172.16.0.1", true)]
        [InlineData("172.31.255.1", true)]
        [InlineData("172.32.0.1", false)]
        [InlineData("127.0.0.1", true)]
        [InlineData("169.254.1.1", true)]
        [InlineData("8.8.8.8", false)]
        [InlineData("::1", true)]
        [InlineData("fe80::1", true)]
        [InlineData("fd12:3456::1", true)]
        [InlineData("2001:4860::8888", false)]
        [InlineData("::ffff:192.168.1.9", true)]
        [InlineData("::ffff:1.1.1.1", false)]
        public void OnlyHomeNetworkAddressesAreLocal(string ip, bool local) =>
            Assert.Equal(local, LanAddresses.IsLocal(IPAddress.Parse(ip)));

        [Fact]
        public void TheRealMachineGivesSomethingSensible()
        {
            var all = LanAddresses.All();   // may be empty on a machine with no network; must never throw
            Assert.All(all, c => Assert.True(IPAddress.TryParse(c.Address, out _)));
            Assert.False(LanAddresses.IsLocal(null));
        }
    }
}
