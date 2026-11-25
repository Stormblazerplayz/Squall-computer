// Tests for web/link.js (the window's half of the phone link). Run: node --test tests/web/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const L = require('../../web/link.js');

const agents = [
  { name: 'Nova', role: 'Team lead', color: '#F5B83D', lead: true, status: 'working', activity: 'Planning the day' },
  { name: 'Quill', role: 'Writer', color: '#3D9BE9', status: 'idle', activity: 'Ready' },
  { name: 'Chief', role: 'Helper', color: 'blue', status: 'error', activity: '' },
  { name: 'Ä Bot', role: '', color: '#123456', status: 'done', activity: '' },
];

function view(extra) {
  return Object.assign({
    agents,
    lead: 'Nova',
    chats: [
      { id: 'dm:Nova', kind: 'dm', name: 'Nova', members: ['Nova'], unread: 2, typing: [], messages: [
        { id: 'm1', who: 'Storm', kind: 'msg', text: 'Hi', at: '2026-11-15T10:00:00.000Z' },
        { id: 'm2', who: 'Nova', kind: 'msg', text: 'Hey Storm', at: '2026-11-15T10:00:05.000Z' },
        { id: 'm3', who: 'Squall', kind: 'event', text: 'Nova was renamed.' },
        { id: 'm4', who: 'Nova', kind: 'error', text: 'Claude stopped.' },
      ] },
      { id: 'dm:Quill', kind: 'dm', name: 'Quill', members: ['Quill'], unread: 0, typing: ['Quill'], messages: [] },
      { id: 'team', kind: 'team', name: 'Team', members: ['Nova', 'Quill', 'Chief', 'Ä Bot'], unread: 0, typing: [], messages: [] },
      { id: 'g:abc', kind: 'group', name: 'Build crew', members: ['Quill', 'Chief'], unread: 0, typing: [], messages: [] },
    ],
    approvals: [
      { requestId: 'r1', who: 'Quill', tool: 'Bash', detail: 'git status', text: 'Can I check git?', at: '2026-11-15T10:01:00.000Z' },
      { requestId: 'r1', who: 'Quill', tool: 'Bash', detail: 'git status', text: 'Can I check git?' },
      { requestId: 'r2', who: 'Ghost', tool: 'Bash', detail: 'rm', text: '' },
    ],
  }, extra || {});
}

test('the lead is always "chief" and every other bot gets a unique id', () => {
  const ids = L.botIds(agents, 'Nova');
  assert.equal(ids.Nova, 'chief');
  assert.equal(ids.Quill, 'quill');
  assert.equal(ids.Chief, 'chief-2');   // a bot really called Chief can't take the lead's id
  assert.equal(ids['Ä Bot'], 'a-bot');
  const dup = L.botIds([{ name: 'Lead' }, { name: 'A b' }, { name: 'a-b' }], 'Lead');
  assert.deepEqual(Object.values(dup).sort(), ['a-b', 'a-b-2', 'chief']);
});

test('the state has bots, chats, groups and the inbox from Squall, and nothing made up', () => {
  const st = L.buildState(view());
  assert.equal(st.bots[0].id, 'chief');
  const chief = st.bots[0];
  assert.equal(chief.name, 'Nova');
  assert.equal(chief.status, 'working');
  assert.equal(chief.task, 'Planning the day');
  assert.equal(chief.unread, 2);
  const quill = st.bots.find(b => b.id === 'quill');
  assert.equal(quill.status, 'waiting');      // it waits for an OK
  assert.equal(quill.task, undefined);        // "Ready" isn't a task
  assert.equal(st.bots.find(b => b.id === 'chief-2').color, '#A78BFA');   // not a #RRGGBB color
  assert.equal(st.typing, 'quill');

  const msgs = st.chats.chief;
  assert.deepEqual(msgs.map(m => m.kind), ['me', 'bot', 'system', 'error']);
  assert.equal(msgs[1].author, 'chief');
  assert.equal(msgs[0].at, '2026-11-15T10:00:00.000Z');
  assert.deepEqual(st.chats.quill, []);
  assert.ok('team' in st.chats && 'g:abc' in st.chats);

  const team = st.groups.find(g => g.id === 'team');
  assert.equal(team.name, 'Team');
  assert.equal(team.members.length, 4);
  const crew = st.groups.find(g => g.id === 'g:abc');
  assert.deepEqual(crew.members, ['quill', 'chief-2']);
  assert.equal(crew.chiefLeads, false);

  assert.equal(st.inbox.length, 1);           // the same ask once, and not one from a bot that's gone
  assert.equal(st.inbox[0].id, 'r1');
  assert.equal(st.inbox[0].botId, 'quill');
  assert.equal(st.inbox[0].title, 'Quill wants to run a command');
  assert.equal(st.inbox[0].command, 'git status');

  for (const k of ['routines', 'work', 'handoffs', 'claudeCode', 'paused']) assert.equal(k in st, false);
  assert.equal(typeof st.version, 'string');
});

