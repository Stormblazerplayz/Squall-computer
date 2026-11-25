using System;
using System.Collections.Concurrent;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Tasks;
using Squall.Link.Pairing;
using Squall.Link.Server;
using Squall.Link.Updates;
using Squall.Link.Uno;
using Xunit;

namespace Squall.Link.Tests
{
    public sealed class UnoServerTests : IAsyncLifetime
    {
        private UnoRig _rig = null!;
        private LinkServer _server = null!;
        private PairingWindow _window = null!;
        private HttpClient _http = null!;
        private string _token = "";

        public async Task InitializeAsync()
        {
            // frames every 10 s here, so "nothing newer" can be checked without a new frame sneaking in
            _rig = new UnoRig(frameInterval: TimeSpan.FromSeconds(10));
            _window = new PairingWindow(TimeSpan.FromMinutes(2), 5, null, () => 482913);
            var phones = new PairedPhones(_rig.Dir.Sub("link"));
            _server = new LinkServer(new LinkOptions { Port = 0, LoopbackOnly = true, ComputerName = "Storm-PC" }, _window, phones, new PageRelay(), "computer-id-1", _rig.Hub);
            Assert.True(await _server.StartAsync(), _server.Error);
            _http = new HttpClient { BaseAddress = new Uri($"http://127.0.0.1:{_server.Port}") };
            _window.Open();
            using var res = await _http.PostAsync("/api/v1/pair", new StringContent("{\"code\":\"482913\",\"device\":{\"deviceId\":\"P1\",\"deviceName\":\"Storm's iPhone\"}}", Encoding.UTF8, "application/json"));
            _token = (string)JsonNode.Parse(await res.Content.ReadAsStringAsync())!["token"]!;
        }

        public async Task DisposeAsync()
        {
            _http.Dispose();
            await _server.DisposeAsync();
            await _rig.DisposeAsync();
        }

        private async Task<(HttpStatusCode Status, JsonObject? Body)> Op(string body, string? token)
        {
            using var req = new HttpRequestMessage(HttpMethod.Post, "/api/v1/uno") { Content = new StringContent(body, Encoding.UTF8, "application/json") };
            if (token != null) req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            using var res = await _http.SendAsync(req);
            string text = await res.Content.ReadAsStringAsync();
            return (res.StatusCode, text.Length > 0 ? JsonNode.Parse(text) as JsonObject : null);
        }

