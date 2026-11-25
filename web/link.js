// Squall on the iPhone and iPad (the Squall app from Squall-mobile).
//
// The host's SquallLink (src/SquallLink) runs the phone API from Squall-mobile docs/pairing.md. This file is the window's half:
//   - every 2 seconds it hands the host the phone's view of the team (bots, chats, groups, approvals), built from Squall's
//     real state: nothing here is made up, and what Squall doesn't have (routines, jobs) is simply left out;
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
    // Squall's own version, for the phone's Settings > Computer (only what the updater really knows)
    const d = view && view.desktop;
    // the jobs the bots are on right now (and ones that ended a few minutes ago), for the phone's Live work screens
    const work = phoneWork(view && view.work, idOf);
    if (work.length) state.work = work;
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
      case 'work.stop': case 'work.pause': case 'work.note': {
        // the phone's Live work: Stop, Pause / Resume, and a note to the bot doing the job
        const w = workFor(view, a.workId);
        const running = w && ['working', 'waiting', 'paused'].includes(w.job.state);
        if (type === 'work.note') {
          const text = String(a.text || '').trim();
          if (!text) return { error: 'There’s nothing to send.' };
          const c = w && chatFor(view, w.botId);
          if (!c) return { error: 'That job has finished.' };
          return { do: 'send', chat: c, text: text.slice(0, 20000) };
        }
        if (!running) return { error: 'That job has already finished.' };
        if (type === 'work.stop') return { do: 'workStop', name: w.name };
        if (typeof a.paused !== 'boolean') return { error: 'Pause has to be on or off.' };
        if (a.paused === (w.job.state === 'paused')) return { do: 'none' };
        return { do: 'workPause', name: w.name, paused: a.paused };
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

  // ---------------------------------------------------------------- live work

  const WORK_STATES = ['working', 'waiting', 'paused', 'done', 'stopped'];
  const EDIT_TOOLS = { Edit: 'Edited', MultiEdit: 'Edited', NotebookEdit: 'Edited', Write: 'Wrote' };
  const MAX_WORK = 8, MAX_STEPS = 14, MAX_TERMINAL = 40, MAX_OUT = 8, MAX_FILES = 20;

  // A job's id for the phone: one per bot, so the screen the phone has open follows the bot from turn to turn.
  const workIdOf = botId => 'work-' + botId;

  // A tool's output as terminal lines: the last few non-empty lines, as an error when the tool failed.
  function outLines(out, failed) {
    const lines = String(out || '').replace(/\r/g, '').split('\n').map(l => l.replace(/\s+$/, '')).filter(l => l.trim());
    const kept = lines.slice(-MAX_OUT).map(l => ({ text: l.length > 300 ? l.slice(0, 299) + '…' : l, kind: failed ? 'err' : 'dim' }));
    if (lines.length > MAX_OUT) kept.unshift({ text: '… ' + (lines.length - MAX_OUT) + ' more line' + (lines.length - MAX_OUT === 1 ? '' : 's'), kind: 'dim' });
    return kept;
  }

  // jobs: [{ name, title, from, state, startedAt (ms), now, askId, tools: [{ title, name, status: running|ok|error, command, out, file }] }]
  // (what app.js gives, from Squall's real runs). Returns the phone's `work` list: steps are the tools the bot used, the terminal is its
  // shell commands and their output, files are the files it wrote or edited. Nothing is made up: a job Squall can't see inside (a live
  // session) has no steps, only what it's doing now.
  function phoneWork(jobs, idOf) {
    if (!Array.isArray(jobs)) return [];
    const out = [];
    for (const j of jobs) {
      const botId = j && idOf(j.name);
      if (!botId || out.some(w => w.botId === botId)) continue;
      const state = WORK_STATES.includes(j.state) ? j.state : 'working';
      const ended = state === 'done' || state === 'stopped';
      const tools = (Array.isArray(j.tools) ? j.tools : []).filter(t => t && t.title);
      const steps = tools.slice(-MAX_STEPS).map(t => {
        const failed = t.status === 'error';
        const lines = [];
        if (t.command) lines.push({ text: '$ ' + String(t.command).slice(0, 300), kind: 'cmd' });
        lines.push(...outLines(t.out, failed));
        if (failed && !t.out) lines.push({ text: 'That step failed.', kind: 'err' });
        return { title: String(t.title).slice(0, 120), state: t.status === 'running' && !ended ? 'now' : 'done', lines };
      });
      let terminal = [];
      for (const t of tools) if (t.command) terminal.push({ text: '$ ' + String(t.command).slice(0, 300), kind: 'cmd' }, ...outLines(t.out, t.status === 'error'));
      terminal = terminal.slice(-MAX_TERMINAL);
      const files = [];
      for (const t of tools) {
        if (!t.file || !EDIT_TOOLS[t.name]) continue;
        const path = String(t.file);
        const i = files.findIndex(f => f.path === path);
        if (i >= 0) files.splice(i, 1);
        files.push({ path, change: EDIT_TOOLS[t.name], edited: t.status === 'ok' });
      }
      const w = { id: workIdOf(botId), botId, title: String(j.title || 'Working').trim().slice(0, 120) || 'Working', from: String(j.from || ''), state, now: String(j.now || '').slice(0, 200), steps, terminal, files: files.slice(-MAX_FILES) };
      const at = j.startedAt ? new Date(j.startedAt) : null;
      if (at && !isNaN(at)) w.startedAt = at.toISOString();
      if (state === 'waiting' && j.askId) w.askId = String(j.askId);
      out.push(w);
      if (out.length >= MAX_WORK) break;
    }
    // running jobs first, then the ones that just ended
    return out.sort((x, y) => (['done', 'stopped'].includes(x.state)) - (['done', 'stopped'].includes(y.state)));
  }

  // The bot's name for a job id from the phone, and the job itself, or null when it has gone.
  function workFor(view, workId) {
    const agents = (view && view.agents) || [];
    const leadName = view && view.lead ? view.lead : (agents.find(a => a.lead) || agents[0] || {}).name;
    const ids = botIds(agents, leadName);
    const name = Object.keys(ids).find(n => workIdOf(ids[n]) === workId);
    const job = name && ((view && view.work) || []).find(j => j && j.name === name);
    return job ? { name, botId: ids[name], job } : null;
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
        work: h.work ? h.work.list() : undefined,
        desktop: status.update || null,
        usage: h.usage ? h.usage() : null,
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
        case 'workStop': case 'workPause': {
          if (!h.work) return { ok: false, error: CANT };
          const res = r.do === 'workStop' ? h.work.stop(r.name) : h.work.pause(r.name, r.paused);
          if (res !== true) return { ok: false, error: typeof res === 'string' ? res : 'Squall couldn’t do that just now.' };
          await pushNow();
          return { ok: true };
        }
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

  const api = { CHIEF, botIds, hash, buildState, phoneMessages, phoneUsage, windowId, routeAction, chatFor, speakable, wire };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SquallLinkCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