test('the version changes only when something changes', () => {
  const a = L.buildState(view()).version;
  assert.equal(L.buildState(view()).version, a);
  const v = view();
  v.chats[0].messages.push({ id: 'm5', who: 'Nova', kind: 'msg', text: 'More' });
  assert.notEqual(L.buildState(v).version, a);
});

test('lines without ids get stable ids, and long text is cut', () => {
  const list = [{ who: 'Nova', kind: 'msg', text: 'same' }, { who: 'Nova', kind: 'msg', text: 'same' }, { who: 'Nova', kind: 'msg', text: 'x'.repeat(5000) }];
  const a = L.phoneMessages(list, () => 'chief'), b = L.phoneMessages(list, () => 'chief');
  assert.deepEqual(a.map(m => m.id), b.map(m => m.id));
  assert.notEqual(a[0].id, a[1].id);
  assert.ok(a[2].text.length <= 4001);
  const many = Array.from({ length: 100 }, (_, i) => ({ id: 'x' + i, who: 'Storm', kind: 'msg', text: String(i) }));
  const out = L.phoneMessages(many, () => null);
  assert.equal(out.length, 60);
  assert.equal(out[59].text, '99');
});

test('phone actions map to the right chat or approval', () => {
  const v = view();
  let r = L.routeAction(v, { type: 'chat.send', chatId: 'chief', text: '  hello  ' });
  assert.equal(r.do, 'send'); assert.equal(r.chat.id, 'dm:Nova'); assert.equal(r.text, 'hello');
  r = L.routeAction(v, { type: 'chat.send', chatId: 'g:abc', text: 'hi crew' });
  assert.equal(r.chat.id, 'g:abc');
  assert.ok(L.routeAction(v, { type: 'chat.send', chatId: 'chief', text: '   ' }).error);
  assert.ok(L.routeAction(v, { type: 'chat.send', chatId: 'nobody', text: 'x' }).error);
  assert.equal(L.routeAction(v, { type: 'chat.read', chatId: 'quill' }).chat.id, 'dm:Quill');
  assert.equal(L.routeAction(v, { type: 'chat.clear', chatId: 'team' }).chat.id, 'team');
  assert.equal(L.routeAction(v, { type: 'chat.clearAll' }).do, 'clearAll');

  r = L.routeAction(v, { type: 'inbox.answer', itemId: 'r1', answer: 'allow' });
  assert.deepEqual([r.do, r.requestId, r.decision], ['answer', 'r1', 'once']);
  assert.equal(L.routeAction(v, { type: 'inbox.answer', itemId: 'r1', answer: 'deny' }).decision, 'deny');
  assert.ok(L.routeAction(v, { type: 'inbox.answer', itemId: 'r1', answer: 'maybe' }).error);
  assert.ok(L.routeAction(v, { type: 'inbox.answer', itemId: 'gone', answer: 'allow' }).error);

  r = L.routeAction(v, { type: 'group.create', name: 'Duo', members: ['quill', 'chief', 'nope'] });
  assert.deepEqual(r.members, ['Quill', 'Nova']);
  assert.ok(L.routeAction(v, { type: 'group.create', name: 'Empty', members: [] }).error);

  for (const t of ['bot.create', 'work.stop', 'routine.save', 'team.pause', 'claudeCode.update', '', undefined])
    assert.equal(L.routeAction(v, { type: t }).error, 'Squall on the computer can’t do that yet.');
});

test('what Chief says on a call is short and speakable', () => {
  assert.equal(L.speakable('**Done.** See `app.js` and [the docs](http://x).'), 'Done. See app.js and the docs.');
  assert.match(L.speakable('Here:\n```js\nlet a = 1;\n```\nThat is it.'), /I put the code in the chat/);
  const long = ('This is a sentence. ').repeat(60);
  const s = L.speakable(long);
  assert.ok(s.length < 700);
  assert.match(s, /The rest is in the chat\.$/);
});

