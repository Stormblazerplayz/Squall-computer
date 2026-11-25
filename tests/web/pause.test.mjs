// Tests for Pause all from the phone (web/link.js: team.pause, and state.paused with each idle bot shown as paused).
// Run: node --test tests/web/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const L = require('../../web/link.js');

const agents = [
  { name: 'Nova', role: 'Team lead', color: '#F5B83D', lead: true, status: 'working', activity: 'Planning the day' },
  { name: 'Quill', role: 'Writer', color: '#3D9BE9', status: 'idle', activity: 'Ready' },
  { name: 'Tide', role: 'Tester', color: '#3FD0B0', status: 'idle', activity: '' },
];

function view(extra) {
  return Object.assign({
    agents,
    lead: 'Nova',
    chats: [
      { id: 'dm:Nova', kind: 'dm', name: 'Nova', members: ['Nova'], unread: 0, typing: ['Nova'], messages: [] },
      { id: 'dm:Quill', kind: 'dm', name: 'Quill', members: ['Quill'], unread: 0, typing: [], messages: [] },
      { id: 'dm:Tide', kind: 'dm', name: 'Tide', members: ['Tide'], unread: 0, typing: [], messages: [] },
    ],
    approvals: [{ requestId: 'r1', who: 'Quill', tool: 'Bash', detail: 'git status', text: 'Can I?' }],
  }, extra || {});
}

test('team.pause needs paused: true or false', () => {
  assert.deepEqual(L.routeAction(view(), { type: 'team.pause', paused: true }), { do: 'teamPause', paused: true });
  assert.deepEqual(L.routeAction(view(), { type: 'team.pause', paused: false }), { do: 'teamPause', paused: false });
  for (const bad of [undefined, 'yes', 1, null])
    assert.equal(L.routeAction(view(), { type: 'team.pause', paused: bad }).error, 'Pause has to be on or off.');
});

test('the phone sees the pause: state.paused, and every bot that isn’t working or waiting shows as paused', () => {
  const off = L.buildState(view());
  assert.equal('paused' in off, false);
  assert.ok(off.bots.every(b => b.status !== 'paused'));

  const on = L.buildState(view({ paused: true }));
  assert.equal(on.paused, true);
  const by = Object.fromEntries(on.bots.map(b => [b.id, b.status]));
  assert.equal(by.chief, 'working');   // a run Storm started himself still shows
  assert.equal(by.quill, 'waiting');   // waiting on his OK isn't hidden by the pause
  assert.equal(by.tide, 'paused');
  assert.notEqual(on.version, off.version);   // the phone sees the change
});

function harness() {
  const listeners = {}, calls = [];
  const Bridge = {
    host: true,
    on(e, fn) { (listeners[e] = listeners[e] || []).push(fn); },
    call(cmd, args) {
      calls.push([cmd, args]);
      if (args.do === 'hello' || args.do === 'status') return Promise.resolve({ running: true, port: 47615, phones: [{ deviceId: 'D1' }], update: {} });
      return Promise.resolve({ ok: true });
    },
  };
  const S = { agents, lead: { name: 'Nova' }, chats: view().chats.map(c => Object.assign({}, c, { messages: [] })) };
  return { listeners, calls, Bridge, S };
}

const hooks = (S, Bridge, extra) => Object.assign({
  S, Bridge, esc: s => String(s),
  phoneMessages: () => [], typingIn: () => [],
  send: () => true, note() { }, markRead() { }, clear() { },
  answer: async () => ({ ok: true }), group: () => null,
  openSettings() { }, closeModal() { }, sfx() { },
}, extra || {});

test('wired to a window, Pause all pauses and resumes the team and pushes the new state', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { listeners, calls, Bridge, S } = harness();
  let paused = false;
  const changes = [];
  globalThis.window = globalThis.window || globalThis;
  L.wire(hooks(S, Bridge, {
    paused: () => paused,
    setPaused: (on, from) => { changes.push([on, from]); paused = on; return true; },
  }));
  await new Promise(r => setTimeout(r, 20));
  const answers = () => calls.filter(c => c[1].do === 'answer');
  const states = () => calls.filter(c => c[1].do === 'state');

  listeners.linkAsk[0]({ rid: 'p1', kind: 'action', body: { type: 'team.pause', paused: true } });
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(changes, [[true, 'the phone']]);
  assert.deepEqual(answers()[0][1].result, { ok: true });
  assert.equal(states().at(-1)[1].data.paused, true);   // pushed before the answer, so the phone's next read shows it
  assert.ok(states().at(-1)[1].data.bots.some(b => b.status === 'paused'));

  listeners.linkAsk[0]({ rid: 'p2', kind: 'action', body: { type: 'team.pause', paused: false } });
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(changes[1], [false, 'the phone']);
  assert.equal('paused' in states().at(-1)[1].data, false);

  listeners.linkAsk[0]({ rid: 'p3', kind: 'action', body: { type: 'team.pause' } });
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(answers()[2][1].result, { ok: false, error: 'Pause has to be on or off.' });
  assert.equal(changes.length, 2);
});

test('an older window without the pause says it can’t, and changes nothing', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { listeners, calls, Bridge, S } = harness();
  globalThis.window = globalThis.window || globalThis;
  L.wire(hooks(S, Bridge));
  await new Promise(r => setTimeout(r, 20));
  listeners.linkAsk[0]({ rid: 'p1', kind: 'action', body: { type: 'team.pause', paused: true } });
  await new Promise(r => setTimeout(r, 20));
  const a = calls.find(c => c[1].do === 'answer');
  assert.deepEqual(a[1].result, { ok: false, error: 'Squall on the computer can’t do that yet.' });
});
