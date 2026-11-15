using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;

namespace Squall.Link.Pairing
{
    /// <summary>One IPv4 address this computer has, with what's known about its network adapter.</summary>
    public sealed record LanCandidate(string Address, string AdapterName, string Description, NetworkInterfaceType Type, bool HasGateway);

    /// <summary>
    /// Finds the address the phone should use: the home Wi-Fi or Ethernet address, not a VPN, WSL, Hyper-V,
    /// VirtualBox or VMware adapter, and not a self-assigned 169.254 address.
    /// </summary>
    public static class LanAddresses
    {
        private static readonly string[] VirtualWords =
        {
            "virtual", "vmware", "virtualbox", "hyper-v", "vethernet", "wsl", "docker", "loopback", "bluetooth",
            "tap-", "tap ", "tun", "vpn", "wireguard", "tailscale", "zerotier", "hamachi", "npcap", "teredo", "isatap",
        };

        /// <summary>Every usable IPv4 address, best first.</summary>
        public static IReadOnlyList<LanCandidate> All()
        {
            var list = new List<LanCandidate>();
            NetworkInterface[] nics;
            try { nics = NetworkInterface.GetAllNetworkInterfaces(); }
            catch (NetworkInformationException) { return list; }
            foreach (var nic in nics)
            {
                try
                {
                    if (nic.OperationalStatus != OperationalStatus.Up) continue;
                    var props = nic.GetIPProperties();
                    bool gateway = props.GatewayAddresses.Any(g => g.Address.AddressFamily == AddressFamily.InterNetwork && !g.Address.Equals(IPAddress.Any));
                    foreach (var ua in props.UnicastAddresses)
                        if (ua.Address.AddressFamily == AddressFamily.InterNetwork)
                            list.Add(new LanCandidate(ua.Address.ToString(), nic.Name ?? "", nic.Description ?? "", nic.NetworkInterfaceType, gateway));
                }
                catch (Exception) { }
            }
            return Rank(list);
        }

        /// <summary>The best address for the QR code, or null when this computer isn't on a network.</summary>
        public static string? Best() => All().FirstOrDefault()?.Address;

        /// <summary>Sorts candidates best first and drops the ones a phone can't use.</summary>
        public static IReadOnlyList<LanCandidate> Rank(IEnumerable<LanCandidate> candidates) =>
            candidates.Where(c => Score(c) > int.MinValue)
                      .OrderByDescending(Score)
                      .ThenBy(c => c.Address, StringComparer.Ordinal)
                      .ToList();

        /// <summary>How likely this is the home network the phone is on. int.MinValue means never use it.</summary>
        public static int Score(LanCandidate c)
        {
            if (!IPAddress.TryParse(c.Address, out var ip) || ip.AddressFamily != AddressFamily.InterNetwork) return int.MinValue;
            if (IPAddress.IsLoopback(ip) || c.Type is NetworkInterfaceType.Loopback or NetworkInterfaceType.Tunnel) return int.MinValue;
            byte[] b = ip.GetAddressBytes();
            if (b[0] == 169 && b[1] == 254) return int.MinValue;   // self-assigned: no network
            if (b[0] == 0 || b[0] >= 224) return int.MinValue;

            int score = 0;
            if (c.HasGateway) score += 40;
            if (b[0] == 192 && b[1] == 168) score += 30;
            else if (b[0] == 10) score += 20;
            else if (b[0] == 172 && b[1] >= 16 && b[1] <= 31) score += 15;
            else if (b[0] == 100 && b[1] >= 64 && b[1] <= 127) score -= 30;   // carrier-grade NAT, often a VPN
            else score -= 10;                                                   // a public address: rare at home
            if (c.Type == NetworkInterfaceType.Wireless80211) score += 12;
            else if (c.Type is NetworkInterfaceType.Ethernet or NetworkInterfaceType.GigabitEthernet or NetworkInterfaceType.FastEthernetT or NetworkInterfaceType.FastEthernetFx) score += 10;
            string words = (c.AdapterName + " " + c.Description).ToLowerInvariant();
            if (VirtualWords.Any(w => words.Contains(w))) score -= 60;
            return score;
        }

        /// <summary>
        /// True for addresses on the home network or this computer: private IPv4 ranges, link-local, loopback, and
        /// IPv6 unique-local and link-local. The phone API answers only these.
        /// </summary>
        public static bool IsLocal(IPAddress? ip)
        {
            if (ip == null) return false;
            if (ip.IsIPv4MappedToIPv6) ip = ip.MapToIPv4();
            if (IPAddress.IsLoopback(ip)) return true;
            if (ip.AddressFamily == AddressFamily.InterNetwork)
            {
                byte[] b = ip.GetAddressBytes();
                return b[0] == 10 || (b[0] == 172 && b[1] >= 16 && b[1] <= 31) || (b[0] == 192 && b[1] == 168) || (b[0] == 169 && b[1] == 254);
            }
            if (ip.AddressFamily == AddressFamily.InterNetworkV6)
            {
                if (ip.IsIPv6LinkLocal || ip.IsIPv6SiteLocal) return true;
                byte first = ip.GetAddressBytes()[0];
                return (first & 0xFE) == 0xFC;   // fc00::/7 unique local
            }
            return false;
        }
    }
}
