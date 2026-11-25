// Tests for Summaries and Catch up from the phone: summary.message, summary.catchUp and state.summaries.
// Run: node --test tests/web/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const L = require('../../web/link.js');
const U = globalThis.SquallSummaries;

const long = 'The leaderboard now saves to a DataStore. '.repeat(20);
function makeView() {
  return {
    agents: [{ name: 'Nova', lead: true }, { name: 'Quill' }],
    lead: 'Nova',
    chats: [
      {
        id: 'dm:Quill', kind: 'dm', name: 'Quill', members: ['Quill'], raw: { id: 'dm:Quill' }, messages: [
          { id: 'm1', who: 'Storm', kind: 'msg', text: 'Make the leaderboard save' },
          { id: 'm2', who: 'Quill', kind: 'msg', text: long },
          { id: 'm3', who: 'Quill', kind: 'msg', text: 'Done!' },
          { id: 'm4', who: 'Squall', kind: 'event', text: 'Quill joined' },
          { who: 'Quill', kind: 'msg', text: long + ' and the shop too.' },
        ],
      },
      { id: 'dm:Nova', kind: 'dm', name: 'Nova', members: ['Nova'], raw: { id: 'dm:Nova' }, messages: [] },
    ],
  };
}

// a summarize that waits until the test lets it finish
function fakeOps() {
  const calls = [];
  const saved = [];
  return {
    calls, saved,
    summarize: text => new Promise((ok, no) => calls.push({ text, ok, no })),
    save: (c, id, s) => saved.push([c.id, id, s]),
  };
}
const tick = () => new Promise(r => setTimeout(r, 0));

test('summaryRoute checks the chat and the message', () => {
  const v = makeView();
  assert.equal(U.summaryRoute(v, { type: 'chat.send' }), null);
  assert.equal(U.summaryRoute(v, { type: 'summary.message', chatId: 'ghost', messageId: 'm2' }).error, 'That chat isn’t on the computer any more.');
  assert.equal(U.summaryRoute(v, { type: 'summary.message', chatId: 'quill', messageId: 'zz' }).error, 'That message isn’t in the chat any more.');
  assert.equal(U.summaryRoute(v, { type: 'summary.message', chatId: 'quill', messageId: 'm1' }).error, 'Only a teammate’s message can be summarized.');
  assert.equal(U.summaryRoute(v, { type: 'summary.message', chatId: 'quill', messageId: 'm3' }).error, 'That message is already short.');
  const r = U.summaryRoute(v, { type: 'summary.message', chatId: 'quill', messageId: 'm2' });
  assert.equal(r.do, 'message');
  assert.equal(r.text, long);
  assert.equal(r.messageId, 'm2');
  // a live session line with no id is found by the id the phone was given
  const phoneId = L.phoneMessages(v.chats[0].messages, () => 'quill').at(-1).id;
  assert.match(phoneId, /^h/);
  assert.equal(U.summaryRoute(v, { type: 'summary.message', chatId: 'quill', messageId: phoneId }).do, 'message');
  assert.equal(U.summaryRoute(v, { type: 'summary.catchUp', chatId: 'chief' }).error, 'There’s nothing to catch up on in this chat yet.');
});

test('catchUpText takes the latest messages, skips events and keeps the newest when it is long', () => {
  const v = makeView();
  const c = U.catchUpText(v.chats[0].messages);
  assert.equal(c.count, 4);
  assert.equal(c.upTo, L.phoneMessages(v.chats[0].messages, () => 'quill').at(-1).id);   // the newest line has no id: the phone's id for it
  assert.ok(c.text.startsWith('Storm: Make the leaderboard save\nQuill: '));
  assert.ok(!c.text.includes('joined'));
  const many = Array.from({ length: 50 }, (_, i) => ({ id: 'x' + i, who: 'Quill', kind: 'msg', text: 'line ' + i }));
  const m = U.catchUpText(many);
  assert.equal(m.count, U.CATCH_MAX);
  assert.equal(m.upTo, 'x49');
  assert.ok(m.text.endsWith('Quill: line 49'));
  assert.equal(U.catchUpText([]), null);
});

