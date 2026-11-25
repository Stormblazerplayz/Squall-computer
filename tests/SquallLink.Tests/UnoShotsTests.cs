using System;
using System.Linq;
using System.Text.Json.Nodes;
using System.Threading.Tasks;
using Squall.Link.Uno;
using Xunit;

namespace Squall.Link.Tests
{
    public class UnoShotsTests
    {
        private static byte[] Bytes(int n, byte fill = 1) => Enumerable.Repeat(fill, n).ToArray();

        [Fact]
        public void SameFrameIsKeptOnceAndIdsGoUp()
        {
            var shots = new UnoShots(1000);
            var a = shots.Add("uno-a", "pc-chief", 1, 11, 5, "screenshot", "Took a screenshot", Bytes(10), 1, 2, frameSeq: 7);
            Assert.NotNull(a);
            Assert.Null(shots.Add("uno-a", "pc-chief", 2, 12, 6, "click", "Clicked", Bytes(10), 1, 2, frameSeq: 7));
            var b = shots.Add("uno-a", "pc-chief", 2, 12, 6, "click", "Clicked", Bytes(10), 1, 2, frameSeq: 8);
            Assert.NotNull(b);
            Assert.True(b!.Id > a!.Id);
            Assert.True(a.Id > 1000);
            Assert.Equal(new[] { 1, 2 }, shots.For("uno-a").Select(s => s.Step));
            Assert.Same(b, shots.Get("uno-a", b.Id));
            Assert.Null(shots.Get("uno-b", b.Id));
            Assert.Null(shots.Add("", "pc-chief", 1, 0, 0, "click", "", Bytes(5), 0, 0, 1));
            Assert.Null(shots.Add("uno-a", "pc-chief", 1, 0, 0, "click", "", Array.Empty<byte>(), 0, 0, 99));
            Assert.Empty(shots.For("nobody"));
        }

        [Fact]
        public void EachSessionKeepsItsNewestPictures()
        {
            var shots = new UnoShots(0, perSession: 3);
            for (int i = 1; i <= 5; i++) shots.Add("uno-a", "pc-chief", i, i, i, "click", "step " + i, Bytes(10), 0, 0, i);
            Assert.Equal(new[] { 3, 4, 5 }, shots.For("uno-a").Select(s => s.Step));
            Assert.Equal(30, shots.Bytes);
        }

        [Fact]
        public void TheByteBudgetTakesFromTheOldestSessionFirst()
        {
            var shots = new UnoShots(0, perSession: 100, byteBudget: 100);
            for (int i = 1; i <= 4; i++) shots.Add("uno-old", "pc-chief", i, i, i, "click", "", Bytes(20), 0, 0, i);
            for (int i = 1; i <= 3; i++) shots.Add("uno-new", "pc-scout", i, i, i, "click", "", Bytes(20), 0, 0, 100 + i);
            Assert.True(shots.Bytes <= 100);
            Assert.Equal(3, shots.For("uno-new").Count);
            Assert.Equal(new[] { 3, 4 }, shots.For("uno-old").Select(s => s.Step));

            // one picture bigger than the whole budget still stays (the newest picture of a session is never dropped)
            var big = shots.Add("uno-new", "pc-scout", 4, 4, 4, "click", "", Bytes(500), 0, 0, 200);
            Assert.NotNull(big);
            Assert.Empty(shots.For("uno-old"));
            Assert.Equal(new[] { 4 }, shots.For("uno-new").Select(s => s.Step));
        }

        [Fact]
        public async Task ASessionKeepsItsScreenshotsAndTheScreenAfterEachClick()
        {
            await using var rig = new UnoRig();
            var pushed = new System.Collections.Concurrent.ConcurrentQueue<UnoShot>();
            rig.Hub.ShotAdded += s => pushed.Enqueue(s);
            rig.Model.Reply("tool_use", FakeModel.Tool("tu_1", "screenshot"), FakeModel.Tool("tu_2", "left_click", "{\"coordinate\":[412,230]}"));
            rig.Model.Reply("tool_use", FakeModel.Tool("tu_3", "wait", "{\"duration\":0.01}"), FakeModel.Tool("tu_4", "type", "{\"text\":\"weather in Paris\"}"));
            rig.Model.Reply("end_turn", FakeModel.Text("Done."));
            string sid = await rig.Start();
            await rig.Hub.RunTask(sid);
            await Wait.Until(() => pushed.Count >= 3, "a picture for the screenshot, the click and the typing");
            await Task.Delay(100);

            var list = await rig.Do("{\"op\":\"shots\",\"sessionId\":\"" + sid + "\"}", fromPage: false);
            Assert.True((bool)list["ok"]!, list.ToJsonString());
            var shots = ((JsonArray)list["shots"]!).Select(n => (JsonObject)n!).ToList();
            Assert.Equal(new[] { "screenshot", "click", "type" }, shots.Select(s => (string)s["kind"]!));
            Assert.Equal(new[] { 1, 2, 4 }, shots.Select(s => (int)s["step"]!));
            Assert.Equal("Clicked at (412, 230)", (string?)shots[1]["text"]);
            Assert.Equal(1280, (int)shots[0]["width"]!);
            Assert.Null(shots[0]["jpeg"]);   // the list never carries pictures
            var events = rig.Events(sid);
            Assert.Equal(events.First(e => e.Kind == "click").Seq, (long)shots[1]["seq"]!);

            long id = (long)shots[1]["id"]!;
            var one = await rig.Do("{\"op\":\"shot\",\"sessionId\":\"" + sid + "\",\"id\":" + id + "}");
            Assert.True((bool)one["ok"]!);
            Assert.Equal(Convert.ToBase64String(FakeDocker.Jpeg), (string?)one["shot"]!["jpeg"]);
            Assert.Equal(FakeDocker.Jpeg, rig.Hub.Shot(sid, id)!.Jpeg);
            Assert.Null(rig.Hub.Shot(sid, 12345));

            var gone = await rig.Do("{\"op\":\"shot\",\"sessionId\":\"" + sid + "\",\"id\":1}");
            Assert.False((bool)gone["ok"]!);
            Assert.Equal("That picture isn't kept anymore.", (string?)gone["error"]);
            var none = await rig.Do("{\"op\":\"shots\",\"sessionId\":\"uno-000000000000\"}");
            Assert.False((bool)none["ok"]!);
            Assert.Equal("That session wasn't found.", (string?)none["error"]);
        }
    }
}
