// Tests for live work on the phone (web/link.js: state.work, and work.stop / work.pause / work.note).
// Run: node --test tests/web/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const L = require('../../web/link.js');

const agents = [
  { name: 'Nova', role: 'Team lead', color: '#F5B83D', lead: true, status: 'working', activity: 'Running: npm test' },
  { name: 'Quill', role: 'Writer', color: '#3D9BE9', status: 'done', activity: 'Done' },
  { name: 'Tide', role: 'Tester', color: '#3FD0B0', status: 'idle', activity: '' },
];
const T0 = Date.UTC(2026, 10, 25, 9, 0, 0);

const novaJob = {
  name: 'Nova', title: 'Fix the login bug.', from: 'Storm', state: 'working', startedAt: T0, now: 'Running: npm test', askId: 'r1',
  tools: [
    { title: 'Reading: login.js', name: 'Read', status: 'ok', command: '', out: '', file: 'C:\\app\\login.js' },
    { title: 'Editing: login.js', name: 'Edit', status: 'ok', command: '', out: '', file: 'C:\\app\\login.js' },
    { title: 'Running: npm test', name: 'Bash', status: 'running', command: 'npm test', out: '', file: '' },
  ],
};
const quillJob = {
  name: 'Quill', title: 'Routine: Morning notes', from: 'Routine', state: 'done', startedAt: T0 - 60000, now: 'Done',
  tools: [
    { title: 'Running: git status', name: 'Bash', status: 'error', command: 'git status', out: 'line 1\n\nfatal: not a git repository\n', file: '' },
    { title: 'Writing: notes.md', name: 'Write', status: 'ok', command: '', out: '', file: 'notes.md' },
    { title: 'Editing: notes.md', name: 'Edit', status: 'error', command: '', out: '', file: 'notes.md' },
  ],
};

function view(extra) {
  return Object.assign({
    agents, lead: 'Nova',
    chats: [
      { id: 'dm:Nova', kind: 'dm', name: 'Nova', members: ['Nova'], unread: 0, typing: [], messages: [] },
      { id: 'dm:Quill', kind: 'dm', name: 'Quill', members: ['Quill'], unread: 0, typing: [], messages: [] },
    ],
    approvals: [],
    work: [quillJob, novaJob],
  }, extra || {});
}

test('state.work has each job, running ones first, built only from the real tool calls', () => {
  const st = L.buildState(view());
  assert.deepEqual(st.work.map(w => w.id), ['work-chief', 'work-quill']);
  const nova = st.work[0];
  assert.equal(nova.botId, 'chief');
  assert.equal(nova.title, 'Fix the login bug.');
  assert.equal(nova.from, 'Storm');
  assert.equal(nova.startedAt, '2026-11-25T09:00:00.000Z');
  assert.equal(nova.now, 'Running: npm test');
  assert.equal(nova.askId, undefined);   // only a waiting job points at its question
  assert.deepEqual(nova.steps.map(s => [s.title, s.state]), [['Reading: login.js', 'done'], ['Editing: login.js', 'done'], ['Running: npm test', 'now']]);
  assert.deepEqual(nova.steps[2].lines, [{ text: '$ npm test', kind: 'cmd' }]);
  assert.deepEqual(nova.terminal, [{ text: '$ npm test', kind: 'cmd' }]);
  assert.deepEqual(nova.files, [{ path: 'C:\\app\\login.js', change: 'Edited', edited: true }]);   // a read isn't a change

  const quill = st.work[1];
  assert.equal(quill.state, 'done');
  assert.deepEqual(quill.terminal, [{ text: '$ git status', kind: 'cmd' }, { text: 'line 1', kind: 'err' }, { text: 'fatal: not a git repository', kind: 'err' }]);
  assert.deepEqual(quill.files, [{ path: 'notes.md', change: 'Edited', edited: false }]);   // one row per file, the newest change
  assert.equal(quill.steps[2].lines.at(-1).text, 'That step failed.');
});

test('no jobs means no work list, and odd input is cleaned up', () => {
  assert.equal('work' in L.buildState(view({ work: [] })), false);
  assert.equal('work' in L.buildState(view({ work: undefined })), false);
  const st = L.buildState(view({ work: [
    { name: 'Ghost', title: 'x', state: 'working' },                       // not on the team
    { name: 'Tide', title: '', state: 'exploding', startedAt: 'never' },   // unknown state and a bad time
    { name: 'Tide', title: 'twice', state: 'working' },                    // one job per bot
    { name: 'Nova', title: 'Asks', state: 'waiting', askId: 'r9', tools: [{ title: 'Running: rm -rf build', name: 'Bash', status: 'running', command: 'rm -rf build', out: Array.from({ length: 12 }, (_, i) => 'out ' + i).join('\n') }] },
  ] }));
  assert.deepEqual(st.work.map(w => [w.botId, w.state, w.title]), [['tide', 'working', 'Working'], ['chief', 'waiting', 'Asks']]);
  assert.equal(st.work[0].startedAt, undefined);
  assert.equal(st.work[1].askId, 'r9');
  const lines = st.work[1].steps[0].lines;
  assert.equal(lines[1].text, '… 4 more lines');
  assert.equal(lines.at(-1).text, 'out 11');
  assert.equal(lines.length, 10);   // the command, the count, and the last 8 lines
});

