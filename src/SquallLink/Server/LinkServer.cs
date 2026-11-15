using System;
using System.Collections.Concurrent;
using System.IO;
using System.Linq;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using Squall.Link.Pairing;

namespace Squall.Link.Server
{
    /// <summary>
    /// The phone API from Squall-mobile docs/pairing.md, version 1:
    ///   POST /api/v1/pair, GET /api/v1/hello, DELETE /api/v1/pair,
    ///   GET /api/v1/state, POST /api/v1/action, POST /api/v1/voice/turn, POST /api/v1/voice/end.
    /// Plain HTTP on the home network only; every call but pairing needs the phone's token.
    /// State, actions and voice come from the Squall window through <see cref="PageRelay"/>; nothing is made up here.
    /// </summary>
    public sealed class LinkServer : IAsyncDisposable
    {
        private readonly LinkOptions _o;
        private readonly PairingWindow _window;
        private readonly PairedPhones _phones;
        private readonly PageRelay _page;
        private readonly string _computerId;
        private readonly ConcurrentDictionary<string, (DateTimeOffset At, Lazy<Task<JsonObject>> Result)> _actions = new();
        private WebApplication? _app;
        private readonly SemaphoreSlim _gate = new(1, 1);

        /// <summary>Raised (on a server thread) when a phone pairs.</summary>
        public event Action<PairedPhone>? Paired;

        public LinkServer(LinkOptions options, PairingWindow window, PairedPhones phones, PageRelay page, string computerId)
        {
            _o = options;
            _window = window;
            _phones = phones;
            _page = page;
            _computerId = computerId;
        }

        public bool Running => _app != null;
        /// <summary>The port it really listens on (useful when Port is 0 in tests).</summary>
        public int Port { get; private set; }
        /// <summary>Why it couldn't start ("port 47615 is in use"), or "".</summary>
        public string Error { get; private set; } = "";

        public async Task<bool> StartAsync()
        {
            await _gate.WaitAsync().ConfigureAwait(false);
            try
            {
                if (_app != null) return true;
                Error = "";
                var builder = WebApplication.CreateSlimBuilder(new WebApplicationOptions { Args = Array.Empty<string>(), ContentRootPath = AppContext.BaseDirectory });
                builder.Logging.ClearProviders();
                builder.WebHost.ConfigureKestrel(k =>
                {
                    k.AddServerHeader = false;
                    k.Limits.MaxRequestBodySize = _o.MaxBodyBytes;
                    k.Limits.RequestHeadersTimeout = TimeSpan.FromSeconds(15);
                    if (_o.LoopbackOnly) k.Listen(IPAddress.Loopback, _o.Port);
                    else k.ListenAnyIP(_o.Port);
                });
                var app = builder.Build();
                app.Run(HandleAsync);
                try { await app.StartAsync().ConfigureAwait(false); }
                catch (Exception ex)
                {
                    Error = ex is IOException || ex.InnerException is IOException || ex.Message.Contains("address already in use", StringComparison.OrdinalIgnoreCase)
                        ? $"Port {_o.Port} is in use by another program."
                        : "The phone link couldn't start: " + ex.Message;
                    await app.DisposeAsync().ConfigureAwait(false);
                    return false;
                }
                var addresses = app.Services.GetService(typeof(IServer)) is IServer server ? server.Features.Get<IServerAddressesFeature>()?.Addresses : null;
                Port = _o.Port;
                if (addresses != null)
                    foreach (var a in addresses)
                        if (Uri.TryCreate(a.Replace("[::]", "localhost").Replace("+", "localhost").Replace("*", "localhost"), UriKind.Absolute, out var u)) { Port = u.Port; break; }
                _app = app;
                return true;
            }
            finally { _gate.Release(); }
        }

        public async Task StopAsync()
        {
            await _gate.WaitAsync().ConfigureAwait(false);
            try
            {
                var app = _app;
                _app = null;
                if (app != null)
                {
                    try
                    {
                        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(3));
                        await app.StopAsync(cts.Token).ConfigureAwait(false);
                    }
                    catch (Exception) { }
                    await app.DisposeAsync().ConfigureAwait(false);
                }
            }
            finally { _gate.Release(); }
        }

        public ValueTask DisposeAsync() => new(StopAsync());

        // ===================================================================== Routing

