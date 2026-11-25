// Tests for Send later: a message Storm writes on the phone and Squall sends at the time picked.
// Run: node --test tests/web/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const L = require('../../web/link.js');
const X = globalThis.SquallLater;

const NOW = Date.parse('2026-11-25T12:00:00Z');
function view(extra) {
  return Object.assign({
    agents: [{ name: 'Nova', lead: true }, { name: 'Quill' }],
    lead: 'Nova',
    chats: [
      { id: 'dm1', kind: 'dm', name: 'Nova', members: ['Nova'], messages: [], typing: [], raw: {} },
      { id: 'dm2', kind: 'dm', name: 'Quill', members: ['Quill'], messages: [], typing: [], raw: {} },
      { id: 'g1', kind: 'group', name: 'Build crew', members: ['Nova', 'Quill'], messages: [], typing: [], raw: {} },
    ],
    approvals: [],
    now: NOW,
  }, extra || {});
}

test('sendLater checks the chat, the text and the time', () => {
  const v = view();
  const at = new Date(NOW + 30 * 60000).toISOString();
  assert.deepEqual(L.routeAction(v, { type: 'chat.sendLater', chatId: 'quill', text: '  Run the tests  ', at }),
    { do: 'later', later: { op: 'add', chat: 'dm2', text: 'Run the tests', at: NOW + 30 * 60000 } });
  assert.equal(L.routeAction(v, { type: 'chat.sendLater', chatId: 'g1', text: 'Hi all', at }).later.chat, 'g1');
  assert.equal(L.routeAction(v, { type: 'chat.sendLater', chatId: 'zed', text: 'x', at }).error, 'That chat isn’t on the computer any more.');
  assert.equal(L.routeAction(v, { type: 'chat.sendLater', chatId: 'quill', text: '   ', at }).error, 'There’s nothing to send.');
  assert.equal(L.routeAction(v, { type: 'chat.sendLater', chatId: 'quill', text: 'x', at: 'soon' }).error, 'Pick when to send it.');
  assert.equal(L.routeAction(v, { type: 'chat.sendLater', chatId: 'quill', text: 'x', at: new Date(NOW + 10000).toISOString() }).error, 'Pick a time at least a minute from now.');
  assert.equal(L.routeAction(v, { type: 'chat.sendLater', chatId: 'quill', text: 'x', at: new Date(NOW + 8 * 86400000).toISOString() }).error, 'Pick a time in the next 7 days.');
  const full = view({ later: Array.from({ length: 30 }, (_, i) => ({ id: 'l' + i, chat: 'dm1', text: 't', at: NOW + 3600000 })) });
  assert.match(L.routeAction(full, { type: 'chat.sendLater', chatId: 'quill', text: 'x', at }).error, /Cancel one first/);
});

test('cancel and send now need a message that is still waiting', () => {
  const v = view({ later: [{ id: 'l1', chat: 'dm2', text: 'Ping', at: NOW + 3600000 }] });
  assert.deepEqual(L.routeAction(v, { type: 'chat.cancelLater', itemId: 'l1' }), { do: 'later', later: { op: 'cancel', id: 'l1' } });
  assert.deepEqual(L.routeAction(v, { type: 'chat.sendLaterNow', itemId: 'l1' }), { do: 'later', later: { op: 'now', id: 'l1' } });
  assert.equal(L.routeAction(v, { type: 'chat.cancelLater', itemId: 'nope' }).error, 'That message already went, or was canceled.');
  assert.equal(L.routeAction(view(), { type: 'chat.sendLaterNow', itemId: 'l1' }).error, 'That message already went, or was canceled.');
});

test('the phone sees the list soonest first, with phone chat ids, and the version changes', () => {
  const later = [
    { id: 'b', chat: 'g1', text: 'Stand up', at: NOW + 7200000 },
    { id: 'a', chat: 'dm1', text: 'Morning', at: NOW + 3600000 },
    { id: 'c', chat: 'gone', text: 'x', at: NOW + 60000 },
    { id: 'd', chat: 'dm2', text: 'x', at: 'bad' },
  ];
  const v = view({ later });
  const plain = L.buildState(view());
  const state = X.withLater(L.buildState(v), v);
  assert.deepEqual(state.later, [
    { id: 'a', chatId: 'chief', text: 'Morning', at: new Date(NOW + 3600000).toISOString() },
    { id: 'b', chatId: 'g1', text: 'Stand up', at: new Date(NOW + 7200000).toISOString() },
  ]);
  assert.notEqual(state.version, plain.version);
  const none = X.withLater(L.buildState(view()), view());
  assert.equal('later' in none, false);
  assert.equal(none.version, plain.version);
});

test('the store adds, cancels, sends now and sends what is due', () => {
  const store = {};
  globalThis.localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
  const sent = [], notes = [];
  let changes = 0;
  const chats = [{ id: 'dm1' }, { id: 'dm2' }];
  const h = { S: { chats }, send: (c, text) => { sent.push([c.id, text]); return true; }, note: (c, text) => notes.push([c.id, text]) };
  const s = X.laterStore(h, () => changes++);
  const r = s.do({ op: 'add', chat: 'dm2', text: 'Ping', at: Date.now() + 3600000 });
  assert.equal(r.ok, true);
  assert.equal(s.list().length, 1);
  assert.equal(JSON.parse(store[X.LATER_KEY]).length, 1);   // kept for a restart
  assert.equal(notes.length, 1);
  s.do({ op: 'add', chat: 'dm1', text: 'Cancel me', at: Date.now() + 3600000 });
  const cancelId = s.list().find(l => l.text === 'Cancel me').id;
  assert.deepEqual(s.do({ op: 'cancel', id: cancelId }), { ok: true });
  assert.deepEqual(s.do({ op: 'cancel', id: cancelId }), { ok: false, error: 'That message already went, or was canceled.' });
  assert.deepEqual(s.do({ op: 'now', id: r.id }), { ok: true });
  assert.deepEqual(sent, [['dm2', 'Ping']]);
  assert.equal(s.list().length, 0);

  // due now, and one from yesterday (Squall was off): the first goes, the second doesn't and Storm is told
  store[X.LATER_KEY] = JSON.stringify([
    { id: 'x', chat: 'dm1', text: 'Due', at: Date.now() - 1000 },
    { id: 'y', chat: 'dm1', text: 'Old', at: Date.now() - 86400000 },
    { id: 'z', chat: 'dm2', text: 'Later', at: Date.now() + 3600000 },
  ]);
  const s2 = X.laterStore(h, () => changes++);
  s2.tick();
  assert.deepEqual(sent.slice(1), [['dm1', 'Due']]);
  assert.deepEqual(s2.list().map(l => l.id), ['z']);
  assert.match(notes[notes.length - 1][1], /didn’t go, because Squall wasn’t running then: “Old”/);
  assert.ok(changes >= 4);
  delete globalThis.localStorage;
});

test('cancel goes by itemId, never by the action’s own id', () => {
  const v = view({ later: [{ id: 'l1', chat: 'dm2', text: 'Ping', at: NOW + 3600000 }] });
  assert.equal(L.routeAction(v, { type: 'chat.cancelLater', id: 'l1' }).error, 'That message already went, or was canceled.');
  assert.equal(L.routeAction(v, { type: 'chat.cancelLater', id: 'a0b1', itemId: 'l1' }).later.id, 'l1');
});
