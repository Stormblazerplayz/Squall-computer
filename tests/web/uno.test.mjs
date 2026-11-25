// Tests for web/uno.js (the window's half of Squall Uno). Run: node --test tests/web/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readGif } from './gif-read.mjs';

const require = createRequire(import.meta.url);
const U = require('../../web/uno.js');
const L = require('../../web/link.js');
const G = require('../../web/gif.js');

const T = 1764000000000;

test('computer ids follow the contract', () => {
  assert.equal(U.computerIdFor('chief'), 'pc-chief');
  assert.equal(U.computerIdFor('Scout_2'), 'pc-scout-2');
  assert.equal(U.computerIdFor('a b.c'), 'pc-a-b-c');
  assert.equal(U.computerIdFor('x'.repeat(80)).length, 40);
});

test('every agent gets a computer, the lead as "chief" and first, with the ids the phone uses', () => {
  const agents = [{ name: 'Quill', color: '#3D9BE9' }, { name: 'Nova', color: '#F5B83D', lead: true }, { name: 'Odd', color: 'blue' }, { name: '' }];
  const list = U.agentsForUno(agents, L.botIds(agents, 'Nova'));
  assert.deepEqual(list.map(a => [a.agentId, a.agentName, a.lead]), [['chief', 'Nova', true], ['quill', 'Quill', false], ['odd', 'Odd', false]]);
  assert.equal(list[1].color, '#3D9BE9');
  assert.equal(list[2].color, '#8b5cf6');   // not a hex color: the purple default
  assert.deepEqual(U.agentsForUno(agents, {}), []);
});

test('pushes are read flat or wrapped in data', () => {
  assert.deepEqual(U.payloadOf({ event: 'unoFrame', computerId: 'pc-chief', seq: 3 }), { event: 'unoFrame', computerId: 'pc-chief', seq: 3 });
  assert.deepEqual(U.payloadOf({ type: 'unoFrame', data: { computerId: 'pc-chief', seq: 4 } }), { computerId: 'pc-chief', seq: 4 });
  const ev = { seq: 7, kind: 'click', text: 'Clicked', sessionId: 'uno-1' };
  assert.equal(U.eventOf({ event: ev }), ev);                       // the contract's shape: the Event sits under "event"
  assert.equal(U.eventOf({ event: 'uno', data: { event: ev } }), ev);
  assert.equal(U.eventOf({ type: 'uno', data: ev }), ev);
  assert.equal(U.eventOf({ event: 'uno', ev }), ev);
  assert.equal(U.eventOf({ event: 'uno' }), null);
  assert.equal(U.eventOf({ event: { seq: 'x', kind: 'click' } }), null);
  assert.equal(U.eventOf(null), null);
});

function sampleState() {
  return {
    ok: true,
    settings: { hasKey: true, keySource: 'saved', keyHint: 'sk-ant-…a1b2', dockerReady: true, dockerText: 'Docker is running.', maxSteps: 80, model: 'claude-opus-5-5', tokensToday: { input: 120000, output: 4000 } },
    computers: [{ id: 'pc-chief', agentId: 'chief', agentName: 'Chief', name: 'Chief’s computer', state: 'on', stateText: '', width: 1280, height: 800, sessionId: 'uno-b', frameSeq: 9 },
      { id: 'pc-scout', agentId: 'scout', agentName: 'Scout', state: 'off', stateText: '', width: 1280, height: 800, sessionId: null, frameSeq: 0 }],
    sessions: [{ id: 'uno-b', computerId: 'pc-chief', agentId: 'chief', task: 'Weather', state: 'running', startedAt: T + 1000, steps: 3, now: 'Clicking Search at (640, 120)' },
      { id: 'uno-a', computerId: 'pc-chief', agentId: 'chief', task: 'Old', state: 'done', startedAt: T, steps: 12 }],
    events: [{ seq: 2, at: T, sessionId: 'uno-b', computerId: 'pc-chief', who: 'uno', kind: 'screenshot', text: 'Looked at the screen' },
      { seq: 1, at: T, sessionId: 'uno-b', computerId: 'pc-chief', who: 'system', kind: 'start', text: 'Started' },
      { seq: 3, at: T, sessionId: 'uno-a', computerId: 'pc-chief', who: 'uno', kind: 'done', text: 'Done' }],
    lastSeq: 3,
  };
}

test('state answers and pushes merge, events stay sorted and unique, "since" only moves on safe answers', () => {
  const st = U.newStore();
  const fresh = U.mergeState(st, sampleState(), true);
  assert.equal(fresh.length, 3);
  assert.deepEqual(st.events.map(e => e.seq), [1, 2, 3]);
  assert.equal(st.lastSeq, 3);
  assert.equal(st.settings.maxSteps, 80);
  assert.deepEqual(st.sessions.map(s => s.id), ['uno-b', 'uno-a']);   // newest first

  // the same events again add nothing
  assert.equal(U.mergeState(st, sampleState(), true).length, 0);
  assert.equal(st.events.length, 3);

  // one session's answer doesn't move "since" (it skipped the others' events)
  U.mergeState(st, { ok: true, events: [{ seq: 50, kind: 'type', sessionId: 'uno-a' }], lastSeq: 99 }, false);
  assert.equal(st.lastSeq, 3);
  assert.deepEqual(st.events.map(e => e.seq), [1, 2, 3, 50]);

  // an unoState push updates a session in place and keeps the others
  U.mergeState(st, { sessions: [{ id: 'uno-b', state: 'you' }] }, false);
  const b = st.sessions.find(s => s.id === 'uno-b');
  assert.equal(b.state, 'you');
  assert.equal(b.task, 'Weather');
  assert.equal(st.sessions.length, 2);

  // a live event moves "since"; a duplicate is ignored; junk is ignored
  assert.ok(U.takeEvent(st, { seq: 4, kind: 'click', x: 1, y: 2, sessionId: 'uno-b', computerId: 'pc-chief' }));
  assert.equal(st.lastSeq, 4);
  assert.equal(U.takeEvent(st, { seq: 4, kind: 'click' }), null);
  assert.equal(U.takeEvent(st, { kind: 'click' }), null);
  assert.deepEqual(U.mergeState(st, null), []);   // nothing to merge, no crash
});

