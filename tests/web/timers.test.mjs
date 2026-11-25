// Tests for work timers from the phone: timer.start, timer.stop and state.timers. Run: node --test tests/web/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const L = require('../../web/link.js');
const T = globalThis.SquallTimers;

const view = {
  agents: [{ name: 'Nova', lead: true }, { name: 'Quill' }],
  lead: 'Nova',
  chats: [
    { id: 'dm:Nova', kind: 'dm', name: 'Nova', members: ['Nova'], messages: [] },
    { id: 'dm:Quill', kind: 'dm', name: 'Quill', members: ['Quill'], messages: [] },
    { id: 'team', kind: 'team', name: 'Team', members: ['Nova', 'Quill'], messages: [] },
  ],
};
const START = Date.parse('2026-11-25T10:00:00.000Z');

test('phoneChatId maps the computer’s chats to the phone’s', () => {
  assert.equal(T.phoneChatId(view, 'dm:Nova'), 'chief');
  assert.equal(T.phoneChatId(view, 'dm:Quill'), 'quill');
  assert.equal(T.phoneChatId(view, 'team'), 'team');
  assert.equal(T.phoneChatId(view, 'dm:Ghost'), null);
});

test('withTimers lists running timers and the dial', () => {
  const ops = {
    list: () => [
      { chatId: 'team', until: null, mins: 'inf', startedAt: START, paused: true },
      { chatId: 'dm:Quill', until: START + 30 * 60000, mins: 30, startedAt: START },
      { chatId: 'dm:Ghost', until: null, mins: 'inf', startedAt: START },
    ],
    workFor: () => 30,
  };
  const state = T.withTimers(L.buildState(view), view, ops);
  assert.deepEqual(state.timers, [
    { chatId: 'quill', minutes: 30, startedAt: '2026-11-25T10:00:00.000Z', until: '2026-11-25T10:30:00.000Z', paused: false },
    { chatId: 'team', minutes: null, startedAt: '2026-11-25T10:00:00.000Z', until: null, paused: true },
  ]);
  assert.equal(state.workFor, 30);
  assert.equal(T.withTimers(L.buildState(view), view, { list: () => [], workFor: () => 'inf' }).workFor, 'inf');
  assert.equal(T.withTimers(L.buildState(view), view, { list: () => [], workFor: () => 7 }).workFor, 'off');
  assert.equal(T.withTimers(L.buildState(view), view, null).timers, undefined);
});

test('timerRoute checks the chat and the length', () => {
  assert.equal(T.timerRoute(view, { type: 'chat.send' }), null);
  const start = T.timerRoute(view, { type: 'timer.start', chatId: 'quill', minutes: 45 });
  assert.equal(start.do, 'timerStart');
  assert.equal(start.chat.id, 'dm:Quill');
  assert.equal(start.value, 45);
  assert.equal(T.timerRoute(view, { type: 'timer.start', chatId: 'team', minutes: 'inf' }).value, 'inf');
  assert.equal(T.timerRoute(view, { type: 'timer.stop', chatId: 'chief' }).do, 'timerStop');
  assert.match(T.timerRoute(view, { type: 'timer.stop', chatId: 'nobody' }).error, /isn’t on the computer/);
  for (const bad of [5, 601, 12.5, '30', null]) assert.match(T.timerRoute(view, { type: 'timer.start', chatId: 'chief', minutes: bad }).error, /10 minutes to 10 hours/);
});

test('timerDo starts and stops through the window', () => {
  const calls = [];
  const ops = { start: (c, v) => { calls.push(['start', c.id, v]); return true; }, stop: c => { calls.push(['stop', c.id]); return c.id === 'dm:Quill'; } };
  const go = a => { const r = T.timerRoute(view, a); if (r.chat) r.chat.raw = r.chat; return T.timerDo(r, ops); };
  assert.deepEqual(go({ type: 'timer.start', chatId: 'quill', minutes: 60 }), { ok: true });
  assert.deepEqual(go({ type: 'timer.stop', chatId: 'quill' }), { ok: true });
  assert.match(go({ type: 'timer.stop', chatId: 'chief' }).error, /no timer running/);
  assert.deepEqual(calls, [['start', 'dm:Quill', 60], ['stop', 'dm:Quill'], ['stop', 'dm:Nova']]);
  assert.match(T.timerDo({ do: 'timerStop', chat: { raw: {} } }, null).error, /can’t do that yet/);
  assert.match(T.timerDo({ do: 'timerStart', chat: { raw: {} }, value: 30 }, { start: () => false }).error, /couldn’t start/);
});