test('wire does nothing without the host', () => {
  assert.doesNotThrow(() => L.wire({ Bridge: { host: false } }));
  assert.doesNotThrow(() => L.wire(null));
});

test('wired to a window, it answers the phone through the host', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });   // the 2-second state push is driven by hand below
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
  const nova = { id: 'dm:Nova', kind: 'dm', name: 'Nova', members: ['Nova'], unread: 0, messages: [] };
  const S = { agents: agents.slice(0, 2), lead: { name: 'Nova' }, chats: [nova] };
  const sent = [];
  let reply = null;
  globalThis.window = globalThis.window || globalThis;
  L.wire({
    S, Bridge, esc: s => String(s),
    phoneMessages: c => c.messages.map(m => ({ id: m.id, who: m.who, kind: 'msg', text: m.text })),
    typingIn: () => [],
    send: (c, text, call) => { sent.push([c.id, text, call]); c.messages.push({ id: 'u' + c.messages.length, who: 'Storm', text }); if (reply) setTimeout(() => c.messages.push(reply), 10); return true; },
    note: (c, text) => c.messages.push({ id: 'n', who: 'Squall', text }),
    markRead: c => { c.unread = 0; }, clear: c => { c.messages = []; },
    answer: async () => ({ ok: true }), group: () => ({ id: 'g:new' }),
    openSettings() { }, closeModal() { }, sfx() { },
  });
  await new Promise(r => setTimeout(r, 20));
  t.mock.timers.tick(2000);
  await new Promise(r => setTimeout(r, 20));
  const state = calls.find(c => c[1].do === 'state');
  assert.ok(state, 'the state goes to the host');
  assert.equal(state[1].data.bots[0].id, 'chief');

  const answers = () => calls.filter(c => c[1].do === 'answer');
  listeners.linkAsk[0]({ rid: 'a1', kind: 'action', body: { type: 'chat.send', chatId: 'chief', text: 'hi' } });
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(sent[0], ['dm:Nova', 'hi', false]);
  assert.deepEqual(answers()[0][1], { do: 'answer', rid: 'a1', result: { ok: true } });

  listeners.linkAsk[0]({ rid: 'a2', kind: 'action', body: { type: 'work.stop' } });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(answers()[1][1].result.ok, false);

  listeners.linkAsk[0]({ rid: 'v1', kind: 'voice', body: { event: 'start', text: '' } });
  await new Promise(r => setTimeout(r, 20));
  assert.match(answers()[2][1].result.text, /^Hi Storm, it’s Nova/);

  reply = { id: 'r9', who: 'Nova', text: 'All **good**, bye for now.' };
  listeners.linkAsk[0]({ rid: 'v2', kind: 'voice', body: { event: 'turn', text: 'How is it going? Bye!' } });
  await new Promise(r => setTimeout(r, 900));
  const v = answers()[3][1];
  assert.equal(v.rid, 'v2');
  assert.deepEqual(v.result, { text: 'All good, bye for now.', endCall: true });
  assert.deepEqual(sent[1], ['dm:Nova', 'How is it going? Bye!', true]);

  listeners.linkAsk[0]({ rid: '', kind: 'voiceEnd', body: { seconds: 75, phone: 'Storm’s iPad' } });
  assert.equal(nova.messages.at(-1).text, 'Call from Storm’s iPad ended (1 min 15 s).');
});

test('the desktop version goes to the phone only when the updater knows it', () => {
  assert.equal('desktop' in L.buildState(view()), false);
  let st = L.buildState(view({ desktop: { current: '1.4.0', ready: null, busy: false } }));
  assert.deepEqual(st.desktop, { version: '1.4.0', updating: false });
  st = L.buildState(view({ desktop: { current: '1.4.0', ready: '1.5.0', busy: true } }));
  assert.deepEqual(st.desktop, { version: '1.4.0', updating: true, latest: '1.5.0' });
});

// ---------------------------------------------------------------- the To do list on the phone

const todoItems = () => [
  { id: 't1', text: '  Fix the jump sound  ', status: 'doing', by: 'Storm', who: 'Quill', at: '2026-11-25T08:00:00.000Z' },
  { id: 't2', text: 'Check the build', status: 'todo', by: 'Nova', needs: 'Your decision on the menu', needsBy: 'Nova', at: '2026-11-25T08:01:00.000Z' },
  { id: 't3', text: 'Ask Laptop about the save file', status: 'doing', by: 'Laptop', who: 'Laptop' },
  { id: 't4', text: 'Old job', status: 'done', who: 'Quill', doneAt: '2026-11-24T10:00:00.000Z', needs: 'gone' },
  { id: 't5', text: 'Newer job', status: 'done', doneAt: '2026-11-25T07:00:00.000Z' },
  { id: 't6', text: '   ', status: 'todo' },
  { id: 't7', text: 'Odd status', status: 'later' },
  null,
];