test('the event list is capped, dropping the oldest', () => {
  const st = U.newStore();
  U.addEvents(st, Array.from({ length: 1600 }, (_, i) => ({ seq: i + 1, kind: 'wait' })));
  assert.equal(st.events.length, 1500);
  assert.equal(st.events[0].seq, 101);
  assert.equal(st.seqs.has(1), false);
  assert.equal(U.addEvents(st, [{ seq: 1, kind: 'wait' }]).length, 1);   // forgotten, so it can come back
});

test('finding a computer, its session and its feed', () => {
  const st = U.newStore();
  U.mergeState(st, sampleState(), true);
  assert.equal(U.computerOf(st, 'chief').id, 'pc-chief');
  assert.equal(U.computerOf(st, 'nobody'), null);
  assert.equal(U.currentSession(st, 'chief').id, 'uno-b');          // the one running on it
  assert.equal(U.currentSession(st, 'scout'), null);
  assert.deepEqual(U.sessionsFor(st, 'chief').map(s => s.id), ['uno-b', 'uno-a']);
  assert.deepEqual(U.sessionEvents(st, 'uno-b').map(e => e.seq), [2, 1]);   // newest first
  assert.deepEqual(U.sessionEvents(st, null), []);
  assert.equal(U.anyRunning(st), true);
  // with nothing running on it, the newest session is the one shown
  st.computers[0].sessionId = null;
  st.sessions[0].state = 'done';
  assert.equal(U.currentSession(st, 'chief').id, 'uno-b');
  assert.equal(U.anyRunning(st), false);
});

test('frames: only newer ones are kept, wrapped or flat; an off computer drops its old screen', () => {
  const st = U.newStore();
  const f1 = U.takeFrame(st, { event: 'unoFrame', computerId: 'pc-chief', seq: 5, width: 1280, height: 800, cursorX: 640, cursorY: 400, jpeg: 'AAA' });
  assert.equal(f1.seq, 5);
  assert.equal(U.takeFrame(st, { event: 'unoFrame', computerId: 'pc-chief', seq: 4, jpeg: 'OLD' }), null);
  assert.equal(U.takeFrame(st, { type: 'unoFrame', data: { computerId: 'pc-chief', seq: 6, width: 1280, height: 800, jpeg: 'BBB' } }).jpeg, 'BBB');
  assert.equal(U.takeFrame(st, { computerId: 'pc-chief', seq: 7 }), null);   // no picture
  assert.equal(st.frames['pc-chief'].jpeg, 'BBB');
  U.mergeState(st, { computers: [{ id: 'pc-chief', agentId: 'chief', state: 'off' }] });
  assert.equal(st.frames['pc-chief'], undefined);
});

test('state words', () => {
  const on = { id: 'pc-chief', state: 'on', stateText: '' };
  assert.deepEqual([U.statusOf(null, null).key, U.statusOf(null, null).label], ['off', 'Off']);
  assert.equal(U.statusOf({ state: 'off' }, null).dot, false);
  const starting = U.statusOf({ state: 'starting', stateText: 'Setting up the computer. The first time takes a few minutes.' }, { state: 'starting' });
  assert.deepEqual([starting.key, starting.label, starting.dot, starting.live], ['starting', 'Starting…', true, false]);
  assert.match(starting.detail, /first time/);
  const live = U.statusOf(on, { state: 'running' });
  assert.deepEqual([live.key, live.label, live.live, live.dot], ['live', 'Live', true, true]);
  assert.deepEqual([U.statusOf(on, { state: 'you' }).label, U.statusOf(on, { state: 'you' }).live], ['You have the wheel', true]);
  assert.equal(U.statusOf(on, { state: 'done' }).label, 'Done');
  assert.equal(U.statusOf(on, { state: 'stopped' }).label, 'Stopped');
  const err = U.statusOf(on, { state: 'error', error: 'The API key was refused.' });
  assert.deepEqual([err.label, err.detail], ['Error', 'The API key was refused.']);
  assert.deepEqual([U.statusOf({ state: 'error', stateText: 'Docker isn’t running.' }, null).label, U.statusOf({ state: 'error', stateText: 'Docker isn’t running.' }, null).detail], ['Error', 'Docker isn’t running.']);
  assert.equal(U.statusOf(on, null).label, 'On');
  assert.equal(U.statusOf({ state: 'off' }, { state: 'done' }).detail, 'Last task: done.');

  assert.equal(U.sessionLabel({ state: 'you' }), 'You have the wheel');
  assert.equal(U.sessionLabel({ state: 'running' }), 'Live');
  assert.equal(U.sessionLabel({ state: 'weird' }), 'Unknown');
  assert.equal(U.sessionLabel(null), 'Unknown');

  assert.deepEqual(U.nowLine({ state: 'running', steps: 7, now: 'Clicking Search at (640, 120)' }), { label: 'NOW · step 7', text: 'Clicking Search at (640, 120)' });
  assert.deepEqual(U.nowLine({ state: 'done', steps: 12, now: '', lastText: 'It is 14 °C in Paris.' }), { label: 'LAST · step 12', text: 'It is 14 °C in Paris.' });
  assert.deepEqual(U.nowLine({ state: 'starting', steps: 0 }), { label: 'NOW', text: 'Getting ready…' });
  assert.deepEqual(U.nowLine(null), { label: 'NOW', text: '' });
});

