// Tests for routines on the phone (web/link.js). Run: node --test tests/web/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const L = require('../../web/link.js');

const agents = [
  { name: 'Nova', lead: true, status: 'idle' },
  { name: 'Quill', status: 'idle' },
];
const routines = [
  { id: 'rt1', name: 'Morning check', bot: 'Nova', prompt: 'Check the vault and sum it up.', time: '09:05', days: 'daily', by: 'Storm', lastRun: '2026-11-24' },
  { id: 'rt2', name: 'Build', bot: 'Quill', prompt: 'Run the build', time: '17:30', days: 'weekdays', off: true },
  { id: 'rt3', name: 'Weekend tidy', bot: 'Quill', prompt: '', time: '7:00', days: 'weekends' },
  { id: 'rt4', name: 'Gone', bot: 'Ghost', prompt: 'x', time: '10:00', days: 'daily' },
];

function view(extra) {
  return Object.assign({
    agents, lead: 'Nova',
    chats: [{ id: 'dm:Nova', kind: 'dm', name: 'Nova', members: ['Nova'], messages: [] }],
    approvals: [],
    routines,
  }, extra || {});
}

test('routines go to the phone only when Squall sends them', () => {
  assert.equal('routines' in L.buildState(view({ routines: undefined })), false);
  assert.deepEqual(L.buildState(view({ routines: [] })).routines, []);
});

test('Squall’s routines become the phone’s, and a routine whose bot left is left out', () => {
  const rs = L.buildState(view()).routines;
  assert.equal(rs.length, 3);
  assert.deepEqual(rs[0], {
    id: 'rt1', botId: 'chief', task: 'Check the vault and sum it up.', repeat: 'daily', days: [true, true, true, true, true, true, true],
    minutes: 9 * 60 + 5, isOn: true, pingWhenDone: true, askBeforePush: true, skipIfBusy: false,
  });
  assert.equal(rs[1].botId, 'quill');
  assert.equal(rs[1].repeat, 'weekdays');
  assert.deepEqual(rs[1].days, [true, true, true, true, true, false, false]);
  assert.equal(rs[1].isOn, false);
  assert.equal(rs[1].minutes, 17 * 60 + 30);
  // weekends is "pick days" on the phone, Saturday and Sunday; an empty prompt falls back to the name; "7:00" reads fine
  assert.equal(rs[2].repeat, 'custom');
  assert.deepEqual(rs[2].days, [false, false, false, false, false, true, true]);
  assert.equal(rs[2].task, 'Weekend tidy');
  assert.equal(rs[2].minutes, 7 * 60);
  assert.ok(!rs.some(r => r.id === 'rt4'));
});

test('a routine change changes the state’s version', () => {
  const a = L.buildState(view()).version;
  const b = L.buildState(view({ routines: routines.map(r => r.id === 'rt1' ? Object.assign({}, r, { off: true }) : r) })).version;
  assert.notEqual(a, b);
});

const save = (r, extra) => L.routeAction(view(extra), { type: 'routine.save', routine: Object.assign({ id: 'new-1', botId: 'quill', task: 'Say hi', repeat: 'daily', days: [true, true, true, true, true, true, true], minutes: 8 * 60 + 3, isOn: true }, r) });

test('saving a new routine from the phone', () => {
  assert.deepEqual(save({}), { do: 'routineSave', oldId: null, isOn: true, routine: { name: 'Say hi', bot: 'Quill', prompt: 'Say hi', time: '08:03', days: 'daily' } });
  assert.equal(save({ repeat: 'weekdays' }).routine.days, 'weekdays');
  assert.equal(save({ repeat: 'custom', days: [true, true, true, true, true, false, false] }).routine.days, 'weekdays');
  assert.equal(save({ repeat: 'custom', days: [false, false, false, false, false, true, true] }).routine.days, 'weekends');
  assert.equal(save({ repeat: 'custom', days: [true, true, true, true, true, true, true] }).routine.days, 'daily');
  assert.equal(save({ isOn: false }).isOn, false);
  assert.equal(save({ minutes: 0 }).routine.time, '00:00');
  assert.equal(save({ minutes: 1439 }).routine.time, '23:59');
  const long = save({ task: 'Read every note in the vault and tell me what changed this week\nThen more' }).routine;
  assert.equal(long.name.length, 40);
  assert.ok(long.name.endsWith('…'));
  assert.equal(long.prompt, 'Read every note in the vault and tell me what changed this week\nThen more');
});