        private async Task HandleAsync(HttpContext ctx)
        {
            var req = ctx.Request;
            if (!LanAddresses.IsLocal(ctx.Connection.RemoteIpAddress))
            {
                await Send(ctx, 403, new JsonObject { ["error"] = "local_only" });
                return;
            }
            string path = (req.Path.Value ?? "/").TrimEnd('/');
            string method = req.Method.ToUpperInvariant();
            try
            {
                switch (path)
                {
                    case "":
                        if (method != "GET") { await NotAllowed(ctx); return; }
                        ctx.Response.ContentType = "text/plain; charset=utf-8";
                        await ctx.Response.WriteAsync("Squall phone link. Open the Squall app on your iPhone or iPad and pair from there.\n");
                        return;
                    case "/api/v1/pair":
                        if (method == "POST") await Pair(ctx);
                        else if (method == "DELETE") await Unpair(ctx);
                        else await NotAllowed(ctx);
                        return;
                    case "/api/v1/hello":
                        if (method != "GET") { await NotAllowed(ctx); return; }
                        if (Phone(ctx) == null) { await Unknown(ctx); return; }
                        await Send(ctx, 200, new JsonObject { ["computerName"] = _o.ComputerName, ["protocolVersion"] = PairingLink.ProtocolVersion });
                        return;
                    case "/api/v1/state":
                        if (method != "GET") { await NotAllowed(ctx); return; }
                        await State(ctx);
                        return;
                    case "/api/v1/action":
                        if (method != "POST") { await NotAllowed(ctx); return; }
                        await Action(ctx);
                        return;
                    case "/api/v1/voice/turn":
                        if (method != "POST") { await NotAllowed(ctx); return; }
                        await VoiceTurn(ctx);
                        return;
                    case "/api/v1/voice/end":
                        if (method != "POST") { await NotAllowed(ctx); return; }
                        await VoiceEnd(ctx);
                        return;
                    default:
                        await Send(ctx, 404, new JsonObject { ["error"] = "not_found" });
                        return;
                }
            }
            catch (BadHttpRequestException)
            {
                if (!ctx.Response.HasStarted) await Send(ctx, 413, new JsonObject { ["error"] = "too_big" });
            }
        }

        // ===================================================================== Pairing

        private async Task Pair(HttpContext ctx)
        {
            var body = await ReadJson(ctx);
            if (body is not JsonObject o) { await Send(ctx, 400, new JsonObject { ["error"] = "bad_json" }); return; }
            string code = o["code"] is JsonValue cv ? cv.ToString() : "";
            switch (_window.Try(code))
            {
                case CodeCheck.NotListening: await Send(ctx, 409, new JsonObject { ["error"] = "not_listening" }); return;
                case CodeCheck.Expired: await Send(ctx, 410, new JsonObject { ["error"] = "code_expired" }); return;
                case CodeCheck.TooManyTries: await Send(ctx, 429, new JsonObject { ["error"] = "too_many_tries" }); return;
                case CodeCheck.Wrong: await Send(ctx, 401, new JsonObject { ["error"] = "wrong_code" }); return;
            }
            var device = PhoneInfo.From(o["device"] as JsonObject);
            string token = _phones.Add(device);
            var paired = _phones.Find(token);
            if (paired != null)
            {
                try { Paired?.Invoke(paired); } catch (Exception) { }
            }
            await Send(ctx, 200, new JsonObject
            {
                ["token"] = token,
                ["computerId"] = _computerId,
                ["computerName"] = _o.ComputerName,
                ["protocolVersion"] = PairingLink.ProtocolVersion,
            });
        }

        private async Task Unpair(HttpContext ctx)
        {
            string? token = Tokens.FromHeader(ctx.Request.Headers.Authorization);
            if (!_phones.Remove(token)) { await Unknown(ctx); return; }
            ctx.Response.StatusCode = 204;
        }

        // ===================================================================== Live data

        private async Task State(HttpContext ctx)
        {
            if (Phone(ctx) == null) { await Unknown(ctx); return; }
            if (!_page.Attached) { await Send(ctx, 501, new JsonObject { ["error"] = "not_supported" }); return; }
            var st = _page.State;
            if (st == null || st.Value.Age > _o.StateMaxAge)
            {
                await Send(ctx, 503, new JsonObject { ["error"] = "squall_not_ready", ["message"] = "Squall on the computer is starting or busy. Try again in a moment." });
                return;
            }
            ctx.Response.StatusCode = 200;
            ctx.Response.ContentType = "application/json; charset=utf-8";
            ctx.Response.Headers.CacheControl = "no-store";
            await ctx.Response.WriteAsync(st.Value.Json, Encoding.UTF8);
        }

        private async Task Action(HttpContext ctx)
        {
            var phone = Phone(ctx);
            if (phone == null) { await Unknown(ctx); return; }
            var body = await ReadJson(ctx);
            if (body is not JsonObject o || o["type"] is not JsonValue tv || tv.GetValueKind() != JsonValueKind.String)
            {
                await Send(ctx, 400, new JsonObject { ["ok"] = false, ["error"] = "That request was broken." });
                return;
            }
            if (!_page.Attached)
            {
                await Send(ctx, 501, new JsonObject { ["ok"] = false, ["error"] = "Squall on this computer can't do that yet. Update Squall on the computer." });
                return;
            }
            string id = o["id"] is JsonValue iv ? iv.ToString() : "";
            o["phone"] = phone.Device.DeviceName;
            Task<JsonObject> run;
            if (id.Length is > 0 and <= 100)
            {
                Sweep();
                var entry = _actions.GetOrAdd(phone.TokenHash + "|" + id, _ => (DateTimeOffset.UtcNow, new Lazy<Task<JsonObject>>(() => RunAction(o))));
                run = entry.Result.Value;
            }
            else run = RunAction(o);
            var result = await run;
            await Send(ctx, 200, (JsonObject)result.DeepClone());
        }

