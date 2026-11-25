// Tests for picking the team's model from the phone: team.model and state.models. Run: node --test tests/web/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const L = require('../../web/link.js');
const M = globalThis.SquallModels;

function fakeOps(start) {
  let current = start || '';
  return {
    list: () => [
      { id: '', name: 'By role', note: 'The default.' },
      { id: 'claude-haiku-5-5', name: 'Haiku 5.5', note: 'Fastest.' },
      { id: 'claude-opus-5-5', name: 'Opus 5.5', note: 'Most capable.' },
      { id: 'claude-opus-5-5', name: 'Twice', note: '' },
      { id: 'Bad Id!', name: 'Bad', note: '' },
    ],
    current: () => current,
    set: id => { current = id; },
  };
}

const view = {
  agents: [{ name: 'Nova', lead: true, model: 'claude-opus-5-5' }, { name: 'Quill', model: '' }, { name: 'Rex', model: 'weird model' }],
  lead: 'Nova',
  chats: [],
};

test('modelChoices keeps good, unique ids', () => {
  assert.deepEqual(M.modelChoices(fakeOps()).map(c => c.id), ['', 'claude-haiku-5-5', 'claude-opus-5-5']);
  assert.equal(M.modelChoices(null), null);
  assert.equal(M.modelChoices({ list: () => [], current: () => '' }), null);
});

test('withModels adds the picker and each teammate’s last model', () => {
  const state = L.buildState(view);
  const before = state.version;
  M.withModels(state, view, fakeOps('claude-haiku-5-5'));
  assert.equal(state.models.current, 'claude-haiku-5-5');
  assert.equal(state.models.choices.length, 3);
  const byId = Object.fromEntries(state.bots.map(b => [b.id, b.model]));
  assert.equal(byId.chief, 'claude-opus-5-5');
  assert.equal(byId.quill, undefined);
  assert.equal(byId.rex, undefined);
  assert.notEqual(state.version, before);
  // an unknown current model reads as By role, and no ops means no block
  assert.equal(M.withModels(L.buildState(view), view, fakeOps('claude-gone-1')).models.current, '');
  assert.equal(M.withModels(L.buildState(view), view, null).models, undefined);
});

test('modelRoute and modelDo pick a model the computer knows', () => {
  const ops = fakeOps();
  assert.equal(M.modelRoute({ type: 'chat.send' }, ops), null);
  assert.deepEqual(M.modelRoute({ type: 'team.model', model: 'claude-opus-5-5' }, ops), { do: 'model', model: 'claude-opus-5-5' });
  assert.deepEqual(M.modelRoute({ type: 'team.model', model: '' }, ops), { do: 'model', model: '' });
  assert.match(M.modelRoute({ type: 'team.model', model: 'gpt' }, ops).error, /isn’t one/);
  assert.match(M.modelRoute({ type: 'team.model', model: 5 }, ops).error, /isn’t one/);
  assert.match(M.modelRoute({ type: 'team.model', model: '' }, null).error, /can’t do that yet/);
  assert.deepEqual(M.modelDo({ do: 'model', model: 'claude-opus-5-5' }, ops), { ok: true });
  assert.equal(ops.current(), 'claude-opus-5-5');
  assert.match(M.modelDo({ do: 'model', model: 'x' }, { set: () => { }, current: () => '' }).error, /couldn’t change/);
  assert.deepEqual(M.modelDo({ error: 'nope' }, ops), { ok: false, error: 'nope' });
});