test('feed rows: text, icon and color per kind, yours marked, times relative', () => {
  const now = T + 90 * 1000;
  const click = U.feedRow({ seq: 1, at: T + 88000, kind: 'click', who: 'uno', text: 'Clicked at (412, 230)', x: 412, y: 230 }, now);
  assert.deepEqual([click.icon, click.color, click.text, click.you, click.when], ['pointer', '#5fb2ff', 'Clicked at (412, 230)', false, 'now']);
  const typed = U.feedRow({ seq: 2, at: T + 60000, kind: 'type', who: 'you', text: 'Typed “hello”' }, now);
  assert.deepEqual([typed.icon, typed.color, typed.you, typed.who, typed.when], ['keyboard', '#b9a7ff', true, 'you', '30s ago']);
  assert.equal(U.feedRow({ seq: 3, at: T, kind: 'screenshot' }, now).color, '#c3c7d4');
  assert.equal(U.feedRow({ seq: 3, at: T, kind: 'screenshot' }, now).text, 'Looked at the screen');
  assert.equal(U.feedRow({ seq: 4, at: T, kind: 'wait' }, now).color, '#7d8197');
  assert.equal(U.feedRow({ seq: 5, kind: 'right_click', x: 3, y: 4 }, now).text, 'Right-clicked at (3, 4)');
  assert.equal(U.feedRow({ seq: 5, kind: 'click', x: null, y: null }, now).text, 'Clicked');
  assert.equal(U.feedRow({ seq: 6, kind: 'mystery' }, now).icon, 'dot');
  assert.equal(U.feedRow({ seq: 6, kind: 'mystery', who: 'hacker' }, now).who, 'uno');
  assert.equal(U.feedRow({ seq: 7, kind: 'error', who: 'system' }, now).who, 'system');

  assert.equal(U.ago(T, T + 3000), 'now');
  assert.equal(U.ago(T, T + 125000), '2 min ago');
  assert.equal(U.ago(T, T + 3 * 3600000), '3 h ago');
  assert.equal(U.ago(T, T + 86400000), '1 day ago');
  assert.equal(U.ago(T, T + 3 * 86400000), '3 days ago');
  assert.equal(U.ago(0, T), '');

  assert.equal(U.isClick({ kind: 'double_click', x: 1, y: 2 }), true);
  assert.equal(U.isClick({ kind: 'left_click', x: 0, y: 0 }), true);
  assert.equal(U.isClick({ kind: 'click' }), false);
  assert.equal(U.isClick({ kind: 'type', x: 1, y: 1 }), false);
});

test('the cursor lands where the frame says, as a share of the picture', () => {
  assert.deepEqual(U.framePct(640, 400, 1280, 800), { left: 50, top: 50 });
  assert.deepEqual(U.framePct(0, 800, 1280, 800), { left: 0, top: 100 });
  assert.deepEqual(U.framePct(2000, -5, 1280, 800), { left: 100, top: 0 });   // clamped onto the screen
  assert.equal(U.framePct(null, 3, 1280, 800), null);
  assert.equal(U.framePct(3, 3, 0, 800), null);
  assert.deepEqual(U.cursorPct({ cursorX: 320, cursorY: 200, width: 1280, height: 800 }), { left: 25, top: 25 });
  assert.deepEqual(U.cursorPct({ cursorX: 320, cursorY: 200 }, 640, 400), { left: 50, top: 50 });
  assert.equal(U.cursorPct({ width: 1280, height: 800 }), null);
  assert.equal(U.cursorPct(null), null);
});

test('a click on the shown picture maps to the computer’s pixels, letterbox and all', () => {
  // the picture fills the box exactly (640 × 400 shows 1280 × 800)
  assert.deepEqual(U.displayToScreen(320, 200, 640, 400, 1280, 800), { x: 640, y: 400 });
  assert.deepEqual(U.displayToScreen(0, 0, 640, 400, 1280, 800), { x: 0, y: 0 });
  assert.deepEqual(U.displayToScreen(640, 400, 640, 400, 1280, 800), { x: 1279, y: 799 });
  // a wider box: 800 × 400 shows the picture 640 wide with 80 px bars left and right
  assert.deepEqual(U.displayToScreen(80, 0, 800, 400, 1280, 800), { x: 0, y: 0 });
  assert.deepEqual(U.displayToScreen(400, 200, 800, 400, 1280, 800), { x: 640, y: 400 });
  assert.equal(U.displayToScreen(40, 200, 800, 400, 1280, 800), null);   // on the bar
  // a taller box: 640 × 600 has 100 px bars top and bottom
  assert.deepEqual(U.displayToScreen(320, 300, 640, 600, 1280, 800), { x: 640, y: 400 });
  assert.equal(U.displayToScreen(320, 50, 640, 600, 1280, 800), null);
  assert.equal(U.displayToScreen(1, 1, 0, 0, 1280, 800), null);
  assert.equal(U.displayToScreen(NaN, 1, 640, 400, 1280, 800), null);

  assert.deepEqual(U.fitBox(1000, 400, 1280, 800), { w: 640, h: 400 });
  assert.deepEqual(U.fitBox(640, 1000, 1280, 800), { w: 640, h: 400 });
  assert.deepEqual(U.fitBox(0, 400, 1280, 800), { w: 0, h: 0 });
});

test('motion: key names look like keys', () => {
  assert.equal(U.prettyKey('ctrl+l'), 'Ctrl + L');
  assert.equal(U.prettyKey('Return'), 'Enter');
  assert.equal(U.prettyKey('ctrl+shift+t'), 'Ctrl + Shift + T');
  assert.equal(U.prettyKey('super'), 'Win');
  assert.equal(U.prettyKey('Control_L+Page_Down'), 'Ctrl + Page Down');
  assert.equal(U.prettyKey('alt+F4'), 'Alt + F4');
  assert.equal(U.prettyKey('ctrl++'), 'Ctrl + +');
  assert.equal(U.prettyKey('ctrl+minus'), 'Ctrl + -');
  assert.equal(U.prettyKey('Escape'), 'Esc');
  assert.equal(U.prettyKey('Up'), '↑');
  assert.equal(U.prettyKey('BackSpace'), 'Backspace');
  assert.equal(U.prettyKey(''), '');
  assert.equal(U.prettyKeys('ctrl+l Return'), 'Ctrl + L, Enter');
  assert.equal(U.prettyKeys('ctrl+l, Return'), 'Ctrl + L, Enter');
});

