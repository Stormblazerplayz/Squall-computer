// Tests for Chief's error card on the phone: Try again (chief.retry) and the Claude Code version (state.claudeCode).
// Run: node --test tests/web/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const L = require('../../web/link.js');

const agents = [
  { name: 'Nova', role: 'Team lead', color: '#F5B83D', lead: true, status: 'error', activity: 'Failed' },
  { name: 'Quill', role: 'Writer', color: '#3D9BE9', status: 'idle', activity: 'Ready' },
];
const desktop = { current: '1.4.0', ready: null, busy: false };

function view(extra) {
  return Object.assign({
    agents, lead: 'Nova',
    chats: [{ id: 'dm:Nova', kind: 'dm', name: 'Nova', members: ['Nova'], unread: 0, typing: [], messages: [] }],
    approvals: [], desktop,
  }, extra || {});
}

test('the Claude Code version goes to the phone only once a run has reported it', () => {
  assert.equal('claudeCode' in L.buildState(view()), false);
  assert.equal('claudeCode' in L.buildState(view({ claudeCode: { version: 'unknown', latest: '2.1.0' } })), false);
  assert.deepEqual(L.buildState(view({ claudeCode: { version: '2.1.3 (Claude Code)', latest: '' } })).claudeCode, { version: '2.1.3', needsUpdate: false });
});

test('an update is offered only when npm has a newer version', () => {
  const cc = (version, latest) => L.buildState(view({ claudeCode: { version, latest } })).claudeCode;
  assert.deepEqual(cc('2.1.3', '2.1.10'), { version: '2.1.3', needsUpdate: true, latest: '2.1.10' });   // 10 is newer than 3, not older
  assert.deepEqual(cc('2.1.3', '2.2.0'), { version: '2.1.3', needsUpdate: true, latest: '2.2.0' });
  assert.deepEqual(cc('2.1.3', '3.0.0'), { version: '2.1.3', needsUpdate: true, latest: '3.0.0' });
  assert.deepEqual(cc('2.1.3', '2.1.3'), { version: '2.1.3', needsUpdate: false });
  assert.deepEqual(cc('2.1.10', '2.1.9'), { version: '2.1.10', needsUpdate: false });   // ahead of npm (a newer build)
  assert.deepEqual(cc('2.1.3', 'next'), { version: '2.1.3', needsUpdate: false });
});

test('chief.retry is its own action, and updating Claude Code from the phone still says it can’t', () => {
  assert.deepEqual(L.routeAction(view(), { type: 'chief.retry' }), { do: 'chiefRetry' });
  assert.equal(L.routeAction(view(), { type: 'claudeCode.update' }).error, 'Squall on the computer can’t do that yet.');
});

function wired(extra) {
  const listeners = {}, calls = [];
  const Bridge = {
    host: true,
    on(e, fn) { (listeners[e] = listeners[e] || []).push(fn); },
    call(cmd, args) {
      calls.push([cmd, args]);
      if (args.do === 'hello' || args.do === 'status') return Promise.resolve({ running: true, port: 47615, phones: [{ deviceId: 'D1' }], update: desktop });
      return Promise.resolve({ ok: true });
    },
  };
  const S = { agents, lead: { name: 'Nova' }, chats: view().chats.map(c => Object.assign({}, c, { messages: [] })) };
  globalThis.window = globalThis.window || globalThis;
  L.wire(Object.assign({
    S, Bridge, esc: s => String(s),
    phoneMessages: () => [], typingIn: () => [],
    send: () => true, note() { }, markRead() { }, clear() { },
    answer: async () => ({ ok: true }), group: () => null,
    openSettings() { }, closeModal() { }, sfx() { },
  }, extra));
  const ask = async body => {
    const rid = 'x' + calls.length;
    listeners.linkAsk[0]({ rid, kind: 'action', body });
    await new Promise(r => setTimeout(r, 20));
    return calls.find(c => c[1].do === 'answer' && c[1].rid === rid)[1].result;
  };
  return { calls, ask };
}

test('wired to a window, Try again resends to Chief or says why it can’t', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const answers = [true, 'There’s nothing to try again: Nova’s last reply didn’t fail.'];
  let tries = 0;
  const { calls, ask } = wired({ retryChief: () => { tries++; return answers.shift(); }, claudeCode: () => ({ version: '2.1.3', latest: '2.1.4' }) });
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(await ask({ type: 'chief.retry' }), { ok: true });
  assert.deepEqual(calls.filter(c => c[1].do === 'state').at(-1)[1].data.claudeCode, { version: '2.1.3', needsUpdate: true, latest: '2.1.4' });
  assert.deepEqual(await ask({ type: 'chief.retry' }), { ok: false, error: 'There’s nothing to try again: Nova’s last reply didn’t fail.' });
  assert.equal(tries, 2);
});

test('an older window without Try again says it can’t', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { ask } = wired({});
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(await ask({ type: 'chief.retry' }), { ok: false, error: 'Squall on the computer can’t do that yet.' });
});
