using System;
using System.Text.Json.Nodes;

namespace Squall.Link.Uno
{
    /// <summary>Something went wrong; Message is a plain sentence the app can show as it is.</summary>
    public class UnoException : Exception
    {
        public UnoException(string message) : base(message) { }
    }

    /// <summary>One computer action couldn't be done (bad input, or it failed). Becomes a tool_result error.</summary>
    public sealed class UnoToolException : UnoException
    {
        public UnoToolException(string message) : base(message) { }
    }

    /// <summary>The computer's container is gone or stopped, so the session can't go on.</summary>
    public sealed class UnoComputerGoneException : UnoException
    {
        public UnoComputerGoneException() : base("The computer turned off. Start the task again to turn it back on.") { }
    }

    /// <summary>An agent's own computer (one Docker container). Field names follow docs/squall-uno.md.</summary>
    public sealed class UnoComputer
    {
        public string Id { get; set; } = "";
        public string AgentId { get; set; } = "";
        public string AgentName { get; set; } = "";
        public string State { get; set; } = "off";
        public string StateText { get; set; } = "";
        public string? SessionId { get; set; }
        public long FrameSeq { get; set; }

        public string Name => AgentName + "'s computer";

        public JsonObject ToJson() => new()
        {
            ["id"] = Id,
            ["agentId"] = AgentId,
            ["agentName"] = AgentName,
            ["name"] = Name,
            ["state"] = State,
            ["stateText"] = StateText,
            ["width"] = DockerDesktops.Width,
            ["height"] = DockerDesktops.Height,
            ["sessionId"] = SessionId,
            ["frameSeq"] = FrameSeq,
        };
    }

    /// <summary>One Squall Uno task. Field names follow docs/squall-uno.md.</summary>
    public sealed class UnoSession
    {
        public string Id { get; set; } = "";
        public string ComputerId { get; set; } = "";
        public string AgentId { get; set; } = "";
        public string AgentName { get; set; } = "";
        public string Task { get; set; } = "";
        public string State { get; set; } = "starting";
        public long StartedAt { get; set; }
        public long? EndedAt { get; set; }
        public int Steps { get; set; }
        public string Now { get; set; } = "";
        public string LastText { get; set; } = "";
        public string? Error { get; set; }
        public long InputTokens { get; set; }
        public long OutputTokens { get; set; }

        /// <summary>starting, running, paused or you: the session holds its computer.</summary>
        public bool Active => State is "starting" or "running" or "paused" or "you";

        public JsonObject ToJson() => new()
        {
            ["id"] = Id,
            ["computerId"] = ComputerId,
            ["agentId"] = AgentId,
            ["agentName"] = AgentName,
            ["task"] = Task,
            ["state"] = State,
            ["startedAt"] = StartedAt,
            ["endedAt"] = EndedAt,
            ["steps"] = Steps,
            ["now"] = Now,
            ["lastText"] = LastText,
            ["error"] = Error,
            ["inputTokens"] = InputTokens,
            ["outputTokens"] = OutputTokens,
        };

        public static UnoSession? FromJson(JsonObject? o)
        {
            if (o == null) return null;
            string id = Str(o, "id");
            if (id.Length == 0) return null;
            return new UnoSession
            {
                Id = id,
                ComputerId = Str(o, "computerId"),
                AgentId = Str(o, "agentId"),
                AgentName = Str(o, "agentName"),
                Task = Str(o, "task"),
                State = Str(o, "state") is { Length: > 0 } st ? st : "stopped",
                StartedAt = Long(o, "startedAt") ?? 0,
                EndedAt = Long(o, "endedAt"),
                Steps = (int)(Long(o, "steps") ?? 0),
                Now = Str(o, "now"),
                LastText = Str(o, "lastText"),
                Error = o["error"] is JsonValue ? Str(o, "error") : null,
                InputTokens = Long(o, "inputTokens") ?? 0,
                OutputTokens = Long(o, "outputTokens") ?? 0,
            };
        }

        internal static string Str(JsonObject o, string key)
        {
            try { return o[key] is JsonValue v && v.TryGetValue<string>(out var s) ? s : ""; }
            catch (InvalidOperationException) { return ""; }
        }

        internal static long? Long(JsonObject o, string key)
        {
            if (o[key] is not JsonValue v) return null;
            if (v.TryGetValue<long>(out var l)) return l;
            if (v.TryGetValue<double>(out var d) && !double.IsNaN(d) && !double.IsInfinity(d)) return (long)Math.Round(d);
            if (v.TryGetValue<string>(out var s) && long.TryParse(s, out l)) return l;
            return null;
        }
    }

    /// <summary>One line of the "WHAT IT DID" feed. Field names follow docs/squall-uno.md.</summary>
    public sealed class UnoEvent
    {
        public long Seq { get; set; }
        public long At { get; set; }
        public string? SessionId { get; set; }
        public string ComputerId { get; set; } = "";
        public string Who { get; set; } = "uno";
        public string Kind { get; set; } = "";
        public string Text { get; set; } = "";
        public int? X { get; set; }
        public int? Y { get; set; }
        public int? X2 { get; set; }
        public int? Y2 { get; set; }
        public int? Step { get; set; }

        public JsonObject ToJson()
        {
            var o = new JsonObject
            {
                ["seq"] = Seq,
                ["at"] = At,
                ["sessionId"] = SessionId,
                ["computerId"] = ComputerId,
                ["who"] = Who,
                ["kind"] = Kind,
                ["text"] = Text,
            };
            if (X != null) o["x"] = X;
            if (Y != null) o["y"] = Y;
            if (X2 != null) o["x2"] = X2;
            if (Y2 != null) o["y2"] = Y2;
            if (Step != null) o["step"] = Step;
            return o;
        }
    }

    /// <summary>The newest picture of a computer's screen.</summary>
    public sealed class UnoFrame
    {
        public UnoFrame(long seq, byte[] jpeg, int cursorX, int cursorY, DateTimeOffset at)
        {
            Seq = seq;
            Jpeg = jpeg;
            CursorX = cursorX;
            CursorY = cursorY;
            At = at;
        }

        public long Seq { get; }
        public byte[] Jpeg { get; }
        public int Width => DockerDesktops.Width;
        public int Height => DockerDesktops.Height;
        public int CursorX { get; }
        public int CursorY { get; }
        public DateTimeOffset At { get; }
    }
}
