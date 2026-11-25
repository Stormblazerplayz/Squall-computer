// Tests for Pause / Resume in web/uno.js. Run: node --test tests/web/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const U = require('../../web/uno.js');

test('a paused task shows "Paused" and still counts as running', () => {
  const on = { state: 'on', id: 'pc-chief' };
  const st = U.statusOf(on, { state: 'paused' });
  assert.deepEqual([st.key, st.label, st.live, st.dot], ['paused', 'Paused', false, true]);
  assert.match(st.detail, /Resume/);
  assert.equal(U.dotClass(st), 'paused');
  assert.equal(U.dotClass(U.statusOf(on, { state: 'running' })), 'live');
  assert.equal(U.dotClass(U.statusOf({ state: 'starting' }, { state: 'starting' })), 'starting');
  assert.equal(U.dotClass(null), 'live');
  assert.equal(U.sessionLabel({ state: 'paused' }), 'Paused');
  assert.equal(U.isRunning({ state: 'paused' }), true);
  const store = U.newStore();
  U.mergeState(store, { sessions: [{ id: 'uno-1', state: 'paused', startedAt: 1 }] }, true);
  assert.equal(U.anyRunning(store), true);
  assert.equal(U.nowLine({ state: 'paused', steps: 4, now: 'Paused. Press Resume to let it carry on.' }).label, 'NOW · step 4');
});

test('Pause shows while it works, Resume while paused, neither while you have the wheel or it ended', () => {
  assert.equal(U.pauseAction({ state: 'running' }), 'pause');
  assert.equal(U.pauseAction({ state: 'starting' }), 'pause');
  assert.equal(U.pauseAction({ state: 'paused' }), 'resume');
  for (const state of ['you', 'done', 'stopped', 'error', 'weird']) assert.equal(U.pauseAction({ state }), null, state);
  assert.equal(U.pauseAction(null), null);
});

test('pause and resume events read plainly in the feed', () => {
  const p = U.feedRow({ seq: 1, kind: 'pause', who: 'you', text: 'Paused by you.', at: 0 });
  assert.deepEqual([p.icon, p.you, p.text, p.cls], ['pause', true, 'Paused by you.', 'k-pause']);
  const r = U.feedRow({ seq: 2, kind: 'resume', who: 'you', text: '' });
  assert.deepEqual([r.icon, r.text], ['play', 'Resumed']);
});
