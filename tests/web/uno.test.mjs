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
