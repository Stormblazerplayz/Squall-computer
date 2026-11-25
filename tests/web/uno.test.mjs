// Tests for web/uno.js (the window's half of Squall Uno). Run: node --test tests/web/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const U = require('../../web/uno.js');
const L = require('../../web/link.js');

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
