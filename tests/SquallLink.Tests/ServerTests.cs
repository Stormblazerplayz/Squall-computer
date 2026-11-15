using System;
using System.Collections.Concurrent;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using Squall.Link.Pairing;
using Squall.Link.Server;
using Xunit;

namespace Squall.Link.Tests
{
    /// <summary>
    /// Stands in for the Squall window in tests: it answers the server's asks the way web/link.js does.
    /// The answers here are test fixtures, not data the real app ever shows.
    /// </summary>
    internal sealed class FakePage
    {
        public readonly ConcurrentQueue<JsonObject> Asks = new();
        public Func<string, JsonObject, JsonNode?> Reply = (_, _) => new JsonObject { ["ok"] = true };
        private readonly PageRelay _relay;

        public FakePage(PageRelay relay)
        {
            _relay = relay;
            relay.Attach(Post);
        }

        private void Post(string json)
        {
            var msg = (JsonObject)JsonNode.Parse(json)!;
            if ((string?)msg["event"] != "linkAsk") return;
            Asks.Enqueue(msg);
            string rid = (string)msg["rid"]!;
            string kind = (string)msg["kind"]!;
            var body = (JsonObject)msg["body"]!;
            _ = Task.Run(() =>
            {
                var answer = Reply(kind, body);
                if (answer != null && rid.Length > 0)
                    _relay.Answer(rid, JsonDocument.Parse(answer.ToJsonString()).RootElement);
            });
        }
    }

    public sealed class ServerTests : IAsyncLifetime
    {
        private readonly TempDir _dir = new();
        private DateTimeOffset _now = DateTimeOffset.UtcNow;
        private PairingWindow _window = null!;
        private PairedPhones _phones = null!;
        private PageRelay _relay = null!;
        private LinkServer _server = null!;
        private HttpClient _http = null!;
        private readonly LinkOptions _o = new()
        {
            Port = 0, LoopbackOnly = true, ComputerName = "Storm-PC",
            ActionTimeout = TimeSpan.FromSeconds(2), VoiceTimeout = TimeSpan.FromSeconds(2), StateMaxAge = TimeSpan.FromSeconds(15),
        };

        public async Task InitializeAsync()
        {
            _window = new PairingWindow(TimeSpan.FromMinutes(2), 5, () => _now, () => 482913);
            _phones = new PairedPhones(_dir.Path);
            _relay = new PageRelay(() => _now);
            _server = new LinkServer(_o, _window, _phones, _relay, "computer-id-1");
            Assert.True(await _server.StartAsync(), _server.Error);
            Assert.True(_server.Port > 0);
            _http = new HttpClient { BaseAddress = new Uri($"http://127.0.0.1:{_server.Port}") };
        }

        public async Task DisposeAsync()
        {
            _http.Dispose();
            await _server.DisposeAsync();
            _dir.Dispose();
        }

        private static StringContent Json(string s) => new(s, Encoding.UTF8, "application/json");

        private const string PairBody = "{\"code\":\"482913\",\"protocolVersion\":1,\"device\":{\"deviceId\":\"6F1C\",\"deviceName\":\"Storm's iPad\",\"platform\":\"iPadOS\",\"systemVersion\":\"18.1\",\"appVersion\":\"0.1.0\"}}";

        private async Task<(HttpStatusCode Status, JsonNode? Body)> Call(HttpMethod method, string path, string? body = null, string? token = null)
        {
            using var req = new HttpRequestMessage(method, path);
            if (body != null) req.Content = Json(body);
            if (token != null) req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            using var res = await _http.SendAsync(req);
            string text = await res.Content.ReadAsStringAsync();
            return (res.StatusCode, text.Length > 0 && res.Content.Headers.ContentType?.MediaType == "application/json" ? JsonNode.Parse(text) : null);
        }

        private async Task<string> PairPhone()
        {
            _window.Open();
            var (status, body) = await Call(HttpMethod.Post, "/api/v1/pair", PairBody);
            Assert.Equal(HttpStatusCode.OK, status);
            return (string)body!["token"]!;
        }

