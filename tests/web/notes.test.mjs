// Tests for Notes on the phone: search the Obsidian vault, read a note, add text to the end of one.
// Run: node --test tests/web/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const L = require('../../web/link.js');
const N = globalThis.SquallNotes;

function fakeVault() {
  const files = { 'Projects/Squall.md': '# Squall\nThe phone app.', 'Daily/2026-11-25.md': 'Shipped send later.', 'Ideas.md': 'x'.repeat(25000) };
  const calls = [];
  return {
    files, calls,
    ops: {
      search: async q => { calls.push(['search', q]); return Object.keys(files).filter(p => files[p].toLowerCase().includes(q.toLowerCase()) || p.toLowerCase().includes(q.toLowerCase())).map(p => ({ path: p, snippet: files[p].slice(0, 30) })); },
      list: async () => { calls.push(['list']); return Object.keys(files).map(p => ({ path: p, name: p.replace(/\.md$/, '').split('/').pop() })); },
      read: async p => { calls.push(['read', p]); return files[p]; },
      append: async (p, t) => { calls.push(['append', p, t]); files[p] += '\n' + t; },
    },
  };
}

test('notesRoute: only notes actions, and only paths the phone was shown', () => {
  const known = new Set(['Ideas.md']);
  assert.equal(N.notesRoute({ type: 'chat.send' }, known), null);
  assert.deepEqual(N.notesRoute({ type: 'notes.search', query: '  squall ' }, known), { do: 'search', query: 'squall' });
  assert.deepEqual(N.notesRoute({ type: 'notes.close' }, known), { do: 'close' });
  assert.deepEqual(N.notesRoute({ type: 'notes.open', path: 'Ideas.md' }, known), { do: 'open', path: 'Ideas.md' });
  assert.match(N.notesRoute({ type: 'notes.open', path: '../secret.txt' }, known).error, /isn’t in the list/);
  assert.deepEqual(N.notesRoute({ type: 'notes.append', path: 'Ideas.md', text: ' more ' }, known), { do: 'append', path: 'Ideas.md', text: 'more' });
  assert.equal(N.notesRoute({ type: 'notes.append', path: 'Ideas.md', text: '  ' }, known).error, 'There’s nothing to add.');
  assert.match(N.notesRoute({ type: 'notes.append', path: 'Ideas.md', text: 'x'.repeat(2001) }, known).error, /too long/);
});

test('noteRows keeps unique paths with a name and a short snippet', () => {
  const rows = N.noteRows([{ path: 'A/B.md', snippet: 's'.repeat(300) }, { path: 'A/B.md' }, null, { path: '' }, { path: 'C.md', name: 'Cee' }]);
  assert.deepEqual(rows.map(r => [r.path, r.name, r.snippet.length]), [['A/B.md', 'B', 240], ['C.md', 'Cee', 0]]);
  assert.equal(N.noteRows(Array.from({ length: 60 }, (_, i) => ({ path: i + '.md' }))).length, N.NOTES_MAX);
});

test('the desk searches, lists, opens, adds and forgets after 10 minutes', async () => {
  const v = fakeVault();
  let t = 1000;
  const desk = N.notesDesk(() => v.ops, () => t);
  assert.equal(desk.view(), null);
  // opening a note nobody listed is refused
  assert.match(desk.route({ type: 'notes.open', path: 'Ideas.md' }).error, /isn’t in the list/);

  assert.deepEqual(await desk.run(desk.route({ type: 'notes.search', query: '' })), { ok: true });
  assert.deepEqual(desk.view().results.map(r => r.path), ['Daily/2026-11-25.md', 'Ideas.md', 'Projects/Squall.md'], 'no words: every note, by path');
  await desk.run(desk.route({ type: 'notes.search', query: 'phone' }));
  assert.deepEqual(desk.view().results.map(r => r.name), ['Squall']);
  assert.equal(desk.view().query, 'phone');

  await desk.run(desk.route({ type: 'notes.open', path: 'Ideas.md' }));
  assert.equal(desk.view().note.name, 'Ideas');
  assert.equal(desk.view().note.text.length, N.NOTE_MAX_TEXT);
  assert.equal(desk.view().note.cut, true);
  assert.equal(desk.view().results.length, 1, 'the list stays for Back');

  await desk.run(desk.route({ type: 'notes.append', path: 'Projects/Squall.md', text: 'Notes work on the phone.' }));
  assert.equal(desk.view().note.text, '# Squall\nThe phone app.\nNotes work on the phone.');
  assert.deepEqual(v.calls.filter(c => c[0] === 'append'), [['append', 'Projects/Squall.md', 'Notes work on the phone.']]);

  await desk.run(desk.route({ type: 'notes.close' }));
  assert.equal(desk.view().note, null);
  t += 10 * 60000;
  assert.equal(desk.view(), null, 'gone from the state when the phone stops asking');
  assert.deepEqual(await N.notesDesk(() => undefined, () => t).run({ do: 'close' }), { ok: false, error: 'Squall on the computer can’t do that yet.' });
});

test('withNotes adds the notes and changes the version', () => {
  const v = { agents: [{ name: 'Nova', lead: true }], lead: 'Nova', chats: [], approvals: [], now: 0 };
  const plain = L.buildState(v);
  assert.equal(N.withNotes(L.buildState(v), null).version, plain.version);
  const s = N.withNotes(L.buildState(v), { query: 'x', results: [{ path: 'a.md', name: 'a', snippet: '' }], note: null, at: 5 });
  assert.deepEqual(s.notes, { query: 'x', results: [{ path: 'a.md', name: 'a', snippet: '' }], note: null });
  assert.notEqual(s.version, plain.version);
});
