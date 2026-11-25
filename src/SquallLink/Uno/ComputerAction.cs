using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Squall.Link.Uno
{
    /// <summary>
    /// One checked computer action: a member of the computer-use toolset (left_click, type, scroll, …) with inputs
    /// that are already validated and inside the screen. Made only by <see cref="ComputerActions.Parse"/>.
    /// </summary>
    public sealed class ComputerAction
    {
        internal ComputerAction(string name) { Name = name; }

        /// <summary>The toolset member, e.g. "left_click".</summary>
        public string Name { get; }
        public int? X { get; internal set; }
        public int? Y { get; internal set; }
        /// <summary>The end point of a drag.</summary>
        public int? X2 { get; internal set; }
        public int? Y2 { get; internal set; }
        /// <summary>type: the text; key / hold_key: the xdotool chords, space separated.</summary>
        public string Text { get; internal set; } = "";
        /// <summary>Keys held during a click, drag or scroll, as xdotool names ("shift", "ctrl").</summary>
        public IReadOnlyList<string> Modifiers { get; internal set; } = Array.Empty<string>();
        /// <summary>scroll: up, down, left or right.</summary>
        public string Direction { get; internal set; } = "";
        /// <summary>scroll: wheel clicks; key: times to press.</summary>
        public int Amount { get; internal set; } = 1;
        /// <summary>wait / hold_key: seconds.</summary>
        public double Seconds { get; internal set; }
        /// <summary>zoom: the area to look at, inclusive pixels x0, y0, x1, y1.</summary>
        public (int X0, int Y0, int X1, int Y1)? Region { get; internal set; }
    }

    /// <summary>Turns toolset calls into checked actions, xdotool arguments and short plain sentences for the feed.</summary>
    public static class ComputerActions
    {
        public const int MaxTypeChars = 5000;
        public const int MaxScroll = 30;
        public const int MaxRepeat = 50;
        public const double MaxWaitSeconds = 30;
        public const double MaxHoldSeconds = 10;

        /// <summary>Every toolset member Squall Uno's computer can do.</summary>
        public static readonly IReadOnlyList<string> Members = new[]
        {
            "screenshot", "zoom", "left_click", "right_click", "middle_click", "double_click", "triple_click",
            "left_click_drag", "mouse_move", "left_mouse_down", "left_mouse_up", "cursor_position", "scroll",
            "type", "key", "hold_key", "wait",
        };

        private static readonly Regex ChordPattern = new(@"^[A-Za-z0-9_+\-]+$", RegexOptions.CultureInvariant);

        private static readonly Dictionary<string, string> KeyNames = new(StringComparer.OrdinalIgnoreCase)
        {
            ["enter"] = "Return", ["return"] = "Return", ["esc"] = "Escape", ["escape"] = "Escape",
            ["backspace"] = "BackSpace", ["back_space"] = "BackSpace", ["del"] = "Delete", ["delete"] = "Delete",
            ["tab"] = "Tab", ["space"] = "space", ["spacebar"] = "space", ["home"] = "Home", ["end"] = "End",
            ["insert"] = "Insert", ["ins"] = "Insert",
            ["pageup"] = "Page_Up", ["page_up"] = "Page_Up", ["pgup"] = "Page_Up", ["prior"] = "Page_Up",
            ["pagedown"] = "Page_Down", ["page_down"] = "Page_Down", ["pgdn"] = "Page_Down", ["next"] = "Page_Down",
            ["up"] = "Up", ["down"] = "Down", ["left"] = "Left", ["right"] = "Right",
            ["arrowup"] = "Up", ["arrowdown"] = "Down", ["arrowleft"] = "Left", ["arrowright"] = "Right",
            ["ctrl"] = "ctrl", ["control"] = "ctrl", ["control_l"] = "ctrl", ["ctrl_l"] = "ctrl",
            ["shift"] = "shift", ["shift_l"] = "shift", ["alt"] = "alt", ["alt_l"] = "alt", ["option"] = "alt",
            ["super"] = "super", ["super_l"] = "super", ["win"] = "super", ["windows"] = "super",
            ["cmd"] = "super", ["command"] = "super", ["meta"] = "super",
            ["minus"] = "minus", ["plus"] = "plus", ["equal"] = "equal",
        };

        private static readonly HashSet<string> ModifierNames = new(StringComparer.Ordinal) { "ctrl", "shift", "alt", "super" };

        // ===================================================================== Parsing

        /// <summary>
        /// Checks a toolset call's input. Throws <see cref="UnoToolException"/> with a short message the model can read
        /// (it goes back as a tool_result error) when anything is missing, the wrong type or off the screen.
        /// </summary>
        public static ComputerAction Parse(string name, IReadOnlyDictionary<string, JsonElement>? input, int width, int height)
        {
            input ??= new Dictionary<string, JsonElement>();
            var a = new ComputerAction(name ?? "");
            switch (name)
            {
                case "screenshot":
                case "left_mouse_down":
                case "left_mouse_up":
                case "cursor_position":
                    return a;
                case "zoom":
                    a.Region = Region(input, width, height);
                    return a;
                case "left_click":
                case "right_click":
                case "middle_click":
                case "double_click":
                case "triple_click":
                    if (Point(input, "coordinate", width, height, required: false) is { } at) { a.X = at.X; a.Y = at.Y; }
                    a.Modifiers = Modifiers(input);
                    return a;
                case "left_click_drag":
                    {
                        var from = Point(input, "start_coordinate", width, height, required: true)!.Value;
                        var to = Point(input, "coordinate", width, height, required: true)!.Value;
                        a.X = from.X; a.Y = from.Y; a.X2 = to.X; a.Y2 = to.Y;
                        a.Modifiers = Modifiers(input);
                        return a;
                    }
                case "mouse_move":
                    {
                        var c = Point(input, "coordinate", width, height, required: true)!.Value;
                        a.X = c.X; a.Y = c.Y;
                        return a;
                    }
                case "scroll":
                    {
                        string dir = Str(input, "scroll_direction").Trim().ToLowerInvariant();
                        if (dir is not ("up" or "down" or "left" or "right"))
                            throw new UnoToolException("scroll_direction must be up, down, left or right.");
                        a.Direction = dir;
                        int amount = input.ContainsKey("scroll_amount") ? WholeNumber(input, "scroll_amount") : 3;
                        if (amount < 1) throw new UnoToolException("scroll_amount must be 1 or more.");
                        a.Amount = Math.Min(amount, MaxScroll);
                        if (Point(input, "coordinate", width, height, required: false) is { } sp) { a.X = sp.X; a.Y = sp.Y; }
                        a.Modifiers = Modifiers(input);
                        return a;
                    }
                case "type":
                    {
                        string text = Clean(Str(input, "text"));
                        if (text.Length == 0) throw new UnoToolException("type needs some text.");
                        if (text.Length > MaxTypeChars) throw new UnoToolException($"That text is too long to type at once (the most is {MaxTypeChars} characters). Type it in parts.");
                        a.Text = text;
                        return a;
                    }
                case "key":
                    {
                        a.Text = Chords(Str(input, "text"), allowSeveral: true);
                        int repeat = input.ContainsKey("repeat") ? WholeNumber(input, "repeat") : 1;
                        if (repeat < 1) throw new UnoToolException("repeat must be 1 or more.");
                        a.Amount = Math.Min(repeat, MaxRepeat);
                        if (a.Amount * a.Text.Split(' ').Length > 200) throw new UnoToolException("That is too many key presses at once.");
                        return a;
                    }
                case "hold_key":
                    a.Text = Chords(Str(input, "text"), allowSeveral: false);
                    a.Seconds = Math.Min(Seconds(input), MaxHoldSeconds);
                    return a;
                case "wait":
                    a.Seconds = Math.Min(Seconds(input), MaxWaitSeconds);
                    return a;
                default:
                    throw new UnoToolException($"This computer can't do \"{Short(name ?? "", 40)}\".");
            }
        }

        private static string Str(IReadOnlyDictionary<string, JsonElement> input, string key)
        {
            if (!input.TryGetValue(key, out var v) || v.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
                throw new UnoToolException($"{key} is missing.");
            if (v.ValueKind != JsonValueKind.String) throw new UnoToolException($"{key} must be text.");
            return v.GetString() ?? "";
        }

        private static double Number(JsonElement v, string key)
        {
            if (v.ValueKind == JsonValueKind.Number && v.TryGetDouble(out var d) && !double.IsNaN(d) && !double.IsInfinity(d)) return d;
            if (v.ValueKind == JsonValueKind.String && double.TryParse(v.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out d) && !double.IsNaN(d) && !double.IsInfinity(d)) return d;
            throw new UnoToolException($"{key} must be a number.");
        }

        private static int WholeNumber(IReadOnlyDictionary<string, JsonElement> input, string key)
        {
            double d = Number(input[key], key);
            if (d > 1_000_000) return 1_000_000;
            if (d < -1_000_000) return -1_000_000;
            return (int)Math.Round(d);
        }

        private static double Seconds(IReadOnlyDictionary<string, JsonElement> input)
        {
            if (!input.TryGetValue("duration", out var v)) throw new UnoToolException("duration is missing.");
            double d = Number(v, "duration");
            if (d <= 0) throw new UnoToolException("duration must be more than 0 seconds.");
            return d;
        }

        private static (int X, int Y)? Point(IReadOnlyDictionary<string, JsonElement> input, string key, int width, int height, bool required)
        {
            if (!input.TryGetValue(key, out var v) || v.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
            {
                if (required) throw new UnoToolException($"{key} is missing.");
                return null;
            }
            if (v.ValueKind != JsonValueKind.Array || v.GetArrayLength() != 2)
                throw new UnoToolException($"{key} must be [x, y].");
            double x = Number(v[0], key), y = Number(v[1], key);
            return (Inside(x, width, key, x, y), Inside(y, height, key, x, y));
        }

        /// <summary>Rounds a coordinate and keeps it on the screen; far off the screen is an error, not a guess.</summary>
        private static int Inside(double value, int size, string key, double x, double y)
        {
            if (value < -0.5 || value > size)
                throw new UnoToolException($"{key} ({Fmt(x)}, {Fmt(y)}) is off the screen. The screen is {DockerDesktops.Width}x{DockerDesktops.Height}.");
            return Math.Clamp((int)Math.Round(value), 0, size - 1);
        }

        private static string Fmt(double d) => Math.Round(d, 1).ToString(CultureInfo.InvariantCulture);

        private static (int, int, int, int) Region(IReadOnlyDictionary<string, JsonElement> input, int width, int height)
        {
            if (!input.TryGetValue("region", out var v) || v.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
                throw new UnoToolException("region is missing.");
            if (v.ValueKind != JsonValueKind.Array || v.GetArrayLength() != 4)
                throw new UnoToolException("region must be [x0, y0, x1, y1].");
            double x0 = Number(v[0], "region"), y0 = Number(v[1], "region"), x1 = Number(v[2], "region"), y1 = Number(v[3], "region");
            int a = Inside(x0, width, "region", x0, y0), b = Inside(y0, height, "region", x0, y0);
            int c = Inside(x1, width, "region", x1, y1), d = Inside(y1, height, "region", x1, y1);
            if (c - a < 4 || d - b < 4) throw new UnoToolException("region must have x1 > x0 and y1 > y0, and be at least 4 pixels each way.");
            return (a, b, c, d);
        }

        private static IReadOnlyList<string> Modifiers(IReadOnlyDictionary<string, JsonElement> input)
        {
            if (!input.TryGetValue("text", out var v) || v.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined) return Array.Empty<string>();
            if (v.ValueKind != JsonValueKind.String) throw new UnoToolException("text must be the keys to hold, like \"shift\".");
            string s = (v.GetString() ?? "").Trim();
            if (s.Length == 0) return Array.Empty<string>();
            var list = new List<string>();
            foreach (var part in s.Split(new[] { '+', ' ' }, StringSplitOptions.RemoveEmptyEntries))
            {
                string k = KeyName(part);
                if (!ModifierNames.Contains(k)) throw new UnoToolException($"\"{Short(part, 20)}\" isn't a key to hold. Use shift, ctrl, alt or super.");
                if (!list.Contains(k)) list.Add(k);
            }
            return list;
        }

        /// <summary>Checks and normalises key chords ("ctrl+s", "Return", "ctrl+shift+t Tab") into xdotool names.</summary>
        internal static string Chords(string text, bool allowSeveral)
        {
            var chords = (text ?? "").Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (chords.Length == 0) throw new UnoToolException("text needs a key, like \"Return\" or \"ctrl+s\".");
            if (!allowSeveral && chords.Length > 1) throw new UnoToolException("hold_key holds one key (or one chord like \"ctrl+a\").");
            if (chords.Length > 20) throw new UnoToolException("That is too many keys at once.");
            var outList = new List<string>();
            foreach (var chord in chords)
            {
                if (chord.Length > 60 || !ChordPattern.IsMatch(chord))
                    throw new UnoToolException($"\"{Short(chord, 30)}\" isn't a key name xdotool knows (use names like Return, Tab, ctrl+s).");
                if (chord is "+" or "-") { outList.Add(chord == "+" ? "plus" : "minus"); continue; }
                var parts = chord.Split('+');
                if (parts.Any(p => p.Length == 0)) throw new UnoToolException($"\"{Short(chord, 30)}\" isn't a key name xdotool knows (use names like Return, Tab, ctrl+s).");
                outList.Add(string.Join("+", parts.Select(KeyName)));
            }
            return string.Join(" ", outList);
        }

        private static string KeyName(string part)
        {
            if (KeyNames.TryGetValue(part, out var named)) return named;
            if (part.Length >= 2 && (part[0] == 'f' || part[0] == 'F') && int.TryParse(part.AsSpan(1), NumberStyles.None, CultureInfo.InvariantCulture, out int f) && f is >= 1 and <= 24)
                return "F" + f.ToString(CultureInfo.InvariantCulture);
            return part;
        }

        /// <summary>Drops control characters xdotool can't type (keeps new lines and tabs).</summary>
        private static string Clean(string s)
        {
            var sb = new StringBuilder(s.Length);
            foreach (char c in s.Replace("\r\n", "\n").Replace('\r', '\n'))
                if (c == '\n' || c == '\t' || !char.IsControl(c)) sb.Append(c);
            return sb.ToString();
        }

        internal static string Short(string s, int max)
        {
            s = s.Replace('\n', ' ').Replace('\r', ' ').Replace('\t', ' ');
            return s.Length <= max ? s : s.Substring(0, max - 1) + "…";
        }

        // ===================================================================== xdotool

        /// <summary>
        /// The xdotool arguments (after "xdotool") for an action that runs on the screen. Chained commands run in one
        /// xdotool call. screenshot, zoom, wait and cursor_position aren't xdotool actions (null).
        /// </summary>
        public static IReadOnlyList<string>? XdotoolArgs(ComputerAction a)
        {
            var args = new List<string>();
            switch (a.Name)
            {
                case "left_click":
                case "right_click":
                case "middle_click":
                case "double_click":
                case "triple_click":
                    {
                        MoveTo(args, a.X, a.Y);
                        Down(args, a.Modifiers);
                        args.Add("click");
                        int times = a.Name == "double_click" ? 2 : a.Name == "triple_click" ? 3 : 1;
                        if (times > 1) args.AddRange(new[] { "--repeat", N(times), "--delay", "80" });
                        args.Add(a.Name switch { "right_click" => "3", "middle_click" => "2", _ => "1" });
                        Up(args, a.Modifiers);
                        return args;
                    }
                case "left_click_drag":
                    {
                        MoveTo(args, a.X, a.Y);
                        Down(args, a.Modifiers);
                        args.AddRange(new[] { "mousedown", "1", "sleep", "0.1" });
                        int mx = (a.X!.Value + a.X2!.Value) / 2, my = (a.Y!.Value + a.Y2!.Value) / 2;
                        args.AddRange(new[] { "mousemove", N(mx), N(my), "sleep", "0.1" });
                        args.AddRange(new[] { "mousemove", N(a.X2.Value), N(a.Y2!.Value), "sleep", "0.1" });
                        args.AddRange(new[] { "mouseup", "1" });
                        Up(args, a.Modifiers);
                        return args;
                    }
                case "mouse_move":
                    MoveTo(args, a.X, a.Y);
                    return args;
                case "left_mouse_down":
                    return new[] { "mousedown", "1" };
                case "left_mouse_up":
                    return new[] { "mouseup", "1" };
                case "scroll":
                    {
                        MoveTo(args, a.X, a.Y);
                        Down(args, a.Modifiers);
                        string button = a.Direction switch { "up" => "4", "down" => "5", "left" => "6", _ => "7" };
                        args.AddRange(new[] { "click", "--repeat", N(a.Amount), "--delay", "40", button });
                        Up(args, a.Modifiers);
                        return args;
                    }
                case "type":
                    return new[] { "type", "--delay", "12", "--", a.Text };
                case "key":
                    {
                        args.AddRange(new[] { "key", "--delay", "60" });
                        var chords = a.Text.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                        for (int i = 0; i < a.Amount; i++) args.AddRange(chords);
                        return args;
                    }
                case "hold_key":
                    return new[] { "keydown", a.Text, "sleep", a.Seconds.ToString("0.###", CultureInfo.InvariantCulture), "keyup", a.Text };
                default:
                    return null;
            }
        }

        private static string N(int i) => i.ToString(CultureInfo.InvariantCulture);

        private static void MoveTo(List<string> args, int? x, int? y)
        {
            if (x != null && y != null) args.AddRange(new[] { "mousemove", N(x.Value), N(y.Value) });
        }

        private static void Down(List<string> args, IReadOnlyList<string> mods)
        {
            foreach (var m in mods) args.AddRange(new[] { "keydown", m });
        }

        private static void Up(List<string> args, IReadOnlyList<string> mods)
        {
            for (int i = mods.Count - 1; i >= 0; i--) args.AddRange(new[] { "keyup", mods[i] });
        }

        // ===================================================================== Words for the feed

        /// <summary>The event kind for the feed (docs/squall-uno.md).</summary>
        public static string Kind(ComputerAction a) => a.Name switch
        {
            "left_click" => "click",
            "mouse_move" => "move",
            "left_click_drag" => "drag",
            "left_mouse_down" => "mouse_down",
            "left_mouse_up" => "mouse_up",
            "cursor_position" => "cursor",
            _ => a.Name,
        };

        /// <summary>A short plain sentence: "Clicked at (412, 230)" (done) or "Clicking at (412, 230)" (doing).</summary>
        public static string Describe(ComputerAction a, bool doing = false)
        {
            string at = a.X != null && a.Y != null ? $" at ({a.X}, {a.Y})" : "";
            string hold = a.Modifiers.Count > 0 ? " holding " + string.Join("+", a.Modifiers) : "";
            string Verb(string done, string now) => doing ? now : done;
            switch (a.Name)
            {
                case "screenshot": return Verb("Took a screenshot", "Taking a screenshot");
                case "zoom":
                    {
                        var r = a.Region!.Value;
                        return Verb("Zoomed in", "Zooming in") + $" on ({r.X0}, {r.Y0}) to ({r.X1}, {r.Y1})";
                    }
                case "left_click": return (a.X == null ? Verb("Clicked where the mouse is", "Clicking where the mouse is") : Verb("Clicked", "Clicking") + at) + hold;
                case "right_click": return (a.X == null ? Verb("Right-clicked where the mouse is", "Right-clicking where the mouse is") : Verb("Right-clicked", "Right-clicking") + at) + hold;
                case "middle_click": return (a.X == null ? Verb("Middle-clicked where the mouse is", "Middle-clicking where the mouse is") : Verb("Middle-clicked", "Middle-clicking") + at) + hold;
                case "double_click": return (a.X == null ? Verb("Double-clicked where the mouse is", "Double-clicking where the mouse is") : Verb("Double-clicked", "Double-clicking") + at) + hold;
                case "triple_click": return (a.X == null ? Verb("Triple-clicked where the mouse is", "Triple-clicking where the mouse is") : Verb("Triple-clicked", "Triple-clicking") + at) + hold;
                case "left_click_drag": return Verb("Dragged", "Dragging") + $" from ({a.X}, {a.Y}) to ({a.X2}, {a.Y2})" + hold;
                case "mouse_move": return Verb("Moved the mouse to", "Moving the mouse to") + $" ({a.X}, {a.Y})";
                case "left_mouse_down": return Verb("Pressed the mouse button down", "Pressing the mouse button down");
                case "left_mouse_up": return Verb("Let go of the mouse button", "Letting go of the mouse button");
                case "cursor_position": return Verb("Checked where the mouse is", "Checking where the mouse is");
                case "scroll": return Verb("Scrolled", "Scrolling") + $" {a.Direction} {a.Amount}" + at + hold;
                case "type": return Verb("Typed", "Typing") + " \"" + Short(a.Text, 60) + "\"";
                case "key": return Verb("Pressed", "Pressing") + " " + Short(a.Text.Replace(" ", ", "), 60) + (a.Amount > 1 ? $" {a.Amount} times" : "");
                case "hold_key": return Verb("Held", "Holding") + " " + a.Text + " for " + SecondsText(a.Seconds);
                case "wait": return Verb("Waited", "Waiting") + " " + SecondsText(a.Seconds);
                default: return a.Name;
            }
        }

        internal static string SecondsText(double s)
        {
            string n = Math.Round(s, 1).ToString("0.#", CultureInfo.InvariantCulture);
            return n == "1" ? "1 second" : n + " seconds";
        }
    }
}
