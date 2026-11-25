using System;
using System.IO;
using System.Linq;
using System.Text.Json.Nodes;
using System.Threading.Tasks;
using Xunit;

namespace Squall.Link.Tests
{
    /// <summary>Pause / Resume (docs/squall-uno.md): the step it is on finishes, then no model calls until Resume.</summary>
    public class UnoPauseTests
    {
        private static JsonArray Content(JsonArray messages, int i) => (JsonArray)messages[i]!["content"]!;

        private static Task<JsonObject> Op(UnoRig rig, string op, string sid, bool fromPage = true) =>
            rig.Do("{\"op\":\"" + op + "\",\"sessionId\":\"" + sid + "\"}", fromPage);

        [Fact]
        public async Task PauseLetsTheStepFinishThenWaitsBeforeTheNextModelCall()
        {
            await using var rig = new UnoRig();
            // one model turn with two steps: a 1-second wait (the step it is on when paused) and a click (skipped)
            rig.Model.Reply("tool_use", FakeModel.Tool("tu_1", "wait", "{\"duration\":1}"), FakeModel.Tool("tu_2", "left_click", "{\"coordinate\":[100,100]}"));
            string sid = await rig.Start();
            await Wait.Until(() => rig.Model.Count == 1, "the first model call");
            await Task.Delay(150);   // the wait step is running now

            var r = await Op(rig, "pause", sid, fromPage: false);   // the phone can pause too
            Assert.True((bool)r["ok"]!, r.ToJsonString());
            var s = await rig.Session(sid);
            Assert.Equal("paused", (string?)s["state"]);
            Assert.True((bool)(await Op(rig, "pause", sid))["ok"]!);   // pausing twice is fine

            await Wait.Until(() => rig.Events(sid).Any(e => e.Kind == "wait"), "the step it was on to finish");
            await Task.Delay(300);
            Assert.Equal(1, rig.Model.Count);   // no model call (no tokens) while paused
            Assert.DoesNotContain(rig.Docker.XdotoolActions(), a => string.Join(" ", a).Contains("mousemove 100 100"));
            Assert.Equal("paused", (string?)(await rig.Session(sid))["state"]);
            Assert.False(rig.Hub.RunTask(sid).IsCompleted);

            // messages wait for Resume too
            Assert.True((bool)(await rig.Do("{\"op\":\"message\",\"sessionId\":\"" + sid + "\",\"text\":\"use Firefox\"}"))["ok"]!);
            await Task.Delay(100);
            Assert.Equal(1, rig.Model.Count);

            rig.Model.Reply("end_turn", FakeModel.Text("All done."));
            Assert.True((bool)(await Op(rig, "resume", sid, fromPage: false))["ok"]!);
            await rig.Hub.RunTask(sid).WaitAsync(TimeSpan.FromSeconds(3));

            var content = Content(rig.Model.Request(1), 2);
            Assert.Equal(new[] { "tool_result", "tool_result", "text", "text" }, content.Select(b => (string)b!["type"]!));
            Assert.Equal("OK", (string?)content[0]!["content"]);
            Assert.True((bool)content[1]!["is_error"]!);
            Assert.Contains("paused", (string?)content[1]!["content"]);
            Assert.Equal("use Firefox", (string?)content[2]!["text"]);
            Assert.Contains("paused you", (string?)content[3]!["text"]);

            Assert.Equal("done", (string?)(await rig.Session(sid))["state"]);
            var mine = rig.Events(sid).Where(e => e.Who == "you").Select(e => (e.Kind, e.Text)).ToList();
            Assert.Equal(new[] { ("pause", "Paused by you."), ("message", "use Firefox"), ("resume", "Resumed.") }, mine);
            Assert.False((bool)(await Op(rig, "resume", sid))["ok"]!);   // it ended, so nothing to resume
        }