        private async Task<JsonObject> RunAction(JsonObject action)
        {
            var answer = await _page.AskAsync("action", action, _o.ActionTimeout).ConfigureAwait(false);
            if (answer == null) return new JsonObject { ["ok"] = false, ["error"] = "Squall on the computer didn't answer in time. Try again." };
            JsonObject? r = null;
            try { r = JsonNode.Parse(answer.Value.GetRawText()) as JsonObject; } catch (JsonException) { }
            if (r == null || r["ok"] is not JsonValue okv || okv.GetValueKind() is not (JsonValueKind.True or JsonValueKind.False))
                return new JsonObject { ["ok"] = false, ["error"] = "Squall on the computer gave a broken answer." };
            if (!(bool)okv && r["error"] is not JsonValue) r["error"] = "That didn't work on the computer.";
            return r;
        }

        /// <summary>Forgets remembered action ids after 10 minutes (the phone only repeats one right away).</summary>
        private void Sweep()
        {
            var cutoff = DateTimeOffset.UtcNow - TimeSpan.FromMinutes(10);
            if (_actions.Count < 50) return;
            foreach (var kv in _actions)
                if (kv.Value.At < cutoff) _actions.TryRemove(kv.Key, out _);
        }

        // ===================================================================== Voice

        private async Task VoiceTurn(HttpContext ctx)
        {
            var phone = Phone(ctx);
            if (phone == null) { await Unknown(ctx); return; }
            var body = await ReadJson(ctx);
            if (body is not JsonObject o) { await Send(ctx, 400, new JsonObject { ["error"] = "bad_json" }); return; }
            if (!_page.Attached) { await Send(ctx, 501, new JsonObject { ["error"] = "not_supported" }); return; }
            o["phone"] = phone.Device.DeviceName;
            var answer = await _page.AskAsync("voice", o, _o.VoiceTimeout, ctx.RequestAborted);
            if (answer == null) { await Send(ctx, 503, new JsonObject { ["error"] = "chief_busy" }); return; }
            JsonObject? r = null;
            try { r = JsonNode.Parse(answer.Value.GetRawText()) as JsonObject; } catch (JsonException) { }
            if (r == null) { await Send(ctx, 503, new JsonObject { ["error"] = "chief_busy" }); return; }
            if (r["error"] is JsonValue ev)
            {
                string err = ev.ToString();
                await Send(ctx, err == "busy" ? 409 : 503, new JsonObject { ["error"] = err == "busy" ? "chief_busy" : err });
                return;
            }
            string text = r["text"] is JsonValue t ? t.ToString() : "";
            if (text.Trim().Length == 0) { await Send(ctx, 503, new JsonObject { ["error"] = "chief_busy" }); return; }
            JsonNode? audio = null;
            if (r["audio"] is JsonObject a && a["base64"] is JsonValue b64 && b64.GetValueKind() == JsonValueKind.String) audio = a.DeepClone();
            bool end = r["endCall"] is JsonValue e && e.GetValueKind() == JsonValueKind.True;
            await Send(ctx, 200, new JsonObject { ["text"] = text, ["audio"] = audio, ["endCall"] = end });
        }

        private async Task VoiceEnd(HttpContext ctx)
        {
            var phone = Phone(ctx);
            if (phone == null) { await Unknown(ctx); return; }
            var body = await ReadJson(ctx) as JsonObject ?? new JsonObject();
            body["phone"] = phone.Device.DeviceName;
            _page.Tell("linkAsk", new JsonObject { ["rid"] = "", ["kind"] = "voiceEnd", ["body"] = body });
            ctx.Response.StatusCode = 204;
        }

        // ===================================================================== Helpers

        private PairedPhone? Phone(HttpContext ctx) => _phones.Find(Tokens.FromHeader(ctx.Request.Headers.Authorization));

        private static Task Unknown(HttpContext ctx) => Send(ctx, 401, new JsonObject { ["error"] = "unknown_token" });

        private static Task NotAllowed(HttpContext ctx) => Send(ctx, 405, new JsonObject { ["error"] = "method_not_allowed" });

        private static async Task<JsonNode?> ReadJson(HttpContext ctx)
        {
            try
            {
                using var reader = new StreamReader(ctx.Request.Body, Encoding.UTF8);
                string text = await reader.ReadToEndAsync();
                return text.Trim().Length == 0 ? null : JsonNode.Parse(text);
            }
            catch (JsonException) { return null; }
        }

        private static async Task Send(HttpContext ctx, int status, JsonObject? body)
        {
            ctx.Response.StatusCode = status;
            ctx.Response.Headers.CacheControl = "no-store";
            if (body == null) return;
            ctx.Response.ContentType = "application/json; charset=utf-8";
            await ctx.Response.WriteAsync(body.ToJsonString(), Encoding.UTF8);
        }
    }
}
