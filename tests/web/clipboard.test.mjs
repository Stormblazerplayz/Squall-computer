// Tests for the shared clipboard from the phone: clip.send, clip.get, clip.clear and state.clipboard.
// Run: node --test tests/web/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const L = require('../../web/link.js');
const C = globalThis.SquallClip;

const view = { agents: [{ name: 'Nova', lead: true }], lead: 'Nova', chats: [] };

test('clipRoute checks what the phone sent', () => {
  assert.equal(C.clipRoute({ type: 'chat.send' }), null);
  assert.equal(C.clipRoute(null), null);
  assert.deepEqual(C.clipRoute({ type: 'clip.get' }), { do: 'get' });
  assert.deepEqual(C.clipRoute({ type: 'clip.clear' }), { do: 'clear' });
  assert.deepEqual(C.clipRoute({ type: 'clip.send', text: ' hi ' }), { do: 'send', text: ' hi ' });
  assert.equal(C.clipRoute({ type: 'clip.send', text: '   ' }).error, 'There’s nothing to send.');
  assert.equal(C.clipRoute({ type: 'clip.send', text: 5 }).error, 'There’s nothing to send.');
  assert.match(C.clipRoute({ type: 'clip.send', text: 'x'.repeat(C.CLIP_MAX + 1) }).error, /too long/);
});

test('send, get, clear and the two minute limit', async () => {
  let board = 'from the computer', t = Date.parse('2026-11-25T10:00:00.000Z');
  const ops = { read: async () => board, write: async text => { board = text; return true; } };
  const desk = C.clipDesk(() => ops, () => t);
  assert.deepEqual(C.withClipboard(L.buildState(view), desk.view()).clipboard, {});
  assert.deepEqual(await desk.run(C.clipRoute({ type: 'clip.send', text: 'from the phone' })), { ok: true });
  assert.equal(board, 'from the phone');
  assert.deepEqual(await desk.run({ do: 'get' }), { ok: true });
  assert.deepEqual(C.withClipboard(L.buildState(view), desk.view()).clipboard, { text: 'from the phone', at: '2026-11-25T10:00:00.000Z', cut: false });
  t += C.CLIP_KEEP + 1;
  assert.equal(desk.view(), null);
  await desk.run({ do: 'get' });
  assert.ok(desk.view());
  await desk.run({ do: 'clear' });
  assert.equal(desk.view(), null);
  board = 'y'.repeat(C.CLIP_MAX + 10);
  await desk.run({ do: 'get' });
  assert.equal(desk.view().text.length, C.CLIP_MAX);
  assert.equal(desk.view().cut, true);
  board = '  ';
  assert.equal((await desk.run({ do: 'get' })).error, 'The computer’s clipboard has no text on it.');
  assert.equal(desk.view(), null);
});

test('errors: a failed write and a computer without the clipboard', async () => {
  const desk = C.clipDesk(() => ({ read: async () => '', write: async () => false }), () => 0);
  assert.equal((await desk.run({ do: 'send', text: 'x' })).error, 'Squall couldn’t use the computer’s clipboard.');
  const none = C.clipDesk(() => null, () => 0);
  assert.equal((await none.run({ do: 'get' })).ok, false);
  assert.deepEqual(await none.run({ do: 'clear' }), { ok: true });
  assert.equal((await none.run({ error: 'nope' })).error, 'nope');
});