test('motion: keycap chips come from the real key events only', () => {
  assert.deepEqual(U.keyChip({ kind: 'key', text: 'Pressed ctrl+l' }), { keys: [['Ctrl', 'L']], label: 'Ctrl + L', times: 1, hold: false });
  const many = U.keyChip({ kind: 'key', text: 'Pressed ctrl+a, Delete 3 times' });
  assert.deepEqual(many.keys, [['Ctrl', 'A'], ['Delete']]);
  assert.equal(many.label, 'Ctrl + A, Delete ×3');
  assert.equal(U.keyChip({ kind: 'hold_key', text: 'Held shift for 1 second' }).label, 'Shift');
  assert.equal(U.keyChip({ kind: 'hold_key', text: 'Held shift for 1 second' }).hold, true);
  assert.deepEqual(U.keyChip({ kind: 'key', text: 'Pressed Tab, Tab, Ret…' }).keys, [['Tab'], ['Tab']]);   // the cut-off key is left out
  assert.equal(U.keyChip({ kind: 'key', text: '' }), null);
  assert.equal(U.keyChip({ kind: 'key', text: 'Something else' }), null);
  assert.equal(U.keyChip({ kind: 'type', text: 'Pressed ctrl+l' }), null);
});

test('motion: typed text and scroll direction are read from the event, never made up', () => {
  assert.equal(U.typedText({ kind: 'type', text: 'Typed "weather in Paris"' }), 'weather in Paris');
  assert.equal(U.typedText({ kind: 'type', text: 'Typed "say "hi" there"' }), 'say "hi" there');
  assert.equal(U.typedText({ kind: 'type', text: 'Typed "a long one…"' }), 'a long one…');
  assert.equal(U.typedText({ kind: 'type', text: 'Typed' }), '');
  assert.equal(U.typedText({ kind: 'key', text: 'Typed "x"' }), '');
  assert.equal(U.scrollDir({ kind: 'scroll', text: 'Scrolled down 3 at (640, 400)' }), 'down');
  assert.equal(U.scrollDir({ kind: 'scroll', text: 'Scrolled up 5' }), 'up');
  assert.equal(U.scrollDir({ kind: 'scroll', text: 'Scrolled' }), '');
  assert.equal(U.scrollDir({ kind: 'click', text: 'Scrolled up' }), '');
});

test('motion: each real event maps to one effect on the screen', () => {
  const ev = (kind, extra) => Object.assign({ seq: 1, kind, text: '' }, extra || {});
  assert.deepEqual(U.motionOf(ev('click', { x: 10, y: 20 })), { kind: 'click', at: { x: 10, y: 20 }, count: 1 });
  assert.equal(U.motionOf(ev('double_click', { x: 1, y: 2 })).count, 2);
  assert.equal(U.motionOf(ev('triple_click', { x: 1, y: 2 })).count, 3);
  assert.equal(U.motionOf(ev('click')), null);   // a click without a spot: no ripple anywhere
  assert.deepEqual(U.motionOf(ev('move', { x: 5, y: 6 })), { kind: 'move', to: { x: 5, y: 6 } });
  assert.deepEqual(U.motionOf(ev('drag', { x: 1, y: 2, x2: 30, y2: 40 })), { kind: 'drag', from: { x: 1, y: 2 }, to: { x: 30, y: 40 } });
  assert.deepEqual(U.motionOf(ev('drag', { x: 1, y: 2 })), { kind: 'move', to: { x: 1, y: 2 } });
  assert.deepEqual(U.motionOf(ev('type', { text: 'Typed "hi"' })), { kind: 'type', text: 'hi' });
  assert.equal(U.motionOf(ev('type', { text: '' })), null);
  assert.equal(U.motionOf(ev('key', { text: 'Pressed Return' })).label, 'Enter');
  assert.deepEqual(U.motionOf(ev('scroll', { text: 'Scrolled down 3 at (4, 5)', x: 4, y: 5 })), { kind: 'scroll', dir: 'down', at: { x: 4, y: 5 } });
  assert.deepEqual(U.motionOf(ev('scroll', { text: 'Scrolled up 3' })), { kind: 'scroll', dir: 'up', at: null });
  assert.deepEqual(U.motionOf(ev('screenshot')), { kind: 'flash', box: null });
  assert.deepEqual(U.motionOf(ev('zoom', { x: 100, y: 50, x2: 20, y2: 250 })), { kind: 'flash', box: { x: 20, y: 50, w: 80, h: 200 } });
  for (const k of ['say', 'wait', 'done', 'start', 'error', 'message']) assert.equal(U.motionOf(ev(k, { x: 1, y: 1 })), null);
  assert.equal(U.motionOf({ kind: 'click', x: 1, y: 1 }), null);   // not a real event (no seq)
  assert.equal(U.motionOf(null), null);
});

test('motion: the cursor glide eases out and lands exactly', () => {
  assert.equal(U.easeOut(0), 0);
  assert.equal(U.easeOut(1), 1);
  assert.equal(U.easeOut(2), 1);
  assert.equal(U.easeOut(-1), 0);
  assert.ok(U.easeOut(0.5) > 0.5);   // most of the way there by halfway
  assert.ok(U.easeOut(0.25) < U.easeOut(0.5));
  const from = { x: 0, y: 0 }, to = { x: 100, y: 200 };
  assert.deepEqual(U.glideAt(from, to, 1000, 1000, 250), { x: 0, y: 0, done: false });
  const mid = U.glideAt(from, to, 1000, 1125, 250);
  assert.equal(mid.done, false);
  assert.ok(Math.abs(mid.x - 87.5) < 1e-9 && Math.abs(mid.y - 175) < 1e-9);
  assert.deepEqual(U.glideAt(from, to, 1000, 1250, 250), { x: 100, y: 200, done: true });
  assert.deepEqual(U.glideAt(from, to, 1000, 9999, 250), { x: 100, y: 200, done: true });
  assert.deepEqual(U.glideAt(null, to, 1000, 1000, 250), { x: 100, y: 200, done: true });   // first sight: just there
  assert.deepEqual(U.glideAt(from, to, 1000, 1000, 0), { x: 100, y: 200, done: true });
  assert.equal(U.glideAt(from, null, 0, 0), null);
});