        [Fact]
        public async Task PairingFollowsTheContract()
        {
            var r = await Call(HttpMethod.Post, "/api/v1/pair", PairBody);
            Assert.Equal(HttpStatusCode.Conflict, r.Status);
            Assert.Equal("not_listening", (string?)r.Body!["error"]);

            PairedPhone? seen = null;
            _server.Paired += p => seen = p;
            _window.Open();
            r = await Call(HttpMethod.Post, "/api/v1/pair", PairBody.Replace("482913", "000000"));
            Assert.Equal(HttpStatusCode.Unauthorized, r.Status);
            Assert.Equal("wrong_code", (string?)r.Body!["error"]);

            r = await Call(HttpMethod.Post, "/api/v1/pair", PairBody);
            Assert.Equal(HttpStatusCode.OK, r.Status);
            string token = (string)r.Body!["token"]!;
            Assert.True(token.Length >= 43);
            Assert.Equal("computer-id-1", (string?)r.Body["computerId"]);
            Assert.Equal("Storm-PC", (string?)r.Body["computerName"]);
            Assert.Equal(1, (int)r.Body["protocolVersion"]!);
            Assert.Equal("Storm's iPad", seen!.Device.DeviceName);
            Assert.Equal("Storm's iPad", _phones.Find(token)!.Device.DeviceName);

            r = await Call(HttpMethod.Post, "/api/v1/pair", PairBody);   // the code is used up
            Assert.Equal(HttpStatusCode.Conflict, r.Status);
        }

        [Fact]
        public async Task NumericCodesWorkToo()
        {
            _window.Open();
            var r = await Call(HttpMethod.Post, "/api/v1/pair", "{\"code\":482913,\"device\":{}}");
            Assert.Equal(HttpStatusCode.OK, r.Status);
        }

        [Fact]
        public async Task ExpiredAndTooManyTries()
        {
            _window.Open();
            _now += TimeSpan.FromMinutes(3);
            var r = await Call(HttpMethod.Post, "/api/v1/pair", PairBody);
            Assert.Equal(HttpStatusCode.Gone, r.Status);
            Assert.Equal("code_expired", (string?)r.Body!["error"]);

            _window.Open();
            for (int i = 0; i < 4; i++)
                Assert.Equal(HttpStatusCode.Unauthorized, (await Call(HttpMethod.Post, "/api/v1/pair", PairBody.Replace("482913", "11111" + i))).Status);
            r = await Call(HttpMethod.Post, "/api/v1/pair", PairBody.Replace("482913", "999999"));
            Assert.Equal((HttpStatusCode)429, r.Status);
            Assert.Equal("too_many_tries", (string?)r.Body!["error"]);
            r = await Call(HttpMethod.Post, "/api/v1/pair", PairBody);
            Assert.Equal((HttpStatusCode)429, r.Status);
        }

        [Fact]
        public async Task BadBodiesAreRefused()
        {
            _window.Open();
            Assert.Equal(HttpStatusCode.BadRequest, (await Call(HttpMethod.Post, "/api/v1/pair", "not json")).Status);
            Assert.Equal(HttpStatusCode.BadRequest, (await Call(HttpMethod.Post, "/api/v1/pair", "[1,2]")).Status);
            Assert.Equal(HttpStatusCode.BadRequest, (await Call(HttpMethod.Post, "/api/v1/pair", "")).Status);
            // a body over the limit
            var big = "{\"code\":\"" + new string('1', 1_100_000) + "\"}";
            var status = (await Call(HttpMethod.Post, "/api/v1/pair", big)).Status;
            Assert.Equal((HttpStatusCode)413, status);
        }

        [Fact]
        public async Task HelloAndUnpair()
        {
            string token = await PairPhone();
            var r = await Call(HttpMethod.Get, "/api/v1/hello", token: token);
            Assert.Equal(HttpStatusCode.OK, r.Status);
            Assert.Equal("Storm-PC", (string?)r.Body!["computerName"]);
            Assert.Equal(1, (int)r.Body["protocolVersion"]!);

            Assert.Equal(HttpStatusCode.Unauthorized, (await Call(HttpMethod.Get, "/api/v1/hello")).Status);
            r = await Call(HttpMethod.Get, "/api/v1/hello", token: "wrong");
            Assert.Equal(HttpStatusCode.Unauthorized, r.Status);
            Assert.Equal("unknown_token", (string?)r.Body!["error"]);

            Assert.Equal(HttpStatusCode.NoContent, (await Call(HttpMethod.Delete, "/api/v1/pair", token: token)).Status);
            Assert.Equal(HttpStatusCode.Unauthorized, (await Call(HttpMethod.Get, "/api/v1/hello", token: token)).Status);
            Assert.Equal(HttpStatusCode.Unauthorized, (await Call(HttpMethod.Delete, "/api/v1/pair", token: token)).Status);
        }

