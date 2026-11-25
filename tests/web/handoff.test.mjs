// Tests for hand offs: Storm's Hand off from the phone (the handoff action) and Mission control's list (state.handoffs).
// Run: node --test tests/web/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const L = require('../../web/link.js');

const agents = [
  { name: 'Nova', role: 'Team lead', color: '#F5B83D', lead: true, status: 'idle', activity: 'Ready' },
  { name: 'Quill', role: 'Writer', color: '#3D9BE9', status: 'working', activity: 'Writing the intro' },
  { name: 'Pixel', role: 'Designer', color: '#E9573D', status: 'idle', activity: 'Ready' },
];
const NOW = Date.parse('2026-11-25T09:00:00Z');
const ago = min => new Date(NOW - min * 60000).toISOString();

function chat(id, kind, members, messages) {
  return { id, kind, name: id, members, unread: 0, typing: [], messages: [], raw: { id, kind, members, messages } };
}
function view(chats, extra) {
  return Object.assign({ agents, lead: 'Nova', now: NOW, chats: chats || [], approvals: [], desktop: { current: '1.4.0', ready: null, busy: false } }, extra || {});
}

test('a lead’s tasks and Storm’s hand offs go to Mission control, newest first', () => {
  const team = chat('team', 'team', ['Nova', 'Quill', 'Pixel'], [
    { id: 'm1', who: 'Nova', kind: 'agent', text: 'Here’s the plan.', time: ago(40) },
    { id: 'e1', who: 'Nova', kind: 'event', text: 'Nova assigned 2 tasks', time: ago(39), tasks: [{ to: 'Quill', task: 'Write the intro' }, { to: 'Pixel', task: 'Draw   the\nlogo' }] },
    { id: 'e0', who: 'Nova', kind: 'event', text: 'old', time: ago(3 * 24 * 60), tasks: [{ to: 'Quill', task: 'Too old' }] },
  ]);
  const dm = chat('dm:Nova', 'dm', ['Nova'], [
    { id: 'h1', who: 'Squall', kind: 'event', text: '↪ Storm handed Quill’s work to Nova', time: ago(5), handoff: { from: 'Quill', to: 'Nova', what: 'Take over Quill’s work: finish by noon' } },
    { id: 'h2', who: 'Squall', kind: 'event', text: 'to nobody', time: ago(4), handoff: { from: 'Quill', to: 'Ghost', what: 'x' } },
    { id: 'h3', who: 'Squall', kind: 'event', text: 'to itself', time: ago(3), handoff: { from: 'Nova', to: 'Nova', what: 'x' } },
  ]);
  const st = L.buildState(view([team, dm]));
  assert.deepEqual(st.handoffs, [
    { id: 'h1', from: 'quill', to: 'chief', what: 'Take over Quill’s work: finish by noon', at: ago(5) },
    { id: 'e1-0', from: 'chief', to: 'quill', what: 'Write the intro', at: ago(39) },
    { id: 'e1-1', from: 'chief', to: 'pixel', what: 'Draw the logo', at: ago(39) },
  ]);
});

test('no hand offs: the field is left out, and the version still changes when one comes', () => {
  const plain = L.buildState(view([chat('team', 'team', ['Nova'], [])]));
  assert.equal('handoffs' in plain, false);
  const one = L.buildState(view([chat('team', 'team', ['Nova'], [{ id: 'e1', who: 'Nova', kind: 'event', time: ago(1), tasks: [{ to: 'Quill', task: 'Go' }] }])]));
  assert.equal(one.handoffs.length, 1);
  assert.notEqual(one.version, plain.version);
  const { version, ...rest } = one;
  assert.ok(typeof version === 'string' && version.length > 0 && Object.keys(rest).length > 0);
});

test('only 12 hand offs go to the phone, and long ones are cut', () => {
  const msgs = Array.from({ length: 20 }, (_, i) => ({ id: 'e' + i, who: 'Nova', kind: 'event', time: ago(i), tasks: [{ to: 'Quill', task: 'y'.repeat(300) }] }));
  const st = L.buildState(view([chat('team', 'team', ['Nova', 'Quill'], msgs)]));
  assert.equal(st.handoffs.length, 12);
  assert.equal(st.handoffs[0].id, 'e0-0');
  assert.equal(st.handoffs[0].what.length, 200);
  assert.ok(st.handoffs[0].what.endsWith('…'));
});

test('the phone’s Hand off goes to the lead, with what to do and the note', () => {
  const v = view([]);
  assert.deepEqual(L.routeAction(v, { type: 'handoff', botId: 'quill', job: 'take_over', note: '  finish by noon ' }), { do: 'handoff', from: 'Quill', to: 'Nova', job: 'take_over', note: 'finish by noon' });
  assert.equal(L.routeAction(v, { type: 'handoff', botId: 'pixel', job: 'split' }).job, 'split');
  assert.equal(L.routeAction(v, { type: 'handoff', botId: 'pixel', job: 'review' }).note, '');
  assert.equal(L.routeAction(v, { type: 'handoff', botId: 'chief', job: 'review' }).error, 'Chief can’t hand work to itself.');
  assert.equal(L.routeAction(v, { type: 'handoff', botId: 'ghost', job: 'review' }).error, 'That teammate isn’t on the team any more.');
  assert.equal(L.routeAction(v, { type: 'handoff', botId: 'quill', job: 'delete' }).error, 'Pick what Chief should do with it.');
  assert.equal(L.routeAction(v, { type: 'handoff', botId: 'quill', note: 'x'.repeat(3000), job: 'review' }).note.length, 1000);
});