test('the To do list goes to the phone only when Squall has one', () => {
  assert.equal('todo' in L.buildState(view()), false);
  const st = L.buildState(view({ todo: todoItems() }));
  const ids = st.todo.items.map(i => i.id);
  assert.deepEqual(ids, ['t1', 't2', 't3', 't7', 't5', 't4']);   // open in Squall's order, then the newest done first; blank ones dropped
  const [t1, t2, t3, t7, t5, t4] = st.todo.items;
  assert.deepEqual(t1, { id: 't1', text: 'Fix the jump sound', status: 'doing', by: 'Storm', who: 'Quill', botId: 'quill', at: '2026-11-25T08:00:00.000Z' });
  assert.equal(t2.needs, 'Your decision on the menu');
  assert.equal(t2.needsBy, 'chief');            // Nova leads, so her id is chief
  assert.equal(t3.who, 'Laptop');               // a live session isn't a bot: a name, no id
  assert.equal(t3.botId, undefined);
  assert.equal(t7.status, 'todo');              // an unknown status reads as not started
  assert.equal(t5.doneAt, '2026-11-25T07:00:00.000Z');
  assert.equal(t4.needs, undefined);            // a finished one needs nobody
  const many = Array.from({ length: 30 }, (_, n) => ({ id: 'd' + n, text: 'Done ' + n, status: 'done', doneAt: new Date(Date.UTC(2026, 10, 1, 0, n)).toISOString() }));
  const done = L.buildState(view({ todo: many })).todo.items;
  assert.equal(done.length, 12);
  assert.equal(done[0].id, 'd29');
  assert.equal(L.buildState(view({ todo: [] })).todo.items.length, 0);   // an empty list is still a list
});

test('the phone keeps the To do list: add, tick, give to a bot, remove, clear done', () => {
  const v = view({ todo: todoItems() });
  assert.deepEqual(L.routeAction(view(), { type: 'todo.add', text: 'x' }), { error: 'Update Squall on the computer to use the To do list from your phone.' });
  assert.deepEqual(L.routeAction(v, { type: 'todo.add', text: '  Clean   up   the  menu ' }), { do: 'todoAdd', text: 'Clean up the menu', bot: null, chat: null });
  assert.ok(L.routeAction(v, { type: 'todo.add', text: '   ' }).error);
  assert.equal(L.routeAction(v, { type: 'todo.add', text: 'x'.repeat(500) }).text.length, 300);
  const given = L.routeAction(v, { type: 'todo.add', text: 'Write the notes', botId: 'quill' });
  assert.equal(given.bot, 'Quill');
  assert.equal(given.chat.id, 'dm:Quill');
  assert.ok(L.routeAction(v, { type: 'todo.add', text: 'x', botId: 'ghost' }).error);

  assert.deepEqual(L.routeAction(v, { type: 'todo.set', itemId: 't2', status: 'done' }), { do: 'todoSet', id: 't2', status: 'done' });
  assert.ok(L.routeAction(v, { type: 'todo.set', itemId: 't2', status: 'maybe' }).error);
  assert.deepEqual(L.routeAction(v, { type: 'todo.set', itemId: 'nope', status: 'done' }), { error: 'That to-do isn’t on the list any more.' });
  assert.deepEqual(L.routeAction(v, { type: 'todo.delete', itemId: 't4' }), { do: 'todoDel', id: 't4' });
  assert.deepEqual(L.routeAction(v, { type: 'todo.clearDone' }), { do: 'todoClearDone' });

  const give = L.routeAction(v, { type: 'todo.give', itemId: 't2', botId: 'chief' });
  assert.equal(give.do, 'todoGive');
  assert.equal(give.bot, 'Nova');
  assert.equal(give.chat.id, 'dm:Nova');
  assert.match(give.text, /\[t2\]: Check the build/);
  assert.match(give.text, /todo_doing/);
  assert.match(give.text, /todo_done/);
  assert.ok(L.routeAction(v, { type: 'todo.give', itemId: 't4', botId: 'quill' }).error);    // already done
  assert.ok(L.routeAction(v, { type: 'todo.give', itemId: 't2', botId: 'ghost' }).error);
});

