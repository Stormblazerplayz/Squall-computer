// Tests for Problems and Done in the phone's Inbox: a bot's errors and finished jobs, from Squall's inbox log.
// Run: node --test tests/web/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const L = require('../../web/link.js');

const agents = [
  { name: 'Nova', role: 'Team lead', color: '#F5B83D', lead: true, status: 'idle', activity: 'Ready' },
  { name: 'Quill', role: 'Writer', color: '#3D9BE9', status: 'idle', activity: 'Ready' },
];
const NOW = Date.parse('2026-11-25T09:00:00Z');
const ago = min => new Date(NOW - min * 60000).toISOString();

function view(extra) {
  return Object.assign({
    agents, lead: 'Nova', now: NOW,
    chats: [{ id: 'dm:Quill', kind: 'dm', name: 'Quill', members: ['Quill'], unread: 0, typing: [], messages: [] }],
    approvals: [{ requestId: 'r1', who: 'Quill', tool: 'Bash', detail: 'npm test', text: 'Run the tests', at: ago(1) }],
    desktop: { current: '1.4.0', ready: null, busy: false },
  }, extra || {});
}

const log = [
  { id: 'p1', kind: 'error', who: 'Quill', title: 'Quill hit a problem', body: 'The run failed.', details: 'Quill: The run failed. Exit 1', at: ago(30), read: false },
  { id: 'd1', kind: 'done', who: 'Nova', title: 'Nova finished a job', body: 'The site is built.', at: ago(10), read: true },
  { id: 'd2', kind: 'done', who: 'Quill', title: 'Quill finished a job', body: 'Old.', at: ago(3 * 24 * 60) },
  { id: 'p2', kind: 'error', who: 'Quill', body: 'Cleared.', at: ago(5), cleared: true },
  { id: 'x1', kind: 'error', who: 'Nobody', body: 'Not a bot.', at: ago(5) },
  { id: 'x2', kind: 'note', who: 'Quill', body: 'Not a kind the phone knows.', at: ago(5) },
  { id: 'x3', kind: 'done', who: 'Quill', body: 'No time.' },
];

test('approvals stay first; problems and finished jobs follow, newest first', () => {
  const inbox = L.buildState(view({ inboxLog: log })).inbox;
  assert.deepEqual(inbox.map(i => i.id), ['r1', 'd1', 'p1']);
  const [, done, err] = inbox;
  assert.deepEqual(err, { id: 'p1', kind: 'error', botId: 'quill', title: 'Quill hit a problem', unread: true, at: ago(30), body: 'The run failed.', details: 'Quill: The run failed. Exit 1' });
  assert.deepEqual(done, { id: 'd1', kind: 'done', botId: 'chief', title: 'Nova finished a job', unread: false, at: ago(10), body: 'The site is built.', openLabel: 'Open chat', opens: 'chat' });
});

test('no log, or a broken one, leaves just the approvals', () => {
  assert.deepEqual(L.buildState(view()).inbox.map(i => i.id), ['r1']);
  assert.deepEqual(L.buildState(view({ inboxLog: 'nope' })).inbox.map(i => i.id), ['r1']);
  assert.deepEqual(L.buildState(view({ inboxLog: [null, 3, {}] })).inbox.map(i => i.id), ['r1']);
});

test('long text is cut, and only 30 items go to the phone', () => {
  const many = Array.from({ length: 45 }, (_, i) => ({ id: 'd' + i, kind: 'done', who: 'Quill', body: 'x'.repeat(900), at: ago(i) }));
  const inbox = L.buildState(view({ inboxLog: many, approvals: [] })).inbox;
  assert.equal(inbox.length, 30);
  assert.equal(inbox[0].id, 'd0');
  assert.equal(inbox[0].body.length, 600);
  assert.equal(inbox[0].title, 'Quill finished a job');
});

test('reading and clearing on the phone reach the log; approvals still need an answer', () => {
  const v = view({ inboxLog: log });
  assert.deepEqual(L.routeAction(v, { type: 'inbox.read', itemId: 'p1' }), { do: 'inboxRead', id: 'p1' });
  assert.deepEqual(L.routeAction(v, { type: 'inbox.read', itemId: 'r1' }), { do: 'none' });
  assert.deepEqual(L.routeAction(v, { type: 'inbox.readAll' }), { do: 'inboxReadAll' });
  assert.deepEqual(L.routeAction(v, { type: 'inbox.clear', itemId: 'd1' }), { do: 'inboxClear', id: 'd1' });
  assert.equal(L.routeAction(v, { type: 'inbox.clear', itemId: 'r1' }).error, 'Answer it with Allow or Deny, and it goes away.');
  assert.deepEqual(L.routeAction(v, { type: 'inbox.clear', itemId: 'p2' }), { do: 'none' });   // already cleared
  assert.deepEqual(L.routeAction(v, { type: 'inbox.clear', itemId: 'gone' }), { do: 'none' });
});
