using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using Anthropic.Models.Messages;
using Squall.Link.Uno;
using Xunit;

namespace Squall.Link.Tests
{
    /// <summary>
    /// Stands in for the docker command line: remembers containers and answers like docker does.
    /// Everything it returns (version numbers, picture bytes, mouse positions) is a test fixture.
    /// </summary>
    internal sealed class FakeDocker : ICommandRunner
    {
        public readonly ConcurrentQueue<string[]> Calls = new();
        public volatile bool Installed = true;
        public volatile bool Running = true;
        public volatile bool ImageBuilt = true;
        public readonly ConcurrentDictionary<string, string> Containers = new();
        public static readonly byte[] Jpeg = MakeJpeg();
        /// <summary>Lets a test answer a call itself (return null to use the normal answer).</summary>
        public Func<string[], CommandResult?>? Answer;

        private static byte[] MakeJpeg()
        {
            var b = new byte[300];
            b[0] = 0xFF; b[1] = 0xD8; b[2] = 0xFF; b[3] = 0xE0;
            for (int i = 4; i < b.Length; i++) b[i] = (byte)(i % 251);
            return b;
        }

        private static CommandResult Ok(string text = "") => new(0, Encoding.UTF8.GetBytes(text), "");
        private static CommandResult Bad(string err) => new(1, Array.Empty<byte>(), err);

        public Task<CommandResult> RunAsync(string program, IReadOnlyList<string> args, TimeSpan timeout, CancellationToken ct = default, byte[]? stdin = null)
        {
            ct.ThrowIfCancellationRequested();
            var a = args.ToArray();
            Calls.Enqueue(new[] { program }.Concat(a).ToArray());
            if (Answer?.Invoke(a) is { } custom) return Task.FromResult(custom);
            if (!Installed) return Task.FromResult(new CommandResult(-1, Array.Empty<byte>(), "not found", missing: true));
            if (!Running) return Task.FromResult(Bad("Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?"));
            return Task.FromResult(Handle(a));
        }

        private CommandResult Handle(string[] a)
        {
            switch (a[0])
            {
                case "version": return Ok("27.3.1\n");
                case "image": return ImageBuilt ? Ok("sha256:abc\n") : Bad("Error: No such image: squall-uno-desktop:1");
                case "build": ImageBuilt = true; return Ok();
                case "container":
                    {
                        string name = a[^1];
                        return Containers.TryGetValue(name, out var st) ? Ok(st == "running" ? "true\n" : "false\n") : Bad("Error: No such container: " + name);
                    }
                case "ps": return Ok(string.Join("\n", Containers.Where(kv => kv.Value == "running").Select(kv => kv.Key)) + "\n");
                case "run":
                    {
                        int i = Array.IndexOf(a, "--name");
                        Containers[a[i + 1]] = "running";
                        return Ok("0123456789abcdef\n");
                    }
                case "start": Containers[a[1]] = "running"; return Ok(a[1] + "\n");
                case "stop":
                    foreach (var n in a.Skip(3)) Containers[n] = "stopped";
                    return Ok();
                case "rm":
                    return Containers.TryRemove(a[^1], out _) ? Ok(a[^1] + "\n") : Bad("Error: No such container: " + a[^1]);
                case "exec":
                    {
                        int i = 1;
                        while (a[i] == "-e") i += 2;
                        string name = a[i];
                        var cmd = a.Skip(i + 1).ToArray();
                        if (!Containers.TryGetValue(name, out var st)) return Bad("Error response from daemon: No such container: " + name);
                        if (st != "running") return Bad($"Error response from daemon: container {name} is not running");
                        if (cmd[0] == "import") return new CommandResult(0, Jpeg, "");
                        if (cmd[0] == "xdotool" && cmd[1] == "getmouselocation") return Ok("X=10\nY=20\nSCREEN=0\nWINDOW=1\n");
                        if (cmd[0] == "xdotool" && cmd[1] == "getdisplaygeometry") return Ok("1280 800\n");
                        return Ok();
                    }
                default: return Bad("unknown command");
            }
        }

        /// <summary>The xdotool arguments of every exec that ran a screen action (not the mouse/screen checks).</summary>
        public List<string[]> XdotoolActions() => Calls
            .Where(c => c.Length > 1 && c[1] == "exec")
            .Select(c => c.SkipWhile(x => x != "xdotool").ToArray())
            .Where(c => c.Length > 1 && c[1] is not ("getmouselocation" or "getdisplaygeometry"))
            .ToList();
    }

    /// <summary>Plays the model: replies are queued by the test; every request is remembered as JSON.</summary>
    internal sealed class FakeModel : IUnoModel
    {
        public readonly List<JsonArray> Requests = new();
        public readonly List<MessageCreateParams> Params = new();
        public readonly List<string> Keys = new();
        private readonly ConcurrentQueue<Func<CancellationToken, Task<Message>>> _replies = new();
        private readonly object _lock = new();
        public string DisplayName = "Claude Opus 5.5";

        public int Count { get { lock (_lock) return Requests.Count; } }
        public JsonArray Request(int i) { lock (_lock) return Requests[i]; }

        public void Reply(string stop, params string[] blocks) => _replies.Enqueue(_ => Task.FromResult(Msg(stop, blocks)));
        public void Reply(Func<CancellationToken, Task<Message>> reply) => _replies.Enqueue(reply);

        public static Message Msg(string stop, params string[] blocks)
        {
            string json = "{\"id\":\"msg_test\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-opus-5-5\",\"stop_reason\":\"" + stop
                + "\",\"stop_sequence\":null,\"usage\":{\"input_tokens\":100,\"output_tokens\":10,\"cache_read_input_tokens\":5},\"content\":[" + string.Join(",", blocks) + "]}";
            return Message.FromRawUnchecked(JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(json)!);
        }

        public static string Text(string t) => JsonSerializer.Serialize(new { type = "text", text = t });
        public static string Thinking(string sig) => "{\"type\":\"thinking\",\"thinking\":\"\",\"signature\":\"" + sig + "\"}";
        public static string Tool(string id, string name, string inputJson = "{}") =>
            "{\"type\":\"tool_use\",\"id\":\"" + id + "\",\"name\":\"" + name + "\",\"toolset_name\":\"computer\",\"input\":" + inputJson + "}";

        public async Task<Message> CreateAsync(string apiKey, MessageCreateParams request, CancellationToken ct)
        {
            lock (_lock)
            {
                Requests.Add((JsonArray)JsonNode.Parse(JsonSerializer.Serialize(request.Messages))!);
                Params.Add(request);
                Keys.Add(apiKey);
            }
            if (!_replies.TryDequeue(out var reply))
            {
                await Task.Delay(Timeout.Infinite, ct);
                throw new OperationCanceledException(ct);
            }
            return await reply(ct);
        }

        public Task<string> CheckAsync(string apiKey, string model, CancellationToken ct)
        {
            if (apiKey.Contains("bad", StringComparison.Ordinal)) throw new UnoException("The API key didn't work. Check it in Squall Uno's settings.");
            return Task.FromResult(DisplayName);
        }
    }

    internal static class Wait
    {
        public static async Task Until(Func<bool> condition, string what, int ms = 5000)
        {
            var until = DateTime.UtcNow.AddMilliseconds(ms);
            while (!condition())
            {
                if (DateTime.UtcNow > until) Assert.Fail("Timed out waiting for: " + what);
                await Task.Delay(10);
            }
        }
    }
}