        [Fact]
        public async Task StopWhilePausedEndsItAndStopAllCountsIt()
        {
            await using var rig = new UnoRig();
            var gate = new TaskCompletionSource();
            rig.Model.Reply(async ct =>
            {
                await gate.Task.WaitAsync(ct);
                return FakeModel.Msg("tool_use", FakeModel.Tool("tu_1", "screenshot"));
            });
            string sid = await rig.Start();
            await Wait.Until(() => rig.Model.Count == 1, "the first model call");
            Assert.True((bool)(await Op(rig, "pause", sid))["ok"]!);
            gate.SetResult();
            await Task.Delay(200);
            Assert.Equal(1, rig.Model.Count);

            // a paused task still holds its computer
            var busy = await rig.Do("{\"op\":\"start\",\"agentId\":\"chief\",\"agentName\":\"Chief\",\"task\":\"another\"}");
            Assert.False((bool)busy["ok"]!);
            Assert.Contains("busy", (string?)busy["error"]);
            var st = await rig.Do("{\"op\":\"state\"}");
            Assert.Equal(sid, (string?)st["computers"]![0]!["sessionId"]);
            Assert.True(rig.Hub.Streaming("pc-chief") || rig.Hub.LatestFrame("pc-chief") != null);

            Assert.True((bool)(await Op(rig, "stop", sid))["ok"]!);
            await rig.Hub.RunTask(sid).WaitAsync(TimeSpan.FromSeconds(3));
            Assert.Equal("stopped", (string?)(await rig.Session(sid))["state"]);
            Assert.Single(rig.Events(sid), e => e.Kind == "stopped");
            Assert.Equal(1, rig.Model.Count);

            // stopAll counts a paused task
            string b = await rig.Start("two", "scout");
            await Wait.Until(() => rig.Model.Count == 2, "the second task's model call");
            Assert.True((bool)(await Op(rig, "pause", b))["ok"]!);
            var all = await rig.Do("{\"op\":\"stopAll\"}");
            Assert.Equal(1, (int)all["stopped"]!);
            await rig.Hub.RunTask(b).WaitAsync(TimeSpan.FromSeconds(3));
            Assert.Equal("stopped", (string?)(await rig.Session(b))["state"]);
        }

        [Fact]
        public async Task PauseOnATaskThatIsNotRunningFailsPlainly()
        {
            await using var rig = new UnoRig();
            Assert.Equal("That task wasn't found.", (string?)(await Op(rig, "pause", "uno-000000000000"))["error"]);

            rig.Model.Reply("end_turn", FakeModel.Text("Done."));
            string sid = await rig.Start();
            await rig.Hub.RunTask(sid);
            var p = await Op(rig, "pause", sid);
            Assert.False((bool)p["ok"]!);
            Assert.Equal("That task isn't running, so there's nothing to pause.", (string?)p["error"]);
            var r = await Op(rig, "resume", sid);
            Assert.False((bool)r["ok"]!);
            Assert.Equal("That task isn't running, so there's nothing to resume.", (string?)r["error"]);
            Assert.DoesNotContain(rig.Events(sid), e => e.Kind is "pause" or "resume");
        }

