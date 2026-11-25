// Tests for Manage teammate on the phone: rename, chief on or off, and remove.
// Run: node --test tests/web/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const L = require('../../web/link.js');
const T = globalThis.SquallTeam;

function view(extra) {
  return Object.assign({
    agents: [{ name: 'Nova', lead: true }, { name: 'Quill' }, { name: 'Rex', lead: true }],
    lead: 'Nova',
    chats: [],
    approvals: [],
    now: Date.parse('2026-11-25T12:00:00Z'),
  }, extra || {});
}

test('teamRoute leaves other actions alone', () => {
  assert.equal(T.teamRoute(view(), { type: 'chat.send', chatId: 'chief', text: 'hi' }), null);
  assert.equal(T.teamRoute(view(), null), null);
});

test('rename checks the teammate and the new name', () => {
  const v = view();
  assert.deepEqual(T.teamRoute(v, { type: 'bot.rename', botId: 'quill', name: '  Pip ' }), { do: 'rename', name: 'Quill', to: 'Pip' });
  assert.deepEqual(T.teamRoute(v, { type: 'bot.rename', botId: 'chief', name: 'Boss' }), { do: 'rename', name: 'Nova', to: 'Boss' });
  assert.equal(T.teamRoute(v, { type: 'bot.rename', botId: 'zed', name: 'Pip' }).error, 'That teammate isn’t on the team any more.');
  assert.match(T.teamRoute(v, { type: 'bot.rename', botId: 'quill', name: '9lives' }).error, /letters and digits/);
  assert.match(T.teamRoute(v, { type: 'bot.rename', botId: 'quill', name: 'A' }).error, /2 to 20/);
  assert.equal(T.teamRoute(v, { type: 'bot.rename', botId: 'quill', name: 'rex' }).error, 'rex is already on the team.');
  // a new case of its own name is fine
  assert.deepEqual(T.teamRoute(v, { type: 'bot.rename', botId: 'quill', name: 'QUILL' }), { do: 'rename', name: 'Quill', to: 'QUILL' });
});

test('chief needs a yes or no, and remove needs the name the phone showed', () => {
  const v = view();
  assert.deepEqual(T.teamRoute(v, { type: 'bot.chief', botId: 'quill', on: true }), { do: 'chief', name: 'Quill', on: true });
  assert.match(T.teamRoute(v, { type: 'bot.chief', botId: 'quill', on: 'yes' }).error, /chief/);
  assert.deepEqual(T.teamRoute(v, { type: 'bot.remove', botId: 'quill', confirm: 'Quill' }), { do: 'remove', name: 'Quill' });
  assert.match(T.teamRoute(v, { type: 'bot.remove', botId: 'quill' }).error, /team changed/);
  assert.match(T.teamRoute(v, { type: 'bot.remove', botId: 'quill', confirm: 'Rex' }).error, /team changed/);
});

test('withTeam marks chiefs and adds the team limits', () => {
  const v = view({ manage: true });
  const state = T.withTeam(L.buildState(v), v);
  const byId = Object.fromEntries(state.bots.map(b => [b.id, b]));
  assert.equal(byId.chief.chief, true);
  assert.equal(byId.rex.chief, true);
  assert.equal(byId.quill.chief, undefined);
  assert.deepEqual(state.team, { size: 3, max: 12, chiefs: 2, maxChiefs: 4, manage: true });
  const plain = L.buildState(view());
  const again = T.withTeam(L.buildState(view()), view());
  assert.notEqual(again.version, plain.version, 'the version changes so the phone redraws');
  assert.equal(T.withTeam(L.buildState(view()), view()).version, again.version, 'and stays the same for the same team');
  assert.equal(T.withTeam(L.buildState(view()), view()).team.manage, false);
});

test('teamDo calls the right op and gives the renamed bot its new id', async () => {
  const calls = [];
  const ops = {
    rename: async (from, to) => { calls.push(['rename', from, to]); return to; },
    chief: async (name, on) => { calls.push(['chief', name, on]); return on; },
    remove: async name => { calls.push(['remove', name]); return name; },
  };
  const after = async () => view({ agents: [{ name: 'Nova', lead: true }, { name: 'Pip' }, { name: 'Rex', lead: true }] });
  assert.deepEqual(await T.teamDo({ do: 'rename', name: 'Quill', to: 'Pip' }, ops, after), { ok: true, id: 'pip' });
  assert.deepEqual(await T.teamDo({ do: 'chief', name: 'Quill', on: true }, ops, after), { ok: true });
  assert.deepEqual(await T.teamDo({ do: 'remove', name: 'Quill' }, ops, after), { ok: true });
  assert.deepEqual(calls, [['rename', 'Quill', 'Pip'], ['chief', 'Quill', true], ['remove', 'Quill']]);
  assert.deepEqual(await T.teamDo({ error: 'nope' }, ops, after), { ok: false, error: 'nope' });
  assert.deepEqual(await T.teamDo({ do: 'chief', name: 'Quill', on: true }, undefined, after), { ok: false, error: 'Squall on the computer can’t do that yet.' });
  await assert.rejects(T.teamDo({ do: 'remove', name: 'Quill' }, { remove: async () => { throw new Error('Quill is working right now.'); } }, after), /working/);
});