test('motion: typing finishes within 1.2 s however long the text is', () => {
  assert.deepEqual(U.tickerTiming(0), { step: 0, total: 0 });
  assert.deepEqual(U.tickerTiming(10), { step: 45, total: 450 });   // short text: a steady pace
  const long = U.tickerTiming(60);
  assert.ok(long.total <= 1200 + 1e-9 && long.step === 20);
  assert.ok(U.tickerTiming(5000).total <= 1200 + 1e-9);
  assert.equal(U.tickerShown(10, 0), 1);
  assert.equal(U.tickerShown(10, 44), 1);
  assert.equal(U.tickerShown(10, 45), 2);
  assert.equal(U.tickerShown(10, 449), 10);
  assert.equal(U.tickerShown(10, 99999), 10);
  assert.equal(U.tickerShown(60, 1200), 60);
  assert.equal(U.tickerShown(0, 100), 0);
});

test('motion: a drag trail runs from where it started to where it let go', () => {
  const g = U.trailGeom({ x: 0, y: 0 }, { x: 1280, y: 0 }, 1280, 800, 640, 400);
  assert.deepEqual(g, { left: 0, top: 0, length: 640, angle: 0 });
  const d = U.trailGeom({ x: 640, y: 400 }, { x: 640, y: 800 }, 1280, 800, 640, 400);
  assert.equal(d.left, 50); assert.equal(d.top, 50); assert.equal(d.length, 200); assert.equal(d.angle, 90);
  assert.equal(U.trailGeom({ x: 1, y: 1 }, null, 1280, 800, 640, 400), null);
  assert.equal(U.trailGeom({ x: 1, y: 1 }, { x: 2, y: 2 }, 1280, 800, 0, 400), null);
});

test('settings words and op errors', () => {
  assert.equal(U.clampSteps(5), 10);
  assert.equal(U.clampSteps(500), 300);
  assert.equal(U.clampSteps(90), 90);
  assert.equal(U.clampSteps('x'), 80);
  assert.match(U.keyText({ hasKey: true, keySource: 'env', keyHint: 'sk-ant-…zz' }), /SQUALL_UNO_KEY variable \(sk-ant-…zz\)/);
  assert.match(U.keyText({ hasKey: true, keySource: 'saved', keyHint: 'sk-ant-…a1' }), /^Saved on this PC/);
  assert.match(U.keyText({ hasKey: false, keySource: 'none' }), /No key yet/);
  assert.equal(U.keyText(null), 'Not checked yet.');
  assert.equal(U.tokensText({ tokensToday: { input: 120000, output: 4000 } }), '120,000 in · 4,000 out today');
  assert.equal(U.tokensText({ tokensToday: { input: 0, output: 0 } }), 'No tokens used today.');
  assert.equal(U.tokensText(null), 'No tokens used today.');
  assert.equal(U.errorText({ ok: false, error: 'Docker isn’t running.' }), 'Docker isn’t running.');
  assert.equal(U.errorText({ ok: false }), 'That didn’t work.');
  assert.equal(U.errorText({ ok: true }), '');
  assert.match(U.errorText(new Error('Unknown link request: uno')), /doesn’t have Squall Uno yet/);
  assert.equal(U.errorText(new Error('Boom')), 'Boom');
  assert.equal(U.errorText(null), 'Squall didn’t answer.');
});

test('wire does nothing without a page', () => {
  assert.equal(U.wire(null), null);
  assert.equal(U.wire({}), null);
});

test('the Uno tab shows every computer from the real state, and Stop everything asks the host', async () => {
  const listeners = {};
  globalThis.document = { hidden: false, addEventListener: (n, f) => { (listeners[n] = listeners[n] || []).push(f); }, getElementById: () => null, querySelector: () => null };
  const realInterval = globalThis.setInterval;
  globalThis.setInterval = (f, ms) => { const t = realInterval(f, ms); t.unref(); return t; };
  const calls = [];
  const state = {
    ok: true, lastSeq: 0, events: [],
    settings: { hasKey: false, dockerReady: true, dockerText: 'Docker is running.', maxSteps: 80 },
    computers: [{ id: 'pc-chief', agentId: 'chief', agentName: 'Nova', state: 'on', sessionId: 'uno-aaaaaaaaaaaa', frameSeq: 1 }],
    sessions: [{ id: 'uno-aaaaaaaaaaaa', computerId: 'pc-chief', agentId: 'chief', agentName: 'Nova', task: 'Find the weather in Paris', state: 'running', startedAt: T, steps: 3, now: 'Clicking Search' }],
  };
  const Bridge = { host: true, on: () => { }, call: async (name, body) => { calls.push(body.op); return body.op === 'stopAll' ? { ok: true, stopped: 1 } : state; } };
  const paneRenders = [];
  globalThis.SquallLinkCore = L;
  try {
    const ui = U.wire({ S: { agents: [{ name: 'Nova', color: '#F5B83D', lead: true }, { name: 'Quill', color: '#3D9BE9' }], lead: { name: 'Nova' } }, Bridge, renderPaneSoon: () => paneRenders.push(1) });
    await new Promise(r => setTimeout(r, 20));
    const html = ui.paneHTML();
    assert.match(html, /Nova’s computer/);
    assert.match(html, /Quill’s computer/);
    assert.match(html, /Find the weather in Paris/);
    assert.match(html, /1 live/);
    assert.match(html, /needs an Anthropic API key/);
    assert.match(html, /data-uno-pane="stopAll"/);
    assert.ok(!/demo|sample|lorem/i.test(html));
    assert.equal(ui.liveCount(), 1);
    assert.ok(paneRenders.length > 0);
    const target = { closest: sel => sel === '[data-uno-pane]' ? { getAttribute: () => 'stopAll' } : null };
    listeners.click.forEach(f => f({ target }));
    await new Promise(r => setTimeout(r, 20));
    assert.ok(calls.includes('stopAll'));
  } finally {
    globalThis.setInterval = realInterval;
    delete globalThis.document;
    delete globalThis.SquallUnoUI;
    delete globalThis.SquallLinkCore;
  }
});