test('a message summary runs in the background and comes back in the state', async () => {
  const ops = fakeOps();
  let changed = 0, t = 1000;
  const desk = U.summaryDesk(() => ops, () => changed++, () => t);
  const v = makeView();
  const r = U.summaryRoute(v, { type: 'summary.message', chatId: 'quill', messageId: 'm2' });
  assert.deepEqual(desk.run(r), { ok: true });
  assert.deepEqual(desk.run(r), { ok: true });   // the same one again doesn't start a second job
  assert.equal(ops.calls.length, 1);
  let state = U.withSummaries(L.buildState(v), desk.view());
  assert.deepEqual(state.summaries.jobs, [{ chatId: 'quill', messageId: 'm2', state: 'working' }]);
  ops.calls[0].ok('  It saves now.  ');
  await tick(); await tick();
  assert.equal(changed, 1);
  assert.deepEqual(ops.saved, [['dm:Quill', 'm2', 'It saves now.']]);
  state = U.withSummaries(L.buildState(v), desk.view());
  assert.deepEqual(state.summaries.jobs, []);
  assert.equal(state.chats.quill.find(m => m.id === 'm2').summary, 'It saves now.');
  assert.equal(state.chats.quill.find(m => m.id === 'm3').summary, undefined);
  // already done: no new job
  assert.deepEqual(desk.run(r), { ok: true });
  assert.equal(ops.calls.length, 1);
});

test('a catch up, a failure, the job limit and a missing computer', async () => {
  const ops = fakeOps();
  let t = Date.parse('2026-11-25T10:00:00.000Z');
  const desk = U.summaryDesk(() => ops, () => { }, () => t);
  const v = makeView();
  const catchUp = U.summaryRoute(v, { type: 'summary.catchUp', chatId: 'quill' });
  const msg = U.summaryRoute(v, { type: 'summary.message', chatId: 'quill', messageId: 'm2' });
  const live = U.summaryRoute(v, { type: 'summary.message', chatId: 'quill', messageId: L.phoneMessages(v.chats[0].messages, () => 'quill').at(-1).id });
  assert.deepEqual(desk.run(catchUp), { ok: true });
  assert.deepEqual(desk.run(msg), { ok: true });
  assert.equal(desk.run(live).error, 'Squall is already writing a summary. Try again in a moment.');
  ops.calls[0].ok('Quill made the leaderboard save.');
  ops.calls[1].no(new Error('Not signed in.'));
  await tick(); await tick();
  let state = U.withSummaries(L.buildState(v), desk.view());
  assert.deepEqual(state.summaries.catchUps, [{ chatId: 'quill', text: 'Quill made the leaderboard save.', at: '2026-11-25T10:00:00.000Z', upTo: L.phoneMessages(v.chats[0].messages, () => 'quill').at(-1).id, count: 4 }]);
  assert.deepEqual(state.summaries.jobs, [{ chatId: 'quill', messageId: 'm2', state: 'failed', error: 'Not signed in.' }]);
  // a failed job leaves after two minutes, a catch up after twelve hours
  t += 3 * 60000;
  state = U.withSummaries(L.buildState(v), desk.view());
  assert.deepEqual(state.summaries.jobs, []);
  t += 12 * 3600000;
  state = U.withSummaries(L.buildState(v), desk.view());
  assert.deepEqual(state.summaries.catchUps, []);
  // an empty answer is a failure
  desk.run(msg);
  ops.calls[2].ok('   ');
  await tick(); await tick();
  assert.equal(desk.view().jobs[0].error, 'The summary came back empty.');
  // no summarize on this computer
  const none = U.summaryDesk(() => null, () => { }, () => t);
  assert.equal(none.run(msg).ok, false);
  assert.equal(none.run({ error: 'nope' }).error, 'nope');
});

test('phoneMessages passes on a saved summary for teammate messages only', () => {
  const out = L.phoneMessages([
    { id: 'a', who: 'Quill', kind: 'msg', text: 'Hi', summary: 'Said hi.' },
    { id: 'b', who: 'Storm', kind: 'msg', text: 'Yo', summary: 'nope' },
  ], () => 'quill');
  assert.equal(out[0].summary, 'Said hi.');
  assert.equal(out[1].summary, undefined);
});
