// Tests for Add teammate from the phone: bot.add, state.team.add and state.team.presets. Run: node --test tests/web/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const L = require('../../web/link.js');
const A = globalThis.SquallAdd;
const T = globalThis.SquallTeam;

const view = {
  agents: [{ name: 'Nova', lead: true }, { name: 'Quill' }],
  lead: 'Nova',
  chats: [],
};
const ask = over => Object.assign({ type: 'bot.add', name: 'Ember', role: ' Coder ', color: '#3d9be9', prompt: ' Fix bugs. ' }, over);

test('addRoute checks the name, role, color and brief', () => {
  assert.equal(A.addRoute(view, { type: 'bot.rename' }), null);
  assert.deepEqual(A.addRoute(view, ask()), { do: 'add', name: 'Ember', role: 'Coder', color: '#3D9BE9', prompt: 'Fix bugs.' });
  assert.deepEqual(A.addRoute(view, ask({ role: null, prompt: undefined })), { do: 'add', name: 'Ember', role: '', color: '#3D9BE9', prompt: '' });
  assert.match(A.addRoute(view, ask({ name: '1bad' })).error, /letters and digits/);
  assert.match(A.addRoute(view, ask({ name: 'E' })).error, /letters and digits/);
  assert.equal(A.addRoute(view, ask({ name: 'quill' })).error, 'quill is already on the team.');
  assert.equal(A.addRoute(view, ask({ role: 'x'.repeat(61) })).error, 'Keep the role to 60 characters.');
  assert.equal(A.addRoute(view, ask({ color: 'blue' })).error, 'Pick a color.');
  assert.equal(A.addRoute(view, ask({ color: '#12345' })).error, 'Pick a color.');
  assert.equal(A.addRoute(view, ask({ prompt: 'x'.repeat(2001) })).error, 'Keep what they do to 2,000 characters.');
  const full = { agents: Array.from({ length: T.TEAM_MAX }, (_, i) => ({ name: 'Bot' + i, lead: i === 0 })), lead: 'Bot0', chats: [] };
  assert.equal(A.addRoute(full, ask()).error, 'The team is full (12 teammates).');
});

test('addDo adds the teammate and answers with its new id', async () => {
  const added = [];
  const ops = { add: async (name, role, color, prompt) => { added.push([name, role, color, prompt]); return name; } };
  const after = async () => ({ agents: view.agents.concat([{ name: 'Ember' }]), lead: 'Nova', chats: [] });
  const r = await A.addDo(A.addRoute(view, ask()), ops, after);
  assert.deepEqual(added, [['Ember', 'Coder', '#3D9BE9', 'Fix bugs.']]);
  assert.equal(r.ok, true);
  assert.equal(r.id, L.botIds(view.agents.concat([{ name: 'Ember' }]), 'Nova').Ember);
  assert.equal((await A.addDo({ error: 'nope' }, ops, after)).error, 'nope');
  assert.equal((await A.addDo(A.addRoute(view, ask()), null, after)).ok, false);
});

test('withAdd tells the phone it can add and lists the starting points', () => {
  const ops = {
    add: async () => 'x',
    presets: () => [
      { id: 'coder', label: 'Coder', role: 'Coder', brief: 'You write code.', color: '#3d9be9' },
      { id: 'bad', label: 'Bad', role: 'Bad', brief: '', color: 'red' },
      null,
    ],
  };
  const state = A.withAdd(T.withTeam(L.buildState(view), view), ops);
  assert.equal(state.team.add, true);
  assert.deepEqual(state.team.presets, [{ id: 'coder', label: 'Coder', role: 'Coder', brief: 'You write code.', color: '#3D9BE9' }]);
  const plain = A.withAdd(T.withTeam(L.buildState(view), view), null);
  assert.equal(plain.team.add, undefined);
  assert.equal(plain.team.presets, undefined);
});