test('replay shots merge by id, oldest first, and step to their neighbors', () => {
  const s = (id, step, text) => ({ id, sessionId: 'uno-a', step, text });
  let list = U.addShots([], [s(3, 2, 'Clicked'), s(1, 1, 'Took a screenshot')]);
  list = U.addShots(list, s(3, 2, 'Clicked again'));
  list = U.addShots(list, { id: 'x' });
  list = U.addShots(list, null);
  assert.deepEqual(list.map(x => x.id), [1, 3]);
  assert.equal(list[1].text, 'Clicked again');
  const many = U.addShots([], Array.from({ length: 230 }, (_, i) => s(i + 1, i, '')));
  assert.equal(many.length, 200);
  assert.equal(many[0].id, 31);
  assert.equal(U.shotNeighbor(list, 1, 1).id, 3);
  assert.equal(U.shotNeighbor(list, 3, 1).id, 3);
  assert.equal(U.shotNeighbor(list, 1, -1).id, 1);
  assert.equal(U.shotNeighbor(list, null, 1).id, 1);
  assert.equal(U.shotNeighbor(list, null, -1).id, 3);
  assert.equal(U.shotNeighbor([], 1, 1), null);
  assert.equal(U.shotLabel(s(3, 7, '  Clicked   at (412, 230) ')), 'Step 7 · Clicked at (412, 230)');
  assert.equal(U.shotLabel(s(3, 0, '')), 'Start');
  assert.equal(U.shotLabel(null), '');
});

test('Save replay: the GIF’s size and file name', () => {
  assert.deepEqual(U.gifFrameSize(1280, 800), { w: 800, picH: 500, h: 530, caption: 30 });
  assert.deepEqual(U.gifFrameSize(640, 400), { w: 640, picH: 400, h: 430, caption: 30 });   // never scaled up
  assert.deepEqual(U.gifFrameSize(0, 0), { w: 800, picH: 500, h: 530, caption: 30 });       // unknown: the computer's 1280 × 800
  const at = new Date(2026, 10, 25, 9, 5).getTime();   // local time, as the file name uses
  assert.equal(U.gifFileName('Nova', at), 'squall-uno-nova-2026-11-25-0905.gif');
  assert.equal(U.gifFileName('Quill 2.0 / Beta', at), 'squall-uno-quill-2-0-beta-2026-11-25-0905.gif');
  assert.equal(U.gifFileName('', at), 'squall-uno-agent-2026-11-25-0905.gif');
  assert.match(U.gifFileName('Nova'), /^squall-uno-nova-\d{4}-\d{2}-\d{2}-\d{4}\.gif$/);
});

// A stand-in canvas for Node: it remembers what was drawn and answers getImageData with the drawn picture's color.
function fakeCanvas() {
  const log = { texts: [], images: [], rings: 0 };
  let color = [0, 0, 0];
  const g = {
    fillRect() { }, beginPath() { }, arc() { log.rings++; }, stroke() { },
    measureText: t => ({ width: String(t).length * 7 }),
    fillText: t => log.texts.push(String(t)),
    drawImage: (img, x, y, w, h) => { color = img.color; log.images.push([img.id, x, y, w, h]); },
    getImageData: (x, y, w, h) => {
      const data = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < data.length; i += 4) { data[i] = color[0]; data[i + 1] = color[1]; data[i + 2] = color[2]; data[i + 3] = 255; }
      // the caption strip differs per frame too
      const row = (h - 15) * w * 4;
      for (let i = row; i < row + log.texts.length * 4 * 3; i += 4) data[i] = 255;
      return { data };
    },
  };
  return { canvas: { width: 0, height: 0, getContext: () => g }, log };
}

test('Save replay: one frame per kept picture, 0.9 s each, the last held 2.5 s, captions from the shots', async () => {
  const shots = [
    { id: 1, sessionId: 'uno-a', step: 0, text: 'Took a screenshot', width: 1280, height: 800 },
    { id: 2, sessionId: 'uno-a', step: 1, text: 'Clicked at (412, 230)', cursorX: 412, cursorY: 230, width: 1280, height: 800 },
    { id: 3, sessionId: 'uno-a', step: 2, text: 'Typed "weather"', width: 1280, height: 800 },
    { id: 4, sessionId: 'uno-a', step: 3, text: 'Pressed Return', width: 1280, height: 800 },
  ];
  const pics = { 1: 'AAA', 2: 'BBB', 4: 'DDD' };   // 3 isn't kept anymore
  const colors = { AAA: [200, 40, 40], BBB: [40, 200, 40], DDD: [40, 40, 200] };
  const { canvas, log } = fakeCanvas();
  const progress = [];
  const made = await U.makeReplayGif(shots, {
    Gif: G, canvas,
    picOf: async s => pics[s.id] || null,
    loadPic: async b64 => ({ id: b64, color: colors[b64], naturalWidth: 1280, naturalHeight: 800 }),
    progress: (done, total) => progress.push(done + '/' + total),
  });
  assert.equal(made.frames, 3);
  assert.equal(made.missing, 1);
  assert.deepEqual([made.width, made.height, canvas.width, canvas.height], [800, 530, 800, 530]);
  assert.deepEqual(progress, ['1/4', '2/4', '3/4', '4/4']);
  assert.deepEqual(log.images.map(x => x[0]), ['AAA', 'BBB', 'DDD']);
  assert.deepEqual(log.images[0].slice(1), [0, 0, 800, 500]);   // the picture fills the top, the caption sits under it
  assert.equal(log.rings, 1);                                   // the pointer ring only where the shot has a cursor
  assert.ok(log.texts.includes('Start · Took a screenshot'));
  assert.ok(log.texts.includes('Step 1 · Clicked at (412, 230)'));
  assert.ok(log.texts.includes('Step 3 · Pressed Return'));
  assert.ok(log.texts.includes('4 of 4'));

  const gif = readGif(made.bytes);
  assert.equal(gif.head, 'GIF89a');
  assert.deepEqual([gif.width, gif.height], [800, 530]);
  assert.ok(gif.exts.some(e => e.label === 0xff && String.fromCharCode(...e.parts[0]) === 'NETSCAPE2.0'));
  assert.deepEqual(gif.images.map(i => i.control.delay), [90, 90, 250]);
  assert.ok(gif.trailer);
  // the first frame is the whole picture in its own color
  const first = gif.images[0];
  assert.deepEqual([first.w, first.h], [800, 530]);
  const c = first.indices[0];
  assert.deepEqual([first.table[c * 3], first.table[c * 3 + 1], first.table[c * 3 + 2]], [200, 40, 40]);
});

