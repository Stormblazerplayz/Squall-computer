// Squall on the iPhone and iPad (the Squall app from Squall-mobile).
//
// The host's SquallLink (src/SquallLink) runs the phone API from Squall-mobile docs/pairing.md. This file is the window's half:
//   - every 2 seconds it hands the host the phone's view of the team (bots, chats, groups, approvals), built from Squall's
//     real state: nothing here is made up, and what Squall doesn't have (jobs) is simply left out;
//   - that includes the shared To do list (Doing now, Next, Done), which the phone can add to, tick off, give to a bot or clear;
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

  // ---------------------------------------------------------------- notes (docs/phone-notes.md)

  // The Obsidian vault on the phone: search it, read a note and add text to the end of one. The phone asks with an action and the
  // answer comes in the next state as state.notes, so nothing new is needed in the phone API. Only notes the computer listed can be
  // read or added to, and the answer leaves the state when the phone hasn't asked for 10 minutes.
  const NOTES_MAX = 40, NOTE_MAX_TEXT = 20000, NOTE_ADD_MAX = 2000, NOTES_IDLE = 10 * 60000;

  function noteName(path) { return String(path || '').replace(/\.md$/i, '').split('/').pop(); }

  // notes.search { query }, notes.open { path }, notes.close, notes.append { path, text }. known: the paths the phone was shown
  function notesRoute(a, known) {
    const type = a && typeof a.type === 'string' ? a.type : '';
    if (!/^notes\.(search|open|close|append)$/.test(type)) return null;
    if (type === 'notes.search') return { do: 'search', query: String(a.query || '').trim().slice(0, 200) };
    if (type === 'notes.close') return { do: 'close' };
    const path = String(a.path || '');
    if (!path || !known.has(path)) return { error: 'That note isn’t in the list any more. Search again.' };
    if (type === 'notes.open') return { do: 'open', path };
    const text = String(a.text || '').trim();
    if (!text) return { error: 'There’s nothing to add.' };
    if (text.length > NOTE_ADD_MAX) return { error: 'That’s too long to add from the phone (2,000 characters at most).' };
    return { do: 'append', path, text };
  }

  // search rows [{ path, snippet }] or graph nodes [{ path, name }] as the phone's list: [{ path, name, snippet }]
  function noteRows(rows) {
    const out = [], seen = new Set();
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!r || typeof r.path !== 'string' || !r.path || seen.has(r.path)) continue;
      seen.add(r.path);
      out.push({ path: r.path, name: String(r.name || noteName(r.path)), snippet: String(r.snippet || '').slice(0, 240) });
      if (out.length >= NOTES_MAX) break;
    }
    return out;
  }

  // holds what the phone asked for: { query, results, note, error, at }
  function notesDesk(ops, now) {
    let st = null;
    const known = new Set();
    function remember(list) { for (const r of list) known.add(r.path); }
    async function run(r) {
      if (r.error) return { ok: false, error: r.error };
      const o = ops();
      if (!o) return { ok: false, error: CANT };
      const t = now();
      if (r.do === 'close') { if (st) st = Object.assign({}, st, { note: null, at: t }); return { ok: true }; }
      if (r.do === 'search') {
        let rows;
        if (r.query) rows = await o.search(r.query);
        else rows = ((await o.list()) || []).slice().sort((x, y) => String(x.path).localeCompare(String(y.path)));
        const results = noteRows(rows);
        remember(results);
        st = { query: r.query, results, note: st && st.note, at: t };
        return { ok: true };
      }
      const read = async path => {
        const text = String((await o.read(path)) || '');
        return { path, name: noteName(path), text: text.slice(0, NOTE_MAX_TEXT), cut: text.length > NOTE_MAX_TEXT };
      };
      if (r.do === 'open') {
        const note = await read(r.path);
        st = Object.assign({ query: '', results: [] }, st || {}, { note, at: t });
        return { ok: true };
      }
      await o.append(r.path, r.text);
      const note = await read(r.path);
      st = Object.assign({ query: '', results: [] }, st || {}, { note, at: t });
      return { ok: true };
    }
    return {
      route: a => notesRoute(a, known),
      run,
      // state.notes while the phone is using it
      view: () => (st && now() - st.at < NOTES_IDLE ? st : null),
    };
  }

  function withNotes(state, notes) {
    if (!notes) return state;
    state.notes = { query: notes.query || '', results: notes.results || [], note: notes.note || null };
    state.version = hash(JSON.stringify(Object.assign({}, state, { version: '' })));
    return state;
  }

  root.SquallNotes = { notesRoute, noteRows, noteName, notesDesk, withNotes, NOTES_MAX, NOTE_MAX_TEXT };

  // ---------------------------------------------------------------- photos from the phone
  // chat.sendPhoto { chatId, text?, photos: [{ data (base64, no data: prefix), type: image/jpeg or image/png, name? }] }
  // Each photo is saved the same way as one pasted into the chat here, and the message goes in as Storm's with the photos
  // attached, so the teammate gets the saved paths to open. The link takes 1 MB a request, so the phone shrinks photos first.

  const PHOTOS_MAX = 3;
  const PHOTO_MAX_BYTES = 700000;
  const PHOTO_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png' };
  const B64_RX = /^[A-Za-z0-9+/]+={0,2}$/;

  function photoLabel(n) { return n > 1 ? '📷 ' + n + ' photos' : '📷 Photo'; }

  // bytes a base64 string holds, or -1 when it isn't base64
  function b64Bytes(data) {
    if (typeof data !== 'string' || !data.length || data.length % 4 || !B64_RX.test(data)) return -1;
    return data.length / 4 * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
  }

  function photoName(raw, type, i) {
    const ext = PHOTO_TYPES[type];
    let name = String(raw || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '').trim().slice(0, 60);
    if (!name) name = 'phone-photo-' + (i + 1);
    if (!new RegExp('\\.' + ext + '$', 'i').test(name)) name = name.replace(/\.[a-z0-9]{1,5}$/i, '') + '.' + ext;
    return name;
  }

  // null when it isn't a photo action; { error } or { do: 'photo', chat, text, photos: [{ dataUrl, name }] }
  function photoRoute(view, a) {
    if (!a || a.type !== 'chat.sendPhoto') return null;
    const chat = chatFor(view, a.chatId);
    if (!chat) return { error: 'That chat isn’t on the computer any more.' };
    const list = Array.isArray(a.photos) ? a.photos : [];
    if (!list.length) return { error: 'Pick a photo to send.' };
    if (list.length > PHOTOS_MAX) return { error: 'Send up to ' + PHOTOS_MAX + ' photos at a time.' };
    const photos = [];
    for (let i = 0; i < list.length; i++) {
      const p = list[i] || {};
      const type = String(p.type || '').toLowerCase();
      if (!PHOTO_TYPES[type]) return { error: 'Send photos as JPEG or PNG.' };
      const bytes = b64Bytes(p.data);
      if (bytes < 0) return { error: 'That photo didn’t come through. Try again.' };
      if (bytes > PHOTO_MAX_BYTES) return { error: 'That photo is too big to send.' };
      photos.push({ dataUrl: 'data:' + type + ';base64,' + p.data, type, name: photoName(p.name, type, i) });
    }
    return { do: 'photo', chat, text: String(a.text || '').trim().slice(0, 20000), photos };
  }

  // ops: { save(dataUrl, type, name) -> { path, url }, send(chat, text, saved) -> true when it went }
  async function photoDo(r, ops) {
    if (r.error) return { ok: false, error: r.error };
    if (!ops) return { ok: false, error: CANT };
    const saved = [];
    for (const p of r.photos) {
      const got = await ops.save(p.dataUrl, p.type, p.name);
      if (!got || !got.path) return { ok: false, error: 'Squall couldn’t save that photo on the computer.' };
      saved.push({ kind: 'image', path: got.path, url: got.url || '', name: p.name });
    }
    if (!ops.send(r.chat.raw, r.text, saved)) return { ok: false, error: 'Squall couldn’t send that. The chat may be busy, or Squall isn’t signed in to Claude.' };
    return { ok: true };
  }

  root.SquallPhotos = { photoRoute, photoDo, photoLabel, b64Bytes, photoName, PHOTOS_MAX, PHOTO_MAX_BYTES };

  // ---------------------------------------------------------------- the team's model from the phone
  // state.models = { current: '' | model id, choices: [{ id, name, note }] } and bots[].model = the model a teammate last ran on.
  // team.model { model } picks one model for every bot ('' = by role), the same as the model chip on the computer.

  const MODEL_ID_RX = /^[a-z0-9][a-z0-9.\-]{0,60}$/;

  // ops: { list() -> [{ id, name, note }], current() -> id }
  function modelChoices(ops) {
    if (!ops) return null;
    const out = [], seen = new Set();
    for (const m of ops.list() || []) {
      if (!m || typeof m.id !== 'string' || seen.has(m.id) || (m.id && !MODEL_ID_RX.test(m.id))) continue;
      seen.add(m.id);
      out.push({ id: m.id, name: String(m.name || m.id).slice(0, 40), note: String(m.note || '').slice(0, 200) });
    }
    return out.length ? out : null;
  }

  function withModels(state, view, ops) {
    const choices = modelChoices(ops);
    if (!choices) return state;
    const current = String(ops.current() || '');
    state.models = { current: choices.some(c => c.id === current) ? current : '', choices };
    const agents = ((view && view.agents) || []).filter(a => a && a.name);
    const ids = botIds(agents, leadOf(view));
    for (const a of agents) {
      const id = ids[a.name], model = typeof a.model === 'string' ? a.model.trim() : '';
      if (!id || !model || !MODEL_ID_RX.test(model)) continue;
      const b = (state.bots || []).find(x => x.id === id);
      if (b) b.model = model;
    }
    state.version = hash(JSON.stringify(Object.assign({}, state, { version: '' })));
    return state;
  }

  // null when it isn't a model action; { error } or { do: 'model', model }
  function modelRoute(a, ops) {
    if (!a || a.type !== 'team.model') return null;
    const choices = modelChoices(ops);
    if (!choices) return { error: CANT };
    const id = a.model;
    if (typeof id !== 'string' || !choices.some(c => c.id === id)) return { error: 'That model isn’t one Squall can use.' };
    return { do: 'model', model: id };
  }

  function modelDo(r, ops) {
    if (r.error) return { ok: false, error: r.error };
    if (!ops) return { ok: false, error: CANT };
    ops.set(r.model);
    return String(ops.current() || '') === r.model ? { ok: true } : { ok: false, error: 'Squall couldn’t change the model.' };
  }

  root.SquallModels = { modelChoices, withModels, modelRoute, modelDo };

  // ---------------------------------------------------------------- work timers from the phone
  // state.timers = [{ chatId, minutes (null = continuous), startedAt, until (null = continuous), paused }] and
  // state.workFor = 'off' | 'inf' | minutes (the computer's dial). timer.start { chatId, minutes: 10..600 or 'inf' } starts a
  // timer in that chat the same as the dial's Done; timer.stop { chatId } stops it. Goals go as a /goal message (chat.send).

  const TIMER_MIN = 10, TIMER_MAX = 600;

  function isoOf(ms) { return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null; }

  // the phone's chat id for a computer chat id: a bot id for a dm, else the chat's own id
  function phoneChatId(view, rawId) {
    const c = ((view && view.chats) || []).find(x => x.id === rawId);
    if (!c) return null;
    if (c.kind !== 'dm') return c.id;
    const agents = (view.agents || []).filter(a => a && a.name);
    return botIds(agents, leadOf(view))[c.members && c.members[0]] || null;
  }

  // ops: { list() -> [{ chatId (computer's), until (ms or null), mins, startedAt (ms), paused }], workFor() }
  function withTimers(state, view, ops) {
    if (!ops) return state;
    const out = [];
    for (const t of ops.list() || []) {
      const id = t && phoneChatId(view, t.chatId);
      if (!id) continue;
      const endless = t.until == null || t.until === Infinity;
      out.push({ chatId: id, minutes: endless ? null : Math.round(+t.mins) || null, startedAt: isoOf(+t.startedAt), until: endless ? null : isoOf(+t.until), paused: !!t.paused });
    }
    out.sort((a, b) => String(a.chatId).localeCompare(String(b.chatId)));
    state.timers = out;
    const w = ops.workFor();
    state.workFor = w === 'off' || w === 'inf' ? w : (Number.isInteger(w) && w >= TIMER_MIN && w <= TIMER_MAX ? w : 'off');
    state.version = hash(JSON.stringify(Object.assign({}, state, { version: '' })));
    return state;
  }

  // null when it isn't a timer action; { error } or { do: 'timerStart' | 'timerStop', chat, value }
  function timerRoute(view, a) {
    if (!a || (a.type !== 'timer.start' && a.type !== 'timer.stop')) return null;
    const chat = chatFor(view, a.chatId);
    if (!chat) return { error: 'That chat isn’t on the computer any more.' };
    if (a.type === 'timer.stop') return { do: 'timerStop', chat };
    const m = a.minutes;
    if (m === 'inf') return { do: 'timerStart', chat, value: 'inf' };
    if (!Number.isInteger(m) || m < TIMER_MIN || m > TIMER_MAX) return { error: 'Pick ' + TIMER_MIN + ' minutes to ' + (TIMER_MAX / 60) + ' hours, or Continuous.' };
    return { do: 'timerStart', chat, value: m };
  }

  // ops: { start(chat, value) -> true, stop(chat) -> true when one was running }
  function timerDo(r, ops) {
    if (r.error) return { ok: false, error: r.error };
    if (!ops) return { ok: false, error: CANT };
    if (r.do === 'timerStop') return ops.stop(r.chat.raw) ? { ok: true } : { ok: false, error: 'There’s no timer running in that chat.' };
    return ops.start(r.chat.raw, r.value) ? { ok: true } : { ok: false, error: 'Squall couldn’t start the timer.' };
  }

  root.SquallTimers = { withTimers, timerRoute, timerDo, phoneChatId, TIMER_MIN, TIMER_MAX };

  // ---------------------------------------------------------------- summaries and catch up (docs/phone-summaries.md)

  // summary.message { chatId, messageId }: a short version of one long teammate message, the same as the Summary button under it on
  // the computer. summary.catchUp { chatId }: a short version of the chat's latest messages. Both run on the computer (Haiku) and can
  // take longer than an action may, so the action only starts the job and the answer comes in the next state: the message's
  // `summary`, and state.summaries { jobs, catchUps }.

  const SUM_MIN = 500, SUM_JOBS = 2, SUM_TIMEOUT = 60000, SUM_KEEP = 200, SUM_FAILED_FOR = 2 * 60000, SUM_ASK_MAX = 12000;
  const CATCH_MAX = 30, CATCH_LINE = 1200, CATCH_KEEP = 12 * 3600000;

  // the ids phoneMessages gives the latest messages of a chat, in the same order as list.slice(-MAX_MESSAGES)
  function phoneIdsOf(list) {
    const seen = {};
    return (list || []).slice(-MAX_MESSAGES).map(m => {
      if (m && m.id) return String(m.id);
      const base = 'h' + hash((m && m.who) + '|' + String((m && m.text) || ''));
      seen[base] = (seen[base] || 0) + 1;
      return base + '-' + seen[base];
    });
  }

  // the message with this phone id in a chat's messages
  function messageById(list, id) {
    const recent = (list || []).slice(-MAX_MESSAGES);
    const i = phoneIdsOf(list).indexOf(id);
    return i >= 0 ? recent[i] : null;
  }

  // the chat's latest messages as lines for a catch up: { text, count, upTo (the phone id of the newest) } or null when there's nothing
  function catchUpText(list) {
    const recent = (list || []).slice(-MAX_MESSAGES);
    const ids = phoneIdsOf(list);
    const lines = [];
    let total = 0, upTo = null;
    for (let i = recent.length - 1; i >= 0 && lines.length < CATCH_MAX; i--) {
      const m = recent[i];
      if (!m || m.kind !== 'msg' || !String(m.text || '').trim()) continue;
      let t = String(m.text).replace(/\s+/g, ' ').trim();
      if (t.length > CATCH_LINE) t = t.slice(0, CATCH_LINE) + '…';
      const line = (m.who || 'Someone') + ': ' + t;
      if (total + line.length > SUM_ASK_MAX && lines.length) break;
      if (!lines.length) upTo = ids[i];
      lines.unshift(line);
      total += line.length + 1;
    }
    if (!lines.length) return null;
    return { text: lines.join('\n'), count: lines.length, upTo };
  }

  // null when it isn't a summary action; { error } or { do: 'message' | 'catchUp', key, chatId, chat, ... }
  function summaryRoute(view, a) {
    if (!a || (a.type !== 'summary.message' && a.type !== 'summary.catchUp')) return null;
    const chatId = typeof a.chatId === 'string' ? a.chatId : '';
    const chat = chatId && chatFor(view, chatId);
    if (!chat) return { error: 'That chat isn’t on the computer any more.' };
    if (a.type === 'summary.catchUp') {
      const c = catchUpText(chat.messages);
      if (!c) return { error: 'There’s nothing to catch up on in this chat yet.' };
      return { do: 'catchUp', key: 'c\n' + chatId, chatId, chat, text: c.text, count: c.count, upTo: c.upTo };
    }
    const messageId = typeof a.messageId === 'string' ? a.messageId : '';
    const m = messageId && messageById(chat.messages, messageId);
    if (!m) return { error: 'That message isn’t in the chat any more.' };
    if (m.who === 'Storm' || m.kind !== 'msg') return { error: 'Only a teammate’s message can be summarized.' };
    const text = String(m.text || '');
    if (text.length < SUM_MIN) return { error: 'That message is already short.' };
    return { do: 'message', key: 'm\n' + chatId + '\n' + messageId, chatId, chat, messageId, text: text.slice(0, SUM_ASK_MAX) };
  }

  // holds the summaries the phone asked for and the jobs still running. ops(): window.SquallSummaryOps { summarize(text), save? }
  function summaryDesk(ops, changed, now) {
    const done = new Map();      // message key -> summary text
    const catchUps = new Map();  // chatId -> { text, at, upTo, count }
    const jobs = new Map();      // key -> { chatId, messageId, state: 'working' | 'failed', error, at }
    function keep(key, text) {
      done.delete(key);
      done.set(key, text);
      while (done.size > SUM_KEEP) done.delete(done.keys().next().value);
    }
    function running() { let n = 0; for (const j of jobs.values()) if (j.state === 'working') n++; return n; }
    function tidy() {
      const t = now();
      for (const [k, j] of jobs) if (j.state === 'failed' && t - j.at > SUM_FAILED_FOR) jobs.delete(k);
      for (const [k, c] of catchUps) if (t - c.at > CATCH_KEEP) catchUps.delete(k);
    }
    function run(r) {
      if (r.error) return { ok: false, error: r.error };
      const o = ops();
      if (!o || !o.summarize) return { ok: false, error: CANT };
      tidy();
      if (r.do === 'message' && done.has(r.key)) return { ok: true };
      const j = jobs.get(r.key);
      if (j && j.state === 'working') return { ok: true };
      if (running() >= SUM_JOBS) return { ok: false, error: 'Squall is already writing a summary. Try again in a moment.' };
      jobs.set(r.key, { chatId: r.chatId, messageId: r.messageId || null, state: 'working', error: null, at: now() });
      let timer = null;
      const late = new Promise((_, no) => { timer = setTimeout(() => no(new Error('It took too long.')), SUM_TIMEOUT); if (timer && timer.unref) timer.unref(); });
      let asked;
      try { asked = Promise.resolve(o.summarize(r.text)); } catch (e) { asked = Promise.reject(e); }
      Promise.race([asked, late])
        .then(out => {
          const s = String(out || '').trim();
          if (!s) throw new Error('The summary came back empty.');
          if (r.do === 'catchUp') catchUps.set(r.chatId, { text: s.slice(0, 1200), at: now(), upTo: r.upTo, count: r.count });
          else {
            keep(r.key, s.slice(0, 1200));
            try { if (o.save) o.save(r.chat.raw, r.messageId, s); } catch (e) { }
          }
          jobs.delete(r.key);
        })
        .catch(e => { jobs.set(r.key, { chatId: r.chatId, messageId: r.messageId || null, state: 'failed', error: String((e && e.message) || e || 'It didn’t work.').slice(0, 200), at: now() }); })
        .finally(() => { clearTimeout(timer); changed(); });
      return { ok: true };
    }
    return {
      route: summaryRoute,
      run,
      view() {
        tidy();
        const out = { done: new Map(done), catchUps: new Map(catchUps), jobs: [] };
        for (const j of jobs.values()) {
          const row = { chatId: j.chatId, messageId: j.messageId, state: j.state };
          if (j.error) row.error = j.error;
          out.jobs.push(row);
        }
        return out;
      },
    };
  }

  // adds `summary` to the phone's messages and state.summaries { jobs, catchUps }. desk: what summaryDesk's view() gives
  function withSummaries(state, desk) {
    if (!desk) return state;
    const chats = state.chats || {};
    for (const chatId of Object.keys(chats)) {
      for (const m of chats[chatId] || []) {
        if (m.kind !== 'bot' || m.summary) continue;
        const s = desk.done.get('m\n' + chatId + '\n' + m.id);
        if (s) m.summary = s;
      }
    }
    const catchUps = [];
    for (const [chatId, c] of desk.catchUps) {
      if (!chats[chatId]) continue;
      catchUps.push({ chatId, text: c.text, at: new Date(c.at).toISOString(), upTo: c.upTo || null, count: c.count });
    }
    catchUps.sort((a, b) => a.chatId.localeCompare(b.chatId));
    const jobs = desk.jobs.filter(j => chats[j.chatId]).sort((a, b) => (a.chatId + (a.messageId || '')).localeCompare(b.chatId + (b.messageId || '')));
    state.summaries = { jobs, catchUps };
    state.version = hash(JSON.stringify(Object.assign({}, state, { version: '' })));
    return state;
  }

  root.SquallSummaries = { summaryRoute, summaryDesk, withSummaries, messageById, catchUpText, phoneIdsOf, SUM_MIN, CATCH_MAX };

  // ---------------------------------------------------------------- shared clipboard (docs/phone-clipboard.md)

  // clip.send { text } puts text on the computer's clipboard. clip.get reads the computer's clipboard; the text comes in the next state
  // as state.clipboard { text, at, cut } and leaves after 2 minutes or on clip.clear, so it isn't sent around longer than needed.
  const CLIP_MAX = 20000, CLIP_KEEP = 2 * 60000;

  // null when it isn't a clipboard action; { error } or { do: 'send' | 'get' | 'clear', text }
  function clipRoute(a) {
    if (!a || (a.type !== 'clip.send' && a.type !== 'clip.get' && a.type !== 'clip.clear')) return null;
    if (a.type === 'clip.get') return { do: 'get' };
    if (a.type === 'clip.clear') return { do: 'clear' };
    if (typeof a.text !== 'string' || !a.text.trim()) return { error: 'There’s nothing to send.' };
    if (a.text.length > CLIP_MAX) return { error: 'That’s too long for the clipboard from the phone (20,000 characters at most).' };
    return { do: 'send', text: a.text };
  }

  // ops(): window.SquallClipOps { read() -> text, write(text) }
  function clipDesk(ops, now) {
    let st = null;
    async function run(r) {
      if (r.error) return { ok: false, error: r.error };
      if (r.do === 'clear') { st = null; return { ok: true }; }
      const o = ops();
      if (!o) return { ok: false, error: CANT };
      if (r.do === 'send') {
        const done = await o.write(r.text);
        return done === false ? { ok: false, error: 'Squall couldn’t use the computer’s clipboard.' } : { ok: true };
      }
      const text = String((await o.read()) || '');
      if (!text.trim()) { st = null; return { ok: false, error: 'The computer’s clipboard has no text on it.' }; }
      st = { text: text.slice(0, CLIP_MAX), cut: text.length > CLIP_MAX, at: now() };
      return { ok: true };
    }
    return {
      run,
      view: () => (st && now() - st.at < CLIP_KEEP ? st : null),
    };
  }

  // state.clipboard: {} when nothing was asked for, so the phone knows this computer has the feature
  function withClipboard(state, clip) {
    state.clipboard = clip ? { text: clip.text, at: new Date(clip.at).toISOString(), cut: !!clip.cut } : {};
    state.version = hash(JSON.stringify(Object.assign({}, state, { version: '' })));
    return state;
  }

  root.SquallClip = { clipRoute, clipDesk, withClipboard, CLIP_MAX, CLIP_KEEP };

  // ---------------------------------------------------------------- add a teammate (docs/phone-add-teammate.md)

  // bot.add { name, role, color, prompt } brings a new teammate to life, the same as Add teammate on the computer. The phone gets
  // state.team.add = true and the computer's starting points (state.team.presets) when this Squall can do it.
  const ROLE_MAX = 60, BRIEF_MAX = 2000, COLOR_RX = /^#[0-9a-fA-F]{6}$/;

  // null when it isn't bot.add; { error } or { do: 'add', name, role, color, prompt }
  function addRoute(view, a) {
    if (!a || a.type !== 'bot.add') return null;
    const agents = ((view && view.agents) || []).filter(x => x && x.name);
    const name = String(a.name || '').trim();
    if (!NAME_RX.test(name)) return { error: NAME_HELP };
    if (agents.some(x => x.name.toLowerCase() === name.toLowerCase())) return { error: name + ' is already on the team.' };
    if (agents.length >= TEAM_MAX) return { error: 'The team is full (' + TEAM_MAX + ' teammates).' };
    const role = String(a.role == null ? '' : a.role).trim();
    if (role.length > ROLE_MAX) return { error: 'Keep the role to ' + ROLE_MAX + ' characters.' };
    const color = String(a.color || '');
    if (!COLOR_RX.test(color)) return { error: 'Pick a color.' };
    const prompt = String(a.prompt == null ? '' : a.prompt).trim();
    if (prompt.length > BRIEF_MAX) return { error: 'Keep what they do to ' + BRIEF_MAX.toLocaleString('en-US') + ' characters.' };
    return { do: 'add', name, role, color: color.toUpperCase(), prompt };
  }

  // ops: window.SquallAddOps { add(name, role, color, prompt) -> the name }; after(): the view once the team is updated
  async function addDo(r, ops, after) {
    if (r.error) return { ok: false, error: r.error };
    if (!ops || !ops.add) return { ok: false, error: CANT };
    const name = await ops.add(r.name, r.role, r.color, r.prompt);
    const v = await after();
    const id = botIds(((v && v.agents) || []).filter(a => a && a.name), leadOf(v))[name];
    return id ? { ok: true, id } : { ok: true };
  }

  // state.team.add and state.team.presets [{ id, label, role, brief, color }] (needs withTeam first)
  function withAdd(state, ops) {
    if (!ops || !ops.add || !state.team) return state;
    state.team.add = true;
    const presets = [];
    for (const p of (ops.presets && ops.presets()) || []) {
      if (!p || typeof p.id !== 'string' || !COLOR_RX.test(p.color || '')) continue;
      presets.push({ id: p.id, label: String(p.label || p.role || p.id).slice(0, 30), role: String(p.role || '').slice(0, ROLE_MAX), brief: String(p.brief || '').slice(0, BRIEF_MAX), color: p.color.toUpperCase() });
      if (presets.length >= 12) break;
    }
    state.team.presets = presets;
    state.version = hash(JSON.stringify(Object.assign({}, state, { version: '' })));
    return state;
  }

  root.SquallAdd = { addRoute, addDo, withAdd, ROLE_MAX, BRIEF_MAX };

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
      if (status === 'idle' && a.napping) status = 'napping';   // asleep in Squall (idle a few minutes; a message or Wake wakes it)
      if (busy) status = 'working';
      if (waiting[a.name]) status = 'waiting';
      if (busy && !typing) typing = ids[a.name];
      const b = { id: ids[a.name], name: a.name, color: /^#[0-9a-fA-F]{6}$/.test(a.color || '') ? a.color : '#A78BFA', role: a.role || (a.name === leadName ? 'Team lead' : ''), status, unread: dm ? Math.max(0, dm.unread | 0) : 0 };
      const task = String(a.activity || '').trim();
      if (task && task !== 'Ready') b.task = task.slice(0, 200);
      // the steps of the run it's on now, for the Board's Steps and Mission control (only while it works or waits on Storm)
      if (status === 'working' || status === 'waiting') { const log = phoneBotLog(a); if (log.length) b.log = log; }
      return b;
    });
    // Chief first, then the order Squall shows
    bots.sort((x, y) => (y.id === CHIEF) - (x.id === CHIEF));
    // the whole team is paused (the phone's Pause all): a bot that isn't working or waiting on Storm shows as paused
    const paused = !!(view && view.paused);
    if (paused) for (const b of bots) if (b.status !== 'working' && b.status !== 'waiting') b.status = 'paused';

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
    }).concat(phoneInboxLog(view && view.inboxLog, idOf, view && view.now));

    const state = { typing, bots, chats, groups, inbox };
    // Squall's shared To do list (workspace\\shared\\todo.json), when this Squall has one
    if (view && Array.isArray(view.todo)) state.todo = phoneTodo(view.todo, ids, view.lead || leadName);
    // the plan's usage and today's jobs, for the phone's Plan usage screen (only when Squall has it)
    const usage = phoneUsage(view && view.usage, idOf, view && view.now);
    if (usage) state.usage = usage;
    // Squall's routines (jobs a bot does at a set time), for the phone's Routines tab (only when Squall sends them)
    const routines = phoneRoutines(view && view.routines, idOf);
    if (routines) state.routines = routines;
    // Squall's own version, for the phone's Settings > Computer (only what the updater really knows)
    const d = view && view.desktop;
    // the jobs the bots are on right now (and ones that ended a few minutes ago), for the phone's Live work screens
    const work = phoneWork(view && view.work, idOf);
    if (work.length) state.work = work;
    if (d && d.current) {
      state.desktop = { version: String(d.current), updating: !!d.busy };
      if (d.ready) state.desktop.latest = String(d.ready);
      // and the Claude Code that Squall runs (the phone shows both under Settings > Computer), once a run has reported its version
      const cc = phoneClaudeCode(view && view.claudeCode);
      if (cc) state.claudeCode = cc;
    }
    if (paused) state.paused = true;   // the phone's Pause all switch
    state.version = hash(JSON.stringify(state));
    // who handed work to whom, for the phone's Mission control: a lead's tasks and Storm's Hand off. Set after the version line
    // above, so the version is worked out again to cover them (the phone only redraws when it changes)
    const handoffs = phoneHandoffs(view && view.chats, idOf, view && view.now);
    if (handoffs.length) { state.handoffs = handoffs; state.version = hash(JSON.stringify(state)); }
    return state;
  }

  // ---------------------------------------------------------------- Claude Code's version

  // "2.1.3 (Claude Code)" -> [2, 1, 3]; null when it isn't a version
  function versionParts(v) {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v || '').trim());
    return m ? [+m[1], +m[2], +m[3]] : null;
  }
  function newerVersion(a, b) {   // is a newer than b?
    const x = versionParts(a), y = versionParts(b);
    if (!x || !y) return false;
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
    return false;
  }
  // cc: { version, latest } from app.js. The phone's claudeCode: { version, latest?, needsUpdate }
  function phoneClaudeCode(cc) {
    const v = cc && versionParts(cc.version);
    if (!v) return null;
    const out = { version: v.join('.'), needsUpdate: false };
    const latest = versionParts(cc.latest);
    if (latest && newerVersion(cc.latest, cc.version)) { out.latest = latest.join('.'); out.needsUpdate = true; }
    return out;
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

  // A bot's current run as short lines, oldest first, the last 6: "$ npm test" for a command, "Edited app.js", "Read README.md",
  // "Searched the web for …". Squall's own runs keep their tools on a.turns; a live session's are on a.liveSteps
  const MAX_LOG = 6;
  const baseName = p => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';
  function stepLine(tool) {
    const name = String((tool && tool.name) || '').trim(), i = (tool && tool.input) || {};
    const one = (s, n) => { const t = String(s || '').split('\n')[0].trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; };
    let line;
    if (/^bash$/i.test(name)) line = i.command ? '$ ' + one(i.command, 120) : 'Ran a command';
    else if (/^(edit|multiedit|notebookedit)$/i.test(name)) line = 'Edited ' + (baseName(i.file_path || i.notebook_path) || 'a file');
    else if (/^write$/i.test(name)) line = 'Wrote ' + (baseName(i.file_path) || 'a file');
    else if (/^read$/i.test(name)) line = 'Read ' + (baseName(i.file_path) || 'a file');
    else if (/^(grep|glob)$/i.test(name)) line = i.pattern ? 'Searched for ' + one(i.pattern, 60) : 'Searched the files';
    else if (/^websearch$/i.test(name)) line = i.query ? 'Searched the web for ' + one(i.query, 80) : 'Searched the web';
    else if (/^webfetch$/i.test(name)) { let host = ''; try { host = new URL(String(i.url || '')).hostname; } catch (e) { } line = host ? 'Opened ' + host : 'Opened a web page'; }
    else if (/^(task|agent)$/i.test(name)) line = 'Started a helper' + (i.description ? ': ' + one(i.description, 80) : '');
    else if (/^todowrite$/i.test(name)) line = 'Updated its plan';
    else if (name) line = 'Used ' + name.replace(/^mcp__[^_]+__/, '').replace(/_/g, ' ');
    else return '';
    if (tool.status === 'error' && line[0] !== '$') line += ' (failed)';
    return line;
  }
  function phoneBotLog(a) {
    const out = [];
    for (const t of (a && Array.isArray(a.turns) ? a.turns : []))
      for (const tool of (t && Array.isArray(t.tools) ? t.tools : [])) { const l = stepLine(tool); if (l) out.push(l); }
    // a live Claude app session keeps its steps on a.liveSteps (app.js sets it from the session's mirror): { name, detail }
    if (!out.length && a && Array.isArray(a.liveSteps))
      for (const s of a.liveSteps) { const l = stepLine(liveTool(s)); if (l) out.push(l); }
    return out.slice(-MAX_LOG);
  }
  // a live session's step has one detail string (the command, the file, the search) where Squall's own runs have the tool's input
  function liveTool(s) {
    const name = String((s && s.name) || ''), d = String((s && s.detail) || '').trim(), input = {};
    if (d) {
      if (/^bash$/i.test(name)) input.command = d;
      else if (/^(edit|multiedit|write|read)$/i.test(name)) input.file_path = d;
      else if (/^notebookedit$/i.test(name)) input.notebook_path = d;
      else if (/^(grep|glob)$/i.test(name)) input.pattern = d;
      else if (/^websearch$/i.test(name)) input.query = d;
      else if (/^webfetch$/i.test(name)) input.url = d;
      else if (/^(task|agent)$/i.test(name)) input.description = d;
    }
    return { name, input, status: s && s.failed ? 'error' : '' };
  }

  function toolWords(tool) {
    const t = String(tool || 'use a tool').trim();
    if (/^bash$/i.test(t)) return 'run a command';
    if (/^(write|edit|multiedit)$/i.test(t)) return 'change a file';
    if (/^webfetch$/i.test(t)) return 'open a web page';
    return 'use ' + t;
  }

  // ---------------------------------------------------------------- the To do list

  const TODO_STATUS = ['todo', 'doing', 'done'];
  const MAX_TODO_OPEN = 100;    // open items the phone gets
  const MAX_TODO_DONE = 12;     // the newest finished ones, like the right pane shows
  const MAX_TODO_TEXT = 300;

  // The list as the phone sees it: { items: [{ id, text, status, by, who, botId, needs, needsBy, at, doneAt }] }.
  // Open items keep Squall's order; the finished ones are the newest 12. A "who" that is one of the bots also gets its id,
  // so the phone can draw its color and open its chat; anyone else (Storm, Laptop, a live session) stays a name.
  function phoneTodo(items, ids, leadName) {
    const idOf = name => (name && ids[name]) || null;
    const clean = (items || []).filter(i => i && i.id && String(i.text || '').trim());
    const open = clean.filter(i => i.status !== 'done').slice(0, MAX_TODO_OPEN);
    const done = clean.filter(i => i.status === 'done')
      .sort((a, b) => String(b.doneAt || b.at || '').localeCompare(String(a.doneAt || a.at || '')))
      .slice(0, MAX_TODO_DONE);
    return {
      items: open.concat(done).map(i => {
        const status = TODO_STATUS.includes(i.status) ? i.status : 'todo';
        const out = { id: String(i.id), text: String(i.text).trim().slice(0, MAX_TODO_TEXT), status };
        if (i.by) out.by = String(i.by).slice(0, 60);
        if (i.who) { out.who = String(i.who).slice(0, 60); const b = idOf(i.who); if (b) out.botId = b; }
        if (i.needs && status !== 'done') {
          out.needs = String(i.needs).slice(0, 160);
          const nb = idOf(i.needsBy) || idOf(i.who) || (leadName ? idOf(leadName) : null);
          if (nb) out.needsBy = nb;
        }
        if (i.at) out.at = String(i.at);
        if (i.doneAt && status === 'done') out.doneAt = String(i.doneAt);
        return out;
      }),
    };
  }

  // What a bot is told when Storm gives it an item from the phone. The bots already keep the list with the squall actions
  // todo_doing, todo_done and todo_needs (app.js TODO_RULES), so this only points at the item.
  function giveText(item) {
    return 'From my phone: please take this To do item [' + item.id + ']: ' + String(item.text || '').trim().slice(0, MAX_TODO_TEXT) +
      '\nMark it with todo_doing now, do it, and close it with todo_done in the reply that says it\u2019s finished. If it needs me, mark it with todo_needs and say why.';
  }

  function todoFor(view, itemId) {
    return ((view && view.todo) || []).find(i => i && String(i.id) === String(itemId)) || null;
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
      const photos = Math.max(0, Math.floor(+m.photos || 0));
      const shown = text || (photos ? photoLabel(photos) : '');
      const out = { id, kind, text: shown.length > MAX_TEXT ? shown.slice(0, MAX_TEXT) + '…' : shown };
      if (photos) out.photos = photos;
      if (kind === 'bot') { const a = idOf(m.who); if (a) out.author = a; }
      if (m.at) out.at = m.at;
      if (kind === 'bot' && m.summary) out.summary = String(m.summary).slice(0, 1200);
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
      const out = {
        id: String(r.id), botId: idOf(r.bot), task: String(r.prompt || r.name || '').slice(0, 4000),
        repeat: days === 'weekends' ? 'custom' : days, days: DAY_SETS[days].map(Boolean), minutes,
        isOn: !r.off, pingWhenDone: true, askBeforePush: true, skipIfBusy: false,
      };
      // the day it last ran (or was skipped), "YYYY-MM-DD" on the computer's clock: it doesn't run again that day
      if (/^\d{4}-\d{2}-\d{2}$/.test(String(r.lastRun || ''))) out.lastRun = String(r.lastRun);
      return out;
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

  // Squall keeps a short log of a bot's errors and the jobs a bot finished (app.js, inboxLog); the phone shows them under Problems and Done.
  // Cleared ones and ones older than 2 days stay off the phone, newest first, 30 at most
  const INBOX_KEEP_MS = 2 * 24 * 3600 * 1000, MAX_INBOX_LOG = 30;
  function phoneInboxLog(list, idOf, nowMs) {
    const t0 = typeof nowMs === 'number' && isFinite(nowMs) ? nowMs : Date.now();
    const out = [], seen = new Set();
    for (const it of Array.isArray(list) ? list : []) {
      if (!it || it.cleared || (it.kind !== 'error' && it.kind !== 'done')) continue;
      const id = String(it.id || ''), botId = idOf(it.who);
      if (!id || !botId || seen.has(id)) continue;
      const at = Date.parse(it.at);
      if (!isFinite(at) || t0 - at > INBOX_KEEP_MS) continue;
      seen.add(id);
      const item = { id, kind: it.kind, botId, title: String(it.title || (it.kind === 'error' ? it.who + ' hit a problem' : it.who + ' finished a job')).slice(0, 120), unread: !it.read, at: new Date(at).toISOString() };
      const body = String(it.body || '').trim();
      if (body) item.body = body.slice(0, 600);
      if (it.kind === 'error') { const d = String(it.details || '').trim(); if (d) item.details = d.slice(0, 1500); }
      else { item.openLabel = 'Open chat'; item.opens = 'chat'; }
      out.push({ item, at });
    }
    return out.sort((a, b) => b.at - a.at).slice(0, MAX_INBOX_LOG).map(x => x.item);
  }
  function inboxLogItem(view, id) {
    return ((view && view.inboxLog) || []).find(it => it && !it.cleared && String(it.id) === String(id)) || null;
  }

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

  // ---------------------------------------------------------------- hand offs

  // From each chat's own messages (raw: Squall's chat): a lead's "assigned N tasks" event ({ who, tasks: [{ to, task }] }) and
  // Storm's Hand off from the phone ({ handoff: { from, to, what } }). Only the last 2 days, newest first, 12 at most
  const HANDOFF_KEEP_MS = 2 * 24 * 3600 * 1000, MAX_HANDOFFS = 12;
  function phoneHandoffs(chats, idOf, nowMs) {
    const t0 = typeof nowMs === 'number' && isFinite(nowMs) ? nowMs : Date.now();
    const out = [], seen = new Set();
    const add = (id, from, to, what, at) => {
      const f = idOf(from), t = idOf(to), w = String(what || '').replace(/\s+/g, ' ').trim();
      if (!f || !t || f === t || !w || seen.has(id)) return;
      seen.add(id);
      out.push({ item: { id, from: f, to: t, what: w.length > 200 ? w.slice(0, 199).trimEnd() + '…' : w, at: new Date(at).toISOString() }, at });
    };
    for (const c of Array.isArray(chats) ? chats : []) {
      const list = c && c.raw && Array.isArray(c.raw.messages) ? c.raw.messages : [];
      for (const m of list) {
        if (!m || m.kind !== 'event' || !m.id) continue;
        const at = Date.parse(m.time || m.at);
        if (!isFinite(at) || t0 - at > HANDOFF_KEEP_MS) continue;
        if (m.handoff && typeof m.handoff === 'object') add(String(m.id), m.handoff.from, m.handoff.to, m.handoff.what, at);
        else if (Array.isArray(m.tasks)) m.tasks.forEach((t, i) => { if (t) add(m.id + '-' + i, m.who, t.to, t.task, at); });
      }
    }
    return out.sort((a, b) => b.at - a.at).slice(0, MAX_HANDOFFS).map(x => x.item);
  }

  const HANDOFF_JOBS = { take_over: 'take over', review: 'review', split: 'split up' };

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
      case 'chief.retry': return { do: 'chiefRetry' };   // the phone's Try again on Chief's error card
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
      case 'team.pause': {
        // the phone's Pause all (and Siri's "Pause my team" / "Resume my team"): { paused: true/false }
        if (typeof a.paused !== 'boolean') return { error: 'Pause has to be on or off.' };
        return { do: 'teamPause', paused: a.paused };
      }
      case 'inbox.answer': {
        const ap = ((view && view.approvals) || []).find(x => String(x.requestId) === String(a.itemId));
        if (!ap) return { error: 'That question was already answered or has gone.' };
        const ans = String(a.answer || '').toLowerCase();
        if (ans !== 'allow' && ans !== 'deny') return { error: 'Answer with Allow or Deny.' };
        return { do: 'answer', requestId: ap.requestId, decision: ans === 'allow' ? 'once' : 'deny' };
      }
      case 'inbox.read': return inboxLogItem(view, a.itemId) ? { do: 'inboxRead', id: String(a.itemId) } : { do: 'none' };
      case 'inbox.readAll': return { do: 'inboxReadAll' };
      case 'inbox.clear': {
        if (inboxLogItem(view, a.itemId)) return { do: 'inboxClear', id: String(a.itemId) };
        if (((view && view.approvals) || []).some(x => String(x.requestId) === String(a.itemId))) return { error: 'Answer it with Allow or Deny, and it goes away.' };
        return { do: 'none' };   // already gone
      }
      case 'group.create': {
        const names = (Array.isArray(a.members) ? a.members : []).map(id => nameFor(view, id)).filter(Boolean);
        if (!names.length) return { error: 'Pick at least one bot for the group.' };
        return { do: 'group', name: String(a.name || '').trim().slice(0, 60), members: names };
      }
      case 'todo.add': case 'todo.set': case 'todo.give': case 'todo.delete': case 'todo.clearDone':
        return routeTodo(view, a, type);
      case 'bot.create': {
        // the phone's New teammate sheet: { name, role, color: "#RRGGBB", job }. Squall checks the name the way its own New teammate does.
        const name = String(a.name || '').trim();
        if (!name) return { error: 'Pick a name for the new teammate.' };
        const color = String(a.color || '').trim();
        if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) return { error: 'Pick one of the colors.' };
        return { do: 'botCreate', bot: { name: name.slice(0, 40), role: String(a.role || '').trim().slice(0, 60), color: color.toUpperCase(), job: String(a.job || '').trim().slice(0, 2000) } };
      }
      case 'chief.wake': return { do: 'chiefWake' };
      case 'chief.nap': return { do: 'chiefNap' };
      case 'settings.save': return { do: 'none' };
      case 'handoff': {
        // Team > a bot > Hand off: { botId, job: take_over | review | split, note }. The work goes to the lead (Chief)
        const name = nameFor(view, a.botId);
        if (!name) return { error: 'That teammate isn’t on the team any more.' };
        const agents = (view && view.agents) || [];
        const lead = view && view.lead ? view.lead : (agents.find(x => x.lead) || agents[0] || {}).name;
        if (!lead) return { error: 'There’s no Chief on the computer to hand it to.' };
        if (name === lead) return { error: 'Chief can’t hand work to itself.' };
        const job = String(a.job || '');
        if (!HANDOFF_JOBS[job]) return { error: 'Pick what Chief should do with it.' };
        return { do: 'handoff', from: name, to: lead, job, note: String(a.note || '').trim().slice(0, 1000) };
      }
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

  const NO_TODO = 'Update Squall on the computer to use the To do list from your phone.';
  const TODO_GONE = 'That to-do isn\u2019t on the list any more.';

  function routeTodo(view, a, type) {
    if (!view || !Array.isArray(view.todo)) return { error: NO_TODO };
    if (type === 'todo.clearDone') return { do: 'todoClearDone' };
    if (type === 'todo.add') {
      const text = String(a.text || '').trim().replace(/\s+/g, ' ');
      if (!text) return { error: 'Type what needs doing first.' };
      let bot = null, chat = null;
      if (a.botId) {
        bot = nameFor(view, a.botId);
        chat = bot ? chatFor(view, a.botId) : null;
        if (!bot || !chat) return { error: 'That bot isn\u2019t on the computer any more.' };
      }
      return { do: 'todoAdd', text: text.slice(0, MAX_TODO_TEXT), bot, chat };
    }
    const item = todoFor(view, a.itemId);
    if (!item) return { error: TODO_GONE };
    if (type === 'todo.delete') return { do: 'todoDel', id: item.id };
    if (type === 'todo.set') {
      const status = String(a.status || '');
      if (!TODO_STATUS.includes(status)) return { error: 'A to-do is todo, doing or done.' };
      return { do: 'todoSet', id: item.id, status };
    }
    // todo.give
    if (item.status === 'done') return { error: 'That one is already done.' };
    const bot = nameFor(view, a.botId);
    const chat = bot ? chatFor(view, a.botId) : null;
    if (!bot || !chat) return { error: 'That bot isn\u2019t on the computer any more.' };
    return { do: 'todoGive', id: item.id, bot, chat, text: giveText(item) };
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
    // messages set to send later (see "send later" above): the phone's state and actions see the list
    const later = laterStore(h, () => pushNow());
    const laterView = () => Object.assign(view(), { later: later.list() });
    const projects = projectCache(() => root.SquallTeamOps, () => pushNow());
    const teamView = () => { const v = Object.assign(laterView(), { manage: !!root.SquallTeamOps }); const p = projects.list(); if (p) v.projects = p; return v; };
    const notes = notesDesk(() => root.SquallNotesOps, () => Date.now());
    const clip = clipDesk(() => root.SquallClipOps, () => Date.now());
    const summaries = summaryDesk(() => root.SquallSummaryOps, () => { pushNow(); }, () => Date.now());
    const phoneState = () => {
      const v = teamView();
      const state = withTimers(withModels(withNotes(withAdd(withTeam(withLater(buildState(v), v), v), root.SquallAddOps), notes.view()), v, root.SquallModelOps), v, root.SquallTimerOps);
      const withSum = root.SquallSummaryOps ? withSummaries(state, summaries.view()) : state;
      return root.SquallClipOps ? withClipboard(withSum, clip.view()) : withSum;
    };

    // what the phone sees, read from Squall's state each time
    function view() {
      const approvals = [];
      for (const c of S.chats || [])
        for (const m of c.messages || [])
          if (m.kind === 'approve' && m.approve && m.approve.state === 'waiting')
            approvals.push({ requestId: m.approve.requestId, who: m.who, tool: m.approve.tool, detail: m.approve.detail, text: m.text, at: m.time });
      return {
        // a teammate asleep in Squall shows as napping on the phone
        agents: (S.agents || []).map(a => (h.isSleeping && a && h.isSleeping(a) ? Object.assign({}, a, { napping: true }) : a)),
        lead: S.lead ? S.lead.name : null,
        claudeCode: h.claudeCode ? h.claudeCode() : null,
        chats: (S.chats || []).map(c => ({
          id: c.id, kind: c.kind, name: c.name, members: c.members || [], unread: c.unread || 0,
          messages: h.phoneMessages(c), typing: h.typingIn(c), raw: c,
        })),
        inboxLog: h.inbox ? h.inbox.list() : null,
        approvals,
        work: h.work ? h.work.list() : undefined,
        desktop: status.update || null,
        todo: h.todo ? h.todo.items() : undefined,
        usage: h.usage ? h.usage() : null,
        routines: h.routines ? h.routines.list() : undefined,
        now: Date.now(),
        paused: h.paused ? !!h.paused() : false,
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
        case 'chiefRetry': {
          if (!h.retryChief) return { ok: false, error: CANT };
          const res = h.retryChief();
          if (res !== true) return { ok: false, error: typeof res === 'string' ? res : 'Squall couldn’t try that again.' };
          await pushNow();
          return { ok: true };
        }
        case 'read': h.markRead(chat); return { ok: true };
        case 'workStop': case 'workPause': {
          if (!h.work) return { ok: false, error: CANT };
          const res = r.do === 'workStop' ? h.work.stop(r.name) : h.work.pause(r.name, r.paused);
          if (res !== true) return { ok: false, error: typeof res === 'string' ? res : 'Squall couldn’t do that just now.' };
          await pushNow();
          return { ok: true };
        }
        case 'clear': h.clear(chat); return { ok: true };
        case 'handoff': {
          if (!h.handoff) return { ok: false, error: CANT };
          const res = h.handoff(r.from, r.to, r.job, r.note);
          if (typeof res === 'string') return { ok: false, error: res };
          await pushNow();
          return { ok: true };
        }
        case 'clearAll': (S.chats || []).forEach(c => h.clear(c)); return { ok: true };
        case 'teamPause': {
          if (!h.setPaused) return { ok: false, error: CANT };
          h.setPaused(r.paused, 'the phone');
          await pushNow();
          return { ok: true };
        }
        case 'answer': {
          const res = await h.answer(r.requestId, r.decision);
          return res && res.ok ? { ok: true } : { ok: false, error: 'That question had already gone on the computer.' };
        }
        case 'inboxRead': case 'inboxReadAll': case 'inboxClear': {
          if (!h.inbox) return r.do === 'inboxClear' ? { ok: false, error: CANT } : { ok: true };
          if (r.do === 'inboxRead') h.inbox.read(r.id);
          else if (r.do === 'inboxReadAll') h.inbox.readAll();
          else h.inbox.clear(r.id);
          await pushNow();
          return { ok: true };
        }
        case 'group': { const c = h.group(r.name, r.members); return c ? { ok: true, id: c.id } : { ok: false, error: 'Couldn’t make that group.' }; }
        case 'todoAdd': {
          const it = h.todo.add(r.text, 'Storm');
          if (!it) return { ok: false, error: 'Couldn’t add that to-do.' };
          let res = { ok: true, id: it.id };
          if (r.bot) {
            if (h.send(r.chat.raw, giveText(it), false)) h.todo.set(it.id, 'doing', r.bot);
            else res = { ok: false, id: it.id, error: 'Added to the list, but ' + r.bot + ' is busy. Give it to ' + r.bot + ' again in a moment.' };
          }
          await pushNow();
          return res;
        }
        case 'todoSet': {
          if (!h.todo.set(r.id, r.status)) return { ok: false, error: TODO_GONE };
          await pushNow();
          return { ok: true };
        }
        case 'todoGive': {
          if (!h.send(r.chat.raw, r.text, false)) return { ok: false, error: r.bot + ' is busy or Squall isn’t signed in to Claude. Try again in a moment.' };
          h.todo.set(r.id, 'doing', r.bot);
          await pushNow();
          return { ok: true };
        }
        case 'todoDel': {
          if (!h.todo.del(r.id)) return { ok: false, error: TODO_GONE };
          await pushNow();
          return { ok: true };
        }
        case 'todoClearDone': h.todo.clearDone(); await pushNow(); return { ok: true };
        case 'botCreate': {
          if (!h.addBot) return { ok: false, error: CANT };
          await h.addBot(r.bot);
          await pushNow();
          const after = view();
          const ids = botIds(after.agents, after.lead || (after.agents.find(x => x.lead) || {}).name);
          return ids[r.bot.name] ? { ok: true, id: ids[r.bot.name] } : { ok: true };
        }
        case 'chiefWake': case 'chiefNap': {
          if (!h.chief) return { ok: false, error: CANT };
          if (r.do === 'chiefWake') h.chief.wake(); else h.chief.nap();
          await pushNow();
          return { ok: true };
        }
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
        if (m.kind === 'action') {
          // Manage teammate first (bot.rename, bot.chief, bot.remove); everything else goes the usual way
          const team = teamRoute(teamView(), m.body || {});
          const note = team ? null : notes.route(m.body || {});
          const photo = team || note ? null : photoRoute(view(), m.body || {});
          const model = team || note || photo ? null : modelRoute(m.body || {}, root.SquallModelOps);
          const timer = team || note || photo || model ? null : timerRoute(view(), m.body || {});
          const sum = team || note || photo || model || timer ? null : summaryRoute(view(), m.body || {});
          const clipAsk = team || note || photo || model || timer || sum ? null : clipRoute(m.body || {});
          const adding = team || note || photo || model || timer || sum || clipAsk ? null : addRoute(view(), m.body || {});
          if (team) result = await teamDo(team, root.SquallTeamOps, async () => { await pushNow(); return view(); });
          else if (note) { result = await notes.run(note); await pushNow(); }
          else if (photo) { result = await photoDo(photo, root.SquallPhotoOps); await pushNow(); }
          else if (model) { result = modelDo(model, root.SquallModelOps); await pushNow(); }
          else if (timer) { result = timerDo(timer, root.SquallTimerOps); await pushNow(); }
          else if (sum) { result = summaries.run(sum); await pushNow(); }
          else if (clipAsk) { result = await clip.run(clipAsk); await pushNow(); }
          else if (adding) result = await addDo(adding, root.SquallAddOps, async () => { await pushNow(); return view(); });
          else result = await doAction(m.body || {});
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

  const api = { CHIEF, botIds, hash, buildState, phoneMessages, phoneTodo, giveText, phoneUsage, phoneRoutines, windowId, routeAction, chatFor, speakable, wire };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SquallLinkCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
