// Squall on the iPhone and iPad (the Squall app from Squall-mobile).
//
// The host's SquallLink (src/SquallLink) runs the phone API from Squall-mobile docs/pairing.md. This file is the window's half:
//   - every 2 seconds it hands the host the phone's view of the team (bots, chats, groups, approvals), built from Squall's
//     real state: nothing here is made up, and what Squall doesn't have (jobs) is simply left out;
//   - it answers the phone's actions and voice turns, which the host forwards as "linkAsk" events;
//   - it adds "Squall app (iPhone and iPad)" to Settings, with Pair a phone (a QR code and a 6-digit code) and Unpair.
// app.js calls SquallLinkCore.wire(hooks) once; the pure parts (buildState, routeAction, ...) are tested with Node in
// tests/web/link.test.mjs.
(function (root) {
  'use strict';

  const CHIEF = 'chief';
  const MAX_MESSAGES = 60;     // per chat: the phone shows recent history, Squall keeps the rest
  const MAX_TEXT = 4000;

  // ---------------------------------------------------------------- ids

  // A bot's id for the phone: Squall's lead is always "chief" (the phone's Call Chief and Live Activities need it);
  // everyone else gets a slug of their name, made unique.
  function botIds(agents, leadName) {
    const map = {};
    const used = new Set([CHIEF]);
    for (const a of agents || []) {
      if (!a || !a.name) continue;
      if (a.name === leadName) { map[a.name] = CHIEF; continue; }
      let base = String(a.name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'bot';
      if (base === CHIEF) base = 'chief-2';
      let id = base, n = 2;
      while (used.has(id)) id = base + '-' + n++;
      used.add(id);
      map[a.name] = id;
    }
    return map;
  }

  // FNV-1a, for stable message ids and the state's version
  function hash(s) {
    let h = 0x811c9dc5;
    s = String(s);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(36);
  }

  // ---------------------------------------------------------------- the phone's state

  const BOT_STATUS = { working: 'working', idle: 'idle', done: 'idle', error: 'idle', stopped: 'idle' };

  // view: { agents, lead, chats: [{ id, kind, name, members, unread, messages: [{id, who, kind, text, at}], typing: [names] }],
  //         approvals: [{ requestId, who, tool, detail, text, at }] }   (what app.js gives; see wire())
  // Returns the object for GET /api/v1/state.
  function buildState(view) {
    const agents = (view && view.agents) || [];
    const leadName = view && view.lead ? view.lead : (agents.find(a => a.lead) || agents[0] || {}).name;
    const ids = botIds(agents, leadName);
    const idOf = name => ids[name] || null;
    const dmOf = {};
    for (const c of (view && view.chats) || []) if (c.kind === 'dm' && c.members && c.members[0]) dmOf[c.members[0]] = c;
    const waiting = {};
    for (const ap of (view && view.approvals) || []) waiting[ap.who] = (waiting[ap.who] || 0) + 1;

    let typing = null;
    const bots = agents.filter(a => a && a.name && ids[a.name]).map(a => {
      const dm = dmOf[a.name];
      const busy = (view.chats || []).some(c => (c.typing || []).includes(a.name));
      let status = BOT_STATUS[a.status] || 'idle';
      if (busy) status = 'working';
      if (waiting[a.name]) status = 'waiting';
      if (busy && !typing) typing = ids[a.name];
      const b = { id: ids[a.name], name: a.name, color: /^#[0-9a-fA-F]{6}$/.test(a.color || '') ? a.color : '#A78BFA', role: a.role || (a.name === leadName ? 'Team lead' : ''), status, unread: dm ? Math.max(0, dm.unread | 0) : 0 };
      const task = String(a.activity || '').trim();
      if (task && task !== 'Ready') b.task = task.slice(0, 200);
      return b;
    });
    // Chief first, then the order Squall shows
    bots.sort((x, y) => (y.id === CHIEF) - (x.id === CHIEF));

    const chats = {};
    const groups = [];
    for (const c of (view && view.chats) || []) {
      let key;
      if (c.kind === 'dm') { key = idOf(c.members && c.members[0]); if (!key) continue; }
      else {
        key = c.id;
        const members = (c.members || []).map(idOf).filter(Boolean);
        groups.push({ id: c.id, name: c.kind === 'team' ? 'Team' : (c.name || members.join(', ')), members: c.kind === 'team' ? bots.map(b => b.id) : members, chiefLeads: c.kind === 'team' || members.includes(CHIEF) });
      }
      chats[key] = phoneMessages(c.messages || [], idOf);
    }

    const seenAsk = new Set();
    const inbox = ((view && view.approvals) || []).filter(ap => ap && ap.requestId && idOf(ap.who) && !seenAsk.has(String(ap.requestId)) && seenAsk.add(String(ap.requestId))).map(ap => {
      const item = { id: String(ap.requestId), kind: 'ask', botId: idOf(ap.who), title: ap.who + ' wants to ' + toolWords(ap.tool), unread: true };
      const body = String(ap.text || '').trim();
      if (body) item.body = body.slice(0, 600);
      if (ap.detail) item.command = String(ap.detail).slice(0, 600);
      if (ap.at) item.at = ap.at;
      return item;
    });

    const state = { typing, bots, chats, groups, inbox };
    // the plan's usage and today's jobs, for the phone's Plan usage screen (only when Squall has it)
    const usage = phoneUsage(view && view.usage, idOf, view && view.now);
    if (usage) state.usage = usage;
    // Squall's routines (jobs a bot does at a set time), for the phone's Routines tab (only when Squall sends them)
    const routines = phoneRoutines(view && view.routines, idOf);
    if (routines) state.routines = routines;
    // Squall's own version, for the phone's Settings > Computer (only what the updater really knows)
    const d = view && view.desktop;
    if (d && d.current) {
      state.desktop = { version: String(d.current), updating: !!d.busy };
      if (d.ready) state.desktop.latest = String(d.ready);
    }
    state.version = hash(JSON.stringify(state));
    return state;
  }

  // ---------------------------------------------------------------- plan usage

  const iso = ms => { const d = new Date(ms); return isNaN(d) ? null : d.toISOString(); };
  const pct = n => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));

  // A window's id for the phone: the 5-hour window is "five_hour", the all-models week is "week", any other week "week-<slug>".
  function windowId(label) {
    const l = String(label || '').toLowerCase();
    if (/5-hour|5 hour|five/.test(l)) return 'five_hour';
    if (/week/.test(l)) {
      const rest = l.replace(/^weekly\s*·?\s*/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      return !rest || rest === 'all-models' ? 'week' : 'week-' + rest;
    }
    return l.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'window';
  }

  // u: what app.js reads (usageForPhone): { windows: [{ label, percentUsed, resetsAt }], five, week (each { label, ready, atReset, outAt }),
  // throttleOn, limit, why, readAt, overage,
  // today: { day, bots: { name: { jobs, ms } } } }. Returns state.usage, or null when there's nothing to show. Nothing is guessed: a window's
  // prediction is there only when Squall has enough readings, and today's jobs are the runs Squall timed itself.
  function phoneUsage(u, idOf, now) {
    if (!u || typeof u !== 'object') return null;
    const at = Number(now) || Date.now();
    const used = new Set();
    const windows = (Array.isArray(u.windows) ? u.windows : []).filter(w => w && w.label).map(w => {
      let id = windowId(w.label), n = 2;
      while (used.has(id)) id = windowId(w.label) + '-' + n++;
      used.add(id);
      const out = { id, label: String(w.label).slice(0, 60), percent: pct(w.percentUsed) };
      const reset = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
      if (!isNaN(reset)) out.resetsAt = iso(reset);
      // the predictions app.js made for the 5-hour window (five) and the all-models week (week)
      const p = id === 'five_hour' ? u.five : id === 'week' ? u.week : null;
      if (p && p.label && windowId(p.label) === id) {
        out.predicting = !p.ready;
        if (p.ready && typeof p.atReset === 'number') out.atReset = pct(p.atReset);
        const outAt = Number(p.outAt);
        if (p.ready && p.outAt != null && isFinite(outAt) && outAt > 0) out.runsOutAt = iso(Math.max(Math.round(at / 60000) * 60000, Math.round(outAt / 60000) * 60000));
      }
      return out;
    });
    const limit = Number.isInteger(u.limit) && u.limit >= 10 && u.limit <= 100 ? u.limit : null;
    const why = u.why === 'pace' || u.why === 'limit' ? u.why : null;
    const out = { windows, slowDown: u.throttleOn !== false, limit, throttled: !!why };
    if (why) out.why = why;
    if (u.readAt) { const r = iso(u.readAt); if (r) out.readAt = r; }
    if (u.overage) out.overage = true;
    const t = u.today;
    if (t && typeof t.day === 'string' && t.bots && typeof t.bots === 'object') {
      const bots = [];
      for (const name of Object.keys(t.bots)) {
        const id = idOf(name), b = t.bots[name];
        if (!id || !b || typeof b !== 'object') continue;   // a bot that's gone from the team
        const jobs = Math.max(0, Math.floor(Number(b.jobs) || 0));
        if (!jobs) continue;
        bots.push({ botId: id, jobs, seconds: Math.max(0, Math.round((Number(b.ms) || 0) / 1000)) });
      }
      bots.sort((x, y) => y.seconds - x.seconds || y.jobs - x.jobs);
      out.today = { day: t.day, bots };
    }
    return out;
  }

  function toolWords(tool) {
    const t = String(tool || 'use a tool').trim();
    if (/^bash$/i.test(t)) return 'run a command';
    if (/^(write|edit|multiedit)$/i.test(t)) return 'change a file';
    if (/^webfetch$/i.test(t)) return 'open a web page';
    return 'use ' + t;
  }

  function phoneMessages(list, idOf) {
    const seen = {};
    return list.slice(-MAX_MESSAGES).map(m => {
      const text = String(m.text || '');
      const kind = m.who === 'Storm' ? 'me' : m.kind === 'error' ? 'error' : m.kind === 'event' ? 'system' : 'bot';
      let id = m.id ? String(m.id) : '';
      if (!id) {   // a live session's lines have no id: name them by what they say
        const base = 'h' + hash(m.who + '|' + text);
        seen[base] = (seen[base] || 0) + 1;
        id = base + '-' + seen[base];
      }
      const out = { id, kind, text: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + '…' : text };
      if (kind === 'bot') { const a = idOf(m.who); if (a) out.author = a; }
      if (m.at) out.at = m.at;
      return out;
    }).filter(m => m.text.trim() || m.kind !== 'bot');
  }

  // ---------------------------------------------------------------- routines

  // The days each of Squall's repeats runs on, Monday first (the phone's order).
  const DAY_SETS = { daily: [1, 1, 1, 1, 1, 1, 1], weekdays: [1, 1, 1, 1, 1, 0, 0], weekends: [0, 0, 0, 0, 0, 1, 1] };
  const pad2 = n => String(n).padStart(2, '0');

  // rs: Squall's routines [{ id, name, bot, prompt, time: "HH:MM", days: daily | weekdays | weekends, off }]. Returns the phone's
  // routines, or null when Squall didn't send any. A routine whose bot has left the team is left out. The phone's extra switches
  // (ping when done, ask before pushing, skip if busy) aren't Squall's, so they're sent as the phone's own defaults.
  function phoneRoutines(rs, idOf) {
    if (!Array.isArray(rs)) return null;
    return rs.filter(r => r && r.id && idOf(r.bot)).map(r => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(String(r.time || '').trim());
      const minutes = m ? Math.min(23, +m[1]) * 60 + Math.min(59, +m[2]) : 9 * 60;
      const days = DAY_SETS[r.days] ? r.days : 'daily';
      return {
        id: String(r.id), botId: idOf(r.bot), task: String(r.prompt || r.name || '').slice(0, 4000),
        repeat: days === 'weekends' ? 'custom' : days, days: DAY_SETS[days].map(Boolean), minutes,
        isOn: !r.off, pingWhenDone: true, askBeforePush: true, skipIfBusy: false,
      };
    });
  }

  // The phone's repeat and days as one of Squall's: 'daily', 'weekdays', 'weekends', '' for no days, or null when Squall can't run it.
  function routineDays(r) {
    if (r.repeat === 'daily' || r.repeat === 'weekdays') return r.repeat;
    const d = Array.isArray(r.days) && r.days.length === 7 ? r.days.map(x => (x === true ? 1 : 0)).join('') : null;
    if (d === null) return null;
    if (d === '0000000') return '';
    return Object.keys(DAY_SETS).find(k => DAY_SETS[k].join('') === d) || null;
  }

  function routineFor(view, id) {
    return ((view && view.routines) || []).find(r => r && String(r.id) === String(id)) || null;
  }

  // ---------------------------------------------------------------- actions from the phone

  // Finds Squall's chat for the phone's chat id (a bot id, "team" or a group id).
  function chatFor(view, chatId) {
    const agents = (view && view.agents) || [];
    const leadName = view && view.lead ? view.lead : (agents.find(a => a.lead) || agents[0] || {}).name;
    const ids = botIds(agents, leadName);
    const name = Object.keys(ids).find(n => ids[n] === chatId);
    if (name) return ((view && view.chats) || []).find(c => c.kind === 'dm' && c.members && c.members[0] === name) || null;
    return ((view && view.chats) || []).find(c => c.kind !== 'dm' && c.id === chatId) || null;
  }

  function nameFor(view, botId) {
    const agents = (view && view.agents) || [];
    const leadName = view && view.lead ? view.lead : (agents.find(a => a.lead) || agents[0] || {}).name;
    const ids = botIds(agents, leadName);
    return Object.keys(ids).find(n => ids[n] === botId) || null;
  }

  const CANT = 'Squall on the computer can’t do that yet.';

  // Works out what an action means for Squall: { do: 'send' | 'read' | 'clear' | 'clearAll' | 'answer' | 'group' | 'none', ... }
  // or { error }. Kept apart from doing it, so it can be tested without a window.
  function routeAction(view, a) {
    const type = a && typeof a.type === 'string' ? a.type : '';
    switch (type) {
      case 'chat.send': {
        const c = chatFor(view, a.chatId);
        const text = String(a.text || '').trim();
        if (!c) return { error: 'That chat isn’t on the computer any more.' };
        if (!text) return { error: 'There’s nothing to send.' };
        return { do: 'send', chat: c, text: text.slice(0, 20000) };
      }
      case 'chat.read': {
        const c = chatFor(view, a.chatId);
        return c ? { do: 'read', chat: c } : { do: 'none' };
      }
      case 'chat.clear': {
        const c = chatFor(view, a.chatId);
        return c ? { do: 'clear', chat: c } : { do: 'none' };
      }
      case 'chat.clearAll': return { do: 'clearAll' };
      case 'inbox.answer': {
        const ap = ((view && view.approvals) || []).find(x => String(x.requestId) === String(a.itemId));
        if (!ap) return { error: 'That question was already answered or has gone.' };
        const ans = String(a.answer || '').toLowerCase();
        if (ans !== 'allow' && ans !== 'deny') return { error: 'Answer with Allow or Deny.' };
        return { do: 'answer', requestId: ap.requestId, decision: ans === 'allow' ? 'once' : 'deny' };
      }
      case 'inbox.read': case 'inbox.readAll': return { do: 'none' };
      case 'inbox.clear': return { error: 'Answer it with Allow or Deny, and it goes away.' };
      case 'group.create': {
        const names = (Array.isArray(a.members) ? a.members : []).map(id => nameFor(view, id)).filter(Boolean);
        if (!names.length) return { error: 'Pick at least one bot for the group.' };
        return { do: 'group', name: String(a.name || '').trim().slice(0, 60), members: names };
      }
      case 'settings.save': return { do: 'none' };
      case 'usage.settings': {
        // the phone's Plan usage screen: { throttle: true/false } and/or { limit: 10 to 100, or null for none }
        const out = { do: 'usage' };
        if ('throttle' in a) {
          if (typeof a.throttle !== 'boolean') return { error: 'Slow down has to be on or off.' };
          out.throttle = a.throttle;
        }
        if ('limit' in a) {
          if (a.limit === null) out.limit = null;
          else {
            const n = Number(a.limit);
            if (!Number.isInteger(n) || n < 10 || n > 100) return { error: 'Pick a limit from 10% to 100%.' };
            out.limit = n;
          }
        }
        if (!('throttle' in out) && !('limit' in out)) return { error: 'There’s nothing to change.' };
        return out;
      }
      case 'routine.save': {
        // the phone's routine editor: { routine: { id, botId, task, repeat, days[7], minutes, isOn, ... } }. A new id makes a new routine.
        const r = a.routine && typeof a.routine === 'object' ? a.routine : null;
        if (!r) return { error: 'There’s nothing to save.' };
        const bot = nameFor(view, r.botId);
        if (!bot) return { error: 'That bot isn’t on the computer any more.' };
        const task = String(r.task || '').trim();
        if (!task) return { error: 'Say what the routine should do.' };
        const min = Number(r.minutes);
        if (!Number.isInteger(min) || min < 0 || min >= 1440) return { error: 'Pick a time for the routine.' };
        const days = routineDays(r);
        if (days === '') return { error: 'Pick at least one day.' };
        if (!days) return { error: 'Squall on the computer runs routines every day, on weekdays or at weekends.' };
        const old = routineFor(view, r.id);
        const first = task.split('\n')[0].trim();
        const name = old && String(old.prompt || '').trim() === task && old.name ? old.name : (first.length > 40 ? first.slice(0, 39).trimEnd() + '…' : first);
        return {
          do: 'routineSave', oldId: old ? old.id : null, isOn: r.isOn !== false,
          routine: { name, bot, prompt: task.slice(0, 4000), time: pad2(Math.floor(min / 60)) + ':' + pad2(min % 60), days },
        };
      }
      case 'routine.toggle': {
        const rt = routineFor(view, a.routineId);
        if (!rt) return { error: 'That routine isn’t on the computer any more.' };
        if (typeof a.isOn !== 'boolean') return { error: 'A routine has to be on or off.' };
        return { do: 'routineOn', id: rt.id, on: a.isOn };
      }
      case 'routine.delete': {
        const rt = routineFor(view, a.routineId);
        return rt ? { do: 'routineDelete', id: rt.id } : { do: 'none' };
      }
      case 'routine.skip': {
        const rt = routineFor(view, a.routineId);
        if (!rt) return { error: 'That routine isn’t on the computer any more.' };
        return { do: 'routineSkip', id: rt.id };
      }
      default: return { error: CANT };
    }
  }

  // ---------------------------------------------------------------- voice calls

  const BYE_RX = /\b(bye|goodbye|good night|hang up|end (the )?call)\b/i;

  // What Chief's chat reply becomes on a call: speakable, short, no code or markdown.
  function speakable(text) {
    let t = String(text || '');
    t = t.replace(/```[\s\S]*?```/g, ' (I put the code in the chat.) ');
    t = t.replace(/`([^`]+)`/g, '$1').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*_#>]+/g, '');
    t = t.replace(/^\s*[-•]\s+/gm, '').replace(/\s+/g, ' ').trim();
    if (t.length > 600) {
      const cut = t.slice(0, 600);
      const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
      t = (end > 200 ? cut.slice(0, end + 1) : cut) + ' The rest is in the chat.';
    }
    return t;
  }

  // ---------------------------------------------------------------- the window

  function wire(h) {
    if (!h || !h.Bridge || !h.Bridge.host) return;   // the page opened without its host (a test page): nothing to link
    const S = h.S;
    let status = { running: false, phones: [], update: {} };
    let pairing = null;    // the open Pair a phone screen: { code, link, qrSvg, address, port, expiresAt }
    let sending = false;

    // what the phone sees, read from Squall's state each time
    function view() {
      const approvals = [];
      for (const c of S.chats || [])
        for (const m of c.messages || [])
          if (m.kind === 'approve' && m.approve && m.approve.state === 'waiting')
            approvals.push({ requestId: m.approve.requestId, who: m.who, tool: m.approve.tool, detail: m.approve.detail, text: m.text, at: m.time });
      return {
        agents: S.agents || [],
        lead: S.lead ? S.lead.name : null,
        chats: (S.chats || []).map(c => ({
          id: c.id, kind: c.kind, name: c.name, members: c.members || [], unread: c.unread || 0,
          messages: h.phoneMessages(c), typing: h.typingIn(c), raw: c,
        })),
        approvals,
        desktop: status.update || null,
        usage: h.usage ? h.usage() : null,
        routines: h.routines ? h.routines.list() : undefined,
        now: Date.now(),
      };
    }

    function push() {
      if (sending || !status.running || !(status.phones || []).length) return;
      sending = true;
      let data;
      try { data = buildState(view()); }
      catch (e) { sending = false; h.Bridge.call('log', { level: 'error', msg: 'link state: ' + (e && e.stack || e) }).catch(() => { }); return; }
      h.Bridge.call('link', { do: 'state', data }).catch(() => { }).finally(() => { sending = false; });
    }
    setInterval(push, 2000);
    // sends the newest state right away and waits for the host to have it, so the phone's next read already shows a change
    async function pushNow() {
      if (!status.running) return;
      try { await h.Bridge.call('link', { do: 'state', data: buildState(view()) }); } catch (e) { }
    }

    function answer(rid, result) {
      if (rid) h.Bridge.call('link', { do: 'answer', rid, result }).catch(() => { });
    }

    async function doAction(a) {
      const v = view();
      const r = routeAction(v, a);
      if (r.error) return { ok: false, error: r.error };
      const chat = r.chat && r.chat.raw;
      switch (r.do) {
        case 'send': return h.send(chat, r.text, false) ? { ok: true } : { ok: false, error: 'Squall couldn’t send that. Is it signed in to Claude?' };
        case 'read': h.markRead(chat); return { ok: true };
        case 'clear': h.clear(chat); return { ok: true };
        case 'clearAll': (S.chats || []).forEach(c => h.clear(c)); return { ok: true };
        case 'answer': {
          const res = await h.answer(r.requestId, r.decision);
          return res && res.ok ? { ok: true } : { ok: false, error: 'That question had already gone on the computer.' };
        }
        case 'group': { const c = h.group(r.name, r.members); return c ? { ok: true, id: c.id } : { ok: false, error: 'Couldn’t make that group.' }; }
        case 'usage': {
          if (!h.setUsage) return { ok: false, error: CANT };
          const change = {};
          if ('throttle' in r) change.throttle = r.throttle;
          if ('limit' in r) change.limit = r.limit;
          h.setUsage(change);
          await pushNow();
          return { ok: true };
        }
        case 'routineSave': case 'routineOn': case 'routineDelete': case 'routineSkip': {
          const rt = h.routines;
          if (!rt) return { ok: false, error: CANT };
          if (r.do === 'routineSave') await rt.save(r.routine, r.oldId, r.isOn);
          else if (r.do === 'routineOn') rt.setOn(r.id, r.on);
          else if (r.do === 'routineDelete') await rt.remove(r.id);
          else rt.skipToday(r.id);
          await pushNow();
          return { ok: true };
        }
        default: push(); return { ok: true };
      }
    }

    // a voice call from the phone: what Storm said goes into Chief's chat, and Chief's reply goes back to be spoken
    async function doVoice(t) {
      const v = view();
      const chief = chatFor(v, CHIEF);
      if (!chief) return { error: 'no_chief' };
      const name = (S.lead && S.lead.name) || 'Chief';
      if (t.event === 'start') return { text: 'Hi Storm, it’s ' + name + '. What’s up?' };
      const said = String(t.text || '').trim();
      if (!said) return { text: 'I didn’t catch that. Say it again?' };
      const c = chief.raw;
      const before = new Set(h.phoneMessages(c).map(m => m.id));
      if (!h.send(c, said, true)) return { error: 'busy' };
      const until = Date.now() + 38000;
      while (Date.now() < until) {
        await new Promise(res => setTimeout(res, 400));
        const fresh = h.phoneMessages(c).filter(m => !before.has(m.id) && m.who !== 'Storm' && m.kind === 'msg' && m.text.trim());
        if (fresh.length && !h.typingIn(c).length) {
          return { text: speakable(fresh.map(m => m.text).join(' ')), endCall: BYE_RX.test(said) };
        }
      }
      return { error: 'busy' };
    }

    h.Bridge.on('linkAsk', async m => {
      let result;
      try {
        if (m.kind === 'action') result = await doAction(m.body || {});
        else if (m.kind === 'voice') result = await doVoice(m.body || {});
        else if (m.kind === 'voiceEnd') {
          const chief = chatFor(view(), CHIEF);
          const secs = Math.max(0, Math.round(+((m.body || {}).seconds) || 0));
          if (chief) h.note(chief.raw, 'Call from ' + ((m.body || {}).phone || 'the phone') + ' ended' + (secs ? ' (' + (secs >= 60 ? Math.floor(secs / 60) + ' min ' : '') + (secs % 60) + ' s)' : '') + '.');
          return;
        }
        else result = { ok: false, error: CANT };
      } catch (e) { result = m.kind === 'voice' ? { error: 'busy' } : { ok: false, error: String(e && e.message || e) }; }
      answer(m.rid, result);
      if (m.kind === 'action') setTimeout(push, 50);
    });

    h.Bridge.on('linkPaired', m => {
      pairing = null;
      h.sfx('okYes');
      showPaired(m.deviceName || 'your phone');
      refresh();
    });
    h.Bridge.on('linkPhones', m => { status.phones = m.phones || []; });
    h.Bridge.on('linkUpdate', m => { const u = Object.assign({}, m); delete u.event; status.update = Object.assign({}, status.update, u); });

    async function refresh() {
      try { status = await h.Bridge.call('link', { do: 'status' }); } catch (e) { /* an older host without SquallLink */ }
      return status;
    }
    h.Bridge.call('link', { do: 'hello' }).then(st => { status = st || status; push(); }).catch(() => { status = { running: false, phones: [], update: {}, missing: true }; });

    // ---------------- Settings ----------------

    function ago(ms) {
      const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
      if (s < 90) return 'just now';
      if (s < 5400) return Math.round(s / 60) + ' min ago';
      if (s < 129600) return Math.round(s / 3600) + ' h ago';
      return Math.round(s / 86400) + ' days ago';
    }

    function settingsHTML() {
      const esc = h.esc;
      if (status.missing) return '<div class="set-sec"><div class="set-title">Squall app (iPhone and iPad)</div><div class="set-note">This copy of Squall.exe doesn’t have the phone link yet. Update Squall on the computer.</div></div>';
      const phones = status.phones || [];
      const rows = phones.map(p => '<div class="set-row"><span><b>' + esc(p.deviceName || 'A phone') + '</b> · ' + esc(p.platform || '') + ' · seen ' + esc(ago(p.lastSeen)) + '</span><button class="set-btn" data-s="link-unpair:' + esc(p.deviceId) + '">Unpair</button></div>').join('');
      const up = status.update || {};
      return '<div class="set-sec"><div class="set-title">Squall app (iPhone and iPad)</div>' +
        '<div class="set-row"><span>' + (status.running ? (phones.length ? phones.length + ' paired. They reach this PC on the home Wi-Fi, port ' + esc(String(status.port)) + '.' : 'No phone paired yet. Pair one to use Squall from the app.') : esc(status.error || 'The phone link is off.')) + '</span><button class="set-btn" data-s="link-pair">Pair a phone</button></div>' +
        rows +
        '<div class="set-row"><span>Version ' + esc(up.current || '') + (up.status ? ' · ' + esc(up.status) : '') + '</span><button class="set-btn" data-s="link-update"' + (up.busy ? ' disabled' : '') + '>Check for updates</button></div>' +
        '</div>';
    }

    // returns true when it handled a Settings button
    function onSettings(what) {
      if (what === 'link-pair') { h.closeModal(); openPair(); return true; }
      if (what.indexOf('link-unpair:') === 0) {
        h.Bridge.call('link', { do: 'unpair', deviceId: what.slice('link-unpair:'.length) }).then(st => { status = st; h.closeModal(); h.openSettings(); }).catch(() => { });
        return true;
      }
      if (what === 'link-update') {
        h.Bridge.call('link', { do: 'updateCheck' }).then(st => { status = st; h.closeModal(); h.openSettings(); }).catch(() => { });
        return true;
      }
      return false;
    }

    // ---------------- Pair a phone ----------------

    let tick = null;
    async function openPair() {
      h.closeModal();
      const box = document.createElement('div');
      box.className = 'modal-back';
      box.innerHTML = '<div class="modal set-modal link-pair"><div class="set-head"><h3>Pair a phone</h3><button class="set-x" data-x="1" title="Close">×</button></div><div class="link-body">Starting…</div></div>';
      document.body.append(box);
      const close = () => {
        clearInterval(tick); tick = null; pairing = null;
        h.Bridge.call('link', { do: 'pairClose' }).catch(() => { });
        box.remove();
      };
      box.addEventListener('click', e => {
        if (e.target === box || e.target.closest('[data-x]')) close();
        else if (e.target.closest('[data-new]')) render(true);
      });
      async function render(fresh) {
        const body = box.querySelector('.link-body');
        if (!body) return;
        let st;
        try { st = await h.Bridge.call('link', { do: 'pairOpen' }); }
        catch (e) { body.innerHTML = '<div class="set-note">' + h.esc(e.message || 'The phone link isn’t in this copy of Squall.exe yet.') + '</div>'; return; }
        if (!st.ok) { body.innerHTML = '<div class="set-note">' + h.esc(st.error || 'Couldn’t start pairing.') + '</div>'; return; }
        pairing = st;
        const esc = h.esc;
        body.innerHTML =
          '<div class="link-qr">' + st.qrSvg + '</div>' +
          '<ol class="link-steps"><li>Open the Squall app on your iPhone or iPad.</li><li>Tap <b>Pair</b> and scan this code.</li></ol>' +
          '<div class="link-code">Or tap <b>Type the code</b>: address <b>' + esc(st.address) + (st.port !== 47615 ? ':' + esc(String(st.port)) : '') + '</b>, code <b class="link-digits">' + esc(st.code.slice(0, 3) + ' ' + st.code.slice(3)) + '</b></div>' +
          '<div class="set-note link-left"></div>' +
          ((st.otherAddresses || []).length ? '<div class="set-note">Not working? The phone must be on the same Wi-Fi. This PC also answers on ' + st.otherAddresses.map(esc).join(', ') + '.</div>' : '') +
          '<div class="set-note">Windows may ask once to let Squall take connections: allow it for private networks.</div>';
        clearInterval(tick);
        const left = body.querySelector('.link-left');
        const upd = () => {
          const s = Math.ceil((st.expiresAt - Date.now()) / 1000);
          if (!box.isConnected) { clearInterval(tick); return; }
          if (s <= 0) {
            clearInterval(tick);
            left.innerHTML = 'This code ran out. <button class="set-btn" data-new="1">New code</button>';
            const qr = body.querySelector('.link-qr'); if (qr) qr.style.opacity = '0.15';
            return;
          }
          left.textContent = 'The code works for ' + (s >= 60 ? Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') : s + ' s') + ' and for one phone.';
        };
        tick = setInterval(upd, 1000);
        upd();
        if (fresh) h.sfx('toggle');
      }
      render(false);
    }

    function showPaired(name) {
      const box = document.querySelector('.link-pair');
      clearInterval(tick); tick = null;
      if (!box) return;
      const body = box.querySelector('.link-body');
      if (body) body.innerHTML = '<div class="link-done">✓ Paired with <b>' + h.esc(name) + '</b></div><div class="set-note">Your team, chats and approvals now show in the app while it’s on the same Wi-Fi as this PC.</div>';
    }

    root.SquallLinkUI = { settingsHTML, onSettings, openPair, refresh, push };
  }

  const api = { CHIEF, botIds, hash, buildState, phoneMessages, phoneUsage, phoneRoutines, windowId, routeAction, chatFor, speakable, wire };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SquallLinkCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