test('a routine Squall can’t run is refused with a reason', () => {
  assert.match(save({ repeat: 'custom', days: [true, false, true, false, false, false, false] }).error, /every day, on weekdays or at weekends/);
  assert.equal(save({ repeat: 'custom', days: [false, false, false, false, false, false, false] }).error, 'Pick at least one day.');
  assert.match(save({ repeat: 'custom', days: [true] }).error, /every day, on weekdays or at weekends/);
  assert.equal(save({ botId: 'ghost' }).error, 'That bot isn’t on the computer any more.');
  assert.equal(save({ task: '   ' }).error, 'Say what the routine should do.');
  assert.equal(save({ minutes: 1440 }).error, 'Pick a time for the routine.');
  assert.equal(save({ minutes: 'nine' }).error, 'Pick a time for the routine.');
  assert.equal(L.routeAction(view(), { type: 'routine.save' }).error, 'There’s nothing to save.');
});

test('editing a routine keeps its name when the job is the same', () => {
  const same = save({ id: 'rt1', botId: 'chief', task: 'Check the vault and sum it up.', minutes: 600 });
  assert.equal(same.oldId, 'rt1');
  assert.equal(same.routine.name, 'Morning check');
  assert.equal(same.routine.time, '10:00');
  assert.equal(same.routine.bot, 'Nova');
  const changed = save({ id: 'rt1', task: 'Something new' });
  assert.equal(changed.oldId, 'rt1');
  assert.equal(changed.routine.name, 'Something new');
});

test('turning on and off, deleting and skipping', () => {
  assert.deepEqual(L.routeAction(view(), { type: 'routine.toggle', routineId: 'rt2', isOn: true }), { do: 'routineOn', id: 'rt2', on: true });
  assert.equal(L.routeAction(view(), { type: 'routine.toggle', routineId: 'rt2', isOn: 'yes' }).error, 'A routine has to be on or off.');
  assert.equal(L.routeAction(view(), { type: 'routine.toggle', routineId: 'nope', isOn: true }).error, 'That routine isn’t on the computer any more.');
  assert.deepEqual(L.routeAction(view(), { type: 'routine.delete', routineId: 'rt1' }), { do: 'routineDelete', id: 'rt1' });
  assert.deepEqual(L.routeAction(view(), { type: 'routine.delete', routineId: 'nope' }), { do: 'none' });
  assert.deepEqual(L.routeAction(view(), { type: 'routine.skip', routineId: 'rt3' }), { do: 'routineSkip', id: 'rt3' });
  assert.ok(L.routeAction(view(), { type: 'routine.skip', routineId: 'nope' }).error);
});