        [Fact]
        public async Task StateComesOnlyFromTheSquallWindow()
        {
            string token = await PairPhone();
            Assert.Equal(HttpStatusCode.Unauthorized, (await Call(HttpMethod.Get, "/api/v1/state")).Status);

            var r = await Call(HttpMethod.Get, "/api/v1/state", token: token);
            Assert.Equal(HttpStatusCode.NotImplemented, r.Status);   // no window attached: the phone says to update Squall

            _ = new FakePage(_relay);
            r = await Call(HttpMethod.Get, "/api/v1/state", token: token);
            Assert.Equal(HttpStatusCode.ServiceUnavailable, r.Status);   // attached, but nothing sent yet

            Assert.True(_relay.SetState(JsonDocument.Parse("{\"version\":\"v1\",\"bots\":[{\"id\":\"chief\",\"name\":\"Chief\"}]}").RootElement));
            r = await Call(HttpMethod.Get, "/api/v1/state", token: token);
            Assert.Equal(HttpStatusCode.OK, r.Status);
            Assert.Equal("v1", (string?)r.Body!["version"]);
            Assert.Equal("chief", (string?)r.Body["bots"]![0]!["id"]);

            _now += TimeSpan.FromSeconds(20);   // the window stopped sending
            Assert.Equal(HttpStatusCode.ServiceUnavailable, (await Call(HttpMethod.Get, "/api/v1/state", token: token)).Status);
            Assert.False(_relay.SetState(JsonDocument.Parse("[1]").RootElement));
        }

        [Fact]
        public async Task ActionsGoToTheWindowOnceEach()
        {
            string token = await PairPhone();
            const string act = "{\"type\":\"chat.send\",\"id\":\"A1\",\"chatId\":\"chief\",\"text\":\"Hi\"}";
            var r = await Call(HttpMethod.Post, "/api/v1/action", act, token);
            Assert.Equal(HttpStatusCode.NotImplemented, r.Status);
            Assert.False((bool)r.Body!["ok"]!);

            var page = new FakePage(_relay);
            int calls = 0;
            page.Reply = (kind, body) =>
            {
                Interlocked.Increment(ref calls);
                Assert.Equal("action", kind);
                return (string?)body["type"] == "bot.create"
                    ? new JsonObject { ["ok"] = true, ["id"] = "new-bot" }
                    : new JsonObject { ["ok"] = true };
            };
            r = await Call(HttpMethod.Post, "/api/v1/action", act, token);
            Assert.Equal(HttpStatusCode.OK, r.Status);
            Assert.True((bool)r.Body!["ok"]!);
            r = await Call(HttpMethod.Post, "/api/v1/action", act, token);   // the same id again: not done twice
            Assert.True((bool)r.Body!["ok"]!);
            Assert.Equal(1, calls);
            var ask = page.Asks.Single();
            Assert.Equal("chief", (string?)ask["body"]!["chatId"]);
            Assert.Equal("Storm's iPad", (string?)ask["body"]!["phone"]);

            r = await Call(HttpMethod.Post, "/api/v1/action", "{\"type\":\"bot.create\",\"id\":\"A2\",\"name\":\"Zip\"}", token);
            Assert.Equal("new-bot", (string?)r.Body!["id"]);
            Assert.Equal(2, calls);

            page.Reply = (_, _) => new JsonObject { ["ok"] = false };
            r = await Call(HttpMethod.Post, "/api/v1/action", "{\"type\":\"chief.wake\",\"id\":\"A3\"}", token);
            Assert.False((bool)r.Body!["ok"]!);
            Assert.False(string.IsNullOrEmpty((string?)r.Body["error"]));

            page.Reply = (_, _) => new JsonObject { ["weird"] = 1 };
            r = await Call(HttpMethod.Post, "/api/v1/action", "{\"type\":\"chief.wake\",\"id\":\"A4\"}", token);
            Assert.False((bool)r.Body!["ok"]!);

            page.Reply = (_, _) => null;   // the window never answers
            r = await Call(HttpMethod.Post, "/api/v1/action", "{\"type\":\"chief.nap\",\"id\":\"A5\"}", token);
            Assert.Equal(HttpStatusCode.OK, r.Status);
            Assert.False((bool)r.Body!["ok"]!);
            Assert.Contains("didn't answer", (string?)r.Body["error"]);

            Assert.Equal(HttpStatusCode.BadRequest, (await Call(HttpMethod.Post, "/api/v1/action", "{\"id\":\"x\"}", token)).Status);
            Assert.Equal(HttpStatusCode.Unauthorized, (await Call(HttpMethod.Post, "/api/v1/action", act, "bad")).Status);
            Assert.Equal(0, _relay.Waiting);
        }

