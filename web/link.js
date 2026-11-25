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

  // ---------------------------------------------------------------- send later
  // Storm can write a message on the phone and pick when it goes. Squall keeps it (localStorage, so it lasts a restart) and sends
  // it at that time, the same as typing it then. The phone sees the list as state.later and can cancel one or send it now.

  const LATER_KEY = 'squall.sendLater';
  const LATER_MIN_MS = 60 * 1000;                  // at least a minute ahead
  const LATER_MAX_MS = 7 * 24 * 3600 * 1000;       // at most a week ahead
  const LATER_STALE_MS = 12 * 3600 * 1000;         // more than 12 hours late (the computer was off): it doesn't go
  const MAX_LATER = 30;

  // The phone's id for a Squall chat: a bot's chat is the bot's id, a group or the team keeps its own id. Null when it's gone.
  function phoneChatId(view, squallChatId) {
    const c = ((view && view.chats) || []).find(x => x && x.id === squallChatId);
    if (!c) return null;
    if (c.kind !== 'dm') return c.id;
    const ids = botIds((view && view.agents) || [], view && view.lead);
    return ids[c.members && c.members[0]] || null;
  }

  // list: [{ id, chat (Squall's chat id), text, at (ms) }]. Returns state.later: [{ id, chatId, text, at (ISO) }], soonest first
  function phoneLater(view, list) {
    const out = [];
    for (const l of Array.isArray(list) ? list : []) {
      if (!l || !l.id || typeof l.text !== 'string') continue;
      const chatId = phoneChatId(view, l.chat);
      const at = new Date(Number(l.at));
      if (!chatId || isNaN(at)) continue;
      out.push({ id: String(l.id), chatId, text: l.text.slice(0, MAX_TEXT), at: at.toISOString() });
    }
    out.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0));
    return out.slice(0, MAX_LATER);
  }

  // Adds state.later and works the version out again so the phone redraws when the list changes.
  function withLater(state, view) {
    const later = phoneLater(view, view && view.later);
    if (later.length) { state.later = later; state.version = hash(JSON.stringify(state)); }
    return state;
  }

  // chat.sendLater { chatId, text, at (ISO) }, chat.cancelLater { itemId } and chat.sendLaterNow { itemId }
  function laterRoute(view, a, type) {
    const list = (view && Array.isArray(view.later)) ? view.later : [];
    if (type === 'chat.sendLater') {
      const c = chatFor(view, a.chatId);
      const text = String(a.text || '').trim();
      if (!c) return { error: 'That chat isn’t on the computer any more.' };
      if (!text) return { error: 'There’s nothing to send.' };
      const at = Date.parse(String(a.at || ''));
      const now = (view && view.now) || Date.now();
      if (!isFinite(at)) return { error: 'Pick when to send it.' };
      if (at < now + LATER_MIN_MS - 5000) return { error: 'Pick a time at least a minute from now.' };
      if (at > now + LATER_MAX_MS) return { error: 'Pick a time in the next 7 days.' };
      if (list.length >= MAX_LATER) return { error: 'There are already ' + MAX_LATER + ' messages waiting to send. Cancel one first.' };
      return { do: 'later', later: { op: 'add', chat: c.id, text: text.slice(0, 20000), at } };
    }
    const id = String(a.itemId || '');   // not a.id: that's the action's own id
    const item = list.find(l => l && String(l.id) === id);
    if (!item) return { error: 'That message already went, or was canceled.' };
    return { do: 'later', later: { op: type === 'chat.cancelLater' ? 'cancel' : 'now', id: item.id } };
  }

  // "7:30 AM" today, or "Thu 7:30 AM" on another day, in the computer's own time
  function laterWhen(ms, now) {
    const d = new Date(ms), t = new Date(now || Date.now());
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return d.toDateString() === t.toDateString() ? time : d.toLocaleDateString([], { weekday: 'short' }) + ' ' + time;
  }

  // The window's list and its clock. changed() is called whenever the list changes, so the phone sees it right away.
  function laterStore(h, changed) {
    let list = [];
    try {
      const raw = JSON.parse(root.localStorage.getItem(LATER_KEY) || '[]');
      if (Array.isArray(raw)) list = raw.filter(l => l && l.id && l.chat && typeof l.text === 'string' && isFinite(l.at));
    } catch (e) { }
    const save = () => { try { root.localStorage.setItem(LATER_KEY, JSON.stringify(list)); } catch (e) { } };
    const chatOf = id => ((h.S && h.S.chats) || []).find(c => c.id === id);
    const note = (chat, text) => { try { if (chat && h.note) h.note(chat, text); } catch (e) { } };
    function sendOne(item) {
      list = list.filter(l => l.id !== item.id);
      save();
      const chat = chatOf(item.chat);
      if (!chat) return false;
      const ok = !!h.send(chat, item.text, false);
      if (!ok) note(chat, 'A message you set to send later couldn’t go: “' + item.text.slice(0, 80) + '”');
      return ok;
    }
    function tick() {
      const now = Date.now();
      const due = list.filter(l => l.at <= now).sort((x, y) => x.at - y.at);
      if (!due.length) return;
      for (const item of due) {
        if (now - item.at > LATER_STALE_MS) {   // the computer was off: a day-old message would be confusing now
          list = list.filter(l => l.id !== item.id);
          save();
          note(chatOf(item.chat), 'A message set for ' + laterWhen(item.at, now) + ' didn’t go, because Squall wasn’t running then: “' + item.text.slice(0, 80) + '”');
        } else sendOne(item);
      }
      changed();
    }
    const every = setInterval(tick, 15000), first = setTimeout(tick, 4000);
    if (every && every.unref) { every.unref(); first.unref(); }   // Node (the tests): don't keep the process alive
    return {
      list: () => list.slice(),
      tick,
      do(op) {
        if (op.op === 'add') {
          const item = { id: 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), chat: op.chat, text: op.text, at: op.at, made: Date.now() };
          list.push(item);
          save();
          note(chatOf(op.chat), 'From your phone: a message is set to send ' + laterWhen(op.at) + '.');
          changed();
          return { ok: true, id: item.id };
        }
        const item = list.find(l => l.id === op.id);
        if (!item) return { ok: false, error: 'That message already went, or was canceled.' };
        if (op.op === 'cancel') {
          list = list.filter(l => l.id !== op.id);
          save();
          changed();
          return { ok: true };
        }
        const ok = sendOne(item);
        changed();
        return ok ? { ok: true } : { ok: false, error: 'Squall couldn’t send that. Is it signed in to Claude?' };
      },
    };
  }

  // the pure parts, for tests/web/later.test.mjs (Node) without touching the exports below
  root.SquallLater = { phoneChatId, phoneLater, withLater, laterRoute, laterWhen, laterStore, LATER_KEY };

  // ---------------------------------------------------------------- manage teammates (docs/phone-teammates.md)

  // The phone's Manage teammate sheet: rename, chief on or off, and remove. app.js does the work through window.SquallTeamOps,
  // with the same checks as the right-click menu here.
  const TEAM_MAX = 12, CHIEFS_MAX = 4;
  const NAME_RX = /^[A-Za-z][A-Za-z0-9]{1,19}$/;
  const NAME_HELP = 'Use a short name: letters and digits, starting with a letter (2 to 20 characters).';

  function leadOf(view) {
    const agents = (view && view.agents) || [];
    return view && view.lead ? view.lead : (agents.find(a => a && a.lead) || agents[0] || {}).name;
  }

  // Adds bots[].chief and state.team { size, max, chiefs, maxChiefs, manage }, then works the version out again
  function withTeam(state, view) {
    const agents = ((view && view.agents) || []).filter(a => a && a.name);
    const ids = botIds(agents, leadOf(view));
    const chiefIds = new Set(agents.filter(a => a.lead).map(a => ids[a.name]));
    const projects = projectList(view);
    const folderOf = {};
    for (const a of agents) if (a.folder) folderOf[ids[a.name]] = projectName(projects, a.folder);
    for (const b of state.bots || []) {
      if (chiefIds.has(b.id)) b.chief = true;
      if (folderOf[b.id]) b.project = folderOf[b.id];
    }
    state.team = { size: agents.length, max: TEAM_MAX, chiefs: chiefIds.size, maxChiefs: CHIEFS_MAX, manage: !!(view && view.manage) };
    if (view && Array.isArray(view.projects)) state.team.projects = projects.map(p => p.name);
    state.version = hash(JSON.stringify(Object.assign({}, state, { version: '' })));
    return state;
  }

  // the folders under Documents\Projects that the computer listed: [{ name, path }], names unique, at most 200
  function projectList(view) {
    const out = [], seen = new Set();
    for (const p of (view && Array.isArray(view.projects)) ? view.projects : []) {
      if (!p || typeof p.name !== 'string' || typeof p.path !== 'string' || !p.name.trim() || seen.has(p.name)) continue;
      seen.add(p.name);
      out.push({ name: p.name.trim().slice(0, 80), path: p.path });
      if (out.length >= 200) break;
    }
    return out;
  }
  // the project's name for a teammate's folder, or the folder's last part when it isn't one of the listed projects
  function projectName(projects, folder) {
    const norm = f => String(f || '').replace(/[\\/]+$/, '').toLowerCase();
    const hit = projects.find(p => norm(p.path) === norm(folder));
    return hit ? hit.name : String(folder).split(/[\\/]/).filter(Boolean).pop() || '';
  }

  // bot.rename { botId, name }, bot.chief { botId, on }, bot.remove { botId, confirm: the name the phone showed },
  // bot.project { botId, project: a project's name, or "" for all of Projects }.
  // Returns null for any other action (so the usual routes handle it), else { do, ... } or { error }
  function teamRoute(view, a) {
    const type = a && typeof a.type === 'string' ? a.type : '';
    if (type !== 'bot.rename' && type !== 'bot.chief' && type !== 'bot.remove' && type !== 'bot.project') return null;
    const name = nameFor(view, String(a.botId || ''));
    if (!name) return { error: 'That teammate isn’t on the team any more.' };
    if (type === 'bot.rename') {
      const to = String(a.name || '').trim();
      if (!NAME_RX.test(to)) return { error: NAME_HELP };
      const taken = ((view && view.agents) || []).some(x => x && x.name && x.name !== name && x.name.toLowerCase() === to.toLowerCase());
      if (taken) return { error: to + ' is already on the team.' };
      return { do: 'rename', name, to };
    }
    if (type === 'bot.chief') {
      if (typeof a.on !== 'boolean') return { error: 'Say whether it should be a chief.' };
      return { do: 'chief', name, on: a.on };
    }
    if (type === 'bot.project') {
      const want = String(a.project || '').trim();
      if (!want) return { do: 'project', name, path: null };
      const hit = projectList(view).find(p => p.name === want);
      if (!hit) return { error: 'That project isn’t on the computer any more.' };
      return { do: 'project', name, path: hit.path };
    }
    // a screen that was open while the team changed can't remove the wrong teammate
    if (String(a.confirm || '') !== name) return { error: 'The team changed. Open the teammate again and try once more.' };
    return { do: 'remove', name };
  }

  // Does what teamRoute worked out. ops: window.SquallTeamOps; after: reads the view again once the change is in
  async function teamDo(r, ops, after) {
    if (r.error) return { ok: false, error: r.error };
    if (!ops) return { ok: false, error: CANT };
    if (r.do === 'chief') { await ops.chief(r.name, r.on); return { ok: true }; }
    if (r.do === 'remove') { await ops.remove(r.name); return { ok: true }; }
    if (r.do === 'project') { if (!ops.setFolder) return { ok: false, error: CANT }; await ops.setFolder(r.name, r.path); return { ok: true }; }
    const newName = await ops.rename(r.name, r.to);
    const v = await after();
    const id = botIds((v && v.agents) || [], leadOf(v))[newName];
    return id ? { ok: true, id } : { ok: true };
  }

  // keeps the computer's project list fresh for the phone: read once, then every minute (and after a change), never more than one at a time
  function projectCache(ops, changed) {
    let list = null, busy = false;
    async function load() {
      const o = ops();
      if (busy || !o || !o.projects) return;
      busy = true;
      try {
        const next = await o.projects();
        const fresh = projectList({ projects: next });
        if (JSON.stringify(fresh) !== JSON.stringify(list)) { list = fresh; changed(); }
      } catch (e) { } finally { busy = false; }
    }
    const t = setInterval(load, 60000);
    if (t && t.unref) t.unref();
    const first = setTimeout(load, 1500);
    if (first && first.unref) first.unref();
    return { list: () => list, load };
  }

  root.SquallTeam = { withTeam, teamRoute, teamDo, projectList, projectName, projectCache, TEAM_MAX, CHIEFS_MAX };

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
      case 'chat.sendLater': case 'chat.cancelLater': case 'chat.sendLaterNow': return laterRoute(view, a, type);
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
    // messages set to send later (see "send later" above): the phone's state and actions see the list
    const later = laterStore(h, () => pushNow());
    const laterView = () => Object.assign(view(), { later: later.list() });
    const projects = projectCache(() => root.SquallTeamOps, () => pushNow());
    const teamView = () => { const v = Object.assign(laterView(), { manage: !!root.SquallTeamOps }); const p = projects.list(); if (p) v.projects = p; return v; };
    const phoneState = () => { const v = teamView(); return withTeam(withLater(buildState(v), v), v); };

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
        now: Date.now(),
      };
    }

    function push() {
      if (sending || !status.running || !(status.phones || []).length) return;
      sending = true;
      let data;
      try { data = phoneState(); }
      catch (e) { sending = false; h.Bridge.call('log', { level: 'error', msg: 'link state: ' + (e && e.stack || e) }).catch(() => { }); return; }
      h.Bridge.call('link', { do: 'state', data }).catch(() => { }).finally(() => { sending = false; });
    }
    setInterval(push, 2000);
    // sends the newest state right away and waits for the host to have it, so the phone's next read already shows a change
    async function pushNow() {
      if (!status.running) return;
      try { await h.Bridge.call('link', { do: 'state', data: phoneState() }); } catch (e) { }
    }

    function answer(rid, result) {
      if (rid) h.Bridge.call('link', { do: 'answer', rid, result }).catch(() => { });
    }

    async function doAction(a) {
      const v = laterView();
      const r = routeAction(v, a);
      if (r.error) return { ok: false, error: r.error };
      if (r.do === 'later') return later.do(r.later);
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
        if (m.kind === 'action') {
          // Manage teammate first (bot.rename, bot.chief, bot.remove); everything else goes the usual way
          const team = teamRoute(teamView(), m.body || {});
          result = team ? await teamDo(team, root.SquallTeamOps, async () => { await pushNow(); return view(); }) : await doAction(m.body || {});
          if (team && team.do === 'project') projects.load();
        }
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