test('wired to a window, routine actions reach Squall and the new state is sent at once', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const listeners = {}, calls = [], did = [];
  const Bridge = {
    host: true,
    on(e, fn) { (listeners[e] = listeners[e] || []).push(fn); },
    call(cmd, args) {
      calls.push([cmd, args]);
      if (args.do === 'hello' || args.do === 'status') return Promise.resolve({ running: true, port: 47615, phones: [{ deviceId: 'D1' }], update: {} });
      return Promise.resolve({ ok: true });
    },
  };
  const S = { agents, lead: { name: 'Nova' }, chats: [], team: { routines: routines.slice(0, 2).map(r => Object.assign({}, r)) } };
  const hooks = {
    list: () => S.team.routines.map(r => Object.assign({}, r)),
    save: async (r, oldId, on) => { did.push(['save', r, oldId, on]); },
    remove: async id => { did.push(['remove', id]); S.team.routines = S.team.routines.filter(r => r.id !== id); },
    setOn: (id, on) => { did.push(['setOn', id, on]); const r = S.team.routines.find(x => x.id === id); if (r) r.off = !on; },
    skipToday: id => { did.push(['skip', id]); },
  };
  globalThis.window = globalThis.window || globalThis;
  L.wire({
    S, Bridge, esc: s => String(s),
    phoneMessages: () => [], typingIn: () => [], send: () => true, note() { }, markRead() { }, clear() { },
    answer: async () => ({ ok: true }), group: () => null, openSettings() { }, closeModal() { }, sfx() { },
    routines: hooks,
  });
  await new Promise(r => setTimeout(r, 20));
  const answers = () => calls.filter(c => c[1].do === 'answer');
  const states = () => calls.filter(c => c[1].do === 'state');
  const ask = async (rid, body) => { listeners.linkAsk[0]({ rid, kind: 'action', body }); await new Promise(r => setTimeout(r, 20)); return answers().find(a => a[1].rid === rid)[1].result; };

  let n = states().length;
  assert.deepEqual(await ask('t1', { type: 'routine.toggle', routineId: 'rt2', isOn: true }), { ok: true });
  assert.deepEqual(did.at(-1), ['setOn', 'rt2', true]);
  const st = states().at(-1)[1].data;
  assert.ok(states().length > n, 'the new state goes out right away');
  assert.equal(st.routines.find(r => r.id === 'rt2').isOn, true);

  assert.deepEqual(await ask('s1', { type: 'routine.save', routine: { id: 'rt1', botId: 'quill', task: 'New job', repeat: 'weekdays', minutes: 75, isOn: false } }), { ok: true });
  assert.deepEqual(did.at(-1), ['save', { name: 'New job', bot: 'Quill', prompt: 'New job', time: '01:15', days: 'weekdays' }, 'rt1', false]);

  assert.deepEqual(await ask('k1', { type: 'routine.skip', routineId: 'rt1' }), { ok: true });
  assert.deepEqual(did.at(-1), ['skip', 'rt1']);

  assert.deepEqual(await ask('d1', { type: 'routine.delete', routineId: 'rt1' }), { ok: true });
  assert.deepEqual(did.at(-1), ['remove', 'rt1']);
  n = states().length;
  t.mock.timers.tick(2000);
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(states().at(-1)[1].data.routines.map(r => r.id), ['rt2']);

  // a host error comes back to the phone as the reason
  hooks.save = async () => { throw new Error('Pick a time like 09:00.'); };
  assert.deepEqual(await ask('s2', { type: 'routine.save', routine: { id: 'x', botId: 'chief', task: 'Hi', repeat: 'daily', minutes: 60 } }), { ok: false, error: 'Pick a time like 09:00.' });
});

test('without routine hooks, routine actions say the computer can’t do it yet', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const listeners = {}, calls = [];
  const Bridge = {
    host: true,
    on(e, fn) { (listeners[e] = listeners[e] || []).push(fn); },
    call(cmd, args) { calls.push([cmd, args]); return Promise.resolve(args.do === 'hello' || args.do === 'status' ? { running: true, phones: [], update: {} } : { ok: true }); },
  };
  const S = { agents, lead: { name: 'Nova' }, chats: [] };
  L.wire({
    S, Bridge, esc: s => String(s), phoneMessages: () => [], typingIn: () => [], send: () => true, note() { }, markRead() { }, clear() { },
    answer: async () => ({ ok: true }), group: () => null, openSettings() { }, closeModal() { }, sfx() { },
  });
  await new Promise(r => setTimeout(r, 20));
  // no routines in the view, so the routine isn't found
  listeners.linkAsk[0]({ rid: 'x1', kind: 'action', body: { type: 'routine.toggle', routineId: 'rt1', isOn: true } });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(calls.find(c => c[1].do === 'answer' && c[1].rid === 'x1')[1].result.ok, false);
});