test('wired to a window, the phone changes the real To do list', async (t) => {
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
  const nova = { id: 'dm:Nova', kind: 'dm', name: 'Nova', members: ['Nova'], unread: 0, messages: [] };
  const quill = { id: 'dm:Quill', kind: 'dm', name: 'Quill', members: ['Quill'], unread: 0, messages: [] };
  const S = { agents: agents.slice(0, 2), lead: { name: 'Nova' }, chats: [nova, quill] };
  // a stand-in for app.js's TODO list and its functions
  let items = [{ id: 't1', text: 'Fix the jump sound', status: 'todo', by: 'Storm' }, { id: 't2', text: 'Old', status: 'done' }];
  let n = 0, busy = false;
  const sent = [];
  globalThis.window = globalThis.window || globalThis;
  L.wire({
    S, Bridge, esc: s => String(s),
    phoneMessages: c => c.messages.map(m => ({ id: m.id, who: m.who, kind: 'msg', text: m.text })),
    typingIn: () => [],
    send: (c, text) => { if (busy) return false; sent.push([c.id, text]); return true; },
    note() { }, markRead() { }, clear() { }, answer: async () => ({ ok: true }), group: () => null,
    openSettings() { }, closeModal() { }, sfx() { },
    todo: {
      items: () => items,
      add: (text, by) => { const it = { id: 'n' + (++n), text, status: 'todo', by }; items.push(it); return it; },
      set: (id, status, who) => { const it = items.find(x => x.id === id); if (!it) return false; it.status = status; if (who) it.who = who; return true; },
      del: id => { const had = items.some(x => x.id === id); items = items.filter(x => x.id !== id); return had; },
      clearDone: () => { items = items.filter(x => x.status !== 'done'); },
    },
  });
  await new Promise(r => setTimeout(r, 20));
  t.mock.timers.tick(2000);
  await new Promise(r => setTimeout(r, 20));
  const state = calls.find(c => c[1].do === 'state');
  assert.deepEqual(state[1].data.todo.items.map(i => i.id), ['t1', 't2']);

  const answers = () => calls.filter(c => c[1].do === 'answer').map(c => c[1].result);
  const ask = async body => { listeners.linkAsk[0]({ rid: 'r' + Math.random(), kind: 'action', body }); await new Promise(r => setTimeout(r, 20)); return answers().at(-1); };

  assert.deepEqual(await ask({ type: 'todo.add', text: 'Write the notes' }), { ok: true, id: 'n1' });
  assert.equal(items.at(-1).by, 'Storm');
  assert.equal(sent.length, 0);

  assert.deepEqual(await ask({ type: 'todo.add', text: 'Polish the menu', botId: 'quill' }), { ok: true, id: 'n2' });
  assert.equal(sent[0][0], 'dm:Quill');
  assert.match(sent[0][1], /\[n2\]: Polish the menu/);
  assert.equal(items.find(x => x.id === 'n2').status, 'doing');
  assert.equal(items.find(x => x.id === 'n2').who, 'Quill');

  assert.deepEqual(await ask({ type: 'todo.give', itemId: 't1', botId: 'chief' }), { ok: true });
  assert.equal(sent[1][0], 'dm:Nova');
  assert.equal(items.find(x => x.id === 't1').who, 'Nova');

  busy = true;   // the bot can't take a message now: the item stays as it was
  items.find(x => x.id === 'n1').status = 'todo';
  const r = await ask({ type: 'todo.give', itemId: 'n1', botId: 'quill' });
  assert.equal(r.ok, false);
  assert.equal(items.find(x => x.id === 'n1').status, 'todo');
  const added = await ask({ type: 'todo.add', text: 'One more', botId: 'quill' });
  assert.equal(added.ok, false);                     // added, but Quill wasn't told: says so
  assert.equal(items.find(x => x.id === added.id).status, 'todo');
  busy = false;

  assert.deepEqual(await ask({ type: 'todo.set', itemId: 'n1', status: 'done' }), { ok: true });
  assert.equal(items.find(x => x.id === 'n1').status, 'done');
  assert.deepEqual(await ask({ type: 'todo.delete', itemId: 'n2' }), { ok: true });
  assert.equal(items.some(x => x.id === 'n2'), false);
  assert.equal((await ask({ type: 'todo.delete', itemId: 'n2' })).ok, false);
  assert.deepEqual(await ask({ type: 'todo.clearDone' }), { ok: true });
  assert.equal(items.some(x => x.status === 'done'), false);
});