test('Stop, Pause and a note find the bot by its job', () => {
  const v = view({ work: [novaJob, quillJob, Object.assign({}, novaJob, { name: 'Tide', state: 'paused' })] });
  assert.deepEqual(L.routeAction(v, { type: 'work.stop', workId: 'work-chief' }), { do: 'workStop', name: 'Nova' });
  assert.deepEqual(L.routeAction(v, { type: 'work.pause', workId: 'work-chief', paused: true }), { do: 'workPause', name: 'Nova', paused: true });
  assert.deepEqual(L.routeAction(v, { type: 'work.pause', workId: 'work-chief', paused: false }), { do: 'none' });   // it isn't paused
  assert.deepEqual(L.routeAction(v, { type: 'work.pause', workId: 'work-tide', paused: false }), { do: 'workPause', name: 'Tide', paused: false });
  assert.deepEqual(L.routeAction(v, { type: 'work.stop', workId: 'work-tide' }), { do: 'workStop', name: 'Tide' });   // a paused job can be stopped
  assert.equal(L.routeAction(v, { type: 'work.pause', workId: 'work-chief', paused: 'yes' }).error, 'Pause has to be on or off.');
  assert.equal(L.routeAction(v, { type: 'work.stop', workId: 'work-quill' }).error, 'That job has already finished.');
  assert.equal(L.routeAction(v, { type: 'work.stop', workId: 'work-ghost' }).error, 'That job has already finished.');
  assert.equal(L.routeAction(v, { type: 'work.stop' }).error, 'That job has already finished.');

  const note = L.routeAction(v, { type: 'work.note', workId: 'work-quill', text: '  Also add a title  ' });   // a just-finished job's bot still hears it
  assert.equal(note.do, 'send');
  assert.equal(note.chat.id, 'dm:Quill');
  assert.equal(note.text, 'Also add a title');
  assert.equal(L.routeAction(v, { type: 'work.note', workId: 'work-quill', text: ' ' }).error, 'There’s nothing to send.');
  assert.equal(L.routeAction(v, { type: 'work.note', workId: 'work-ghost', text: 'hi' }).error, 'That job has finished.');
});

function wired(hooksExtra) {
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
  const sent = [];
  globalThis.window = globalThis.window || globalThis;
  L.wire(Object.assign({
    S, Bridge, esc: s => String(s),
    phoneMessages: () => [], typingIn: () => [],
    send: (c, text) => { sent.push([c.id, text]); return true; }, note() { }, markRead() { }, clear() { },
    answer: async () => ({ ok: true }), group: () => null,
    openSettings() { }, closeModal() { }, sfx() { },
  }, hooksExtra));
  const ask = async body => {
    const rid = 'x' + calls.length;
    listeners.linkAsk[0]({ rid, kind: 'action', body });
    await new Promise(r => setTimeout(r, 20));
    return calls.find(c => c[1].do === 'answer' && c[1].rid === rid)[1].result;
  };
  return { calls, sent, ask };
}

test('wired to a window, the phone stops, pauses and messages a job', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const jobs = [Object.assign({}, novaJob)];
  const did = [];
  const { calls, sent, ask } = wired({
    work: {
      list: () => jobs,
      stop: name => { did.push(['stop', name]); jobs[0].state = 'stopped'; return true; },
      pause: (name, on) => { did.push(['pause', name, on]); if (!on) return 'It’s busy in that chat right now. Try again in a moment.'; jobs[0].state = 'paused'; return true; },
    },
  });
  await new Promise(r => setTimeout(r, 20));

  assert.deepEqual(await ask({ type: 'work.pause', workId: 'work-chief', paused: true }), { ok: true });
  assert.equal(calls.filter(c => c[1].do === 'state').at(-1)[1].data.work[0].state, 'paused');   // the new state went out first
  assert.deepEqual(await ask({ type: 'work.pause', workId: 'work-chief', paused: false }), { ok: false, error: 'It’s busy in that chat right now. Try again in a moment.' });
  assert.deepEqual(await ask({ type: 'work.note', workId: 'work-chief', text: 'Use the new API' }), { ok: true });
  assert.deepEqual(sent, [['dm:Nova', 'Use the new API']]);
  assert.deepEqual(await ask({ type: 'work.stop', workId: 'work-chief' }), { ok: true });
  assert.deepEqual(await ask({ type: 'work.stop', workId: 'work-chief' }), { ok: false, error: 'That job has already finished.' });
  assert.deepEqual(did, [['pause', 'Nova', true], ['pause', 'Nova', false], ['stop', 'Nova']]);
});

test('a window that sends no jobs has nothing to stop', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { ask } = wired({});
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(await ask({ type: 'work.stop', workId: 'work-chief' }), { ok: false, error: 'That job has already finished.' });
});