test('Save replay: nothing kept means no GIF', async () => {
  const { canvas } = fakeCanvas();
  const made = await U.makeReplayGif([{ id: 1, sessionId: 'uno-a', step: 1 }], { Gif: G, canvas, picOf: async () => null, loadPic: async () => null });
  assert.deepEqual(made, { bytes: null, frames: 0, missing: 1, width: 0, height: 0 });
  const none = await U.makeReplayGif([], { Gif: G, canvas, picOf: async () => null, loadPic: async () => null });
  assert.equal(none.bytes, null);
});

test('token counts read short and plain', () => {
  assert.equal(U.fmtTokens(0), '0');
  assert.equal(U.fmtTokens(680), '680');
  assert.equal(U.fmtTokens(999), '999');
  assert.equal(U.fmtTokens(999.6), '1k');          // rounds up into thousands
  assert.equal(U.fmtTokens(1000), '1k');
  assert.equal(U.fmtTokens(1234), '1.2k');
  assert.equal(U.fmtTokens(5000), '5k');
  assert.equal(U.fmtTokens(12345), '12.3k');
  assert.equal(U.fmtTokens(99960), '100k');        // no "100.0k"
  assert.equal(U.fmtTokens(123456), '123k');
  assert.equal(U.fmtTokens(999600), '1M');         // no "1000k"
  assert.equal(U.fmtTokens(1234567), '1.2M');
  assert.equal(U.fmtTokens(250000000), '250M');
  assert.equal(U.fmtTokens(-5), '0');
  assert.equal(U.fmtTokens('x'), '0');
  assert.equal(U.fmtTokens(null), '0');

  assert.equal(U.sessionTokensText({ inputTokens: 12345, outputTokens: 680 }), '12.3k tokens in · 680 out');
  assert.equal(U.sessionTokensText({ inputTokens: 900, outputTokens: 0 }), '900 tokens in · 0 out');
  assert.equal(U.sessionTokensText({ inputTokens: 0, outputTokens: 0 }), '');   // nothing used yet: no line
  assert.equal(U.sessionTokensText({}), '');
  assert.equal(U.sessionTokensText(null), '');

  assert.equal(U.todayTokensText({ tokensToday: { input: 120000, output: 4000 } }), 'Today: 124k tokens');
  assert.equal(U.todayTokensText({ tokensToday: { input: 0, output: 0 } }), 'Today: no tokens yet');
  assert.equal(U.todayTokensText({}), 'Today: no tokens yet');
  assert.equal(U.todayTokensText(null), '');
});

test('the New task box says plainly why Start is off, and offers "Tell it" when the computer is busy', () => {
  const ok = { hasKey: true, dockerReady: true, dockerText: 'Docker is running.' };
  assert.deepEqual(U.quickStartCheck(ok, null, 'Chief'), { ok: true, kind: '', why: '', sessionId: null });
  assert.deepEqual(U.quickStartCheck(null, null, 'Chief').ok, true);   // not known yet: the host decides
  const key = U.quickStartCheck({ hasKey: false, dockerReady: true }, null, 'Chief');
  assert.deepEqual([key.ok, key.kind], [false, 'key']);
  assert.match(key.why, /API key/);
  const dock = U.quickStartCheck({ hasKey: true, dockerReady: false, dockerText: 'Start Docker Desktop, then try again.' }, null, 'Chief');
  assert.deepEqual([dock.ok, dock.kind, dock.why], [false, 'docker', 'Start Docker Desktop, then try again.']);
  assert.match(U.quickStartCheck({ hasKey: true, dockerReady: false }, null, 'Chief').why, /Docker/);
  const busy = U.quickStartCheck(ok, { id: 'uno-1', state: 'running' }, 'Quill');
  assert.deepEqual([busy.ok, busy.kind, busy.sessionId], [false, 'busy', 'uno-1']);
  assert.match(busy.why, /^Quill’s computer is busy/);
  assert.equal(U.quickStartCheck(ok, { id: 'uno-1', state: 'you' }, 'Quill').kind, 'busy');
  assert.equal(U.quickStartCheck(ok, { id: 'uno-1', state: 'done' }, 'Quill').ok, true);   // an ended task doesn't block
  // busy wins over the setup problems, because "Tell it" still works
  assert.equal(U.quickStartCheck({ hasKey: false }, { id: 'uno-1', state: 'running' }, 'Quill').kind, 'busy');

  const list = [{ agentId: 'quill', agentName: 'Quill' }, { agentId: 'chief', agentName: 'Nova' }];
  assert.equal(U.pickAgent(list, null).agentId, 'chief');      // Chief by default
  assert.equal(U.pickAgent(list, 'quill').agentId, 'quill');
  assert.equal(U.pickAgent(list, 'gone').agentId, 'chief');
  assert.equal(U.pickAgent([{ agentId: 'quill' }], null).agentId, 'quill');
  assert.equal(U.pickAgent([], 'chief'), null);

  assert.equal(U.canRunAgain({ state: 'done', task: 'Weather' }), true);
  assert.equal(U.canRunAgain({ state: 'stopped', task: 'Weather' }), true);
  assert.equal(U.canRunAgain({ state: 'error', task: 'Weather' }), true);
  assert.equal(U.canRunAgain({ state: 'running', task: 'Weather' }), false);
  assert.equal(U.canRunAgain({ state: 'done', task: '  ' }), false);
  assert.equal(U.canRunAgain(null), false);

  const st = U.newStore();
  U.mergeState(st, sampleState(), true);
  assert.equal(U.runningOn(st, 'chief').id, 'uno-b');
  assert.equal(U.runningOn(st, 'scout'), null);
  st.sessions[0].state = 'done';
  assert.equal(U.runningOn(st, 'chief'), null);
});