        private async Task<HttpResponseMessage> Frame(string query, string? token)
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, "/api/v1/uno/frame" + query);
            if (token != null) req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            return await _http.SendAsync(req);
        }

        [Fact]
        public async Task OpsNeedThePhonesToken()
        {
            var (status, body) = await Op("{\"op\":\"state\"}", null);
            Assert.Equal(HttpStatusCode.Unauthorized, status);
            Assert.Equal("unknown_token", (string?)body!["error"]);
            Assert.Equal(HttpStatusCode.Unauthorized, (await Op("{\"op\":\"state\"}", "wrong")).Status);
            using (var f = await Frame("?computer=pc-chief&after=0", null)) Assert.Equal(HttpStatusCode.Unauthorized, f.StatusCode);
            using (var get = await _http.GetAsync("/api/v1/uno")) Assert.Equal(HttpStatusCode.MethodNotAllowed, get.StatusCode);

            (status, body) = await Op("{\"op\":\"state\",\"since\":0}", _token);
            Assert.Equal(HttpStatusCode.OK, status);
            Assert.True((bool)body!["ok"]!);
            Assert.True((bool)body["settings"]!["hasKey"]!);
            Assert.DoesNotContain(UnoRig.Key, body.ToJsonString());

            (status, body) = await Op("not json", _token);
            Assert.Equal(HttpStatusCode.BadRequest, status);
            Assert.False((bool)body!["ok"]!);
            (status, body) = await Op("{\"op\":\"watch\",\"computerId\":\"pc-chief\"}", _token);
            Assert.Equal(HttpStatusCode.OK, status);
            Assert.False((bool)body!["ok"]!);   // watching is for the window; the phone polls frames

            // a normal-size task goes through (the body limit is LinkOptions.MaxBodyBytes)
            (status, body) = await Op("{\"op\":\"start\",\"agentId\":\"chief\",\"task\":\"" + new string('a', 3900) + "\"}", _token);
            Assert.Equal(HttpStatusCode.OK, status);
            Assert.True((bool)body!["ok"]!, body.ToJsonString());
        }

        [Fact]
        public async Task FramesComeAsJpegsWithHeaders()
        {
            using (var off = await Frame("?computer=pc-chief&after=0", _token))
            {
                Assert.Equal(HttpStatusCode.NotFound, off.StatusCode);
                Assert.Equal("no_computer", (string?)JsonNode.Parse(await off.Content.ReadAsStringAsync())!["error"]);
            }

            var (_, started) = await Op("{\"op\":\"start\",\"agentId\":\"chief\",\"agentName\":\"Chief\",\"task\":\"Look around\"}", _token);
            string sid = (string)started!["sessionId"]!;
            await Wait.Until(() => _rig.Model.Count == 1, "the session to start");   // the model "thinks" until stopped

            HttpResponseMessage? res = null;
            await Wait.Until(() =>
            {
                res?.Dispose();
                res = Frame("?computer=pc-chief&after=0", _token).GetAwaiter().GetResult();
                return res.StatusCode == HttpStatusCode.OK;
            }, "a frame");
            using (res)
            {
                Assert.Equal("image/jpeg", res!.Content.Headers.ContentType!.MediaType);
                Assert.Equal(FakeDocker.Jpeg, await res.Content.ReadAsByteArrayAsync());
                long seq = long.Parse(res.Headers.GetValues("X-Uno-Frame").Single());
                Assert.True(seq > 0);
                Assert.Equal("1280", res.Headers.GetValues("X-Uno-Width").Single());
                Assert.Equal("800", res.Headers.GetValues("X-Uno-Height").Single());
                Assert.Equal("10,20", res.Headers.GetValues("X-Uno-Cursor").Single());

                using var same = await Frame("?computer=pc-chief&after=" + seq, _token);
                Assert.Equal(HttpStatusCode.NoContent, same.StatusCode);
                Assert.Empty(await same.Content.ReadAsByteArrayAsync());
            }

            var (_, stopped) = await Op("{\"op\":\"stop\",\"sessionId\":\"" + sid + "\"}", _token);
            Assert.True((bool)stopped!["ok"]!);
        }
    }

    public class UnoDesktopLinkTests
    {
        [Fact]
        public async Task TheWindowGetsPushesWithoutAnEventKeyClash()
        {
            using var dir = new TempDir();
            var docker = new FakeDocker();
            var model = new FakeModel();
            await using var link = new SquallDesktopLink(
                new LinkOptions { Port = 0, LoopbackOnly = true, ComputerName = "Storm-PC", Folder = dir.Sub("link") },
                new UpdaterOptions { Folder = dir.Sub("updates"), InstallFolder = dir.Sub("install"), CurrentVersion = new Version(1, 0, 0), Http = new FakeGitHub() },
                new UnoHubOptions { Runner = docker, Model = model, EnvKey = () => null, ComputerReadyPoll = TimeSpan.FromMilliseconds(1) });
            var posted = new ConcurrentQueue<JsonObject>();
            link.AttachPage(json => posted.Enqueue((JsonObject)JsonNode.Parse(json)!));

            const string key = "sk-ant-api03-PAGEKEY-abcdefghijklmnopqrstuvwxyz-P4p4";
            var saved = (JsonObject)(await link.HandlePageCommandAsync(JsonDocument.Parse("{\"do\":\"uno\",\"op\":\"saveKey\",\"key\":\"" + key + "\"}").RootElement))!;
            Assert.True((bool)saved["ok"]!);
            var state = posted.Last(m => (string?)m["event"] == "unoState");
            Assert.True((bool)state["settings"]!["hasKey"]!);
            Assert.NotNull(state["computers"]);
            Assert.NotNull(state["sessions"]);

            model.Reply("end_turn", FakeModel.Text("Hello!"));
            var started = (JsonObject)(await link.HandlePageCommandAsync(JsonDocument.Parse("{\"do\":\"uno\",\"op\":\"start\",\"agentId\":\"chief\",\"agentName\":\"Chief\",\"task\":\"Say hello\"}").RootElement))!;
            Assert.True((bool)started["ok"]!, started.ToJsonString());
            await link.Uno.RunTask((string)started["sessionId"]!);

            var unoPushes = posted.Where(m => (string?)m["event"] == "uno").ToList();
            Assert.Equal(new[] { "start", "say", "done" }, unoPushes.Select(m => (string)m["ev"]!["kind"]!));
            Assert.Equal("Hello!", (string?)unoPushes[1]["ev"]!["text"]);

            Assert.True((bool)(await link.HandlePageCommandAsync(JsonDocument.Parse("{\"do\":\"uno\",\"op\":\"watch\",\"computerId\":\"pc-chief\"}").RootElement))!["ok"]!);
            await Wait.Until(() => posted.Any(m => (string?)m["event"] == "unoFrame"), "a frame push");
            var frame = posted.First(m => (string?)m["event"] == "unoFrame");
            Assert.Equal("pc-chief", (string?)frame["computerId"]);
            Assert.Equal(Convert.ToBase64String(FakeDocker.Jpeg), (string?)frame["jpeg"]);
            Assert.Equal(1280, (int)frame["width"]!);

            Assert.All(posted, m => Assert.DoesNotContain(key, m.ToJsonString()));
        }
    }
}