        [Fact]
        public async Task VoiceTurnsAskChiefThroughTheWindow()
        {
            string token = await PairPhone();
            const string turn = "{\"callId\":\"C1\",\"event\":\"turn\",\"turn\":1,\"bot\":\"chief\",\"text\":\"What's up?\",\"locale\":\"en_US\",\"wantsAudio\":true}";
            Assert.Equal(HttpStatusCode.NotImplemented, (await Call(HttpMethod.Post, "/api/v1/voice/turn", turn, token)).Status);

            var page = new FakePage(_relay);
            page.Reply = (kind, body) => kind == "voice"
                ? new JsonObject { ["text"] = "Echo: " + (string?)body["text"], ["endCall"] = false }
                : null;
            var r = await Call(HttpMethod.Post, "/api/v1/voice/turn", turn, token);
            Assert.Equal(HttpStatusCode.OK, r.Status);
            Assert.Equal("Echo: What's up?", (string?)r.Body!["text"]);
            Assert.False((bool)r.Body["endCall"]!);
            Assert.Null(r.Body["audio"]);

            page.Reply = (_, _) => new JsonObject { ["text"] = "Bye!", ["endCall"] = true, ["audio"] = new JsonObject { ["format"] = "mp3", ["base64"] = "AAAA" } };
            r = await Call(HttpMethod.Post, "/api/v1/voice/turn", turn, token);
            Assert.True((bool)r.Body!["endCall"]!);
            Assert.Equal("mp3", (string?)r.Body["audio"]!["format"]);

            page.Reply = (_, _) => new JsonObject { ["error"] = "busy" };
            Assert.Equal(HttpStatusCode.Conflict, (await Call(HttpMethod.Post, "/api/v1/voice/turn", turn, token)).Status);

            page.Reply = (_, _) => null;
            Assert.Equal(HttpStatusCode.ServiceUnavailable, (await Call(HttpMethod.Post, "/api/v1/voice/turn", turn, token)).Status);

            page.Reply = (_, _) => null;
            Assert.Equal(HttpStatusCode.NoContent, (await Call(HttpMethod.Post, "/api/v1/voice/end", "{\"callId\":\"C1\",\"seconds\":42}", token)).Status);
            Assert.Contains(page.Asks, a => (string?)a["kind"] == "voiceEnd" && (int)a["body"]!["seconds"]! == 42);
            Assert.Equal(HttpStatusCode.Unauthorized, (await Call(HttpMethod.Post, "/api/v1/voice/end", "{}", "bad")).Status);
        }

        [Fact]
        public async Task OtherPathsAndMethods()
        {
            using (var res = await _http.GetAsync("/"))
            {
                Assert.Equal(HttpStatusCode.OK, res.StatusCode);
                Assert.Contains("Squall", await res.Content.ReadAsStringAsync());
            }
            Assert.Equal(HttpStatusCode.NotFound, (await Call(HttpMethod.Get, "/api/v2/hello")).Status);
            Assert.Equal(HttpStatusCode.MethodNotAllowed, (await Call(HttpMethod.Get, "/api/v1/pair")).Status);
            Assert.Equal(HttpStatusCode.MethodNotAllowed, (await Call(HttpMethod.Post, "/api/v1/hello", "{}")).Status);
            Assert.Equal(HttpStatusCode.MethodNotAllowed, (await Call(HttpMethod.Get, "/api/v1/action")).Status);
            // a trailing slash is fine
            string token = await PairPhone();
            Assert.Equal(HttpStatusCode.OK, (await Call(HttpMethod.Get, "/api/v1/hello/", token: token)).Status);
        }

        [Fact]
        public async Task StopAndStartAgain()
        {
            await _server.StopAsync();
            Assert.False(_server.Running);
            await _server.StopAsync();   // twice is fine
            Assert.True(await _server.StartAsync());
            Assert.True(_server.Running);
        }

        [Fact]
        public async Task ABusyPortGivesAPlainError()
        {
            var o = new LinkOptions { Port = _server.Port, LoopbackOnly = true };
            await using var second = new LinkServer(o, _window, _phones, _relay, "x");
            Assert.False(await second.StartAsync());
            Assert.Contains("in use", second.Error);
            Assert.False(second.Running);
        }
    }
}
