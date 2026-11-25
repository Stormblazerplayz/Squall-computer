// Tests for team controls from the phone (web/link.js): new teammates, napping, Wake Chief and Let Chief nap.
// Run: node --test tests/web/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const L = require('../../web/link.js');

const agents = [
  { name: 'Nova', lead: true, status: 'idle', napping: true },
  { name: 'Quill', status: 'working', napping: true },
  { name: 'Pixel', status: 'idle' },
];
const view = extra => Object.assign({ agents, lead: 'Nova', chats: [], approvals: [] }, extra || {});

test('a napping teammate shows as napping, and working wins over napping', () => {
  const st = L.buildState(view());
  assert.equal(st.bots.find(b => b.id === 'chief').status, 'napping');
  assert.equal(st.bots.find(b => b.id === 'quill').status, 'working');
  assert.equal(st.bots.find(b => b.id === 'pixel').status, 'idle');
});

test('a napping teammate waiting for an OK shows as waiting', () => {
  const st = L.buildState(view({ approvals: [{ requestId: 'r1', who: 'Nova', tool: 'Bash', text: '' }] }));
  assert.equal(st.bots.find(b => b.id === 'chief').status, 'waiting');
});

test('bot.create is checked before it reaches Squall', () => {
  assert.deepEqual(L.routeAction(view(), { type: 'bot.create', name: ' Echo ', role: ' Coder ', color: '#3fd0b0', job: ' Fix bugs ' }),
    { do: 'botCreate', bot: { name: 'Echo', role: 'Coder', color: '#3FD0B0', job: 'Fix bugs' } });
  assert.equal(L.routeAction(view(), { type: 'bot.create', name: 'Echo' }).bot.color, '');
  assert.equal(L.routeAction(view(), { type: 'bot.create', name: '  ' }).error, 'Pick a name for the new teammate.');
  assert.equal(L.routeAction(view(), { type: 'bot.create', name: 'Echo', color: 'teal' }).error, 'Pick one of the colors.');
  assert.equal(L.routeAction(view(), { type: 'bot.create', name: 'Echo', role: 'x'.repeat(80) }).bot.role.length, 60);
});

test('Wake Chief and Let Chief nap are routed', () => {
  assert.deepEqual(L.routeAction(view(), { type: 'chief.wake' }), { do: 'chiefWake' });
  assert.deepEqual(L.routeAction(view(), { type: 'chief.nap' }), { do: 'chiefNap' });
});

function wired(t, extraHooks) {
  t.mock.timers.enable({ apis: ['setInterval'] });
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
  const S = { agents: [{ name: 'Nova', lead: true, status: 'idle' }, { name: 'Quill', status: 'idle' }], lead: { name: 'Nova' }, chats: [] };
  globalThis.window = globalThis.window || globalThis;
  L.wire(Object.assign({
    S, Bridge, esc: x => String(x),
    phoneMessages: () => [], typingIn: () => [], send: () => true, note() { }, markRead() { }, clear() { },
    answer: async () => ({ ok: true }), group: () => null, openSettings() { }, closeModal() { }, sfx() { },
  }, extraHooks(S)));
  const ask = async (rid, body) => {
    listeners.linkAsk[0]({ rid, kind: 'action', body });
    await new Promise(r => setTimeout(r, 20));
    return calls.find(c => c[1].do === 'answer' && c[1].rid === rid)[1].result;
  };
  return { ask, calls, S };
}

test('wired: a new teammate joins, and the phone gets its id and the new team at once', async (t) => {
  const added = [];
  const { ask, calls } = wired(t, S => ({
    isSleeping: a => a.name === 'Quill',
    addBot: async b => { added.push(b); S.agents.push({ name: b.name, status: 'idle' }); },
  }));
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(await ask('b1', { type: 'bot.create', name: 'Echo', role: 'Coder', color: '#3FD0B0', job: 'Fix bugs' }), { ok: true, id: 'echo' });
  assert.deepEqual(added[0], { name: 'Echo', role: 'Coder', color: '#3FD0B0', job: 'Fix bugs' });
  const st = calls.filter(c => c[1].do === 'state').at(-1)[1].data;
  assert.ok(st.bots.some(b => b.id === 'echo'));
  assert.equal(st.bots.find(b => b.id === 'quill').status, 'napping');
});

test('wired: Squall’s reason comes back when a teammate can’t be added', async (t) => {
  const { ask } = wired(t, () => ({ addBot: async () => { throw new Error('Quill is already on the team.'); } }));
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(await ask('b2', { type: 'bot.create', name: 'Quill' }), { ok: false, error: 'Quill is already on the team.' });
});

test('wired: Wake Chief and Let Chief nap reach Squall, and their reasons come back', async (t) => {
  const did = [];
  let busy = false;
  const { ask } = wired(t, () => ({
    chief: {
      wake: () => { if (busy) throw new Error('Nova is already working.'); did.push('wake'); },
      nap: () => { did.push('nap'); },
    },
  }));
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(await ask('w1', { type: 'chief.wake' }), { ok: true });
  assert.deepEqual(await ask('n1', { type: 'chief.nap' }), { ok: true });
  assert.deepEqual(did, ['wake', 'nap']);
  busy = true;
  assert.deepEqual(await ask('w2', { type: 'chief.wake' }), { ok: false, error: 'Nova is already working.' });
});

test('wired without the hooks: the computer says it can’t yet', async (t) => {
  const { ask } = wired(t, () => ({}));
  await new Promise(r => setTimeout(r, 20));
  assert.equal((await ask('x1', { type: 'chief.wake' })).ok, false);
  assert.equal((await ask('x2', { type: 'bot.create', name: 'Echo' })).ok, false);
});