test('the Uno tab starts a task, tells a busy one, runs an old one again, and shows real tokens', async () => {
  const listeners = {};
  globalThis.document = { hidden: false, addEventListener: (n, f) => { (listeners[n] = listeners[n] || []).push(f); }, getElementById: () => null, querySelector: () => null };
  const realInterval = globalThis.setInterval;
  globalThis.setInterval = (f, ms) => { const t = realInterval(f, ms); t.unref(); return t; };
  const calls = [];
  let startAnswer = { ok: true, sessionId: 'uno-cccccccccccc', computerId: 'pc-chief' };
  const state = {
    ok: true, lastSeq: 0, events: [],
    settings: { hasKey: true, dockerReady: true, dockerText: 'Docker is running.', maxSteps: 80, tokensToday: { input: 120000, output: 4000 } },
    computers: [{ id: 'pc-chief', agentId: 'chief', agentName: 'Nova', state: 'on', sessionId: null, frameSeq: 1 },
      { id: 'pc-quill', agentId: 'quill', agentName: 'Quill', state: 'on', sessionId: 'uno-qqqqqqqqqqqq', frameSeq: 2 }],
    sessions: [{ id: 'uno-qqqqqqqqqqqq', computerId: 'pc-quill', agentId: 'quill', agentName: 'Quill', task: 'Sort the files', state: 'running', startedAt: T + 5, steps: 2, inputTokens: 5000, outputTokens: 90 },
      { id: 'uno-aaaaaaaaaaaa', computerId: 'pc-chief', agentId: 'chief', agentName: 'Nova', task: 'Find the weather in Paris', state: 'done', startedAt: T, steps: 9, inputTokens: 12345, outputTokens: 680 }],
  };
  const Bridge = { host: true, on: () => { }, call: async (name, body) => {
    calls.push(body);
    if (body.op === 'start') return startAnswer;
    if (body.op === 'message' || body.op === 'watch') return { ok: true };
    return state;
  } };
  globalThis.SquallLinkCore = L;
  const fire = (name, ev) => (listeners[name] || []).forEach(f => f(ev));
  const button = (what, attrs) => ({ disabled: false, getAttribute: n => (n === 'data-uno-pane' ? what : (attrs || {})[n] || null) });
  const press = (what, attrs) => { const b = button(what, attrs); fire('click', { target: { closest: sel => (sel === '[data-uno-pane]' ? b : null) } }); };
  const type = text => fire('input', { target: { classList: { contains: c => c === 'uno-qs-in' }, value: text } });
  const tick = () => new Promise(r => setTimeout(r, 20));
  try {
    const ui = U.wire({ S: { agents: [{ name: 'Nova', color: '#F5B83D', lead: true }, { name: 'Quill', color: '#3D9BE9' }], lead: { name: 'Nova' } }, Bridge, renderPaneSoon: () => { } });
    await tick();
    let html = ui.paneHTML();
    // the header, the box, the chips (Chief first and on), the busy marker, the tokens, Run again
    assert.match(html, /Today: 124k tokens/);
    assert.match(html, /placeholder="What should it do\?"/);
    assert.ok(html.indexOf('data-k="uno-qs"') < html.indexOf('data-k="uno-sec-pcs"'));   // the box is at the top
    assert.match(html, /uno-qs-chip on" data-k="uno-qs-chip:chief"/);
    assert.ok(html.indexOf('uno-qs-chip:chief') < html.indexOf('uno-qs-chip:quill'));
    assert.match(html, /uno-qs-chip busy" data-k="uno-qs-chip:quill"/);
    assert.match(html, /12\.3k tokens in · 680 out/);
    assert.match(html, /5k tokens in · 90 out/);
    assert.match(html, /data-uno-pane="again" data-sid="uno-aaaaaaaaaaaa"/);
    assert.ok(!/data-sid="uno-qqqqqqqqqqqq"/.test(html));   // a running task has no Run again
    assert.ok(!/demo|sample|lorem/i.test(html));

    // an empty box doesn't start anything
    press('qsStart'); await tick();
    assert.ok(!calls.some(c => c.op === 'start'));
    assert.match(ui.paneHTML(), /Write what it should do first/);

    // a failed start keeps the text and shows the host's reason
    type('Check my email');
    startAnswer = { ok: false, error: 'Docker isn’t running.' };
    press('qsStart'); await tick();
    html = ui.paneHTML();
    assert.match(html, /Docker isn’t running\./);
    assert.match(html, /value="Check my email"/);

    // then it starts on Chief's computer and opens the live view
    startAnswer = { ok: true, sessionId: 'uno-cccccccccccc', computerId: 'pc-chief' };
    press('qsStart'); await tick();
    const st1 = calls.filter(c => c.op === 'start').pop();
    assert.deepEqual([st1.agentId, st1.agentName, st1.task], ['chief', 'Nova', 'Check my email']);
    assert.equal(ui.isOpen(), true);
    assert.match(ui.paneHTML(), /value=""/);

    // Quill is busy: Start is off with a plain reason, "Tell it instead" sends a message to its running task
    press('pick', { 'data-agent': 'quill' }); await tick();
    html = ui.paneHTML();
    assert.match(html, /data-uno-pane="qsStart" disabled/);
    assert.match(html, /Quill’s computer is busy/);
    assert.match(html, /Tell it instead/);
    type('Put them in folders by year');
    press('qsTell'); await tick();
    const msg = calls.filter(c => c.op === 'message').pop();
    assert.deepEqual([msg.sessionId, msg.text], ['uno-qqqqqqqqqqqq', 'Put them in folders by year']);

    // Run again starts the same task on the same computer
    const before = calls.filter(c => c.op === 'start').length;
    press('again', { 'data-sid': 'uno-aaaaaaaaaaaa' }); await tick();
    const again = calls.filter(c => c.op === 'start');
    assert.equal(again.length, before + 1);
    assert.deepEqual([again[again.length - 1].agentId, again[again.length - 1].task], ['chief', 'Find the weather in Paris']);

    // no key: Start is off and says why
    state.settings = Object.assign({}, state.settings, { hasKey: false });
    await ui.refresh(); await tick();
    press('pick', { 'data-agent': 'chief' }); await tick();
    html = ui.paneHTML();
    assert.match(html, /data-uno-pane="qsStart" disabled/);
    assert.match(html, /needs an Anthropic API key first\. Add it in Settings/);
  } finally {
    globalThis.setInterval = realInterval;
    delete globalThis.document;
    delete globalThis.SquallUnoUI;
    delete globalThis.SquallLinkCore;
  }
});
