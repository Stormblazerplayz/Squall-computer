// Tests for the phone's Plan usage data in web/link.js (state.usage and the usage.settings action).
// Run: node --test tests/web/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const L = require('../../web/link.js');

const NOW = Date.parse('2026-11-25T12:00:00.000Z');
const agents = [
  { name: 'Nova', role: 'Team lead', color: '#F5B83D', lead: true, status: 'idle', activity: 'Ready' },
  { name: 'Quill', role: 'Writer', color: '#3D9BE9', status: 'idle', activity: 'Ready' },
];

function usage(extra) {
  return Object.assign({
    windows: [
      { label: '5-hour limit', percentUsed: 42.4, resetsAt: '2026-11-25T14:00:00.000Z' },
      { label: 'Weekly · all models', percentUsed: 17, resetsAt: '2026-11-29T09:00:00.000Z' },
      { label: 'Weekly · opus', percentUsed: 120, resetsAt: 'not a date' },
    ],
    five: { label: '5-hour limit', ready: true, atReset: 61, outAt: null },
    week: { label: 'Weekly · all models', ready: false, atReset: null, outAt: null },
    throttleOn: true, limit: 80, why: '', readAt: NOW - 90000, overage: false,
    today: { day: '2026-11-25', bots: { Nova: { jobs: 3, ms: 840000 }, Quill: { jobs: 5, ms: 1200400 }, Ghost: { jobs: 2, ms: 1000 }, Idle: { jobs: 0, ms: 0 } } },
  }, extra || {});
}

function state(u) {
  return L.buildState({ agents, lead: 'Nova', chats: [], approvals: [], usage: u, now: NOW });
}

test('window ids: the 5-hour window, the all-models week and other weeks', () => {
  assert.equal(L.windowId('5-hour limit'), 'five_hour');
  assert.equal(L.windowId('Weekly · all models'), 'week');
  assert.equal(L.windowId('Weekly · opus'), 'week-opus');
  assert.equal(L.windowId('Weekly · sonnet 4'), 'week-sonnet-4');
});

test('the state carries the plan usage Squall read, and nothing it did not', () => {
  const u = state(usage()).usage;
  assert.equal(u.windows.length, 3);
  const five = u.windows[0];
  assert.deepEqual(five, { id: 'five_hour', label: '5-hour limit', percent: 42, resetsAt: '2026-11-25T14:00:00.000Z', predicting: false, atReset: 61 });
  const week = u.windows[1];
  assert.equal(week.id, 'week');
  assert.equal(week.percent, 17);
  assert.equal(week.predicting, true);       // not enough readings yet: no guess
  assert.equal(week.atReset, undefined);
  const opus = u.windows[2];
  assert.equal(opus.id, 'week-opus');
  assert.equal(opus.percent, 100);           // kept in 0 to 100
  assert.equal(opus.resetsAt, undefined);    // a broken date is left out
  assert.equal(opus.predicting, undefined);  // Squall doesn't predict per-model weeks
  assert.equal(u.slowDown, true);
  assert.equal(u.limit, 80);
  assert.equal(u.throttled, false);
  assert.equal(u.why, undefined);
  assert.equal(u.readAt, new Date(NOW - 90000).toISOString());
  assert.equal(u.overage, undefined);
});

test('today lists real jobs by phone id, longest first, and skips bots that are gone or did nothing', () => {
  const u = state(usage()).usage;
  assert.equal(u.today.day, '2026-11-25');
  assert.deepEqual(u.today.bots, [
    { botId: 'quill', jobs: 5, seconds: 1200 },
    { botId: 'chief', jobs: 3, seconds: 840 },
  ]);
});

test('a window that runs out before its reset gets the time it runs out', () => {
  const outAt = NOW + 38 * 60000 + 20000;
  const u = state(usage({ five: { label: '5-hour limit', ready: true, atReset: 100, outAt }, why: 'pace' })).usage;
  assert.equal(u.windows[0].runsOutAt, new Date(NOW + 38 * 60000).toISOString());   // rounded to the minute, so it doesn't change every push
  assert.equal(u.throttled, true);
  assert.equal(u.why, 'pace');
  const past = state(usage({ five: { label: '5-hour limit', ready: true, atReset: 100, outAt: NOW - 600000 } })).usage;
  assert.equal(past.windows[0].runsOutAt, new Date(NOW).toISOString());   // never before now
  const week = state(usage({ week: { label: 'Weekly · all models', ready: true, atReset: 100, outAt: NOW + 3600000 } })).usage;
  assert.equal(week.windows[1].runsOutAt, new Date(NOW + 3600000).toISOString());
  assert.equal(week.windows[1].atReset, 100);
});

test('the limit and the switch come through as they are, and bad values are dropped', () => {
  assert.equal(state(usage({ limit: null })).usage.limit, null);
  assert.equal(state(usage({ limit: 5 })).usage.limit, null);
  assert.equal(state(usage({ limit: 70.5 })).usage.limit, null);
  assert.equal(state(usage({ throttleOn: false })).usage.slowDown, false);
  const lim = state(usage({ why: 'limit' })).usage;
  assert.equal(lim.throttled, true);
  assert.equal(lim.why, 'limit');
  assert.equal(state(usage({ why: 'other' })).usage.throttled, false);
  assert.equal(state(usage({ overage: true })).usage.overage, true);
});

test('no usage from Squall means no usage in the state, and no windows yet is an empty list', () => {
  assert.equal('usage' in state(null), false);
  assert.equal('usage' in state(undefined), false);
  const empty = state({ windows: [], throttleOn: true, limit: null, why: '' }).usage;
  assert.deepEqual(empty.windows, []);
  assert.equal(empty.today, undefined);
  assert.equal(empty.readAt, undefined);
});

test('the state version changes when the usage does, and not when nothing changed', () => {
  const a = state(usage()).version, b = state(usage()).version;
  assert.equal(a, b);
  const c = state(usage({ windows: [{ label: '5-hour limit', percentUsed: 43, resetsAt: '2026-11-25T14:00:00.000Z' }] })).version;
  assert.notEqual(a, c);
});

test('usage.settings: the switch and the limit, checked', () => {
  const v = { agents, lead: 'Nova', chats: [], approvals: [] };
  assert.deepEqual(L.routeAction(v, { type: 'usage.settings', throttle: false }), { do: 'usage', throttle: false });
  assert.deepEqual(L.routeAction(v, { type: 'usage.settings', limit: 80 }), { do: 'usage', limit: 80 });
  assert.deepEqual(L.routeAction(v, { type: 'usage.settings', limit: null }), { do: 'usage', limit: null });
  assert.deepEqual(L.routeAction(v, { type: 'usage.settings', throttle: true, limit: 50 }), { do: 'usage', throttle: true, limit: 50 });
  assert.ok(L.routeAction(v, { type: 'usage.settings', limit: 5 }).error);
  assert.ok(L.routeAction(v, { type: 'usage.settings', limit: 101 }).error);
  assert.ok(L.routeAction(v, { type: 'usage.settings', limit: 'lots' }).error);
  assert.ok(L.routeAction(v, { type: 'usage.settings', throttle: 'yes' }).error);
  assert.ok(L.routeAction(v, { type: 'usage.settings' }).error);
});