        [Fact]
        public async Task TakingTheWheelWhilePausedHandsBackToPaused()
        {
            await using var rig = new UnoRig();
            var gate = new TaskCompletionSource();
            rig.Model.Reply(async ct =>
            {
                await gate.Task.WaitAsync(ct);
                return FakeModel.Msg("tool_use", FakeModel.Tool("tu_1", "screenshot"));
            });
            string sid = await rig.Start();
            await Wait.Until(() => rig.Model.Count == 1, "the first model call");
            Assert.True((bool)(await Op(rig, "pause", sid))["ok"]!);
            gate.SetResult();

            var input = await rig.Do("{\"op\":\"input\",\"computerId\":\"pc-chief\",\"action\":\"key\",\"text\":\"Return\"}");
            Assert.Equal("Squall Uno is paused on this computer. Take over first.", (string?)input["error"]);

            Assert.True((bool)(await Op(rig, "takeover", sid))["ok"]!);
            Assert.Equal("you", (string?)(await rig.Session(sid))["state"]);
            var pauseNow = await Op(rig, "pause", sid);
            Assert.Equal("You have the computer right now. Hand it back first, then pause.", (string?)pauseNow["error"]);
            Assert.True((bool)(await rig.Do("{\"op\":\"input\",\"computerId\":\"pc-chief\",\"action\":\"key\",\"text\":\"Return\"}"))["ok"]!);
            Assert.True((bool)(await rig.Do("{\"op\":\"handback\",\"sessionId\":\"" + sid + "\"}"))["ok"]!);

            var s = await rig.Session(sid);
            Assert.Equal("paused", (string?)s["state"]);   // it was paused before the wheel, so it stays paused
            await Task.Delay(200);
            Assert.Equal(1, rig.Model.Count);
            Assert.Contains("stays paused", rig.Events(sid).Last(e => e.Kind == "handback").Text);

            rig.Model.Reply("end_turn", FakeModel.Text("Finished."));
            Assert.True((bool)(await Op(rig, "resume", sid))["ok"]!);
            await rig.Hub.RunTask(sid).WaitAsync(TimeSpan.FromSeconds(3));
            Assert.Equal("done", (string?)(await rig.Session(sid))["state"]);
            var told = string.Join("\n", Content(rig.Model.Request(1), 2).Where(b => (string?)b!["type"] == "text").Select(b => (string)b!["text"]!));
            Assert.Contains("Pressed Return", told);
            Assert.Contains("paused you", told);
            var mine = rig.Events(sid).Where(e => e.Who == "you").Select(e => e.Kind).ToList();
            Assert.Equal(new[] { "pause", "takeover", "key", "handback", "resume" }, mine);
        }

        [Fact]
        public async Task ResumingWhileYouHaveTheWheelCarriesOnAtHandback()
        {
            await using var rig = new UnoRig();
            var gate = new TaskCompletionSource();
            rig.Model.Reply(async ct =>
            {
                await gate.Task.WaitAsync(ct);
                return FakeModel.Msg("tool_use", FakeModel.Tool("tu_1", "screenshot"));
            });
            string sid = await rig.Start();
            await Wait.Until(() => rig.Model.Count == 1, "the first model call");
            Assert.True((bool)(await Op(rig, "pause", sid))["ok"]!);
            Assert.True((bool)(await Op(rig, "takeover", sid))["ok"]!);
            Assert.True((bool)(await Op(rig, "resume", sid))["ok"]!);
            Assert.Equal("you", (string?)(await rig.Session(sid))["state"]);   // still yours until you hand it back
            gate.SetResult();
            await Task.Delay(200);
            Assert.Equal(1, rig.Model.Count);

            rig.Model.Reply("end_turn", FakeModel.Text("Finished."));
            Assert.True((bool)(await rig.Do("{\"op\":\"handback\",\"sessionId\":\"" + sid + "\"}"))["ok"]!);
            await rig.Hub.RunTask(sid).WaitAsync(TimeSpan.FromSeconds(3));
            Assert.Equal("done", (string?)(await rig.Session(sid))["state"]);
        }

        [Fact]
        public async Task ATaskPausedWhenSquallClosedComesBackStopped()
        {
            using var dir = new TempDir();
            Directory.CreateDirectory(dir.Sub("uno"));
            File.WriteAllText(Path.Combine(dir.Sub("uno"), "state.json"),
                "{\"computers\":[{\"id\":\"pc-chief\",\"agentId\":\"chief\",\"agentName\":\"Chief\"}],\"sessions\":[{\"id\":\"uno-bbbbbbbbbbbb\",\"computerId\":\"pc-chief\",\"agentId\":\"chief\",\"agentName\":\"Chief\",\"task\":\"t\",\"state\":\"paused\",\"startedAt\":5}]}");
            await using var rig = new UnoRig(dir);
            var s = await rig.Session("uno-bbbbbbbbbbbb");
            Assert.Equal("stopped", (string?)s["state"]);
            Assert.NotNull(s["endedAt"]);
        }
    }
}
