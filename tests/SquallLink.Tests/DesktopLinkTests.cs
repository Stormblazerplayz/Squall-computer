using System;
using System.Collections.Concurrent;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Tasks;
using Squall.Link.Pairing;
using Squall.Link.Updates;
using Xunit;

namespace Squall.Link.Tests
{
    public class DesktopLinkTests
    {
        private static JsonElement Args(string json) => JsonDocument.Parse(json).RootElement;

        private static SquallDesktopLink Make(TempDir dir) => new(
            new LinkOptions { Port = 0, LoopbackOnly = true, ComputerName = "Storm-PC", Folder = dir.Sub("link") },
            new UpdaterOptions { Folder = dir.Sub("updates"), InstallFolder = dir.Sub("install"), CurrentVersion = new Version(1, 0, 0), Http = new FakeGitHub() });

        [Fact]
        public async Task ThePairScreenGivesACodeAQrCodeAndAWorkingLink()
        {
            using var dir = new TempDir();
            await using var link = Make(dir);
            var posted = new ConcurrentQueue<JsonObject>();
            link.AttachPage(json => posted.Enqueue((JsonObject)JsonNode.Parse(json)!));
            Assert.True(await link.StartAsync(checkForUpdates: false));

            var hello = (JsonObject)(await link.HandlePageCommandAsync(Args("{\"do\":\"hello\"}")))!;
            Assert.True((bool)hello["running"]!);
            Assert.Empty((JsonArray)hello["phones"]!);

            var screen = (JsonObject)(await link.HandlePageCommandAsync(Args("{\"do\":\"pairOpen\"}")))!;
            Assert.True((bool)screen["ok"]!);
            string code = (string)screen["code"]!;
            Assert.Matches("^[0-9]{6}$", code);
            Assert.StartsWith("<svg", ((string)screen["qrSvg"]!).TrimStart());
            Assert.Equal(120, (int)screen["seconds"]!);
            var parts = PairingLink.Parse((string)screen["link"]!)!;
            Assert.Equal(code, parts["code"]);
            Assert.Equal("127.0.0.1", parts["host"]);
            Assert.Equal("Storm-PC", parts["name"]);
            Assert.True((bool)screen["listening"]!);

            // the phone pairs using exactly what the QR code says
            using var http = new HttpClient();
            string url = $"http://{parts["host"]}:{parts["port"]}/api/v1/pair";
            using var res = await http.PostAsync(url, new StringContent(
                "{\"code\":\"" + parts["code"] + "\",\"protocolVersion\":1,\"device\":{\"deviceId\":\"D1\",\"deviceName\":\"Storm's iPad\",\"platform\":\"iPadOS\"}}",
                Encoding.UTF8, "application/json"));
            Assert.Equal(HttpStatusCode.OK, res.StatusCode);

            Assert.False(link.Pairing.IsOpen);   // pairing closes the screen
            Assert.Contains(posted, m => (string?)m["event"] == "linkPaired" && (string?)m["deviceName"] == "Storm's iPad");
            Assert.Contains(posted, m => (string?)m["event"] == "linkPhones");

            var status = (JsonObject)(await link.HandlePageCommandAsync(Args("{\"do\":\"status\"}")))!;
            var phones = (JsonArray)status["phones"]!;
            Assert.Single(phones);
            Assert.Equal("D1", (string?)phones[0]!["deviceId"]);

            status = (JsonObject)(await link.HandlePageCommandAsync(Args("{\"do\":\"unpair\",\"deviceId\":\"D1\"}")))!;
            Assert.Empty((JsonArray)status["phones"]!);
        }

        [Fact]
        public async Task StateAndAnswersFlowThroughTheBridge()
        {
            using var dir = new TempDir();
            await using var link = Make(dir);
            string? rid = null;
            link.AttachPage(json =>
            {
                var m = (JsonObject)JsonNode.Parse(json)!;
                if ((string?)m["event"] == "linkAsk") rid = (string?)m["rid"];
            });
            var r = (JsonObject)(await link.HandlePageCommandAsync(Args("{\"do\":\"state\",\"data\":{\"version\":\"7\"}}")))!;
            Assert.True((bool)r["ok"]!);
            Assert.Contains("\"7\"", link.Page.State!.Value.Json);
            r = (JsonObject)(await link.HandlePageCommandAsync(Args("{\"do\":\"state\",\"data\":[]}")))!;
            Assert.False((bool)r["ok"]!);

            var ask = link.Page.AskAsync("action", new JsonObject { ["type"] = "chat.read" }, TimeSpan.FromSeconds(5));
            Assert.NotNull(rid);
            r = (JsonObject)(await link.HandlePageCommandAsync(Args("{\"do\":\"answer\",\"rid\":\"" + rid + "\",\"result\":{\"ok\":true}}")))!;
            Assert.True((bool)r["ok"]!);
            var answer = await ask;
            Assert.True(answer!.Value.GetProperty("ok").GetBoolean());
            r = (JsonObject)(await link.HandlePageCommandAsync(Args("{\"do\":\"answer\",\"rid\":\"" + rid + "\",\"result\":{\"ok\":true}}")))!;
            Assert.False((bool)r["ok"]!);   // already answered

            await Assert.ThrowsAsync<ArgumentException>(() => link.HandlePageCommandAsync(Args("{\"do\":\"explode\"}")));
            await Assert.ThrowsAsync<ArgumentException>(() => link.HandlePageCommandAsync(Args("[]")));
        }

        [Fact]
        public async Task NoUpdateMeansTheHostCarriesOn()
        {
            using var dir = new TempDir();
            await using var link = Make(dir);
            bool exited = false;
            link.RequestExit = () => exited = true;
            Assert.False(link.InstallUpdateIfReady());
            Assert.False(exited);
            var st = (JsonObject)(await link.HandlePageCommandAsync(Args("{\"do\":\"updateCheck\"}")))!;
            Assert.Equal("1.0.0", (string?)st["update"]!["current"]);
            Assert.Null(st["update"]!["ready"]);
            Assert.Contains("no Squall release", (string?)st["update"]!["status"]);
        }

        [Fact]
        public async Task ThePairScreenSaysWhyWhenThePortIsTaken()
        {
            using var dir = new TempDir();
            await using var first = Make(dir);
            Assert.True(await first.StartAsync(checkForUpdates: false));
            await using var second = new SquallDesktopLink(
                new LinkOptions { Port = first.Server.Port, LoopbackOnly = true, Folder = dir.Sub("link2") },
                new UpdaterOptions { Folder = dir.Sub("updates2"), Http = new FakeGitHub() });
            var screen = (JsonObject)(await second.HandlePageCommandAsync(Args("{\"do\":\"pairOpen\"}")))!;
            Assert.False((bool)screen["ok"]!);
            Assert.Contains("in use", (string?)screen["error"]);
            Assert.False(second.Pairing.IsOpen);
        }
    }
}
