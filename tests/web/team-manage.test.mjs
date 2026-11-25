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

test('project: the list, each teammate’s project and the bot.project action', async () => {
  const projects = [{ name: 'Squall', path: 'C:\\Users\\Storm\\Documents\\Projects\\Squall' }, { name: 'Farside', path: 'C:\\Users\\Storm\\Documents\\Projects\\Farside\\' },
    { name: 'Squall', path: 'C:\\dupe' }, { name: '', path: 'C:\\x' }, null];
  const v = view({ projects, agents: [{ name: 'Nova', lead: true }, { name: 'Quill', folder: 'c:\\users\\storm\\documents\\projects\\farside' }, { name: 'Rex', lead: true, folder: 'D:\\Games\\Odd' }] });
  assert.deepEqual(T.projectList(v).map(p => p.name), ['Squall', 'Farside']);
  const state = T.withTeam(L.buildState(v), v);
  const byId = Object.fromEntries(state.bots.map(b => [b.id, b]));
  assert.equal(byId.quill.project, 'Farside');
  assert.equal(byId.rex.project, 'Odd', 'a folder outside Projects shows its own name');
  assert.equal(byId.chief.project, undefined);
  assert.deepEqual(state.team.projects, ['Squall', 'Farside']);
  assert.equal(T.withTeam(L.buildState(view()), view()).team.projects, undefined, 'no list yet: the phone just shows the current project');

  assert.deepEqual(T.teamRoute(v, { type: 'bot.project', botId: 'quill', project: 'Squall' }), { do: 'project', name: 'Quill', path: 'C:\\Users\\Storm\\Documents\\Projects\\Squall' });
  assert.deepEqual(T.teamRoute(v, { type: 'bot.project', botId: 'quill', project: '' }), { do: 'project', name: 'Quill', path: null });
  assert.equal(T.teamRoute(v, { type: 'bot.project', botId: 'quill', project: 'Nope' }).error, 'That project isn’t on the computer any more.');

  const calls = [];
  const ops = { setFolder: async (name, path) => { calls.push([name, path]); return path || ''; } };
  assert.deepEqual(await T.teamDo({ do: 'project', name: 'Quill', path: null }, ops, async () => v), { ok: true });
  assert.deepEqual(calls, [['Quill', null]]);
  assert.equal((await T.teamDo({ do: 'project', name: 'Quill', path: null }, {}, async () => v)).ok, false);
});

test('projectCache reads the list once and tells about a change', async () => {
  let reads = 0, changes = 0;
  const ops = { projects: async () => { reads++; return [{ name: 'Squall', path: 'C:\\P\\Squall' }]; } };
  const cache = T.projectCache(() => ops, () => changes++);
  assert.equal(cache.list(), null);
  await cache.load();
  assert.deepEqual(cache.list(), [{ name: 'Squall', path: 'C:\\P\\Squall' }]);
  await cache.load();
  assert.equal(reads, 2);
  assert.equal(changes, 1, 'the same list again is no change');
  const none = T.projectCache(() => undefined, () => changes++);
  await none.load();
  assert.equal(none.list(), null);
});
