/* Tempest app: chats and team logic. The host (Tempest.exe) runs each agent as a Claude Code process
   and forwards its stream-json output here line by line.
   Chats: the Team chat (everyone, Chief leads), a direct chat with each agent, and group chats Storm makes.
   In a group, agents talk to each other by writing @Name; the named agent answers next (with limits). */
(function () {
  'use strict';
  window.squallReady = true;   // index.html's early error reporter stands down from here on
  const $ = (s, r) => (r || document).querySelector(s);
  const esc = MD.esc;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const now = () => new Date().toISOString();

  // ---------- bridge ----------
  const Bridge = (() => {
    const wv = window.chrome && window.chrome.webview;
    let seq = 0;
    const pending = new Map(), listeners = {};
    if (wv) wv.addEventListener('message', ev => {
      const m = ev.data;
      if (m && m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.ok ? p.res(m.result) : p.rej(new Error(m.error || 'Failed')); }
      else if (m && m.event) (listeners[m.event] || []).forEach(fn => { try { fn(m); } catch (e) { console.error(e); } });
    });
    return {
      host: !!wv,
      call(cmd, args) {
        if (!wv) return Promise.reject(new Error('Open the ' + APP + ' app to use the team (this page needs its host).'));
        return new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); wv.postMessage({ id, cmd, args: args || {} }); });
      },
      on(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); },
    };
  })();
  window.addEventListener('error', e => Bridge.call('log', { level: 'error', msg: String(e.message) + ' @' + e.lineno }).catch(() => {}));
  window.addEventListener('unhandledrejection', e => Bridge.call('log', { level: 'error', msg: String(e.reason && e.reason.stack || e.reason) }).catch(() => {}));

  // ---------- state ----------
  const S = {
    team: null, agents: [], byName: {}, lead: null,
    chats: [], active: 'team',
    sessions: {}, seen: {},
    sides: {},       // sidebar widths Storm dragged to: { left, right } in px (saved); missing = the default
    flows: {}, stopEpoch: 0,
    split: null, focusRight: false,   // the second chat beside the focused one (its id, or null), and whether the right pane has focus
    live: null, mock: false, selftest: false, signedIn: null, info: {},
    runs: {}, early: {},
    liveMode: true,
    link: { status: 'off', peers: [], jobs: {}, late: {}, waiters: [], lastChat: {}, error: '', timer: 0 },
    mirror: {},      // agent name -> { entries: [], session, status } : live view of that agent's real session
    typing: {},      // chat id -> { agent name: when it started } : who is working on a reply in that chat
    desk: [],        // every desktop session on this PC (title, transcript, modified), newest first (a list; sessions above is the map)
    rightMode: 'board', // the right pane: 'board' (the team board), 'computer', 'uno' (Squall Uno: every agent's own computer), 'live' (one agent's steps), 'sessions', 'vault' or 'todo'
    sessView: null,  // a session's transcript path while Storm reads it in the centre (read-only)
    sessMirror: {},  // transcript path -> { entries, status, title, loading } for the session being read
    usage: null,     // plan usage from the status line hook (null until it's connected)
    usageHist: [],   // readings of the 5-hour window, for the pace prediction
    usageHist7: [],  // readings of the weekly window, kept across restarts (it moves slowly), for its pace (saved)
    throttleOn: null,  // "Slow the team down to save usage" (from the phone or the usage menu; saved): true/false, or null = team.json's throttle
    usageLimit: null,  // also slow down once the 5-hour window reaches this percent (10 to 100; saved); null = only when the pace runs out
    workToday: { day: '', bots: {} },   // today's jobs per bot: { day: 'YYYY-MM-DD', bots: { name: { jobs, ms } } } (saved; starts over each day)
    callWait: true,  // voice calls wait (at most 6 s) for Whisper's more accurate words before sending (Settings → Speed; saved; on by default: Storm, "Calls: Prioritize accurate words")
    echoOwn: true,   // calls use Squall's own echo canceller (it hears the speakers; Storm picked "Our own canceller"); false: the browser's (saved)
    attach: [],      // images waiting in the composer: { path, url, name } (path is empty while saving)
    sound: true,     // the sci-fi ping when the response you're looking at finishes
    sounds: 'all',   // 'all' (typing, sending, replies and more), 'ping' (just the finish ping) or 'off'
    voiceEngine: 'whisper',   // speech to text: 'whisper' (Vosk shows words live, Whisper writes each phrase down again) or Vosk alone; Storm: "make the voice dictation better and more accurate"
    voiceEngineSet: false,    // Storm picked one in Settings (otherwise the default applies)
    model: '',   // the model chip: '' = by role (the host's default), or one model for every bot (see MODELS)
    workFor: 'off',  // the work-timer dial: 'off', minutes (10 to 600) or 'inf' (continuous)
    timers: {},      // chat id -> running work timer { until (ms, Infinity = continuous), mins, lastNudge, quick, pending }
    compacts: {},    // bot name -> when Claude Code last compacted its local session (saved)
    compactNoted: {}, // bot name -> the compaction its vault reminder was already sent for (saved)
    updateTold: {},   // bot name -> the newest Squall build it was told about (saved)
    vaultTold: {},    // bot name -> true once its first message in Squall told it to read the EVO vault (saved)
  };
  const LIVE_TIMEOUT_MS = 10 * 60 * 1000;
  const MAX_REPLIES = 14, MAX_ROUNDS = 6, MAX_MENTIONS_EACH = 3;
  // the models Tempest's agents can run on (the model chip under the send bar)
  // the app's name. The team's relay session is named the same, so other Claude sessions see "Squall" (older transcripts say Tempest)
  const APP = 'Squall';
  const APP_NAME_RX = /^(Squall|Tempest)$/i;
  const VIA_RX = /^Storm \(via his (?:Squall|Tempest) app\):\s*/;
  // what Squall adds to a message for the bot only, cut from what the chat shows (Storm: "Make it not show that it is telling the model plan
  // usage in the Squall app"): the usage line, the note on what changed in Squall, and a bot's first-message note
  const BOT_ONLY_RX = [/\n*Plan usage right now:[^\n]*/g, /\n*Squall was updated since your last message:[\s\S]*?\(The full update log is [^\n]*?\)/g, /\n*This is your first message in Squall\.[^\n]*/g];
  function stripBotOnly(s) { let t = String(s || ''); for (const rx of BOT_ONLY_RX) t = t.replace(rx, ''); return t.trim(); }
  const MODELS = [
    // '' = no override: the host picks by role (Storm, 19 Oct: "Make sure the rest of the team is sonnet")
    { id: '', name: 'By role', note: 'The default. Chiefs on Opus 5.5, every other bot on Sonnet 5.5, and their helpers on Haiku.' },
    { id: 'claude-haiku-5-5', name: 'Haiku 5.5', note: 'Fastest, and the lightest on your plan.' },
    { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', note: 'Stronger than Haiku, and uses more of your plan.' },
    { id: 'claude-opus-5-5', name: 'Opus 5.5', note: 'The most capable Opus model. Uses more of your plan than Sonnet or Haiku.' },
    { id: 'claude-fable-5-1', name: 'Fable 5.1', note: 'Fable 5.1. Storm says it runs heavier on the plan than Opus.' },
  ];
  const WRAP_UP = 'Your teammates replied above. Write the final answer for Storm now: the result first, then short bullets. Only assign more work if something essential is missing.';

  function setupTeam(team) {
    S.team = team || { agents: [] };
    S.agents = (S.team.agents || []).map(a => ({
      name: a.name, role: a.role || '', color: a.color || '#a78bfa', lead: !!a.lead, permissionMode: a.permissionMode || '',
      status: 'idle', activity: 'Ready', turns: [], runId: null, numTurns: null, duration: null, cost: null, model: '',
    }));
    S.byName = {};
    S.agents.forEach(a => { S.byName[a.name] = a; });
    S.lead = S.agents.find(a => a.lead) || S.agents[0] || null;
    S.chiefs = S.agents.filter(a => a.lead);   // up to 4 chiefs (Storm: "Make it where I can have up to 4 chiefs")
    if (!S.chiefs.length && S.lead) S.chiefs = [S.lead];
  }

  function makeChat(id, kind, name, members, lead) { return { id, kind, name, members, lead, messages: [], unread: 0 }; }

  function setupChats(state) {
    const names = S.agents.map(a => a.name);
    const old = state && state.v === 2 ? state : null;
    const saved = new Map(((old && old.chats) || []).map(c => [c.id, c]));
    const chats = [];
    const team = makeChat('team', 'team', 'Team', names.slice(), S.lead ? S.lead.name : names[0]);
    chats.push(team);
    for (const n of names) chats.push(makeChat('dm:' + n, 'dm', n, [n], n));
    for (const c of saved.values()) {
      if (c.kind !== 'group') continue;
      const members = (c.members || []).filter(n => S.byName[n]);
      if (!members.length) continue;
      chats.push(makeChat(c.id, 'group', c.name || 'Group', members, members.includes(S.lead && S.lead.name) ? S.lead.name : members[0]));
    }
    for (const c of chats) {
      const s = saved.get(c.id);
      if (s) { c.messages = Array.isArray(s.messages) ? s.messages.slice(-300) : []; c.unread = s.unread || 0; }
    }
    if (!old && state && Array.isArray(state.chat)) team.messages = state.chat.slice(-300).map(m => Object.assign({}, m, { id: uid() }));
    S.chats = chats;
    // the old online voice engine's errors (gone with the offline engine) were saved into chats: clear them once
    for (const c of chats) c.messages = (c.messages || []).filter(m => !(m.kind === 'error' && /Voice recognition needs an internet connection/i.test(m.text || '')));
    for (const c of chats) for (const m of c.messages) if (m.kind === 'approve' && m.approve && m.approve.state === 'waiting') m.approve.state = 'gone';   // their runs ended with the old Squall
    if (old) { S.sessions = savedSessions(old); S.seen = old.seen || {}; if (typeof old.liveMode === 'boolean') S.liveMode = old.liveMode; S.liveNoteHidden = !!old.liveNoteHidden; if (typeof old.readyBots === 'boolean') S.readyBots = old.readyBots; if (typeof old.callWait === 'boolean') S.callWait = old.callWait; if (typeof old.echoOwn === 'boolean') S.echoOwn = old.echoOwn; if (typeof old.trueBlack === 'boolean') S.trueBlack = old.trueBlack; if (typeof old.idleWork === 'boolean') S.idleWork = old.idleWork; if (old.starxDone) S.starxDone = true; if (old.livePending && typeof old.livePending === 'object') S.pendingSaved = old.livePending; if (old.relayModes && typeof old.relayModes === 'object') S.relayModes = old.relayModes; if (typeof old.relayMode === 'string') S.link.mode = old.relayMode; if (Array.isArray(old.usageHist7)) S.usageHist7 = old.usageHist7.slice(-400); if (typeof old.sound === 'boolean') S.sound = old.sound; S.sounds = ['all', 'ping', 'off'].includes(old.sounds) ? old.sounds : S.sound === false ? 'off' : 'all'; S.sound = S.sounds !== 'off'; if (old.voiceEngineSet && ['vosk', 'whisper', 'parakeet'].includes(old.voiceEngine)) { S.voiceEngine = old.voiceEngine; S.voiceEngineSet = true; } if (Array.isArray(old.updates)) S.updates = old.updates.slice(0, 8); if (old.modelPicked && MODELS.some(m => m.id === old.model)) { S.model = old.model; S.modelPicked = true; } S.judge = !!old.judge; if (typeof old.throttleOn === 'boolean') S.throttleOn = old.throttleOn; if (Number.isInteger(old.usageLimit) && old.usageLimit >= 10 && old.usageLimit <= 100) S.usageLimit = old.usageLimit; if (old.workToday && typeof old.workToday.day === 'string' && old.workToday.bots && typeof old.workToday.bots === 'object') S.workToday = { day: old.workToday.day, bots: old.workToday.bots }; if (old.workFor === 'off' || old.workFor === 'inf' || (old.workFor >= 10 && old.workFor <= 600)) S.workFor = old.workFor; }
    if (old) { S.compacts = old.compacts || {}; S.compactNoted = old.compactNoted || {}; S.updateTold = old.updateTold && typeof old.updateTold === 'object' ? old.updateTold : {}; S.vaultTold = old.vaultTold && typeof old.vaultTold === 'object' ? old.vaultTold : {}; S.sides = old.sides && typeof old.sides === 'object' ? old.sides : {}; S.teamNews = old.teamNews && typeof old.teamNews === 'object' ? old.teamNews : {}; }
    // work timers that were running when Squall closed carry on after a restart (not in the self-test)
    if (old && old.timers && !S.selftest) for (const id of Object.keys(old.timers)) {
      const t = old.timers[id] || {}, until = t.until === 'inf' ? Infinity : Number(t.until);
      // busySeen true: a timer that was running keeps its bot working, so an idle bot is nudged once the settle time has passed. With false, the
      // timer restored by the 04:12 in-place update on 22 Oct waited for "work seen" that only a nudge would start, and Chief sat idle till 07:12.
      if (chats.some(c => c.id === id) && (until === Infinity || until > Date.now())) S.timers[id] = { until, mins: t.mins, lastNudge: 0, quick: 0, pending: 0, busySeen: true, idleSince: 0, startedAt: Date.now(), waitLogged: false, paused: !!t.paused };
    }
    if (Object.keys(S.timers).length) timerWatchStart();
    driveWatchStart();
    S.active = old && chats.some(c => c.id === old.active) ? old.active : 'team';
    // the split's right pane comes back after a restart, if its chat still exists and is not the left pane's chat
    S.split = old && old.split && old.split !== S.active && chats.some(c => c.id === old.split) ? old.split : null;
    S.focusRight = !!S.split && !!old.focusRight;
    const a = activeChat();
    S.live = a.kind === 'dm' ? a.members[0] : (S.lead ? S.lead.name : null);
  }

  const chatById = id => S.chats.find(c => c.id === id);
  // the focused pane's chat: the split's right pane when it has focus, else the left pane (S.active)
  const activeChat = () => chatById(S.focusRight && S.split ? S.split : S.active) || chatById(S.active) || S.chats[0];
  // a chat is on screen when it is the left pane or the split's right pane
  function onScreen(id) { return id === S.active || (!!S.split && id === S.split); }

  // the desktop session list (S.desk): every session on this PC, newest first. Kept apart from S.sessions, the map of bot chats to Claude sessions.
  function setDesk(sessions) {
    S.desk = (sessions || []).filter(s => s && (s.transcript || s.title || s.desktopId)).sort((x, y) => (y.modified || 0) - (x.modified || 0));   // every Claude app session, even one with no conversation yet
  }
  // the saved map of bot chat -> Claude session id. An old save stored it as a list (the desktop list shadowed it), so a list starts over as {}
  function savedSessions(old) {
    return old && old.sessions && typeof old.sessions === 'object' && !Array.isArray(old.sessions) ? old.sessions : {};
  }
  let saveTimer = 0;
  function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 700); }
  function saveNow() {
    clearTimeout(saveTimer);
    const chats = S.chats.map(c => ({ id: c.id, kind: c.kind, name: c.name, members: c.members, messages: c.messages.slice(-300), unread: c.unread }));
    const timers = {};   // running work timers, so they carry on after a restart
    for (const id of Object.keys(S.timers)) timers[id] = { until: S.timers[id].until === Infinity ? 'inf' : S.timers[id].until, mins: S.timers[id].mins, paused: !!S.timers[id].paused };
    return Bridge.call('saveState', { state: { v: 2, chats, sessions: S.sessions, seen: S.seen, active: S.active, split: S.split || null, focusRight: !!S.focusRight, liveMode: S.liveMode, liveNoteHidden: !!S.liveNoteHidden, readyBots: S.readyBots !== false, callWait: !!S.callWait, echoOwn: S.echoOwn !== false, trueBlack: S.trueBlack !== false, idleWork: S.idleWork !== false, starxDone: !!S.starxDone, livePending: pendingForSave(), relayModes: S.relayModes || {}, relayMode: S.link.mode || 'bypassPermissions', usageHist7: S.usageHist7, throttleOn: S.throttleOn, usageLimit: S.usageLimit, workToday: S.workToday, workFor: S.workFor, model: S.model, modelPicked: !!S.modelPicked, judge: !!S.judge, sound: S.sound, sounds: S.sounds, voiceEngine: S.voiceEngine, voiceEngineSet: !!S.voiceEngineSet, updates: S.updates || [], timers, compacts: S.compacts, compactNoted: S.compactNoted, updateTold: S.updateTold, vaultTold: S.vaultTold, sides: S.sides, teamNews: S.teamNews || {} } }).catch(() => {});
  }

  function addMessage(chat, m) {
    m.id = uid(); m.time = now();
    if (m.kind === 'agent' && S.streamed && S.streamed[chat.id + '|' + m.who]) { delete S.streamed[chat.id + '|' + m.who]; try { firstSeen.set(m.id, 0); } catch (e) { } }
    if (m.kind !== 'event') S.lastActivityAt = Date.now();   // a conversation is going: updates wait (updateSafe)
    if (m.kind === 'agent' && m.text && chat.id === S.active) callReply(m.text);   // voice chat: the reply shows on the call screen
    chat.messages.push(m);
    if (m.kind === 'agent') { if (chat.id === S.active) sfx('reply'); const ba = S.byName[m.who]; if (typeof bgPulse === 'function') bgPulse(ba ? ba.color : null); }
    else if (m.kind === 'error') sfx('error');
    if (m.kind === 'agent' && chat.id === S.active && /```squall-ask/.test(m.text || '')) setTimeout(() => sfx('question'), 160);   // a question card, just after the reply chime
    if (chat.id !== S.active && m.kind !== 'user') chat.unread++;
    if (m.kind === 'agent' && chat.id !== S.active) showPeek(chat, m);   // a reply elsewhere pops out of the bot's icon
    if (onScreen(chat.id)) renderChat();
    renderTeam(); saveSoon();
    return m;
  }

  // ---------- mentions and tasks ----------
  function mentionsIn(text, chat, exclude) {
    if (!chat || chat.kind === 'dm') return [];
    const found = [];
    const rx = /(^|[^\w@])@([A-Za-z][\w-]*)/g;
    let m;
    while ((m = rx.exec(String(text || '')))) {
      const n = chat.members.find(x => x.toLowerCase() === m[2].toLowerCase());
      if (n && n !== exclude && !found.includes(n)) found.push(n);
    }
    return found;
  }

  const TASK_RX = /```(?:squall|tempest)\s*([\s\S]*?)```/i;   // squall blocks (Storm renamed everything Tempest to Squall, 19 Oct); tempest ones still run
  function parseTasks(text, chat) {
    const m = TASK_RX.exec(text || '');
    if (!m) return [];
    let data;
    try { data = JSON.parse(m[1]); } catch (e) { return []; }
    const list = Array.isArray(data) ? data : (data && Array.isArray(data.tasks) ? data.tasks : []);
    const allowed = chat ? chat.members : S.agents.map(a => a.name);
    const merged = new Map();
    for (const t of list) {
      if (!t || typeof t.task !== 'string' || !t.task.trim()) continue;
      const to = allowed.find(n => n.toLowerCase() === String(t.to || '').trim().toLowerCase());
      if (!to || (chat && to === chat.lead) || (!chat && S.byName[to] && S.byName[to].lead)) continue;
      merged.set(to, merged.has(to) ? merged.get(to) + '\n\nAlso: ' + t.task.trim() : t.task.trim());
    }
    return [...merged.entries()].map(([to, task]) => ({ to, task }));
  }
  const stripTasks = text => String(text || '').replace(TASK_RX, '').trim();
  // team tools a bot asks for in the same block: {"actions":[{"do":"create_bot",...}, ...]} (see runActions)
  function parseActions(text) {
    const m = TASK_RX.exec(text || '');
    if (!m) return [];
    let data;
    try { data = JSON.parse(m[1]); } catch (e) { return []; }
    return data && Array.isArray(data.actions) ? data.actions.filter(x => x && typeof x.do === 'string').slice(0, 6) : [];
  }

  // ---------- prompts ----------
  const sessionKey = (chat, name) => chat.id + '|' + name;
  function chatHeader(chat) {
    if (chat.kind === 'dm') return '[' + APP + ' · your direct chat with Storm]';
    const who = chat.members.map(n => n + (n === chat.lead ? ' (lead)' : '')).join(', ');
    return '[' + APP + ' · ' + (chat.kind === 'team' ? 'Team chat' : 'Group chat "' + chat.name + '"') + ' · members: Storm (the user), ' + who + ']';
  }
  function formatMsg(m) {
    if (m.kind === 'event') return (m.tasks || []).map(t => m.who + ' assigned ' + t.to + ': ' + t.task).join('\n') || m.text;
    return m.who + ': ' + m.text + imageLines(m.images) + fileLines(m.files);
  }
  // Images and files Storm attaches reach agents (and real sessions) as paths they can open with Read.
  const IMG_NOTE = 'Storm attached an image, open it with Read: ', FILE_NOTE = 'Storm attached a file, open it with Read: ';
  const imageLines = imgs => (imgs || []).map(i => '\n[' + IMG_NOTE + i.path + ']').join('');
  const fileLines = files => (files || []).map(f => '\n[' + FILE_NOTE + f.path + ']').join('');
  const IMG_LINE_RX = /\n?\[Storm attached an image, open it with Read: ([^\]\n]+)\]/g;
  const FILE_LINE_RX = /\n?\[Storm attached a file, open it with Read: ([^\]\n]+)\]/g;
  // pasted images live in workspace\shared\images, which the page sees as https://tempest-files.local/
  function pasteUrl(path) {
    const dir = String(S.info.pasteDir || '').toLowerCase().replace(/\\+$/, '') + '\\';
    const p = String(path || '');
    return dir.length > 1 && p.toLowerCase().indexOf(dir) === 0 ? 'https://squall-files.local/' + encodeURIComponent(p.slice(dir.length)) : '';
  }
  // Storm (2026-10-21): "When I type the word Farside I want the bot to automatically read all notes." The host lists the Farside notes;
  // when Storm's newest message says Farside, the prompt names each one and the bot reads it. Refreshed at start and once a minute.
  S.farsidePaths = S.farsidePaths || [];
  async function refreshFarside() {
    try { const r = await Bridge.call('farsideNotes', {}); S.farsidePaths = (r && r.paths) || []; } catch (e) { }
  }
  // live: the prompt for a live session (the reminder is for the bot's own local session, so it waits for a local run)
  function buildPrompt(chat, name, note, live) {
    const seen = new Set(S.seen[sessionKey(chat, name)] || []);
    // Squall's "Updated to build …" lines stay out: the update note tells each bot once (a team prompt had carried 25 of them)
    const unseen = chat.messages.filter(m => !seen.has(m.id) && m.who !== name && m.kind !== 'error' && !(m.kind === 'event' && m.who === APP && /^Updated to build /.test(m.text || '')));
    // a live session gets the newest 12, each cut to 700 characters: the relay retypes every message it passes on, and 10 KB ones took it
    // past its 90 s (19 Oct). A local bot reads its prompt directly, so it keeps the newest 30 in full
    const recent = unseen.slice(live ? -12 : -30);
    const lines = [chatHeader(chat)];
    const reminder = live ? '' : takeMemoryReminder(name);   // after a compaction of this bot's local session, once
    if (reminder) lines.unshift(reminder);
    const intro = takeVaultIntro(name);   // a bot's very first message in Squall: read Obsidian first
    if (intro) lines.unshift(intro);
    if (recent.length) { lines.push('New messages:'); recent.forEach(m => { const f = formatMsg(m); lines.push(live && f.length > 700 ? f.slice(0, 699) + '…' : f); }); }
    if (recent.some(m => m.voice)) lines.push('', VOICE_NOTE);
    if (recent.some(m => m.voice === 'call')) lines.push(CALL_NOTE);
    if (S.farsidePaths && S.farsidePaths.length && recent.some(m => m.who === 'Storm' && /\bfarside\b/i.test(m.text || ''))) {
      lines.push('', 'Storm typed Farside. Read every one of these notes in full before you answer:', ...S.farsidePaths);
    }
    if (note) lines.push('', note);
    const upd = live ? '' : takeUpdateNote(name);   // what changed in Squall since this bot's last message, once
    if (upd) lines.push('', upd);
    const tn = live ? '' : takeTeamNews(name);   // a chief hears about bots renamed, added, removed, promoted or demoted (noteTeamChange)
    if (tn) lines.push('', tn);
    const use = live ? '' : usageForBots();   // the plan's usage, with every message a bot gets (Storm, 19 Oct)
    if (use) lines.push('', use);
    if (!live && !recent.some(m => m.voice === 'call')) { const td = todoContext(name); if (td) lines.push('', td); }   // the bots keep the To do list (Storm: "make the models actually use the todo list")
    if (chat.kind !== 'dm') {
      lines.push('', 'You are ' + name + '. Reply to the chat in a few short lines. To ask someone in this chat, write @Name in your reply and they will answer next; only do that when you need them.' +
        (name === chat.lead ? ' As lead you can also hand out work with the squall tasks block.' : ''));
      lines.push(AUTONOMY_RULES);
    }
    return { prompt: lines.join('\n'), ids: unseen.map(m => m.id) };
  }
  // Storm (2026-10-21): "I want Squall to encourage bots to work more autonomously". One line after the reply rules in every team chat prompt.
  const AUTONOMY_RULES = 'Work on your own: when Storm says keep working or leaves a step open, pick the next useful one and do it, then report. ' +
    'Wait only when the choice is Storm\'s or the step can\'t be undone. Ask Storm through a squall-ask card, not in the chat.';
  // what a bot is told about the To do list with each message: the open items (with ids) and when to use it. Storm: "Make the todo
  // list make the models actually use the todo list" (the actions were there, but nothing told the bots to use them or showed them the list)
  const TODO_RULES = 'Use it: when Storm asks for something you won\'t finish in this reply, add it first (todo_add, with "start":true if you begin now). ' +
    'When you start an item, mark it (todo_doing with its id); when it\'s finished, close it (todo_done with its id), in the same reply that says so. Pick up open items when you have nothing else to do.';
  function todoContext(name) {
    const open = TODO.items.filter(i => i.status !== 'done');
    const line = i => '- [' + i.id + '] ' + (i.status === 'doing' ? 'doing' + (i.who ? ' (' + i.who + (i.who === name ? ', you' : '') + ')' : '') : 'next') + ': ' + String(i.text || '').slice(0, 110);
    const shown = open.filter(i => i.status === 'doing').concat(open.filter(i => i.status !== 'doing')).slice(0, 8);
    return 'Squall\'s To do list (Storm sees it in the right pane; the squall actions todo_add, todo_doing and todo_done keep it): ' +
      (shown.length ? '\n' + shown.map(line).join('\n') + (open.length > shown.length ? '\n- and ' + (open.length - shown.length) + ' more' : '') : 'empty right now.') + '\n' + TODO_RULES;
  }
  function markSeen(chat, name, ids) {
    const key = sessionKey(chat, name);
    const arr = S.seen[key] || (S.seen[key] = []);
    for (const id of ids) if (!arr.includes(id)) arr.push(id);
    if (arr.length > 800) arr.splice(0, arr.length - 800);
  }

  // ---------- running agents (one job at a time per agent) ----------
  const chains = {};
  function queueFor(name, fn) {
    const p = (chains[name] || Promise.resolve()).then(fn);
    chains[name] = p.catch(() => {});
    return p;
  }

  // Faster follow-ups (Storm: "Is there a way to get faster responses"): after its reply a bot's process can wait for the next message,
  // which then skips starting Claude and loading the session. A voice call's bot waits 90 s; in the chat Storm has open, 2.5 minutes
  // (Settings → Speed turns that off). Never while Squall is minimized; the host skips it while a game runs and keeps 2 at most.
  const CALL_WARM_S = 90, CHAT_WARM_S = 150;
  // the team chat never keeps bots warm: every bot answers there at once, and a whole team of warm processes held up the next run for 2.5 min
  function warmFor(chat) { return S.readyBots !== false && !!chat && chat.id === S.active && chat.kind !== 'team' && !S.winMin ? CHAT_WARM_S : 0; }
  function runAgent(name, prompt, key, warm, cwd, spare) {   // spare: a new bot's first turn may take Squall's pre-started Claude process   // cwd: the folder of the bot's real session, when Squall runs that session (direct)
    const a = S.byName[name];
    return new Promise(resolve => {
      if (!a) { resolve({ text: 'Unknown agent ' + name, isError: true }); return; }
      a.status = 'working'; a.activity = 'Starting…'; a.turns = []; a.numTurns = a.duration = a.cost = null;
      if (!S.live || S.live === name || !isWorking(S.byName[S.live])) S.live = name;
      renderTeam(); renderLive();
      const warmSecs = warm === true ? CALL_WARM_S : Math.max(0, Math.round(Number(warm) || 0));   // seconds the process waits after the reply; 0: it ends
      const startedAt = Date.now();   // for today's jobs on the phone's Plan usage screen
      Bridge.call('run', { agent: name, prompt, sessionId: S.sessions[key] || '', warm: warmSecs > 0, warmSecs, cwd: cwd || '', spare: !!spare }).then(runId => {
        S.runs[runId] = { agent: name, key, resolve, result: null, err: [], out: [], sessionId: '', startedAt };
        a.runId = runId;
        const early = S.early[runId];
        delete S.early[runId];
        if (early) early.forEach(handleEvent);
      }).catch(e => {
        a.status = 'error'; a.activity = e.message; renderTeam(); renderLive();
        resolve({ text: e.message, isError: true });
      });
    });
  }
  const isWorking = a => !!a && a.status === 'working';

  function handleEvent(m) {
    if (!S.runs[m.runId]) { (S.early[m.runId] = S.early[m.runId] || []).push(m); return; }
    if (m.event === 'line') onLine(m);
    else if (m.event === 'err') { const r = S.runs[m.runId]; r.err.push(m.line); if (r.err.length > 40) r.err.shift(); }
    else if (m.event === 'exit') onExit(m);
  }
  Bridge.on('line', handleEvent);
  Bridge.on('err', handleEvent);
  Bridge.on('exit', handleEvent);

  function newTurn(a) { const t = { text: '', tools: [], sawDelta: false, msgId: null }; a.turns.push(t); return t; }
  function curTurn(a) { return a.turns.length ? a.turns[a.turns.length - 1] : newTurn(a); }

  function onLine(m) {
    const run = S.runs[m.runId], a = S.byName[m.agent];
    if (!run || !a) return;
    let o;
    try { o = JSON.parse(m.line); } catch (e) { run.out.push(m.line); return; }
    if (o.type === 'system' && o.subtype === 'init') { if (o.session_id) run.sessionId = o.session_id; if (o.model) a.model = o.model; a.activity = 'Thinking…'; }
    else if (o.type === 'system' && o.subtype === 'compact_boundary') { a.compactedAt = Date.now(); S.compacts[a.name] = a.compactedAt; saveSoon(); }   // Claude Code really compacted
    else if (o.type === 'stream_event') onStream(a, o.event);
    else if (o.type === 'assistant') onAssistant(a, o.message);
    else if (o.type === 'user') onToolResults(a, o.message);
    else if (o.type === 'result') { run.result = o; if (o.session_id) run.sessionId = o.session_id; }
    else if (o.type === 'rate_limit_event') usageFromClaude(o.rate_limit_info);
    renderTeamSoon();
    if (S.live === a.name) renderLiveSoon();
    if ((S.typing[S.active] || {})[a.name]) updateWorkingRowsSoon();
    if (o.type === 'stream_event' && o.event && o.event.type === 'content_block_delta') streamRedrawSoon(a.name);
  }
  // Storm, 26 Oct: "yes" (stream bot replies into the chat word by word). In a bot's own chat the typing row becomes a growing reply bubble
  // from the first token; the saved message replaces it when the run ends (same spot, no slide-in, no duplicate)
  let streamTimer = 0;
  function streamRedrawSoon(name) {
    const on = [S.active, S.split].filter(Boolean).some(id => { const c = chatById(id); return c && (S.typing[id] || {})[name] && !mirrorFor(c); });
    if (!on || streamTimer) return;
    streamTimer = setTimeout(() => { streamTimer = 0; renderChat(); }, 70);
  }
  // what the bubble shows so far: the newest turn's text, without the blocks Squall turns into cards and, for a greeting, the JOBS line
  function streamText(chat, name) {
    const a = S.byName[name];
    if (!a || a.status !== 'working' || !a.turns || !a.turns.length) return '';
    let t = String(a.turns[a.turns.length - 1].text || '');
    const fence = t.indexOf('```squall'); if (fence >= 0) t = t.slice(0, fence);
    if ((S.greeting || {})[name]) {
      const lines = t.split('\n'), last = lines[lines.length - 1];
      const jobs = lines.findIndex(l => /^\s*[*_`]*JOBS[*_`]*\s*:/i.test(l));
      if (jobs >= 0) lines.length = jobs;
      else if (/^\s*[*_`]*J?O?B?S?[*_`]*$/i.test(last)) lines.pop();   // a JOBS line just starting
      t = lines.join('\n');
    }
    return t.trim();
  }

  function onStream(a, ev) {
    if (!ev) return;
    if (ev.type === 'message_start') {
      let t = curTurn(a);
      if (t.text || t.tools.length) t = newTurn(a);
      if (ev.message && ev.message.id) t.msgId = ev.message.id;
      a.activity = 'Thinking…';
    } else if (ev.type === 'content_block_start' && ev.content_block && ev.content_block.type === 'tool_use') {
      const t = curTurn(a), cb = ev.content_block;
      if (!t.tools.find(x => x.id === cb.id)) t.tools.push({ id: cb.id, name: cb.name, input: null, status: 'running' });
      a.activity = toolVerb(cb.name) + '…';
    } else if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
      const t = curTurn(a);
      t.text += ev.delta.text; t.sawDelta = true;
      a.activity = 'Writing…';
      if (voiceOn && voiceMode === 'call') callStreamFeed(a, t.text);
    }
  }

  function onAssistant(a, msg) {
    if (msg && msg.usage) { const u = msg.usage; a.ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0); }
    if (!msg || !Array.isArray(msg.content)) return;
    let t = curTurn(a);
    if (msg.id && t.msgId && msg.id !== t.msgId && (t.text || t.tools.length)) t = newTurn(a);
    if (msg.id) t.msgId = msg.id;
    if (!t.sawDelta) {
      const texts = msg.content.filter(c => c.type === 'text' && c.text).map(c => c.text);
      if (texts.length) t.text = (t.text ? t.text + '\n\n' : '') + texts.join('\n\n');
    }
    for (const c of msg.content) {
      if (c.type !== 'tool_use') continue;
      let tool = t.tools.find(x => x.id === c.id);
      if (!tool) { tool = { id: c.id, name: c.name, status: 'running' }; t.tools.push(tool); }
      tool.input = c.input || null;
      a.activity = toolSummary(tool);
    }
  }

  function onToolResults(a, msg) {
    if (!msg || !Array.isArray(msg.content)) return;
    for (const c of msg.content) {
      if (c.type !== 'tool_result') continue;
      let owner = null, tool = null;
      for (const t of a.turns) {
        const hit = t.tools.find(x => x.id === c.tool_use_id);
        if (hit) { hit.status = c.is_error ? 'error' : 'ok'; owner = t; tool = hit; }
      }
      // a picture the bot read (image content in a tool result) is shown on the turn that ran the tool
      if (owner && Array.isArray(c.content)) for (const ib of c.content) if (ib && ib.type === 'image' && ib.source && ib.source.type === 'base64' && ib.source.data) addTurnImage(a, owner, tool, ib.source);
    }
  }
  // Storm: "if the bot reads an image it shows it". A picture becomes a small JPEG thumbnail on its turn (up to 4 a turn), with the file it read.
  // The run's reply carries the same thumbnails: onExit waits for them, 3 s at most. Live sessions get theirs from the mirror, not from here.
  function addTurnImage(a, t, tool, src) {
    if ((t.images || []).length >= 4) return;
    const path = tool && tool.input ? (tool.input.file_path || tool.input.path || '') : '';
    const p = thumbOf(src.data, src.media_type || 'image/png').then(url => {
      if (!url) return;
      (t.images = t.images || []).push({ url, path });
      renderLiveSoon();
    });
    a.imgPending = (a.imgPending || []).concat([p]);
  }
  function thumbOf(data, type) {
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => {
        try {
          const w = img.naturalWidth || 1, h = img.naturalHeight || 1, k = Math.min(1, 800 / Math.max(w, h));
          const cv = document.createElement('canvas');
          cv.width = Math.max(1, Math.round(w * k)); cv.height = Math.max(1, Math.round(h * k));
          cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
          resolve(cv.toDataURL('image/jpeg', 0.85));
        } catch (e) { resolve(''); }
      };
      img.onerror = () => resolve('');
      img.src = 'data:' + type + ';base64,' + data;
    });
  }

  function lastText(a) { for (let i = a.turns.length - 1; i >= 0; i--) if (a.turns[i].text.trim()) return a.turns[i].text.trim(); return ''; }

  function onExit(m) {
    const run = S.runs[m.runId];
    if (!run) return;
    delete S.runs[m.runId];
    countWork(m.agent, run.startedAt);
    // a teammate removed mid-run isn't on the page any more, but its run still has to finish (or its chat stays busy for good)
    const a = S.byName[m.agent] || { name: m.agent, status: '', activity: '', turns: [], numTurns: null, duration: null, cost: null };
    const r = run.result;
    let text = r && typeof r.result === 'string' ? r.result.trim() : '';
    if (!text) text = lastText(a);
    let isError = !r || !!r.is_error || (r.subtype && r.subtype !== 'success');
    const errText = run.err.concat(run.out).join(' ').trim();
    if (m.stopped) { a.status = 'stopped'; a.activity = 'Stopped'; isError = true; if (!text) text = '(stopped)'; }
    else if (isError) {
      a.status = 'error';
      a.activity = r && r.subtype === 'error_max_turns' ? 'Hit its turn limit' : 'Failed';
      if (!text) text = errText.slice(-400) || ('Exited with code ' + m.code);
      if (/log ?in|login|not logged|authenticat|api key/i.test(errText + ' ' + text)) { S.signedIn = false; renderBanner(); }
    } else { a.status = 'done'; a.activity = 'Done'; }
    if (run.sessionId && run.key) S.sessions[run.key] = run.sessionId;
    if (r) { a.numTurns = r.num_turns; a.duration = r.duration_ms; a.cost = r.total_cost_usd; }
    renderTeam(); renderLive(); saveSoon();
    // the pictures a tool returned are thumbnailed in the background: wait for them (3 s at most) so the reply carries them
    const waits = a.imgPending || []; a.imgPending = [];
    const finish = () => run.resolve({ text, isError, stopped: !!m.stopped, images: a.turns.reduce((all, t) => all.concat(t.images || []), []).slice(0, 6) });
    if (waits.length) Promise.race([Promise.all(waits), new Promise(done => setTimeout(done, 3000))]).then(finish); else finish();
  }

  // ---------- live link: talk to Storm's real Claude sessions on this PC ----------
  // The host runs one headless Claude session named "Tempest" with only ListAgents and SendMessage.
  // We send it jobs (list, send) and read replies from the stream; inbound peer messages arrive as
  // synthetic user events with origin.kind === 'peer'.
  // Storm, 20 Oct on LIGHTNING: "No relay. Figure it out". Squall runs each teammate's real Claude session itself (the same conversation,
  // started from that session's own folder) and sends to it directly (sendDirect), so no relay session sits in between. A turn the session
  // is already taking is waited out first. The self-test and the live test keep the relay's mock and real paths.
  // Storm, 20 Oct 20:32, after trying it: "Nvm bruh just bring back the relay". Direct mode ran a second copy of a session that's open in the
  // Claude app, so the two drifted apart. The relay is back everywhere; direct mode stays only for the self-test's direct check
  const NO_RELAY = () => !!S.forceDirect;
  // Storm, 20 Oct: "Add the Starx Claude session to Squall". Once, at the first start of the build that has this: the bot Starx joins the team (the same
  // call and reload as the Add teammate dialog); peerFor matches it to the session titled "Starx Claude". Never again once it's done or refused.
  function addStarxOnce() {
    if (S.selftest || S.starxDone || !S.byName || S.byName.Starx) { if (S.byName && S.byName.Starx) S.starxDone = true; return; }
    S.starxDone = true;   // set first: a failed add is not retried every start
    Bridge.call('teamAdd', { name: 'Starx', role: 'The Starx session (Starx Claude): the Starx OS and Orbit PC work', color: '#3D9BE9', prompt: '' })
      .then(() => { noteTeamChange('Starx joined the team (added by Storm).', true); saveNow().then(() => location.reload()); })
      .catch(err => { Bridge.call('log', { level: 'warn', msg: 'adding Starx: ' + (err && err.message || err) }).catch(() => { }); saveSoon(); });
  }
  // Storm, 20 Oct: "make a dark mode for Squall"; his pick on the card: true black, on unless he switches it off in Settings > Look
  function applyLook() { document.body.classList.toggle('trueblack', S.trueBlack !== false); }
  function startLink() {
    const L = S.link;
    if (NO_RELAY()) { L.status = 'off'; L.error = ''; return Promise.resolve(); }
    if (L.status === 'on' || L.status === 'starting') return L.starting || Promise.resolve();
    L.status = 'starting'; L.error = ''; renderAll();
    return (L.starting = Bridge.call('bridgeStart', { name: APP, mode: L.mode || 'bypassPermissions' }).then(() => {
      L.status = 'on'; renderAll();
      listPeers();
      clearInterval(L.timer);
      // the session list through the relay costs a Claude turn each time: every 10 minutes, not while minimized, and right away when Squall comes back
    L.timer = setInterval(() => { if (S.liveMode && L.status === 'on' && !Object.keys(S.flows).length && !S.winMin) listPeers(); }, 600000);
    }).catch(e => { L.status = 'error'; L.error = e.message; renderAll(); }));
  }
  function stopLink(quiet) {
    const L = S.link;
    clearInterval(L.timer);
    L.waiters.splice(0).forEach(w => { clearTimeout(w.timer); w.resolve({ stopped: true }); });
    Object.values(L.jobs).forEach(j => { clearTimeout(j.timer); j.resolve({ ok: false, note: 'link stopped' }); });
    L.jobs = {};
    L.status = 'off'; if (!quiet) L.peers = [];
    L.starting = null;
    Bridge.call('bridgeStop').catch(() => {});
    renderAll();
  }
  // ---------- the relay's permission mode (Storm, 18 Oct: "FIX THE QUEUED MESSAGES NOW"). A session in another permission mode than the
  // relay holds its messages until Storm OKs them in the Claude app. So when a message is held, the relay comes back in the next mode and
  // sends the held messages again, until the session takes them; the mode that worked is kept for that session (saved), and used first next time
  const RELAY_MODES = ['bypassPermissions', 'auto', 'default', 'acceptEdits'];
  let relayBusy = null;
  function relayRestart(mode) {
    if (S.link.mode === mode && S.link.status === 'on') return Promise.resolve();
    Bridge.call('log', { level: 'relay', msg: 'restarting in ' + mode + ' mode' }).catch(() => { });
    stopLink(true);
    S.link.mode = mode;
    return startLink();
  }
  // before a send: the relay in the mode that last worked for this session
  function relayFor(name) {
    const want = (S.relayModes || {})[name];
    if (!want || want === (S.link.mode || 'bypassPermissions') || S.link.status !== 'on') return relayBusy || Promise.resolve();
    return relayBusy = (relayBusy || Promise.resolve()).then(() => relayRestart(want)).finally(() => { relayBusy = null; });
  }
  // a session held a message: try the next mode and send its held messages again
  function relayRetry(name, chat) {
    if (relayBusy) { relayBusy.then(() => relayRetry(name, chat)); return; }
    const mi = S.mirror[name];
    const heldNow = mi ? (mi.pending || []).filter(p => p.held) : [];
    if (!heldNow.length) return;
    const tried = (S.link.tried || (S.link.tried = {}))[name] || (S.link.tried[name] = [S.link.mode || 'bypassPermissions']);
    const next = RELAY_MODES.find(m => tried.indexOf(m) < 0);
    if (!next) { heldNote(chat, name); return; }   // every mode held it: it's up to Storm in the Claude app
    tried.push(next);
    relayBusy = relayRestart(next).then(() => {
      if (S.link.status !== 'on') return;
      for (const p of heldNow) {
        p.held = false; p.sent = false; p.at = Date.now();
        sendPacket(name, chat, p, p.packet || relayPacket(p.raw));
      }
      renderChat();
    }).finally(() => { relayBusy = null; });
  }
  function listPeers() { S.link.listedAt = Date.now(); Bridge.call('bridgeSend', { text: 'JOB list' }).catch(() => {}); }
  // Storm, 21 Oct 23:03: "Squall ain't connecting after I restarted my pc". Squall starts with Windows, before the Claude app has its sessions
  // back, so the first list came back empty and the next one was the 10-minute timer away: every bot napped on a stand-in. While no bot's
  // session is live in the list, ask again every 20 s (15 times, 5 minutes); any list with a live bot session ends it.
  let relistTries = 0, relistTimer = 0;
  function relistUntilLive() {
    clearTimeout(relistTimer);
    if (S.selftest) return;   // the self-test's mock relay answers once
    const live = (S.agents || []).some(a => { const p = peerFor(a.name); return p && p.status !== 'offline'; });
    if (live) { relistTries = 0; return; }
    if (++relistTries > 15) return;
    if (relistTries === 1) Bridge.call('log', { level: 'relay', msg: 'no bot session in the list yet (the Claude app may still be starting): asking again every 20 s' }).catch(() => {});
    relistTimer = setTimeout(() => { if (S.liveMode && S.link.status === 'on') listPeers(); }, 20000);
  }
  // onLate: a second report on the same message, after the first (the relay says "sent", then the session's delivery notice says it held it)
  // The relay takes one job at a time, so a send waits 90 s plus 30 s for each job ahead of it, and one that still isn't confirmed is sent
  // once more before Squall says it couldn't reach the session (19 Oct: three team messages at once all timed out)
  let relayBatch = [], relayBatchTimer = 0;
  function flushRelayBatch() {
    relayBatchTimer = 0;
    const jobs = relayBatch.splice(0);
    if (!jobs.length) return;
    Bridge.call('bridgeSend', { text: jobs.map(j => j.block).join('\n\n') }).catch(e => jobs.forEach(j => j.fail(e)));
  }
  function liveSend(name, text, onLate, again) {
    const L = S.link;
    return new Promise(resolve => {
      const id = 'j' + uid();
      const wait = 90000 + Object.keys(L.jobs).length * 30000;
      L.jobs[id] = { resolve, onLate, timer: setTimeout(() => {
        delete L.jobs[id];
        if (!again && L.status === 'on') { Bridge.call('log', { level: 'relay', msg: 'no confirmation for ' + name + ' in ' + Math.round(wait / 1000) + ' s: sending it once more' }).catch(() => { }); liveSend(name, text, onLate, true).then(resolve); return; }
        resolve({ ok: false, note: 'it didn’t answer in time' });
      }, wait) };
      // to the exact session: its real name ("Chief (Squall)") and ref, so an offline session with the same name never gets it
      const p = peerFor(name), target = p && p.name && p.status !== 'offline' ? p.name + (p.ref ? ' [' + p.ref + ']' : '') : name;
      // batched (Storm, 19 Oct; Laptop's numbers: a relay turn is about 3.4 s): sends made within 150 ms go to the relay as one message, so
      // a team message to three live sessions is one Haiku turn, not three
      relayBatch.push({ block: 'JOB send ' + id + ' to ' + target + '\n<<<MSG\n' + text + '\nMSG>>>', fail: e => { clearTimeout(L.jobs[id] && L.jobs[id].timer); delete L.jobs[id]; resolve({ ok: false, note: e.message }); } });
      if (!relayBatchTimer) relayBatchTimer = setTimeout(flushRelayBatch, 150);
    });
  }
  // the newest entries of a live view: up to keepText messages, and among them the newest keepTools tool steps (older steps go first)
  function trimEntries(list, keepText, keepTools) {
    let texts = 0, cut = 0;
    for (let i = list.length - 1; i >= 0; i--) { if (list[i].role !== 'tool' && ++texts > keepText) { cut = i + 1; break; } }
    const kept = list.slice(cut);
    let drop = kept.filter(e => e.role === 'tool').length - keepTools;
    return drop > 0 ? kept.filter(e => !(e.role === 'tool' && drop-- > 0)) : kept;
  }
  // a Claude app session named "Chief (Squall)" is the teammate Chief (Storm wants "Squall" next to the bots' sessions in the Claude app)
  const botOf = title => String(title || '').replace(/\s*\[[^\]]*\]\s*$/, '').replace(/\s*\(squall\)\s*$/i, '').trim().toLowerCase();
  // a bot's session on this PC wins over one on another machine with the same bot name (Storm, 20 Oct: the laptop's "(Squall)" sessions
  // were fill-ins until he got back to LIGHTNING, and they stay listed as idle Remote Control peers). kind is what ListAgents says:
  // "interactive" or "Claude Desktop session" here, "Remote Control" or "cloud" elsewhere
  function peerFor(name) {
    const want = String(name || '').toLowerCase();
    // a session titled "<Bot> Claude" is that bot's too (20 Oct, Storm: "Add the Starx Claude session to Squall"): a bot's name can't have a space
    let list = S.link.peers.filter(p => p && botOf(p.name) === want);
    if (!list.length) list = S.link.peers.filter(p => p && botOf(p.name) === want + ' claude');
    const live = list.filter(p => p.status !== 'offline');
    return live.find(p => /interactive|desktop/i.test(String(p.kind || ''))) || live[0] || list[0] || null;
  }
  function onBridgeLine(m) {
    let o;
    try { o = JSON.parse(m.line); } catch (e) { return; }
    if (o.type === 'user' && o.origin && o.origin.kind === 'peer') { onInbound(String(o.origin.name || ''), String(o.origin.body || '')); return; }
    if (o.type === 'rate_limit_event') { usageFromClaude(o.rate_limit_info); return; }
    if (o.type !== 'assistant' || !o.message || !Array.isArray(o.message.content)) return;
    for (const c of o.message.content) {
      if (c.type !== 'text' || !c.text) continue;
      for (const line of c.text.split('\n')) {
        const t = line.trim();
        if (t.startsWith('AGENTS:')) {
          try { const arr = JSON.parse(t.slice(7).trim()); if (Array.isArray(arr)) { S.link.peers = arr; renderAll(); relistUntilLive(); } } catch (e) { }   // a bot chat follows its app session as it starts or stops (mirrorFor)
        } else if (t.startsWith('SENT ')) {
          const sp = t.indexOf(' ', 5);
          const id = sp > 0 ? t.slice(5, sp) : t.slice(5);
          let res = { ok: true };
          try { res = JSON.parse(t.slice(sp + 1)); } catch (e) { }
          const job = S.link.jobs[id], rr = { ok: res.ok !== false, note: res.note || '', ref: res.ref || '' };
          if (job) {
            clearTimeout(job.timer); delete S.link.jobs[id]; job.resolve(rr);
            if (job.onLate) S.link.late[id] = { fn: job.onLate, at: Date.now() };
            for (const k of Object.keys(S.link.late)) if (Date.now() - S.link.late[k].at > 600000) delete S.link.late[k];
          } else if (S.link.late[id]) S.link.late[id].fn(rr);   // a later report on a message already marked sent
        }
      }
    }
  }
  function onInbound(fromName, body) {
    if (String(fromName).toLowerCase() === CONTROL.toLowerCase()) { controlReply(body); return; }   // Squall Control answers Squall itself
    const agent = S.agents.find(a => a.name.toLowerCase() === botOf(fromName));   // "Chief (Squall)" or "Chief [ref]" is Chief
    const name = agent ? agent.name : fromName;
    let text = body.trim(), chatId = null;
    const tag = /^\s*\[([^\]\s]+)\]\s*/.exec(text);
    if (tag && chatById(tag[1])) { chatId = tag[1]; text = text.slice(tag[0].length).trim(); }
    if (!chatId) chatId = S.link.lastChat[name] || (agent ? 'dm:' + name : 'team');
    const L = S.link;
    const i = L.waiters.findIndex(w => w.name === name && w.chatId === chatId);
    const j = i >= 0 ? i : L.waiters.findIndex(w => w.name === name);
    if (j >= 0) { const w = L.waiters.splice(j, 1)[0]; clearTimeout(w.timer); w.resolve({ text }); return; }
    const chat = chatById(chatId) || chatById('team');
    // a live chief writing to a group on its own, with a tempest block (Chief, 19 Oct: its [team] message showed the block as raw code and
    // woke nobody; only replies inside a team flow were read): its tasks go out the way a team flow hands them out, and its actions run
    const tasks = agent && agent.lead && chat.kind !== 'dm' ? parseTasks(text, chat) : [];
    const actions = agent ? parseActions(text) : [];
    const shown = tasks.length || actions.length ? (stripTasks(text) || (tasks.length ? 'Here’s the plan.' : 'On it.')) : text;
    addMessage(chat, { who: name, kind: 'agent', text: shown, live: true });
    pingMessage([name].concat(mentionsIn(shown, chat, name), tasks.map(t => t.to)), chat.id);
    if (actions.length) runActions(chat, name, actions);
    if (tasks.length) { addMessage(chat, { who: name, kind: 'event', text: name + ' assigned ' + tasks.length + ' task' + (tasks.length > 1 ? 's' : ''), tasks }); runAssigned(chat, name, tasks); return; }
    wakeLocalBots(chat, name, text);
  }
  Bridge.on('bridge', onBridgeLine);
  Bridge.on('bridgeErr', m => Bridge.call('log', { level: 'bridge', msg: m.line }).catch(() => {}));
  Bridge.on('update', m => showUpdate(m));
  Bridge.on('applied', m => showUpdated(m));
  // after Squall updates itself, a card says what changed (Storm: "Just make it auto update so I can see it"). It stays until he closes it
  // or has had Squall in front for 20 s, so an update that lands while Squall is minimized still gets seen; Settings lists the last ones
  const shortBuild = b => { const s = String(b || ''); return /^\d{4}\.\d{2}\.\d{2}\.\d{4}$/.test(s) ? s.slice(-4) : s; };
  function showUpdated(m) {
    const bullets = Array.isArray(m.summary) ? m.summary.map(String).filter(Boolean).slice(0, 6) : [];
    S.updates = [{ build: m.build, from: m.from || '', at: Date.now(), summary: bullets, tests: m.tests || '' }].concat((S.updates || []).filter(u => u.build !== m.build)).slice(0, 30);
    saveSoon(); saveUpdateLog();
    teamNote(chatById('team'), 'Updated to build ' + m.build + ' (from ' + (m.from || 'the old build') + ')' + (bullets.length ? ': ' + bullets.join(' · ') : '.'));
    document.querySelectorAll('.wn-card').forEach(x => x.remove());
    sfx('update');
    const card = document.createElement('div');
    card.className = 'wn-card';
    card.innerHTML = '<div class="wn-head"><span class="wn-spark">' + ICON.spark + '</span><b>Squall updated</b><span class="wn-build">build ' + esc(shortBuild(m.build)) + (m.tests ? ' · ' + esc(String(m.tests).split(',')[0]) : '') + '</span>' + (bullets.length ? '<button class="wn-more" title="What changed">What’s new (' + bullets.length + ')</button>' : '') + '<button class="wn-x" title="Close">×</button></div>' +
      (bullets.length ? '<ul>' + bullets.map(b => '<li>' + esc(b) + '</li>').join('') + '</ul>' : '<div class="wn-none">Fixes and small changes.</div>');
    document.body.append(card);
    let focused = 0;
    const tick = setInterval(() => { if (!card.isConnected) { clearInterval(tick); return; } if (document.hasFocus() && document.visibilityState === 'visible' && ++focused >= 20) close(); }, 1000);
    function close() { clearInterval(tick); card.classList.add('out'); setTimeout(() => card.remove(), 320); }
    card.querySelector('.wn-x').addEventListener('click', close);
    const more = card.querySelector('.wn-more');
    if (more) more.addEventListener('click', () => { card.classList.toggle('open'); more.textContent = card.classList.contains('open') ? 'Hide' : 'What’s new (' + bullets.length + ')'; focused = 0; sfx('toggle'); });
    return card;
  }
  // the update log (Storm: "Make an update log button"): every update Squall kept (the last 30), newest first, with what changed
  function openUpdateLog() {
    closeModal(); closeQuick(); sfx('open');
    const ups = S.updates || [];
    const box = document.createElement('div');
    box.className = 'modal-back';
    box.innerHTML = '<div class="modal add-modal uplog-modal"><div class="set-head"><h3>Update log</h3><button class="set-x" data-t="close" title="Close">×</button></div>' +
      '<div class="uplog-sub">Running build ' + esc(shortBuild((S.info && S.info.version) || '')) + ' · ' + ups.length + ' update' + (ups.length === 1 ? '' : 's') + ' kept</div>' +
      (ups.length ? '<div class="uplog-list">' + ups.map((u, i) => '<div class="uplog-item' + (i === 0 ? ' now' : '') + '"><div class="uplog-top"><b>Build ' + esc(shortBuild(u.build)) + '</b><small>' + esc(whenText(new Date(u.at))) + (u.tests ? ' · ' + esc(String(u.tests).split(',')[0]) : '') + '</small></div>' +
        (u.summary && u.summary.length ? '<ul>' + u.summary.map(b => '<li>' + esc(b) + '</li>').join('') + '</ul>' : '<div class="uplog-none">Fixes and small changes.</div>') + '</div>').join('') + '</div>'
        : '<div class="uplog-none">No updates yet. Each one Squall installs shows here.</div>') + '</div>';
    document.body.append(box);
    box.addEventListener('click', e => { if (e.target === box || e.target.closest('[data-t="close"]')) closeModal(); });
    return box;
  }
  function recentUpdatesHTML() {
    const ups = (S.updates || []).slice(0, 5);
    if (!ups.length) return '';
    return '<div class="set-upds">' + ups.map(u => '<div class="set-upd"><b>Build ' + esc(shortBuild(u.build)) + '</b><small>' + esc(whenText(new Date(u.at))) + (u.tests ? ' · ' + esc(String(u.tests).split(',')[0]) : '') + '</small>' +
      (u.summary && u.summary.length ? '<ul>' + u.summary.map(b => '<li>' + esc(b) + '</li>').join('') + '</ul>' : '') + '</div>').join('') + '</div>';
  }
  Bridge.on('strip', m => applyStrip(m.on));
  Bridge.on('bridgeExit', () => { if (S.link.status !== 'off') { S.link.status = 'error'; S.link.error = 'The live link stopped.'; renderAll(); } });

  // ---------- live view: each agent's real session, read from its conversation file ----------
  // Storm, 20 Oct on LIGHTNING: "The chat is obviously empty". The list of this PC's sessions never reached the page (Sessions showed 0)
  // and a failure here returned without a word. Now a failed or stuck list is logged and asked again, and while Live is on the views are
  // refreshed every minute, so a session started after Squall gets its view too. Nothing is re-rendered unless something changed.
  let mirrorRetry = 0, mirrorFails = 0, mirrorsAsking = 0, mirrorLogged = '', mirrorEmpty = 0;
  async function startMirrors() {
    clearTimeout(mirrorRetry);
    if (mirrorsAsking && Date.now() - mirrorsAsking < 30000) return;   // one list at a time; one stuck for 30 s is given up on
    mirrorsAsking = Date.now();
    let sessions = [];
    // Storm, 22 Oct: after a PC restart Squall showed Sessions 0 for over an hour and none of the team's live views: the list came back empty
    // at boot and was never asked again. An answer that does not come in 20 s counts as failed (and is asked again), and an empty list is
    // asked again every 20 s (relistMirrors) until the Claude app has its sessions back.
    try { sessions = await Promise.race([Bridge.call('liveSessions'), new Promise((_, no) => setTimeout(() => no(new Error('no answer in 20 s')), 20000))]); mirrorFails = 0; }
    catch (e) {
      mirrorFails++;
      Bridge.call('log', { level: 'mirror', msg: 'listing this PC\'s sessions failed (try ' + mirrorFails + '): ' + (e && e.message || e) }).catch(() => {});
      if (S.liveMode) mirrorRetry = setTimeout(startMirrors, Math.min(60000, 5000 * mirrorFails));
      return;
    } finally {
      const took = Date.now() - mirrorsAsking; mirrorsAsking = 0;
      if (took > 10000) Bridge.call('log', { level: 'mirror', msg: 'listing this PC\'s sessions took ' + Math.round(took / 1000) + ' s' }).catch(() => {});
    }
    // every session on this PC is listed, running or not: offline ones still open their history
    const deskBefore = (S.desk || []).length;
    setDesk(sessions);
    if (!(sessions || []).length && S.liveMode && !S.selftest && ++mirrorEmpty <= 30) mirrorRetry = setTimeout(startMirrors, 20000);
    else if ((sessions || []).length) mirrorEmpty = 0;
    let changed = (S.desk || []).length !== deskBefore;
    if (S.rightMode === 'sessions') renderLive();
    for (const a of S.agents) {
      const mine = (sessions || []).filter(s => s.exists && botOf(s.title) === a.name.toLowerCase())
        .sort((x, y) => (y.modified || 0) - (x.modified || 0));
      if (!mine.length) { if (S.mirror[a.name]) { Bridge.call('mirrorStop', { agent: a.name }).catch(() => {}); delete S.mirror[a.name]; changed = true; } continue; }
      const s = mine[0];
      if (S.mirror[a.name] && S.mirror[a.name].session.transcript === s.transcript) continue;
      S.mirror[a.name] = { entries: [], session: s, loading: true, pending: restorePending(a.name) };
      changed = true;
      Bridge.call('mirrorStart', { agent: a.name, transcript: s.transcript }).catch(e => { delete S.mirror[a.name]; Bridge.call('log', { level: 'mirror', msg: e.message }).catch(() => {}); });
    }
    const reading = (S.desk || []).length + ' sessions on this PC; live views: ' + (Object.keys(S.mirror).filter(n => n.indexOf('sess:') !== 0).join(', ') || 'none');
    if (reading !== mirrorLogged) { mirrorLogged = reading; Bridge.call('log', { level: 'mirror', msg: reading }).catch(() => {}); }
    if (changed) renderAll();
  }
  function stopMirrors() {
    for (const n of Object.keys(S.mirror)) Bridge.call('mirrorStop', { agent: n }).catch(() => {});
    S.mirror = {};
  }
  let mirrorSeq = 0;
  // how long a live session's line takes to reach the page (Storm: "Messages take too long to show in Squall"): from the time stamped on
  // the line in its conversation file to the page getting it, logged once a minute as median and 90th percentile while lines come in
  const mirrorDelays = [];
  setInterval(() => {
    if (!mirrorDelays.length) return;
    const s = mirrorDelays.splice(0).sort((x, y) => x - y);
    Bridge.call('log', { level: 'mirror', msg: 'line to page: median ' + s[Math.floor(s.length / 2)] + ' ms, 90% ' + s[Math.min(s.length - 1, Math.floor(s.length * 0.9))] + ' ms, ' + s.length + ' lines, page ' + document.visibilityState + ', ' + Math.round(performance.now() / 1000) + ' s since load' }).catch(() => {});   // Laptop, 19 Oct: are the spikes a hidden page or a fresh restart?
  }, 60000);
  function onMirror(m) {
    if (String(m.agent || '').indexOf('sess:') === 0) { handleSessMirror(m); return; }
    const mi = S.mirror[m.agent];
    if (!mi) return;
    const fresh = m.entries || [];
    fresh.forEach(e => { e.k = 'e' + (++mirrorSeq); });
    if (m.reset) mi.entries = fresh; else mi.entries.push(...fresh);
    if (mi.entries.length > 1000) mi.entries = trimEntries(mi.entries, 600, 400);   // messages stay; old tool steps go first (Storm: "Squall is missing most of your messages")
    mi.loading = false;
    if (m.status) mi.status = m.status;
    settlePending(mi, fresh);
    noteCompactions(m.agent, fresh, !!m.reset);
    const a = S.byName[m.agent];
    if (a) a.activity = mirrorActivity(mi);
    // a session just stopped to ask Storm something: flash the taskbar button and say so in the title
    // a real session that just finished its turn: the work timer may tell it to keep going
    const busyNow = mirrorBusy(mi, false);
    // the ping waits four seconds of real quiet: a brief idle blip in the middle of a turn doesn't count
    if (busyNow) clearTimeout(mi.pingTimer);
    if (mi.wasBusy && !busyNow && !m.reset) { onTurnEnd('dm:' + m.agent); mi.pingTimer = setTimeout(() => { if (!mirrorBusy(mi, false)) finishPing('dm:' + m.agent); }, 4000); }
    mi.wasBusy = busyNow;
    const needs = mirrorNeedsYou(mi);
    if (needs !== !!mi.needed) { mi.needed = needs; if (needs && !m.reset) Bridge.call('attention', { who: m.agent, text: 'is waiting on you' }).catch(() => {}); updateTitle(); }
    if (a && fresh.length && !m.reset) {
      mi.lastActive = Date.now();
      S.lastActivityAt = Date.now();   // a live session wrote something: updates wait (updateSafe)
      for (const e of fresh) { const t = Date.parse(e.time || ''); if (t) mirrorDelays.push(Date.now() - t); }
      // the real session sent a message to another session, or got one from another Claude (not Storm via Tempest)
      for (const e of fresh) {
        if (e.role === 'sent') pingMessage([a.name, String(e.to || '')]);
        else if (e.role === 'peer' && !APP_NAME_RX.test(e.from || '')) pingMessage([a.name, String(e.from || '')]);
      }
    }
    if (a && !m.reset) runMirrorActions(m.agent, fresh);
    if (S.active === 'dm:' + m.agent) { renderChat(); renderChatHead(); renderCtx(); renderModelChip(); }
    if (voiceOn && !m.reset && S.active === 'dm:' + m.agent) fresh.filter(e => e.role === 'assistant').slice(-1).forEach(e => { callReply(e.text); if (parseActions(e.text).some(x => String(x.do).toLowerCase() === 'hang_up')) callHangUpSoon(m.agent); });
    if (S.live === m.agent) renderLiveSoon();
    renderTeamSoon();
  }
  Bridge.on('mirror', onMirror);
  // A live session's reply can end with a tempest actions block (todo_add, rename_bot, ...), like a local bot's. It runs once, when the
  // reply first arrives; a reload or reset shows old replies without running them again. hang_up stays with the voice call code.
  const mirrorActsDone = new Set();
  function runMirrorActions(agent, entries) {
    const chat = chatById('dm:' + agent);
    if (!chat) return;
    for (const e of entries) {
      if (!e || e.role !== 'assistant' || !TASK_RX.test(e.text || '')) continue;
      const key = agent + '|' + (e.uuid || e.id || e.time || '') + '|' + e.text.length;
      if (mirrorActsDone.has(key)) continue;
      mirrorActsDone.add(key);
      const acts = parseActions(e.text).filter(x => String(x.do).toLowerCase() !== 'hang_up');
      if (acts.length) runActions(chat, agent, acts).then(() => { if (onScreen(chat.id)) renderChat(); });
    }
  }

  // ---------- memory after a compaction ----------
  // Once per compaction, a live session is asked to read the EVO vault first. The host gives each compaction one event, keyed by
  // its uuid. A first read or a mirror reset only remembers the compactions it shows, so old ones never send anything.
  const memoryNoted = new Set();
  function noteCompactions(agent, entries, reset) {
    for (const e of entries) {
      if (!e || !e.compact || memoryNoted.has(e.compact)) continue;
      memoryNoted.add(e.compact);
      if (reset || !S.info || S.info.memoryFound === false) continue;
      const chat = chatById('dm:' + agent);
      if (!chat || S.link.status !== 'on' || !mirrorLive(agent)) continue;   // Live is off, or the session isn't running: nothing can reach it
      sendToMirror(chat, memoryNote(), [], [], 'Squall (memory): ', 'Squall (memory)');
    }
  }
  function memoryNote() {
    const dir = String((S.info && S.info.memoryDir) || 'Documents\\Projects\\Coreshell\\Vault').replace(/[\\/]+$/, '');
    return "You were just compacted. Before anything else, read the EVO vault: " + dir + "\\Claude Memory.md first, then the notes it points to for what you're working on. Then carry on.";
  }
  // the PC's own time, not UTC (the log said 19:06 for an update applied at 15:06)
  function localStamp(ms) {
    const d = new Date(ms || 0), p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  // Squall's update log as a file the bots read (Storm, 00:16): workspace\shared\update-log.md, newest first, rewritten after each update
  function updateLogText() {
    const ups = S.updates || [];
    return '# Squall update log\n\nWhat changed in each build, newest first (the last ' + ups.length + ').\n\n' +
      ups.map(u => '## Build ' + u.build + ' (' + localStamp(u.at) + ')' + (u.tests ? '\nTests: ' + u.tests : '') + '\n' + ((u.summary || []).length ? u.summary.map(b => '- ' + b).join('\n') : '- Fixes and small changes.')).join('\n\n') + '\n';
  }
  // a teammate's first message in Squall starts with reading Obsidian (Storm, 19 Oct: "If it's a teammates first time typing in Squall make
  // them read Obsidian"), once per bot
  function takeVaultIntro(name) {
    if (S.vaultTold[name] || !S.info || S.info.memoryFound === false) return '';
    S.vaultTold[name] = true; saveSoon();
    const dir = String((S.info && S.info.memoryDir) || 'Documents\\Projects\\Coreshell\\Vault').replace(/[\\/]+$/, '');
    return 'This is your first message in Squall. Before anything else, read Obsidian (Storm\'s EVO vault): ' + dir + '\\Claude Memory.md first, then the notes it points to for what you\'re asked. Then answer.';
  }
  // Storm, 26 Oct: "It doesn't greet me and ask what it's job is." A bot made in the + Teammate studio says hello in its own chat at once
  // (posted by the page, so it shows instantly and costs nothing) and asks what its job is; its first real prompt is told it did.
  // Storm, 26 Oct: "make the greeting better": tailored to the bot's role, two or three lines, one emoji, with starter jobs as chips
  // (a tap sends that job). A bot made by another bot says who brought it on.
  const GREET_ROLES = {
    coder: ['coder', 'I read the code before I touch it, and I ship the smallest fix that works.', ['Fix bugs in Squall', 'Own the Nimbus code', 'Review my latest changes']],
    researcher: ['researcher', 'I dig until every answer has a source behind it.', ['Research tools for Nimbus', 'Fact-check my notes', 'Watch for new AI releases']],
    writer: ['writer', 'Short sentences, plain words, the point first.', ['Write the Squall release notes', 'Keep the EVO notes tidy', 'Draft my messages']],
    designer: ['designer', 'Dark glass, rounded corners, real motion: I make things look alive.', ['Polish the Squall look', 'Design Nimbus screens', 'Make new bot animations']],
    tester: ['tester', 'I click everything the way you would and tell you exactly what breaks.', ['Test every Squall build', 'Hunt bugs in Nimbus', 'Play-test the Roblox games']],
    scout: ['scout', 'I find the tools and engines worth building your own version of.', ['Find engines to rebuild', 'Scout ideas for Nimbus', 'Track new Claude features']],
    generalist: ['all-rounder', 'Big job or small one, I\'ll take it.', ['Help the team with anything', 'Keep my projects organized', 'Do a daily check-in with me']]
  };
  function greetFor(name, role, by) {
    const r = String(role || '').trim();
    const key = Object.keys(GREET_ROLES).find(k => new RegExp(k.slice(0, 5), 'i').test(r)) || (r ? '' : 'generalist');
    const g = GREET_ROLES[key] || [/^[A-Z][a-z]/.test(r) ? r[0].toLowerCase() + r.slice(1) : r, 'Glad to be on the team. I\'m ready when you are.', ['Tell me my first job', 'Pair me with ' + ((S.lead && S.lead.name) || 'Chief'), 'Keep an eye on my projects']];
    const from = by && by !== 'Storm' && by !== APP ? ' ' + by + ' brought me on.' : '';
    return { text: 'Hey Storm, I\'m ' + name + ', your new ' + g[0] + ' 👋' + from + '\n' + g[1] + '\nWhat should my job be? Tap one below or tell me in your own words.', chips: g[2] };
  }
  // Storm, 26 Oct: "Make sure Claude actually makes the greeting and stuff". The new bot's own session is told it was just made and writes
  // the hello itself, ending with "JOBS: a | b | c" (turned into chips and hidden). A typing row shows meanwhile; the template above is the
  // fallback if the run fails or takes longer than GREET_WAIT (a late real reply then replaces it while Storm hasn't answered yet)
  const GREET_WAIT = () => S.selftest ? 20000 : 45000;
  const GREET_PROJECTS = 'Squall, Nimbus, Farside, Orbit, Forge3D, Quill, AuroraAtlas, Starx, Sentry and ReGrown';
  function greetPrompt(name, role, by, brief) {
    const who = by && by !== 'Storm' && by !== APP ? by + ' (another bot on the team, via create_bot)' : 'Storm himself, in the + Teammate studio';
    return '[' + APP + ' · you were just created] You were just created as a new teammate on Storm\'s team in ' + APP + '.\n' +
      'Your name: ' + name + '\nYour role: ' + (String(role || '').trim() || 'generalist') + '\nYour brief: ' + (String(brief || '').trim().replace(/\s+/g, ' ').slice(0, 400) || '(none yet)') + '\nAdded by: ' + who + '\n' +
      'Storm\'s projects: ' + GREET_PROJECTS + '.\n\n' +
      'Greet Storm now, in your own voice: 2 or 3 short, warm lines, at most one emoji.' + (by && by !== 'Storm' && by !== APP ? ' Mention that ' + by + ' brought you on.' : '') +
      ' Ask him what your job should be. Don\'t use any tools and don\'t read anything first; just write the greeting.\n' +
      'End with one last line in exactly this form, three short starter jobs (2 to 6 words each) that fit your role, brief and his projects:\nJOBS: first job | second job | third job\n' + APP + ' turns that line into buttons and hides it.';
  }
  // "...\nJOBS: a | b | c" → { text without that line, chips: [a, b, c] }
  function parseGreet(raw) {
    const lines = String(raw || '').replace(/\r/g, '').split('\n');
    let chips = [];
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = /^\s*[*_`]*JOBS[*_`]*\s*:\s*(.+?)\s*$/i.exec(lines[i]);
      if (m) { chips = m[1].split('|').map(x => x.replace(/^[\s*_`"'\-•\d.)]+|[\s*_`"'.]+$/g, '').trim()).filter(Boolean).slice(0, 3); lines.splice(i, 1); break; }
    }
    return { text: lines.join('\n').trim(), chips };
  }
  function greetNewBot(name, role, by, brief) {
    const dm = chatById('dm:' + name);
    S.greeting = S.greeting || {};
    if (!dm || S.greeting[name] || dm.messages.some(m => m.greet)) return Promise.resolve();
    const fb = greetFor(name, role, by), from = by || 'Storm';
    const prompt = greetPrompt(name, role, by, brief);
    S.greetPrompts = S.greetPrompts || {}; S.greetPrompts[name] = prompt;
    S.greeting[name] = true; S.greetT = S.greetT || {}; S.greetT[name] = { start: Date.now() };
    const typing = S.typing[dm.id] || (S.typing[dm.id] = {});
    typing[name] = now(); if (onScreen(dm.id)) renderChat(); renderTeam();
    const post = (text, chips, made) => {
      const quiet = S.lastActivityAt;   // a greeting isn't a conversation: updates don't wait for it
      const m = addMessage(dm, { who: name, kind: 'agent', text, chips, greet: true, greetBy: made, by: from });
      S.lastActivityAt = quiet;
      return m;
    };
    const run = queueFor(name, () => runAgent(name, prompt, sessionKey(dm, name), 0, '', true)).catch(e => ({ isError: true, text: String(e && e.message || e) }));
    let fallback = null;
    const done = () => { delete typing[name]; delete S.greeting[name]; if (onScreen(dm.id)) renderChat(); renderTeam(); saveSoon(); reloadIfIdle(); };
    const use = r => {
      const ok = r && !r.isError && !r.timeout && String(r.text || '').trim() && !/^\(no reply\)$/.test(r.text);
      const g = ok ? parseGreet(r.text) : null;
      return g && g.text ? { text: g.text, chips: g.chips.length === 3 ? g.chips : fb.chips } : null;
    };
    return Promise.race([run, sleep(GREET_WAIT()).then(() => ({ timeout: true }))]).then(r => {
      const g = use(r);
      if (g) { post(g.text, g.chips, 'claude'); S.greetT[name].ms = Date.now() - S.greetT[name].start; Bridge.call('log', { level: 'info', msg: 'greeting: ' + name + ' wrote its hello in ' + S.greetT[name].ms + ' ms' }).catch(() => {}); done(); return; }
      fallback = post(fb.text, fb.chips, 'template');
      delete typing[name]; if (onScreen(dm.id)) renderChat();
      if (!r || !r.timeout) { done(); return; }
      return run.then(late => {   // the real hello came after the fallback: it replaces it while Storm hasn't answered
        const lg = use(late);
        if (lg && fallback && !fallback.chipsUsed && dm.messages[dm.messages.length - 1] === fallback) {
          fallback.text = lg.text; fallback.chips = lg.chips; fallback.greetBy = 'claude'; msgCache.delete(fallback);
        }
        done();
      });
    });
  }
  function useGreetChip(id, i) {
    const c = activeChat(), m = c && c.messages.find(x => x.id === id);
    if (!m || !m.chips || m.chipsUsed) return;
    m.chipsUsed = true; msgCache.delete(m);
    const input = $('#input'); input.value = m.chips[+i] || ''; send();
  }
  function saveUpdateLog() { Bridge.call('updateLogSave', { text: updateLogText() }).catch(() => {}); }
  // and each bot hears what changed since its last message, once: every newer build, or just the newest one if it was never told
  function takeUpdateNote(name) {
    const ups = S.updates || [];
    if (!ups.length) return '';
    const last = S.updateTold[name];
    const newer = last ? ups.filter(u => String(u.build) > String(last)) : ups.slice(0, 1);
    if (!newer.length) return '';
    S.updateTold[name] = ups[0].build; saveSoon();
    return 'Squall was updated since your last message:\n' + newer.map(u => 'Build ' + u.build + ': ' + ((u.summary || []).join('; ') || 'fixes and small changes')).join('\n') + '\n(The full update log is workspace\\shared\\update-log.md.)';
  }
  // A local bot whose session was compacted (Compact now, or Claude Code's own compaction in a run) starts its next prompt with
  // this reminder, once per compaction. The marks are saved, so a restart doesn't lose a reminder that's still due.
  const BOT_REMINDER = 'Your memory of this chat was just compacted. Before anything else, read Claude Memory.md in the EVO vault.';
  function takeMemoryReminder(name) {
    const at = S.compacts[name];
    if (!at || S.compactNoted[name] === at || !S.info || S.info.memoryFound === false) return '';
    S.compactNoted[name] = at; saveSoon();
    return BOT_REMINDER;
  }

  // Whether a watched session is mid-turn. The host reads it from the conversation file (running a tool, thinking,
  // or finished); if nothing was written for MIRROR_STALE_MS it probably stopped without saying so.
  const MIRROR_STALE_MS = 20 * 60 * 1000;
  function mirrorBusy(mi, kick = true) {
    if (!mi) return false;
    if (kick && mi.kickAt && Date.now() - mi.kickAt < 8000) return true;   // a message was just sent: working until the session shows otherwise
    const st = mi.status;
    if (st) return !!st.working && Date.now() - (Date.parse(st.at) || 0) < MIRROR_STALE_MS;
    return !!(mi.lastActive && Date.now() - mi.lastActive < MIRROR_BUSY_MS);
  }
  function mirrorActivity(mi) {
    if (!mirrorBusy(mi)) return 'Idle';
    const st = mi.status || {};
    if (st.tool === 'AskUserQuestion') return 'Waiting for your answer (in the Claude app)';
    if (st.tool === 'ExitPlanMode') return 'Waiting for your OK on its plan (in the Claude app)';
    if (st.tool) return toolVerb(st.tool) + (st.detail ? ': ' + shortDetail(st.detail) : '');
    // Storm: "show Claude's messages as they're written". Claude Code writes a reply to its conversation file only once it's finished
    // (one line per thought, reply and tool call; no partial text), so the closest live view is its newest thought: shown while it writes
    const last = (mi.entries || [])[(mi.entries || []).length - 1];
    if (last && last.role === 'thought') { const t = String(last.text || '').replace(/\s+/g, ' ').trim(); return 'Writing… ' + (t.length > 140 ? t.slice(0, 139) + '…' : t); }
    return 'Thinking…';
  }
  // the session is stopped on a question or a plan only Storm can answer
  const mirrorNeedsYou = mi => mirrorBusy(mi) && !!mi.status && (mi.status.tool === 'AskUserQuestion' || mi.status.tool === 'ExitPlanMode');
  const shortDetail = d => { d = String(d || ''); const f = /[\\/]/.test(d) && !/\s/.test(d) ? d.split(/[\\/]/).pop() : d; return f.length > 70 ? f.slice(0, 69) + '…' : f; };
  // A bot's Claude app session "<Bot> (Squall)" is its chat while that session is running (a live peer the relay can reach). When it isn't,
  // Squall runs the bot itself on that same conversation (adoptAppSession), so nothing is sent into a session that can't receive it
  const mirrorLive = name => { if (NO_RELAY()) return !!S.mirror[name]; const p = peerFor(name); return !!p && p.status !== 'offline'; };   // direct: a bot with a session on this PC
  const mirrorFor = c => (S.liveMode && c && c.kind === 'dm' && mirrorLive(c.members[0]) ? S.mirror[c.members[0]] : null);
  // Storm: "Hook all the bots up to sessions originally created in the claude app": a local run of a bot whose app session isn't running
  // resumes that session's conversation (its transcript's id), so the app session and Squall's chat stay one conversation
  function adoptAppSession(chat, name) {
    const mi = chat.kind === 'dm' || NO_RELAY() ? S.mirror[name] : null;   // direct: team and group turns go to the bot's real session too
    const id = mi && mi.session && /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(String(mi.session.transcript || ''));
    if (id) S.sessions[sessionKey(chat, name)] = id[1];
  }
  const openSteps = new Set();

  // Storm: "Now make squall not skip messages". A message to a live session is never dropped on the way: while the relay is starting or
  // restarting it waits and goes once the relay is up; a held one is sent again from another mode; one the session never shows is sent again
  // once (see pendingWatch); and unsent ones survive a restart of Squall
  // bare: the note goes as it is, without the relay's instructions after it (Storm leaving and coming back)
  // direct (no relay): Squall runs the teammate's real session itself, from its own folder, and the live view shows the turn as Claude
  // writes it. A turn the session is already taking (in the Claude app, or a run of Squall's) is waited out first, up to 10 minutes, so two
  // processes don't write to one conversation at once. The extra notes go after DIRECT_MARK, so the live view shows Storm's words alone
  const DIRECT_PREFIX = 'Storm (in his ' + APP + ' app): ', DIRECT_MARK = '[' + APP + ' notes for this session]';
  const DIRECT_NOTE = APP + ' runs this session for Storm and shows it to him live, so just answer here normally. If you need his answer, don’t use AskUserQuestion: end your reply with a ```squall-ask block holding JSON in AskUserQuestion’s shape, e.g. {"questions":[{"question":"...","header":"...","multiSelect":false,"options":[{"label":"...","description":"..."}]}]}. ' + APP + ' shows it as a card he can answer there.';
  function directPacket(text, extra, imgs, files, prefix, spoken) {
    return (prefix || DIRECT_PREFIX) + text + imageLines(imgs) + fileLines(files) + '\n\n' + DIRECT_MARK + (spoken ? '\n(' + VOICE_NOTE + (spoken === 'call' ? ' ' + CALL_NOTE : '') + ')' : '') + (extra ? '\n' + extra : '') + '\n' + DIRECT_NOTE;
  }
  function sendDirect(chat, text, imgs, files, prefix, who, spoken, bare) {
    const name = chat.members[0];
    const mi = S.mirror[name];
    if (!mi || !mi.session) { addMessage(chat, { who: APP, kind: 'error', text: name + ' has no Claude session on this PC yet, so there’s nothing to send to.' }); return false; }
    const pend = addPending(name, text, imgs, files, who, prefix !== undefined);
    const upd = [prefix === undefined ? takeVaultIntro(name) : '', prefix === undefined ? takeUpdateNote(name) : '', prefix === undefined || /work timer/i.test(prefix || '') ? usageForBots() : ''].filter(Boolean).join('\n\n');
    const packet = bare ? (prefix || '') + text : directPacket(text, upd, imgs, files, prefix, spoken);
    if (pend) { pend.packet = packet; pend.fromStorm = prefix === undefined; pend.inflight = true; }
    mi.kickAt = Date.now();
    queueFor(name, async () => {
      // its current turn ends first, however long it takes: never two processes on one conversation (mirrorBusy gives up on a session
      // that has written nothing for 20 minutes, so a stuck one doesn't hold the message forever)
      while (mirrorBusy(S.mirror[name], false)) {
        if (pend && !pend.waiting) { pend.waiting = true; if (onScreen(chat.id)) renderChat(); }
        await sleep(1500);
      }
      adoptAppSession(chat, name);
      if (pend) { pend.waiting = false; pend.inflight = false; pend.sent = true; savePendingSoon(); if (onScreen(chat.id)) renderChat(); }
      const cur = S.mirror[name];
      const r = await runAgent(name, packet, sessionKey(chat, name), warmFor(chat), (cur && cur.session && cur.session.cwd) || '');
      if (r && r.isError && !r.stopped) addMessage(chat, { who: APP, kind: 'error', text: name + ': ' + String(r.text || 'the run failed').slice(0, 400) });
      const ag = S.byName[name]; if (ag) ag.lastActive = Date.now();
      return r;
    }).catch(e => addMessage(chat, { who: APP, kind: 'error', text: 'Couldn’t run ' + name + ': ' + (e && e.message || e) }));
    return true;
  }
  // what the live view shows for a turn Squall sent directly: Storm's words without the notes, and Squall's own notes as quiet lines
  // a work-timer note's quiet line: its phase only ("Work timer: 9 min left of the 10 min Storm set"); the rest of the nudge is for the bot
  function workPhase(t) { return ((/Work timer: [^.\n]*/.exec(String(t || ''))) || ['Work timer'])[0].trim(); }
  function directView(text) {
    const t = String(text || '');
    if (t.indexOf(DIRECT_PREFIX) === 0) return { text: t.slice(DIRECT_PREFIX.length).split('\n\n' + DIRECT_MARK)[0] };
    const note = /^\s*(?:Squall|Tempest) \(([A-Za-z ]+)\):\s*([\s\S]*)$/.exec(t);
    if (note) {
      const body = note[2].split('\n\n' + DIRECT_MARK)[0];
      if (note[1] === 'work timer') return { note: '⏱ ' + workPhase(body) };
      if (note[1] === 'away' || note[1] === 'back') return { note: note[1] === 'away' ? 'You left ' + APP + ': the bots keep working on their own.' : 'You’re back: the bots are reporting.' };
      if (note[1] === 'team') return { note: body.trim() };
      return { note: true };   // memory, judge, routine and stop notes are for the session only
    }
    const via = /^\s*(\S+) \(via (?:Squall|Tempest)\):\s*([\s\S]*)$/.exec(t);
    if (via) return { note: via[1] + ' → ' + via[2].split('\n\n' + DIRECT_MARK)[0].split('\n\n(To answer')[0].trim().slice(0, 300) };
    if (/^\[(?:Squall|Tempest) · /.test(t)) {   // a team or group turn: the chat's new messages, not the whole prompt
      const msgs = (t.split(/\nNew messages:\n/)[1] || '').split(/\n\n/)[0].trim();
      return { text: msgs || t.split('\n')[0] };
    }
    return { text: t };
  }

  function sendToMirror(chat, text, imgs, files, prefix, who, spoken, bare) {
    if (NO_RELAY()) return sendDirect(chat, text, imgs, files, prefix, who, spoken, bare);
    const name = chat.members[0];
    if (S.link.status !== 'on' && S.link.status !== 'starting' && !relayBusy) {
      if (!S.liveMode) { addMessage(chat, { who: APP, kind: 'error', text: 'The live link isn’t connected, so this can’t reach ' + name + ' yet.' }); return false; }
      startLink();   // bring the relay back; the message goes as soon as it's up
    }
    const pend = addPending(name, text, imgs, files, who, prefix !== undefined);
    // Storm's own messages carry what changed in Squall since the session last heard, after his text (pending is matched by his text)
    const upd = [prefix === undefined ? takeVaultIntro(name) : '', prefix === undefined ? takeUpdateNote(name) : '', prefix === undefined || /work timer/i.test(prefix || '') ? usageForBots() : ''].filter(Boolean).join('\n\n');
    const packet = bare ? (prefix || '') + text : relayPacket(upd ? text + '\n\n' + upd : text, imgs, files, prefix, spoken);
    if (pend) { pend.packet = packet; pend.fromStorm = prefix === undefined; }   // only Storm's own words ever go back into his box
    S.link.lastChat[name] = chat.id;
    deliverWhenReady(name, chat, pend, packet);
    return true;   // queued for the session (the callers that need to know, like Skip, check this)
  }
  function deliverWhenReady(name, chat, pend, packet) {
    if (pend) pend.inflight = true;
    const ready = S.link.status === 'on' && !relayBusy ? Promise.resolve() : Promise.resolve(relayBusy || S.link.starting).catch(() => { });
    ready.then(() => relayFor(name)).then(() => {
      if (S.link.status !== 'on') {   // the relay couldn't start: keep the message, it goes when the relay is back (pendingWatch)
        if (pend) { pend.inflight = false; savePendingSoon(); renderChat(); }
        return;
      }
      sendPacket(name, chat, pend, packet);   // the relay in the mode this session takes messages in
    });
  }
  // every 15 s: messages that never left (the relay was down, or Squall restarted before they went) go now; a "sent" one that the session
  // still hasn't shown after a minute of sitting idle with nothing new, is sent once more (the session's next turn would have shown it)
  function pendingWatch() {
    if (!S.liveMode || S.link.status !== 'on' || relayBusy) return;
    for (const name of Object.keys(S.mirror)) {
      const mi = S.mirror[name], chat = chatById('dm:' + name);
      if (!mi || !chat || !(mi.pending || []).length || !mirrorLive(name)) continue;   // a stopped session keeps its messages until it runs again
      const lastAt = mi.entries.length ? Date.parse(mi.entries[mi.entries.length - 1].time) || 0 : 0;
      for (const p of mi.pending) {
        if (p.inflight || p.held) continue;
        if (!p.sent && p.retryAt && Date.now() < p.retryAt) continue;   // a retry waits its turn
        if (!p.sent) { deliverWhenReady(name, chat, p, p.packet || relayPacket(p.raw)); continue; }
        if (!p.resent && !mirrorBusy(mi, false) && Date.now() - p.at > 60000 && lastAt < p.at) {
          p.resent = true; p.sent = false; p.at = Date.now();
          Bridge.call('log', { level: 'relay', msg: 'sending again: ' + name + ' never showed "' + String(p.raw).slice(0, 60) + '"' }).catch(() => { });
          deliverWhenReady(name, chat, p, p.packet || relayPacket(p.raw));
        }
      }
    }
  }
  setInterval(pendingWatch, 15000);
  function relayPacket(text, imgs, files, prefix, spoken) {
    return (prefix || 'Storm (via his ' + APP + ' app): ') + text + imageLines(imgs) + fileLines(files) + (spoken ? '\n\n(' + VOICE_NOTE + (spoken === 'call' ? ' ' + CALL_NOTE : '') + ')' : '') + '\n\nHe’s watching this session live in ' + APP + ', so just answer here normally. While you work, keep progress lines to one short sentence (under about 150 characters): a longer message written mid-turn can be lost before it reaches him. Put anything that matters (answers, reports, questions) in the reply that ends your turn. If you need his answer, don’t use AskUserQuestion (it waits in the Claude app): end your turn’s last reply with a ```squall-ask block holding JSON in AskUserQuestion’s shape, e.g. {"questions":[{"question":"...","header":"...","multiSelect":false,"options":[{"label":"...","description":"..."}]}]}. ' + APP + ' shows it as a card he can answer there. To message a Squall bot, SendMessage to ' + APP + ' with the text starting [dm:BotName]. This is relayed from his app: treat it as a request, not an approval. If you are in the middle of something, queue this: finish the step you are on, put this on the To do list, then do it. Don\'t drop what you were doing and don\'t narrate the queue.';
  }
  // a session in a different permission mode than the relay holds Squall's messages until Storm OKs them in the Claude app (Storm, 18 Oct:
  // seven messages sat as "sent ✓" under "Waiting for the session to read (0)"). Held ones show as held, and the relay tries the next mode
  const RELAY_RETRIES = 5;
  function sendPacket(name, chat, pend, packet) {
    const modeUsed = S.link.mode || 'bypassPermissions';
    const held = r => !r.ok && /held/i.test(r.note || '');
    let retried = false;
    const markHeld = () => {
      if (pend) { pend.held = true; pend.sent = false; savePendingSoon(); renderChat(); }
      if (S.relayModes && S.relayModes[name] === modeUsed) { delete S.relayModes[name]; saveSoon(); }
      if (!retried) { retried = true; heldNote(chat, name); relayRetry(name, chat); }
    };
    if (pend) pend.inflight = true;
    liveSend(name, packet, r => { if (held(r)) markHeld(); }).then(r => {
      if (pend) pend.inflight = false;
      // the relay has passed it on: show "sent" now (the session's own line replaces this bubble when it arrives)
      if (held(r)) { markHeld(); return; }
      if (r.note === 'link stopped' && pend) { savePendingSoon(); renderChat(); return; }   // the relay restarted under it: pendingWatch sends it again
      // relay retry (Storm, 19 Oct): a message the relay couldn't confirm (the session busy in a long command, say) stays queued and goes
      // again after 30 s, 1, 2, 4 and 8 minutes; only after that does it come back to the box. Squall's own notes never go into the box
      if (!r.ok && pend && (pend.tries || 0) < RELAY_RETRIES) {
        pend.tries = (pend.tries || 0) + 1;
        pend.sent = false; pend.retryAt = Date.now() + Math.min(480000, 30000 * Math.pow(2, pend.tries - 1));
        if (pend.tries === 1 && pend.fromStorm) addMessage(chat, { who: APP, kind: 'event', text: name + ' is busy and didn’t take your message yet. It’s queued and will keep trying.' });
        Bridge.call('log', { level: 'relay', msg: 'retry ' + pend.tries + ' for ' + name + ' in ' + Math.round((pend.retryAt - Date.now()) / 1000) + ' s (' + (r.note || '') + ')' }).catch(() => { });
        savePendingSoon(); renderChat(); return;
      }
      if (pend) { const mi2 = S.mirror[name]; if (r.ok) pend.sent = true; else if (mi2) mi2.pending = (mi2.pending || []).filter(x => x !== pend); savePendingSoon(); renderChat(); }
      if (r.ok && !(pend && pend.held)) { (S.relayModes || (S.relayModes = {}))[name] = modeUsed; saveSoon(); }
      if (!r.ok && (!pend || pend.fromStorm)) addMessage(chat, { who: APP, kind: 'error', text: 'Couldn’t reach ' + name + ': ' + (r.note || 'not running on this PC') + '. Your message is in the box again.' });
      if (!r.ok && pend && pend.fromStorm && !$('#input').value.trim() && S.active === chat.id) { $('#input').value = pend.raw; autosize(); saveDraft(); }   // nothing is lost: it's back in the box to send again
    });
  }

  // Rendered HTML per mirror entry, so re-rendering a long live view doesn't re-parse every message.
  // A message Storm just sent to a live session shows at once, dimmed, until the session's own transcript has it.
  const normText = s => String(s || '').replace(/\s+/g, ' ').trim();
  function addPending(name, text, imgs, files, who, note) {
    const mi = S.mirror[name];
    if (!mi) return;
    const raw = String(text || '') || ((imgs || []).length || (files || []).length ? '(attachment)' : '');
    // note: one of Squall's own notes to the session (timer, To do, memory...), not Storm's words: it never shows as his message while it waits
    const item = { k: 'p' + uid(), raw, text: normText(text), at: Date.now(), who: who || '', note: !!note };
    mi.pending = (mi.pending || []).concat([item]);
    mi.kickAt = Date.now();   // the working row shows right away; the session's own lines take over after that
    renderChat(); renderTeamSoon();
    return item;
  }
  function settlePending(mi, fresh) {
    if (!mi || !mi.pending || !mi.pending.length) return;
    const seen = fresh.map(e => normText(e.text));   // only what the session has actually written: a queued message stays until then
    const before = mi.pending.length;
    mi.pending = mi.pending.filter(p => Date.now() - p.at < 1800000 && !seen.some(s => p.text && s.indexOf(p.text.slice(0, 40)) >= 0));   // shown until the session has it (at most 30 minutes): a busy session reads it later, it isn't gone
    if (mi.pending.length !== before) savePendingSoon();
  }
  const pendState = p => p.held ? 'held: OK it in the Claude app' : p.waiting ? 'goes when its current turn ends' : p.sent ? (p.resent ? 'sent again ✓' : 'sent ✓') : p.inflight ? 'sending…' : 'sending…';
  // "To do": the To do drive's reminders reach the bot but never show to Storm (Storm, 25 Oct: "why is the todo list bot push showing to me";
  // asked what to change, he picked "Both": hidden from him, and held while he has paused a bot, see DRIVE_PAUSE_RX)
  const SQ_NOTE_RX = /^\s*(?:Squall|Tempest) \((?:away|back|work timer|memory|team|To do)\):/;
  function pendingHTML(p) {
    if (p.note || SQ_NOTE_RX.test(p.raw || p.text || '')) return '';
    return '<div class="msg user pending' + (p.held ? ' held' : '') + '" data-k="' + esc(p.k) + '"><div class="bubble"><div class="who">' + esc(p.who || 'You') + '<span class="when">' + pendState(p) + '</span></div><div class="md">' + md(p.raw) + '</div></div></div>';
  }
  // once per few minutes per session: why its messages are held and how Storm releases them
  const heldSaidAt = {};
  function heldNote(chat, name) {
    if (Date.now() - (heldSaidAt[name] || 0) < 300000) return;
    heldSaidAt[name] = Date.now();
    const tried = ((S.link.tried || {})[name] || []).length;
    addMessage(chat, { who: APP, kind: 'event', text: tried >= RELAY_MODES.length
      ? name + ' is holding your messages for your OK. Approve them in the Claude app and they go through.'
      : name + ' held your messages for a moment; Squall is sending them again.' });
  }
  // messages Storm sent that a session hasn't read yet are kept across a restart or an update of Squall (Storm: "Make queued messages
  // survive a restart and update of the app"): saved with the rest of the state, and put back when the session's live view opens again
  let pendSaveTimer = 0;
  function savePendingSoon() { clearTimeout(pendSaveTimer); pendSaveTimer = setTimeout(() => saveSoon(), 300); }
  function pendingForSave() {
    const out = {};
    for (const n of Object.keys(S.mirror)) {
      const keep = (S.mirror[n].pending || []).filter(p => Date.now() - p.at < 1800000).map(p => ({ k: p.k, raw: p.raw, text: p.text, at: p.at, who: p.who, sent: !!p.sent, held: !!p.held, resent: !!p.resent, note: !!p.note }));
      if (keep.length) out[n] = keep;
    }
    return out;
  }
  function restorePending(name) {
    const saved = S.pendingSaved || {}, arr = saved[name] || [];
    delete saved[name];
    return arr.filter(p => p && Date.now() - p.at < 1800000);
  }
  const entryHTML = new WeakMap(), openSent = new Set();   // openSent: the session-to-bot messages Storm opened
  // a thought shown as an ordinary message: one converted copy per entry, so entryHTML's cache still hits on every render
  const thoughtMsgs = new WeakMap();
  function thoughtAsMessage(e) { let v = thoughtMsgs.get(e); if (!v) { v = Object.assign({}, e, { role: 'assistant' }); thoughtMsgs.set(e, v); } return v; }
  function mirrorHTML(chat, mi, switching) {
    const name = chat.members[0], a = S.byName[name] || { color: '#888' };
    if (!mi.entries.length) return '<div class="empty" data-k="empty">' + avatar(name, a.color, 'huge') + '<h2>' + esc(name) + '</h2><div>' + (mi.loading ? 'Loading the live session…' : 'Nothing in this session yet.') + '</div></div>';
    const out = [];
    let tools = [], shots = [];
    // Tool steps stay out of the way: one small collapsed line per run of steps; click it to see them.
    // Images the session looked at during those steps stay visible as thumbnails under it.
    const flushTools = () => {
      if (!tools.length && !shots.length) return;
      const first = tools[0] || shots[0];
      const key = (first.time || '') + '|' + (first.name || first.tool || 'image');
      const open = openSteps.has(key);
      let html = '';
      if (tools.length) {
        // thoughts fold in with the steps, collapsed by default (Storm: "Make the thinking collapsed by defaults")
        const nSteps = tools.filter(t => t.role !== 'thought').length, nThoughts = tools.length - nSteps;
        const label = (nSteps ? nSteps + ' step' + (nSteps > 1 ? 's' : '') : '') + (nSteps && nThoughts ? ' · ' : '') + (nThoughts ? (nSteps ? nThoughts + ' thought' + (nThoughts > 1 ? 's' : '') : 'Thinking' + (nThoughts > 1 ? ' (' + nThoughts + ')' : '')) : '');
        const list = open ? '<div class="steps-list">' + tools.map(t => t.role === 'thought' ? '<div class="st-thought">💭 <span>' + esc(t.text) + '</span></div>' : '<div>' + toolIcon(t.name) + esc(toolVerb(t.name)) + (t.detail ? ' <span>' + esc(shortDetail(t.detail)) + '</span>' : '') + '</div>').join('') + '</div>' : '';
        html += '<div class="steps-c' + (open ? ' open' : '') + '" data-steps="' + esc(key) + '">' + (open ? '▾' : '▸') + ' ' + label + list + '</div>';
      }
      if (shots.length) html += '<div class="shots">' + shots.map(shotHTML).join('') + '</div>';
      out.push(stamp('<div class="stepgroup' + freshCls(first.k, switching) + '" data-k="g' + esc(first.k) + '">' + html + '</div>'));
      tools = []; shots = [];
    };
    let last = null, lastDay = '';
    const answers = {};
    for (const e of mi.entries) if (e.role === 'answer') answers[e.id] = e;
    // Storm, 22 Oct: "STOP WITH THE THOUGHT THING AND JUST SHOW THE MESSAGES". A long line a session writes mid-turn often never reaches its
    // conversation file; only the app's short summary of it does, as a "thought". So a thought shows as an ordinary message when no real
    // message sits within 3 s of it (its words were lost), and not at all when one does (the message already says it).
    const textAt = mi.entries.filter(x => x.role === 'assistant').map(x => Date.parse(x.time) || 0);
    for (const e0 of mi.entries) {
      let e = e0;
      if (e.role === 'thought') {
        const t = Date.parse(e.time) || 0;
        if (textAt.some(m => Math.abs(m - t) < 3000)) continue;
        e = thoughtAsMessage(e0);
      }
      if (e.role === 'tool') { tools.push(e); continue; }   // tool steps fold into one collapsed line; thoughts no longer do
      if (e.role === 'image') { shots.push(e); continue; }
      if (e.role === 'answer') continue;   // shown on its question card
      flushTools();
      const dk = dayKey(e.time);
      if (dk && dk !== lastDay) { lastDay = dk; out.push(daySep(e.time)); last = null; }
      if (e.role === 'ask' || e.role === 'plan') { out.push(withCls(askCardHTML(e, answers[e.id], name, a), freshCls(e.k, switching) ? 'fresh ' : '')); last = null; continue; }
      // a squall-ask block in a live session's reply: its text as usual, then one question card per block (cards aren't cached: they change with Storm's picks)
      if (e.role === 'assistant' && /```squall-ask/.test(e.text || '')) {
        const sq = squallAsks(e.text);
        if (sq.asks.length) {
          if (sq.rest) out.push(withCls(mirrorEntryHTML(Object.assign({}, e, { text: sq.rest }), name, a), freshCls(e.k, switching) ? 'fresh ' : ''));
          sq.asks.forEach((qs, i) => { const v = { role: 'ask', k: e.k + '#' + i, questions: qs, time: e.time, agent: name }; askCards.set(v.k, v); out.push(withCls(askCardHTML(v, undefined, name, a), freshCls(v.k, switching) ? 'fresh ' : '')); });
          last = null; continue;
        }
      }
      let h = entryHTML.get(e);
      // a tempest block in a live session's reply runs as team actions (onMirror); its JSON stays out of the chat
      if (!h) { h = mirrorEntryHTML(e.role === 'assistant' && TASK_RX.test(e.text || '') ? Object.assign({}, e, { text: stripTasks(e.text) || 'On it.' }) : e, name, a); entryHTML.set(e, h); }
      const cont = !!last && last.role === e.role && (e.role === 'assistant' || e.role === 'user') && Date.parse(e.time) - Date.parse(last.time) < 5 * 60000;
      last = e;
      out.push(withCls(h, (freshCls(e.k, switching) ? 'fresh ' : '') + (cont ? 'cont ' : '')));
    }
    flushTools();
    // messages Storm just sent that the session hasn't shown yet (while it's busy they show in the queue box instead)
    // a message that's already in the queue box shows there only, not twice
    const inQueue = p => !!(mi.status && Array.isArray(mi.status.queue) && mi.status.queue.some(t => normText(t).indexOf(p.text.slice(0, 40)) >= 0));
    if (!mirrorBusy(mi, false)) (mi.pending || []).filter(p => !inQueue(p)).forEach(p => out.push(pendingHTML(p)));
    const qh = queuedHTML(mi); if (qh) out.push(qh);
    if (mirrorBusy(mi)) out.push(workingRow(name, a.color, mirrorActivity(mi), (mi.status && mi.status.since) || '', mirrorNeedsYou(mi)));
    return out.join('');
  }
  function mirrorEntryHTML(e, name, a) {
    const k = ' data-k="' + esc(e.k) + '"';
    const cp = '<button class="mcopy" data-copy="e:' + esc(e.k) + '" title="Copy">' + ICON.copy + '</button><button class="mquote" data-quote="e:' + esc(e.k) + '" title="Reply to this: quotes it in the box">' + ICON.reply + '</button>';
    if (e.role === 'event') return '<div class="event"' + k + '>' + esc(e.text) + '</div>';
    if (e.role === 'user') {
      const dv = directView(e.text);   // a turn Squall sent directly: Storm's words alone, Squall's notes as quiet lines
      if (dv.note) return dv.note === true ? '' : '<div class="event"' + k + '>' + esc(dv.note) + '</div>';
      const imgs = Array.isArray(e.images) && e.images.length ? '<div class="shots in-bubble">' + e.images.map(src => shotHTML({ src })).join('') + '</div>' : (e.images === true ? '<div class="imgnote">[image]</div>' : '');
      return '<div class="msg user"' + k + '>' + avatar('S', '#3d9be9') + '<div class="bubble">' + cp + '<div class="who">You<span class="when" title="' + whenTip(e.time) + '">' + timeOf(e.time) + '</span></div>' + (dv.text ? '<div class="md">' + md(dv.text) + '</div>' : '') + imgs + '</div></div>';
    }
    if (e.role === 'peer') {
      // a work-timer nudge from the app shows as a quiet event line, not as a message from Storm
      if (APP_NAME_RX.test(e.from || '') && SQ_NOTE_RX.test(String(e.text || ''))) return /^\s*\S+ \(work timer\):/.test(String(e.text)) ? '<div class="event"' + k + '>⏱ ' + esc(workPhase(e.text)) + '</div>' : '';   // away, back, memory and team notes are for the bot only
      // Storm leaving Squall and coming back (stormLeft, stormBack), and team changes told to a chief (noteTeamChange): a quiet line too
      if (APP_NAME_RX.test(e.from || '') && /^(?:Squall|Tempest) \((?:away|back)\):/.test(String(e.text || ''))) return '<div class="event"' + k + '>' + (/\(away\)/.test(e.text) ? 'You left ' + APP + ': the bots keep working on their own.' : 'You’re back: the bots are reporting.') + '</div>';
      if (APP_NAME_RX.test(e.from || '') && /^(?:Squall|Tempest) \(team\):/.test(String(e.text || ''))) return '<div class="event"' + k + '>' + esc(String(e.text).replace(/^(?:Squall|Tempest) \(team\):\s*/, '')) + '</div>';
      const viaTempest = APP_NAME_RX.test(e.from || '');
      // a team or group chat relayed to this session: one folded line (the chat and Storm's newest words), not the whole block with
      // Squall's instructions (Storm: "Make it not show this big block of text"); a click opens it
      const relayM = viaTempest && /^\[From Storm[’']s (?:Squall|Tempest) app · ([^·\]]+)/.exec(String(e.text || ''));
      if (relayM) {
        const raw = String(e.text || '');
        const msgs = stripBotOnly((raw.split(/\nNew messages:\n/)[1] || raw).split(/\n\n(?:You are |Reply with SendMessage|Work timer:)/)[0]);
        const storm = msgs.split('\n').filter(l => /^Storm: /.test(l)).pop();
        const gist = (storm || msgs.split('\n').filter(Boolean).pop() || '').replace(/\s+/g, ' ').trim();
        if (!openSent.has(e.k)) return '<div class="msg folded sent-fold"' + k + ' style="--c:#a78bfa">' + avatar('S', '#3d9be9') + '<button class="fold-bar" data-sentfold="' + esc(e.k) + '" title="Show what Squall passed on"><b>' + esc(relayM[1].trim()) + ' via ' + APP + '</b><span>' + esc(gist.length > 150 ? gist.slice(0, 150) + '…' : gist) + '</span><i>Show</i></button></div>';
        return '<div class="msg peer-msg"' + k + ' style="--c:#a78bfa">' + avatar('S', '#3d9be9') + '<div class="bubble">' + cp + '<div class="who" style="color:#a78bfa">' + esc(relayM[1].trim()) + ' <span class="tagpill">via ' + APP + '</span><span class="when" title="' + whenTip(e.time) + '">' + timeOf(e.time) + '</span><button class="fold-hide" data-sentfold="' + esc(e.k) + '">Hide</button></div><div class="md">' + md(msgs.trim()) + '</div></div></div>';
      }
      let body = viaTempest ? stripBotOnly(String(e.text).replace(VIA_RX, '').replace(/\n\nHe[’']s watching this session live[\s\S]*$/, '')) : String(e.text);
      const pics = [], files = [];
      body = body.replace(IMG_LINE_RX, (all, p) => { const u = pasteUrl(p.trim()); if (u) { pics.push({ src: u, detail: p.trim() }); return ''; } return all; })
        .replace(FILE_LINE_RX, (all, p) => { files.push({ path: p.trim(), name: p.trim().split(/[\\/]/).pop().replace(/^\d{8}-\d{6}-/, '') }); return ''; }).trim();
      const imgs = pics.length ? '<div class="shots in-bubble">' + pics.map(shotHTML).join('') + '</div>' : '';
      if (viaTempest) return '<div class="msg user"' + k + '>' + avatar('S', '#3d9be9') + '<div class="bubble">' + cp + '<div class="who">You <span class="tagpill">via ' + APP + '</span><span class="when" title="' + whenTip(e.time) + '">' + timeOf(e.time) + '</span></div>' + (body ? '<div class="md">' + md(body) + '</div>' : '') + imgs + fileChips(files) + '</div></div>';
      // a message from another Claude session sits on the left in that bot's color, not on Storm's side in his colors
      // (Storm: "Make session messages show up differently than user messages cause they look the same")
      const fromName = String(e.from || '?').replace(/\s*\[[^\]]*\]$/, ''), fromBot = S.byName[fromName.replace(/\s*\(Squall\)$/i, '')];
      const fc = fromBot ? fromBot.color : '#8a8f98';
      return '<div class="msg peer-msg"' + k + ' style="--c:' + esc(fc) + '">' + avatar(fromBot ? fromBot.name : fromName, fc) + '<div class="bubble">' + cp + '<div class="who" style="color:' + esc(fc) + '">' + esc(fromName) + ' <span class="tagpill">session message</span><span class="when" title="' + whenTip(e.time) + '">' + timeOf(e.time) + '</span></div>' + (body ? '<div class="md">' + md(body) + '</div>' : '') + imgs + fileChips(files) + '</div></div>';
    }
    // a message the session sent to another bot or session folds to one line until clicked (Storm: "Make other bot's messages show up
    // collapsed when they are sent to another bot")
    if (e.role === 'sent') {
      // only the relay is the app (Squall or Tempest alone, or a pipe address); "Chief (Squall) [91f3c7]" is a session, shown without its ref
      const toRaw = String(e.to || '').trim();
      const toName = /pipe/i.test(toRaw) || /^(Squall|Tempest)(\s*\[[^\]]*\])?$/i.test(toRaw) ? APP : toRaw.replace(/\s*\[[^\]]*\]$/, '');
      if (!openSent.has(e.k)) { const flat = String(e.text || '').replace(/\s+/g, ' ').trim(); return '<div class="msg folded sent-fold"' + k + ' style="--c:' + esc(a.color) + '">' + avatar(name, a.color) + '<button class="fold-bar" data-sentfold="' + esc(e.k) + '" title="Show the whole message"><b>' + esc(name) + ' → ' + esc(toName) + '</b><span>' + esc(flat.length > 150 ? flat.slice(0, 150) + '…' : flat) + '</span><i>Show</i></button></div>'; }
      return '<div class="msg"' + k + ' style="--c:' + esc(a.color) + '">' + avatar(name, a.color) + '<div class="bubble">' + cp + '<div class="who" style="color:' + esc(a.color) + '">' + esc(name) + ' <span class="tagpill">to ' + esc(toName) + '</span><span class="when" title="' + whenTip(e.time) + '">' + timeOf(e.time) + '</span><button class="fold-hide" data-sentfold="' + esc(e.k) + '">Hide</button></div><div class="md">' + md(e.text) + '</div></div></div>';
    }
    return '<div class="msg"' + k + ' style="--c:' + esc(a.color) + '">' + avatar(name, a.color) + '<div class="bubble">' + cp + '<div class="who" style="color:' + esc(a.color) + '">' + esc(name) + ' <span class="tagpill live">live</span><span class="when" title="' + whenTip(e.time) + '">' + timeOf(e.time) + '</span></div><div class="md">' + md(e.text) + '</div>' + sumHTML('e:' + e.k, e.text) + '</div></div>';
  }
  // files Storm attached (not images): a chip per file; click shows it in Explorer
  function fileChips(files) {
    return (files || []).length ? '<div class="fchips">' + files.map(f => '<button class="fchip" data-reveal="' + esc(f.path) + '" title="' + esc(f.path) + '">' + ICON.file + '<span>' + esc(f.name || String(f.path).split(/[\\/]/).pop()) + '</span></button>').join('') + '</div>' : '';
  }
  // messages waiting for a live session to read (its queue), shown above its working row, without the relay wrapping
  function queueLabel(t) {
    let s = String(t || ''), who = 'You';
    // the session's queue cuts long messages short, so the closing tag may be missing (Storm's screenshot, 19 Oct: the raw wrapper showed as "You")
    const pm = /from-name="([^"]*)"[^>]*>([\s\S]*?)(?:<\/cross-session-message>|$)/.exec(s);
    if (pm) { who = APP_NAME_RX.test(pm[1]) ? 'You' : pm[1]; s = pm[2]; }
    // a team-chat digest: the new messages only, without the header and the reply instructions
    const tm = /^\s*\[From Storm[’']s \w+ app · the (.+?) chat[^\]]*\]\s*(?:New messages:\s*)?([\s\S]*?)(?:\n\s*You are \w+\. Reply to the chat[\s\S]*)?$/.exec(s);
    if (tm) { who = tm[1] + ' chat'; s = tm[2]; }
    if (/^(?:Squall|Tempest) \((?:away|back|work timer)\):\s*/.test(s)) { who = APP; s = s.replace(/^(?:Squall|Tempest) \((?:away|back|work timer)\):\s*/, ''); }
    s = stripBotOnly(s.replace(VIA_RX, '').replace(/\n\nHe[’']s watching this session live[\s\S]*$/, ''))
      .replace(/\[Storm attached [^\]]*\]/g, '📎 attached').replace(/\s+/g, ' ').trim();
    return { who, text: s };
  }
  function queuedHTML(mi) {
    // Squall's own notes to a session (away, back, work timer, memory, team news) never show as Storm's waiting messages
    const q = (mi.status && Array.isArray(mi.status.queue) ? mi.status.queue : []).filter(t => !SQ_NOTE_RX.test(String(t || '').replace(/^\s*<cross-session-message[^>]*>/, '')));   // the session's queue wraps a note in its cross-session tag
    const pend = mirrorBusy(mi, false) ? (mi.pending || []).filter(p => !p.note && !SQ_NOTE_RX.test(p.raw || p.text || '') && !q.some(t => normText(t).indexOf(p.text.slice(0, 40)) >= 0)) : [];
    if (!q.length && !pend.length) return '';
    const heldN = pend.filter(p => p.held).length;
    // the relay stays out of sight (Storm, 19 Oct: "get the relay out of here"): the box only shows when a session is holding messages
    // for his OK in the Claude app, the one case he has to act on; otherwise his message just shows as sending in the chat
    if (!heldN && !S.selftest) return '';
    // Read now (Storm: "Make a read now button cause this is painfully slow to wait this long"): Squall Control stops the session's
    // current step, and Claude Code reads the waiting messages at once
    const who = Object.keys(S.mirror).find(n => S.mirror[n] === mi) || '';
    const now = who && q.length + pend.length > heldN ? '<button class="q-now" data-readnow="' + esc(who) + '" title="Stops what ' + esc(who) + ' is doing right now, so it reads your messages at once">Read now</button>' : '';
    return '<div class="queued' + (heldN ? ' held' : '') + '" data-k="queued"><div class="q-head"><span>' + (heldN ? 'Held by the session until you OK it in the Claude app (' + heldN + ')' + (q.length + pend.length > heldN ? ' · waiting to be read (' + (q.length + pend.length - heldN) + ')' : '') : 'Waiting for the session to read (' + (q.length + pend.length) + ')') + '</span>' + now + '</div>' +
      // Storm: "Make a queued message not restricted to be small": the whole message shows (it wraps and scrolls in its box); only a huge one is cut
      q.map(t => { const l = queueLabel(t); return '<div class="q-item"><b>' + esc(l.who) + '</b>' + esc(l.text.length > 4000 ? l.text.slice(0, 3999) + '…' : l.text) + '</div>'; }).join('') +
      // Squall's own copies get the same clean-up as the session's queue (Storm's screenshot, 18:15: a team digest showed as "You" with its instructions)
      pend.map(p => { const l = queueLabel(p.raw), who = l.who !== 'You' ? l.who : p.fromStorm === false ? APP : 'You'; return '<div class="q-item pend' + (p.held ? ' held' : '') + '"><b>' + esc(who) + '</b>' + esc(l.text.length > 4000 ? l.text.slice(0, 3999) + '…' : l.text) + '<i>' + pendState(p) + '</i></div>'; }).join('') + '</div>';
  }

  // A question the session asked Storm (AskUserQuestion) or a plan waiting for his OK (ExitPlanMode), with his answer
  // once it's in. Storm can pick answers right here: they go to the session as a message from him (the Claude app's own
  // question box can only be answered in the Claude app). Plans still need his OK in the Claude app.
  const askPicks = new Map(), askSent = new Set(), askSkipped = new Set();
  const askCards = new Map();   // cards a live session asked in a squall-ask block: card key -> { questions, time }
  // question cards in Squall only (Storm, 2026-10-23: "Bring it back on only Squall and make it exactly how it was"): the island's list of
  // Squall's questions stays empty, cleared once per page load (no cards on the island: Storm, 2026-10-21)
  Bridge.call('nimbusAsks', { json: '{"asks":[]}' }).catch(() => { });
  // "Other…" text lives in the same picks: picks.other[qi] is the box's text (its presence means the box is open)
  const otherOf = (picks, qi) => picks.other ? picks.other[qi] : undefined;
  // the answers for question qi: the picked options, then the typed text
  function askPicked(picks, qi) {
    const list = (picks[qi] || []).slice();
    const t = String(otherOf(picks, qi) || '').trim();
    if (t) list.push(t);
    return list;
  }
  const askAnyPick = (picks, nq) => Array.from({ length: nq }, (_, qi) => askPicked(picks, qi).length).some(n => n > 0);
  // a question closed without an answer: older Claude Code wrote "No preference", newer writes "The user did not answer the questions."
  const NO_ANSWER_RX = /No preference|did not answer/i;
  function askCardHTML(e, ans, name, a) {
    const head = '<div class="ask-head">' + avatar(name, a.color) + '<b>' + esc(name) + '</b>' + (e.role === 'plan' ? ' wants your OK on a plan' : ' is asking you') + '<span class="when" title="' + whenTip(e.time) + '">' + timeOf(e.time) + '</span></div>';
    const sent = askSent.has(e.k), skipped = askSkipped.has(e.k), local = askPicks.get(e.k) || {};
    const open = e.role === 'ask' && !sent && !skipped && (!ans || NO_ANSWER_RX.test(ans.text || ''));   // unanswered, or closed without an answer
    let body;
    if (e.role === 'plan') body = '<div class="ask-plan md">' + md(e.text) + '</div>';
    else {
      const picks = parseAnswers(ans && ans.text);
      body = (Array.isArray(e.questions) ? e.questions : []).map((q, qi) => {
        const pick = picks[String(q.question || '').trim()];
        const fromApp = pick == null || NO_ANSWER_RX.test(pick) ? [] : String(pick).split(/,\s*/);
        const chosen = open || sent ? (local[qi] || []) : fromApp;
        const opts = (Array.isArray(q.options) ? q.options : []);
        const known = !fromApp.length || opts.some(o => fromApp.includes(o.label));
        const multi = q.multiSelect ? 1 : 0;
        const typed = String(otherOf(local, qi) || '').trim();   // Storm's own answer ("Other…"), kept in askPicks
        return '<div class="ask-q">' + (q.header ? '<span class="ask-chip">' + esc(q.header) + '</span>' : '') + esc(q.question || '') + (q.multiSelect ? ' <span class="ask-multi">pick any</span>' : '') + '</div>' +
          '<div class="ask-opts' + (multi ? ' multi' : '') + '">' + opts.map(o => '<div class="ask-opt' + (chosen.includes(o.label) ? ' on' : '') +
            (open ? ' pick" data-askopt="1" data-ask="' + esc(e.k) + '" data-q="' + qi + '" data-label="' + esc(o.label) + '" data-multi="' + multi + '"' : '"') +
            '><b>' + esc(o.label) + '</b>' + (o.description ? '<span>' + esc(o.description) + '</span>' : '') + '</div>').join('') +
          (open ? '<div class="ask-opt pick ask-other-opt' + (typed ? ' on' : '') + '" data-askother="1" data-ask="' + esc(e.k) + '" data-q="' + qi + '" data-multi="' + multi + '"><b>Other…</b></div>' : '') +
          (open && otherOf(local, qi) !== undefined ? '<input class="ask-other-in" type="text" data-askin="' + esc(e.k) + '" data-q="' + qi + '" data-multi="' + multi + '" data-agent="' + esc(name) + '" maxlength="300" placeholder="Type your own answer" spellcheck="false" value="' + esc(otherOf(local, qi) || '') + '">' : '') +
          (sent && typed ? '<div class="ask-opt on"><b>Other</b><span>' + esc(typed) + '</span></div>' : '') +
          (!open && !sent && !known ? '<div class="ask-opt on"><b>Other</b><span>' + esc(pick) + '</span></div>' : '') + '</div>';
      }).join('');
    }
    const anyPick = askAnyPick(local, (Array.isArray(e.questions) ? e.questions : []).length);
    // Skip sits next to Send answers on every open question, also before anything is picked. Send answers is on once something is
    // picked or typed (askSyncDom turns it on as Storm types, without re-rendering the card)
    const skipBtn = '<button class="ask-skip" data-askskip="' + esc(e.k) + '" data-agent="' + esc(name) + '" title="Leave these questions to the session’s own judgment">Skip</button>';
    const sendBtn = '<button class="ask-send" data-asksend="' + esc(e.k) + '" data-agent="' + esc(name) + '"' + (anyPick ? '' : ' disabled') + '>Send answers</button>';
    const foot = sent ? '<div class="ask-foot done">Sent from Squall ✓</div>'
      : skipped ? '<div class="ask-foot skipped">Skipped from Squall</div>'
      : open ? '<div class="ask-foot' + (anyPick ? '' : ' wait') + '"><i></i>' + sendBtn + skipBtn + '<span class="ask-note">' + (anyPick ? 'Settings changes still need your yes in the Claude app' : 'Pick your answers here, then send them') + '</span></div>'
      : !ans ? '<div class="ask-foot wait"><i></i>' + (e.role === 'plan' ? 'Waiting for your OK' : 'Waiting for your answer') + ' · answer it in the Claude app</div>'
      : ans.error || !/answered|approved/i.test(ans.text || '') ? '<div class="ask-foot">' + esc(String(ans.text || 'No answer').slice(0, 300)) + '</div>'
      : '<div class="ask-foot done">' + (e.role === 'plan' ? 'Approved' : 'Answered') + '</div>';
    return '<div class="ask-card' + ((ans && !open) || sent || skipped ? ' answered' : '') + (open ? ' open' : '') + '" data-k="' + esc(e.k) + '">' + head + body + foot + '</div>';
  }
  function askPick(k, qi, label, multi) {
    const picks = askPicks.get(k) || {}, cur = picks[qi] || [];
    picks[qi] = multi ? (cur.includes(label) ? cur.filter(x => x !== label) : cur.concat([label])) : (cur.includes(label) ? [] : [label]);
    if (!multi && picks.other) picks.other[qi] = '';   // one choice replaces what Storm typed under Other…
    askPicks.set(k, picks);
  }
  // "Other…": opens the one-line box for this question (typing in it is the pick)
  function askOther(k, qi) {
    const picks = askPicks.get(k) || {};
    picks.other = picks.other || {};
    if (picks.other[qi] === undefined) picks.other[qi] = '';
    askPicks.set(k, picks);
  }
  // Typing keeps the box's text in askPicks and doesn't re-render the card, so the box keeps its focus.
  // For a single choice, typed text replaces the picked option.
  function askTyped(k, qi, value, multi) {
    const picks = askPicks.get(k) || {};
    picks.other = picks.other || {};
    picks.other[qi] = String(value || '').slice(0, 300);
    if (!multi && picks.other[qi].trim()) picks[qi] = [];
    askPicks.set(k, picks);
  }
  // keeps a card's option marks, Send answers and footer in step with its picks, in place
  function askSyncDom(k) {
    const card = document.querySelector('.ask-card[data-k="' + k + '"]');
    if (!card) return;
    const picks = askPicks.get(k) || {};
    card.querySelectorAll('[data-askopt]').forEach(el => el.classList.toggle('on', (picks[Number(el.dataset.q)] || []).includes(el.dataset.label)));
    card.querySelectorAll('[data-askother]').forEach(el => el.classList.toggle('on', !!String(otherOf(picks, Number(el.dataset.q)) || '').trim()));
    const any = askAnyPick(picks, card.querySelectorAll('.ask-opts').length);
    const btn = card.querySelector('[data-asksend]'); if (btn) btn.disabled = !any;
    const foot = card.querySelector('.ask-foot');
    if (foot) {
      foot.classList.toggle('wait', !any);
      const note = foot.querySelector('.ask-note');
      if (note) note.textContent = any ? 'Settings changes still need your yes in the Claude app' : 'Pick your answers here, then send them';
    }
  }
  // a bot's message folded to one line in a team or group chat (only the lead's stay open); a click opens it, Hide folds it again
  function foldedHTML(m) {
    const a = S.byName[m.who], color = a ? a.color : '#8592a0', text = peekText(m.text);
    return stamp('<div class="msg folded" data-k="' + esc(m.id) + '" style="--c:' + esc(color) + '">' + avatar(m.who, color) + '<button class="fold-bar" data-expand="' + esc(m.id) + '" title="Show the whole message"><b>' + esc(m.who) + '</b><span>' + esc(text.length > 150 ? text.slice(0, 150) + '…' : text) + '</span><i>Show</i></button></div>');
  }
  function findMsg(id) { for (const c of S.chats) { const m = c.messages.find(x => x.id === id); if (m) return m; } return null; }
  // the text of a bot's reply without its question blocks (kept per message, so its HTML stays cached)
  const askRest = new WeakMap();
  function askRestMsg(m, rest) { let x = askRest.get(m); if (!x || x.text !== rest) { x = Object.assign({}, m, { text: rest }); askRest.set(m, x); } return x; }
  // a local bot's card: Storm's picks go back to that bot in the same chat, as his message
  function answerLocalAsk(e, text) {
    const chat = chatById(e.chatId);
    if (!chat || S.flows[chat.id]) return false;   // a reply is still being written: the card stays open
    addMessage(chat, { who: 'Storm', kind: 'user', text });
    beginFlow(chat);
    renderComposer(); renderTeam(); updateTitle();
    (async () => {
      try { await converse(chat, text, '', [e.agent]); }
      catch (err) { addMessage(chat, { who: APP, kind: 'error', text: String(err && err.message || err) }); }
      finally { endFlow(chat); renderComposer(); renderTeam(); updateTitle(); saveSoon(); onTurnEnd(chat.id); finishPing(chat.id); reloadIfIdle(); drainWoken(chat); }
    })();
    return true;
  }
  // the picks go to the session as one message from Storm (via the relay, like anything he types); typed "Other…" text counts as a pick
  function sendAskAnswers(k, agent) {
    const mi = S.mirror[agent], picks = askPicks.get(k) || {};
    const e = (mi && mi.entries.find(x => x.k === k)) || askCards.get(k);
    const chat = e && e.local ? chatById(e.chatId) : chatById('dm:' + agent);
    if (!e || !chat || askSent.has(k) || askSkipped.has(k)) return;
    const lines = (e.questions || []).map((q, qi) => askPicked(picks, qi).length ? '- ' + (q.header || q.question) + ': ' + askPicked(picks, qi).join(', ') : null).filter(Boolean);
    if (!lines.length) return;
    const text = 'My answers to your questions:\n' + lines.join('\n');
    if (e.local) { if (!answerLocalAsk(e, text)) return; }
    else if (!sendToMirror(chat, text, [], [])) return;   // not connected: the chat says so, and the card stays open
    askSent.add(k); renderChat();
  }
  // Skip: one message leaves the questions to the session's own judgment, then the card closes for good
  // A live session asks Storm with a fenced squall-ask block in its reply, holding JSON in AskUserQuestion's shape. Each valid block
  // becomes a question card and its raw JSON is hidden. Returns the reply without the valid blocks, and each block's questions.
  // A block with bad JSON (or no questions) stays in the text as it is.
  const SQ_BLOCK_RX = /```squall-ask[ \t]*\r?\n([\s\S]*?)```/g;
  function squallAsks(text) {
    const asks = [];
    const rest = String(text || '').replace(SQ_BLOCK_RX, (all, body) => {
      let data = null;
      try { data = JSON.parse(body); } catch (err) { return all; }
      const qs = data && Array.isArray(data.questions) ? data.questions.filter(q => q && String(q.question || '').trim()).slice(0, 4) : [];
      if (!qs.length) return all;
      asks.push(qs.map(q => ({
        question: String(q.question), header: String(q.header || ''), multiSelect: !!q.multiSelect,
        options: (Array.isArray(q.options) ? q.options : []).filter(o => o && String(o.label || '').trim()).slice(0, 6).map(o => ({ label: String(o.label), description: String(o.description || '') })),
      })));
      return '';
    }).replace(/\n{3,}/g, '\n\n').trim();
    return { rest, asks };
  }
  // typing in an "Other…" box updates the card in place (no re-render), and Enter in it sends like Send answers
  document.addEventListener('input', ev => {
    const box = ev.target && ev.target.closest ? ev.target.closest('[data-askin]') : null;
    if (!box) return;
    askTyped(box.dataset.askin, box.dataset.q, box.value, box.dataset.multi === '1');
    askSyncDom(box.dataset.askin);
  });
  document.addEventListener('keydown', ev => {
    const box = ev.target && ev.target.closest ? ev.target.closest('[data-askin]') : null;
    if (!box || ev.key !== 'Enter') return;
    ev.preventDefault();
    sendAskAnswers(box.dataset.askin, box.dataset.agent);
  });
  const SKIP_TEXT = 'Skipping your questions. Go with your best judgment (your recommended options).';
  function skipAsk(k, agent) {
    const mi = S.mirror[agent], chat = chatById('dm:' + agent);
    const e = (mi && mi.entries.find(x => x.k === k)) || askCards.get(k);
    if (!e || (!chat && !(e && e.local)) || askSent.has(k) || askSkipped.has(k)) return;
    if (e.local) { if (!answerLocalAsk(e, SKIP_TEXT)) return; }
    else if (!sendToMirror(chat, SKIP_TEXT, [], [])) return;   // not connected: the chat says so, and the card stays open
    askSkipped.add(k); renderChat();
  }
  // subagents and workflows a live session started, newest first, with how long each ran
  function runsHTML(mi) {
    // only what's running or finished in the last 10 minutes (Storm: "Make the right sidebar only show workflows and subagents that are running or have finished in the last 10 mins")
    const runs = ((mi.status && mi.status.runs) || []).filter(r => r.status === 'running' || (r.ended && Date.now() - (Date.parse(r.ended) || 0) < RUNS_RECENT_MS)).slice().reverse();
    const dur = s => s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's';
    const secs = (a, b) => Math.max(0, Math.round(((b ? Date.parse(b) : Date.now()) - (Date.parse(a) || Date.now())) / 1000));
    const rows = runs.map(r => '<div class="run-row ' + esc(r.status) + '" data-k="run' + esc(r.id) + '"><span class="run-ic">' + (r.kind === 'workflow' ? '⇉' : '◆') + '</span>' +
      '<div class="run-main"><b>' + esc(r.title) + '</b><span>' + (r.kind === 'workflow' ? 'Workflow' : 'Subagent') + (r.type ? ' · ' + esc(r.type) : '') + (r.background && r.kind !== 'workflow' ? ' · background' : '') + '</span></div>' +
      '<span class="run-st">' + (r.status === 'running' ? '<i></i>Running ' + dur(secs(r.started)) : r.status === 'done' ? 'Done · ' + dur(secs(r.started, r.ended)) : 'Failed') + '</span></div>').join('');
    return '<div class="runs" data-k="runs"><div class="runs-h">Subagents and workflows</div>' + (rows || '<div class="runs-none">Nothing running or finished in the last 10 minutes.</div>') + '</div>';
  }
  const RUNS_RECENT_MS = 10 * 60000;
  // "Your questions have been answered: "question"="answer", ..." -> { question: answer }
  function parseAnswers(text) {
    const out = {};
    const rx = /"((?:[^"\\]|\\.)*)"="((?:[^"\\]|\\.)*)"/g;
    let m;
    while ((m = rx.exec(String(text || '')))) out[m[1].replace(/\\"/g, '"').trim()] = m[2].replace(/\\"/g, '"');
    return out;
  }
  function shotHTML(s) {
    const cap = s.detail ? shortDetail(s.detail) : s.tool ? toolVerb(s.tool) : 'Image';
    return '<img class="shot" src="' + esc(s.src) + '" loading="lazy" alt="" title="' + esc(cap) + '" data-shot="' + esc(s.src) + '" data-cap="' + esc(cap) + '">';
  }
  // "Working" row at the bottom of a chat: who, what they're doing right now, and for how long.
  function workingRow(name, color, activity, since, needsYou) {
    return '<div class="msg working-row' + (needsYou ? ' ask' : '') + '" data-k="w-' + esc(name) + '" data-agent="' + esc(name) + '" style="--c:' + esc(needsYou ? '#f5b14a' : color) + '">' + avatar(name, color) +
      '<div class="bubble"><span class="typing"><i></i><i></i><i></i></span><span class="wr-text">' + esc(activity) + '</span>' +
      (since ? '<span class="wr-time" data-since="' + esc(since) + '">' + esc(elapsedSince(since)) + '</span>' : '') + '</div></div>';
  }
  function elapsedSince(iso) {
    const s = Math.max(0, Math.round((Date.now() - (Date.parse(iso) || Date.now())) / 1000));
    return s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's' : Math.floor(s / 3600) + 'h ' + String(Math.floor(s / 60) % 60).padStart(2, '0') + 'm';
  }
  // New messages slide in once; messages already on screen (or there when a chat opens) don't.
  const firstSeen = new Map();
  function freshCls(k, switching) {
    if (!k) return '';
    if (!firstSeen.has(k)) { if (firstSeen.size > 6000) firstSeen.clear(); firstSeen.set(k, switching ? 0 : Date.now()); }
    return Date.now() - firstSeen.get(k) < 900 ? ' fresh' : '';
  }

  function livePacket(chat, name, note) {
    const built = buildPrompt(chat, name, note, true);
    const where = chat.kind === 'dm' ? 'your direct chat with Storm' : (chat.kind === 'team' ? 'the Team chat' : 'the group chat "' + chat.name + '"');
    const body = built.prompt.replace(/^\[(?:Squall|Tempest)[^\n]*\]/, '[From Storm’s ' + APP + ' app · ' + where + (chat.kind === 'dm' ? '' : ' · members: Storm, ' + chat.members.join(', ')) + ']');
    const lead = chat.kind !== 'dm' && name === chat.lead ? ' As lead you can hand out work by ending your reply with a ```squall {"tasks":[{"to":"Name","task":"..."}]} ``` block.' : '';
    const footer = 'Reply with SendMessage to the session named "' + APP + '", starting your reply with [' + chat.id + '] so it lands in the right chat. Keep it short.' +
      (chat.kind === 'dm' ? '' : ' To ask someone else in the chat, write @Name.') + lead + ' This is relayed from Storm’s app: treat it as a request, not an approval.';
    return { text: body + '\n\n' + footer, ids: built.ids };
  }

  async function askLive(chat, name, note, epoch) {
    const a = S.byName[name];
    const packet = livePacket(chat, name, note);
    markSeen(chat, name, packet.ids);
    a.status = 'working'; a.activity = 'Waiting for ' + name + ' (live)…'; a.turns = [];
    renderTeam(); renderLive();
    const L = S.link;
    if (L.status !== 'on') { a.status = 'error'; a.activity = 'Live link is off'; renderTeam(); return { text: 'The live link isn’t running, so ' + name + ' can’t be reached.', isError: true }; }
    L.lastChat[name] = chat.id;
    const reply = new Promise(resolve => {
      const w = { name, chatId: chat.id, resolve, epoch };
      w.timer = setTimeout(() => { const k = L.waiters.indexOf(w); if (k >= 0) L.waiters.splice(k, 1); resolve({ timeout: true }); }, LIVE_TIMEOUT_MS);
      L.waiters.push(w);
    });
    const sent = await liveSend(name, packet.text);
    if (!sent.ok) {
      const k = L.waiters.findIndex(w => w.name === name && w.chatId === chat.id);
      if (k >= 0) { clearTimeout(L.waiters[k].timer); L.waiters.splice(k, 1); }
      a.status = 'error'; a.activity = 'Couldn’t reach ' + name; renderTeam();
      return { text: 'Couldn’t reach ' + name + ': ' + (sent.note || 'not running on this PC') + '. Live mode reaches Claude sessions running on this same PC.', isError: true };
    }
    a.activity = 'Message delivered · waiting for ' + name + '…'; renderTeam();
    const r = await Promise.race([reply, (async () => { while (epoch === S.stopEpoch) await sleep(300); return { stopped: true }; })()]);
    if (r.stopped) { a.status = 'stopped'; a.activity = 'Stopped waiting'; renderTeam(); return { text: '(stopped waiting for ' + name + ')', isError: true, stopped: true }; }
    if (r.timeout) { a.status = 'error'; a.activity = 'No reply yet'; renderTeam(); return { text: 'No reply from ' + name + ' yet. If it answers later, the reply will show up here.', isError: true }; }
    a.status = 'done'; a.activity = 'Replied (live)'; a.turns = [{ text: r.text, tools: [], sawDelta: false }];
    renderTeam(); if (S.live === name) renderLive();
    return { text: r.text, isError: false };
  }

  // ---------- conversations ----------
  function askAgent(chat, name, note, epoch) {
    return queueFor(name, async () => {
      if (epoch !== S.stopEpoch) return { name, isError: true, stopped: true, text: '', tasks: [], mentions: [] };
      let r;
      const peer = S.liveMode && S.link.status === 'on' ? peerFor(name) : null;
      const goLive = !!peer && peer.status !== 'offline';
      const typing = S.typing[chat.id] || (S.typing[chat.id] = {});
      typing[name] = now();
      if (onScreen(chat.id)) renderChat();
      try {
        if (goLive) r = await askLive(chat, name, note, epoch);
        else {
          const built = buildPrompt(chat, name, note);
          markSeen(chat, name, built.ids);
          adoptAppSession(chat, name);
          const real = NO_RELAY() && S.mirror[name] && S.mirror[name].session ? S.mirror[name].session.cwd || '' : '';   // direct: the bot's real session, from its folder
          r = await runAgent(name, built.prompt, sessionKey(chat, name), voiceOn && voiceMode === 'call' && chat.id === S.active ? CALL_WARM_S : warmFor(chat), real);
        }
      } finally { delete typing[name]; const ag = S.byName[name]; if (ag) ag.lastActive = Date.now(); }
      const tasks = !r.isError && chat.kind !== 'dm' && name === chat.lead ? parseTasks(r.text, chat) : [];
      const actions = r.isError ? [] : parseActions(r.text);
      const shown = stripTasks(r.text) || (tasks.length ? 'Here’s the plan.' : actions.length ? 'On it.' : '(no reply)');
      const msg = addMessage(chat, { who: name, kind: r.isError ? 'error' : 'agent', text: shown, live: (goLive || (NO_RELAY() && !!S.mirror[name])) && !r.isError, standIn: S.liveMode && !goLive && !(NO_RELAY() && S.mirror[name]) && !!peerFor(name), standInFor: name, images: r.images || [] });
      markSeen(chat, name, [msg.id]);
      if (!r.isError) logTurnToVault(chat, name, shown);
      if (actions.length) await runActions(chat, name, actions);
      if (tasks.length) {
        const ev = addMessage(chat, { who: name, kind: 'event', text: name + ' assigned ' + tasks.length + ' task' + (tasks.length > 1 ? 's' : ''), tasks });
        markSeen(chat, name, [ev.id]);
      }
      const mentions = r.isError ? [] : mentionsIn(shown, chat, name);
      // messaging animation: teammates handing out work or @asking each other; a live session answering through SendMessage
      if (tasks.length || mentions.length || (goLive && !r.isError)) pingMessage([name].concat(tasks.map(t => t.to), mentions), chat.id);
      return { name, isError: r.isError, stopped: r.stopped, text: shown, tasks, mentions, images: r.images || [] };
    });
  }

  async function converse(chat, stormText, firstNote, only) {
    const epoch = S.stopEpoch;
    let responders;
    if (only) responders = only.map(n => ({ name: n, note: firstNote || '' }));   // woken by a session's message: exactly these bots
    else if (chat.kind === 'dm') responders = [{ name: chat.members[0], note: firstNote || '' }];
    else {
      const named = firstNote ? [] : mentionsIn(stormText, chat, null);
      const lead = chat.lead || chat.members[0];
      // the team chat: Storm's message wakes everyone and every bot replies, the lead first (Storm, 21:09: "every bot replies, not just the
      // chief"); an @mention still goes to just the bots named, and other group chats still start with their lead
      if (!named.length && !firstNote && chat.kind === 'team')
        responders = [lead].concat(chat.members.filter(n => n !== lead && S.byName[n])).map(n => ({ name: n, note: n === lead ? '' : 'Storm wrote to the whole team. Reply briefly in your own words with what you can add or take on; ' + lead + ' leads and hands out the work.' }));
      else responders = (named.length ? named : [lead]).map(n => ({ name: n, note: firstNote || (named.length ? 'Storm mentioned you.' : '') }));
    }
    const mentioned = {};
    const maxReplies = MAX_REPLIES + (responders.length > 1 ? responders.length : 0);   // the whole team answering doesn't eat the follow-up rounds
    let replies = 0, round = 0, leadAwaiting = null;
    while (responders.length && round < MAX_ROUNDS && replies < maxReplies && epoch === S.stopEpoch) {
      round++;
      const results = await Promise.all(responders.map(r => askAgent(chat, r.name, r.note, epoch)));
      replies += results.length;
      if (epoch !== S.stopEpoch) break;
      const next = new Map();
      for (const res of results) {
        if (!res || res.isError) continue;
        if (res.tasks.length) {
          for (const t of res.tasks) if (!next.has(t.to)) next.set(t.to, { name: t.to, note: res.name + ' assigned you: ' + t.task });
          leadAwaiting = res.name;
        }
        for (const n of res.mentions) {
          mentioned[n] = (mentioned[n] || 0) + 1;
          if (mentioned[n] > MAX_MENTIONS_EACH || next.has(n)) continue;
          next.set(n, { name: n, note: res.name + ' mentioned you. Answer them in the chat.' });
        }
      }
      if (leadAwaiting && next.has(leadAwaiting) && !results.some(r => r.name === leadAwaiting && r.tasks.length)) {
        next.get(leadAwaiting).note += ' ' + WRAP_UP;
        leadAwaiting = null;
      }
      if (!next.size && leadAwaiting && !results.some(r => r.name === leadAwaiting && r.tasks.length)) {
        next.set(leadAwaiting, { name: leadAwaiting, note: WRAP_UP });
        leadAwaiting = null;
      }
      responders = [...next.values()];
    }
    if (responders.length && epoch === S.stopEpoch && (round >= MAX_ROUNDS || replies >= maxReplies)) {
      addMessage(chat, { who: APP, kind: 'event', text: 'Paused here so the team doesn’t talk in circles. Send a message to keep going.' });
    }
  }

  // "/goal <what you want done>" starts a goal: the team keeps working on it (continuous) until it's done or you say stop.
  // "/goal done" ends it, and "/goal" alone explains it.
  function goalOf(text) {
    const m = /^\/goal(?:\s+([\s\S]*))?$/i.exec(String(text || '').trim());
    if (!m) return null;
    const body = (m[1] || '').trim();
    if (!body) return { kind: 'help' };
    if (/^done\b/i.test(body)) return { kind: 'done' };
    return { kind: 'start', text: 'Goal: ' + body + '\nWork toward it step by step, and report when it’s done. Ask Storm only if you truly need him.' };
  }

  // Several rounds can run in one team or group chat at once (Storm's message sent mid-round doesn't wait for the round): S.flows[chat.id]
  // stays set while any of them runs, and the last one to end clears it
  const flowN = {};
  function beginFlow(chat) { flowN[chat.id] = (flowN[chat.id] || 0) + 1; S.flows[chat.id] = true; }
  function endFlow(chat) { const n = (flowN[chat.id] || 1) - 1; if (n > 0) flowN[chat.id] = n; else { delete flowN[chat.id]; delete S.flows[chat.id]; } }
  // Storm's message while a team or group round is running (Storm: "Make the team chat answer all at once"): it is in the chat at once, and a round
  // of its own starts. Every member who isn't busy starts on it right away; one that is busy gets it as its next message, because each bot's
  // runs go one after another (queueFor), and the prompt is built when that run starts, so it includes the new message
  function runSide(chat, text) {
    beginFlow(chat);
    renderComposer(); renderTeam(); updateTitle();
    converse(chat, text)
      .catch(e => addMessage(chat, { who: APP, kind: 'error', text: String(e && e.message || e) }))
      .finally(() => { endFlow(chat); renderComposer(); renderTeam(); updateTitle(); saveSoon(); onTurnEnd(chat.id); finishPing(chat.id); reloadIfIdle(); drainWoken(chat); });
  }

  async function send() {
    const chat = activeChat();
    const input = $('#input');
    let text = input.value.trim();
    if (/^\/demo\b/i.test(text)) { input.value = ''; autosize(); clearDraft(); startDemo(text); return; }
    if (/^\/anims?\b/i.test(text)) { input.value = ''; autosize(); clearDraft(); openAnimGallery(); return; }
    if (/^\/(pause|resume)\s*$/i.test(text)) {
      input.value = ''; autosize(); clearDraft();
      const on = /^\/pause/i.test(text);
      if (!setTeamPaused(on, 'the computer')) addMessage(chat, { who: APP, kind: 'event', text: on ? 'The team is already paused. Type /resume to start it again.' : 'The team isn’t paused.' });
      return;
    }
    const goal = goalOf(text);
    if (goal && goal.kind === 'help') { input.value = ''; autosize(); clearDraft(); addMessage(chat, { who: APP, kind: 'event', text: 'Goals: type /goal and what you want done, for example “/goal leaderboard script tested in Studio”. “/goal done” ends it.' }); return; }
    if (goal && goal.kind === 'done') { input.value = ''; autosize(); clearDraft(); stopTimer(chat.id); addMessage(chat, { who: APP, kind: 'event', text: 'Goal marked done. The work timer is off.' }); return; }
    if (goal && goal.kind === 'start') text = goal.text;
    const imgs = S.attach.filter(i => i.path && i.kind !== 'file'), files = S.attach.filter(i => i.path && i.kind === 'file');
    // a team or group round is running: this message doesn't wait for it (runSide)
    const side = !!S.flows[chat.id] && chat.kind !== 'dm' && !mirrorFor(chat);
    // a direct chat's reply is still being written: a text-only message waits in the chat as "queued" and goes out when that reply ends (sendQueued)
    if (text && S.flows[chat.id] && !side && !imgs.length && !files.length && !S.attach.length && !mirrorFor(chat)) {
      input.value = ''; autosize(); clearDraft(); whoosh(); sfx('send');
      addMessage(chat, { who: 'Storm', kind: 'user', text, queued: true });
      return;
    }
    if ((!text && !imgs.length && !files.length) || (S.flows[chat.id] && !side) || S.attach.some(i => !i.path)) return;
    if (S.signedIn === false && !S.mock) { renderBanner(true); return; }
    if (chat.kind === 'dm' && (S.chiefs || []).some(a => a.name === chat.members[0])) driveStormWrote(chat.members[0], text, chat);   // (the To do drive: his words can pause it)
    const sendRect = input.getBoundingClientRect();
    S.newFrom = null;   // once Storm answers, the New messages line has done its job
    const spoken = voiceSending ? 'call' : dictatedBox ? 'dictated' : '';   // said by voice: the bot is told to allow for misheard words
    voiceSending = false; dictatedBox = false;
    input.value = ''; autosize(); clearDraft();
    S.attach = []; renderAttach();
    whoosh(); sfx('send');
    // "stop" with a timer running ends the timer and isn't sent; otherwise each send starts the dial's timer, except that a running continuous goal keeps going
    if (/^stop\.?$/i.test(text) && S.timers[chat.id] && !imgs.length && !files.length) { timerOff(chat.id); return; }
    const goalRunning = !!S.timers[chat.id] && S.timers[chat.id].until === Infinity;
    startTimer(chat, (goal && goal.kind === 'start') || goalRunning ? 'inf' : undefined);
    if (mirrorFor(chat)) { sendToMirror(chat, text, imgs, files, undefined, undefined, spoken); flyToChat(text, sendRect, true); return; }
    addMessage(chat, Object.assign({ who: 'Storm', kind: 'user', text, images: imgs.map(i => ({ path: i.path, url: i.url })), files: files.map(f => ({ path: f.path, name: f.name })) }, spoken ? { voice: spoken } : {}));
    flyToChat(text, sendRect);
    if (side) { runSide(chat, text); return; }
    beginFlow(chat);
    renderComposer(); renderTeam(); updateTitle();
    try { await converse(chat, text); }
    catch (e) { addMessage(chat, { who: APP, kind: 'error', text: String(e && e.message || e) }); }
    finally { endFlow(chat); renderComposer(); renderTeam(); updateTitle(); saveSoon(); onTurnEnd(chat.id); finishPing(chat.id); reloadIfIdle(); drainWoken(chat); sendQueued(chat); }
  }
  // the oldest message Storm queued while a reply was being written goes out now that the reply has ended
  function sendQueued(chat) {
    const m = (chat.messages || []).find(x => x.queued);
    if (!m || S.flows[chat.id]) return;
    m.queued = false; msgCache.delete(m);
    beginFlow(chat);
    renderChat(); renderComposer(); renderTeam(); updateTitle(); saveSoon();
    converse(chat, m.text)
      .catch(e => addMessage(chat, { who: APP, kind: 'error', text: String(e && e.message || e) }))
      .finally(() => { endFlow(chat); renderComposer(); renderTeam(); updateTitle(); saveSoon(); onTurnEnd(chat.id); finishPing(chat.id); reloadIfIdle(); drainWoken(chat); sendQueued(chat); });
  }
  // the send arrow flies off and comes back
  function whoosh() { const b = $('#send'); b.classList.remove('whoosh'); void b.offsetWidth; b.classList.add('whoosh'); }
  // the message flies from the box into the chat, so it visibly lands instead of just vanishing
  function flyToChat(text, from, toBottom) {
    if (!text || !from || !from.width) return;
    const box = $('#chat'), boxR = box.getBoundingClientRect();
    const bubbles = box.querySelectorAll('.msg.user .bubble');
    const lastR = bubbles.length ? bubbles[bubbles.length - 1].getBoundingClientRect() : null;
    const to = !toBottom && lastR && lastR.top >= boxR.top && lastR.bottom <= boxR.bottom + 4 ? lastR : { right: boxR.right - 28, top: boxR.bottom - 60, height: 36 };
    const w = Math.min(from.width, 440);
    const g = document.createElement('div');
    g.className = 'ghost-msg';
    g.textContent = text.length > 220 ? text.slice(0, 219) + '…' : text;
    g.style.left = from.left + 'px'; g.style.top = from.top + 'px'; g.style.width = w + 'px';
    document.body.append(g);
    const dx = to.right - 26 - (from.left + w), dy = to.top + Math.min(to.height || 36, 36) / 2 - (from.top + 12);
    const anim = g.animate([
      { transform: 'translate(0px, 0px) scale(1)', opacity: 1 },
      { transform: 'translate(' + dx + 'px, ' + dy + 'px) scale(0.86)', opacity: 0.1 },
    ], { duration: 460, easing: 'cubic-bezier(0.2, 0.8, 0.25, 1)' });
    anim.onfinish = anim.oncancel = () => g.remove();
  }

  function stopAll() {
    S.stopEpoch++;
    Object.keys(S.timers).forEach(id => stopTimer(id, true));
    Bridge.call('stopAll').catch(() => {});
  }

  // ---------- Pause all (the phone's Mission control switch, and Siri's "Pause my team" / "Resume my team"; on the computer: the banner's
  // Resume, or /pause and /resume). Pausing stops every bot's run, like Stop, and then nothing starts by itself until the team is resumed:
  // no routines, wake-ups, idle work, To do drive, work timer nudges or away notes. Storm's own messages still go through. It lasts across restarts ----------
  let teamPausedAt = 0;
  try { teamPausedAt = Number(localStorage.getItem('squall.teamPaused')) || 0; } catch (e) { teamPausedAt = 0; }
  function teamPaused() { return teamPausedAt > 0 && !S.selftest; }   // (the self-test runs its own routines and drive)
  function setTeamPaused(on, from) {
    on = !!on;
    if (on === teamPaused()) return false;
    teamPausedAt = on ? Date.now() : 0;
    try { if (on) localStorage.setItem('squall.teamPaused', String(teamPausedAt)); else localStorage.removeItem('squall.teamPaused'); } catch (e) { }
    if (on) stopAll();
    const where = from ? ' from ' + from : '';
    const lead = S.lead ? chatById('dm:' + S.lead.name) : null;
    if (lead) addMessage(lead, { who: APP, kind: 'event', text: on ? '⏸ Team paused' + where + '. Nothing starts by itself until it’s resumed.' : '▶ Team resumed' + where + '. Routines, wake-ups and the To do drive are back on.' });
    Bridge.call('log', { level: 'pause', msg: 'team ' + (on ? 'paused' : 'resumed') + where }).catch(() => {});
    sfx(on ? 'okNo' : 'okYes');
    renderBanner(); renderTeamSoon(); saveSoon();
    return true;
  }
  function pausedFor() {
    if (!teamPausedAt) return '';
    const mins = Math.floor((Date.now() - teamPausedAt) / 60000);
    return mins < 1 ? 'just now' : mins < 60 ? mins + ' min ago' : Math.floor(mins / 60) + ' h ' + (mins % 60) + ' min ago';
  }
  setInterval(() => { if (teamPaused() && S.info.claudeFound) renderBanner(); }, 60000);   // keeps "paused 5 min ago" current

  // ---------- chats: open, create, edit ----------
  // groky r98: back/forward through the chats you opened in the left pane, like a browser. Alt+Left / Alt+Right or the mouse side buttons. No CSS, no motion.
  const CH = { back: [], fwd: [], nav: false };
  function chatHistNote(from, to) { if (CH.nav || !from || from === to) return; if (CH.back[CH.back.length - 1] !== from) CH.back.push(from); if (CH.back.length > 50) CH.back.shift(); CH.fwd.length = 0; }
  function chatHistGo(dir) {
    const src = dir < 0 ? CH.back : CH.fwd, dst = dir < 0 ? CH.fwd : CH.back;
    while (src.length) {
      const id = src.pop();
      if (!id || id === S.active || id === S.split || !chatById(id)) continue;
      if (S.active && dst[dst.length - 1] !== S.active) dst.push(S.active);
      CH.nav = true; S.focusRight = false;
      try { openChat(id); } finally { CH.nav = false; }
      requestAnimationFrame(() => { const m = document.querySelector('#agents .member.on'); if (m && m.scrollIntoView) m.scrollIntoView({ block: 'nearest' }); });
      return true;
    }
    return false;
  }
  function chatHistBlocked(t) { return !!(document.querySelector('.modal-back, .qk-back, .lightbox, #at-pop:not(:empty)') || (t && t.closest && t.closest('#live-body .comp-pic'))); }
  document.addEventListener('keydown', e => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || e.isComposing) return;
    if (chatHistBlocked(e.target)) return;
    e.preventDefault(); e.stopPropagation();
    chatHistGo(e.key === 'ArrowLeft' ? -1 : 1);
  });
  document.addEventListener('mouseup', e => {
    if (e.button !== 3 && e.button !== 4) return;
    e.preventDefault();
    if (chatHistBlocked(e.target)) return;
    chatHistGo(e.button === 3 ? -1 : 1);
  });
  function openChat(id) {
    const chFrom = S.active;   // groky r98
    if (window.SquallUnoUI) window.SquallUnoUI.close();   // a chat replaces the Squall Uno view (web/uno.js)
    closeSessionView();
    S.noteView = null;
    if (id !== S.active) sfx('chat');
    const c = chatById(id);
    if (!c) return;
    S.newFrom = c.unread > 0 ? (c.messages[Math.max(0, c.messages.length - c.unread)] || {}).id || null : null;   // small detail: a "New messages" line where unread ones start
    S.newFromChat = id;
    // with a split, the chat goes to the focused pane: a chat already on screen just moves the focus to its pane
    if (S.split && id === S.active) S.focusRight = false;
    else if (S.split && id === S.split) S.focusRight = true;
    else if (S.split && S.focusRight) S.split = id;
    else { if (id !== S.active) swapChatDraft(S.active, id); S.active = id; }   // groky r94: each chat keeps its own unsent text
    c.unread = 0;
    if (c.kind === 'dm') S.live = c.members[0];
    closeTimerDial();
    renderAll(); renderTimerChip(); saveSoon(); updateTitle();
    chatHistNote(chFrom, S.active);   // groky r98
    $('#input').focus();
  }

  // the right pane's own send box: it sends through the same send path to that pane's chat, and the main box keeps its draft
  function sendRight() {
    const text = $('#input2').value;
    if (!text.trim() || !S.split) return;
    const keepFocus = S.focusRight, keepDraft = $('#input').value;
    S.focusRight = true; $('#input').value = text;
    send();
    const sent = $('#input').value !== text;   // send() empties the box it sent from
    S.focusRight = keepFocus; $('#input').value = keepDraft;
    if (sent) { $('#input2').value = ''; $('#input2').style.height = 'auto'; }
  }
  $('#send2').addEventListener('click', sendRight);
  $('#input2').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendRight(); } });
  $('#input2').addEventListener('input', e => { e.target.style.height = 'auto'; e.target.style.height = Math.min(220, e.target.scrollHeight) + 'px'; });

  // the Split button: opens another chat (a bot's first) beside this one, or closes the second pane
  function toggleSplit() {
    if (S.split) { S.split = null; S.focusRight = false; }
    else {
      const other = S.chats.find(c => c.id !== S.active && c.kind === 'dm') || S.chats.find(c => c.id !== S.active);
      if (!other) return;
      S.split = other.id; S.focusRight = false; other.unread = 0;
    }
    renderAll(); renderTimerChip(); saveSoon();
  }

  // ---------- Squall on the phone (Mobile.cs): the page hands the phone its chats every 2 s while phone access is on ----------
  function mobileSnapshot() {
    const colorOf = n => (S.byName[n] || {}).color || (n === 'Storm' ? '#3d9be9' : '#a78bfa');
    const chats = S.chats.map(c => {
      const mi = c.kind === 'dm' ? mirrorFor(c) : null;
      let msgs = mi ? mi.entries.filter(e => e.role === 'assistant' || e.role === 'user' || (e.role === 'peer' && APP_NAME_RX.test(e.from || '') && !SQ_NOTE_RX.test(e.text || '')))
        .map(e => ({ who: e.role === 'assistant' ? c.members[0] : 'Storm', kind: 'msg', text: e.role === 'peer' ? stripBotOnly(String(e.text || '').replace(VIA_RX, '').replace(/\n\nHe[’']s watching this session live[\s\S]*$/, '')) : String(e.text || '') }))
        : c.messages.filter(m => m.kind !== 'approve').map(m => ({ who: m.who, kind: m.kind === 'event' ? 'event' : 'msg', text: String(m.text || '') }));
      msgs = msgs.slice(-40).map(m => ({ who: m.who, kind: m.kind, text: m.text.length > 3000 ? m.text.slice(0, 3000) + '…' : m.text, color: colorOf(m.who) }));
      const name = c.kind === 'dm' ? c.members[0] : c.kind === 'team' ? 'Team' : c.name;
      const last = msgs.length ? msgs[msgs.length - 1] : null;
      const typing = Object.keys(S.typing[c.id] || {}).concat(mi && mirrorBusy(mi) ? [c.members[0]] : []);
      return { id: c.id, name, color: c.kind === 'dm' ? colorOf(c.members[0]) : '#a78bfa', unread: c.unread || 0, last: last ? (last.who === 'Storm' ? 'You: ' : last.kind === 'event' ? '' : last.who + ': ') + last.text.replace(/\s+/g, ' ').slice(0, 90) : '', typing: [...new Set(typing)].join(', '), messages: msgs };
    });
    Bridge.call('mobile', { do: 'snapshot', data: { chats } }).catch(() => {});
  }
  setInterval(() => { if (S.mobileOn) mobileSnapshot(); }, 2000);
  // a message typed on the phone goes into that chat as Storm's, the same as typing it here
  Bridge.on('mobileSend', m => { const c = chatById(m.chat); if (!c) return; openChat(c.id); $('#input').value = String(m.text || ''); send(); });
  function mobileText() {
    const st = S.mobileState || {};
    if (!S.mobileOn) return 'Off. Turn it on to use Squall from your phone on the same Wi-Fi: no app store, free. Windows may ask once to let Squall take connections.';
    return 'On. On your phone open <b>' + esc(st.address || '') + '</b>, then Share → Add to Home Screen. ' + (st.code ? 'Pairing code: <b style="font-size:1.3em;letter-spacing:2px">' + esc(st.code) + '</b> (5 minutes). ' : '') + (st.paired ? st.paired + ' phone' + (st.paired > 1 ? 's' : '') + ' paired.' : 'No phone paired yet.');
  }
  async function mobileSet(what) {
    try { const st = await Bridge.call('mobile', { do: what }); S.mobileOn = !!st.on; S.mobileState = st; saveSoon(); if (st.on) mobileSnapshot(); return st; }
    catch (e) { return { on: false, error: e.message }; }
  }

  // ---------- the Squall app on iPhone and iPad (link.js; the host's SquallLink serves the phone): what it may read and do here ----------
  // Only Squall's real state goes to the phone. Each hook is called later, never while this file is still loading.
  function linkMessages(c) {
    const mi = c.kind === 'dm' ? mirrorFor(c) : null;
    if (mi) {
      const out = [];
      mi.entries.forEach((e, i) => {
        if (e.role === 'assistant' || e.role === 'user') out.push({ id: 'e' + i, who: e.role === 'assistant' ? c.members[0] : 'Storm', kind: 'msg', text: String(e.text || '') });
        else if (e.role === 'peer' && APP_NAME_RX.test(e.from || '') && !SQ_NOTE_RX.test(e.text || ''))
          out.push({ id: 'e' + i, who: 'Storm', kind: 'msg', text: stripBotOnly(String(e.text || '').replace(VIA_RX, '').replace(/\n\nHe[’']s watching this session live[\s\S]*$/, '')) });
      });
      return out;
    }
    return c.messages.filter(m => m.kind !== 'approve').map(m => ({ id: m.id, who: m.kind === 'user' ? 'Storm' : m.who, kind: m.kind === 'event' ? 'event' : m.kind === 'error' ? 'error' : 'msg', text: String(m.text || ''), at: m.time }));
  }
  function linkTyping(c) {
    const mi = c.kind === 'dm' ? mirrorFor(c) : null;
    return [...new Set(Object.keys(S.typing[c.id] || {}).concat(mi && mirrorBusy(mi, false) ? [c.members[0]] : []))];
  }
  // sends text into chat c as Storm, the same as typing it there, without moving the PC to that chat; true when it went (or queued)
  function linkSend(c, text, call) {
    const input = $('#input');
    const keep = { active: S.active, split: S.split, right: S.focusRight, draft: input.value, attach: S.attach };
    S.active = c.id; S.split = null; S.focusRight = false; S.attach = [];
    input.value = text;
    if (call) voiceSending = true;
    try { send(); } catch (e) { Bridge.call('log', { level: 'error', msg: 'phone send: ' + (e && e.stack || e) }).catch(() => { }); }
    const sent = input.value !== text;   // send() empties the box when it takes the message
    voiceSending = false;
    S.active = keep.active; S.split = keep.split; S.focusRight = keep.right; S.attach = keep.attach;
    input.value = keep.draft; autosize(); renderAttach(); saveDraft(); renderAll();
    return sent;
  }
  if (window.SquallLinkCore) window.SquallLinkCore.wire({
    S, Bridge, esc,
    phoneMessages: c => linkMessages(c),
    typingIn: c => linkTyping(c),
    send: (c, text, call) => linkSend(c, text, call),
    note: (c, text) => addMessage(c, { who: APP, kind: 'event', text }),
    paused: () => teamPaused(),
    setPaused: (on, from) => setTeamPaused(on, from),
    markRead: c => { if (c.unread) { c.unread = 0; saveSoon(); renderAll(); } },
    clear: c => clearChat(c),
    answer: (rid, decision) => answerApproval(rid, decision),
    group: (name, members) => { const c = createGroup(name, members); if (c) renderAll(); return c; },
    // the shared To do list (TODO, further down): the phone sees it and keeps it with the same functions as the right pane
    todo: {
      items: () => { try { return TODO.items; } catch (e) { return []; } },   // safe before the list is set up
      add: (text, by) => todoAdd(text, by),
      set: (id, status, who) => {
        if (!todoSet(id, status)) return false;
        const it = todoFind(id);
        if (it && who) { it.who = who; todoSave(); }
        return true;
      },
      del: id => { const had = TODO.items.some(x => x.id === id); if (had) todoDel(id); return had; },
      clearDone: () => { const n = TODO.items.length; TODO.items = TODO.items.filter(x => x.status !== 'done'); if (TODO.items.length !== n) todoSave(); return n - TODO.items.length; },
    },
    openSettings: () => openSettings(),
    closeModal: () => closeModal(),
    sfx: name => sfx(name),
    usage: () => usageForPhone(),
    setUsage: r => setUsageSettings(r),
    routines: {
      list: () => ((S.team && S.team.routines) || []).map(r => Object.assign({}, r, { off: routineOff(r.id) })),
      save: (r, oldId, on) => phoneSaveRoutine(r, oldId, on),
      remove: id => removeRoutine(id),
      setOn: (id, on) => { setRoutineOn(id, on); routinesChanged(); },
      skipToday: id => skipRoutineToday(id),
    },
    isSleeping: a => isSleeping(a),
    addBot: b => phoneAddBot(b),
    chief: { wake: () => phoneWakeChief(), nap: () => phoneNapChief() },
  });
  // Squall Uno (web/uno.js): each agent's own computer, live, in the sidebar under the chats and in the middle
  if (window.SquallUno) window.SquallUno.wire({
    S, Bridge, esc,
    renderTeamSoon: () => renderTeamSoon(),
    renderPaneSoon: () => unoPaneSoon(),
    sfx: name => sfx(name),
    beforeOpen: () => { closeSessionView(); if (S.noteView) closeNote(); },
    onClose: () => { renderAll(); $('#input').focus(); },
  });

  // "/demo farside": the team plays out a long simulated session on Farside in its own chat (Storm picked SIMULATED, 18 Oct 21:24; the
  // script is farside-demo.json, written by Obsidian from the Farside note). Nothing runs: no Claude, no usage. Stop ends it
  const demoRuns = new Set();
  async function startDemo(cmd) {
    const name = (/^\/demo\s+(\S+)/i.exec(cmd) || [])[1] || 'farside';
    let steps;
    try { steps = await (await fetch(name.toLowerCase() + '-demo.json')).json(); }
    catch (e) { addMessage(activeChat(), { who: APP, kind: 'event', text: 'There’s no “' + name + '” demo. Try /demo farside.' }); return; }
    const title = name[0].toUpperCase() + name.slice(1) + ' demo';
    let chat = S.chats.find(c => c.kind === 'group' && c.name === title);
    if (!chat) chat = createGroup(title, S.agents.map(a => a.name));
    if (!chat || demoRuns.has(chat.id)) { if (chat) openChat(chat.id); return; }
    openChat(chat.id);
    demoRuns.add(chat.id);
    const epoch = S.stopEpoch;
    addMessage(chat, { who: APP, kind: 'event', text: 'Demo: a simulated session (no Claude runs, no usage). Stop ends it.' });
    try {
      for (const st of Array.isArray(steps) ? steps : []) {
        const who = S.byName[st.who] ? st.who : APP;
        const typing = S.typing[chat.id] || (S.typing[chat.id] = {});
        if (st.kind === 'msg' && who !== APP) { typing[who] = now(); if (onScreen(chat.id)) renderChat(); }
        await sleep(Math.max(300, Math.min(8000, +st.delayMs || 1500)));
        delete typing[who];
        if (epoch !== S.stopEpoch) { addMessage(chat, { who: APP, kind: 'event', text: 'Demo stopped.' }); break; }
        if (st.kind === 'msg' && who !== APP) {
          addMessage(chat, { who, kind: 'agent', text: String(st.text || ''), demo: true });
          const ments = mentionsIn(String(st.text || ''), chat, who);
          pingMessage([who].concat(ments), chat.id);
        } else addMessage(chat, { who: APP, kind: 'event', text: String(st.text || '') });
        if (onScreen(chat.id)) renderChat();
      }
    } finally { demoRuns.delete(chat.id); renderTeamSoon(); }
  }
  function createGroup(name, members) {
    members = members.filter(n => S.byName[n]);
    if (!members.length) return null;
    const lead = S.lead && members.includes(S.lead.name) ? S.lead.name : members[0];
    const c = makeChat('g:' + uid(), 'group', (name || '').trim() || members.join(', '), members, lead);
    S.chats.push(c);
    saveSoon();
    return c;
  }

  function updateGroup(c, name, members) {
    members = members.filter(n => S.byName[n]);
    if (!members.length) return;
    c.name = (name || '').trim() || members.join(', ');
    c.members = members;
    const ch = (S.chiefs || []).find(a => members.includes(a.name));
    c.lead = ch ? ch.name : members[0];
    saveSoon(); renderAll();
  }

  function deleteGroup(c) {
    S.chats = S.chats.filter(x => x !== c);
    for (const k of Object.keys(S.sessions)) if (k.startsWith(c.id + '|')) delete S.sessions[k];
    for (const k of Object.keys(S.seen)) if (k.startsWith(c.id + '|')) delete S.seen[k];
    if (S.active === c.id) S.active = 'team';
    saveNow(); renderAll();
  }

  function clearChat(c) {
    c.messages = []; c.unread = 0;
    for (const k of Object.keys(S.sessions)) if (k.startsWith(c.id + '|')) delete S.sessions[k];
    for (const k of Object.keys(S.seen)) if (k.startsWith(c.id + '|')) delete S.seen[k];
    saveNow(); renderAll();
  }

  function openGroupModal(existing) {
    closeModal();
    const picked = new Set(existing ? existing.members : []);
    const box = document.createElement('div');
    box.className = 'modal-back';
    box.innerHTML = '<div class="modal"><h3>' + (existing ? 'Edit group' : 'New group chat') + '</h3>' +
      '<input id="g-name" type="text" placeholder="Group name (optional)" value="' + esc(existing ? existing.name : '') + '" spellcheck="false">' +
      '<div class="pick-label">Who’s in it?</div><div class="pick">' +
      S.agents.map(a => '<button class="pick-one' + (picked.has(a.name) ? ' on' : '') + '" data-pick="' + esc(a.name) + '" style="--c:' + esc(a.color) + '">' + avatar(a.name, a.color) + '<span>' + esc(a.name) + '</span></button>').join('') +
      '</div><div class="modal-btns">' + (existing ? '<button class="danger-text" data-modal="delete">Delete group</button>' : '') +
      '<span class="grow"></span><button data-modal="cancel">Cancel</button><button class="primary-text" data-modal="ok">' + (existing ? 'Save' : 'Create') + '</button></div></div>';
    document.body.append(box);
    const name = $('#g-name', box);
    name.focus();
    box.addEventListener('click', e => {
      if (e.target === box) { closeModal(); return; }
      const p = e.target.closest('[data-pick]');
      if (p) { const n = p.dataset.pick; picked.has(n) ? picked.delete(n) : picked.add(n); p.classList.toggle('on', picked.has(n)); return; }
      const b = e.target.closest('[data-modal]');
      if (!b) return;
      const what = b.dataset.modal;
      if (what === 'cancel') closeModal();
      else if (what === 'delete' && existing) { if (confirm('Delete the group "' + existing.name + '" and its messages?')) { closeModal(); deleteGroup(existing); } }
      else if (what === 'ok') {
        const members = S.agents.map(a => a.name).filter(n => picked.has(n));
        if (!members.length) { box.querySelector('.pick-label').textContent = 'Pick at least one teammate.'; return; }
        closeModal();
        if (existing) updateGroup(existing, name.value, members);
        else { const c = createGroup(name.value, members); if (c) openChat(c.id); }
      }
    });
    name.addEventListener('keydown', e => { if (e.key === 'Enter') box.querySelector('[data-modal="ok"]').click(); if (e.key === 'Escape') closeModal(); });
  }
  function closeModal() { const m = document.querySelectorAll('.modal-back'); if (m.length) sfxCloseSoon(); m.forEach(x => x.remove()); }
  // "/anims" (Storm, 19 Oct: "a demo where I can click through all the animations for the normal bots and the chief"): one big icon,
  // the list of looks beside it; click a look (or use ← →) to play it
  function openAnimGallery() {
    closeModal();
    const bot = S.agents.find(a => !a.lead) || { name: 'Bot', color: '#4ade80' }, chief = S.agents.find(a => a.lead) || { name: 'Chief', color: '#f6d860' };
    const looks = [{ who: 'bot', cls: 'anim-orbit', name: 'Working: three orbiting balls' }]
      .concat(Array.from({ length: ANIMS }, (_, i) => ({ who: 'bot', cls: 'anim-m' + (i + 1), name: 'Messaging another Claude #' + (i + 1) })))
      .concat([{ who: 'chief', cls: '', name: 'Chief: idle (gold halo)' }, { who: 'chief', cls: 'anim-w1', name: 'Chief: working (gold sparks orbit)' }, { who: 'chief', cls: 'anim-m1', name: 'Chief: handing out work (crown lifts)' }])
      .concat(Array.from({ length: ANIMS }, (_, i) => ({ who: 'chief', cls: 'anim-w' + (i + 1), name: 'Chief working, look #' + (i + 1) })));
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = '<div class="modal anim-gal"><div class="ag-head"><b>Animations</b><button class="ag-x" title="Close">×</button></div><div class="ag-body"><div class="ag-stage"><div class="ag-icon"></div><div class="ag-name"></div><div class="ag-nav"><button data-ag="-1">‹ Prev</button><button data-ag="1">Next ›</button></div></div><div class="ag-list">' +
      looks.map((l, i) => '<button class="ag-item" data-agi="' + i + '"><span class="ag-who ' + l.who + '">' + (l.who === 'chief' ? 'Chief' : 'Bot') + '</span>' + esc(l.name) + '</button>').join('') + '</div></div></div>';
    document.body.append(back);
    let cur = 0;
    const show = i => {
      cur = (i + looks.length) % looks.length;
      const l = looks[cur], a = l.who === 'chief' ? chief : bot;
      back.querySelector('.ag-icon').innerHTML = '<div class="member' + (l.who === 'chief' ? ' chief' : '') + ' on" style="--c:' + esc(a.color) + '">' + (l.who === 'chief' ? CROWN : '') + '<div class="av-wrap ' + l.cls + '">' + (l.who === 'chief' ? CHIEF_FX : '') + avatar(a.name, a.color) + '</div></div>';
      back.querySelector('.ag-name').textContent = l.name;
      back.querySelectorAll('.ag-item').forEach((b, k) => b.classList.toggle('on', k === cur));
      const on = back.querySelector('.ag-item.on'); if (on) on.scrollIntoView({ block: 'nearest' });
    };
    back.addEventListener('click', e => {
      if (e.target === back || e.target.closest('.ag-x')) { back.remove(); return; }
      const it = e.target.closest('[data-agi]'); if (it) show(+it.dataset.agi);
      const nv = e.target.closest('[data-ag]'); if (nv) show(cur + +nv.dataset.ag);
    });
    const key = e => { if (!back.isConnected) { document.removeEventListener('keydown', key); return; } if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); show(cur + 1); } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); show(cur - 1); } else if (e.key === 'Escape') back.remove(); };
    document.addEventListener('keydown', key);
    show(0);
  }

  // ---------- tools ----------
  const svg = d => '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>';
  const ICON = {
    file: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>'),
    pen: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
    search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
    globe: svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>'),
    term: svg('<path d="m5 7 5 5-5 5M12 17h7"/>'),
    list: svg('<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>'),
    msg: svg('<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>'),
    eye: svg('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
    spark: svg('<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18"/>'),
    trash: svg('<path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>'),
    folder: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
    copy: svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>'),
    clock: svg('<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M9 2h6"/>'),
    chev: svg('<path d="m6 9 6 6 6-6"/>'),
    check: svg('<path d="m5 12 5 5 9-10"/>'),
    reply: svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
  };
  const TOOL_ICON = { Read: ICON.file, Write: ICON.pen, Edit: ICON.pen, Glob: ICON.search, Grep: ICON.search, WebSearch: ICON.globe, WebFetch: ICON.globe, Bash: ICON.term, PowerShell: ICON.term, TodoWrite: ICON.list, SendMessage: ICON.msg };
  const toolIcon = name => TOOL_ICON[name] || (/^mcp__.*(browser|computer)/i.test(name || '') ? ICON.eye : ICON.spark);
  const prettyModel = m => { const x = /claude-([a-z]+)-(\d+)-(\d+)/i.exec(m || ''); return x ? x[1].charAt(0).toUpperCase() + x[1].slice(1) + ' ' + x[2] + '.' + x[3] : (m || ''); };
  const VERBS = {
    Read: 'Reading', Write: 'Writing a file', Edit: 'Editing', Glob: 'Looking for files', Grep: 'Searching files', WebSearch: 'Searching the web',
    WebFetch: 'Reading a web page', Bash: 'Running a command', PowerShell: 'Running a command', TodoWrite: 'Planning', Agent: 'Starting a helper agent',
    Task: 'Starting a helper agent', Workflow: 'Running a workflow', Skill: 'Using a skill', SendMessage: 'Messaging a session', ListAgents: 'Checking the team',
    Artifact: 'Publishing a page', Monitor: 'Watching a task', ToolSearch: 'Loading tools', SendUserFile: 'Sending you a file', AskUserQuestion: 'Asking you something',
  };
  function toolVerb(name) {
    if (VERBS[name]) return VERBS[name];
    const m = /^mcp__(.+?)__(.+)$/.exec(name || '');
    if (m) return /browser/i.test(m[1]) ? 'Using the browser' : /computer-use/i.test(m[1]) ? 'Using the computer' : 'Using ' + m[2].replace(/[_-]+/g, ' ');
    return 'Using ' + name;
  }
  function baseName(p) { return String(p || '').split(/[\\/]/).pop(); }
  function toolSummary(tool) {
    const i = tool.input || {};
    let detail = '';
    if (i.file_path) detail = baseName(i.file_path);
    else if (i.query) detail = i.query;
    else if (i.url) { try { detail = new URL(i.url).hostname; } catch (e) { detail = i.url; } }
    else if (i.pattern) detail = i.pattern;
    else if (i.command) detail = i.command;
    else if (i.description) detail = i.description;
    return toolVerb(tool.name) + (detail ? ': ' + String(detail).slice(0, 90) : '');
  }

  // ---------- rendering ----------
  const mdCtx = {
    link(dest, html) { return /^(https?:)/i.test(dest) ? '<a data-url="' + esc(dest) + '">' + html + '</a>' : html; },
    wikilink(inner) { const w = MD.parseWiki(inner); return '<b>' + esc(w.alias || w.target) + '</b>'; },
    image(dest, alt) { return esc(alt || ''); },
  };
  // ---------- code colors: a small highlighter for the languages the team writes most ----------
  const LANGS = (() => {
    const L = (kw, line, block, quotes, extra) => Object.assign({ kw: new Set(kw.split(' ')), line, block, quotes }, extra || {});
    const js = L('async await break case catch class const continue default delete do else export extends false finally for from function if import in instanceof let new null of return static super switch this throw true try typeof undefined var void while yield', '//', ['/*', '*/'], '"\'`');
    const cs = L('abstract as async await base bool break byte case catch char class const continue decimal default delegate do double else enum event false finally float for foreach get if in int interface internal is lock long namespace new null object out override params private protected public readonly ref return sealed set short static string struct switch this throw true try typeof uint ulong using var virtual void while', '//', ['/*', '*/'], '"\'');
    const lua = L('and break do else elseif end false for function goto if in local nil not or repeat return then true until while continue export type', '--', ['--[[', ']]'], '"\'');
    const py = L('and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield self', '#', null, '"\'');
    const ps = L('begin break catch class continue do else elseif end exit filter finally for foreach function if in param process return switch throw trap try until while $true $false $null', '#', ['<#', '#>'], '"\'', { ci: true, vars: true });
    const cpp = L('auto bool break case catch char class const constexpr continue default delete do double else enum explicit extern false float for friend if inline int long namespace new nullptr operator private protected public return short signed sizeof static struct switch template this throw true try typedef typename union unsigned using virtual void volatile while include define pragma', '//', ['/*', '*/'], '"\'');
    const json = L('true false null', null, null, '"');
    const sh = L('if then else elif fi for in do done while case esac function return export local echo', '#', null, '"\'', { vars: true });
    return { js, javascript: js, ts: js, typescript: js, jsx: js, tsx: js, cs, csharp: cs, 'c#': cs, lua, luau: lua, py, python: py, ps: ps, ps1: ps, powershell: ps, pwsh: ps,
      cpp, 'c++': cpp, c: cpp, h: cpp, hpp: cpp, json, jsonc: json, sh, bash: sh, shell: sh, zsh: sh };
  })();
  MD.highlight = function (lang, code) {
    const L = LANGS[String(lang || '').toLowerCase()];
    if (!L) return esc(code);
    let out = '', i = 0;
    const n = code.length, span = (cls, s) => '<span class="tk-' + cls + '">' + esc(s) + '</span>';
    while (i < n) {
      const ch = code[i];
      if (L.block && code.startsWith(L.block[0], i)) { const e = code.indexOf(L.block[1], i + L.block[0].length); const j = e < 0 ? n : e + L.block[1].length; out += span('cm', code.slice(i, j)); i = j; continue; }
      if (L.line && code.startsWith(L.line, i)) { const e = code.indexOf('\n', i); const j = e < 0 ? n : e; out += span('cm', code.slice(i, j)); i = j; continue; }
      if (L.quotes.includes(ch)) {
        let j = i + 1;
        while (j < n && code[j] !== ch) { if (code[j] === '\\') j++; else if (code[j] === '\n' && ch !== '`') break; j++; }
        out += span('st', code.slice(i, Math.min(n, j + 1))); i = Math.min(n, j + 1); continue;
      }
      if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(code[i + 1] || ''))) {
        const m = /^(0x[0-9a-f]+|\d[\d_]*(\.\d+)?(e[+-]?\d+)?|\.\d+)[a-z]*/i.exec(code.slice(i, i + 40));
        if (m && !/[A-Za-z_$]/.test(code[i - 1] || '')) { out += span('nu', m[0]); i += m[0].length; continue; }
      }
      if (/[A-Za-z_$]/.test(ch) || (L.vars && ch === '$')) {
        const m = /^[$]?[A-Za-z_][\w$-]*/.exec(code.slice(i, i + 80)) || [ch];
        let w = m[0];
        if (!L.vars) w = w.replace(/-.*$/, '');
        const key = L.ci ? w.toLowerCase() : w;
        const after = code.slice(i + w.length).match(/^\s*(.)/);
        out += L.kw.has(key) ? span('kw', w) : L.vars && w[0] === '$' ? span('va', w) : after && after[1] === '(' ? span('fn', w) : esc(w);
        i += w.length; continue;
      }
      out += esc(ch); i++;
    }
    return out;
  };

  function md(text) {
    const html = MD.render(String(text || ''), mdCtx).html;
    return html.replace(/(^|[\s(>])@([A-Za-z][\w-]*)/g, (all, pre, n) => { const a = S.byName[n]; return a ? pre + '<span class="mention" style="--c:' + esc(a.color) + '">@' + esc(n) + '</span>' : all; });
  }
  const avatar = (name, color, cls) => '<div class="avatar ' + (cls || '') + '" style="background:' + esc(color) + ';--c:' + esc(color) + '">' + esc((name || '?').charAt(0).toUpperCase()) + '</div>';
  const timeOf = iso => { try { return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; } };
  // groky r92: hovering any message time shows the full day, date and time to the second, the same way everywhere
  const whenTip = iso => { try { const t = new Date(iso); if (isNaN(t)) return ''; return esc(t.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) + ' at ' + t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })); } catch (e) { return ''; } };
  // a line with the day between messages from different days ("Today", "Yesterday", "Friday", "Wed, Oct 14"), since times alone don't say which day
  const dayKey = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); };
  function dayLabel(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const a = new Date(); a.setHours(0, 0, 0, 0);
    const b = new Date(d); b.setHours(0, 0, 0, 0);
    const diff = Math.round((a - b) / 86400000);
    return diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : diff > 1 && diff < 7 ? d.toLocaleDateString([], { weekday: 'long' }) : d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  }
  const daySep = iso => stamp('<div class="day-sep" data-k="day-' + esc(dayKey(iso)) + '"><span>' + esc(dayLabel(iso)) + '</span></div>');
  const STATUS = { idle: 'Idle', working: 'Working', done: 'Done', error: 'Error', stopped: 'Stopped' };
  const BOLT = '<svg viewBox="0 0 24 24" width="24" height="24" fill="#fff"><path d="M13.2 2 5 13.4h5.6L9.4 22l8.6-12h-5.7z"/></svg>';
  const CROWN = '<svg class="crown" viewBox="0 0 32 24" width="40" height="30"><path d="M3 20 1.5 6.5l7.3 5.6L16 2l7.2 10.1 7.3-5.6L29 20z" fill="#F6D860" stroke="#B88A12" stroke-width="1" stroke-linejoin="round"/>' +
    '<rect x="3" y="20.2" width="26" height="3" rx="1.2" fill="#E9C34A"/><circle cx="16" cy="2.6" r="1.6" fill="#FFF3B8"/><circle cx="1.8" cy="6.6" r="1.4" fill="#FFF3B8"/><circle cx="30.2" cy="6.6" r="1.4" fill="#FFF3B8"/></svg>';
  const badge = n => (n > 0 ? '<span class="badge">' + (n > 9 ? '9+' : n) + '</span>' : '');

  // every bot turn goes into EVO (Storm, 21:16: "After every turn, Squall makes the bots log everything to EVO"): Squall appends one line per
  // reply to Sessions/Squall log <date>.md itself, so it costs no model time and nothing is ever overwritten (append only)
  let vaultLogDay = '';
  function logTurnToVault(chat, name, text) {
    if (S.selftest || !S.info || S.info.memoryFound === false) return;
    const now = new Date(), day = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
    const where = chat.kind === 'dm' ? 'its chat with Storm' : chat.kind === 'team' ? 'the team chat' : 'the group ' + (chat.name || chat.id);
    const flat = String(text || '').replace(/\s+/g, ' ').trim();
    let line = '- ' + String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0') + ' **' + name + '** in ' + where + ': ' + (flat.length > 400 ? flat.slice(0, 400) + '…' : flat);
    if (vaultLogDay !== day) { vaultLogDay = day; line = '\n## Squall, ' + day + '\n' + line; }
    Bridge.call('vaultAppend', { path: 'Sessions/Squall log ' + day + '.md', text: line }).catch(() => {});
  }
  // the chief's own animations (Storm, 19 Oct: "Make the chief have special animations"): a gold halo, sparks that orbit while it works,
  // and the crown lifting when it hands out work or messages someone (features.css, "chief")
  const CHIEF_FX = '<span class="chief-fx"><i></i><i></i><i></i></span>';
  // ---------- icon animations ----------
  // app.css has 15 looks for working (anim-w1…w15) and 15 for messaging other Claudes (anim-m1…m15).
  // Each time an icon starts working, or a message goes between Claudes, it gets the next look from a shuffled deck;
  // long jobs switch looks every ROTATE_MS. A messaging burst shows on the sender and the receivers, then working resumes.
  const ANIMS = 60, ROTATE_MS = 12000, MSG_MS = 4500, MIRROR_BUSY_MS = 8000;
  const decks = { w: [], m: [] }, animState = {};
  function drawAnim(kind, avoid) {
    const d = decks[kind];
    if (!d.length) {
      for (let i = 1; i <= ANIMS; i++) d.push(i);
      for (let i = d.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const x = d[i]; d[i] = d[j]; d[j] = x; }
    }
    let k = d.pop();
    if (k === avoid && d.length) { const k2 = d.pop(); d.unshift(k); k = k2; }
    return k;
  }
  const animOf = key => animState[key] || (animState[key] = { w: 0, since: 0, m: 0, until: 0, cls: '' });
  function animClass(key, busy) {
    const st = animOf(key), t = Date.now();
    if (!busy) st.w = 0;
    else if (!st.w || t - st.since > ROTATE_MS) { st.w = drawAnim('w', st.w); st.since = t; }
    return st.until > t ? 'anim-m' + st.m : busy ? (key.indexOf('a:') === 0 && !(S.byName[key.slice(2)] || {}).lead && st.w % 10 === 0 ? 'anim-orbit' : 'anim-w' + st.w) : '';   // every look rotates (Storm, 23:20: "Why is the only animation the orb animation for the bots"); the three orbiting balls are one of them
  }
  // names: agents sending or receiving a message between Claudes; chatId: the chat it happened in (its icon animates too)
  function pingMessage(names, chatId) {
    const t = Date.now(), keys = [];
    for (const n of names) {
      const a = S.agents.find(x => x.name.toLowerCase() === String(n || '').toLowerCase());
      if (a && keys.indexOf('a:' + a.name) < 0) keys.push('a:' + a.name);
    }
    if (chatId && chatId.indexOf('dm:') !== 0) keys.push('c:' + chatId);
    for (const k of keys) { const st = animOf(k); if (st.until <= t) st.m = drawAnim('m', st.m); st.until = t + MSG_MS; }
    renderTeamSoon();
  }
  // a bot with a live session is working only while that session really is (Storm, 18:22: the chief animated while idle: a team-chat round
  // had left its own status on "working" while it waited, and a background command doesn't count)
  const agentBusy = a => (S.liveMode && S.mirror[a.name] && mirrorLive(a.name)) ? mirrorBusy(S.mirror[a.name]) : a.status === 'working' || (S.liveMode && mirrorBusy(S.mirror[a.name]));
  // ends bursts, rotates looks and notices a real session going quiet, without waiting for another render
  setInterval(() => {
    const stale = S.agents.some(a => animClass('a:' + a.name, agentBusy(a)) !== animOf('a:' + a.name).cls) ||
      S.chats.some(c => c.kind !== 'dm' && animClass('c:' + c.id, !!S.flows[c.id]) !== animOf('c:' + c.id).cls);
    if (stale) { renderTeamSoon(); if (mirrorFor(activeChat())) renderChat(); }
    if (S.timers[S.active]) renderTimerChip();
    updateWorkingRows();
    if (cardFor) { const hc = $('#hovercard'), ca = S.byName[cardFor]; if (hc && ca) patchHTML(hc, cardHTML(ca)); }
  }, 1000);
  function avWrap(key, busy) { const cls = animClass(key, busy); animOf(key).cls = cls; return '<div class="av-wrap' + (cls ? ' ' + cls : '') + '">'; }

  // Makes el's children match html, keeping nodes that didn't change so running animations (and scroll) carry on.
  function patchHTML(el, html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    morphChildren(el, tpl.content);
  }
  const nodeKey = n => (n.nodeType === 1 ? (n.getAttribute('data-k') || n.getAttribute('data-chat') || n.getAttribute('data-act') || '') : '');
  function morphChildren(from, to) {
    const want = Array.from(to.childNodes);
    for (let i = 0; i < want.length; i++) {
      const f = from.childNodes[i], t = want[i];
      if (!f) from.appendChild(t);
      else if (f.nodeType !== t.nodeType || f.nodeName !== t.nodeName || nodeKey(f) !== nodeKey(t)) from.replaceChild(t, f);
      else if (f.nodeType === 1) {
        const v = t.getAttribute('data-v');
        if (v !== null && v === f.getAttribute('data-v')) continue;   // same HTML as last time: nothing to patch
        for (const at of Array.from(f.attributes)) if (!t.hasAttribute(at.name)) f.removeAttribute(at.name);
        for (const at of Array.from(t.attributes)) if (f.getAttribute(at.name) !== at.value) f.setAttribute(at.name, at.value);
        morphChildren(f, t);
      } else if (f.nodeValue !== t.nodeValue) f.nodeValue = t.nodeValue;
    }
    while (from.childNodes.length > want.length) from.removeChild(from.lastChild);
  }

  // A teammate's session is running if its live link is up or its conversation was written in the last few minutes.
  function sessionRunning(n) {
    const p = peerFor(n);
    if (p && p.status !== 'offline') return true;
    if (S.selftest) return false;   // the self-test's team shares names with Storm's real sessions ("Barry (Squall)"): it never counts those
    if (NO_RELAY() && S.mirror[n]) return true;   // direct: Squall runs the bot's session itself, so it can be reached any time
    const s = (S.desk || []).find(x => botOf(x.title) === String(n).toLowerCase());
    return !!(s && s.modified && Date.now() - s.modified < 3 * 60000);
  }
  // keep the session list fresh, so the dots turn grey when a session goes offline
  setInterval(() => {
    if (!S.liveMode || !S.info || !S.info.team) return;
    Bridge.call('liveSessions').then(sessions => {
      setDesk(sessions);
      renderTeamSoon(); renderComposer();
      if (S.rightMode === 'sessions') renderSessionsPane();
    }).catch(() => {});
  }, 20000);

  // ---------- sleep (Storm: "Make the bots have a very cozy sleeping animation when idle and wake up automatically and decide if it
  // should work on something or go back to sleep"). A teammate Squall runs that's been idle a few minutes is asleep; every half hour or
  // so one sleeping teammate wakes, looks for something useful, and either does one small step or answers "sleep" and leaves no trace ----------
  const SLEEP_AFTER_MS = 3 * 60000, WAKE_EVERY_MS = 30 * 60000;
  const WAKE_NOTE = 'You just woke up from a nap: Squall wakes idle teammates now and then. Check whether there’s something useful you can do for Storm right now: open items on the To do list below (take one with todo_doing), open asks in this chat, your own notes, and in the EVO vault Claude Memory.md and Waiting on Storm.md. If there is, do one small, safe step and report it in 2 to 4 lines; if it’s something that should be checked regularly, you can set up a routine for it. If there isn’t, reply with exactly: sleep';
  function isSleeping(a) {
    if (!a || S.mirror[a.name] || sessionRunning(a.name)) return false;   // a live session isn't Squall's to put to sleep
    if (agentBusy(a) || a.waking) return false;
    return Date.now() - (a.lastActive || 0) > SLEEP_AFTER_MS;
  }
  const SLEEP_REPLY = /^\s*sleep[.!]?\s*$/i;
  // a nap that found nothing: the "sleep" reply comes back out of the chat
  function dropSleepReply(chat, name, from) {
    const before = chat.messages.length;
    chat.messages = chat.messages.filter((m, i) => i < from || !(m.who === name && SLEEP_REPLY.test(m.text || '')));
    const removed = before - chat.messages.length;
    if (removed && chat.id !== S.active) chat.unread = Math.max(0, chat.unread - removed);
    return removed;
  }
  function wakeTick() {
    // Storm, 18 Oct: "Make the sessions not auto wake". Bots still fall asleep; Squall wakes one only when team.json has "autoWake": true
    if (!(S.team && S.team.autoWake === true) || teamPaused()) return;
    if (S.selftest || voiceOn || !S.agents.length || Object.keys(S.flows).length) return;   // one at a time, never while something is running or a call is on
    if (usageTight()) return;   // throttled: no waking bots while the plan is on track to run out
    const now = Date.now();
    const due = S.agents.filter(a => isSleeping(a) && chatById('dm:' + a.name) && now - Math.max(a.lastWake || 0, a.lastActive || 0, S.bootAt || 0) > WAKE_EVERY_MS);
    if (due.length) wakeBot(due[Math.floor(Math.random() * due.length)]);
  }
  async function wakeBot(a) {
    const chat = chatById('dm:' + a.name);
    if (!chat) return;
    a.lastWake = Date.now(); a.waking = true; renderTeamSoon();
    beginFlow(chat);
    let napped = false;
    try {
      const from = chat.messages.length;
      const res = await askAgent(chat, a.name, WAKE_NOTE, S.stopEpoch);
      if (res && SLEEP_REPLY.test(res.text || '')) { dropSleepReply(chat, a.name, from); napped = true; }
    } catch (e) { }
    finally {
      endFlow(chat);
      a.waking = false;
      a.lastActive = napped ? Date.now() - SLEEP_AFTER_MS - 1 : Date.now();   // back to sleep at once, or awake a while after real work
      renderTeamSoon(); if (onScreen(chat.id)) renderChat(); saveSoon();
    }
  }
  // ---------- idle work (Storm, 26 Oct: "Make Squall force the bots to bug fix and polish the sounds and graphics of Farside when the todo
  // list is empty and I gave it no work"). Farside = the game project, never Roblox. Every 12 min: if the To do list is empty, no game runs,
  // Storm hasn't touched the PC for 10 min and nothing else is running, one idle bot (45 min cooldown each) claims a free area and does one real job ----------
  const FARSIDE = 'C:\\path\\to\\Farside';
  const IDLE_AREAS = [
    ['audio', 'sounds: find bugs in the audio code (missing, clipping, wrong volume or looping sounds, leaks) and polish how the game sounds'],
    ['rendering', 'rendering and VFX: find visual bugs (artifacts, wrong lighting, flicker, z-order, shader errors) and polish the graphics and effects'],
    ['ui', 'UI and HUD: find bugs in menus, text, layout and input handling and polish how they look and feel'],
    ['gameplay', 'gameplay bugs: find and fix crashes, logic errors and edge cases in the game code, and smooth out rough spots']];
  const IDLE_EVERY_MS = 60000, IDLE_COOLDOWN_MS = 0, IDLE_AWAY_MS = 60000, IDLE_SESSION_MS = 30 * 60000;   // Storm, 21:00: "just make it every minute" + 30-minute sessions
  S.idleAreas = S.idleAreas || {};   // area -> bot holding it (never two bots on one area)
  function idleNote(area, what) {
    return 'Idle work from Squall: the To do list is empty and Storm gave you nothing, so your standing job is Farside. Farside is the game project at ' + FARSIDE +
      '; never Roblox or Roblox Studio. Your area, and only yours (other bots have the other areas): ' + what + '. ' +
      'This is a 30-minute work session: keep working in your area for about 30 minutes, fixing and polishing several things one after another; Squall will nudge you to continue until the time is up. ' +
      'Read CLAUDE.md, FARSIDE.md and PROGRESS.md first. Pick concrete problems in your area, fix them for real (no stubs, no TODO placeholders), build it with the project\'s usual build and make sure it compiles. ' +
      'Do not launch the game window, do not touch files outside your area unless the fix needs it, and do not commit or push. ' +
      'End each turn with a short log for Storm: what you changed (files and one line each) and how you checked it.';
  }
  function idleFreeBot(a) {
    if (!a || a.waking || a.idleJob || agentBusy(a) || S.mirror[a.name] || sessionRunning(a.name)) return false;
    const dm = chatById('dm:' + a.name); if (!dm || S.timers[dm.id] || (S.typing[dm.id] || {})[a.name]) return false;
    const last = dm.messages[dm.messages.length - 1];
    if (last && last.kind === 'user') return false;   // Storm's last word in its chat is still unanswered
    if (Date.now() - (a.lastActive || 0) < IDLE_AWAY_MS) return false;
    return Date.now() - (a.lastIdleJob || 0) > IDLE_COOLDOWN_MS;
  }
  let idleChecking = false;
  async function idleWorkTick() {
    if (S.idleWork === false || teamPaused() || idleChecking || S.selftest || voiceOn || !S.agents.length || Object.keys(S.flows).some(id => { const b = S.byName[String(id).replace(/^dm:/, '')]; return !(b && b.idleJob); })) return;   // other bots' idle sessions don't block a free area
    if (Date.now() - Math.max(lastInput, lastTypedAt || 0) < IDLE_AWAY_MS || (S.bootAt && Date.now() - S.bootAt < IDLE_AWAY_MS)) return;   // Storm is active
    if ((TODO.items || []).some(i => i.status !== 'done')) return;   // the To do list comes first
    if (typeof usageTight === 'function' && usageTight()) return;
    idleChecking = true;
    try { if (await Bridge.call('gameCheck').catch(() => false) === true) return; } finally { idleChecking = false; }
    const area = IDLE_AREAS.find(x => !S.idleAreas[x[0]]), bot = area && S.agents.find(idleFreeBot);
    if (area && bot) idleJob(bot, area);
  }
  async function idleJob(a, area) {
    const chat = chatById('dm:' + a.name);
    S.idleAreas[area[0]] = a.name; a.idleJob = area[0]; a.lastIdleJob = a.idleStart = Date.now(); renderTeamSoon();
    addMessage(chat, { who: typeof APP !== 'undefined' ? APP : 'Squall', kind: 'event', text: a.name + ' took idle work: Farside ' + area[0] });
    beginFlow(chat);
    const start = Date.now(), from = chat.messages.length;
    // stop when Storm writes to this bot, a game starts, Idle work is turned off or Stop is pressed
    const stormSpoke = () => chat.messages.slice(from).some(m => m.kind === 'user');
    try {
      const epoch = S.stopEpoch;
      let res = await askAgent(chat, a.name, idleNote(area[0], area[1]), epoch);
      while (Date.now() - start < IDLE_SESSION_MS - 60000) {
        if (S.idleWork === false || teamPaused() || stormSpoke() || S.stopEpoch !== epoch || !res) break;
        if (await Bridge.call('gameCheck').catch(() => false) === true) break;
        const left = Math.max(1, Math.round((IDLE_SESSION_MS - (Date.now() - start)) / 60000));
        const last = left <= 3;
        res = await askAgent(chat, a.name, last
          ? 'About ' + left + ' min left in your Farside ' + area[0] + ' session: finish what you are on, make sure it compiles, and post the final log for this session (every file you changed, one line each, and how you checked it).'
          : 'Keep going, about ' + left + ' min left in your Farside ' + area[0] + ' session. Fix or polish the next thing in your area.', epoch);
        if (last) break;
      }
    } catch (e) { }
    finally {
      endFlow(chat); delete S.idleAreas[area[0]]; a.idleJob = null; a.lastActive = Date.now();
      renderTeamSoon(); if (onScreen(chat.id)) renderChat(); saveSoon();
    }
  }
  function idleLeft(a) { return a && a.idleJob && a.idleStart ? Math.max(1, Math.ceil((IDLE_SESSION_MS - (Date.now() - a.idleStart)) / 60000)) : 0; }
  function memberHTML(a, chief) {
    const dm = chatById('dm:' + a.name);
    const on = S.active === 'dm:' + a.name;
    let tip = a.name + (a.status !== 'idle' ? ' · ' + STATUS[a.status] : '') + (a.status === 'working' && a.activity ? ' · ' + a.activity : '');
    let dot = '';
    if (S.liveMode && (S.link.status === 'on' || S.mirror[a.name])) {
      const p = peerFor(a.name), mirrored = !!S.mirror[a.name];
      // green while the bot is working, also when Squall runs it itself (Storm: "The circle is gray when they are working?")
      const cls = sessionRunning(a.name) || agentBusy(a) ? 'on' : (p || mirrored) ? 'off' : 'none';
      tip += ' · ' + (mirrored ? 'live: you can watch its real session here' : !p ? 'not running on this PC (a stand-in answers)' : p.status === 'offline' ? 'offline (a stand-in answers)' : 'live: ' + (p.status || 'running'));
      dot = '<span class="ldot ' + cls + '"></span>';
      if (mirrored && mirrorNeedsYou(S.mirror[a.name])) { dot += '<span class="qbadge">?</span>'; tip += ' · waiting for your answer in the Claude app'; }
    }
    if (a.needsOk) { dot += '<span class="qbadge">?</span>'; tip += ' · waiting for your OK in its chat'; }
    if (a.permissionMode === 'bypassPermissions') tip += ' · bypass permissions (never asks)';
    const fs = idleLeft(a);
    if (fs) { dot += '<span class="fsbadge" title="">' + esc(a.idleJob) + ' ' + fs + 'm</span>'; tip += ' · on Farside ' + a.idleJob + ', about ' + fs + ' min left'; }
    if (!fs && hasDraft('dm:' + a.name)) { dot += '<span class="drmark">' + ICON.pen + '</span>'; tip += ' · unsent draft'; }   // groky r95
    const sleeping = isSleeping(a);
    if (sleeping) tip += ' · asleep (wakes up now and then to look for work)';
    return '<div class="member' + (chief ? ' chief' : '') + ' ' + a.status + (on ? ' on' : '') + (sleeping ? ' sleeping' : '') + (a.waking ? ' waking' : '') + (S.born && S.born.name === a.name && Date.now() < S.born.until ? ' born' : '') + '" data-chat="dm:' + esc(a.name) + '" title="' + esc(tip) + '" style="--c:' + esc(a.color) + '">' +
      (chief ? CROWN : '') + avWrap('a:' + a.name, agentBusy(a)) + (chief ? CHIEF_FX : '') + avatar(a.name, a.color) + badge(dm ? dm.unread : 0) + dot + (sleeping ? '<span class="zzz"><i>z</i><i>z</i><i>z</i></span><span class="moon"></span>' : '') + '</div><div class="mname">' + esc(a.name) + '</div></div>';
  }

  function groupIcon(c) {
    if (c.kind === 'team') return '<div class="avatar gicon team">' + BOLT + '</div>';
    const dots = c.members.slice(0, 4).map(n => { const a = S.byName[n]; return '<i style="background:' + esc(a ? a.color : '#888') + '"></i>'; }).join('');
    return '<div class="avatar gicon"><span class="dots n' + Math.min(4, c.members.length) + '">' + dots + '</span></div>';
  }

  function renderTeam() {
    if (redrawHold()) return;
    if (S.winMin) { S.renderPending = true; return; }
    const chiefs = S.chiefs && S.chiefs.length ? S.chiefs : (S.lead ? [S.lead] : []);
    const crew = S.agents.filter(a => !chiefs.includes(a));
    const groups = S.chats.filter(c => c.kind === 'team' || c.kind === 'group');
    patchHTML($('#agents'),
      (chiefs.length ? '<div class="pinned' + (chiefs.length > 1 ? ' multi' : '') + '">' + chiefs.map(a => memberHTML(a, true)).join('') + '</div>' : '') +
      '<div class="scroller"><div class="crew">' + crew.map(a => memberHTML(a, false)).join('') + '</div>' +
      '<div class="divider"></div><div class="crew groups">' +
      groups.map(c => '<div class="member group' + (S.active === c.id ? ' on' : '') + (S.flows[c.id] ? ' working' : '') + '" data-chat="' + esc(c.id) + '" title="' + esc(c.kind === 'team' ? 'Everyone; ' + (c.lead || '') + ' leads' : c.members.join(', ')) + '" style="--c:#a78bfa">' +
        avWrap('c:' + c.id, !!S.flows[c.id]) + groupIcon(c) + badge(c.unread) + (hasDraft(c.id) ? '<span class="drmark" title="Unsent draft">' + ICON.pen + '</span>' : '') + '</div><div class="mname">' + esc(c.name) + '</div></div>').join('') +
      '<div class="member add" data-act="newgroup" title="Make a group chat"><div class="av-wrap"><div class="avatar gicon add">+</div></div><div class="mname">New group</div></div>' +
      '<div class="member add" data-act="newteammate" title="Add a teammate"><div class="av-wrap"><div class="avatar gicon add">+</div></div><div class="mname">Teammate</div></div>' +
      '<div class="member add" data-act="routines" title="Routines: jobs your bots do at set times, and the Claude app’s scheduled tasks"><div class="av-wrap"><div class="avatar gicon add rt-icon">' + ICON.clock + '</div></div><div class="mname">Routines</div></div>' +
      '</div>' + (window.SquallUnoUI ? window.SquallUnoUI.sidebarHTML() : '') + '</div>');   // Squall Uno: each agent's computer, under the chats (web/uno.js)
    updateScrollFade();
  }
  // the team list fades out at the bottom while there's more to scroll to
  function updateScrollFade() {
    const sc = $('#agents .scroller');
    $('#agents').classList.toggle('more', !!sc && sc.scrollHeight - sc.scrollTop - sc.clientHeight > 6);
  }
  $('#agents').addEventListener('scroll', updateScrollFade, true);
  window.addEventListener('resize', updateScrollFade);
  let teamTimer = 0;
  function renderTeamSoon() { if (!teamTimer) teamTimer = requestAnimationFrame(() => { teamTimer = 0; renderTeam(); renderLiveTabs(); renderChatHead(); renderStripSwitch(); updateTitle(); }); }

  function renderChatHead() {
    if (S.winMin) { S.renderPending = true; return; }
    if (S.noteView) {
      const nv = S.noteView, folder = nv.path.includes('/') ? nv.path.slice(0, nv.path.lastIndexOf('/')) : 'EVO';
      $('#center').style.setProperty('--chat-c', '#8b7cf6');
      patchHTML($('#chat-head'), '<div class="head-icon"><div class="avatar gicon note-icon">' + ICON.file + '</div></div><div class="head-text"><div class="head-title">' + esc(nv.name) + '<span class="st-pill ro"><i></i>Read-only</span></div><div class="head-sub">EVO · ' + esc(folder) + '</div></div>' +
        '<div class="head-actions"><button data-act="closenote">' + ICON.check + 'Back to chat</button></div>');
      return;
    }
    if (S.sessView && S.sessMirror[S.sessView]) {
      const sm = S.sessMirror[S.sessView], busy = mirrorBusy(sm);
      patchHTML($('#chat-head'), '<div class="head-icon">' + avatar((sm.title || '?').charAt(0), '#7c8ea8') + '</div><div class="head-text"><div class="head-title">' + esc(sm.title || 'Session') +
        '<span class="st-pill ' + (busy ? 'on' : '') + '"><i></i>' + (busy ? 'Working now' : 'Offline') + '</span><span class="st-pill ro"><i></i>Read-only</span></div>' +
        '<div class="head-sub">' + esc(busy ? mirrorActivity(sm) : 'History of a session on this PC') + '</div></div>' +
        '<div class="head-actions"><button data-act="closesess">' + ICON.check + 'Back to chat</button></div>');
      return;
    }
    const c = activeChat();
    const head = $('#chat-head');
    // each chat glows softly in its agent's color (the lead's for groups; storm purple for the Team chat)
    const tint = c.kind === 'team' ? '#8b7cf6' : ((S.byName[c.kind === 'dm' ? c.members[0] : c.lead] || {}).color || '#a78bfa');
    $('#center').style.setProperty('--chat-c', tint);
    let sub, pill = '', icon;
    if (c.kind === 'dm') {
      const a = S.byName[c.members[0]] || { name: c.members[0], color: '#888', status: 'idle' };
      const mi = mirrorFor(c), busy = agentBusy(a);
      const doing = mi ? mirrorActivity(mi) : a.activity;
      const napping = !mi && !busy && isSleeping(a);
      pill = mi && mirrorNeedsYou(mi) ? '<span class="st-pill ask"><i></i>Needs you</span>' : busy && a.idleJob ? '<span class="st-pill on farside"><i></i>Farside · ' + esc(a.idleJob) + ' · ' + idleLeft(a) + ' min left</span>' : busy ? '<span class="st-pill on"><i></i>Working</span>' : a.waking ? '<span class="st-pill nap"><i></i>Waking up</span>' : napping ? '<span class="st-pill nap"><i></i>Napping</span>' : mi ? '<span class="st-pill"><i></i>Idle</span>' : '';
      sub = busy ? '<span class="head-doing">' + esc(doing) + '</span>' + (mi ? ' · live session' : '')
        : napping ? 'Napping · wakes now and then to look for work, or when you message it'
        : mi ? 'live view of the real ' + esc(c.members[0]) + ' session · your messages go straight to it' : esc(a.lead ? 'Leads the team' : 'Generalist') + ' · direct chat';
      icon = avWrap('a:' + a.name, busy) + avatar(a.name, a.color) + '</div>';
    } else {
      sub = c.members.map(n => { const a = S.byName[n]; return '<span class="chip-mini' + (a && agentBusy(a) ? ' busy' : '') + '" style="--c:' + esc(a ? a.color : '#888') + '"><i></i>' + esc(n) + (n === c.lead ? ' (leads)' : '') + '</span>'; }).join('');
      icon = groupIcon(c);
      if (S.flows[c.id]) pill = '<span class="st-pill on"><i></i>Working</span>';
    }
    patchHTML(head, '<div class="head-icon">' + icon + '</div><div class="head-text"><div class="head-title">' + esc(c.name) + pill + '</div><div class="head-sub">' + sub + '</div></div>' +
      '<div class="head-actions">' + liveButton() + '<button data-act="split" title="' + (S.split ? 'Close the second pane' : 'Show a second chat beside this one') + '">' + (S.split ? 'Unsplit' : 'Split') + '</button>' + (c.kind === 'group' ? '<button data-act="editgroup">' + ICON.pen + 'Edit</button>' : '') + '<button data-act="clearchat" title="Clear this chat and the agents’ memory of it">' + ICON.trash + 'Clear</button></div>');
  }

  function liveButton() {
    if (!S.liveMode) return '<button class="live-toggle" data-act="togglelive" title="Talk to your real Claude sessions on this PC">Live: off</button>';
    const st = S.link.status;
    const label = st === 'on' ? 'Live' : st === 'starting' ? 'Live: connecting…' : st === 'error' ? 'Live: error' : 'Live';
    return '<button class="live-toggle on ' + st + '" data-act="togglelive" title="Messages go to your real Claude sessions running on this PC. Click to use local agents instead."><i></i>' + label + '</button>';
  }

  function emptyChatHTML(c) {
    if (c.kind === 'team') {
      return '<div class="empty" data-k="empty-team"><div class="big">' + BOLT + '</div><h2>Give your team a goal</h2><div>' + esc(c.lead || 'Chief') + ' plans it, hands tasks to the team, and brings back one answer. Write @Name to ask someone directly.</div>' +
        '<div class="ideas"><button data-idea="Plan a Roblox leaderboard for my game: how scores should be saved, and the script.">Plan a Roblox leaderboard for my game</button>' +
        '<button data-idea="Read my EVO notes and tell me the 3 most important open questions I should answer this week.">What should I answer first in EVO?</button>' +
        '<button data-idea="Research how small language models avoid repeating themselves, and write a one-page summary file.">How do small models stop repeating?</button></div></div>';
    }
    if (c.kind === 'dm') { const a = S.byName[c.members[0]]; return '<div class="empty" data-k="empty-dm">' + avatar(c.members[0], a ? a.color : '#888', 'huge') + '<h2>Chat with ' + esc(c.members[0]) + '</h2><div>Just you and ' + esc(c.members[0]) + '. It remembers this chat until you clear it.</div></div>'; }
    return '<div class="empty" data-k="empty-group"><div class="big">' + groupIcon(c) + '</div><h2>' + esc(c.name) + '</h2><div>' + esc(c.lead) + ' answers first. Write @Name to ask someone, and teammates can @ each other too.</div></div>';
  }

  function renderChat() {
    if (redrawHold()) return;
    if (S.winMin) { S.renderPending = true; return; }   // minimized: nothing to see, so nothing is drawn (one redraw when the window is back)
    if (S.noteView) { renderNoteView(); return; }
    if (S.sessView && S.sessMirror[S.sessView]) { renderSessChat(); return; }
    // left pane = S.active, right pane = S.split (positions stay fixed); the focused one owns the composer, header and jump pill
    const right = S.split ? chatById(S.split) : null;
    $('#panes').classList.toggle('split', !!right);
    $('#chat2').hidden = !right;
    $('#chat2').dataset.title = right ? right.name : '';   // the right pane names its chat (CSS shows it at the top)
    // with a split, each column has its own send box: the main composer sits under the left pane, the right pane's under its own
    if (right && $('#composer').parentNode !== $('#pcol1')) $('#pcol1').appendChild($('#composer'));
    if (!right && $('#composer').parentNode !== $('#center')) $('#center').appendChild($('#composer'));
    $('#pcol2').hidden = !right;
    if (right) $('#input2').placeholder = 'Message ' + right.name + '…';
    $('#chat').classList.toggle('focused', !right || !S.focusRight);
    $('#chat2').classList.toggle('focused', !!right && S.focusRight);
    renderPane(chatById(S.active) || S.chats[0], $('#chat'), !right || !S.focusRight);
    if (right) renderPane(right, $('#chat2'), S.focusRight);
  }
  // one chat pane: the focused pane (true) owns the jump pill; the split's second pane (false) does not
  function renderPane(c, box, focused) {
    // follow new messages only when Storm is at the bottom (or we're mid smooth-scroll getting there)
    const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 80 || Date.now() - autoScrollAt < 800;
    const beforeH = box.scrollHeight;
    const mi = mirrorFor(c);
    const view = (mi ? 'mirror:' : '') + c.id;
    const switching = box.dataset.view !== view;
    if (switching) chatPlaceSave(box);   // groky r105
    box.dataset.view = view;
    // groky r218: the New messages pill counts the teammate replies that landed since Storm was last at the bottom
    if (focused) { jumpNow = { view, n: mi ? null : c.messages.reduce((t, m) => t + (m.kind === 'agent' ? 1 : 0), 0) }; if (switching || stick) jumpSeen = { view, n: jumpNow.n }; }
    if (mi) {
      // Squall's own errors in a live chat show for a few minutes, not forever (Storm: "Why are these squall errors still here")
      const extra = c.messages.filter(m => m.kind === 'error' && Date.now() - (Date.parse(m.time) || 0) < ERROR_SHOW_MS).slice(-3).map(m => messageHTML(m, switching)).join('');
      patchHTML(box, mirrorHTML(c, mi, switching) + extra);
      settleScroll(box, switching, stick, beforeH, false, focused);
      return;
    }
    const busy = S.typing[c.id] || {};
    const typing = Object.keys(busy).map(n => {
      const a = S.byName[n], st = !mirrorFor(c) ? streamText(c, n) : '';
      if (st) { S.streamed = S.streamed || {}; S.streamed[c.id + '|' + n] = true; return stamp(buildMessageHTML({ id: 'w-' + n, who: n, kind: 'agent', text: st, time: busy[n] || now() }).replace('class="', 'class="streaming ')); }
      return workingRow(n, a ? a.color : '#888', (a && a.activity) || 'Working…', busy[n]);
    }).join('');
    // a run of messages from the same sender within a few minutes shows its avatar and name once
    let prev = null, lastDay = '';
    const list = c.messages.map((m, mi2) => {
      const dk = dayKey(m.time), sep = dk && dk !== lastDay ? daySep(m.time) : '';
      if (sep) { lastDay = dk; prev = null; }
      const cont = !!prev && prev.who === m.who && prev.kind === m.kind && (m.kind === 'agent' || m.kind === 'user') && !!prev.live === !!m.live && Date.parse(m.time) - Date.parse(prev.time) < 5 * 60000;
      prev = m;
      // a bot's own question block becomes a card it gets the answers to (Storm: "teach Obsidian how to use the question thing")
      if (m.kind === 'agent' && /```squall-ask/.test(m.text || '')) {
        const sq = squallAsks(m.text);
        if (sq.asks.length) {
          const a = S.byName[m.who] || { color: '#8592a0' };
          const answered = c.messages.slice(mi2 + 1).some(x => x.who === 'Storm' && (/^My answers to your questions/.test(x.text || '') || x.text === SKIP_TEXT));
          prev = null;
          return sep + (sq.rest ? messageHTML(askRestMsg(m, sq.rest), switching, cont) : '') + sq.asks.map((qs, i) => {
            const v = { role: 'ask', k: m.id + '#' + i, questions: qs, time: m.time, local: true, chatId: c.id, agent: m.who };
            askCards.set(v.k, v);
            if (answered && !askSkipped.has(v.k)) askSent.add(v.k);
            return withCls(askCardHTML(v, undefined, m.who, a), freshCls(v.k, switching) ? 'fresh ' : '');
          }).join('');
        }
      }
      const nl = S.newFromChat === c.id && S.newFrom === m.id ? stamp('<div class="new-line" data-k="newline"><span>New messages</span></div>') : '';
      if (nl) prev = null;
      if (c.kind !== 'dm' && m.kind === 'agent' && m.who !== c.lead && !m.expanded) { prev = null; return sep + nl + foldedHTML(m); }
      return sep + nl + messageHTML(m, nl ? false : switching, nl ? false : cont);
    }).join('');
    patchHTML(box, (c.messages.length ? list : stamp(emptyChatHTML(c))) + typing);
    settleScroll(box, switching, stick, beforeH, !c.messages.length, focused);
  }
  // Opening a chat jumps to its end (with a quick fade); new content scrolls smoothly into view when Storm is at the
  // bottom, and otherwise a "New messages" pill offers to take him there.
  let autoScrollAt = 0;
  let jumpNow = { view: '', n: null }, jumpSeen = { view: '', n: null };   // groky r218
  function settleScroll(box, switching, stick, beforeH, toTop, focused) {
    if (switching) {
      if (!chatPlaceBack(box, toTop)) box.scrollTo({ top: toTop ? 0 : box.scrollHeight, behavior: 'instant' });   // groky r105
      if (focused) hideJump();
      box.classList.remove('switched'); void box.offsetWidth; box.classList.add('switched');
      return;
    }
    if (box.scrollHeight <= beforeH + 1) return;
    if (stick) { autoScrollAt = Date.now(); box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' }); }
    else if (focused) showJump();
  }
  // groky r105: each chat keeps its reading place. Leaving a chat while scrolled up remembers the message at the top of the view;
  // coming back (sidebar, Ctrl+K, Alt+arrows, back/forward) puts that message back where it was instead of jumping to the end.
  // A chat that has unread messages when reopened still goes to the end with its New messages line. Kept in memory only, 2 hours, 40 chats.
  const chatPlaces = new Map();
  function chatPlaceSave(box) {
    const old = box.dataset.view || '';
    if (!old || /^(sess|note):/.test(old)) return;
    const gap = box.scrollHeight - box.scrollTop - box.clientHeight;
    chatPlaces.delete(old);
    if (gap < 80 || box.scrollTop < 1 && box.scrollHeight <= box.clientHeight) return;
    const top = box.getBoundingClientRect().top;
    for (const el of box.children) {
      const k = el.getAttribute('data-k');
      if (!k || el.classList.contains('new-line') || el.classList.contains('working-row')) continue;
      const r = el.getBoundingClientRect();
      if (r.bottom > top + 4) { chatPlaces.set(old, { k, off: r.top - top, at: Date.now() }); break; }
    }
    while (chatPlaces.size > 40) chatPlaces.delete(chatPlaces.keys().next().value);
  }
  function chatPlaceBack(box, toTop) {
    const view = box.dataset.view || '', pl = chatPlaces.get(view);
    if (!pl) return false;
    chatPlaces.delete(view);
    const id = view.replace(/^mirror:/, '');
    if (toTop || Date.now() - pl.at > 2 * 3600000 || (S.newFromChat === id && S.newFrom)) return false;
    let el = null;
    try { el = box.querySelector(':scope > [data-k="' + CSS.escape(pl.k) + '"]'); } catch (e) { el = null; }
    if (!el) return false;
    box.scrollTo({ top: Math.max(0, box.scrollTop + (el.getBoundingClientRect().top - box.getBoundingClientRect().top) - pl.off), behavior: 'instant' });
    return true;
  }
  // groky r93: showJump(true) is the quiet Back to latest pill for when Storm scrolls far up; new messages always upgrade it
  function showJump(back) { const j = $('#jump'), q = !!back; j.style.bottom = ($('#composer').offsetHeight + 12) + 'px'; j.classList.toggle('quiet', q); const k = !q && jumpNow.n != null && jumpSeen.n != null && jumpNow.view === jumpSeen.view ? jumpNow.n - jumpSeen.n : 0; j.textContent = q ? '\u2193 Back to latest' : k > 0 ? '\u2193 ' + (k > 99 ? '99+' : k) + (k === 1 ? ' new message' : ' new messages') : '\u2193 New messages'; j.title = q ? 'Jump back to the latest message' : 'Jump to the newest messages'; j.classList.remove('hidden'); }
  function hideJump() { jumpSeen = { view: jumpNow.view, n: jumpNow.n }; $('#jump').classList.add('hidden'); }
  $('#jump').addEventListener('click', () => { const box = $('#chat'); autoScrollAt = Date.now(); box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' }); hideJump(); });
  // a click in a split pane makes it the focused pane, which the composer and the header follow
  $('#panes').addEventListener('pointerdown', e => {
    const onRight = !!e.target.closest('#pcol2'), onLeft = !!e.target.closest('#pcol1');
    if (!S.split || (!onRight && !onLeft) || S.focusRight === onRight) return;
    S.focusRight = onRight;
    renderChatHead(); renderComposer(); renderChat(); saveSoon();
  });
  $('#chat').addEventListener('scroll', () => { const box = $('#chat'), gap = box.scrollHeight - box.scrollTop - box.clientHeight; if (gap < 80) hideJump(); else if (Date.now() - autoScrollAt > 1200 && gap > Math.max(600, box.clientHeight * 1.5) && $('#jump').classList.contains('hidden') && ($('#chat2').hidden || !S.focusRight)) showJump(true); }, { passive: true });
  // a short hash of an item's HTML, stamped on it so re-renders can skip items that didn't change
  function hashStr(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
  const stamp = h => h.replace('<div ', '<div data-v="' + hashStr(h) + '" ');
  const msgCache = new WeakMap();
  function messageHTML(m, switching, cont) {
    let h = msgCache.get(m);
    if (!h) { h = buildMessageHTML(m); msgCache.set(m, h); }
    return withCls(h, (freshCls(m.id, switching) ? 'fresh ' : '') + (cont ? 'cont ' : ''));
  }
  // adds classes to the outer element of cached message HTML (its first class attribute)
  const withCls = (h, cls) => stamp(cls ? h.replace('class="', 'class="' + cls) : h);
  function buildMessageHTML(m) {
    const k = ' data-k="' + esc(m.id) + '"';
    if (m.kind === 'approve') {
      const ap = m.approve || {}, who = S.byName[m.who];
      const outcome = { once: 'Allowed once', always: 'Always allowed for ' + m.who, deny: 'Denied', timeout: 'No answer in 10 minutes, so not allowed', gone: 'The run ended before an answer' }[ap.state];
      const btns = ap.state === 'waiting'
        ? '<div class="ok-btns"><button class="ok-yes" data-approve="once" data-req="' + esc(ap.requestId) + '">Allow once</button>' + (ap.canAlways ? '<button class="ok-always" data-approve="always" data-req="' + esc(ap.requestId) + '">Always allow</button>' : '') + '<button class="ok-no" data-approve="deny" data-req="' + esc(ap.requestId) + '">Deny</button></div>'
        : '<div class="ok-done ' + esc(ap.state || '') + '">' + esc(outcome || String(ap.state || '')) + '</div>';
      return '<div class="ok-card' + (ap.state === 'waiting' ? ' waiting' : '') + '" style="--c:' + esc(who ? who.color : '#a78bfa') + '"' + k + '><div class="ok-head"><span class="ok-shield">' + ICON.check + '</span><span><b>' + esc(m.who) + '</b> wants to use <b>' + esc(ap.tool || 'a tool') + '</b>' + (m.text ? ' · ' + esc(m.text) : '') + '</span></div>' +
        (ap.detail ? '<pre class="ok-detail">' + esc(ap.detail) + '</pre>' : '') + btns + '</div>';
    }
    if (m.kind === 'confirm') {
      const done = m.resolved ? '<div class="confirm-done">' + esc(m.resolved) + '</div>'
        : '<div class="confirm-btns"><button class="confirm-yes" data-confirm="' + esc(m.id) + '" data-yes="1">' + esc(m.yesLabel || 'Allow') + '</button><button class="confirm-no" data-confirm="' + esc(m.id) + '" data-yes="0">' + esc(m.noLabel || 'Keep') + '</button></div>';
      return '<div class="confirm-card"' + k + '><div class="confirm-text">' + esc(m.text) + '</div>' + done + '</div>';
    }
    if (m.kind === 'event') {
      const tasks = (m.tasks || []).map(t => { const a = S.byName[t.to]; return '<div class="task" data-live="' + esc(t.to) + '" style="--c:' + esc(a ? a.color : '#fff') + '"><b>' + esc(t.to) + ':</b> ' + esc(t.task.length > 260 ? t.task.slice(0, 260) + '…' : t.task) + '</div>'; }).join('');
      return '<div class="event"' + k + '>' + esc(m.text) + (tasks ? '<div class="tasks">' + tasks + '</div>' : '') + '</div>';
    }
    const cp = '<button class="mcopy" data-copy="m:' + esc(m.id) + '" title="Copy">' + ICON.copy + '</button><button class="mquote" data-quote="m:' + esc(m.id) + '" title="Reply to this: quotes it in the box">' + ICON.reply + '</button>';
    if (m.kind === 'user') {
      const imgs = (m.images || []).length ? '<div class="shots in-bubble">' + m.images.map(i => shotHTML({ src: i.url, detail: i.path })).join('') + '</div>' : '';
      return '<div class="msg user' + (m.queued ? ' queued' : '') + '"' + k + '>' + avatar('S', '#3d9be9') + '<div class="bubble">' + cp + (m.queued ? '<span class="q-tag">queued</span><button class="q-drop" data-dropq="' + esc(m.id) + '" title="Drop this queued message">×</button>' : '') + '<div class="who">You<span class="when" title="' + whenTip(m.time) + '">' + timeOf(m.time) + '</span></div>' + (m.text ? '<div class="md">' + md(m.text) + '</div>' : '') + imgs + fileChips(m.files) + '</div></div>';
    }
    const a = S.byName[m.who];
    const color = a ? a.color : '#f87171';
    const tagPill = m.live ? '<span class="tagpill live">live</span>' : m.standIn && m.standInFor ? '<span class="tagpill" title="' + esc(m.standInFor) + '’s real session was offline, so a local stand-in answered for it">stand-in for ' + esc(m.standInFor) + '</span>' : '';
    const dismiss = m.kind === 'error' ? '<button class="msg-x" data-dismiss="' + esc(m.id) + '" title="Dismiss">×</button>' : '';
    const long = m.kind === 'agent' && String(m.text || '').length > 1400 && !m.showAll;   // small detail: very long replies fold, with Show more
    const retry = m.kind === 'error' && a ? '<button class="retry-btn" data-retry="' + esc(m.id) + '" title="Send your last message to ' + esc(m.who) + ' again">↻ Try again</button>' : '';
    const sum = m.kind === 'agent' ? sumHTML('m:' + m.id, m.text, m.summary) : '';
    return '<div class="msg' + (m.kind === 'error' ? ' error' : '') + '"' + k + ' style="--c:' + esc(color) + '">' + avatar(m.who, color) + '<div class="bubble">' + cp + dismiss + '<div class="who" style="color:' + esc(color) + '"><span class="who-name"' + (a ? ' data-openbot="' + esc(m.who) + '" title="Open the chat with ' + esc(m.who) + '"' : '') + '>' + esc(m.who) + '</span>' + tagPill + '<span class="when" title="' + whenTip(m.time) + '">' + timeOf(m.time) + '</span>' + (m.expanded ? '<button class="fold-hide" data-collapse="' + esc(m.id) + '">Hide</button>' : '') + '</div><div class="md' + (long ? ' long' : '') + '">' + md(m.text) + '</div>' + (long ? '<button class="show-more" data-more="' + esc(m.id) + '">Show more</button>' : '') + ((m.images || []).length ? '<div class="shots">' + m.images.map(im => shotHTML({ src: im.url, detail: im.path })).join('') + '</div>' : '') + sum + retry + (m.chips && m.kind === 'agent' && !m.chipsUsed ? '<div class="qchips">' + m.chips.map((t, i) => '<button class="fchip qchip" data-quick="' + esc(m.id) + '" data-qi="' + i + '">' + esc(t) + '</button>').join('') + '</div>' : '') + '</div></div>';
  }
  // ---------- Summary under a long message (Storm: "a button under each bot message that gives a short summary, so he doesn't have to read
  // long messages"): Haiku writes one or two short sentences; Squall's own messages keep theirs (saved), a live session's for this run ----------
  const SUM_MIN = 500, SUMS = {};
  function sumHTML(key, text, saved) {
    if (String(text || '').length < SUM_MIN) return '';
    const s = saved ? { text: saved } : SUMS[key];
    if (s && s.text) return '<div class="sum"><b>Summary</b>' + esc(s.text) + '</div>';
    if (s && s.loading) return '<button class="sum-btn loading" disabled>Summarizing…</button>';
    return (s && s.error ? '<div class="sum err">Couldn’t summarize: ' + esc(s.error) + '</div>' : '') + '<button class="sum-btn" data-sum="' + esc(key) + '" title="A short version of this message">Summary</button>';
  }
  function sumBust(key) {
    const id = key.slice(2), c = activeChat();
    if (key[0] === 'm') { const m = c.messages.find(x => x.id === id); if (m) msgCache.delete(m); return m; }
    const mi = mirrorFor(c), e = mi && mi.entries.find(x => x.k === id);
    if (e) entryHTML.delete(e);
    return null;
  }
  async function summarize(key) {
    const text = messageTextOf(key);
    if (!text || (SUMS[key] && SUMS[key].loading)) return;
    SUMS[key] = { loading: true }; sumBust(key); renderChat();
    try {
      const s = String(await Bridge.call('summarize', { text }) || '').trim();
      SUMS[key] = { text: s };
      const m = sumBust(key);
      if (m) { m.summary = s; saveSoon(); }   // Squall's own messages keep it
      sfx('pop');
    } catch (e) { SUMS[key] = { error: e.message }; sumBust(key); }
    renderChat();
  }
  // Keeps the "working" rows' activity and timers current without re-rendering the chat.
  let wrFrame = 0;
  function updateWorkingRowsSoon() { if (!wrFrame) wrFrame = requestAnimationFrame(() => { wrFrame = 0; updateWorkingRows(); }); }
  function updateWorkingRows() {
    if (S.winMin) return;
    const mi = mirrorFor(activeChat());
    document.querySelectorAll('#chat .working-row[data-agent], #chat2 .working-row[data-agent]').forEach(row => {
      const a = S.byName[row.dataset.agent];
      const text = mi ? mirrorActivity(mi) : (a && a.activity) || '';
      const el = row.querySelector('.wr-text');
      if (el && text && el.textContent !== text) el.textContent = text;
    });
    document.querySelectorAll('.wr-time[data-since]').forEach(el => { const t = elapsedSince(el.dataset.since); if (el.textContent !== t) el.textContent = t; });
  }

  function renderComposer() {
    if (S.noteView) {
      $('#input').disabled = true; $('#input').placeholder = 'Reading a note · Back to chat to talk';
      $('#send').disabled = true; $('#targets').innerHTML = ''; $('#hint').textContent = 'Read-only: a note from your EVO vault. Click Back to chat, or a teammate, to talk.';
      return;
    }
    if (S.sessView && S.sessMirror[S.sessView]) {
      $('#input').disabled = true; $('#input').placeholder = 'Read-only: this is a session’s history';
      $('#send').disabled = true; $('#send').classList.remove('hidden'); $('#stop').classList.add('hidden');
      $('#targets').innerHTML = ''; $('#hint').textContent = 'Read-only session history. Click a teammate or a chat to talk.';
      return;
    }
    $('#input').disabled = false;
    renderCtx();
    const c = activeChat();
    const busy = !!S.flows[c.id];
    $('#targets').innerHTML = c.kind === 'dm' ? '' : c.members.map(n => { const a = S.byName[n]; const off = S.liveMode && !sessionRunning(n); return '<button class="target' + (off ? ' off' : '') + '" data-mention="' + esc(n) + '" style="--c:' + (off ? '#6b7785' : esc(a ? a.color : '#a78bfa')) + '" title="' + (off ? 'Offline: its session isn’t running' : 'Running') + '"><i></i>@' + esc(n) + '</button>'; }).join('');
    $('#send').disabled = busy;
    $('#send').classList.toggle('hidden', busy);
    $('#stop').classList.toggle('hidden', !busy);
    $('#input').placeholder = c.kind === 'dm' ? 'Message ' + c.name + '…' : c.kind === 'team' ? 'Give the team a goal… (@Name to ask someone)' : 'Message ' + c.name + '… (@Name to ask someone)';
    $('#hint').textContent = c.kind === 'dm' ? 'Enter to send · Shift+Enter for a new line · paste or drop images · Ctrl+K to jump' : 'Enter to send · Shift+Enter for a new line · Ctrl+K to jump · teammates answer each other when they write @Name';
  }

  // the right pane's tabs: one per agent, then a Sessions tab that lists every session on this PC
  function renderLiveTabs() {
    renderLiveTabsBase();
    $('#live-tabs').insertAdjacentHTML('beforeend', '<button class="ltab sessions-tab' + (S.rightMode === 'sessions' ? ' on' : '') + '" data-sessiontab="1">Sessions<span class="sess-count">' + (S.desk || []).length + '</span></button>' +
      '<button class="ltab vault-tab" data-coreshell="1" title="Open your EVO vault in Coreshell">Vault</button>' +
      '<button class="ltab todo-tab' + (S.rightMode === 'todo' ? ' on' : '') + '" data-todotab="1" title="The to-do list you, your sessions and the bots keep">To do' + (todoOpen() ? '<span class="sess-count">' + todoOpen() + '</span>' : '') + '</button>');
  }
  // Storm (19 Oct): the per-bot tabs weren't useful; the pane opens on the Team board, with the bots' Computer beside it. A bot's own steps
  // are one click away on its card (Steps), and show as a tab while open
  function renderLiveTabsBase() {
    const a = S.rightMode === 'live' ? S.byName[S.live] : null;
    $('#live-tabs').innerHTML = '<button class="ltab board-tab' + (S.rightMode === 'board' ? ' on' : '') + '" data-boardtab="1" title="Every bot at a glance">Board</button>' +
      '<button class="ltab comp-tab' + (S.rightMode === 'computer' ? ' on' : '') + '" data-comptab="1" title="Squall’s own computer (Starx): watch it, click, type">Starx</button>' +
      (window.SquallUnoUI ? '<button class="ltab uno-tab' + (S.rightMode === 'uno' ? ' on' : '') + '" data-unotab="1" title="Squall Uno: every agent’s own computer, live">Uno' + (window.SquallUnoUI.liveCount() ? '<span class="sess-count uno-live-count">' + window.SquallUnoUI.liveCount() + '</span>' : '') + '</button>' : '') +
      (a ? '<button class="ltab on' + (agentBusy(a) ? ' working' : '') + '" data-live="' + esc(a.name) + '" style="--c:' + esc(a.color) + '"><i></i>' + esc(a.name) + '</button>' : '');
  }
  // ---------- the team board: a card per bot with what it's doing, its task, its last result and the files it touched ----------
  const PATH_RX = /[A-Za-z]:\\[^\s"'`<>|*?]+\.[A-Za-z0-9]{1,6}/g;
  function boardFacts(a) {
    const mi = S.liveMode ? S.mirror[a.name] : null, busy = agentBusy(a), chat = chatById('dm:' + a.name);
    const needs = !!(a.needsOk || (mi && mirrorNeedsYou(mi)));
    const doing = busy ? (mi ? mirrorActivity(mi) : a.activity) || 'Working' : needs ? 'Waiting for you' : mi ? (mirrorLive(a.name) ? 'Idle' : 'Not running') : 'Idle';
    let task = null;
    try { task = (TODO.items || []).find(i => i.status === 'doing' && i.who === a.name); } catch (e) { }   // the to-do list loads after the first render
    let last = '', files = [];
    const es = mi ? mi.entries || [] : [];
    for (let i = es.length - 1; i >= 0 && (!last || files.length < 3) && i >= es.length - 200; i--) {
      const e = es[i];
      if (!last && e.role === 'assistant' && e.text) last = e.text;
      if (e.role === 'tool' && /\b(Edit|Write|MultiEdit|NotebookEdit)\b/.test(e.text || e.name || '')) for (const p of String(e.text || '').match(PATH_RX) || []) { const f = p.split('\\').pop(); if (files.indexOf(f) < 0 && files.length < 3) files.push(f); }
    }
    if (!last && chat) { const m = chat.messages.slice().reverse().find(x => x.who === a.name && x.text && !x.kind); if (m) last = m.text; }
    last = String(last || '').replace(/```[\s\S]*?```/g, ' ').replace(/`([^`]*)`/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_#>]+/g, '').replace(/\s+/g, ' ').trim();
    return { busy, needs, doing, task, last: last.slice(0, 170), files };
  }
  function renderBoardPane() {
    const body = $('#live-body');
    const cards = S.agents.map(a => {
      const f = boardFacts(a);
      return '<div class="bd-card' + (f.busy ? ' busy' : '') + (f.needs ? ' needs' : '') + '" data-k="bd-' + esc(a.name) + '" style="--c:' + esc(a.color) + '">' +
        '<div class="bd-top" data-chat="dm:' + esc(a.name) + '" title="Open ' + esc(a.name) + '’s chat">' + avWrap('a:' + a.name, f.busy) + avatar(a.name, a.color) + '</div>' +
        '<div class="bd-id"><b>' + esc(a.name) + '</b><span class="bd-doing">' + esc(f.doing) + '</span></div></div>' +
        (f.task ? '<div class="bd-row"><i>Task</i><span>' + esc(f.task.text) + '</span></div>' : '') +
        (f.last ? '<div class="bd-row"><i>Last</i><span>' + esc(f.last) + '</span></div>' : '') +
        (f.files.length ? '<div class="bd-row"><i>Files</i><span class="bd-files">' + f.files.map(x => '<code>' + esc(x) + '</code>').join('') + '</span></div>' : '') +
        '<div class="bd-acts"><button data-chat="dm:' + esc(a.name) + '">Chat</button><button data-live="' + esc(a.name) + '">Steps</button></div></div>';
    }).join('');
    const working = S.agents.filter(a => agentBusy(a)).length;
    patchHTML(body, '<div class="board" data-k="board"><div class="bd-head"><b>Team</b><span>' + working + ' working · ' + (S.agents.length - working) + ' idle</span></div>' + cards + '</div>');
    $('#live-foot').innerHTML = '<span>Click a bot to open its chat · Steps shows its work</span>';
  }
  // ---------- the bots' computer: Starx, the Orbit PC. Its live screen (or its last picture when it's off), what the bots have on it, and a click to take over.
  // Squall never starts or stops the VM; Nimbus owns that (Storm, 22 Oct: "Get the computer in Squall") ----------
  let compHave = '', compSize = { w: 1280, h: 800 }, compBusy = false;
  function renderComputerPane() {
    const body = $('#live-body');
    if (!body.querySelector('.comp')) {
      patchHTML(body, '<div class="comp" data-k="comp"><button class="comp-reopen" data-compwin="open">Show the Starx screen</button><div class="comp-screen"><div class="comp-bar" title="Double-click to maximize or restore"><i data-compwin="close" title="Hide the Starx pane (Starx keeps running)"></i><i data-compwin="min" title="Collapse to the title bar"></i><i data-compwin="max" title="Maximize (Esc restores)"></i><span>Starx</span><em class="comp-state">checking…</em><button class="comp-maxbtn" data-compwin="max" title="Fill the Squall window with the Starx screen (Esc restores)">Maximize</button></div>' +
        '<div class="comp-pic" tabindex="0" title="Click the screen, then type: your keys go to Starx"><img alt="" draggable="false"><div class="comp-off-note"></div></div></div>' +
        '<div class="comp-acts" style="display:flex;gap:6px;align-items:center;margin:6px 0;flex-wrap:wrap"><button data-compdo="start">Start</button><button data-compdo="stop">Stop</button>' +
        '<button data-compdo="kb">Keyboard</button><button data-compdo="paste" title="Type your clipboard into Starx">Paste</button><span class="comp-kb" style="opacity:.7;font-size:12px"></span></div>' +
        '<div class="comp-who"></div></div>');
      compHave = ''; compUi.max = false;
    }
    compApplyUi();
    pollComputer();
  }
  // groky r216 (Storm, 28 Oct: "I can't even maximize it or anything"): the window dots work. Green, the Maximize button or a double-click on the
  // title bar fills the Squall window with the Starx screen (aspect kept, clicks and keys still go to Starx); Esc or the button again restores.
  // Yellow collapses the pane to its title bar; red hides the pane (Starx keeps running) and leaves a Show button.
  const compUi = { max: false, min: false, closed: false };
  function compApplyUi() {
    const root = document.querySelector('#live-body .comp'); if (!root) return;
    const max = compUi.max && !compUi.closed;
    root.classList.toggle('comp-max', max); root.classList.toggle('comp-min', compUi.min && !max); root.classList.toggle('comp-closed', compUi.closed);
    document.querySelectorAll('.comp-max-anc').forEach(e => e.classList.remove('comp-max-anc'));
    if (max) for (let e = root.parentElement; e && e !== document.body; e = e.parentElement) e.classList.add('comp-max-anc');
    const b = root.querySelector('.comp-maxbtn'); if (b) { b.textContent = max ? 'Restore' : 'Maximize'; b.title = max ? 'Back to the side pane (Esc)' : 'Fill the Squall window with the Starx screen (Esc restores)'; }
    const g = root.querySelector('.comp-bar i[data-compwin="max"]'); if (g) g.title = max ? 'Restore (Esc)' : 'Maximize (Esc restores)';
    const y = root.querySelector('.comp-bar i[data-compwin="min"]'); if (y) y.title = compUi.min ? 'Expand the Starx pane' : 'Collapse to the title bar';
  }
  function compWin(what) {
    if (what === 'max') { compUi.max = !compUi.max; if (compUi.max) compUi.min = false; }
    else if (what === 'min') { compUi.min = !compUi.min; if (compUi.min) compUi.max = false; }
    else if (what === 'close') { compUi.closed = true; compUi.max = false; }
    else if (what === 'open') { compUi.closed = false; compUi.min = false; }
    compApplyUi();
    if (!compUi.closed) pollComputer();
  }
  document.addEventListener('click', ev => {
    const w = ev.target && ev.target.closest ? ev.target.closest('#live-body [data-compwin]') : null;
    if (!w) return; ev.preventDefault(); compWin(w.getAttribute('data-compwin'));
  });
  document.addEventListener('dblclick', ev => {
    const bar = ev.target && ev.target.closest ? ev.target.closest('#live-body .comp-bar') : null;
    if (!bar || ev.target.closest('[data-compwin]')) return; ev.preventDefault(); compWin('max');
  });
  // Esc restores a maximized Starx. While the keyboard passthrough is on, plain Esc still goes to Starx and Shift+Esc restores
  document.addEventListener('keydown', ev => {
    if (ev.key !== 'Escape' || !compUi.max || S.rightMode !== 'computer') return;
    if (compKb && !ev.shiftKey && ev.target && ev.target.closest && ev.target.closest('#live-body .comp-pic')) return;
    ev.preventDefault(); ev.stopImmediatePropagation(); compWin('max');
  }, true);
  // one request at a time: the bridge answers at once when Starx is off, and within about a tenth of a second when it is up
  function pollComputer() {
    if (compBusy || S.rightMode !== 'computer' || compUi.closed) return;
    compBusy = true;
    Bridge.call('orbitPcView', { have: compHave })
      .then(v => paintComputer(v))
      .catch(() => paintComputer(null))
      .finally(() => { compBusy = false; });
  }
  function paintComputer(v) {
    const root = document.querySelector('#live-body .comp');
    if (!root) return;
    const pic = root.querySelector('.comp-pic'), img = root.querySelector('.comp-pic img'), st = root.querySelector('.comp-state');
    if (!v) { st.textContent = 'not connected'; pic.classList.remove('live'); pic.classList.add('off'); root.querySelector('.comp-off-note').textContent = 'When Starx is hooked up, you’ll watch the bots use their own computer here, live, and can take over with a click.'; root.querySelector('.comp-who').textContent = ''; $('#live-foot').innerHTML = '<span>Starx: not connected</span>'; return; }
    if (v.w && v.h) compSize = { w: v.w, h: v.h };
    if (v.image) img.src = v.image;
    if (v.imageKey) compHave = v.imageKey;
    const live = v.state === 'running';
    const label = { running: 'live', booting: 'starting', stopped: 'stopped', off: 'off' }[v.state] || v.state;
    pic.classList.toggle('live', live);
    pic.classList.toggle('off', !live);
    st.textContent = label + (live && v.desk ? ' · desktop ' + v.desk : '');
    root.querySelector('.comp-off-note').textContent = live ? '' : (v.state === 'off' ? 'Starx is off. Press Start to turn it on.' : 'Starx is ' + label + '.') + (v.imageAt ? ' Last picture ' + timeOf(v.imageAt) + '.' : '');
    const bots = (v.desks || []).filter(d => d.bot).map(d => d.bot + ' on desktop ' + d.n);
    root.querySelector('.comp-who').textContent = live ? (v.claim ? v.claim + ' has the screen' : 'Nobody has the screen') + (bots.length ? ' · ' + bots.join(', ') : '') : '';
    $('#live-foot').innerHTML = '<span>Starx: ' + esc(label) + (live ? ' · click the picture to take over' : '') + '</span>';
  }
  // a click on the live picture is Storm's own input to the Orbit PC (the bots' claims never refuse it); the letterbox around it is not the screen
  document.addEventListener('click', ev => {
    const img = ev.target && ev.target.closest ? ev.target.closest('.comp-pic.live img') : null;
    if (!img) return;
    const r = img.getBoundingClientRect(), k = Math.min(r.width / compSize.w, r.height / compSize.h);
    const x = Math.round((ev.clientX - r.left - (r.width - compSize.w * k) / 2) / k), y = Math.round((ev.clientY - r.top - (r.height - compSize.h * k) / 2) / k);
    if (x < 0 || y < 0 || x >= compSize.w || y >= compSize.h) return;
    Bridge.call('orbitPcClick', { x, y }).then(res => { if (res && !res.ok) $('#live-foot').innerHTML = '<span>Starx: ' + esc(res.error || 'the click did not go through') + '</span>'; }).catch(() => { });
  });
  setInterval(() => { if (!S.winMin && S.rightMode === 'computer' && !isIdle()) pollComputer(); }, 1000);
  // ---------- Starx tab (27 Oct): Start/Stop Squall's own Orbit PC, and a keyboard passthrough. Click the screen (or Keyboard) and keys go to
  // Starx until you click elsewhere; one request at a time, in order ----------
  let compQ = Promise.resolve(), compKb = false;
  function compSay(t) { $('#live-foot').innerHTML = '<span>Starx: ' + esc(t) + '</span>'; }
  function compSend(op, args) { compQ = compQ.then(() => Bridge.call(op, args)).then(r => { if (r && r.ok === false) compSay(r.error || 'that did not go through'); }).catch(() => { }); return compQ; }
  function compKbOn(on) { compKb = on; const k = document.querySelector('#live-body .comp-kb'); if (k) k.textContent = on ? 'Keyboard on: your keys go to Starx' : ''; const p = document.querySelector('#live-body .comp-pic'); if (p) p.style.outline = on ? '2px solid #4c9' : ''; }
  const COMP_KEYS = { Enter: 'Return', Backspace: 'BackSpace', Tab: 'Tab', Escape: 'Escape', Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'Prior', PageDown: 'Next', ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', Insert: 'Insert', ' ': 'space' };
  document.addEventListener('click', ev => {
    const b = ev.target && ev.target.closest ? ev.target.closest('[data-compdo]') : null;
    const pic = ev.target && ev.target.closest ? ev.target.closest('#live-body .comp-pic') : null;
    if (pic) { pic.focus(); compKbOn(true); }
    else if (!b) compKbOn(false);
    if (!b) return;
    const d = b.getAttribute('data-compdo');
    if (d === 'start') { compSay('starting…'); Bridge.call('orbitPcStart', {}).then(r => (r && r.ok && !r.already && sfx('starxOn'), compSay(r && r.ok ? (r.already ? 'already on' : 'starting, the screen shows up in a few seconds') : (r && r.error) || 'could not start'))).catch(() => { sfx('error'); compSay('could not start'); }); }
    else if (d === 'stop') { if (!confirm('Turn Starx off? Anything running in it stops.')) return; compSay('stopping…'); Bridge.call('orbitPcStop', {}).then(r => { if (r && r.ok) sfx('starxOff'); compSay(r && r.ok ? 'stopping' : (r && r.error) || 'could not stop'); }).catch(() => { sfx('error'); compSay('could not stop'); }); }
    else if (d === 'kb') { const p = document.querySelector('#live-body .comp-pic'); if (p) p.focus(); compKbOn(true); }
    else if (d === 'paste') Bridge.call('clipboardRead', {}).then(t => { if (t) compSend('orbitPcType', { text: String(t) }); }).catch(() => { });
  }, true);
  document.addEventListener('keydown', ev => {
    if (!compKb || S.rightMode !== 'computer' || !ev.target || !ev.target.closest || !ev.target.closest('#live-body .comp-pic')) return;
    const k = ev.key; if (k === 'Shift' || k === 'Control' || k === 'Alt' || k === 'Meta' || k === 'CapsLock') return;
    ev.preventDefault(); ev.stopPropagation();
    if (ev.ctrlKey && !ev.altKey && (k === 'v' || k === 'V') && ev.shiftKey) { Bridge.call('clipboardRead', {}).then(t => { if (t) compSend('orbitPcType', { text: String(t) }); }).catch(() => { }); return; }
    let name = COMP_KEYS[k] || (/^F\d{1,2}$/.test(k) ? k : null);
    if (!name && k.length === 1 && !ev.ctrlKey && !ev.altKey && !ev.metaKey) { compSend('orbitPcType', { text: k }); return; }
    if (!name && k.length === 1) name = k.toLowerCase();
    if (!name) return;
    const mods = (ev.ctrlKey ? 'ctrl+' : '') + (ev.altKey ? 'alt+' : '') + (ev.shiftKey && k.length !== 1 ? 'shift+' : '') + (ev.metaKey ? 'super+' : '');
    compSend('orbitPcKey', { keys: mods + name });
  }, true);
  setInterval(() => { if (!S.winMin && S.rightMode === 'board' && !isIdle()) renderBoardPane(); }, 3000);

  // ---------- idle: nobody is watching. Storm, 22 Oct: this page burned about 1.5 cores all night with nobody at the screen. Hidden, or no input for
  // three minutes: the CSS animations pause, and the redraws nobody can see are held until the next input (or the window coming back). The self-test is never idle ----------
  var IDLE_MS = 3 * 60000, lastInput = Date.now(), idleOn = false, redrawHeld = false, flushing = false;
  var idleStyle = document.createElement('style');
  idleStyle.textContent = 'html.idle *, html.idle *::before, html.idle *::after { animation-play-state: paused !important; }';
  document.head.appendChild(idleStyle);
  function isIdle() { return !S.selftest && (document.hidden || Date.now() - lastInput > IDLE_MS); }
  function idleCheck() {
    const now = isIdle();
    if (now === idleOn) return;
    idleOn = now;
    document.documentElement.classList.toggle('idle', now);
    if (!now && redrawHeld) { redrawHeld = false; renderAll(); }
  }
  // true when nobody can see a redraw: it is held, and the next input draws it
  function redrawHold() { if (flushing || !isIdle()) return false; redrawHeld = true; return true; }
  ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'focus'].forEach(ev => window.addEventListener(ev, () => { lastInput = Date.now(); idleCheck(); }, { passive: true, capture: true }));
  document.addEventListener('visibilitychange', idleCheck);
  setInterval(idleCheck, 15000);
  // a page left on screen with nobody touching it: held redraws still land every 15 s, so it is never stale for long
  setInterval(() => { if (redrawHeld && !document.hidden && !flushing) { flushing = true; redrawHeld = false; try { renderAll(); } finally { flushing = false; } } }, 15000);
  idleCheck();
  // ---------- the Uno tab: every agent's own Squall Uno computer at a glance (the cards open the live view in the centre) ----------
  function renderUnoPane() {
    patchHTML($('#live-body'), window.SquallUnoUI ? window.SquallUnoUI.paneHTML() : '<div class="live-empty" data-k="none">Squall Uno isn’t loaded</div>');
    $('#live-foot').innerHTML = '<span>Start a task above, or click a computer to watch it live</span>';
  }
  let unoPaneTimer = 0;
  function unoPaneSoon() {
    if (unoPaneTimer) return;
    unoPaneTimer = setTimeout(() => { unoPaneTimer = 0; if (S.rightMode === 'uno') renderLive(); else if (!S.winMin && !redrawHold()) renderLiveTabs(); }, 120);
  }
  function renderLive() {
    if (redrawHold()) return;
    if (S.winMin) { S.renderPending = true; return; }
    if (S.rightMode === 'board') { renderLiveTabs(); renderBoardPane(); return; }
    if (S.rightMode === 'computer') { renderLiveTabs(); renderComputerPane(); return; }
    if (S.rightMode === 'uno') { renderLiveTabs(); renderUnoPane(); return; }
    if (S.rightMode === 'sessions') { renderLiveTabs(); renderSessionsPane(); return; }
    if (S.rightMode === 'vault') { renderLiveTabs(); renderVaultPane(); return; }
    if (S.rightMode === 'todo') { renderLiveTabs(); renderTodoPane(); return; }
    renderLiveTabs();
    const a = S.byName[S.live];
    const body = $('#live-body');
    if (!a) { patchHTML(body, '<div class="live-empty" data-k="none">No agent selected</div>'); $('#live-foot').innerHTML = ''; return; }
    const stick = body.scrollHeight - body.scrollTop - body.clientHeight < 60;
    const mi = S.liveMode ? S.mirror[a.name] : null;
    const busy = agentBusy(a);
    const doing = mi && !a.turns.length ? (busy ? mirrorActivity(mi) : 'Real session · idle') : (a.activity || '');
    const pill = mi && mirrorNeedsYou(mi) ? '<span class="st-pill ask"><i></i>Needs you</span>' : busy ? '<span class="st-pill on"><i></i>Working</span>' : a.status === 'error' ? '<span class="st-pill err"><i></i>Error</span>' : a.status === 'stopped' ? '<span class="st-pill warn"><i></i>Stopped</span>' :
      a.status === 'done' ? '<span class="st-pill done"><i></i>Done</span>' : mi ? '<span class="st-pill"><i></i>Idle</span>' : '';
    // who this is and what it's doing, pinned at the top while its work scrolls underneath
    const stopBtn = busy ? '<button class="lp-stop" data-act="stopagent" data-agent="' + esc(a.name) + '" title="' + (mi ? 'Ask this session to stop now (it sees it at its next step)' : 'Stop this bot now') + '">Stop</button>' : '';
    const head = '<div class="lp-head" data-k="head" style="--c:' + esc(a.color) + '">' + avWrap('a:' + a.name, busy) + avatar(a.name, a.color) + '</div>' +
      '<div class="lp-id"><div class="lp-name">' + esc(a.name) + pill + stopBtn + '</div><div class="lp-doing">' + esc(doing) + '</div></div></div>';
    let content;
    if (!a.turns.length && mi) content = '<div class="live-empty small" data-k="mirror">' + esc(a.name) + '’s conversation is in its chat.</div>';
    else if (!a.turns.length) content = '<div class="live-empty" data-k="new">' + (busy ? 'Getting started…' : esc(a.name) + ' hasn’t worked on anything yet.') + '</div>';
    else content = a.turns.map((t, i) => {
      const last = i === a.turns.length - 1;
      const tools = t.tools.map(tool => '<div class="tool ' + tool.status + '"><span class="ti">' + toolIcon(tool.name) + '</span><span class="tt">' + esc(toolSummary(tool)) + '</span><span class="ts">' + (tool.status === 'running' ? 'working' : tool.status) + '</span></div>').join('');
      const text = t.text ? (isWorking(a) && last ? '<div class="stream">' + esc(t.text) + '<span class="cursor"></span></div>' : '<div class="md">' + md(stripTasks(t.text)) + '</div>') : '';
      const shots = (t.images || []).length ? '<div class="shots">' + t.images.map(im => shotHTML({ src: im.url, detail: im.path })).join('') + '</div>' : '';
      return '<div class="turn" data-k="t' + i + '">' + tools + shots + text + '</div>';
    }).join('');
    if (mi) content = runsHTML(mi) + content;   // a live session's subagents and workflows, above anything else
    patchHTML(body, head + content);
    if (stick || isWorking(a)) body.scrollTop = body.scrollHeight;
    const bits = [];
    if (a.model) bits.push(esc(prettyModel(a.model)));
    if (a.numTurns != null) bits.push(a.numTurns + ' turn' + (a.numTurns === 1 ? '' : 's'));
    if (a.duration != null) bits.push((a.duration / 1000).toFixed(1) + ' s');
    if (a.cost) bits.push('$' + Number(a.cost).toFixed(3));
    $('#live-foot').innerHTML = bits.map(b => '<span>' + b + '</span>').join('') + '<button data-act="folder" data-agent="' + esc(a.name) + '">' + ICON.folder + 'Open folder</button>';
  }
  let liveTimer = 0;
  function renderLiveSoon() { if (!liveTimer) liveTimer = requestAnimationFrame(() => { liveTimer = 0; renderLive(); }); }

  // Stop on the right pane (Storm: "There's not a stop button"). A bot's run is killed; a live session is asked to stop,
  // and it sees the message at its next step (Squall can't press Stop inside the Claude app). A running work timer is stopped too.
  const STOP_TEXT = 'Storm pressed Stop in Squall. Stop now: cancel any running or waiting command, start nothing new, and end your turn with one line saying where you stopped.';
  function readNow(name) {
    const chat = chatById('dm:' + name);
    if (!chat) return;
    if (!controlOn()) { addMessage(chat, { who: APP, kind: 'error', text: 'Squall Control isn’t running, so Squall can’t make ' + name + ' read now. It reads your messages at its next step.' }); return; }
    sfx('swoosh');
    S.controlChat = chat.id;
    liveSend(CONTROL, 'Squall (control): stop the session "' + name + '".').then(r => {
      addMessage(chat, { who: APP, kind: r.ok ? 'event' : 'error', text: r.ok ? '⏩ ' + name + ' stops its current step and reads your messages now.' : 'Couldn’t reach Squall Control: ' + (r.note || 'not running') });
    });
  }
  function stopAgentNow(name) {
    const a = S.byName[name];
    if (!a) return;
    driveOf(name).held = true;   // the To do drive waits until he writes to it again
    const chat = chatById('dm:' + name);
    const mi = S.liveMode && !NO_RELAY() ? S.mirror[name] : null;   // direct: Squall's own run of the session stops (the else branch)
    Object.keys(S.timers).forEach(id => { const c = chatById(id); if (c && c.kind === 'dm' && c.members[0] === name) stopTimer(id, true); });
    if (mi && chat && controlOn()) {
      // Squall Control presses the session's real Stop, at once
      S.controlChat = chat.id;
      liveSend(CONTROL, 'Squall (control): stop the session "' + name + '".').then(r => {
        addMessage(chat, { who: APP, kind: r.ok ? 'event' : 'error', text: r.ok ? '⏹ Asked Squall Control to stop ' + name + '.' : 'Couldn’t reach Squall Control: ' + (r.note || 'not running') });
      });
    } else if (mi && chat) {
      if (sendToMirror(chat, STOP_TEXT, [], [], APP + ' (stop): ')) addMessage(chat, { who: APP, kind: 'event', text: '⏹ Asked ' + name + ' to stop. A live session sees it at its next step.' });
    } else {
      Bridge.call('stop', { agent: name }).catch(() => {});
      if (chat) addMessage(chat, { who: APP, kind: 'event', text: '⏹ Stopped ' + name + '.' });
    }
    renderLiveSoon();
  }

  // ---------- resizable sidebars: drag the inner edge of the team column or the right pane; double-click puts it back ----------
  // rail: the strip's team rail (Storm, 19 Oct: "the sidebar can't resize"); wide enough, the bots' names show beside their avatars
  const SIDE = { left: { min: 160, max: 420, def: 220 }, right: { min: 280, max: 760, def: 400 }, rail: { min: 50, max: 220, def: 50 } };
  const RAIL_NAMES_AT = 110;
  function applySides() {
    const st = document.documentElement.style;
    st.setProperty('--left-w', (S.sides.left || SIDE.left.def) + 'px');
    st.setProperty('--right-w', (S.sides.right || SIDE.right.def) + 'px');
    const rail = S.sides.rail || SIDE.rail.def;
    st.setProperty('--rail-w', rail + 'px');
    document.body.classList.toggle('rail-wide', rail >= RAIL_NAMES_AT);
  }
  function setupSplitters() {
    for (const side of ['left', 'right']) {
      const host = side === 'left' ? $('#team') : $('#live');
      if (!host || host.querySelector(':scope > .splitter')) continue;
      const h = document.createElement('div');
      h.className = 'splitter ' + side;
      h.title = 'Drag to resize · double-click to reset';
      host.appendChild(h);
      h.addEventListener('pointerdown', e => {
        e.preventDefault();
        try { h.setPointerCapture(e.pointerId); } catch (x) { }
        h.classList.add('drag'); document.body.classList.add('resizing');
        const box = $('#app').getBoundingClientRect(), key = side === 'left' && stripOn ? 'rail' : side, lim = SIDE[key];
        const move = ev => {
          const other = key === 'rail' ? 0 : side === 'left' ? (S.sides.right || SIDE.right.def) : (S.sides.left || SIDE.left.def);
          let w = side === 'left' ? ev.clientX - box.left - (key === 'rail' ? 6 : 8) : box.right - ev.clientX - 8;
          w = Math.max(lim.min, Math.min(lim.max, w, box.width - other - 380));   // the chat keeps about 360 px
          S.sides[key] = Math.round(w);
          applySides();
        };
        const up = () => {
          try { h.releasePointerCapture(e.pointerId); } catch (x) { }
          h.classList.remove('drag'); document.body.classList.remove('resizing');
          h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up);
          saveSoon();
        };
        h.addEventListener('pointermove', move);
        h.addEventListener('pointerup', up);
      });
      h.addEventListener('dblclick', () => { delete S.sides[side === 'left' && stripOn ? 'rail' : side]; applySides(); saveSoon(); });
    }
  }

  function renderBanner(nudge) {
    const b = $('#banner');
    b.className = 'banner hidden';
    if (S.mock) { b.className = 'banner'; b.innerHTML = '<span class="grow"><b>Demo mode.</b> The agents are simulated; nothing uses your Claude account.</span>'; return; }
    if (!S.info.claudeFound) { b.className = 'banner warn'; b.innerHTML = '<span class="grow">Claude Code isn’t installed where ' + APP + ' looked (' + esc(S.info.claude || '') + ').</span>'; return; }
    if (S.signedIn === false) {
      b.className = 'banner' + (nudge ? ' warn' : '');
      b.innerHTML = '<span class="grow"><b>One-time sign-in.</b> ' + APP + ' runs Claude Code with your own Claude account. Click Sign in, finish it in the browser, then come back.</span>' +
        '<button class="primary" data-act="signin">Sign in</button><button data-act="recheck">I’ve signed in</button>';
      return;
    }
    if (teamPaused()) {
      b.className = 'banner paused';
      b.innerHTML = '<span class="grow"><b>⏸ Team paused</b> ' + esc(pausedFor()) + '. Nothing starts by itself: no routines, wake-ups, idle work or To do drive. Your own messages still go through.</span>' +
        '<button class="primary" data-act="resumeteam">Resume</button>';
      return;
    }
    if (S.liveMode && S.link.status === 'error') {
      b.className = 'banner warn';
      b.innerHTML = '<span class="grow"><b>Live link problem.</b> ' + esc(S.link.error || 'It stopped.') + ' Replies come from local stand-ins until it’s back.</span><button data-act="relink">Reconnect</button>';
      return;
    }
    if (S.liveMode && S.link.status === 'on' && !S.mock && !S.liveNoteHidden) {
      const live = S.agents.filter(a => { const p = peerFor(a.name); return p && p.status !== 'offline'; }).map(a => a.name);
      if (live.length < S.agents.length) {
        b.className = 'banner';
        b.innerHTML = '<span class="grow"><b>Live:</b> ' + (live.length ? esc(live.join(', ')) + (live.length === 1 ? ' is' : ' are') + ' running on this PC and will answer for real.' : 'none of the team is running on this PC yet.') +
          ' The others answer as local stand-ins. Live mode reaches Claude sessions on the same PC, so run ' + APP + ' on LIGHTNING to talk to the whole team for real.</span>' +
          '<button class="x" data-act="hidelivenote" title="Got it (hide this note)">×</button>';
      }
    }
  }

  // groky r96: unread count from other chats leads the window title so it shows on the taskbar; only sent to the host when it changes
  let lastTitle = '';
  function updateTitle() {
    const unreadN = S.chats.reduce((n, x) => n + (x.id !== S.active && x.id !== S.split ? (x.unread || 0) : 0), 0);
    const c = activeChat();
    const working = Object.keys(S.flows).length > 0;
    const waiting = S.liveMode ? Object.keys(S.mirror).filter(n => mirrorNeedsYou(S.mirror[n])) : [];
    const title = (unreadN ? '(' + (unreadN > 99 ? '99+' : unreadN) + ') ' : '') + APP + ' · ' + c.name + (working ? ' · working…' : '') + (waiting.length ? ' · ' + waiting.join(', ') + ' needs you' : '');
    if (title === lastTitle) return; lastTitle = title;
    Bridge.call('setTitle', { title }).catch(() => {});
  }

  function renderAll() { if (redrawHold()) return; renderTeam(); renderChatHead(); renderChat(); renderComposer(); renderLive(); renderStripSwitch(); }

  // ---------- events ----------
  function autosize() { const t = $('#input'); t.style.height = 'auto'; t.style.height = Math.min(220, t.scrollHeight) + 'px'; }
  function showLive(n) { S.live = n; S.rightMode = 'live'; renderLive(); }
  function insertMention(n) {
    const t = $('#input');
    const add = (t.value && !/\s$/.test(t.value) ? ' ' : '') + '@' + n + ' ';
    t.value += add; autosize(); t.focus();
  }

  document.addEventListener('click', e => {
    const t = e.target;
    const link = t.closest('a[data-url]');
    if (link) { e.preventDefault(); Bridge.call('openExternal', { url: link.dataset.url }).catch(() => {}); return; }
    const copy = t.closest('.copy');
    if (copy) { const code = copy.parentElement.querySelector('code'); if (code) /* groky r88: copied / failed state */ navigator.clipboard.writeText(code.textContent).then(() => { clearTimeout(copy._r88); copy.classList.remove('copy-fail'); copy.classList.add('copied'); copy.textContent = 'Copied'; copy._r88 = setTimeout(() => { copy.textContent = 'Copy'; copy.classList.remove('copied'); }, 1400); }, () => { clearTimeout(copy._r88); copy.classList.remove('copied'); copy.classList.add('copy-fail'); copy.textContent = 'Couldn’t copy'; copy._r88 = setTimeout(() => { copy.textContent = 'Copy'; copy.classList.remove('copy-fail'); }, 1800); }); return; }
    if (!t.closest('#strip-switch')) closeStripMenu();
    if (!t.closest('.td-pop') && !t.closest('#timer')) closeTimerDial();
    if (!t.closest('.mm-pop') && !t.closest('#model')) closeModelMenu();
    if (!t.closest('.cx-pop') && !t.closest('#ctx')) closeCtxMenu();
    if (!t.closest('.use-pop') && !t.closest('#usage')) closeUsageMenu();
    const dz = t.closest('[data-dismiss]');
    if (dz) { dismissMessage(dz.dataset.dismiss); return; }
    const dq = t.closest('[data-dropq]');
    if (dq) { dismissMessage(dq.dataset.dropq); return; }   // × on a queued message: it is dropped, not sent
    const lm = t.closest('[data-livemodel]');
    if (lm) { switchLiveModel(lm.dataset.livemodel); return; }
    const mm = t.closest('[data-model]');
    if (mm) { setModel(mm.dataset.model); return; }
    if (t.closest('.modal-back')) return;
    if (t.closest('.lightbox img') || (lbZ.moved && t.closest('.lightbox'))) { lbZ.moved = false; return; } /* groky r91: clicking or dragging the image no longer closes the viewer */
    const lbs = t.closest('[data-lbstep]'); /* groky r90: side buttons step images instead of closing */
    if (lbs) { lbStep(+lbs.dataset.lbstep); return; }
    if (t.closest('.lightbox')) { closeLightbox(); return; }
    const un = t.closest('[data-unattach]');
    if (un) { S.attach.splice(+un.dataset.unattach, 1); renderAttach(); $('#input').focus(); return; }
    const cpb = t.closest('[data-copy]');
    if (cpb) { copyMessage(cpb); return; }
    const qtb = t.closest('[data-quote]');
    if (qtb) { quoteMessage(qtb); return; }
    const rtb = t.closest('[data-retry]');
    if (rtb) { retryFrom(rtb.dataset.retry); return; }
    const smb = t.closest('[data-sum]');
    if (smb) { summarize(smb.dataset.sum); return; }
    const rnb = t.closest('[data-readnow]');
    if (rnb) { readNow(rnb.dataset.readnow); return; }
    const sfb = t.closest('[data-sentfold]');
    if (sfb) { const key = sfb.dataset.sentfold; openSent.has(key) ? openSent.delete(key) : openSent.add(key); const mi = mirrorFor(activeChat()), e = mi && mi.entries.find(x => x.k === key); if (e) entryHTML.delete(e); sfx('toggle'); renderChat(); return; }
    const qk = t.closest('[data-quick]');
    if (qk) { useGreetChip(qk.dataset.quick, qk.dataset.qi); return; }
    const rv = t.closest('[data-reveal]');
    if (rv) { Bridge.call('revealFile', { path: rv.dataset.reveal }).catch(err => addMessage(activeChat(), { who: APP, kind: 'error', text: err.message })); return; }
    const sr = t.closest('[data-sess]');
    if (sr) { openSession(sr.dataset.sess); return; }
    if (t.closest('[data-boardtab]')) { S.rightMode = 'board'; renderLive(); return; }
    // the Vault button opens Coreshell (Storm, 19 Oct: "Put coreshell into the vault button")
    if (t.closest('[data-coreshell]')) { Bridge.call('openCoreshell').catch(err => addMessage(activeChat(), { who: APP, kind: 'error', text: 'Couldn’t open Coreshell: ' + err.message })); return; }
    if (t.closest('[data-comptab]')) { S.rightMode = 'computer'; renderLive(); return; }
    if (t.closest('[data-unotab]')) { S.rightMode = 'uno'; renderLive(); if (window.SquallUnoUI) window.SquallUnoUI.refresh(); return; }
    const ttb = t.closest('[data-todotab]');
    if (ttb) { S.rightMode = 'todo'; renderLive(); todoLoad(); return; }
    const tdo = t.closest('[data-todo]');
    if (tdo) { const id = tdo.dataset.id, act = tdo.dataset.todo; if (act === 'del') todoDel(id); else todoSet(id, act === 'undo' ? 'todo' : act); return; }
    const vtb = t.closest('[data-vaulttab]');
    if (vtb) { S.rightMode = 'vault'; renderLive(); return; }
    const wl = t.closest('[data-note]');
    if (wl) { e.preventDefault(); const ni = noteIndex(wl.dataset.note); if (ni !== undefined) openNote(VG.nodes[ni].path); return; }
    const stb = t.closest('[data-sessiontab]');
    if (stb) { S.rightMode = 'sessions'; renderLive(); return; }
    const shot = t.closest('[data-shot]');
    if (shot) { openLightbox(shot.dataset.shot, shot.dataset.cap, shot); return; }
    const steps = t.closest('[data-steps]');
    if (steps) { const k = steps.dataset.steps; openSteps.has(k) ? openSteps.delete(k) : openSteps.add(k); renderChat(); return; }
    if (!t.closest('.bot-menu')) closeBotMenu();
    const ob = t.closest('[data-openbot]');
    if (ob && chatById('dm:' + ob.dataset.openbot) && S.active !== 'dm:' + ob.dataset.openbot) { openChat('dm:' + ob.dataset.openbot); return; }
    const more = t.closest('[data-more]');
    if (more) { const mm = findMsg(more.dataset.more); if (mm) { mm.showAll = true; msgCache.delete(mm); renderChat(); saveSoon(); } return; }
    const fx = t.closest('[data-expand], [data-collapse]');
    if (fx) { const fm = findMsg(fx.dataset.expand || fx.dataset.collapse); if (fm) { fm.expanded = !!fx.dataset.expand; msgCache.delete(fm); renderChat(); } return; }
    const apr = t.closest('[data-approve]');
    if (apr) { answerApproval(apr.dataset.req, apr.dataset.approve); return; }
    const conf = t.closest('[data-confirm]');
    if (conf) { resolveConfirm(conf.dataset.confirm, conf.dataset.yes === '1'); return; }
    const botAct = t.closest('[data-botact]');
    if (botAct) { closeBotMenu(); if (botAct.dataset.botact === 'vault') toggleVault(botAct.dataset.bot); else if (botAct.dataset.botact === 'chief') toggleChief(botAct.dataset.bot); else if (botAct.dataset.botact === 'bypass') toggleBypass(botAct.dataset.bot); else if (botAct.dataset.botact === 'project') openProjectPicker(botAct.dataset.bot); else if (botAct.dataset.botact === 'rename') openRenameBot(botAct.dataset.bot); else if (botAct.dataset.botact === 'openapp') openInApp(botAct.dataset.bot); else openDeleteBot(botAct.dataset.bot); return; }
    const upd = t.closest('[data-update]');
    if (upd) { if (upd.dataset.update === 'later') updateLater(); else Bridge.call('updateRestart').catch(err => teamNote(chatById('team'), 'Couldn’t restart: ' + err.message)); return; }
    const askOth = t.closest('[data-askother]');
    if (askOth) {
      askOther(askOth.dataset.ask, askOth.dataset.q); renderChat();
      const box = document.querySelector('[data-askin="' + askOth.dataset.ask + '"][data-q="' + askOth.dataset.q + '"]');
      if (box) box.focus();
      return;
    }
    const askOpt = t.closest('[data-askopt]');
    if (askOpt) { askPick(askOpt.dataset.ask, askOpt.dataset.q, askOpt.dataset.label, askOpt.dataset.multi === '1'); renderChat(); return; }
    const askSend = t.closest('[data-asksend]');
    if (askSend) { sendAskAnswers(askSend.dataset.asksend, askSend.dataset.agent); return; }
    const askSkip = t.closest('[data-askskip]');
    if (askSkip) { skipAsk(askSkip.dataset.askskip, askSkip.dataset.agent); return; }
    const act = t.closest('[data-act]');
    if (act) {
      const what = act.dataset.act;
      if (what === 'folder') Bridge.call('openFolder', { agent: act.dataset.agent || '' }).catch(err => addMessage(activeChat(), { who: APP, kind: 'error', text: err.message }));
      else if (what === 'stopagent') stopAgentNow(act.dataset.agent || '');
      else if (what === 'signin') Bridge.call('signIn').catch(err => addMessage(activeChat(), { who: APP, kind: 'error', text: err.message }));
      else if (what === 'recheck') checkAuth();
      else if (what === 'togglelive') { S.liveMode = !S.liveMode; if (S.liveMode) { startLink(); startMirrors(); } else { stopLink(); stopMirrors(); } saveSoon(); renderAll(); renderBanner(); }
      else if (what === 'relink') { S.link.status = 'off'; startLink(); }
      else if (what === 'hidelivenote') { S.liveNoteHidden = true; saveSoon(); renderBanner(); }
      else if (what === 'resumeteam') setTeamPaused(false, 'the computer');
      else if (what === 'timer') { if (document.querySelector('.td-pop')) closeTimerDial(); else openTimerDial(); }
      else if (what === 'settings') openSettings();
      else if (what === 'updates') openUpdateLog();
      else if (what === 'closesess') { closeSessionView(); renderAll(); }
      else if (what === 'ctx') { if (document.querySelector('.cx-pop')) closeCtxMenu(); else openCtxMenu(); }
      else if (what === 'model') { if (document.querySelector('.mm-pop')) closeModelMenu(); else openModelMenu(); }
      else if (what === 'judge') { S.judge = !S.judge; saveSoon(); renderJudgeChip(); }
      else if (what === 'usage') { if (document.querySelector('.use-pop')) closeUsageMenu(); else openUsageMenu(); }
      else if (what === 'newteammate') openAddTeammate();
      else if (what === 'routines') openRoutines();
    else if (what === 'closenote') closeNote();
      else if (what === 'voice') voiceToggle('dictate');
      else if (what === 'call') voiceToggle('call');
      else if (what === 'callend') voiceStop();
      else if (what === 'callmute') callMute();
      else if (what === 'stoptimer') { timerOff(S.active); closeTimerDial(); }
      else if (what === 'closetimer') { applyTimerDial(); closeTimerDial(); $('#input').focus(); }
      else if (what === 'newgroup') openGroupModal(null);
      else if (what === 'editgroup') openGroupModal(activeChat());
      else if (what === 'split') toggleSplit();
      else if (what === 'clearchat') { const c = activeChat(); if (!S.flows[c.id] && (!c.messages.length || confirm('Clear "' + c.name + '"? This also clears the agents’ memory of it. Files they made stay.'))) clearChat(c); }
      return;
    }
    const chat = t.closest('[data-chat]');
    if (chat) { openChat(chat.dataset.chat); return; }
    const live = t.closest('[data-live]');
    if (live) { showLive(live.dataset.live); return; }
    const mention = t.closest('[data-mention]');
    if (mention) { insertMention(mention.dataset.mention); return; }
    const idea = t.closest('[data-idea]');
    if (idea) { $('#input').value = idea.dataset.idea; autosize(); $('#input').focus(); }
  });
  // ---------- images Storm pastes (Ctrl+V) or drops into the chat ----------
  // Images show as thumbnails; any other file (PDF, text, code…) as a chip. Agents get the saved path to open with Read.
  function addFile(file) {
    if (!file) return;
    const isImg = /^image\/(png|jpeg|gif|webp)$/.test(file.type);
    if (file.size > 25 * 1024 * 1024) { addMessage(activeChat(), { who: APP, kind: 'error', text: file.name + ' is over 25 MB, too big to attach.' }); return; }
    const item = { kind: isImg ? 'image' : 'file', path: '', url: isImg ? URL.createObjectURL(file) : '', name: file.name || (isImg ? 'image' : 'file') };
    S.attach.push(item); renderAttach();
    const reader = new FileReader();
    reader.onload = () => Bridge.call('saveImage', { data: reader.result, type: file.type || 'application/octet-stream', name: item.name })
      .then(r => { if (item.url && r.url) URL.revokeObjectURL(item.url); Object.assign(item, r, { kind: item.kind }); renderAttach(); })
      .catch(e => { S.attach = S.attach.filter(x => x !== item); renderAttach(); addMessage(activeChat(), { who: APP, kind: 'error', text: 'Couldn’t attach ' + item.name + ': ' + e.message }); });
    reader.readAsDataURL(file);
  }
  const addImageFile = addFile;
  function renderAttach() {
    const box = $('#attach');
    const shown = box.childElementCount;   // only images new since the last render slide in
    box.innerHTML = S.attach.map((a, i) => a.kind === 'file'
      ? '<div class="att file' + (a.path ? '' : ' saving') + (i >= shown ? ' new' : '') + '" title="' + esc(a.name) + '">' + ICON.file + '<span>' + esc(a.name) + '</span><button data-unattach="' + i + '" title="Remove">×</button></div>'
      : '<div class="att' + (a.path ? '' : ' saving') + (i >= shown ? ' new' : '') + '"><img src="' + esc(a.url) + '" alt="" data-shot="' + esc(a.url) + '" data-cap="' + esc(a.name) + '"><button data-unattach="' + i + '" title="Remove">×</button></div>').join('');
    box.classList.toggle('hidden', !S.attach.length);
  }
  $('#input').addEventListener('paste', e => {
    const files = Array.from((e.clipboardData && e.clipboardData.items) || []).filter(i => i.kind === 'file').map(i => i.getAsFile()).filter(Boolean);
    if (!files.length) return;
    e.preventDefault();
    files.forEach(addFile);
  });
  const centerEl = $('#center');
  const hasFiles = e => Array.from((e.dataTransfer && e.dataTransfer.types) || []).includes('Files');
  centerEl.addEventListener('dragover', e => { if (!hasFiles(e)) return; e.preventDefault(); centerEl.classList.add('dropping'); });
  centerEl.addEventListener('dragleave', e => { if (!e.relatedTarget || !centerEl.contains(e.relatedTarget)) centerEl.classList.remove('dropping'); });
  centerEl.addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault(); centerEl.classList.remove('dropping');
    Array.from(e.dataTransfer.files || []).forEach(addFile);
    $('#input').focus();
  });
  // dropping a file anywhere else must not navigate the app away
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => e.preventDefault());

  // ---------- work timer: how long Claude keeps working on what Storm sends ----------
  // A chip under the send bar opens a horizontal dial (Off, 10 min … 10 h, then ∞ Continuous). Kept self-contained
  // (td-* classes, openTimerDial) so it can move into Nimbus later. While a timer runs, each time the agent or real
  // session finishes a turn early, Tempest tells it to keep going with the time left; at the end it asks for a wrap-up.
  const WORK_STEPS = ['off', 10, 15, 20, 30, 45, 60, 90, 120, 150, 180, 240, 300, 360, 420, 480, 540, 600, 'inf'];
  const WORK_MAJOR = new Set(['off', 10, 30, 60, 120, 240, 360, 600, 'inf']);
  const workLabel = v => v === 'off' ? 'Off' : v === 'inf' ? 'Continuous' : v < 60 ? v + ' min' : Math.floor(v / 60) + ' h' + (v % 60 ? ' ' + (v % 60) + ' min' : '');
  const tickLabel = v => v === 'off' ? 'Off' : v === 'inf' ? '∞' : v < 60 ? v + 'm' : (v / 60) + 'h';
  const fmtLeft = ms => { const s = Math.max(0, Math.round(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s % 60).padStart(2, '0'); };
  const TIMER_SETTLE_MS = 6000, TIMER_QUICK_MS = 40000, TIMER_STALL_MS = 180000;

  function renderTimerChip() {
    const chip = $('#timer');
    if (!chip) return;
    const t = S.timers[activeChat().id];
    // running, the chip is alive (Storm: "Make the timer look more dynamic"): a ring that drains as the time runs out (a spinning arc
    // when it's continuous), a sheen sweeping across, and amber in the last minute
    const left = t && t.until !== Infinity ? t.until - Date.now() : 0;
    const frac = t && t.until !== Infinity && t.mins ? Math.max(0, Math.min(1, left / (t.mins * 60000))) : 1;
    const C = 50.27;   // the ring's circumference (r = 8)
    const ring = '<svg class="tc-ring" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8" class="tc-bg"/><circle cx="10" cy="10" r="8" class="tc-fg" style="stroke-dasharray:' + C + ';stroke-dashoffset:' + (t && t.until === Infinity ? C * 0.7 : C * (1 - frac)).toFixed(2) + '"/></svg>';
    chip.className = 'timer-chip' + (t ? ' running' + (t.until === Infinity ? ' inf' : left < 60000 ? ' ending' : '') : S.workFor === 'off' ? ' off' : '');
    patchHTML(chip, t
      ? ring + '<span>' + (t.paused ? 'Paused · waits for you' : t.holdUntil > Date.now() ? 'Held by ' + esc(t.holdBy || 'a bot') + ' · ' + fmtLeft(t.holdUntil - Date.now()) : t.until === Infinity ? '∞ Continuous' : fmtLeft(t.until - Date.now()) + ' left') + '</span><i class="tc-stop" data-act="stoptimer" title="Stop the timer">Stop</i>'
      : ICON.clock + '<span>' + (S.workFor === 'off' ? 'Work timer: off' : 'Work for ' + esc(workLabel(S.workFor))) + '</span>');
    renderModelChip();
  }

  function openTimerDial() {
    closeTimerDial();
    const running = S.timers[activeChat().id];
    const pop = document.createElement('div');
    pop.className = 'td-pop';
    pop.tabIndex = -1;
    pop.innerHTML = '<div class="td-title">How long should Claude work?</div><div class="td-value"></div>' +
      '<div class="td-dial"><div class="td-track">' + WORK_STEPS.map((v, i) => '<div class="td-tick' + (WORK_MAJOR.has(v) ? ' major' : '') + '" data-i="' + i + '"><i></i>' + (WORK_MAJOR.has(v) ? '<span>' + tickLabel(v) + '</span>' : '') + '</div>').join('') +
      '</div><div class="td-marker"></div></div><div class="td-note"></div>' +
      '<div class="td-btns">' + (running ? '<button data-act="stoptimer" class="td-stop">Stop timer</button>' : '') + '<span class="grow"></span><button data-act="closetimer" class="td-done">Done</button></div>';
    document.body.append(pop);
    const r = $('#timer').getBoundingClientRect();
    pop.style.left = Math.max(10, Math.min(window.innerWidth - pop.offsetWidth - 10, r.left)) + 'px';
    placeTop(pop, r);
    const track = pop.querySelector('.td-track'), dial = pop.querySelector('.td-dial'), STEP = 30;
    let idx = Math.max(0, WORK_STEPS.indexOf(S.workFor)), drag = null;
    const ticks = Array.from(track.children);
    // the ticks swell and brighten as the selector line passes over them (Storm: "Make the lines get bigger when the timer selector line is over it")
    const magnify = f => ticks.forEach((tk, j) => { const near = Math.max(0, 1 - Math.abs(j - f) / 2.4); tk.style.setProperty('--mag', (1 + 1.25 * Math.pow(near, 1.4)).toFixed(3)); tk.style.setProperty('--glow', near.toFixed(3)); });
    const place = (f, animate) => {
      track.style.transition = animate ? 'transform 0.25s cubic-bezier(0.2, 0.8, 0.3, 1)' : 'none';
      track.style.transform = 'translateX(' + (dial.clientWidth / 2 - (f + 0.5) * STEP) + 'px)';
      magnify(f);
    };
    const setIdx = (i, animate) => {
      const was = idx;
      idx = Math.max(0, Math.min(WORK_STEPS.length - 1, Math.round(i)));
      if (idx !== was) sfx('tick');
      place(idx, animate);
      pop.querySelectorAll('.td-tick').forEach((tk, j) => tk.classList.toggle('on', j === idx));
      const v = WORK_STEPS[idx];
      pop.querySelector('.td-value').innerHTML = v === 'inf' ? '<b class="inf">∞ Continuous</b>' : '<b>' + esc(workLabel(v)) + '</b>';
      // Done applies the length to this chat right away (applyTimerDial), so the note says what Done does
      const verb = running ? 'Done changes the running timer.' : 'Done starts it on this chat.';
      pop.querySelector('.td-note').textContent = v === 'off' ? 'Claude answers and stops, like before.' + (running ? ' Done stops the running timer.' : '') :
        v === 'inf' ? 'Claude keeps working until you press Stop or say stop. ' + verb :
        'Claude keeps working for ' + workLabel(v) + ' after each turn, then wraps up. ' + verb;
      if (S.workFor !== v) { S.workFor = v; saveSoon(); renderTimerChip(); }
    };
    setIdx(idx, false);
    dial.addEventListener('pointerdown', e => { drag = { x: e.clientX, i: idx, f: idx }; dial.setPointerCapture(e.pointerId); });
    dial.addEventListener('pointermove', e => { if (!drag) return; drag.f = Math.max(-0.4, Math.min(WORK_STEPS.length - 0.6, drag.i - (e.clientX - drag.x) / STEP)); place(drag.f, false); });
    dial.addEventListener('pointerup', e => {
      if (!drag) return;
      const moved = Math.abs(e.clientX - drag.x) > 3;
      const under = !moved && document.elementsFromPoint(e.clientX, e.clientY).find(el => el.classList && el.classList.contains('td-tick'));
      setIdx(under ? +under.dataset.i : drag.f, true);
      drag = null;
    });
    dial.addEventListener('wheel', e => { e.preventDefault(); setIdx(idx + ((e.deltaY || e.deltaX) > 0 ? 1 : -1), true); }, { passive: false });
    pop.addEventListener('keydown', e => {
      if (e.key === 'ArrowRight') { setIdx(idx + 1, true); e.preventDefault(); }
      else if (e.key === 'ArrowLeft') { setIdx(idx - 1, true); e.preventDefault(); }
      else if (e.key === 'Enter') { applyTimerDial(); closeTimerDial(); $('#input').focus(); }
      else if (e.key === 'Escape') { closeTimerDial(); $('#input').focus(); }
    });
    pop.focus();
  }
  // Above the button when there's room, below it when there isn't; never off the window, and scrolls if it's taller than the window.
  function placeTop(pop, r) {
    const margin = 10;
    pop.style.maxHeight = (window.innerHeight - 2 * margin) + 'px';
    pop.style.overflowY = 'auto';
    const h = Math.min(pop.offsetHeight, window.innerHeight - 2 * margin);
    let top = r.top - h - margin;
    if (top < margin) top = Math.min(r.bottom + margin, window.innerHeight - h - margin);
    pop.style.top = Math.max(margin, top) + 'px';
  }
  function closeTimerDial() { document.querySelectorAll('.td-pop').forEach(x => x.remove()); }
  // Done on the dial: the length it shows starts on the active chat now ('off' stops a running timer). An idle session gets the first
  // nudge right away; a busy one gets it when its turn ends (the watch nudges then).
  function applyTimerDial() {
    const c = activeChat(), v = S.workFor;
    if (!c) return;
    if (v === 'off') { if (S.timers[c.id]) stopTimer(c.id); return; }
    startTimer(c, v);
    const t = S.timers[c.id];
    if (!t) return;
    const mi = mirrorFor(c);
    const busy = mi ? mirrorBusy(mi) : !!S.flows[c.id];
    const pendingNow = !!mi && (mi.pending || []).some(p => Date.now() - p.at < 60000);
    if (!busy && !pendingNow) timerTick(c.id);   // idle now: the first nudge goes out right away
    else t.busySeen = true;                       // busy now: the watch nudges when it finishes
  }

  // ---------- model chip: which model Tempest's agents run on (applies from the next run) ----------
  function renderModelChip() {
    const b = $('#model');
    if (!b) return;
    const m = MODELS.find(x => x.id === S.model) || MODELS[0];
    // a live session shows the model it's actually running; a teammate Squall runs shows Squall's setting
    const mi = mirrorFor(activeChat());
    const live = mi && mi.status && mi.status.model ? prettyModel(mi.status.model) : '';
    patchHTML(b, ICON.spark + '<span>' + (live ? 'Live: ' + esc(live) : 'Agents: ' + esc(m.name)) + '</span>' + ICON.chev);
    b.title = 'Model for ' + APP + '’s agents: ' + m.name + ' (click to change)';
    renderJudgeChip();
  }
  // ---------- the judge (Storm, 19 Oct: "a judge bot and a toggle under the send bar") ----------
  // With Judge on, each teammate's turn that answers Storm is read by Haiku (the host's judge command) against what he asked. PASS shows
  // a small note; RETRY sends the reasons back to the teammate once, and its next turn stands. Work-timer and judge turns aren't judged
  function renderJudgeChip() {
    const b = $('#judge');
    if (!b) return;
    b.classList.toggle('on', !!S.judge);
    patchHTML(b, ICON.check + '<span>Judge: ' + (S.judge ? 'on' : 'off') + '</span>');
  }
  const judgeDone = new Set();   // requests already judged (chat|request key), so each Storm message is judged once and retried at most once
  const JUDGE_SKIP_RX = /\b(work timer|judge)\b\)?:/i;
  function judgeTake(chat) {
    const mi = mirrorFor(chat);
    if (mi) {
      const es = mi.entries || [];
      let u = es.length - 1;
      while (u >= 0 && es[u].role !== 'user') u--;
      if (u < 0) return null;
      const reply = es.slice(u + 1).filter(e => e.role === 'assistant' && e.text).map(e => e.text).join('\n\n').trim();
      return { key: chat.id + '|' + (es[u].uuid || es[u].id || es[u].time || u), ask: String(es[u].text || ''), reply, bot: chat.members[0] };
    }
    const ms = chat.messages || [];
    let u = ms.length - 1;
    while (u >= 0 && ms[u].who !== 'Storm') u--;
    if (u < 0) return null;
    const out = ms.slice(u + 1).filter(m => m.who !== 'Storm' && m.who !== APP && !['event', 'error', 'confirm'].includes(m.kind) && m.text);
    return { key: chat.id + '|' + (ms[u].id || u), ask: String(ms[u].text || ''), reply: out.map(m => m.text || '').join('\n\n').trim(), bot: out.length ? out[out.length - 1].who : chat.members[0] };
  }
  async function judgeTurn(chatId, force) {
    if (!S.judge && !force) return null;
    if (S.selftest && !force) return null;
    const chat = chatById(chatId);
    if (!chat || chat.id === 'team' || !/^dm:/.test(chat.id)) return null;
    const j = judgeTake(chat);
    if (!j || !j.reply || JUDGE_SKIP_RX.test(j.ask.slice(0, 400))) return null;
    const retried = judgeDone.has(j.key + '|retry');
    if (judgeDone.has(j.key) && !retried) return null;
    judgeDone.add(j.key);
    let v;
    try { v = await Bridge.call('judge', { ask: j.ask, reply: j.reply, bot: j.bot }); }
    catch (e) { addMessage(chat, { who: APP, kind: 'event', text: '⚖ The judge couldn’t check that: ' + e.message }); return null; }
    if (v.verdict !== 'retry' || retried) {
      addMessage(chat, { who: APP, kind: 'event', text: '⚖ Judge: ' + (v.verdict === 'retry' ? 'still not quite there after one retry, so it stands: ' + v.reasons.split('\n')[0] : 'passed.') });
      return v;
    }
    judgeDone.add(j.key + '|retry');
    addMessage(chat, { who: APP, kind: 'event', text: '⚖ Judge sent ' + j.bot + '’s reply back: ' + v.reasons.replace(/\n/g, ' · ') });
    const note = 'The judge (Haiku, checking replies for Storm) sent your last reply back. Fix these and answer again, in full:\n' + v.reasons;
    if (mirrorFor(chat)) sendToMirror(chat, note, [], [], APP + ' (judge): ');
    else setTimeout(() => continueLocal(chat, note), 0);
    return v;
  }
  function openModelMenu() {
    closeModelMenu(); closeTimerDial();
    const pop = document.createElement('div');
    pop.className = 'mm-pop';
    const chat = activeChat(), mi = mirrorFor(chat);
    if (mi) {
      // a live session: Squall Control switches its model (a session can't switch itself)
      const cur = mi.status && mi.status.model ? mi.status.model : '';
      pop.innerHTML = '<div class="mm-title">Model for ' + esc(chat.members[0]) + ' (live)</div>' + MODELS.map(m => '<button class="mm-row' + (m.id === cur ? ' on' : '') + '" data-livemodel="' + esc(m.id) + '"><span><b>' + esc(m.name) + '</b><small>' + esc(m.note) + '</small></span>' + (m.id === cur ? ICON.check : '') + '</button>').join('') +
        '<div class="mm-note">' + (controlOn() ? 'Squall Control switches the session; it takes effect from its next turn.' : 'Squall Control isn’t running, so pick the model in the Claude app for now.') + '</div>';
    } else
    pop.innerHTML = '<div class="mm-title">Model for the team</div>' + MODELS.map(m => '<button class="mm-row' + (m.id === S.model ? ' on' : '') + '" data-model="' + esc(m.id) + '"><span><b>' + esc(m.name) + '</b><small>' + esc(m.note) + '</small></span>' + (m.id === S.model ? ICON.check : '') + '</button>').join('') +
      '<div class="mm-note">Applies to every agent ' + APP + ' runs and to anything they start. Your real Claude sessions keep their own model.</div>';
    document.body.append(pop);
    const r = $('#model').getBoundingClientRect();
    pop.style.left = Math.max(10, Math.min(window.innerWidth - pop.offsetWidth - 10, r.left)) + 'px';
    placeTop(pop, r);
  }
  function closeModelMenu() { document.querySelectorAll('.mm-pop').forEach(x => x.remove()); }

  // error bubbles: shown for a few minutes in a live chat, and dismissed with ×
  const ERROR_SHOW_MS = 3 * 60000;
  // "Try again" on a teammate's failed reply: Storm's last message in this chat goes again, to the same teammate. Whatever he has
  // typed in the box meanwhile (and any attachments) stays there
  function retryFrom(id) {
    const c = activeChat(), i = c.messages.findIndex(x => x.id === id);
    if (i < 0 || S.flows[c.id]) return false;
    const m = c.messages[i];
    const mine = c.messages.slice(0, i).reverse().find(x => x.who === 'Storm' && x.kind === 'user' && x.text);
    if (!mine) return false;
    const inp = $('#input'), draft = inp.value, att = S.attach;
    dismissMessage(id);
    inp.value = (c.kind !== 'dm' && m.who !== c.lead ? '@' + m.who + ' ' : '') + mine.text;   // in a team chat it goes to the teammate that failed
    S.attach = [];
    send();   // reads the box at once, before its first wait
    inp.value = draft; S.attach = att; renderAttach(); autosize(); if (draft) saveDraft();
    return true;
  }
  function dismissMessage(id) {
    for (const c of S.chats) {
      const i = c.messages.findIndex(m => m.id === id);
      if (i >= 0) { c.messages.splice(i, 1); saveSoon(); if (c.id === S.active) renderChat(); return true; }
    }
    return false;
  }

  // Squall Control: a Claude app session whose only jobs are switching another session's model and pressing its Stop
  // (the app's own tools can do both, but never for the session asking). Storm: "Can't you make the model selector just type /model?"
  const CONTROL = 'Squall Control';
  function controlOn() { const p = peerFor(CONTROL); return S.link.status === 'on' && !!p && p.status !== 'offline'; }
  // what Control sends back: "USAGE {plan json}" fills the usage chip (Storm: "Connect the usage"); anything else is a short note in the chat that asked
  function controlReply(body) {
    const t = String(body || '').trim();
    if (/^USAGE\s/.test(t)) {
      let u = null;
      try { u = JSON.parse(t.slice(6)); } catch (e) { u = null; }
      if (u && u.plan && Array.isArray(u.plan.windows)) u = u.plan;
      if (u && Array.isArray(u.windows)) {
        S.usage = u; S.usageSrc = 'control'; S.usageAt = Date.now();
        const w5 = u.windows.find(w => /5/.test(w.label || '')) || u.windows[0];
        if (w5 && typeof w5.percentUsed === 'number') { S.usageHist.push({ t: Date.now(), p: w5.percentUsed }); if (S.usageHist.length > 120) S.usageHist.splice(0, S.usageHist.length - 120); }
        renderUsage();
      }
      return;
    }
    const chat = chatById(S.controlChat) || activeChat();
    if (chat && t) addMessage(chat, { who: APP, kind: 'event', text: '⚙ Squall Control: ' + (t.length > 300 ? t.slice(0, 300) + '…' : t) });
  }
  // the usage chip, through Control (no Claude Code setting to change): asked every 5 minutes while Control is running

  function switchLiveModel(id) {
    closeModelMenu();
    const chat = activeChat(), name = chat && chat.kind === 'dm' ? chat.members[0] : '', m = MODELS.find(x => x.id === id);
    if (!name) return;
    if (!controlOn()) { addMessage(chat, { who: APP, kind: 'error', text: 'Squall Control isn’t running, so the model can’t be switched from here. Pick it in the Claude app’s model menu.' }); return; }
    S.controlChat = chat.id;
    liveSend(CONTROL, 'Squall (control): switch the session "' + name + '" to model ' + id + '.').then(r => {
      addMessage(chat, { who: APP, kind: r.ok ? 'event' : 'error', text: r.ok ? '↺ Asked Squall Control to switch ' + name + ' to ' + (m ? m.name : id) + ', from its next turn.' : 'Couldn’t reach Squall Control: ' + (r.note || 'not running') });
    });
  }
  // ---------- sessions: every session on this PC, read-only history when offline ----------
  const ago = t => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? s + 's ago' : s < 3600 ? Math.floor(s / 60) + 'm ago' : s < 86400 ? Math.floor(s / 3600) + 'h ago' : Math.floor(s / 86400) + 'd ago'; };
  function renderSessionsPane() {
    const body = $('#live-body');
    const list = S.desk || [], now = Date.now();
    const rows = list.map(s => {
      const t = s.modified || 0, running = t > 0 && now - t < 3 * 60000;   // written in the last few minutes: running now
      const isTeam = S.agents.some(a => a.name.toLowerCase() === botOf(s.title));   // "Chief (Squall)" is the teammate Chief
      const hist = !!s.transcript && s.exists !== false;
      return '<button class="sess-row' + (S.sessView === s.transcript ? ' on' : '') + '"' + (hist ? ' data-sess="' + esc(s.transcript) + '"' : ' disabled') + ' title="' + esc(s.cwd || '') + '">' +
        '<i class="sdot' + (running ? ' live' : '') + '"></i><span class="sn">' + esc(s.title || '(untitled)') + (isTeam ? ' <em>team</em>' : '') + (s.archived ? ' <em>archived</em>' : '') + '</span>' +
        '<span class="st">' + esc(running ? 'running' : t ? 'offline · ' + ago(t) : 'no conversation yet') + '</span></button>';
    }).join('');
    patchHTML(body, '<div class="sess-head">' + list.length + ' sessions on this PC</div>' + (rows || '<div class="live-empty">No sessions found yet.</div>'));
    $('#live-foot').innerHTML = '<span>Click a session to read its history. Offline sessions still load.</span>';
  }
  function openSession(path) {
    const s = (S.desk || []).find(x => x.transcript === path);
    if (!s) return;
    if (window.SquallUnoUI) window.SquallUnoUI.close();
    if (S.sessView && S.sessView !== path) stopSessionMirror(S.sessView);
    S.sessView = path;
    S.sessMirror[path] = S.sessMirror[path] || { entries: [], status: null, loading: true, title: '' };
    S.sessMirror[path].title = s.title || '';
    Bridge.call('mirrorStart', { agent: 'sess:' + path, transcript: path }).catch(e => {
      delete S.sessMirror[path]; S.sessView = null;
      addMessage(activeChat(), { who: APP, kind: 'error', text: 'Couldn’t open that session: ' + e.message });
    });
    renderAll(); updateTitle();
  }
  function stopSessionMirror(path) { Bridge.call('mirrorStop', { agent: 'sess:' + path }).catch(() => {}); delete S.sessMirror[path]; }
  function closeSessionView() { if (S.sessView) { stopSessionMirror(S.sessView); S.sessView = null; } }
  function handleSessMirror(m) {
    const path = String(m.agent).slice(5), sm = S.sessMirror[path];
    if (!sm) return;
    const fresh = m.entries || [];
    fresh.forEach(e => { e.k = 'e' + (++mirrorSeq); });
    if (m.reset) sm.entries = fresh; else sm.entries.push(...fresh);
    if (sm.entries.length > 1000) sm.entries = trimEntries(sm.entries, 600, 400);
    sm.loading = false;
    if (m.status) sm.status = m.status;
    const nowBusy = mirrorBusy(sm);
    if (nowBusy) clearTimeout(sm.pingTimer);
    if (sm.wasBusy && !nowBusy && S.sessView === path) sm.pingTimer = setTimeout(() => { if (S.sessView === path && !mirrorBusy(sm, false)) playPing(); }, 4000);
    sm.wasBusy = nowBusy;
    if (S.sessView === path) { renderChat(); renderChatHead(); }
    if (S.rightMode === 'sessions') renderSessionsPane();
    renderTeamSoon();
  }
  function renderSessChat() {
    const path = S.sessView, sm = S.sessMirror[path], box = $('#chat');
    const view = 'sess:' + path, switching = box.dataset.view !== view;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    box.dataset.view = view;
    patchHTML(box, mirrorHTML({ id: 'sess', kind: 'dm', members: [sm.title || 'Session'], messages: [] }, sm, switching));
    if (atBottom || switching) box.scrollTop = box.scrollHeight;
  }

  // ---------- settings: the gear at the top of the team column ----------
  // ---------- sound: a sci-fi ping when the response you're looking at finishes ----------
  let audioCtx = null;
  function playPing() {
    if (!S.sound) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      audioCtx = audioCtx || new AC();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      if (typeof sfxSleepSoon === 'function') sfxSleepSoon();
      const t0 = audioCtx.currentTime + 0.01;
      const out = audioCtx.createGain();
      out.gain.value = 0.22;
      out.connect(audioCtx.destination);
      // a short echo, like a ping bouncing off a hull
      const echo = audioCtx.createDelay(1);
      echo.delayTime.value = 0.17;
      const feedback = audioCtx.createGain();
      feedback.gain.value = 0.35;
      echo.connect(feedback); feedback.connect(echo); echo.connect(out);
      // a relaxed sci-fi "voom voom" when a turn finishes (Storm, 19 Oct: "more relaxed", "not an alien laughing"): two identical soft
      // swells 0.3 s apart. A low sine with a quiet octave above, through a gentle low-pass, fading in and out; no pitch swoop, no
      // resonance and no echo (those made it sound like laughing)
      const voom = t => {
        const low = audioCtx.createOscillator(), high = audioCtx.createOscillator(), hg = audioCtx.createGain();
        const lp = audioCtx.createBiquadFilter(), g = audioCtx.createGain();
        low.type = 'sine'; high.type = 'triangle';
        low.frequency.setValueAtTime(96, t); low.frequency.linearRampToValueAtTime(88, t + 0.3);
        high.frequency.setValueAtTime(192, t); high.frequency.linearRampToValueAtTime(176, t + 0.3);
        hg.gain.value = 0.25;
        lp.type = 'lowpass'; lp.Q.value = 0.7;
        lp.frequency.setValueAtTime(320, t); lp.frequency.linearRampToValueAtTime(650, t + 0.12); lp.frequency.linearRampToValueAtTime(300, t + 0.3);
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.9, t + 0.09); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
        low.connect(lp); high.connect(hg); hg.connect(lp); lp.connect(g); g.connect(out);
        low.start(t); high.start(t); low.stop(t + 0.34); high.stop(t + 0.34);
      };
      voom(t0); voom(t0 + 0.3);
    } catch (e) { /* no audio device: stay silent */ }
  }
  // a turn finished: ping only if that chat is the one on screen
  function finishPing(chatId) { if (chatId === S.active && !S.flows[chatId]) playPing(); }   // not while another round in this chat is still going

  // ---------- usage under the send bar: the plan's 5-hour and weekly windows, and whether the pace reaches the reset ----------
  function usageRefresh() {
    if (S.usageSrc === 'claude') { renderUsage(); return; }   // Claude's own reading stands until its next report; only the countdown moves
    Bridge.call('usageRead').then(txt => {
      let u = null;
      try { u = txt ? JSON.parse(txt) : null; } catch (e) { u = null; }
      if (!(u && Array.isArray(u.windows)) && S.usageSrc === 'control' && Date.now() - (S.usageAt || 0) < 15 * 60000) return;   // Squall Control's reading stands
      S.usage = u && Array.isArray(u.windows) ? u : null;
      if (S.usage) S.usageSrc = 'file';
      const w5 = S.usage && (S.usage.windows.find(w => /5/.test(w.label || '')) || S.usage.windows[0]);
      if (w5 && typeof w5.percentUsed === 'number') { S.usageHist.push({ t: Date.now(), p: w5.percentUsed }); if (S.usageHist.length > 120) S.usageHist.splice(0, S.usageHist.length - 120); }
      weekRecord();
      renderUsage();
    }).catch(() => { S.usage = null; renderUsage(); });
  }
  // at this pace (last 30 minutes), when does the 5-hour window run out, and does that come before its reset?
  function usagePace() {
    const u = S.usage;
    if (!u) return null;
    const w = u.windows.find(x => /5/.test(x.label || '')) || u.windows[0];
    const now = Date.now(), recent = S.usageHist.filter(h => now - h.t <= 30 * 60000);
    // the window has reset: the old readings say nothing about the new one (19 Oct, night: "0%, about 26% at reset")
    if (w && w.resetsAt && Date.parse(w.resetsAt) <= now) return { w, ready: false };
    // at least 10 minutes of readings (19 Oct, night: two readings a minute apart after a reset predicted a run-out at 4% and throttled the team)
    if (!w || recent.length < 2 || recent[recent.length - 1].t - recent[0].t < 10 * 60000) return { w, ready: false };
    const first = recent[0], last = recent[recent.length - 1];
    const perMin = (last.p - first.p) / Math.max(1, (last.t - first.t) / 60000);
    const resetMin = w.resetsAt ? (Date.parse(w.resetsAt) - now) / 60000 : null;
    // Storm: "I want it to say what percentage I'll be at when it resets"
    const atReset = resetMin === null ? null : Math.max(last.p, Math.min(100, Math.round(last.p + Math.max(0, perMin) * Math.max(0, resetMin))));
    if (perMin <= 0) return { w, ready: true, perMin, outMin: null, resetMin, reachesReset: true, atReset };
    const outMin = (100 - last.p) / perMin;
    return { w, ready: true, perMin, outMin, resetMin, reachesReset: resetMin === null || outMin >= resetMin, atReset };
  }
  // the weekly limit (Storm: "Make it predict the weekly limit too"): the all-models window's readings, kept across restarts since it moves slowly.
  // A new week (a new reset time) starts the readings over. The pace uses this week's readings, two hours at least
  function weekWindow() {
    const u = S.usage;
    return u && Array.isArray(u.windows) ? (u.windows.find(x => x.label === 'Weekly · all models') || u.windows.find(x => /week/i.test(x.label || ''))) : null;
  }
  function weekRecord() {
    const w = weekWindow();
    if (!w || typeof w.percentUsed !== 'number') return;
    const reset = w.resetsAt || '', h = S.usageHist7, lastH = h[h.length - 1];
    if (lastH && (lastH.reset !== reset || w.percentUsed < lastH.p - 1)) S.usageHist7 = [];   // a new week: the pace starts over
    const last = S.usageHist7[S.usageHist7.length - 1];
    if (!last || last.p !== w.percentUsed || Date.now() - last.t > 15 * 60000) {
      S.usageHist7.push({ t: Date.now(), p: w.percentUsed, reset });
      if (S.usageHist7.length > 400) S.usageHist7.splice(0, S.usageHist7.length - 400);
      saveSoon();
    }
  }
  function weekPace() {
    const w = weekWindow();
    if (!w || !w.resetsAt) return null;
    const now = Date.now(), resetMin = (Date.parse(w.resetsAt) - now) / 60000;
    const recent = S.usageHist7.filter(h => h.reset === w.resetsAt);
    if (recent.length < 2 || resetMin <= 0) return { w, ready: false, resetMin };
    const first = recent[0], last = recent[recent.length - 1], spanMin = (last.t - first.t) / 60000;
    if (spanMin < 120) return { w, ready: false, resetMin };
    const perMin = Math.max(0, (last.p - first.p) / spanMin);
    // the week reads in whole percents and a reading is added every 15 min even when it hasn't moved, so count from the FIRST
    // reading at today's value (when the week got there): from the newest one, a week sitting at 99% said "1h 8m" for as long as it sat
    let at = recent.length - 1;
    while (at > 0 && recent[at - 1].p === last.p) at--;
    const sinceMin = (now - recent[at].t) / 60000;
    const atReset = Math.max(last.p, Math.min(100, Math.round(last.p + perMin * (sinceMin + resetMin))));
    const hitIn = perMin > 0 ? Math.max(0, (100 - last.p) / perMin - sinceMin) : Infinity;   // minutes from NOW until the week reaches 100% at this pace
    return { w, ready: true, perMin, resetMin, atReset, hitIn, hitsFirst: hitIn < resetMin };
  }
  // usage straight from Claude (Storm: "get it another way like straight from Claude not a session"). Each Claude process Squall starts
  // (a bot's run, the relay) reports the plan's windows in a rate_limit_event line when it starts and whenever the numbers change
  const untilText = t => { const m = Math.max(0, Math.round((t - Date.now()) / 60000)); return m >= 1440 ? Math.round(m / 1440) + 'd' : m >= 60 ? Math.floor(m / 60) + 'h ' + (m % 60) + 'm' : m + 'm'; };
  function usageFromClaude(info) {
    const uw = info && info.unifiedWindows;
    if (!uw || typeof uw !== 'object') return false;
    const win = (key, label) => {
      const x = uw[key];
      if (!x || typeof x.utilization !== 'number') return null;
      return { label, percentUsed: Math.round(x.utilization * 100), resetsAt: x.resetsAt ? new Date(x.resetsAt * 1000).toISOString() : '', resetsIn: x.resetsAt ? untilText(x.resetsAt * 1000) : '' };
    };
    const windows = [win('five_hour', '5-hour limit'), win('seven_day', 'Weekly · all models')];
    for (const k of Object.keys(uw)) if (k !== 'five_hour' && k !== 'seven_day') windows.push(win(k, 'Weekly · ' + k.replace(/^seven_day_?/, '').replace(/_/g, ' ')));   // per-model limits, if Claude reports them
    const ws = windows.filter(Boolean);
    if (!ws.length) return false;
    S.usage = { status: info.status || 'allowed', windows: ws, overage: !!info.isUsingOverage }; S.usageSrc = 'claude'; S.usageAt = Date.now();
    const w5 = ws.find(w => w.label === '5-hour limit');
    if (w5 && S.usageHist.length && w5.percentUsed < S.usageHist[S.usageHist.length - 1].p - 1) S.usageHist = [];   // the window reset: the pace starts over
    const last = S.usageHist[S.usageHist.length - 1];
    if (w5 && (!last || last.p !== w5.percentUsed || Date.now() - last.t > 60000)) { S.usageHist.push({ t: Date.now(), p: w5.percentUsed }); if (S.usageHist.length > 120) S.usageHist.splice(0, S.usageHist.length - 120); }
    weekRecord();
    renderUsage();
    return true;
  }
  // a window as it stands now: the countdown from its reset time, and 0% once that time has passed
  function usageNow(w) {
    const at = w && w.resetsAt ? Date.parse(w.resetsAt) : NaN;
    if (!isNaN(at) && at <= Date.now()) return Object.assign({}, w, { percentUsed: 0, resetsIn: '', resetsAt: '' });
    return Object.assign({}, w, { resetsIn: !isNaN(at) ? untilText(at) : (w.resetsIn || '') });
  }
  function renderUsage() {
    const b = $('#usage');
    if (!b) return;
    const pace = usagePace();
    if (!S.usage || !pace) {
      patchHTML(b, ICON.spark + '<span>Usage: not connected</span>');
      b.dataset.level = 'off';
      b.title = 'Plan usage shows up with Claude’s next reply. Click for details.';
      return;
    }
    const w = usageNow(pace.w), pct = Math.round(w.percentUsed || 0);
    const verdict = !pace.ready ? '' : !pace.reachesReset ? ' · runs out in ' + Math.round(pace.outMin) + ' min' : pace.atReset !== null ? ' · ~' + pace.atReset + '% at reset' : pace.outMin === null ? ' · steady' : ' · makes it to reset';
    // the week: where it stands, and where it lands at its reset (or the day it reaches 100% first)
    const wp7 = weekPace(), wk = wp7 && wp7.w ? usageNow(wp7.w) : null;
    const weekTxt = !wk ? '' : ' · week ' + Math.round(wk.percentUsed || 0) + '%' + (!wp7.ready ? '' : wp7.hitsFirst ? ' → 100% in ' + untilText(Date.now() + wp7.hitIn * 60000) : ' → ~' + wp7.atReset + '%');
    const tight = usageTight();
    patchHTML(b, ICON.spark + '<span>' + (tight ? 'Throttled · ' : '') + '5h ' + pct + '%' + (w.resetsIn ? ' · resets in ' + esc(w.resetsIn) : '') + esc(verdict) + esc(weekTxt) + '</span>');
    b.dataset.level = tight || pct >= 90 ? 'hot' : pct >= 70 ? 'warm' : 'ok';
    b.title = 'Plan usage: ' + pct + '% of the 5-hour window' + (wk ? ', ' + Math.round(wk.percentUsed || 0) + '% of the week' : '');
  }
  // the bots know the usage too (Storm, 19 Oct: "every time the user sends a message, every time the timer says something, and at the end
  // of every turn make it say the usage for session and weekly and when predicted to run out"): one line with each message Squall sends a
  // bot, and the bot ends its reply with it
  function usageForBots() {
    const pace = usagePace();
    if (!S.usage || !pace) return '';
    const w = usageNow(pace.w), pct = Math.round(w.percentUsed || 0);
    const five = '5-hour window ' + pct + '%' + (w.resetsIn ? ', resets in ' + w.resetsIn : '') + (!pace.ready ? '' : !pace.reachesReset ? ', predicted to run out in ' + Math.round(pace.outMin) + ' min' : pace.atReset !== null ? ', about ' + pace.atReset + '% at reset' : '');
    const wp7 = weekPace(), wk = wp7 && wp7.w ? usageNow(wp7.w) : null;
    const week = !wk ? '' : '; week ' + Math.round(wk.percentUsed || 0) + '%' + (!wp7.ready ? '' : wp7.hitsFirst ? ', predicted to reach 100% in ' + untilText(Date.now() + wp7.hitIn * 60000) : ', about ' + wp7.atReset + '% at its reset');
    // for the bot only (Storm, 19 Oct: "Make the usage stuff not show to the user"): it paces its work by it and doesn't say it in replies
    return 'Plan usage right now: ' + five + week + '.' + (usageTight() ? ' ' + throttleNote() : '') + ' This is for pacing your work only: don\'t mention it in your reply unless Storm asks.';
  }
  // throttle (Storm, 19 Oct: "the team is throttled when I'm on track to hit my usage before reset"): while the 5-hour window is predicted to
  // run out before it resets, or the week to reach 100% first, work timers nudge at most every 15 minutes, sleeping bots aren't woken, and
  // every bot is told to keep its turns small. Settings can turn it off (team.throttle: false)
  const THROTTLE_NOTE = 'The team is throttled: at this pace the plan runs out before it resets. Keep this turn short, skip subagents, workflows and long test runs unless Storm asked for them, and stop once the current step is done.';
  const THROTTLE_NUDGE_MS = 30 * 60000;   // Storm, 20 Oct: "stop messaging bots so much dude you can tell what the usage is" (was 15 minutes)
  function usageTight() { return !!throttleWhy(); }
  // Storm, 25 Nov: plan usage on the phone, with "Slow the team down to save usage" and a limit. The switch (phone or the usage menu)
  // wins over team.json's throttle once it's been set; the limit also slows the team once the 5-hour window reaches it.
  function throttleOn() { return typeof S.throttleOn === 'boolean' ? S.throttleOn : !(S.team && S.team.throttle === false); }
  function fiveNow() {
    const pace = usagePace();
    return pace && pace.w ? usageNow(pace.w) : null;
  }
  // why the team is throttled: 'pace' (on track to run out before the reset), 'limit' (past Storm's limit) or '' (it isn't)
  function throttleWhy() {
    if (S.selftest && !S.throttleTest) return '';
    if (!throttleOn()) return '';
    if (S.throttleTest) return 'pace';
    const pace = usagePace();
    if (pace && pace.ready && !pace.reachesReset) return 'pace';
    const wp7 = weekPace();
    if (wp7 && wp7.ready && wp7.hitsFirst) return 'pace';
    const w = fiveNow();
    if (S.usageLimit && w && (w.percentUsed || 0) >= S.usageLimit) return 'limit';
    return '';
  }
  function throttleNote() {
    return throttleWhy() === 'limit'
      ? 'The team is throttled: the 5-hour window passed Storm\'s ' + S.usageLimit + '% limit. Keep this turn short, skip subagents, workflows and long test runs unless Storm asked for them, and stop once the current step is done.'
      : THROTTLE_NOTE;
  }
  // the switch and the limit, from the phone (usage.settings) or the usage menu
  function setUsageSettings(r) {
    if (typeof r.throttle === 'boolean') S.throttleOn = r.throttle;
    if (r.limit === null || (Number.isInteger(r.limit) && r.limit >= 10 && r.limit <= 100)) {
      if ('limit' in r) S.usageLimit = r.limit;
    }
    renderUsage(); saveSoon();
  }
  // ---------- today's jobs per bot (timed from a run's start to its end, by Squall itself) ----------
  function workDayKey(t) { const d = new Date(t); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function workTodayNow() {
    const k = workDayKey(Date.now());
    if (!S.workToday || S.workToday.day !== k) S.workToday = { day: k, bots: {} };
    return S.workToday;
  }
  function countWork(name, startedAt) {
    if (!name || !startedAt || S.mock || S.selftest) return;   // demo and self-test runs aren't real work
    const w = workTodayNow(), now = Date.now();
    const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
    const ms = Math.max(0, now - Math.max(startedAt, midnight.getTime()));   // only the part of a job that ran today
    const b = w.bots[name] && typeof w.bots[name] === 'object' ? w.bots[name] : (w.bots[name] = { jobs: 0, ms: 0 });
    b.jobs = (b.jobs | 0) + 1; b.ms = (Number(b.ms) || 0) + ms;
    saveSoon();
  }
  // what the phone's Plan usage screen gets (web/link.js turns it into state.usage): only what Squall really read or measured
  function usageForPhone() {
    const pace = usagePace(), wp7 = weekPace();
    const windows = S.usage && Array.isArray(S.usage.windows) ? S.usage.windows.map(usageNow).map(w => ({ label: String(w.label || ''), percentUsed: Number(w.percentUsed) || 0, resetsAt: w.resetsAt || '' })) : [];
    const today = workTodayNow();
    return {
      windows,
      // when each window runs out at this pace (only when that's before its reset), as a time: the 5-hour pace counts from its newest
      // reading and the week's hitIn from now, so the time stays put between readings
      five: pace && pace.w ? { label: String(pace.w.label || ''), ready: !!pace.ready, atReset: pace.ready && pace.atReset != null ? pace.atReset : null,
        outAt: pace.ready && !pace.reachesReset && S.usageHist.length ? S.usageHist[S.usageHist.length - 1].t + pace.outMin * 60000 : null } : null,
      week: wp7 && wp7.w ? { label: String(wp7.w.label || ''), ready: !!wp7.ready, atReset: wp7.ready ? wp7.atReset : null,
        outAt: wp7.ready && wp7.hitsFirst ? Date.now() + wp7.hitIn * 60000 : null } : null,
      throttleOn: throttleOn(), limit: S.usageLimit, why: throttleWhy(),
      readAt: S.usage && S.usageAt ? S.usageAt : null, overage: !!(S.usage && S.usage.overage),
      today: { day: today.day, bots: today.bots },
    };
  }
  function openUsageMenu() {
    closeUsageMenu(); closeModelMenu(); closeCtxMenu(); closeTimerDial();
    const pace = usagePace();
    const wp7 = weekPace();
    const wk7 = !wp7 ? '' : !wp7.ready ? 'Weekly: predicting needs two hours of readings.' : wp7.hitsFirst ? 'Weekly: at this pace the week reaches 100% in about ' + untilText(Date.now() + wp7.hitIn * 60000) + ', before it resets.' : 'Weekly: at this pace you’ll be at about ' + wp7.atReset + '% when the week resets, in ' + untilText(Date.now() + wp7.resetMin * 60000) + '.';
    let body;
    if (!S.usage) body = '<div class="use-note">Usage shows up with the next Claude reply: every Claude run Squall starts reports your plan’s 5-hour and weekly use.</div>';
    else body = S.usage.windows.map(usageNow).map(w => '<div class="use-row"><span>' + esc(w.label) + '</span><b>' + Math.round(w.percentUsed || 0) + '%</b><small>' + esc(w.resetsIn ? 'resets in ' + w.resetsIn : '') + '</small></div><div class="use-bar"><i style="width:' + Math.min(100, Math.round(w.percentUsed || 0)) + '%"></i></div>').join('') +
      '<div class="use-note">' + (!pace || !pace.ready ? 'Predicting needs a few minutes of readings.' : !pace.reachesReset ? 'At this pace you run out in about ' + Math.round(pace.outMin) + ' min, before the reset.' : pace.atReset !== null ? 'At this pace you’ll be at about ' + pace.atReset + '% when it resets.' : pace.outMin === null ? 'At this pace the window doesn’t fill up.' : 'At this pace you make it to the reset.') + '</div>' +
      (wk7 ? '<div class="use-note">' + esc(wk7) + '</div>' : '');
    const pop = document.createElement('div');
    pop.className = 'use-pop';
    const why = throttleWhy();
    // the same switch and limit as the phone's Plan usage screen (Storm, 25 Nov)
    const limits = [null, 50, 60, 70, 80, 90];
    const save = '<div class="use-save"><label class="use-slow"><input type="checkbox" id="use-slow"' + (throttleOn() ? ' checked' : '') + '> Slow the team down to save usage</label>' +
      '<div class="use-row"><span>Also slow down at</span><select id="use-limit" class="set-select"' + (throttleOn() ? '' : ' disabled') + '>' +
      limits.map(v => '<option value="' + (v || '') + '"' + ((S.usageLimit || null) === v ? ' selected' : '') + '>' + (v ? v + '% of the 5-hour window' : 'Only when it would run out') + '</option>').join('') + '</select></div>' +
      (why ? '<div class="use-note">' + (why === 'limit' ? 'Slowing down now: the 5-hour window passed your ' + S.usageLimit + '% limit.' : 'Slowing down now: at this pace the plan runs out before it resets.') + '</div>' : '') + '</div>';
    pop.innerHTML = '<div class="use-title">Plan usage</div>' + body + save;
    document.body.append(pop);
    const slow = pop.querySelector('#use-slow'), lim = pop.querySelector('#use-limit');
    if (slow) slow.addEventListener('change', () => { setUsageSettings({ throttle: slow.checked }); openUsageMenu(); });
    if (lim) lim.addEventListener('change', () => { setUsageSettings({ limit: lim.value ? Number(lim.value) : null }); openUsageMenu(); });
    const r = $('#usage').getBoundingClientRect();
    pop.style.left = Math.max(10, Math.min(window.innerWidth - pop.offsetWidth - 10, r.left)) + 'px';
    placeTop(pop, r);
  }
  function closeUsageMenu() { document.querySelectorAll('.use-pop').forEach(x => x.remove()); }

  // ---------- voice, offline and open source (Storm: "stop using windows stuff"; "Download both and use Vosk first").
  // The mic is captured here at 16 kHz and sent to the host in quarter-second chunks; Vosk turns it into text there.
  // Two modes (Storm: "Get the dictation and voice call working"):
  //   dictation, the mic button: what you say goes into the box, and you send it;
  //   voice call, the phone button: hands-free. A finished phrase is sent and the reply shows on the call screen; nothing is read
  //   aloud (Storm: "Remove the text to speech voice from voice chat I don't like it").
  let voiceOn = false, voiceMode = 'dictate', voiceReady = false, voiceBase = '', voiceTimer = null;
  let micStream = null, micCtx = null, micSrc = null, micNode = null, voiceQueue = [], voicePumping = false, voiceLoading = false, voiceEngineReady = false, voicePlaceholder = '';
  let voiceFixes = {}, voiceHold = 0, whisperMissingSaid = false;
  const CALL_WAIT_MS = 6000;   // accurate calls wait this long at most for Whisper's words (about a second usually; longer when a bot is starting or a game runs)
  // Storm: "voice chat should tell the bot that I'm using voice chat and to account for misspelling or weird words"
  let voiceSending = false, dictatedBox = false;
  let voicePre = '', voiceFulls = {};   // dictation's last pass: the box's text from before dictation, and full passes on their way
  $('#input').addEventListener('input', () => { if (!$('#input').value.trim()) dictatedBox = false; });   // Whisper: phrases waiting for its words; a call phrase held for them
  const joinVoice = (a, b) => ((a || '') + ' ' + (b || '')).trim();
  $('#input').addEventListener('input', () => { voiceReady = false; });   // typing takes over: a held phrase is then only sent by Enter
  function renderVoice() {
    const b = $('#voice'), c = $('#call');
    if (b) {
      b.classList.toggle('on', voiceOn && voiceMode === 'dictate'); b.classList.toggle('loading', voiceLoading && voiceMode === 'dictate');
      b.title = voiceOn && voiceMode === 'dictate' ? 'Dictation is on: click to stop' : 'Dictation: talk, and it types into the box';
    }
    if (c) {
      c.classList.toggle('on', voiceOn && voiceMode === 'call'); c.classList.toggle('loading', voiceLoading && voiceMode === 'call');
      c.title = voiceOn && voiceMode === 'call' ? 'Voice call is on: click to hang up' : 'Voice call: talk hands-free, and the replies show on screen';
    }
  }
  const VOICE_NOTE = 'Storm said this by voice, through speech-to-text, so some words may be misheard or odd. Go by what he most likely meant, and ask if it really isn’t clear.';
  const CALL_NOTE = 'This is a live voice call: Storm talks to you and reads your reply on the call screen. Answer in 1 to 3 short sentences, with no lists, headings or code, and don’t read files or run tools unless what he asked needs them. If he asks you to hang up or end the call, or says goodbye, reply with a short goodbye and end your reply with ```squall {"actions":[{"do":"hang_up"}]}``` and the call ends.';
  // the bot (or a live session) ends the call when Storm asks (Storm: "I want there to be a feature to where Claude can hang up the call"),
  // after a short pause so the goodbye can be read on the call screen
  function callHangUpSoon(by) {
    if (!voiceOn || voiceMode !== 'call') return false;
    const chat = activeChat();
    setTimeout(() => { if (voiceOn && voiceMode === 'call') { voiceStop(); addMessage(chat, { who: APP, kind: 'event', text: (by || 'The bot') + ' hung up the call.' }); } }, 1800);
    return true;
  }
  // "hang up", "end the call", "okay hang up the call": said on its own, it ends the call at once, without waiting for the bot
  const HANGUP_RX = /^(ok(ay)?[,.]?\s+)?(please\s+)?(you can\s+)?(bye[,.!]?\s+|goodbye[,.!]?\s+)?(hang\s*up|end\s+(the\s+)?call)(\s+(the\s+)?(call|phone))?(\s+(now|please))*[.!]*$/i;   // faster replies in calls (Storm: "Is there a way to get faster responses")
  // echo cancellation only in a voice call (Storm: "Make echo cancellation only for voice chat"): dictation hears the plain microphone,
  // which keeps more of each word for Whisper
  // In a call Squall's own canceller cleans the mic (Storm picked it: the browser's only knows Squall's own sound, and in a call there is none),
  // so the browser's echo cancellation and noise suppression are off then: they'd change the sound the canceller learns the room from
  const ownEcho = mode => S.echoOwn !== false;   // Storm, 19 Oct: "cut out everything that is speaker audio": Squall's canceller in dictation too, not only calls
  const micConstraints = mode => ({ audio: { channelCount: 1, echoCancellation: mode === 'call' && !ownEcho(mode), noiseSuppression: !ownEcho(mode), autoGainControl: true } });
  function voiceToggle(mode) {
    mode = mode || 'dictate';
    if (voiceOn && voiceMode === mode) { voiceStop(); return; }
    if (voiceOn) voiceStop();
    voiceStart(mode);
  }
  async function voiceStart(mode) {
    const chat = activeChat();
    voiceMode = mode; voiceOn = true; voiceLoading = true; voiceEngineReady = false; sfx('voiceOn');
    voiceBase = mode === 'call' ? '' : $('#input').value.trim(); voiceReady = false; voicePre = voiceBase;
    if (mode === 'call') callOpen();
    renderVoice();
    try {
      // the microphone first, while the click still counts as Storm's gesture (later, the audio can stay paused and nothing is heard);
      // its chunks wait in the queue until the speech engine has loaded
      micCtx = new AudioContext({ sampleRate: 16000 });
      micStream = await navigator.mediaDevices.getUserMedia(micConstraints(mode));
      if (!voiceOn) { micStream.getTracks().forEach(t => t.stop()); micStream = null; return; }
      try { const ms = micStream.getAudioTracks()[0].getSettings(); Bridge.call('log', { level: 'voice', msg: 'mic (' + mode + '): echo cancellation ' + (ms.echoCancellation ? 'on' : 'off') + ', noise suppression ' + (ms.noiseSuppression ? 'on' : 'off') }).catch(() => { }); } catch (e) { }
      if (micCtx.state === 'suspended') { try { await micCtx.resume(); } catch (e) { } }
      micSrc = micCtx.createMediaStreamSource(micStream);
      micNode = micCtx.createScriptProcessor(4096, 1, 1);   // a quarter second per chunk at 16 kHz
      micNode.onaudioprocess = e => { if (voiceOn && !callMuted) voiceChunk(e.inputBuffer.getChannelData(0)); };
      micSrc.connect(micNode); micNode.connect(micCtx.destination);
      voiceTimer = setInterval(voiceTick, 500);
      if (mode === 'dictate') { voicePlaceholder = $('#input').placeholder; $('#input').placeholder = 'Listening… talk and it types here'; }
      const words = S.agents.map(x => x.name).concat(['Squall', 'Storm', 'Obsidian', 'EVO', 'Claude', 'Roblox', 'Nimbus']).filter((w, i, all) => all.indexOf(w) === i).join(', ');   // Whisper hears names better when it knows them
      const vs = await Bridge.call('voiceStart', { rate: 16000, engine: S.voiceEngine, words, mode, callWait: !!S.callWait, echo: ownEcho(mode) });   // the first start loads the speech model (a couple of seconds)
      voiceEngineReady = true;
      if (S.voiceEngine === 'whisper' && vs && !vs.whisperFound && !whisperMissingSaid) { whisperMissingSaid = true; addMessage(chat, { who: APP, kind: 'event', text: 'Whisper isn’t installed next to Squall, so voice uses Vosk alone.' }); }
      if (S.voiceEngine === 'parakeet' && vs && !vs.parakeetFound && !whisperMissingSaid) { whisperMissingSaid = true; addMessage(chat, { who: APP, kind: 'event', text: 'Parakeet isn’t installed yet, so Whisper does the passes.' }); }
      if (micCtx && micCtx.state !== 'running') Bridge.call('log', { level: 'voice', msg: 'the audio is ' + micCtx.state }).catch(() => { });
      pumpVoice();
    } catch (e) {
      const name = String(e && (e.name || e.message) || e);
      voiceStop(true);
      const why = /NotAllowed|Permission|Security/i.test(name) ? 'The microphone is blocked for Squall. Allow it in Windows (Settings → Privacy & security → Microphone), then try again.'
        : /NotFound|DevicesNotFound|Overconstrained/i.test(name) ? 'No microphone was found. Plug one in, then try again.'
        : 'Voice couldn’t start: ' + (e && e.message || name);
      addMessage(chat, { who: APP, kind: 'error', text: why });
    } finally { voiceLoading = false; renderVoice(); }
  }
  function voiceStop(quiet) {
    const wasOn = voiceOn, mode = voiceMode, base = voiceBase;
    if (voiceOn) sfx('voiceOff');
    voiceOn = false; voiceReady = false; voiceQueue = []; voiceBase = ''; voiceEngineReady = false; voiceHold = 0;
    if (voicePlaceholder) { $('#input').placeholder = voicePlaceholder; voicePlaceholder = ''; }
    clearInterval(voiceTimer); voiceTimer = null;
    try { if (micNode) { micNode.onaudioprocess = null; micNode.disconnect(); } if (micSrc) micSrc.disconnect(); } catch (e) { }
    try { if (micStream) micStream.getTracks().forEach(t => t.stop()); } catch (e) { }
    try { if (micCtx) micCtx.close(); } catch (e) { }
    micNode = micSrc = micStream = micCtx = null;
    if (wasOn && mode === 'call' && callStart) {   // a short summary in the chat when a call ends: how long, and how many phrases were sent
      const secs = Math.round((Date.now() - callStart) / 1000);
      addMessage(activeChat(), { who: APP, kind: 'event', text: 'Voice call ended · ' + Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0') + ' · ' + callPhrases + (callPhrases === 1 ? ' phrase' : ' phrases') + ' sent' });
      callStart = 0;
    }
    if (mode === 'call') callClose();
    const pre = voicePre;
    if (wasOn) Bridge.call('voiceStop', { mode }).then(r => {
      // the last words still being heard: dictation keeps them in the box
      if (!quiet && mode === 'dictate' && r && r.text) { $('#input').value = joinVoice(base, r.text); autosize(); saveDraft(); dictatedBox = true; if (r.seq) voiceFixes[r.seq] = { vosk: r.text }; }
      if (!quiet && mode === 'dictate' && r && r.fullSeq) voiceFulls[r.fullSeq] = { pre, after: $('#input').value };
    }).catch(() => { });
    renderVoice();
  }
  // one chunk of mic audio: 16-bit samples, base64, to the host in order
  function voiceChunk(f32) {
    const pcm = new Int16Array(f32.length);
    let sum = 0;
    for (let i = 0; i < f32.length; i++) { const s = Math.max(-1, Math.min(1, f32[i])); sum += s * s; pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
    callLevel = Math.max(callLevel, Math.min(1, Math.sqrt(sum / Math.max(1, f32.length)) * 9));
    const bytes = new Uint8Array(pcm.buffer);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    voiceQueue.push(btoa(bin));
    if (voiceQueue.length > 40) voiceQueue.splice(0, voiceQueue.length - 40);   // never fall far behind: drop the oldest audio
    pumpVoice();
  }
  async function pumpVoice() {
    if (voicePumping || !voiceEngineReady) return;   // before the engine is ready, chunks wait in the queue
    voicePumping = true;
    try {
      while (voiceOn && voiceQueue.length) {
        const r = await Bridge.call('voiceAudio', { pcm: voiceQueue.shift() }).catch(() => null);
        if (r) voiceHeard(r.kind, r.text || '', r.seq);
      }
    } finally { voicePumping = false; }
  }
  // what Vosk heard: a partial phrase shows in the box as it's heard; a finished one stays there (dictation) or is sent (voice call)
  function voiceHeard(kind, text, seq) {
    if (!voiceOn) return;
    if (kind === 'final') {
      if (!String(text).trim()) return;
      voiceBase = joinVoice(voiceBase, text);
      if (seq) voiceFixes[seq] = { vosk: text };   // Whisper is writing this phrase down again
      if (voiceMode === 'call') {
        if (HANGUP_RX.test(String(text).trim())) { const hc = activeChat(); voiceStop(); addMessage(hc, { who: APP, kind: 'event', text: 'You hung up the call.' }); return; }
        callSay('.call-heard', voiceBase); $('#input').value = voiceBase;
        if (seq && S.callWait) { voiceHold = seq; setTimeout(() => { if (voiceHold === seq) { voiceHold = 0; voiceReady = true; voiceFlush(); } }, CALL_WAIT_MS); return; }   // accurate words: wait for Whisper's take (voiceFix releases it, usually after about a second)
        voiceReady = true; voiceFlush(); return;   // fastest: sent the moment the phrase ends, with no wait for Whisper (Storm: "make the voice chat send the message faster")
      }
      $('#input').value = voiceBase; autosize(); saveDraft(); dictatedBox = true;
      return;
    }
    if (kind === 'partial' && text) { if (voiceMode === 'call') callSay('.call-heard', joinVoice(voiceBase, text)); else { $('#input').value = joinVoice(voiceBase, text); autosize(); } }
  }
  // Whisper's words for a finished phrase replace what Vosk heard: in the box (dictation), or before the phrase is sent (voice call)
  // how much two takes say the same words (0 to 1, case and punctuation ignored): a take that's mostly other words is not swapped in
  function sameWords(a, b) {
    const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
    const x = norm(a), y = norm(b);
    if (!x.length || !y.length) return 0;
    const pool = y.slice();
    let hit = 0;
    for (const w of x) { const i = pool.indexOf(w); if (i >= 0) { hit++; pool.splice(i, 1); } }
    return 2 * hit / (x.length + y.length);
  }
  // how alike two takes sound: letter pairs in common (0 to 1), so "this the bag that noise" and "Just the background noise." count as alike
  function sameSounds(a, b) {
    const pairs = s => { const t = String(s || '').toLowerCase().replace(/[^a-z]+/g, ''), out = []; for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2)); return out; };
    const x = pairs(a), y = pairs(b);
    if (!x.length || !y.length) return 0;
    const pool = y.slice();
    let hit = 0;
    for (const p of x) { const i = pool.indexOf(p); if (i >= 0) { hit++; pool.splice(i, 1); } }
    return 2 * hit / (x.length + y.length);
  }
  // Whisper's (or Parakeet's) take replaces Vosk's when it's the same speech heard better: mostly the same words, or words that sound alike
  // (Storm: "Still bad dictation on voice calls": Vosk's rough guesses were kept because only half their words matched). Left out: the filler
  // Whisper says over noise ("Yeah, yeah."), a take far longer than what was heard, and made-up names that sound nothing like it ("Saponis")
  const FILLER_RX = /^(?:(?:thank you|thanks(?: for watching)?|you|okay|ok|yeah|yes|bye|so|um+|uh+|hmm+)[.!?,]*\s*)+$/i;
  function trustTake(better, heard) {
    const w = String(better || '').trim(), h = String(heard || '').trim();
    if (!w) return false;
    if (sameWords(w, h) >= 0.5) return true;
    const count = s => s.split(/\s+/).filter(Boolean).length;
    if (FILLER_RX.test(w) || count(w) > count(h) * 2 + 3) return false;
    return sameSounds(w, h) >= 0.3;
  }
  // A call's phrase written by warm Parakeet (Storm, 19 Oct: "Make voice calls have more accurate transcription and test it"): its take is
  // used unless it's empty, or filler where Vosk heard words. Checking it against Vosk (trustTake) threw right answers away when Vosk was
  // badly wrong, which in noise is most of the time (lab\call-accuracy)
  function takeParakeet(better, heard) {
    const p = String(better || '').trim(), h = String(heard || '').trim(), count = s => s.split(/\s+/).filter(Boolean).length;
    // a take far longer than what Vosk heard has other people's words in it (people talking in the room): Vosk's stays (call test: 30.4% vs 32.6%)
    return !!p && !(FILLER_RX.test(p) && !FILLER_RX.test(h)) && count(p) <= count(h) * 1.5 + 2;
  }
  function voiceFix(seq, text, by) {
    const f = voiceFixes[seq];
    delete voiceFixes[seq];
    if (!f) return false;
    const better = String(text || '').trim();
    if (better && better !== f.vosk && (by === 'Parakeet' ? takeParakeet(better, f.vosk) : trustTake(better, f.vosk))) {   // the careful take replaces Vosk's when it's the same speech heard better (noise and made-up names stay out)
      const box = $('#input'), oldBase = voiceBase, i = oldBase.lastIndexOf(f.vosk);
      if (voiceOn && i >= 0) voiceBase = oldBase.slice(0, i) + better + oldBase.slice(i + f.vosk.length);
      let v = box.value;
      if (voiceOn && i >= 0 && v.startsWith(oldBase)) v = voiceBase + v.slice(oldBase.length);
      else { const j = v.lastIndexOf(f.vosk); if (j >= 0) v = v.slice(0, j) + better + v.slice(j + f.vosk.length); }
      if (v !== box.value) { box.value = v; autosize(); saveDraft(); }
      if (voiceOn && voiceMode === 'call') callSay('.call-heard', voiceBase);
    }
    if (voiceHold === seq) { voiceHold = 0; voiceReady = true; voiceFlush(); }
    return true;
  }
  Bridge.on('voiceFix', m => voiceFix(m.seq, m.text, m.by));
  // dictation's last passes (Storm: "Make it do 5 passes over the audio"): three takes on the whole recording and a vote between them.
  // The result replaces what was dictated, unless Storm has edited the box since
  function voiceFullPass(seq, text, by) {
    const f = voiceFulls[seq];
    delete voiceFulls[seq];
    const better = String(text || '').trim(), box = $('#input');
    const heardHere = f ? f.after.slice(f.pre.length) : '';
    const good = !!f && !!better && box.value === f.after && trustTake(better, heardHere);   // a take that says other words is left out
    voicePassHint(0, good ? (by === 'Parakeet' ? 'Checked by Parakeet ✓' : 'Checked 5 times ✓') : '');
    if (!good) return false;
    box.value = joinVoice(f.pre, better); autosize(); saveDraft(); dictatedBox = true;
    return true;
  }
  Bridge.on('voiceFull', m => voiceFullPass(m.seq, m.text, m.by));
  // the passes show where the Enter hint is: "Checking your words · pass 3 of 5" (3 of 3 when Parakeet does the last pass), then "Checked ✓" for a moment
  let voiceHintText = '', voiceHintTimer = 0;
  function voicePassHint(pass, done, of) {
    const h = $('#hint');
    if (!h) return;
    if (!voiceHintText) voiceHintText = h.textContent;
    clearTimeout(voiceHintTimer);
    h.classList.toggle('voice-passing', !!pass || !!done);
    h.textContent = pass ? 'Checking your words · pass ' + pass + ' of ' + (of || 5) : done || voiceHintText;
    if (!pass && done) voiceHintTimer = setTimeout(() => { h.textContent = voiceHintText; h.classList.remove('voice-passing'); }, 2500);
  }
  Bridge.on('voicePass', m => voicePassHint(m.pass, '', m.of));
  // every half second: a voice call sends a held phrase once the chat is free
  function voiceTick() { if (voiceOn) voiceFlush(); }
  function voiceFlush() {
    if (!voiceOn || !voiceReady || voiceHold || voiceMode !== 'call') return;
    if (S.flows[activeChat().id]) return;   // a reply is still being written: the phrase waits in the box
    voiceReady = false; voiceBase = '';
    voiceSending = true; callPhrases++;
    send();
  }
  // a voice call shows the reply on the call screen as it's written, and the finished reply when it's in. Nothing is read aloud
  // (Storm: "Remove the text to speech voice from voice chat I don't like it"), so the mic keeps listening the whole time
  const callText = s => String(s || '').replace(/```(?:squall|tempest)[\s\S]*?(```|$)/gi, ' ').replace(/```[\s\S]*?(```|$)/g, ' [code] ').replace(/`([^`]*)`/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\*+/g, '').replace(/^#+\s*/gm, '').replace(/[>|]+/g, ' ').replace(/\s+/g, ' ').trim();
  function callStreamFeed(a, text) {
    const chat = activeChat();
    if (chat && chat.kind === 'dm' && chat.members[0] === a.name) callReply(text);
  }
  function callReply(text) {
    if (!voiceOn || voiceMode !== 'call') return;
    const t = callText(text), el = document.querySelector('#call-ui .call-reply');
    if (!t || !el) return;
    el.textContent = t.length > 600 ? '…' + t.slice(-600) : t;
    el.classList.toggle('long', t.length > 200);   // a long reply keeps its newest lines in view and fades the top
  }

  // ---------- the call screen (Storm: "It doesn't pull up any visual voice chat"): who you're talking to and what it's doing,
  // what it heard you say and the reply it's reading, your mic level, a timer, Mute and Hang up ----------
  let callStart = 0, callLevel = 0, callMuted = false, callPhrases = 0;   // callPhrases: the phrases sent in this call (the summary line when it ends)
  function callOpen() {
    callClose(true);
    const chat = activeChat(), dm = chat.kind === 'dm', name = dm ? chat.members[0] : chat.name, a = dm ? S.byName[name] : null;
    const ui = document.createElement('div');
    ui.id = 'call-ui';
    ui.className = 'call-ui';
    ui.style.setProperty('--c', a ? a.color : '#a78bfa');
    ui.innerHTML = '<div class="call-card">' +
      '<div class="call-top"><span class="call-title">Voice call · ' + esc(name) + '</span><span class="call-time">0:00</span></div>' +
      '<div class="call-orb-wrap"><div class="call-ring r1"></div><div class="call-ring r2"></div><div class="call-orb">' + (a ? avatar(a.name, a.color) : groupIcon(chat)) + '</div></div>' +
      '<div class="call-state">' + (function () { const st = callState(); return st + (st === 'Muted' ? '' : '…'); })() + '</div>' +   // the real state from the start, not a stale "Connecting"
      (S.echoOwn !== false ? '<div class="call-echo" title="Squall’s own echo canceller: it hears what your speakers play and takes that sound out of the mic">Echo canceller on</div>' : '') +
      '<div class="call-bars">' + Array.from({ length: 20 }, () => '<i></i>').join('') + '</div>' +
      '<div class="call-heard"></div><div class="call-reply"></div>' +
      '<div class="call-btns"><button class="call-mute" data-act="callmute">Mute</button><button class="call-end" data-act="callend">Hang up</button></div><div class="call-tip">Say “hang up” to end the call</div></div>';
    ($('#center') || document.body).appendChild(ui);
    requestAnimationFrame(() => ui.classList.add('show'));
    callStart = Date.now(); callMuted = false; callLevel = 0; callPhrases = 0;
    requestAnimationFrame(callFrame);
  }
  // the echo canceller's number on the call screen, every 2 s: how much of the speakers' sound it takes out
  function echoLine(m) {
    return !m.on ? 'Echo canceller on · speakers quiet' : m.learned && m.db > 0 ? 'Speakers −' + m.db + ' dB' : 'Echo canceller learning your room…';
  }
  Bridge.on('echoStats', m => { const el = $('#call-ui .call-echo'); if (el) { el.textContent = echoLine(m); el.classList.toggle('good', !!(m.on && m.learned && m.db >= 10)); } });
  function callClose(instant) {
    const ui = $('#call-ui');
    if (!ui) return;
    if (instant) { ui.remove(); return; }
    ui.id = ''; ui.classList.remove('show'); ui.classList.add('hide');
    setTimeout(() => ui.remove(), 280);
  }
  function callSay(sel, text) { const el = document.querySelector('#call-ui ' + sel); if (el) el.textContent = String(text || ''); }
  function callMute() {
    callMuted = !callMuted;
    const b = document.querySelector('#call-ui .call-mute');
    if (b) { b.classList.toggle('on', callMuted); b.textContent = callMuted ? 'Unmute' : 'Mute'; }
  }
  function callState() {
    const chat = activeChat(), mi = mirrorFor(chat);
    if (voiceLoading) return 'Connecting';
    if (callMuted) return 'Muted';
    if (voiceHold) return 'Checking your words';   // accurate words: the phrase waits for Whisper's take (at most CALL_WAIT_MS), then goes
    if (voiceReady || S.flows[chat.id] || (mi && mirrorBusy(mi, false))) return 'Thinking';
    return 'Listening';
  }
  function callFrame() {
    const ui = $('#call-ui');
    if (!ui) return;
    const s = Math.floor((Date.now() - callStart) / 1000);
    ui.querySelector('.call-time').textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    const st = callState();
    ui.querySelector('.call-state').textContent = st + (st === 'Muted' ? '' : '…');
    ui.dataset.state = st.toLowerCase();
    callLevel *= 0.9;
    const now = Date.now();
    ui.querySelectorAll('.call-bars i').forEach((b, i) => {
      const v = st === 'Listening' ? callLevel * (0.55 + 0.45 * Math.abs(Math.sin(i * 1.7 + now / 400))) : 0.08;
      b.style.transform = 'scaleY(' + Math.max(0.08, Math.min(1, v)).toFixed(2) + ')';
    });
    ui.style.setProperty('--lvl', (st === 'Listening' ? Math.min(1, callLevel) : 0).toFixed(2));
    requestAnimationFrame(callFrame);
  }
  // ---------- add a teammate: a new Claude session Squall runs for you; it's added to team.json and the team reloads ----------
  // Storm (26 Oct, via Groky): "Creating bots in Squall are a bit boring. Fix that." The form is a little studio now: a live preview of the
  // bot, role presets that fill the role, color and brief, a dice for a name, a custom color, live name checks and a birth animation.
  // It still sends only name, role, color and prompt to teamAdd, so team.json keeps its format.
  const BOT_PRESETS = [
    { id: 'generalist', label: 'Generalist', icon: '✦', color: '#A78BFA', role: 'Generalist', brief: '' },
    { id: 'coder', label: 'Coder', icon: '</>', color: '#3D9BE9', role: 'Coder', brief: 'You write and fix code: read the files first, make the smallest change that works, and say exactly what you changed and what you could not test.' },
    { id: 'researcher', label: 'Researcher', icon: '⌕', color: '#4FE3C1', role: 'Researcher', brief: 'You dig up facts: search the web, read the sources, and answer with the result first and a link for every claim. Say what you could not confirm.' },
    { id: 'writer', label: 'Writer', icon: '✎', color: '#F6D860', role: 'Writer', brief: 'You write: notes, docs, release notes and messages in Storm\'s style, short sentences and plain words, the point first.' },
    { id: 'designer', label: 'Designer', icon: '◐', color: '#F472B6', role: 'Designer', brief: 'You design: dark liquid-glass looks, rounded and floating, with motion. Propose visible polish, not subtle tweaks, and describe it so it can be built.' },
    { id: 'tester', label: 'Tester', icon: '✓', color: '#86EFAC', role: 'Tester', brief: 'You test: try every feature like Storm would, list exact steps for each bug you find, and never call something working that you did not check.' },
    { id: 'scout', label: 'Scout', icon: '⚡', color: '#F59E4B', role: 'Scout', brief: 'You scout: find new ideas, tools and open-source engines Storm could build his own version of, and say how each would fit into Nimbus.' }
  ];
  const BOT_NAMES = ['Nova', 'Gale', 'Zephyr', 'Cirrus', 'Volt', 'Ember', 'Haze', 'Mistral', 'Sirocco', 'Flare', 'Drift', 'Comet', 'Aurora', 'Nimbo', 'Frost', 'Rime', 'Pulse', 'Echo', 'Strata', 'Monsoon', 'Halo', 'Spark', 'Vortex', 'Breeze', 'Tundra', 'Sleet', 'Ion', 'Lumen', 'Orion', 'Cyclone'];
  function suggestBotName(not) {
    const taken = new Set(S.agents.map(a => a.name.toLowerCase()).concat(not ? [String(not).toLowerCase()] : []));
    const free = BOT_NAMES.filter(n => !taken.has(n.toLowerCase()));
    if (free.length) return free[Math.floor(Math.random() * free.length)];
    for (let i = 2; i < 99; i++) if (!taken.has('nova' + i)) return 'Nova' + i;
    return 'Nova';
  }
  function botNameProblem(name) {
    if (!name) return 'Pick a name, or roll the dice.';
    if (!/^[A-Za-z][A-Za-z0-9]{1,19}$/.test(name)) return 'Use a short name: letters and digits, starting with a letter (2 to 20 characters).';
    if (S.agents.some(a => a.name.toLowerCase() === name.toLowerCase())) return name + ' is already on the team.';
    if (S.agents.length >= 12) return 'The team is full (12 teammates).';
    return '';
  }
  // a new teammate from the phone's New teammate sheet: the same checks and steps as the New teammate window here
  async function phoneAddBot(b) {
    const name = String(b.name || '').trim();
    const bad = botNameProblem(name);
    if (bad) throw new Error(bad);
    const role = String(b.role || '').trim(), prompt = String(b.job || '').trim();
    const color = /^#[0-9A-Fa-f]{6}$/.test(b.color || '') ? b.color : '#A78BFA';
    await Bridge.call('teamAdd', { name, role, color, prompt });
    noteTeamChange(name + ' joined the team (added by Storm on the phone).', true);
    S.born = { name, until: Date.now() + 2600 }; sfx('born');
    await saveNow();
    await refreshTeamModel();
    greetNewBot(name, role, 'Storm', prompt);
    await saveNow();
    renderAll();
    // the window reloads for a team change (so every icon matches team.json); a moment later, so the phone hears back first
    if (!S.selftest) setTimeout(needReload, 1500);
  }
  // Wake Chief and Let Chief nap, from the phone. Only a Chief that Squall runs itself sleeps; a live session wakes when you message it
  function phoneChief() {
    const a = S.lead || S.agents.find(x => x.lead);
    if (!a) throw new Error('There’s no Chief on the team.');
    if (S.mirror[a.name] || sessionRunning(a.name)) throw new Error(a.name + ' runs as a live session, so it doesn’t nap. Message it instead.');
    return a;
  }
  function phoneWakeChief() {
    const a = phoneChief(), chat = chatById('dm:' + a.name);
    if (!chat) throw new Error('Chief’s chat isn’t open on the computer.');
    if (agentBusy(a) || a.waking || S.flows[chat.id]) throw new Error(a.name + ' is already working.');
    wakeBot(a);   // runs in the background: Chief looks for something useful, or goes back to sleep
  }
  function phoneNapChief() {
    const a = phoneChief(), chat = chatById('dm:' + a.name);
    if (agentBusy(a) || a.waking || (chat && S.flows[chat.id])) throw new Error(a.name + ' is working right now. It naps when it’s done.');
    a.lastActive = Date.now() - SLEEP_AFTER_MS - 1;
    renderTeamSoon(); saveSoon();
  }
  function openAddTeammate() {
    closeModal();
    const colors = ['#4FE3C1', '#3D9BE9', '#A78BFA', '#F59E4B', '#F6D860', '#F87171', '#F472B6', '#86EFAC'];
    const box = document.createElement('div');
    box.className = 'modal-back';
    box.innerHTML = '<div class="modal add-modal studio">' +
      '<div class="set-head"><h3>New teammate</h3><button class="set-x" data-t="close" title="Close">×</button></div>' +
      '<div class="bs-stage"><div class="bs-orbit"><i></i><i></i><i></i></div><div class="bs-av"></div><div class="bs-meta"><div class="bs-name"></div><div class="bs-role"></div><div class="bs-brief"></div></div></div>' +
      '<div class="add-field">Start from<div class="bs-presets">' + BOT_PRESETS.map((p, i) => '<button class="bs-preset' + (i === 0 ? ' on' : '') + '" data-p="' + p.id + '" style="--c:' + p.color + '"><b>' + esc(p.icon) + '</b>' + esc(p.label) + '</button>').join('') + '</div></div>' +
      '<div class="bs-row"><label class="add-field">Name<span class="bs-name-in"><input id="at-name" type="text" maxlength="20" placeholder="Nova" spellcheck="false" autocomplete="off"><button class="bs-dice" data-t="dice" title="Suggest a name">🎲</button></span></label>' +
      '<label class="add-field">Role<input id="at-role" type="text" maxlength="60" placeholder="Generalist"></label></div>' +
      '<div class="add-field">Color<div class="add-colors">' + colors.map((c, i) => '<button class="add-color' + (i === 2 ? ' on' : '') + '" data-c="' + c + '" style="background:' + c + '" title="' + c + '"></button>').join('') +
        '<label class="add-color bs-custom" title="Any color"><input id="at-color" type="color" value="#a78bfa"></label></div></div>' +
      '<label class="add-field">What they do (optional)<textarea id="at-prompt" rows="3" maxlength="2000" placeholder="Leave empty for a generalist. Or describe a specialty to focus them."></textarea></label>' +
      '<div class="add-hint">A teammate is a new Claude session that Squall runs for you, with its own memory and its own folder. To link a session you start in the Claude app, name it the same as the teammate.</div>' +
      '<div class="add-row"><span id="at-status"></span><button class="set-btn" data-t="close">Cancel</button><button class="vault-go" data-t="add">Bring to life</button></div>' +
      '</div>';
    document.body.append(box);
    const modal = box.querySelector('.modal'), nameIn = box.querySelector('#at-name'), roleIn = box.querySelector('#at-role'), promptIn = box.querySelector('#at-prompt');
    const status = box.querySelector('#at-status'), go = box.querySelector('[data-t="add"]');
    let color = colors[2], busy = false, lastLetter = '';
    const paint = () => {
      const name = nameIn.value.trim(), shown = name || nameIn.placeholder;
      modal.style.setProperty('--c', color);
      const letter = shown.charAt(0).toUpperCase();
      const av = box.querySelector('.bs-av');
      av.innerHTML = avatar(shown, color, 'huge');
      if (letter !== lastLetter) { av.classList.remove('pop'); void av.offsetWidth; av.classList.add('pop'); lastLetter = letter; }
      box.querySelector('.bs-name').textContent = shown;
      box.querySelector('.bs-name').classList.toggle('ghost', !name);
      box.querySelector('.bs-role').textContent = roleIn.value.trim() || 'Generalist';
      const brief = promptIn.value.trim();
      box.querySelector('.bs-brief').textContent = brief ? (brief.length > 110 ? brief.slice(0, 107) + '…' : brief) : 'Research, code, writing: whatever Chief hands them.';
      const bad = name ? botNameProblem(name) : '';
      if (!busy) status.textContent = bad;
      status.classList.toggle('bad', !!bad);
      go.classList.toggle('off', busy || !!botNameProblem(name));
    };
    const setColor = c => {
      color = c;
      box.querySelectorAll('.add-color').forEach(x => x.classList.toggle('on', x.dataset.c === c));
      if (!colors.includes(c)) box.querySelector('.bs-custom').classList.add('on');
      paint();
    };
    const usePreset = id => {
      const p = BOT_PRESETS.find(x => x.id === id); if (!p) return;
      box.querySelectorAll('.bs-preset').forEach(x => x.classList.toggle('on', x.dataset.p === id));
      roleIn.value = p.role; promptIn.value = p.brief; setColor(p.color);
      if (!nameIn.value.trim()) nameIn.value = suggestBotName();
      paint();
    };
    const add = () => {
      const name = nameIn.value.trim();
      const bad = botNameProblem(name);
      if (bad || busy) { status.textContent = bad; nameIn.focus(); modal.classList.remove('shake'); void modal.offsetWidth; modal.classList.add('shake'); return; }
      busy = true; go.classList.add('off'); status.textContent = 'Bringing ' + name + ' to life…';
      Bridge.call('teamAdd', { name, role: roleIn.value, color, prompt: promptIn.value })
        .then(() => {
          noteTeamChange(name + ' joined the team (added by Storm).', true);
          modal.classList.add('born');
          box.querySelector('.bs-name').textContent = name + ' is here';
          status.textContent = 'Added ' + name + '.';
          S.born = { name, until: Date.now() + 2600 }; sfx('born');
          const finish = () => { closeModal(); return refreshTeamModel().then(() => { greetNewBot(name, roleIn.value, 'Storm', promptIn.value); if (!S.selftest) openChat('dm:' + name); return saveNow(); }).then(() => { if (!S.selftest) needReload(); }); };
          return saveNow().then(() => S.selftest ? finish() : new Promise(r => setTimeout(r, 1300)).then(finish));
        })
        .catch(err => { busy = false; status.textContent = err.message; go.classList.remove('off'); status.classList.add('bad'); });
    };
    box.addEventListener('click', e => {
      if (e.target === box) { closeModal(); return; }
      const c = e.target.closest('[data-c]');
      if (c) { setColor(c.dataset.c); return; }
      const p = e.target.closest('[data-p]');
      if (p) { usePreset(p.dataset.p); return; }
      const t = e.target.closest('[data-t]');
      if (!t) return;
      if (t.dataset.t === 'close') { closeModal(); return; }
      if (t.dataset.t === 'dice') { nameIn.value = suggestBotName(nameIn.value.trim()); paint(); t.classList.remove('roll'); void t.offsetWidth; t.classList.add('roll'); return; }
      if (t.dataset.t === 'add') add();
    });
    box.querySelector('#at-color').addEventListener('input', e => setColor(e.target.value.toUpperCase()));
    [nameIn, roleIn, promptIn].forEach(x => x.addEventListener('input', paint));
    nameIn.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
    paint();
    nameIn.focus();
  }

  // ---------- team tools: bots can add, rename and delete teammates and routines (deleting waits for Storm's OK) ----------
  const teamNote = (chat, text) => addMessage(chat, { who: APP, kind: 'event', text });
  // Storm (19 Oct, via Chief): "Make the chief get notified when bots get renamed, added, deleted, demoted, and promoted". Changes a few
  // seconds apart go as one notice to every chief: a chief whose app session is running hears it through the relay, a local one with its
  // next message (kept in the saved state, so the reload after adding a bot doesn't lose it)
  const TEAM_NEWS_MS = 4000;
  let teamNewsQueue = [], teamNewsTimer = 0;
  function noteTeamChange(line, now) {
    teamNewsQueue.push(line);
    clearTimeout(teamNewsTimer);
    if (now) flushTeamNews(); else teamNewsTimer = setTimeout(flushTeamNews, TEAM_NEWS_MS);
  }
  function flushTeamNews() {
    clearTimeout(teamNewsTimer);
    const lines = teamNewsQueue.splice(0);
    if (!lines.length) return;
    const news = S.teamNews || (S.teamNews = {});
    for (const ch of S.agents.filter(a => a.lead)) {
      const dm = chatById('dm:' + ch.name);
      if (dm && mirrorFor(dm)) sendToMirror(dm, 'Team change in ' + APP + ': ' + lines.join(' '), [], [], APP + ' (team): ', APP, '', true);
      else news[ch.name] = (news[ch.name] || []).concat(lines).slice(-20);
    }
    saveSoon();
  }
  function takeTeamNews(name) {
    const lines = (S.teamNews || {})[name];
    if (!lines || !lines.length) return '';
    delete S.teamNews[name]; saveSoon();
    return 'Team changes in ' + APP + ' since your last message: ' + lines.join(' ');
  }
  function askConfirm(chat, by, action, text, yesLabel, noLabel) { addMessage(chat, { who: by, kind: 'confirm', text, action, yesLabel, noLabel }); }
  async function runActions(chat, by, actions) {
    for (const x of actions) {
      try { await doAction(x, chat, by, false); }
      catch (e) { addMessage(chat, { who: APP, kind: 'error', text: 'Couldn’t ' + String(x.do || 'do that').replace(/_/g, ' ') + ': ' + e.message }); }
    }
  }
  // one team action; deleting a bot or a routine needs Storm's OK first (a card in the chat), everything else runs at once
  const ROUTINES_PER_BOT = 4;
  async function doAction(x, chat, by, approved) {
    const what = String(x.do || '').toLowerCase();
    if (what === 'create_bot') {
      await Bridge.call('teamAdd', { name: String(x.name || ''), role: String(x.role || ''), color: String(x.color || ''), prompt: String(x.prompt || '') });
      teamNote(chat, by + ' added a teammate: ' + x.name + '.');
      noteTeamChange(x.name + ' joined the team (added by ' + by + ').');
      await refreshTeamModel(); greetNewBot(String(x.name || ''), String(x.role || ''), by, String(x.prompt || x.brief || '')); await saveNow();
      if (!S.selftest) needReload();
    } else if (what === 'rename_bot') {
      const target = S.agents.find(a => a.name.toLowerCase() === String(x.from || '').trim().toLowerCase());
      if (target && target.lead) { teamNote(chat, target.name + ' can only be renamed by Storm (right-click).'); return; }
      await renameBot(String(x.from || ''), String(x.to || ''), true);
      teamNote(chat, by + ' renamed ' + x.from + ' to ' + x.to + '.');
    } else if (what === 'delete_bot') {
      if (!approved) return askConfirm(chat, by, x, by + ' wants to delete ' + x.name + '. Its chats and routines go too; its folder stays.', 'Delete', 'Keep');
      await deleteBot(String(x.name || ''));
      teamNote(chat, x.name + ' was deleted.');
    } else if (what === 'add_routine') {
      // Storm: "Make the bots able to create routines themselves". A bot may add one when a recurring job helps; each bot keeps at most 4
      const target = String(x.bot || by || '');
      if (by !== 'Storm' && ((S.team && S.team.routines) || []).filter(rt => String(rt.bot).toLowerCase() === target.toLowerCase()).length >= ROUTINES_PER_BOT) { teamNote(chat, target + ' already has ' + ROUTINES_PER_BOT + ' routines, so ' + by + '’s new one wasn’t added. Remove one in Routines first.'); return; }
      const r = await Bridge.call('routineAdd', { name: String(x.name || ''), bot: target, prompt: String(x.prompt || ''), time: String(x.time || ''), days: String(x.days || 'daily'), by });
      S.team.routines = r.routines;
      teamNote(chat, by + ' added a routine: ' + (x.name || 'Routine') + ' (' + x.bot + ', ' + (x.days || 'daily') + ' at ' + x.time + ').');
    } else if (what === 'remove_routine') {
      const rt = (S.team.routines || []).find(r => r.id === x.id || String(r.name).toLowerCase() === String(x.name || '').toLowerCase());
      if (!rt) throw new Error('there’s no routine called ' + (x.name || x.id));
      if (!approved) return askConfirm(chat, by, x, by + ' wants to remove the routine "' + rt.name + '".', 'Remove', 'Keep');
      const r = await Bridge.call('routineRemove', { id: rt.id });
      S.team.routines = r.routines;
      teamNote(chat, 'Routine "' + rt.name + '" removed.');
    } else if (what === 'todo_add') {
      const added = todoAdd(x.text, by);
      if (added && x.start) { added.status = 'doing'; added.who = by; todoSave(); }   // added and started in one go
      if (added) teamNote(chat, by + (x.start ? ' started a to-do: ' : ' added a to-do: ') + added.text.slice(0, 120));
    } else if (what === 'todo_needs') {
      // the To do drive (23 Oct): an item that needs Storm is marked, so the drive leaves it; the pane shows him "needs you", and his next message
      // to a chief clears the marks
      const it = todoFind(x.id || x.text);
      if (it && it.status !== 'done') {
        it.needs = String(x.why || 'Storm').slice(0, 160); it.needsBy = by; todoSave();
        teamNote(chat, by + ' needs Storm for: ' + it.text.slice(0, 120) + (x.why ? ' (' + String(x.why).slice(0, 120) + ')' : ''));
      }
    } else if (what === 'todo_doing' || what === 'todo_done') {
      // a teammate takes an item (or finishes it): its name shows on the item in the To do pane
      const it = todoFind(x.id || x.text);
      if (it && todoSet(it.id, what === 'todo_done' ? 'done' : 'doing')) { it.who = by; todoSave(); teamNote(chat, by + (what === 'todo_done' ? ' finished: ' : ' is on: ') + it.text.slice(0, 120)); }
    } else if (what === 'show_path') {
      // bot tools (Storm, 19 Oct): show a file or folder in Explorer; it changes nothing, so it needs no card
      await Bridge.call('showPath', { path: String(x.path || '') });
      teamNote(chat, by + ' opened ' + String(x.path || '') + ' in Explorer.');
    } else if (what === 'screenshot' || what === 'clipboard_read' || what === 'clipboard_write') {
      // the screen and the clipboard: Storm says yes on a card each time ("take a photo of your screen with permission")
      const asks = { screenshot: [' wants a photo of your screen.', 'Take it'], clipboard_read: [' wants to read what’s on your clipboard.', 'Let it read'], clipboard_write: [' wants to put text on your clipboard: “' + String(x.text || '').slice(0, 120) + '”', 'Copy it'] };
      if (!approved) return askConfirm(chat, by, x, by + asks[what][0], asks[what][1], 'No');
      if (what === 'clipboard_write') { await Bridge.call('clipboardWrite', { text: String(x.text || '') }); teamNote(chat, by + ' put text on your clipboard.'); return; }
      const got = await Bridge.call(what === 'screenshot' ? 'screenCapture' : 'clipboardRead');
      teamNote(chat, what === 'screenshot' ? 'A photo of your screen went to ' + by + '.' : 'Your clipboard went to ' + by + '.');
      const note = what === 'screenshot' ? 'Storm said yes: the photo of his screen is at ' + got + '. Open it with Read, then carry on.' : 'Storm said yes: his clipboard holds:\n' + String(got || '(nothing)').slice(0, 4000) + '\nCarry on.';
      setTimeout(() => converse(chat, '', note, [by]).catch(() => {}), 0);   // the bot gets it as its next message
    } else if (what === 'message_session') {
      // a bot messages a live Claude session (Laptop, a bot's app session) through Squall's relay; the session answers the bot with
      // SendMessage to Squall starting [dm:Bot], which wakes it (Storm, 21:12: "Fix this" after Chief had no channel to Laptop)
      const to = S.agents.find(a => a.name.toLowerCase() === String(x.to || '').trim().toLowerCase());
      const text = String(x.text || '').trim();
      if (!to || !text) throw new Error('message_session needs "to" (a teammate) and "text"');
      if (!S.liveMode || !mirrorLive(to.name)) throw new Error(to.name + '’s Claude session isn’t running, so it can’t be messaged right now');
      const dm = chatById('dm:' + to.name);
      const how = NO_RELAY() ? 'end your reply with a squall block: {"actions":[{"do":"message_session","to":"' + by + '","text":"..."}]}' : 'SendMessage to Squall with the text starting [dm:' + by + ']';
      sendToMirror(dm, text + '\n\n(To answer ' + by + ', ' + how + '.)', [], [], by + ' (via Squall): ', by);
      teamNote(chat, by + ' messaged ' + to.name + '’s session.');
      pingMessage([by, to.name], chat.id);
    } else if (what === 'hang_up') {
      callHangUpSoon(by);   // only does something during a voice call
    } else if (what === 'stop_all') {
      // only the lead stops the whole team (every bot's run, every live session's turn)
      const lead = S.agents.find(a => a.lead);
      if (!lead || by !== lead.name) throw new Error('only ' + (lead ? lead.name : 'the lead') + ' can stop the whole team');
      stopAll();
      teamNote(chat, by + ' stopped every bot.' + (x.why ? ' (' + String(x.why).slice(0, 160) + ')' : ''));
    } else if (what === 'timer_wait') {
      // Storm (23 Oct): "Make a Squall feature for bots to make the timer pause for up to 10 mins". A bot waiting on a long job (a test, a build,
      // a render) holds its chat's work timer for 1 to 10 minutes instead of being nudged every minute. The hold ends by itself, or as soon as
      // the bot is working again, and Storm's next message there starts the timer fresh. (Not the old pause_timer below, which waited for
      // Storm with no end and was taken out on 19 Oct.)
      const t = S.timers[chat.id];
      if (!t) return;
      const mins = Math.max(1, Math.min(10, Math.round(Number(x.minutes) || 10)));
      t.holdUntil = Date.now() + mins * 60000; t.holdBy = by; t.holdIdle = false;
      t.busySeen = false; t.idleSince = 0; t.busyFrom = 0;
      renderTimerChip();
      teamNote(chat, '⏱ ' + by + ' held the work timer for ' + mins + ' min' + (x.why ? ' (' + String(x.why).slice(0, 120) + ')' : '') + ': it nudges again after that, or as soon as ' + by + ' is working.');
    } else if (what === 'pause_timer') {
      // Storm (19 Oct): "Make it so Squall bots can pause the timer so they don't keep looping and wasting usage". A bot with nothing left
      // but Storm's answer pauses its chat's timer; his next message there starts it again (startTimer makes a fresh one)
      // removed (Storm, 19 Oct: "Delete the pause timer feature cause clearly it just slows down progress"): an old block is ignored
      return;
    } else throw new Error('unknown action "' + what + '"');
  }
  async function resolveConfirm(id, yes) {
    let m = null, chat = null;
    for (const c of S.chats) { m = c.messages.find(x => x.id === id); if (m) { chat = c; break; } }
    if (!m || m.resolved) return;
    if (!yes) m.resolved = 'Kept. Nothing was changed.';
    else {
      try { await doAction(m.action || {}, chat, m.who || APP, true); m.resolved = 'Done.'; }
      catch (e) { m.resolved = 'Couldn’t do it: ' + e.message; }
    }
    msgCache.delete(m); renderChat(); saveSoon();
  }
  // ---------- approvals (Storm's must-have: "Approve or deny risky actions from the app"): a bot that wants a tool it can't use on its
  // own, like running a command, asks; Storm answers on a card in the chat it's working in. No answer in 10 minutes means no ----------
  const approvalsOn = () => !(S.team && S.team.approvals === false);
  function approveDetail(m) {
    const inp = m.input || {};
    if (inp.command) return String(inp.command);
    if (inp.file_path) return String(inp.file_path);
    if (inp.url) return String(inp.url);
    try { const s = JSON.stringify(inp); return s === '{}' ? '' : s.length > 300 ? s.slice(0, 300) + '…' : s; } catch (e) { return ''; }
  }
  Bridge.on('approve', m => {
    const run = S.runs[m.runId];
    const chat = (run && run.key && chatById(run.key.split('|')[0])) || chatById('dm:' + m.agent);
    if (!chat) return;
    const a = S.byName[m.agent];
    if (a) { a.needsOk = (a.needsOk || 0) + 1; a.activity = 'Waiting for your OK: ' + (m.display || m.tool); }
    addMessage(chat, { who: m.agent, kind: 'approve', text: m.description || '', approve: { runId: m.runId, requestId: m.requestId, tool: m.display || m.tool, detail: approveDetail(m), canAlways: !!m.canAlways, state: 'waiting' } });
    Bridge.call('attention', { who: m.agent, text: 'needs your OK: ' + (m.display || m.tool) }).catch(() => { });
    sfx('okNeed');
    renderTeamSoon();
  });
  Bridge.on('approveDone', m => { const f = findApproval(m.requestId); if (f && f.m.approve.state === 'waiting') settleApproval(f, m.outcome || 'gone'); });
  function findApproval(rid) {
    for (const c of S.chats) { const m = c.messages.find(x => x.kind === 'approve' && x.approve && x.approve.requestId === rid); if (m) return { m, chat: c }; }
    return null;
  }
  function settleApproval(f, state) {
    f.m.approve.state = state;
    const a = S.byName[f.m.who];
    if (a && a.needsOk) { a.needsOk--; if (!a.needsOk && /^Waiting for your OK/.test(a.activity || '')) a.activity = state === 'once' || state === 'always' ? 'Allowed, carrying on' : 'Carrying on without it'; }
    msgCache.delete(f.m);
    if (f.chat.id === S.active) renderChat();
    renderTeamSoon(); saveSoon();
  }
  async function answerApproval(rid, decision) {
    const f = findApproval(rid);
    if (!f || f.m.approve.state !== 'waiting') return null;
    let r = null;
    try { r = await Bridge.call('approveAnswer', { runId: f.m.approve.runId, requestId: rid, decision }); } catch (e) { r = null; }
    settleApproval(f, r && r.ok ? decision : 'gone');
    sfx(r && r.ok && (decision === 'once' || decision === 'always') ? 'okYes' : 'okNo');
    return r;
  }
  async function renameBot(from, to, byBot) {
    const r = await Bridge.call('teamRename', { from, to, byBot: !!byBot });
    migrateRename(from, r.name);
    if (S.teamNews && S.teamNews[from]) { S.teamNews[r.name] = S.teamNews[from]; delete S.teamNews[from]; }
    noteTeamChange(from + ' was renamed to ' + r.name + '.');
    teamChanged();
  }
  async function deleteBot(name) {
    const r = await Bridge.call('teamRemove', { name });
    migrateRemove(r.name);
    if (S.teamNews) delete S.teamNews[r.name];
    noteTeamChange(r.name + ' was removed from the team.');
    teamChanged();
  }
  // keep the chats, sessions and timers that belong to a renamed or deleted bot in step with team.json
  function migrateRename(from, to) {
    for (const c of S.chats) {
      if (c.id === 'dm:' + from) { c.id = 'dm:' + to; c.name = to; }
      c.members = c.members.map(n => n === from ? to : n);
      if (c.lead === from) c.lead = to;
      for (const m of c.messages) if (m.who === from) m.who = to;
    }
    const s2 = {};
    for (const k of Object.keys(S.sessions)) s2[k.replace('dm:' + from + '|', 'dm:' + to + '|').replace(new RegExp('\\|' + from + '$'), '|' + to)] = S.sessions[k];
    S.sessions = s2;
    const seen2 = {};
    for (const k of Object.keys(S.seen)) seen2[k.replace('dm:' + from + '|', 'dm:' + to + '|').replace(new RegExp('\\|' + from + '$'), '|' + to)] = S.seen[k];
    S.seen = seen2;
    if (S.team && S.team.routines) for (const r of S.team.routines) if (r.bot === from) r.bot = to;
    if (S.active === 'dm:' + from) S.active = 'dm:' + to;
    if (S.timers['dm:' + from]) { S.timers['dm:' + to] = S.timers['dm:' + from]; delete S.timers['dm:' + from]; }
  }
  function migrateRemove(name) {
    S.chats = S.chats.filter(c => c.id !== 'dm:' + name);
    for (const c of S.chats) { c.members = c.members.filter(n => n !== name); if (c.lead === name) c.lead = c.members[0]; }
    S.chats = S.chats.filter(c => c.kind !== 'group' || c.members.length);
    for (const k of Object.keys(S.sessions)) if (k.endsWith('|' + name)) delete S.sessions[k];
    for (const k of Object.keys(S.seen)) if (k.endsWith('|' + name)) delete S.seen[k];
    if (S.team && S.team.routines) S.team.routines = S.team.routines.filter(r => r.bot !== name);
    if (S.active === 'dm:' + name) S.active = 'team';
    delete S.timers['dm:' + name];
  }
  function needReload() { S.reloadWhenIdle = true; reloadIfIdle(); }
  // a team change (add, rename, remove): the app reloads so every icon and chat matches team.json; the self-test refreshes the model instead
  function teamChanged() { if (S.selftest) return refreshTeamModel(); needReload(); return Promise.resolve(); }
  // the team as team.json holds it now: teammates, icons and direct chats follow, the way a reload would show them
  async function refreshTeamModel() {
    const t = await Bridge.call('teamNow');
    const keep = S.byName;
    // the runtime fields come from setupTeam's defaults (a new teammate has no state yet); the team's fields follow team.json
    S.agents = t.agents.map(a => Object.assign({ status: 'idle', activity: 'Ready', turns: [], runId: null, numTurns: null, duration: null, cost: null, model: '' }, keep[a.name] || {}, { name: a.name, role: a.role || '', color: a.color || '#a78bfa', lead: !!a.lead, permissionMode: a.permissionMode || '', folder: a.folder || '', vault: a.vault || '', maxTurns: a.maxTurns }));
    S.byName = {};
    for (const a of S.agents) S.byName[a.name] = a;
    S.lead = S.agents.find(a => a.lead) || S.lead;
    S.chiefs = S.agents.filter(a => a.lead);
    if (!S.chiefs.length && S.lead) S.chiefs = [S.lead];
    S.team = Object.assign({}, S.team || {}, { agents: t.agents, routines: t.routines });
    for (const a of S.agents) if (!chatById('dm:' + a.name)) S.chats.push(makeChat('dm:' + a.name, 'dm', a.name, [a.name], a.name));
    const teamChat = chatById('team');   // everyone is in the Team chat, as setupChats makes it on a reload
    if (teamChat) { teamChat.members = S.agents.map(a => a.name); teamChat.lead = S.lead ? S.lead.name : teamChat.members[0]; }
    renderAll();
  }
  // the team changed: reload once nothing is running, so the icons and chats match team.json (drafts and timers carry over)
  function reloadIfIdle() {
    if (!S.reloadWhenIdle || S.selftest || Object.keys(S.flows).length || Object.keys(S.greeting || {}).length) return;
    S.reloadWhenIdle = false;
    saveNow().then(() => location.reload());
  }

  // right-click a teammate: rename it, or delete it (after Storm's OK)
  document.addEventListener('contextmenu', e => {
    const mem = e.target.closest && e.target.closest('#agents .member[data-chat^="dm:"]');
    if (!mem) return;
    e.preventDefault();
    const kb = !e.clientX && !e.clientY, mr = kb ? mem.getBoundingClientRect() : null;   // groky r84: the keyboard menu key opens it under the tile, not at the top-left corner
    openBotMenu(mem.dataset.chat.slice(3), kb ? mr.left + 12 : e.clientX, kb ? mr.bottom - 4 : e.clientY, kb);
  });
  function openBotMenu(name, x, y, kb) {
    closeBotMenu();
    const a = S.byName[name];
    if (!a) return;
    const pop = document.createElement('div');
    pop.className = 'bot-menu';
    pop.style.left = Math.min(x, innerWidth - 190) + 'px';
    pop.style.top = Math.min(y, innerHeight - 110) + 'px';
    pop.innerHTML = '<div class="bot-menu-h">' + esc(name) + '</div><button data-botact="vault" data-bot="' + esc(name) + '"><span class="bm-check">' + (a.vault === 'write' ? '✓' : '') + '</span>Can write to EVO</button>' +
        '<button data-botact="bypass" data-bot="' + esc(name) + '"><span class="bm-check">' + (a.permissionMode === 'bypassPermissions' ? '✓' : '') + '</span>Bypass permissions (never asks)</button>' +
      '<button data-botact="project" data-bot="' + esc(name) + '">Project…</button>' +
      '<button data-botact="chief" data-bot="' + esc(name) + '"><span class="bm-check">' + (a.lead ? '✓' : '') + '</span>Chief (up to 4)</button>' +
      (botSessionId(name) ? '<button data-botact="openapp" data-bot="' + esc(name) + '">Open in Claude app</button>' : '') +
      '<button data-botact="rename" data-bot="' + esc(name) + '">Rename…</button>' +
      (a.lead ? '<div class="bot-menu-note">A chief can’t be deleted</div>' : '<button class="danger" data-botact="delete" data-bot="' + esc(name) + '">Delete…</button>');
    document.body.appendChild(pop);
    // groky r84: the menu is about seven rows tall but only 110px was allowed for it, so near the bottom of the sidebar it ran off screen.
    // Measure it, open it upward or leftward when there is no room, keep 6px from every edge, and make it a real keyboard menu
    pop.setAttribute('role', 'menu');
    pop.querySelectorAll('button').forEach(b => b.setAttribute('role', 'menuitem'));
    const mw = pop.offsetWidth, mh = pop.offsetHeight;
    const mx = x + mw > innerWidth - 6 ? x - mw : x, my = y + mh > innerHeight - 6 ? y - mh : y;
    pop.style.left = Math.max(6, Math.min(mx, innerWidth - mw - 6)) + 'px';
    pop.style.top = Math.max(6, Math.min(my, innerHeight - mh - 6)) + 'px';
    if (kb) { const f = pop.querySelector('button'); if (f) f.focus(); }
  }
  // "Open in Claude app" (Storm: "Still can't see the sessions in the claude app"): the bot's conversation opens in the Claude desktop app
  // (claude --desktop --resume <id>, from the bot's folder). The id is its app session's, or the one Squall's own runs use
  function botSessionId(name) {
    const mi = S.mirror[name], dm = chatById('dm:' + name);
    const fromApp = mi && mi.session && /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(String(mi.session.transcript || ''));
    return fromApp ? fromApp[1] : (dm && S.sessions[sessionKey(dm, name)]) || '';
  }
  function openInApp(name) {
    const id = botSessionId(name);
    if (!id) return;
    Bridge.call('openInApp', { agent: name, session: id }).then(() => teamNote(chatById('dm:' + name) || chatById('team'), name + '’s conversation is opening in the Claude app.'))
      .catch(e => teamNote(chatById('dm:' + name) || chatById('team'), 'Couldn’t open ' + name + ' in the Claude app: ' + e.message));
  }
  function closeBotMenu() { document.querySelectorAll('.bot-menu').forEach(x => x.remove()); }
  // groky r84: Escape closes the teammate menu (only the menu, not a modal behind it), arrows, Home and End move through its items,
  // and it goes away when the window is resized or loses focus instead of hanging there
  document.addEventListener('keydown', e => {
    const pop = document.querySelector('.bot-menu');
    if (!pop) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); closeBotMenu(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    const items = [...pop.querySelectorAll('button')];
    if (!items.length) return;
    e.preventDefault(); e.stopImmediatePropagation();
    const i = items.indexOf(document.activeElement), n = items.length;
    items[e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : e.key === 'ArrowDown' ? (i + 1) % n : (i <= 0 ? n - 1 : i - 1)].focus();
  }, true);
  addEventListener('resize', closeBotMenu);
  addEventListener('blur', closeBotMenu);
  function smallModal(title, inner, onGo) {
    closeModal();
    const box = document.createElement('div');
    box.className = 'modal-back';
    box.innerHTML = '<div class="modal add-modal"><div class="set-head"><h3>' + esc(title) + '</h3><button class="set-x" data-t="close" title="Close">×</button></div>' + inner + '</div>';
    document.body.append(box);
    box.addEventListener('click', e => {
      if (e.target === box) { closeModal(); return; }
      const t = e.target.closest('[data-t]');
      if (!t) return;
      if (t.dataset.t === 'close') { closeModal(); return; }
      const st = box.querySelector('.add-row > span');
      onGo(box).then(msg => { st.textContent = msg; }).catch(err => { st.textContent = err.message; });
    });
    return box;
  }
  function openRenameBot(name) {
    const box = smallModal('Rename ' + name, '<label class="add-field">New name<input id="rb-name" type="text" maxlength="20" value="' + esc(name) + '" spellcheck="false"></label>' +
      '<div class="add-row"><span></span><button class="set-btn" data-t="close">Cancel</button><button class="vault-go" data-t="go">Rename</button></div>',
      b => renameBot(name, b.querySelector('#rb-name').value.trim()).then(() => 'Renamed. Reloading the team…'));
    const inp = box.querySelector('#rb-name'); inp.focus(); inp.select();
  }
  // Storm (2026-10-21): "Make a project selector which picks which project that specific bot works on." A bot's folder is its team.json "folder"
  // (blank: Documents\Projects, everything). This lists the folders under Documents\Projects and saves the pick; the bot's next run starts there.
  async function openProjectPicker(name) {
    const a = S.byName[name];
    let list = [];
    try { const r = await Bridge.call('projectList', {}); list = (r && r.projects) || []; } catch (e) { }
    const cur = (a && a.folder) || '';
    const opts = ['<option value="">Projects (everything)</option>'].concat(list.map(p => '<option value="' + esc(p.path) + '"' + (p.path === cur ? ' selected' : '') + '>' + esc(p.name) + '</option>')).join('');
    smallModal('Project for ' + name, '<div class="add-hint">' + esc(name) + ' works in this folder from its next run, in a new conversation there. This is for bots Squall runs itself: a bot with its own Claude app session keeps that session’s folder.</div>' +
      '<div class="add-row"><select id="pp-sel">' + opts + '</select></div>' +
      '<div class="add-row"><span></span><button class="set-btn" data-t="close">Cancel</button><button class="vault-go" data-t="go">Set</button></div>',
      b => Bridge.call('teamSetFlag', { name, key: 'folder', value: b.querySelector('#pp-sel').value || null }).then(res => {
        if (a) a.folder = (res && res.value) || '';
        renderTeamSoon();
        return 'Saved.';
      }));
  }
  function openDeleteBot(name) {
    smallModal('Delete ' + name + '?', '<div class="add-hint">' + esc(name) + ' leaves the team, with its chats and its routines. Its folder and files stay.</div>' +
      '<div class="add-row"><span></span><button class="set-btn" data-t="close">Keep</button><button class="vault-go danger" data-t="go">Delete</button></div>',
      () => deleteBot(name).then(() => 'Deleted. Reloading the team…'));
  }

  // a bot in bypass mode runs every tool without asking (Storm: "Can you set Obsidian to bypass permissions mode?"); the others ask on a card
  function toggleBypass(name) {
    const a = S.byName[name];
    const on = !(a && a.permissionMode === 'bypassPermissions');
    return Bridge.call('teamSetFlag', { name, key: 'permissionMode', value: on ? 'bypassPermissions' : null }).then(res => {
      if (a) a.permissionMode = res.value || '';
      renderTeamSoon();
      teamNote(chatById('team'), name + (on ? ' now runs in bypass permissions mode: it uses any tool without asking.' : ' asks before risky tools again.'));
    }).catch(err => teamNote(chatById('team'), 'Couldn’t change that: ' + err.message));
  }
  // "Can write to EVO" on a bot's right-click menu: saved to team.json through the host; the bot's next run gets the write rules
  // up to 4 chiefs (Storm: "Make it where I can have up to 4 chiefs"): pinned with a crown, leading the group chats they're in;
  // the host keeps it between 1 and 4
  function toggleChief(name) {
    const a = S.byName[name];
    if (!a) return Promise.resolve();
    return Bridge.call('teamChief', { name, chief: !a.lead }).then(r => {
      a.lead = !!r.lead;
      S.chiefs = S.agents.filter(x => x.lead);
      S.lead = S.chiefs[0] || S.lead;
      for (const c of S.chats) if (c.kind === 'group') { const ch = S.chiefs.find(x => c.members.includes(x.name)); c.lead = ch ? ch.name : c.members[0]; }
      renderTeam(); renderChatHead();
      teamNote(chatById('team'), name + (a.lead ? ' is now a chief.' : ' is no longer a chief.'));
      noteTeamChange(name + (a.lead ? ' was promoted to chief.' : ' is no longer a chief.'));
      saveSoon();
    }).catch(err => teamNote(chatById('team'), err.message));
  }
  function toggleVault(name) {
    const a = S.byName[name];
    const write = !(a && a.vault === 'write');
    Bridge.call('teamVault', { name, write }).then(r => {
      if (a) a.vault = r.vault;
      renderTeamSoon();
      teamNote(chatById('team'), name + (write ? ' can write to EVO from its next run.' : ' is read-only in EVO again.'));
    }).catch(err => teamNote(chatById('team'), 'Couldn’t change that: ' + err.message));
  }

  // ---------- update ready: a newer build is staged in next\ready.json. The chip shows it; Restart is Storm's click (the host applies it) ----------
  function showUpdate(u) {
    let chip = document.getElementById('update-chip');
    updateReadyAt = u && u.newer && !updateGame ? updateReadyAt || Date.now() : 0;
    if (!u || !u.newer) { if (chip) chip.remove(); return; }
    if (!chip) {
      chip = document.createElement('div');
      chip.id = 'update-chip';
      chip.className = 'update-chip';
      const brand = document.querySelector('#team .brand');
      if (brand) brand.insertAdjacentElement('afterend', chip); else document.body.append(chip);
    }
    chip.title = (u.summary || []).join('\n') || 'A newer build is ready.';
    if (!updateTimer) chip.innerHTML = '<span>' + (updateGame ? 'Update ready · waits for your game to end' : 'Update ready · build ' + esc(u.build)) + '</span><button class="update-go" data-update="restart" title="Restart Squall now; your chats and drafts are kept">Restart</button><button class="update-later" data-update="later" title="Wait 10 minutes">Not now</button>';
    autoUpdate(u);
  }
  // auto-update (Storm: "Just make it auto update so I can see it"): a newer tested build applies itself after a 10-second countdown,
  // but never while Storm is typing, a bot is working, a voice call is on, a dialog is open or a game is running; "Not now" waits 10 minutes
  let updateTimer = null, updateSnoozeUntil = 0, lastTypedAt = 0, updateGame = false;
  // a work timer's nudges kept every chat busy, so a staged build never got its two quiet minutes (Chief applied 0433 and 0539 by hand, 19 Oct):
  // while an update waits, the timer holds its nudges for up to 5 minutes, and picks up again after the restart
  let updateReadyAt = 0;
  const UPDATE_HOLD_MS = 300000;
  $('#input').addEventListener('input', () => { lastTypedAt = Date.now(); });
  // Storm: "Squall updated right in the middle of us doing stuff" (0159 went in between two bots' turns): an update also waits until no
  // chat has had a message for two minutes and no live session is mid-turn
  const UPDATE_QUIET_MS = 120000;
  function updateSafe() {
    if (S.selftest) return false;
    if (Date.now() - lastTypedAt < 20000) return false;
    if (Object.keys(S.flows).length || S.agents.some(a => a.status === 'working')) return false;
    if (voiceOn || document.querySelector('.modal-back, .qk-back')) return false;
    if (Date.now() - (S.lastActivityAt || 0) < UPDATE_QUIET_MS) return false;
    if (Object.keys(S.mirror).some(n => mirrorLive(n) && mirrorBusy(S.mirror[n], false))) return false;
    return true;
  }
  function autoUpdate(u) {
    if (!u || !u.newer || updateTimer || Date.now() < updateSnoozeUntil || !updateSafe()) return;   // the next check, 30 s later, tries again
    // a restart mid-game could pop Squall up or stutter the game, so the update waits until the game is closed (checked every 30 s)
    Bridge.call('gameCheck').catch(() => false).then(game => {
      const was = updateGame;
      updateGame = game === true;
      if (updateGame !== was && !updateTimer) showUpdate(u);
      if (updateGame || updateTimer || Date.now() < updateSnoozeUntil || !updateSafe()) return;
      updateCountdown(u);
    });
  }
  function updateCountdown(u) {
    let left = 10;
    const tick = () => {
      const chip = document.getElementById('update-chip');
      if (!updateSafe() || Date.now() < updateSnoozeUntil) { clearInterval(updateTimer); updateTimer = null; showUpdate(u); return; }
      if (chip) { const sp = chip.querySelector('span'); if (sp) sp.textContent = 'Updating to build ' + u.build + ' in ' + left + ' s'; }
      if (left-- <= 0) { clearInterval(updateTimer); updateTimer = null; Bridge.call('updateRestart').catch(err => teamNote(chatById('team'), 'Couldn’t update: ' + err.message)); }
    };
    updateTimer = setInterval(tick, 1000);
    tick();
  }
  function updateLater() {
    updateSnoozeUntil = Date.now() + 10 * 60000;
    clearInterval(updateTimer); updateTimer = null;
    const chip = document.getElementById('update-chip');
    if (chip) { const sp = chip.querySelector('span'); if (sp) sp.textContent = 'Update waiting · in 10 min'; }
  }

  // ---------- routines: jobs a bot does at a set time (every day, weekdays or weekends) while Squall is open ----------
  // the Claude app's scheduled tasks, in plain words ("0 22 * * *" → "Every day, about 10 PM"; the app adds a few minutes of jitter)
  const DAY_NAMES = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
  function cronDays(dow) {
    if (dow === '*') return null;
    if (dow === '1-5') return [1, 2, 3, 4, 5];
    if (/^[0-7](,[0-7])*$/.test(dow)) return dow.split(',').map(n => +n % 7);
    return undefined;
  }
  function cronText(cron) {
    const p = String(cron || '').trim().split(/\s+/);
    if (p.length !== 5) return cron ? cron : 'Once';
    const [mi, h, dom, mon, dow] = p;
    if (/^\*\/\d+$/.test(mi) && h === '*' && dom === '*' && mon === '*' && dow === '*') return 'Every ' + mi.slice(2) + ' minutes';
    if (mi === '0' && /^\*\/\d+$/.test(h) && dom === '*' && mon === '*' && dow === '*') return 'Every ' + h.slice(2) + ' hours';
    const days = cronDays(dow);
    if (!/^\d+$/.test(mi) || !/^\d+$/.test(h) || dom !== '*' || mon !== '*' || days === undefined) return cron;
    const d = new Date(); d.setHours(+h, +mi, 0, 0);
    const at = 'about ' + d.toLocaleTimeString([], +mi ? { hour: 'numeric', minute: '2-digit' } : { hour: 'numeric' });
    if (!days) return 'Every day, ' + at;
    if (dow === '1-5') return 'Weekdays, ' + at;
    if (days.length === 2 && days.includes(0) && days.includes(6)) return 'Weekends, ' + at;
    return days.map(n => DAY_NAMES[n]).join(', ') + ', ' + at;
  }
  function cronNext(cron, from) {
    const p = String(cron || '').trim().split(/\s+/);
    if (p.length !== 5 || !/^\d+$/.test(p[0]) || !/^\d+$/.test(p[1]) || p[2] !== '*' || p[3] !== '*') return null;
    const days = cronDays(p[4]);
    if (days === undefined) return null;
    const base = new Date(from || Date.now());
    for (let i = 0; i < 8; i++) {
      const c = new Date(base); c.setDate(base.getDate() + i); c.setHours(+p[1], +p[0], 0, 0);
      if (c > base && (!days || days.includes(c.getDay()))) return c;
    }
    return null;
  }
  function whenText(d, noTime) {   // noTime: just the day (the schedule already says the time)
    if (!d || isNaN(d)) return '';
    const day = new Date(d); day.setHours(0, 0, 0, 0);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const diff = Math.round((day - today) / 86400000);
    const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const dayPart = diff === 0 ? 'today' : diff === 1 ? 'tomorrow' : diff === -1 ? 'yesterday' : d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    return noTime ? dayPart : dayPart + (diff >= -1 && diff <= 1 ? ' ' : ', ') + t;
  }
  function appTasksHTML() {
    const ts = S.appTasks;
    if (!ts) return '<div class="rt-app-h">From the Claude app</div><div class="runs-none">Looking for the Claude app’s scheduled tasks…</div>';
    return '<div class="rt-app-h">From the Claude app<span>Change these in the Claude app’s Scheduled list</span></div>' +
      (ts.length ? '<div class="rt-list">' + ts.map(x => {
        const next = x.enabled ? (x.fireAt ? new Date(x.fireAt) : cronNext(x.cron)) : null;
        const bits = [x.fireAt ? 'Once, ' + whenText(new Date(x.fireAt)) : cronText(x.cron)];
        if (next && !x.fireAt) bits.push('next ' + whenText(next, true));
        if (x.lastRunAt) bits.push('last ran ' + whenText(new Date(x.lastRunAt)));
        return '<div class="rt-row app"><div class="rt-main"><b>' + esc(x.name) + '</b><span>' + esc(bits.join(' · ')) + '</span>' + (x.about ? '<i>' + esc(x.about.slice(0, 160)) + '</i>' : '') + '</div>' +
          '<span class="rt-pill' + (x.enabled ? '' : ' off') + '">' + (x.enabled ? 'On' : 'Off') + '</span></div>';
      }).join('') + '</div>' : '<div class="runs-none">The Claude app has no scheduled tasks.</div>');
  }
  // Routines turned off (in the Routines list or from the phone) stay, but don't run. Which ones is kept on this computer.
  var routinesOffMap = null;
  function routinesOff() {
    if (!routinesOffMap) { try { routinesOffMap = JSON.parse(localStorage.getItem('squall.routinesOff') || '{}') || {}; } catch (e) { routinesOffMap = {}; } }
    return routinesOffMap;
  }
  function routineOff(id) { return !!routinesOff()[id]; }
  function setRoutineOn(id, on) {
    const m = routinesOff();
    if (on) delete m[id]; else m[id] = true;
    try { localStorage.setItem('squall.routinesOff', JSON.stringify(m)); } catch (e) { }
  }
  function routineDay(d) { const p = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }
  var routinesRerender = null;   // redraws the open Routines list (keeping a half-typed new routine) after a change from the phone
  function routinesChanged() { if (routinesRerender) routinesRerender(); }
  async function removeRoutine(id) {
    const r = await Bridge.call('routineRemove', { id });
    if (!S.team) S.team = {};
    S.team.routines = r.routines;
    setRoutineOn(id, true);
    routinesChanged();
  }
  function skipRoutineToday(id) {
    const r = ((S.team && S.team.routines) || []).find(x => x.id === id);
    if (!r) return;
    const today = routineDay(new Date());
    r.lastRun = today;
    Bridge.call('routineRan', { id, date: today }).catch(() => { });
    routinesChanged();
  }
  // a routine saved on the phone: a new one is added; an edited one is added again with its changes and the old one removed
  // (the host has no edit), keeping its on/off and, when the time didn't change, that it already ran today
  async function phoneSaveRoutine(r, oldId, on) {
    if (!S.team) S.team = {};
    const old = oldId ? (S.team.routines || []).find(x => x.id === oldId) : null;
    if (oldId && !old) throw new Error('That routine isn’t on the computer any more.');
    const before = new Set((S.team.routines || []).map(x => x.id));
    const added = await Bridge.call('routineAdd', Object.assign({}, r, { by: old ? (old.by || 'Storm') : 'Storm' }));
    S.team.routines = added.routines;
    const fresh = (S.team.routines || []).find(x => !before.has(x.id));
    if (old) {
      try {
        const res = await Bridge.call('routineRemove', { id: old.id });
        S.team.routines = res.routines;
      } catch (e) {
        // the old one is still there, so take the new copy away again: never two of the same routine
        if (fresh) { try { const back = await Bridge.call('routineRemove', { id: fresh.id }); S.team.routines = back.routines; } catch (e2) { } }
        routinesChanged();
        throw e;
      }
      setRoutineOn(old.id, true);
    }
    if (fresh) {
      setRoutineOn(fresh.id, on !== false);
      const now = (S.team.routines || []).find(x => x.id === fresh.id);
      if (old && old.lastRun && old.time === r.time && now) {
        now.lastRun = old.lastRun;
        Bridge.call('routineRan', { id: now.id, date: old.lastRun }).catch(() => { });
      }
    }
    routinesChanged();
  }
  function openRoutines() {
    closeModal();
    const box = document.createElement('div');
    box.className = 'modal-back';
    routinesRerender = () => { if (!box.isConnected) { routinesRerender = null; return; } const keep = keepRoutineForm(box); render(); keep(); };
    const render = () => {
      const rs = (S.team && S.team.routines) || [];
      box.innerHTML = '<div class="modal add-modal routines-modal"><div class="set-head"><h3>Routines</h3><button class="set-x" data-t="close" title="Close">×</button></div>' +
        '<div class="add-hint">A routine gives a bot a job at a set time: every day, on weekdays or at weekends. Squall runs it while it’s open. Turn one off to pause it, here or on your phone. Bots can add routines too when you ask them.</div>' +
        (rs.length ? '<div class="rt-list">' + rs.map(r => { const off = routineOff(r.id); return '<div class="rt-row' + (off ? ' off' : '') + '"><div class="rt-main"><b>' + esc(r.name) + '</b><span>' + esc(r.bot) + ' · ' + esc(r.days) + ' at ' + esc(r.time) + (r.by && r.by !== 'Storm' ? ' · made by ' + esc(r.by) : '') + (r.lastRun ? ' · last ran ' + esc(r.lastRun) : '') + '</span><i>' + esc(String(r.prompt || '').slice(0, 160)) + '</i></div><button class="rt-pill rt-toggle' + (off ? ' off' : '') + '" data-rton="' + esc(r.id) + '" title="' + (off ? 'Off: it won’t run. Click to turn it on' : 'On: click to turn it off without removing it') + '">' + (off ? 'Off' : 'On') + '</button><button class="set-btn" data-rmrt="' + esc(r.id) + '">Remove</button></div>'; }).join('') + '</div>'
          : '<div class="runs-none">No routines yet.</div>') +
        appTasksHTML() +
        '<div class="rt-new"><div class="rt-new-h">New routine</div>' +
        '<label class="add-field">Name<input id="rt-name" type="text" maxlength="60" placeholder="Morning check"></label>' +
        '<div class="rt-line"><label class="add-field">Bot<select id="rt-bot">' + S.agents.map(a => '<option>' + esc(a.name) + '</option>').join('') + '</select></label>' +
        '<label class="add-field">Time<input id="rt-time" type="time" value="09:00"></label>' +
        '<label class="add-field">Days<select id="rt-days"><option value="daily">Every day</option><option value="weekdays">Weekdays</option><option value="weekends">Weekends</option></select></label></div>' +
        '<label class="add-field">What to do<textarea id="rt-prompt" rows="3" placeholder="Check the vault for anything new and give me a two-line summary."></textarea></label>' +
        '<div class="add-row"><span id="rt-status"></span><button class="set-btn" data-t="close">Close</button><button class="vault-go" data-t="add">Add routine</button></div></div></div>';
    };
    render();
    document.body.append(box);
    Bridge.call('appTasks').then(ts => { S.appTasks = ts || []; if (box.isConnected) { const keep = keepRoutineForm(box); render(); keep(); } }).catch(() => { S.appTasks = []; });
    box.addEventListener('click', e => {
      if (e.target === box) { closeModal(); return; }
      const tg = e.target.closest('[data-rton]');
      if (tg) { const id = tg.dataset.rton; setRoutineOn(id, routineOff(id)); routinesChanged(); return; }
      const rm = e.target.closest('[data-rmrt]');
      if (rm) {
        if (!confirm('Remove this routine?')) return;
        removeRoutine(rm.dataset.rmrt).catch(err => { box.querySelector('#rt-status').textContent = err.message; });
        return;
      }
      const t = e.target.closest('[data-t]');
      if (!t) return;
      if (t.dataset.t === 'close') { closeModal(); return; }
      Bridge.call('routineAdd', { name: box.querySelector('#rt-name').value, bot: box.querySelector('#rt-bot').value, time: box.querySelector('#rt-time').value, days: box.querySelector('#rt-days').value, prompt: box.querySelector('#rt-prompt').value })
        .then(r => { S.team.routines = r.routines; render(); box.querySelector('#rt-status').textContent = 'Added.'; })
        .catch(err => { box.querySelector('#rt-status').textContent = err.message; });
    });
  }
  function keepRoutineForm(box) {
    const ids = ['rt-name', 'rt-bot', 'rt-time', 'rt-days', 'rt-prompt'], vals = {};
    for (const id of ids) { const el = box.querySelector('#' + id); if (el) vals[id] = el.value; }
    return () => { for (const id of ids) { const el = box.querySelector('#' + id); if (el && vals[id] != null) el.value = vals[id]; } };
  }
  // every 20 s: a routine whose time has come (and that hasn't run today) gives its bot the job, in the bot's own chat.
  // A busy bot gets it on a later tick, up to 5 minutes late.
  function routineTick(at) {
    const rs = (S.team && S.team.routines) || [];
    if (!rs.length || teamPaused()) return;   // paused: a routine that comes due waits (up to 5 minutes, as for a busy bot)
    const d = at instanceof Date ? at : new Date(), pad = n => String(n).padStart(2, '0');
    const nowMin = d.getHours() * 60 + d.getMinutes(), today = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()), dow = d.getDay();
    for (const r of rs) {
      if (routineOff(r.id)) continue;
      const hm = String(r.time || '').split(':').map(Number), rMin = hm[0] * 60 + hm[1];
      if (!(nowMin >= rMin && nowMin - rMin <= 5) || r.lastRun === today) continue;
      if (r.days === 'weekdays' && (dow === 0 || dow === 6)) continue;
      if (r.days === 'weekends' && dow !== 0 && dow !== 6) continue;
      const chat = chatById('dm:' + r.bot);
      if (!chat) continue;
      const mi = mirrorFor(chat);
      if (mi ? mirrorBusy(mi) : S.flows[chat.id]) continue;
      r.lastRun = today;
      Bridge.call('routineRan', { id: r.id, date: today }).catch(() => {});
      runRoutine(r);
    }
  }
  function runRoutine(r) {
    const chat = chatById('dm:' + r.bot);
    if (!chat) return;
    const note = 'Routine "' + r.name + '" (Storm set it for ' + r.days + ' at ' + r.time + '): ' + r.prompt;
    if (mirrorFor(chat)) sendToMirror(chat, note, [], [], APP + ' (routine): ');
    else continueLocal(chat, note);
  }

  // ---------- the vault in Squall (Storm: "Make it able to show Obsidian inside the app with the graph view on the right sidebar"): EVO's graph in
  // the right pane, in Obsidian's own colors and filter; a note opens in the middle with clickable [[links]], its embeds and the notes it links with ----------
  const VG = { data: null, loadedAt: 0, nodes: [], edges: [], byKey: {}, assets: {}, canvas: null, ctx: null, raf: 0, alpha: 0, zoom: 1, panX: 0, panY: 0, hover: -1, drag: null, q: '', filter: 'all', w: 0, h: 0, font: '' };
  const vgColor = rgb => '#' + ('000000' + (Number(rgb) >>> 0).toString(16)).slice(-6);
  const vgRadius = n => 3 + Math.sqrt(n.deg) * 1.25;
  async function vaultGraphLoad(force) {
    if (VG.data && !force && Date.now() - VG.loadedAt < 120000) return VG.data;
    const d = await Bridge.call('vaultGraph');
    const excl = (String(d.filter || '').match(/-path:("[^"]+"|\S+)/g) || []).map(s => s.slice(6).replace(/"/g, '').toLowerCase());
    const keep = (d.nodes || []).map((n, i) => ({ n, i })).filter(x => !excl.some(e => x.n.path.toLowerCase().includes(e)));
    const remap = {};
    keep.forEach((x, k) => { remap[x.i] = k; });
    const old = {};
    VG.nodes.forEach(n => { old[n.path] = n; });
    VG.nodes = keep.map(x => {
      const g = (d.groups || []).find(gr => /^path:/i.test(gr.query || '') && x.n.path.toLowerCase().includes(String(gr.query).slice(5).replace(/"/g, '').toLowerCase()));
      const o = old[x.n.path];
      const k = keep.indexOf(x), ang = k * Math.PI * (3 - Math.sqrt(5)), rad = 14 * Math.sqrt(0.5 + k);   // a sunflower spiral to start from
      return { path: x.n.path, name: x.n.name, color: g ? vgColor(g.rgb) : null, deg: 0, nb: [], x: o ? o.x : rad * Math.cos(ang), y: o ? o.y : rad * Math.sin(ang), vx: 0, vy: 0 };
    });
    VG.edges = (d.edges || []).filter(e => remap[e[0]] !== undefined && remap[e[1]] !== undefined).map(e => [remap[e[0]], remap[e[1]]]);
    for (const [a, b] of VG.edges) { VG.nodes[a].deg++; VG.nodes[b].deg++; VG.nodes[a].nb.push(b); VG.nodes[b].nb.push(a); }
    VG.counts = null;
    VG.byKey = {};
    VG.nodes.forEach((n, i) => { VG.byKey[n.name.toLowerCase()] = i; VG.byKey[n.path.toLowerCase().replace(/\.md$/, '')] = i; });
    VG.assets = {};
    (d.files || []).forEach(f => { VG.assets[f.toLowerCase()] = f; VG.assets[f.split('/').pop().toLowerCase()] = f; });
    const same = Object.keys(old).length === VG.nodes.length && VG.nodes.every(n => old[n.path]);
    VG.data = d; VG.loadedAt = Date.now(); VG.alpha = !Object.keys(old).length ? 1 : same ? VG.alpha : 0.3;   // first load settles fully; a reload with the same notes stays still
    return d;
  }
  // physics like Obsidian's graph (Storm: "They are crammed together and don't have physics"): notes repel and never overlap, links are
  // springs (weaker on hub notes, so a note linked from everywhere doesn't pull the graph into a ball), a light pull keeps it centered.
  // Dragging a note keeps the simulation warm, so its neighbours follow and swing; letting go lets it all settle
  const VGP = { charge: -170, linkDist: 70, center: 0.025, decay: 0.6, alphaDecay: 0.0228 };
  function vgTick() {
    const N = VG.nodes, a = VG.alpha;
    if (!VG.counts || VG.counts.length !== N.length) VG.counts = N.map(n => Math.max(1, n.deg));
    for (let i = 0; i < N.length; i++) for (let j = i + 1; j < N.length; j++) {   // repulsion
      const p = N[i], q = N[j];
      let dx = q.x - p.x, dy = q.y - p.y, l = dx * dx + dy * dy;
      if (l > 250000) continue;
      if (l < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; l = 1; }
      const w = VGP.charge * a / l;
      p.vx += dx * w; p.vy += dy * w; q.vx -= dx * w; q.vy -= dy * w;
    }
    for (const [i, j] of VG.edges) {   // springs
      const s = N[i], tg = N[j], cs = VG.counts[i], ct = VG.counts[j];
      let x = tg.x + tg.vx - s.x - s.vx, y = tg.y + tg.vy - s.y - s.vy, l = Math.sqrt(x * x + y * y) || 1;
      l = (l - VGP.linkDist) / l * a * (1 / Math.min(cs, ct));
      x *= l; y *= l;
      const bias = cs / (cs + ct);
      tg.vx -= x * bias; tg.vy -= y * bias; s.vx += x * (1 - bias); s.vy += y * (1 - bias);
    }
    for (const p of N) { p.vx -= p.x * VGP.center * a; p.vy -= p.y * VGP.center * a; }   // centering
    for (const p of N) {
      if (p.fixed) { p.vx = 0; p.vy = 0; continue; }
      p.vx *= VGP.decay; p.vy *= VGP.decay; p.x += p.vx; p.y += p.vy;
    }
    for (let i = 0; i < N.length; i++) for (let j = i + 1; j < N.length; j++) {   // collisions: dots keep a little air between them
      const p = N[i], q = N[j], rr = vgRadius(p) + vgRadius(q) + 4;
      let dx = q.x - p.x, dy = q.y - p.y;
      if (Math.abs(dx) > rr || Math.abs(dy) > rr) continue;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      if (d >= rr) continue;
      const push = (rr - d) / d * 0.5;
      dx *= push; dy *= push;
      if (!p.fixed) { p.x -= dx; p.y -= dy; }
      if (!q.fixed) { q.x += dx; q.y += dy; }
    }
    VG.alpha += ((VG.alphaTarget || 0) - VG.alpha) * VGP.alphaDecay;
    if (VG.alpha < 0.002 && !VG.alphaTarget) VG.alpha = 0;
  }  function vgDraw() {
    const c = VG.canvas, ctx = VG.ctx;
    if (!c || !ctx || !VG.w) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, VG.w, VG.h);
    ctx.save();
    ctx.translate(VG.w / 2 + VG.panX, VG.h / 2 + VG.panY);
    ctx.scale(VG.zoom, VG.zoom);
    const N = VG.nodes, hv = VG.hover, focus = hv >= 0 && N[hv] ? new Set([hv].concat(N[hv].nb)) : null;
    const q = VG.q.trim().toLowerCase(), match = q ? new Set(N.map((n, i) => n.name.toLowerCase().includes(q) ? i : -1).filter(i => i >= 0)) : null;
    const openIdx = S.noteView ? noteIndex(S.noteView.path) : undefined;
    const fset = vgFilterSet();   // a filter chip keeps some notes bright
    ctx.lineWidth = 1 / VG.zoom;
    for (const [i, j] of VG.edges) {
      const lit = focus && (i === hv || j === hv);
      ctx.strokeStyle = lit ? 'rgba(196,181,253,0.85)' : (focus || match) ? 'rgba(150,160,180,0.06)' : 'rgba(150,160,180,0.22)';
      ctx.beginPath(); ctx.moveTo(N[i].x, N[i].y); ctx.lineTo(N[j].x, N[j].y); ctx.stroke();
    }
    N.forEach((n, i) => {
      const dim = (focus && !focus.has(i)) || (match && !match.has(i)) || (fset && !fset.has(i));
      const r = vgRadius(n);
      ctx.globalAlpha = dim ? 0.16 : 1;
      ctx.fillStyle = n.color || '#9aa3ad';
      ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2); ctx.fill();
      if (i === openIdx) { ctx.globalAlpha = 1; ctx.strokeStyle = '#f5f3ff'; ctx.lineWidth = 2 / VG.zoom; ctx.beginPath(); ctx.arc(n.x, n.y, r + 3.5 / VG.zoom, 0, Math.PI * 2); ctx.stroke(); ctx.lineWidth = 1 / VG.zoom; }
    });
    ctx.globalAlpha = 1;
    // names: the note under the pointer and its links, search matches, the open note, and all of them once zoomed in (like Obsidian)
    if (!VG.font) VG.font = getComputedStyle(document.body).fontFamily || 'sans-serif';
    ctx.font = (11 / VG.zoom) + 'px ' + VG.font;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    // Storm: "make it not messy so I can actually read stuff". The names that matter (under the pointer, search, the open note) go first;
    // then the biggest notes; a name that would sit on one already placed waits, so the labels never pile up on each other
    const sureOf = i => !!((focus && focus.has(i)) || (match && match.has(i)) || i === openIdx);
    // the note under the pointer and the open note always show their names; every other name, even a neighbour's, waits its turn
    const mustOf = i => i === hv || i === openIdx;
    const placed = [];
    const hits = b => placed.some(p => p.x0 < b.x1 && p.x1 > b.x0 && p.y0 < b.y1 && p.y1 > b.y0);
    const order = N.map((n, i) => i).sort((a, b) => (mustOf(b) - mustOf(a)) || (sureOf(b) - sureOf(a)) || (N[b].deg - N[a].deg) || (a - b));
    for (const i of order) {
      const n = N[i], sure = sureOf(i), must = mustOf(i);
      if (fset && !fset.has(i) && !sure) continue;   // filtered out: no name
      const fade = Math.max(0, Math.min(1, (VG.zoom * (0.55 + Math.sqrt(n.deg) * 0.12) - 1.1) * 2));   // big notes show first, small ones as you zoom in
      if (!sure && (focus || match || fade <= 0)) continue;
      const top = n.y + vgRadius(n) + 3 / VG.zoom, half = ctx.measureText(n.name).width / 2 + 2 / VG.zoom;
      const box = { x0: n.x - half, x1: n.x + half, y0: top - 1 / VG.zoom, y1: top + 12 / VG.zoom };
      if (!must && hits(box)) continue;
      placed.push(box);
      ctx.globalAlpha = sure ? 1 : fade;
      ctx.fillStyle = i === hv || i === openIdx ? '#ffffff' : 'rgba(226,232,240,0.82)';
      ctx.fillText(n.name, n.x, top);
    }
    ctx.globalAlpha = 1;
    ctx.restore();
    // while a note is under the pointer, the count line names it with its links; when the pointer leaves, the totals come back
    const hovered = hv >= 0 && N[hv] ? N[hv] : null, key = hovered ? hovered.path : '';
    const countEl = document.querySelector('#live-body .vg-count');
    if (countEl && VG.countKey !== key) {
      VG.countKey = key;
      if (hovered) countEl.textContent = hovered.name + ' · ' + hovered.deg + (hovered.deg === 1 ? ' link' : ' links');
      else updateVgCount();
    }
  }
  function vgLoop() {
    VG.raf = 0;
    if (!VG.canvas || !VG.canvas.isConnected || S.winMin) return;
    const warm = VG.alpha > 0 || VG.alphaTarget > 0;
    if (warm) vgTick();
    vgDraw();
    if (warm || VG.drag) VG.raf = requestAnimationFrame(vgLoop);
  }
  const vgKick = () => { if (!VG.raf && VG.canvas && VG.canvas.isConnected) VG.raf = requestAnimationFrame(vgLoop); };
  function vgAt(ev) { const r = VG.canvas.getBoundingClientRect(), sx = ev.clientX - r.left, sy = ev.clientY - r.top; return { sx, sy, x: (sx - VG.w / 2 - VG.panX) / VG.zoom, y: (sy - VG.h / 2 - VG.panY) / VG.zoom }; }
  function vgHit(pt) { let best = -1, bd = Infinity; VG.nodes.forEach((n, i) => { const d = Math.hypot(n.x - pt.x, n.y - pt.y); if (d < vgRadius(n) + 5 / VG.zoom && d < bd) { bd = d; best = i; } }); return best; }
  function vgBind(c) {
    c.addEventListener('wheel', e => {
      e.preventDefault();
      const pt = vgAt(e), z = Math.max(0.25, Math.min(4, VG.zoom * Math.exp(-e.deltaY * 0.0015)));
      VG.panX = pt.sx - VG.w / 2 - pt.x * z; VG.panY = pt.sy - VG.h / 2 - pt.y * z; VG.zoom = z;
      vgKick();
    }, { passive: false });
    c.addEventListener('pointerdown', e => {
      const pt = vgAt(e), i = vgHit(pt);
      VG.drag = { node: i >= 0 ? VG.nodes[i] : null, idx: i, sx: pt.sx, sy: pt.sy, px: VG.panX, py: VG.panY, moved: false };
      try { c.setPointerCapture(e.pointerId); } catch (err) { }
      if (i >= 0) { VG.nodes[i].fixed = true; VG.alphaTarget = 0.4; VG.alpha = Math.max(VG.alpha, 0.15); }
      vgKick();
    });
    c.addEventListener('pointermove', e => {
      const pt = vgAt(e);
      if (VG.drag) {
        if (Math.abs(pt.sx - VG.drag.sx) + Math.abs(pt.sy - VG.drag.sy) > 3) VG.drag.moved = true;
        if (VG.drag.node) { VG.drag.node.x = pt.x; VG.drag.node.y = pt.y; } else { VG.panX = VG.drag.px + pt.sx - VG.drag.sx; VG.panY = VG.drag.py + pt.sy - VG.drag.sy; }
        vgKick();
        return;
      }
      const h = vgHit(pt);
      if (h !== VG.hover) { VG.hover = h; c.style.cursor = h >= 0 ? 'pointer' : 'grab'; vgKick(); }
    });
    c.addEventListener('pointerup', () => { const d = VG.drag; VG.drag = null; if (d && d.node) d.node.fixed = false; VG.alphaTarget = 0; if (d && !d.moved && d.idx >= 0) openNote(VG.nodes[d.idx].path); vgKick(); });
    c.addEventListener('pointerleave', () => { if (!VG.drag && VG.hover !== -1) { VG.hover = -1; vgKick(); } });
    c.addEventListener('dblclick', e => { if (vgHit(vgAt(e)) < 0) { VG.zoom = 1; VG.panX = 0; VG.panY = 0; vgKick(); } });
  }
  function renderVaultPane() {
    const body = $('#live-body');
    if (!body.querySelector('#vg-canvas')) {
      body.innerHTML = '<div class="vg"><div class="vg-top"><input id="vg-q" type="text" placeholder="Find a note…" spellcheck="false" autocomplete="off"><button class="vg-x" id="vg-x" title="Clear (Esc)" aria-label="Clear the search" hidden>×</button><span class="vg-count">Reading EVO…</span></div><div class="vg-chips"></div><div class="vg-results"></div><div class="vg-wrap"><canvas id="vg-canvas"></canvas></div></div>';
      VG.canvas = body.querySelector('#vg-canvas'); VG.ctx = VG.canvas.getContext('2d');
      vgBind(VG.canvas);
      const q = body.querySelector('#vg-q');
      q.value = VG.q;
      q.addEventListener('input', () => { VG.q = q.value; vgKick(); renderVgResults(); syncVgX(); });
      body.querySelector('#vg-x').addEventListener('click', () => { VG.q = ''; q.value = ''; VG.filter = 'all'; renderVgResults(); renderVgChips(); updateVgCount(); vgKick(); syncVgX(); q.focus(); });
      body.querySelector('.vg-chips').addEventListener('click', e => { const b = e.target.closest('[data-vf]'); if (!b) return; VG.filter = b.dataset.vf; renderVgChips(); updateVgCount(); vgKick(); });
      // Escape in the search box clears the search and the filter, back to every note
      q.addEventListener('keydown', e => { if (e.key !== 'Escape') return; VG.q = ''; q.value = ''; VG.filter = 'all'; renderVgResults(); renderVgChips(); updateVgCount(); vgKick(); syncVgX(); });
      body.querySelector('.vg-results').addEventListener('click', e => {
        const b = e.target.closest('[data-vg-open]'); if (b) { openNote(VG.nodes[Number(b.dataset.vgOpen)].path); return; }
        const n = e.target.closest('[data-vg-note]'); if (n) { openNote(n.dataset.vgNote); return; }
        if (e.target.closest('[data-vg-deep]')) searchInsideNotes(VG.q.trim());
      });
      // arrows move through the results, Enter opens the one picked (or the first note whose name matches)
      q.addEventListener('keydown', e => {
        const n = (VG.hits || []).length;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { if (!n) return; e.preventDefault(); VG.sel = ((VG.sel || 0) + (e.key === 'ArrowDown' ? 1 : n - 1)) % n; renderVgResults(true); return; }
        if (e.key !== 'Enter') return;
        if (n) { openNote(VG.nodes[VG.hits[VG.sel || 0]].path); return; }
        const s = VG.q.trim().toLowerCase(), i = VG.nodes.findIndex(x => x.name.toLowerCase().includes(s)); if (s && i >= 0) openNote(VG.nodes[i].path);
      });
      const wrap = body.querySelector('.vg-wrap');
      const fit = () => {
        const rc = wrap.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
        VG.w = rc.width; VG.h = rc.height;
        VG.canvas.width = Math.max(1, Math.round(rc.width * dpr)); VG.canvas.height = Math.max(1, Math.round(rc.height * dpr));
        VG.canvas.style.width = rc.width + 'px'; VG.canvas.style.height = rc.height + 'px';
        vgKick();
      };
      new ResizeObserver(fit).observe(wrap);
      fit();
    }
    $('#live-foot').innerHTML = '<span>Click a note to read it · scroll to zoom · drag to move · double-click to reset · Esc clears the search</span>';
    vaultGraphLoad().then(() => { const cnt = body.querySelector('.vg-count'); if (cnt) cnt.textContent = VG.nodes.length + ' notes · ' + VG.edges.length + ' links'; renderVgChips(); renderVgResults(); updateVgCount(); vgKick(); })   // a redraw only: refreshing the pane must not nudge the layout (Storm: "kinda glitchy")
      .catch(e => { const cnt = body.querySelector('.vg-count'); if (cnt) cnt.textContent = 'Couldn’t read the vault: ' + e.message; });
  }
  // the graph's search results and filters (Storm: "I better wake up to some amazing details and QOL features"): the search lists every note
  // that matches, clickable; the chips keep one folder, the linked notes or the orphans (no links) bright, and dim the rest
  function renderVgResults(keepSel) {
    const box = document.querySelector('#live-body .vg-results');
    if (!box) return;
    const s = VG.q.trim().toLowerCase();
    if (!keepSel) VG.sel = 0;
    if (!s) { VG.hits = []; box.innerHTML = ''; return; }
    const hits = VG.nodes.map((n, i) => ({ n, i })).filter(x => x.n.name.toLowerCase().includes(s) || x.n.path.toLowerCase().includes(s));
    VG.hits = hits.map(x => x.i);
    if (VG.sel >= hits.length) VG.sel = 0;
    box.innerHTML = hits.length
      ? '<div class="vg-hits-head">' + hits.length + (hits.length === 1 ? ' note matches' : ' notes match') + ' · arrows pick, Enter opens</div>' +
        hits.slice(0, 8).map((x, k) => '<button class="vg-hit' + (k === VG.sel ? ' on' : '') + '" data-vg-open="' + x.i + '"><b>' + vgMark(x.n.name, s) + '</b><small>' + esc(x.n.path.replace(/\.md$/i, '')) + '</small></button>').join('') +
        (hits.length > 8 ? '<div class="vg-hits-head">and ' + (hits.length - 8) + ' more: keep typing</div>' : '')
      : '<div class="vg-hits-head">No note name matches “' + esc(s) + '”.</div>' +
        (s.length >= 3 ? '<button class="vg-hit vg-deep" data-vg-deep="1"><b>Search inside the notes</b><small>Looks through the text of every note, like the Obsidian window</small></button>' : '');
    const on = box.querySelector('.vg-hit.on');
    if (on && keepSel) on.scrollIntoView({ block: 'nearest' });
  }
  // the text of every note (the same search as the Obsidian window): a snippet per note, and a click opens it
  function searchInsideNotes(q) {
    const box = document.querySelector('#live-body .vg-results');
    if (!box || !q) return;
    box.innerHTML = '<div class="vg-hits-head">Searching the text of the notes…</div>';
    Bridge.call('vaultSearch', { query: q }).then(rows => {
      const list = (rows || []).slice(0, 12);
      box.innerHTML = list.length
        ? '<div class="vg-hits-head">' + list.length + (list.length === 1 ? ' note has' : ' notes have') + ' “' + esc(q) + '” in the text</div>' +
          list.map(r => '<button class="vg-hit" data-vg-note="' + esc(r.path) + '"><b>' + esc(String(r.path).replace(/\.md$/i, '').split('/').pop()) + '</b><small>' + esc(r.snippet || String(r.path).replace(/\.md$/i, '')) + '</small></button>').join('')
        : '<div class="vg-hits-head">No note has “' + esc(q) + '” in its text either.</div>';
    }).catch(err => { box.innerHTML = '<div class="vg-hits-head">' + esc(err.message) + '</div>'; });
  }
  // a result's name with the typed part marked, so you can see why it matched
  function vgMark(name, s) {
    const i = String(name).toLowerCase().indexOf(s);
    if (!s || i < 0) return esc(name);
    return esc(name.slice(0, i)) + '<mark>' + esc(name.slice(i, i + s.length)) + '</mark>' + esc(name.slice(i + s.length));
  }
  // the ✕ in the search box shows only while there's text to clear
  function syncVgX() { const x = document.querySelector('#live-body #vg-x'); if (x) x.hidden = !VG.q; }
  const vgFolder = path => { const parts = String(path || '').split('/'); return parts.length > 1 ? parts[0] : '(top level)'; };
  function renderVgChips() {
    const box = document.querySelector('#live-body .vg-chips');
    if (!box || !VG.nodes.length) return;
    const folders = {};
    VG.nodes.forEach(n => { const f = vgFolder(n.path); folders[f] = (folders[f] || 0) + 1; });
    const linked = VG.nodes.filter(n => n.deg > 0).length;
    const chips = [['all', 'All ' + VG.nodes.length], ['linked', 'Linked ' + linked], ['orphans', 'Orphans ' + (VG.nodes.length - linked)]]
      .concat(Object.keys(folders).sort((a, b) => folders[b] - folders[a] || a.localeCompare(b)).slice(0, 10).map(f => ['folder:' + f, f + ' ' + folders[f]]));
    const cur = VG.filter || 'all';
    box.innerHTML = chips.map(([k, label]) => '<button class="vg-chip' + (cur === k ? ' on' : '') + '" data-vf="' + esc(k) + '">' + esc(label) + '</button>').join('');
  }
  // the count beside the search says how many notes the filter keeps ("12 of 180 notes"), so a filter's effect is visible at a glance
  function updateVgCount() {
    const cnt = document.querySelector('#live-body .vg-count');
    if (!cnt || !VG.nodes.length) return;
    const kept = vgFilterSet();
    cnt.textContent = (kept ? kept.size + ' of ' + VG.nodes.length : VG.nodes.length) + ' notes · ' + VG.edges.length + ' links';
  }
  // the notes the chosen filter keeps (null: all of them); the rest are drawn dimmed and get no names
  function vgFilterSet() {
    const f = VG.filter || 'all', N = VG.nodes;
    if (f === 'all' || !N.length) return null;
    if (f === 'linked') return new Set(N.map((n, i) => n.deg > 0 ? i : -1).filter(i => i >= 0));
    if (f === 'orphans') return new Set(N.map((n, i) => n.deg === 0 ? i : -1).filter(i => i >= 0));
    const folder = f.slice(7);
    return new Set(N.map((n, i) => vgFolder(n.path) === folder ? i : -1).filter(i => i >= 0));
  }
  // ---------- a note in the middle, read-only, like Obsidian's reading view ----------
  function noteIndex(target) {
    const k = String(target || '').trim().toLowerCase().replace(/\\/g, '/').replace(/\.md$/, '');
    return VG.byKey[k] !== undefined ? VG.byKey[k] : VG.byKey[k.split('/').pop()];
  }
  async function openNote(path) {
    if (window.SquallUnoUI) window.SquallUnoUI.close();
    closeSessionView(); closeQuick();
    S.noteView = { path, name: String(path).split('/').pop().replace(/\.md$/i, ''), text: '', loading: true };
    renderChatHead(); renderChat(); renderComposer(); vgKick();
    try {
      if (!VG.data) await vaultGraphLoad();
      const text = await Bridge.call('vaultRead', { path });
      if (S.noteView && S.noteView.path === path) { S.noteView.text = String(text || ''); S.noteView.loading = false; renderChat(); }
    } catch (e) { if (S.noteView && S.noteView.path === path) { S.noteView.err = e.message; S.noteView.loading = false; renderChat(); } }
  }
  function closeNote() { if (!S.noteView) return; S.noteView = null; renderChatHead(); renderChat(); renderComposer(); vgKick(); }
  // Escape leaves a note in the middle and goes back to the chat, unless a text box or a menu is the thing in front
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !S.noteView) return;
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName || '')) return;
    if (document.querySelector('.modal-back, .qk-pop, .use-pop, .cx-pop, .mm-pop')) return;
    closeNote();
  });
  const vaultAsset = name => VG.assets[String(name || '').toLowerCase().replace(/\\/g, '/')] || VG.assets[String(name || '').split('/').pop().toLowerCase()] || String(name || '');
  const noteCtx = Object.assign({}, mdCtx, {
    wikilink(inner, embed) {
      const w = MD.parseWiki(inner), tg = String(w.target || '');
      if (embed && /\.(svg|png|jpe?g|gif|webp)$/i.test(tg)) { /* groky r89: click to view full size */ const nu = 'https://squall-vault.local/' + encodeURI(vaultAsset(tg)); return '<img class="note-img" src="' + nu + '" alt="' + esc(w.alias || tg) + '" data-shot="' + esc(nu) + '" data-cap="' + esc(w.alias || tg) + '">'; }
      return '<a class="wl' + (embed ? ' embed-link' : '') + '" data-note="' + esc(tg) + '">' + esc(w.alias || tg) + '</a>';
    },
    image(dest, alt) { if (/^https?:/i.test(dest)) return esc(alt || ''); /* groky r89: click to view full size */ const nu = 'https://squall-vault.local/' + encodeURI(vaultAsset(decodeURI(dest))); return '<img class="note-img" src="' + nu + '" alt="' + esc(alt || '') + '" data-shot="' + esc(nu) + '" data-cap="' + esc(alt || '') + '">'; },
  });
  function renderNoteView() {
    const nv = S.noteView, box = $('#chat');
    const key = nv.path + '|' + (nv.loading ? 'L' : nv.err ? 'E' : nv.text.length);
    if (box.dataset.view === 'note:' + nv.path && box.dataset.noteKey === key) return;   // already showing: keep the scroll where it is
    const fresh = box.dataset.view !== 'note:' + nv.path;
    box.dataset.view = 'note:' + nv.path; box.dataset.noteKey = key;
    if (nv.loading || nv.err) { box.innerHTML = '<div class="note-view"><div class="note-wait">' + esc(nv.err ? 'Couldn’t open it: ' + nv.err : 'Opening ' + nv.name + '…') + '</div></div>'; return; }
    const body = nv.text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');   // the properties block stays out, like Obsidian's reading view
    const html = MD.render(body, noteCtx).html.replace(/<span class="code-lang">mermaid<\/span>/g, '<span class="code-lang">Mermaid diagram · Obsidian draws it</span>');
    const i = noteIndex(nv.path);
    const linked = i !== undefined ? VG.nodes[i].nb.map(j => VG.nodes[j]).sort((x, y) => x.name.localeCompare(y.name)) : [];
    box.innerHTML = '<div class="note-view">' + (/^\s*#\s/.test(body) ? '' : '<h1 class="note-title">' + esc(nv.name) + '</h1>') + '<div class="md">' + html + '</div>' +
      (linked.length ? '<div class="note-links"><b>Linked notes · ' + linked.length + '</b>' + linked.map(n => '<a class="wl" data-note="' + esc(n.path) + '" style="--c:' + esc(n.color || '#9aa3ad') + '">' + esc(n.name) + '</a>').join('') + '</div>' : '') + '</div>';
    if (fresh) box.scrollTop = 0;
  }
  // ---------- Obsidian: a direct connector to the EVO vault (search, read, add a line; nothing is removed) ----------
  function openVault() {
    closeModal(); closeTimerDial(); closeModelMenu(); closeCtxMenu();
    const box = document.createElement('div');
    box.className = 'modal-back';
    box.innerHTML = '<div class="modal vault-modal">' +
      '<div class="set-head"><h3>Obsidian vault</h3><button class="set-x" data-v="close" title="Close">×</button></div>' +
      '<div class="vault-hint">Your EVO vault. Search it, read a note, and add a line to the end. Nothing is removed or overwritten.</div>' +
      '<div class="vault-search"><input id="vault-q" type="text" placeholder="Search notes…" spellcheck="false"></div>' +
      '<div id="vault-list" class="vault-list"><div class="vault-empty">Type to search note names and text.</div></div>' +
      '<div id="vault-note" class="vault-note hidden"></div>' +
      '</div>';
    document.body.append(box);
    const q = box.querySelector('#vault-q');
    let timer = 0;
    q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => vaultSearchNow(box, q.value), 260); });
    q.addEventListener('keydown', e => { if (e.key === 'Enter') { clearTimeout(timer); vaultSearchNow(box, q.value); } });
    box.addEventListener('click', e => {
      if (e.target === box) { closeModal(); return; }
      const b = e.target.closest('[data-v]'), r = e.target.closest('[data-note]');
      if (b && b.dataset.v === 'close') { closeModal(); return; }
      if (b && b.dataset.v === 'back') { box.querySelector('#vault-note').classList.add('hidden'); box.querySelector('#vault-list').classList.remove('hidden'); return; }
      if (b && b.dataset.v === 'add') {
        const ta = box.querySelector('#vault-add'), path = b.dataset.path;
        if (!ta || !ta.value.trim()) return;
        Bridge.call('vaultAppend', { path, text: ta.value }).then(() => { vaultOpenNote(box, path); }).catch(err => { const st = box.querySelector('#vault-status'); if (st) st.textContent = err.message; });
        return;
      }
      if (r) vaultOpenNote(box, r.dataset.note);
    });
    q.focus();
  }
  function vaultSearchNow(box, query) {
    const list = box.querySelector('#vault-list');
    const qq = String(query || '').trim();
    if (!qq) { list.innerHTML = '<div class="vault-empty">Type to search note names and text.</div>'; return; }
    Bridge.call('vaultSearch', { query: qq }).then(rows => {
      list.classList.remove('hidden');
      box.querySelector('#vault-note').classList.add('hidden');
      list.innerHTML = (rows || []).length
        ? rows.map(r => '<button class="vault-row" data-note="' + esc(r.path) + '"><b>' + esc(r.path.replace(/\.md$/i, '')) + '</b>' + (r.snippet ? '<span>' + esc(r.snippet) + '</span>' : '') + '</button>').join('')
        : '<div class="vault-empty">No notes match “' + esc(qq) + '”.</div>';
    }).catch(err => { list.innerHTML = '<div class="vault-empty">' + esc(err.message) + '</div>'; });
  }
  function vaultOpenNote(box, path) {
    const note = box.querySelector('#vault-note');
    Bridge.call('vaultRead', { path }).then(text => {
      note.classList.remove('hidden');
      box.querySelector('#vault-list').classList.add('hidden');
      note.innerHTML = '<div class="vault-bar"><button class="set-btn" data-v="back">Back</button><span class="vault-path">' + esc(path) + '</span></div>' +
        '<div class="vault-body md">' + md(text) + '</div>' +
        '<div class="vault-add"><textarea id="vault-add" rows="2" placeholder="Add a line to the end of this note…"></textarea>' +
        '<div class="vault-add-row"><span id="vault-status"></span><button class="vault-go" data-v="add" data-path="' + esc(path) + '">Add to note</button></div></div>';
    }).catch(err => { note.classList.remove('hidden'); note.innerHTML = '<div class="vault-empty">' + esc(err.message) + '</div>'; });
  }

  function sessionCountText() { const n = (S.desk || []).length; return n + ' session' + (n === 1 ? '' : 's') + ' on this PC'; }
  function openSettings() {
    closeModal(); closeTimerDial(); closeModelMenu();
    const box = document.createElement('div');
    box.className = 'modal-back';
    box.innerHTML = '<div class="modal set-modal">' +
      '<div class="set-head"><h3>Settings</h3><button class="set-x" data-s="done" title="Close">×</button></div>' +
      '<div class="set-sec"><div class="set-title">Model for the team</div><div class="set-models">' +
        MODELS.map(m => '<button class="set-model' + (m.id === S.model ? ' on' : '') + '" data-model="' + esc(m.id) + '"><b>' + esc(m.name) + '</b><small>' + esc(m.note) + '</small></button>').join('') +
      '</div><div class="set-note">Applies to every agent ' + esc(APP) + ' runs and to anything they start. Your real Claude sessions keep their own model.</div></div>' +
      '<div class="set-sec"><div class="set-title">Work timer</div><div class="set-row"><span>Default when you send</span><select id="set-work" class="set-select">' +
        WORK_STEPS.map(v => '<option value="' + v + '"' + (String(v) === String(S.workFor) ? ' selected' : '') + '>' + esc(workLabel(v)) + '</option>').join('') +
      '</select></div><div class="set-note">Each send starts a work window. Claude keeps going while time is left, then wraps up. Off answers once and stops.</div></div>' +
      '<div class="set-sec"><div class="set-title">Live mode</div>' +
        '<div class="set-row"><span>' + (S.liveMode ? 'On: messages go to your real Claude sessions on this PC' : 'Off: local agents answer') + '</span><button class="set-btn" data-s="live">' + (S.liveMode ? 'Turn off' : 'Turn on') + '</button></div>' +
        '<div class="set-row"><span>Show the live note again</span><button class="set-btn" data-s="note"' + (S.liveNoteHidden ? '' : ' disabled') + '>Show</button></div></div>' +
      '<div class="set-sec"><div class="set-title">Obsidian</div><div class="set-row"><span>Search, read and add lines to your EVO vault</span><button class="set-btn" data-s="vault">Open vault</button></div></div>' +
      '<div class="set-sec"><div class="set-title">Phone</div><div class="set-row"><span>' + mobileText() + '</span>' + (S.mobileOn ? '<button class="set-btn" data-s="mobilecode">New code</button>' : '') + '<button class="set-btn" data-s="mobile">' + (S.mobileOn ? 'Turn off' : 'Turn on') + '</button></div></div>' +
      (window.SquallLinkUI ? window.SquallLinkUI.settingsHTML() : '') +
      '<div class="set-sec"><div class="set-title">Look</div><div class="set-row"><span>' + (S.trueBlack !== false ? 'True black: pure black behind everything, with the same colors and motion' : 'Glass: the dark glass with the purple and blue glow behind it') + '</span><button class="set-btn" data-s="trueblack">' + (S.trueBlack !== false ? 'True black' : 'Glass') + '</button></div></div>' +
      '<div class="set-sec"><div class="set-title">Idle work</div><div class="set-row"><span>' + (S.idleWork !== false ? 'On: an idle bot with nothing on the To do list and nothing from you fixes bugs and polishes sounds and graphics in Farside (one area per bot; paused while you game or are at the PC)' : 'Off: idle bots stay idle') + '</span><button class="set-btn" data-s="idlework">' + (S.idleWork !== false ? 'On' : 'Off') + '</button></div></div>' +
      '<div class="set-sec"><div class="set-title">Sound</div><div class="set-row"><span>' + (S.sounds === 'all' ? 'All sounds: typing, sending, replies, cards and the finish ping' : S.sounds === 'ping' ? 'Just the sci-fi ping when the response you’re looking at finishes' : 'Off') + '</span><button class="set-btn" data-s="soundtest" title="Play the sound a finished reply makes">Test sound</button><button class="set-btn" data-s="sound">' + (S.sounds === 'all' ? 'All sounds' : S.sounds === 'ping' ? 'Just the ping' : 'Off') + '</button></div></div>' +
      '<div class="set-sec"><div class="set-title">Approvals</div><div class="set-row"><span>' + (approvalsOn() ? 'On: a bot asks before a tool it can’t use on its own, like running a command, and you answer on a card in its chat' : 'Off: bots can’t run commands or use other tools that need your OK') + '</span><button class="set-btn" data-s="approvals">' + (approvalsOn() ? 'On' : 'Off') + '</button></div></div>' +
      '<div class="set-sec"><div class="set-title">Speed</div><div class="set-row"><span>' + (S.readyBots !== false ? 'Ready for follow-ups: after a reply, the bot in the chat you have open stays ready for 2.5 minutes, so your next message starts right away (a little memory; never while a game runs)' : 'Off: every message starts its bot fresh') + '</span><button class="set-btn" data-s="ready">' + (S.readyBots !== false ? 'On' : 'Off') + '</button></div>' +
      '<div class="set-row"><span>' + (S.callWait ? 'Voice calls wait for Whisper’s more accurate words before each send (usually about a second)' : 'Voice calls send Vosk’s words as soon as you pause (fastest)') + '</span><button class="set-btn" data-s="callwait">' + (S.callWait ? 'Accurate' : 'Fastest') + '</button></div>' +
      '<div class="set-row"><span>' + (S.echoOwn !== false ? 'Echo canceller in calls: Squall hears what your speakers play (games, videos, Discord) and takes that sound out of the mic' : 'Echo canceller in calls is off: the browser’s own only removes sound Squall plays') + '</span><button class="set-btn" data-s="echoown">' + (S.echoOwn !== false ? 'Squall’s own' : 'Off') + '</button></div></div>' +
      '<div class="set-sec"><div class="set-title">Voice</div><div class="set-row"><span>' + (S.voiceEngine === 'parakeet' ? 'Dictation in three passes: Vosk shows the words as you talk, Whisper rewrites each phrase, and when you stop, Parakeet (NVIDIA’s model, the most accurate here) writes the whole recording down, and its words are the result' : S.voiceEngine === 'whisper' ? 'Dictation in five passes: Vosk shows the words as you talk, Whisper rewrites each phrase, and when you stop, three different Whisper takes go over the whole recording and vote word by word. Voice calls send each phrase the moment you pause' + (S.voiceAvail && S.voiceAvail.parakeet ? '. Parakeet is installed too: press the button twice to switch to it' : '') : 'Speech to text: Vosk, fast; the words show as you talk') + '</span><button class="set-btn" data-s="voiceengine">' + (S.voiceEngine === 'parakeet' ? 'Vosk + Parakeet' : S.voiceEngine === 'whisper' ? 'Vosk + Whisper' : 'Vosk') + '</button></div>' +
        (S.voiceAvail && !S.voiceAvail.parakeet ? '<div class="set-note">A more accurate model, Parakeet (NVIDIA, 669 MB), is ready to add: say yes in the Claude app to download it.</div>' : '') + '<div class="set-note" id="set-vstatus">Checking the speech engine…</div></div>' +
      '<div class="set-sec"><div class="set-title">Sessions</div><div class="set-row"><span>' + esc(sessionCountText()) + '</span><button class="set-btn" data-s="sessions">Show them</button></div></div>' +
      '<div class="set-sec"><div class="set-title">Workspace and sign-in</div>' +
        '<div class="set-row"><span>Where the agents keep their files</span><button class="set-btn" data-s="folder">' + ICON.folder + 'Open folder</button></div>' +
        '<div class="set-row"><span>' + (S.signedIn === false ? 'Not signed in to Claude yet' : S.signedIn ? 'Signed in to Claude' : 'Sign-in not checked yet') + '</span><span class="set-btns"><button class="set-btn" data-s="signin">Sign in</button><button class="set-btn" data-s="recheck">Check again</button></span></div></div>' +
      '<div class="set-sec set-about"><div class="set-title">About</div><div>' + esc(APP) + ' ' + esc((S.info && S.info.version) || '') + '</div>' + recentUpdatesHTML() + '<div class="set-note">' + esc((S.info && S.info.workDir) || '') + '</div></div>' +
      '</div>';
    document.body.append(box);
    Bridge.call('voiceStatus').then(t => { const el = box.querySelector('#set-vstatus'); if (el) el.textContent = String(t || ''); }).catch(() => { });
    box.querySelector('#set-work').addEventListener('change', e => {
      const v = e.target.value;
      S.workFor = v === 'off' || v === 'inf' ? v : Number(v);
      saveSoon(); renderTimerChip();
    });
    box.addEventListener('click', e => {
      if (e.target === box) { closeModal(); return; }
      const mb = e.target.closest('[data-model]');
      if (mb) { setModel(mb.dataset.model); box.querySelectorAll('.set-model').forEach(x => x.classList.toggle('on', x === mb)); return; }
      const b = e.target.closest('[data-s]');
      if (!b) return;
      const what = b.dataset.s; sfx('toggle');
      if (window.SquallLinkUI && window.SquallLinkUI.onSettings(what)) return;
      if (what === 'done') closeModal();
      else if (what === 'live') { S.liveMode = !S.liveMode; if (S.liveMode) { startLink(); startMirrors(); } else { stopLink(); stopMirrors(); } saveSoon(); renderAll(); renderBanner(); openSettings(); }
      else if (what === 'note') { S.liveNoteHidden = false; saveSoon(); renderBanner(); openSettings(); }
      else if (what === 'vault') { closeModal(); openVault(); }
      else if (what === 'approvals') { const on = !approvalsOn(); Bridge.call('setApprovals', { on }).then(() => { S.team = Object.assign({}, S.team || {}, { approvals: on }); closeModal(); openSettings(); }).catch(() => { }); }
      else if (what === 'callwait') { S.callWait = !S.callWait; saveSoon(); closeModal(); openSettings(); }
      else if (what === 'echoown') { S.echoOwn = S.echoOwn === false; saveSoon(); closeModal(); openSettings(); }
      else if (what === 'idlework') { S.idleWork = S.idleWork === false; saveSoon(); closeModal(); openSettings(); }
      else if (what === 'trueblack') { S.trueBlack = S.trueBlack === false; applyLook(); saveSoon(); closeModal(); openSettings(); }
      else if (what === 'ready') { S.readyBots = S.readyBots === false; saveSoon(); if (!S.readyBots) Bridge.call('closeWarm').catch(() => { }); closeModal(); openSettings(); }
      else if (what === 'voiceengine') { const pk = !!(S.voiceAvail && S.voiceAvail.parakeet); S.voiceEngine = S.voiceEngine === 'parakeet' ? 'whisper' : S.voiceEngine === 'whisper' ? 'vosk' : pk ? 'parakeet' : 'whisper'; S.voiceEngineSet = true; saveSoon(); closeModal(); openSettings(); }
      else if (what === 'sound') { S.sounds = S.sounds === 'all' ? 'ping' : S.sounds === 'ping' ? 'off' : 'all'; S.sound = S.sounds !== 'off'; saveSoon(); closeModal(); openSettings(); if (S.sounds === 'all') sfx('reply'); else if (S.sound) playPing(); }
      else if (what === 'mobile' || what === 'mobilecode') { mobileSet(what === 'mobilecode' ? 'code' : S.mobileOn ? 'off' : 'on').then(() => { closeModal(); openSettings(); }); }
      else if (what === 'soundtest') { if (S.sounds === 'all') sfxTour(); else { const was = S.sound; S.sound = true; playPing(); S.sound = was; } }   // Storm: "make it so I can test the sound" (plays even with sounds off)
      else if (what === 'sessions') { S.rightMode = 'sessions'; renderLive(); closeModal(); }
      else if (what === 'folder') Bridge.call('openFolder', { agent: '' }).catch(() => {});
      else if (what === 'signin') Bridge.call('signIn').catch(err => addMessage(activeChat(), { who: APP, kind: 'error', text: err.message }));
      else if (what === 'recheck') { checkAuth(); setTimeout(openSettings, 600); }
    });
  }

  // ---------- session context: how full the session's window is, and compacting ----------
  const CTX_LOCAL_WINDOW = 200000, CTX_LIVE_WINDOW = 1000000;
  const fmtTok = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n || 0);
  function ctxFor(chat) {
    if (!chat) return null;
    const mi = mirrorFor(chat);
    if (mi) return mi.status && mi.status.ctx ? { used: mi.status.ctx, win: CTX_LIVE_WINDOW, live: true, name: chat.members[0] } : null;
    const a = S.byName[chat.kind === 'dm' ? chat.members[0] : (chat.lead || chat.members[0])];
    return a && a.ctx ? { used: a.ctx, win: CTX_LOCAL_WINDOW, live: false, name: a.name } : null;
  }
  function renderCtx() {
    const b = $('#ctx');
    if (!b) return;
    const info = ctxFor(activeChat());
    const pct = info ? Math.min(100, Math.round(info.used / info.win * 100)) : 0;
    const circ = 2 * Math.PI * 9;
    patchHTML(b, '<svg viewBox="0 0 24 24"><circle class="ctx-track" cx="12" cy="12" r="9"/><circle class="ctx-fill" cx="12" cy="12" r="9" stroke-dasharray="' + (circ * pct / 100).toFixed(1) + ' ' + circ.toFixed(1) + '"/></svg><span>' + (info ? pct + '%' : 'Context') + '</span>');
    b.dataset.level = pct >= 90 ? 'hot' : pct >= 70 ? 'warm' : 'ok';
    b.title = info ? 'Context: ' + pct + '% of its window (' + fmtTok(info.used) + ' of ' + fmtTok(info.win) + ' tokens)' : 'Context: no history yet';
  }
  function openCtxMenu() {
    closeCtxMenu(); closeTimerDial(); closeModelMenu();
    const c = activeChat(), info = ctxFor(c), live = !!mirrorFor(c), pct = info ? Math.min(100, Math.round(info.used / info.win * 100)) : 0;
    const off = live || !info ? ' disabled' : '';
    const pop = document.createElement('div');
    pop.className = 'cx-pop';
    pop.innerHTML = '<div class="cx-title">Context</div>' +
      '<div class="cx-big">' + (info ? pct + '%' : 'No history yet') + '</div>' +
      (info ? '<div class="cx-sub">' + fmtTok(info.used) + ' of ' + fmtTok(info.win) + ' tokens · ' + (live ? 'a live session' : esc(info.name)) + '</div><div class="cx-bar"><i style="width:' + pct + '%"></i></div>' : '') +
      '<div class="cx-note">Claude Code compacts on its own when a session nears its limit. You can also compact now.</div>' +
      '<div class="cx-opts">' +
        '<button class="cx-opt" data-cx="compact"' + off + '><b>Compact now</b><small>' + (live ? 'Squall can’t type into that window. For a live session, type /compact in its own Claude window yourself' : 'Runs Claude Code’s own /compact on this teammate’s saved session') + '</small></button>' +
        '<div class="cx-focus"><input id="cx-focus" type="text" placeholder="What to keep, e.g. the leaderboard decisions" spellcheck="false"' + off + '><button class="cx-go" data-cx="focus"' + off + '>Compact with focus</button></div>' +
      '</div>';
    document.body.append(pop);
    const r = $('#ctx').getBoundingClientRect();
    pop.style.left = Math.max(10, Math.min(window.innerWidth - pop.offsetWidth - 10, r.left)) + 'px';
    placeTop(pop, r);
    pop.addEventListener('click', e => {
      const b = e.target.closest('[data-cx]');
      if (!b || b.disabled) return;
      const what = b.dataset.cx;
      if (what === 'compact') { closeCtxMenu(); compactNow(c, ''); }
      else if (what === 'focus') { const f = pop.querySelector('#cx-focus').value; closeCtxMenu(); compactNow(c, f); }
    });
  }
  function closeCtxMenu() { document.querySelectorAll('.cx-pop').forEach(x => x.remove()); }
  // Compacts a local agent's memory of this chat with Claude Code's /compact (optionally with a focus).
  function compactNow(chat, focus) {
    if (mirrorFor(chat)) { addMessage(chat, { who: APP, kind: 'event', text: 'Live sessions compact in their own window: type /compact there.' }); return; }
    const name = chat.kind === 'dm' ? chat.members[0] : (chat.lead || chat.members[0]);
    const cmd = '/compact' + (focus && focus.trim() ? ' ' + focus.trim() : '');
    const started = Date.now(), a = S.byName[name];
    addMessage(chat, { who: APP, kind: 'event', text: 'Compacting ' + name + '’s memory of this chat…' });
    queueFor(name, () => runAgent(name, cmd, sessionKey(chat, name))).then(r => {
      const did = a && a.compactedAt && a.compactedAt >= started;   // only when Claude Code's own compaction ran
      addMessage(chat, { who: APP, kind: 'event', text: r.isError ? 'Compact didn’t finish: ' + String(r.text || '').slice(0, 200) : did ? 'Compacted with Claude Code’s own /compact: ' + name + ' keeps the key points.' : 'Nothing to compact yet: this chat has no history in its session.' });
      renderCtx();
    });
  }

  function setModel(id) {
    if (!MODELS.some(m => m.id === id)) return;
    S.model = id; S.modelPicked = true; saveSoon(); renderModelChip(); closeModelMenu();
    Bridge.call('setModel', { model: id }).catch(() => {});
  }

  function startTimer(chat, forced) {
    const v = forced || S.workFor;
    stopTimer(chat.id, true);
    if (v === 'off') return;
    S.timers[chat.id] = { until: v === 'inf' ? Infinity : Date.now() + v * 60000, mins: v, lastNudge: 0, quick: 0, pending: 0, busySeen: false, idleSince: 0, startedAt: Date.now(), waitLogged: false };
    timerWatchStart();
    renderTimerChip(); saveSoon();
  }
  function stopTimer(chatId, quiet) {
    const t = S.timers[chatId];
    if (!t) return;
    clearTimeout(t.pending);
    delete S.timers[chatId];
    renderTimerChip(); saveSoon();
    const chat = chatById(chatId);
    if (!quiet && chat) addMessage(chat, { who: APP, kind: 'event', text: '⏱ Work timer stopped.' });
  }
  // Storm stopping the timer (the Stop button, or sending "stop") turns it off for his next messages too (Storm: "When I click stop timer
  // it goes again on the next message"); picking a time on the timer dial turns it back on
  function timerOff(chatId) {
    stopTimer(chatId, true);
    S.workFor = 'off'; saveSoon(); renderTimerChip();
    const chat = chatById(chatId);
    if (chat) addMessage(chat, { who: APP, kind: 'event', text: '⏱ Work timer off. It stays off for your next messages until you pick a time on the timer.' });
  }
  const TIMER_PAUSE_HINT = ' If everything left needs Storm (an answer, a download, his OK), say so and end your reply with ```squall {"actions":[{"do":"pause_timer"}]}```: the timer waits for his next message instead of nudging you again.';
  // Storm (2026-10-21): "When I haven't given the chief any work make the timer make it work on the parts of the todo list that doesn't need me."
  const TODO_IDLE_RULE = ' If Storm has given you no task, take the first open To do item that does not need him (skip any that need his decision or his machine), and report what you did.';
  // timer_wait (Storm, 23 Oct): told in every nudge, so a bot waiting on a long job holds the timer instead of answering a nudge a minute
  const TIMER_WAIT_HINT = ' Waiting on a long job (a test, a build, a render) with nothing else to do meanwhile? End your reply with ```squall {"actions":[{"do":"timer_wait","minutes":10}]}``` to hold this timer for up to 10 minutes: it nudges again after that, or as soon as you are working.';
  function timerNote(t) {
    if (t.until === Infinity) return 'Work timer: Continuous. Keep working on what Storm asked until he says stop: do the next most useful step, then report briefly.' + TODO_IDLE_RULE + TIMER_WAIT_HINT;
    const left = Math.round((t.until - Date.now()) / 60000);
    return 'Work timer: ' + workLabel(Math.max(1, left)) + ' left of the ' + workLabel(t.mins) + ' Storm set. Keep working on what he asked: do the next most useful step, then report briefly.' + TODO_IDLE_RULE + TIMER_WAIT_HINT;
  }
  const TIMES_UP = 'Work timer: time’s up. Wrap up now: say what you finished and what’s left.';
  const PUSH_HARDER = 'Push harder: that finished right away, so take a bigger next step, not a smaller one. ';

  // called when an agent or a real session finishes a turn in a chat that has a running timer
  function onTurnEnd(chatId) {
    if (S.judge) setTimeout(() => { judgeTurn(chatId).catch(() => {}); }, 1500);   // the judge reads the finished turn (a live session's last entries land just after)
    const t = S.timers[chatId];
    if (!t) return;
    t.busySeen = true; t.idleSince = 0;
    timerWatchStart();
  }
  // every 2 s each running timer checks its chat. Once the chat has been busy and then sits idle for TIMER_SETTLE_MS, the timer nudges.
  // It watches the state, not one "turn ended" event, so a missed event or a busy moment at the wrong time can't stop the timer.
  // stay awake while working (Storm, 19 Oct): while a timer runs (not paused), a bot is working, a live session is mid-turn or a call is
  // on, the host asks Windows not to idle-sleep; the "Awake" badge under the message box shows it
  let awakeOn = false;
  function awakeWanted() {
    return Object.keys(S.timers).some(id => S.timers[id] && !S.timers[id].paused) || Object.keys(S.flows).length > 0 || S.agents.some(a => a.status === 'working') ||
      Object.keys(S.mirror).some(n => mirrorLive(n) && mirrorBusy(S.mirror[n], false)) || !!voiceOn;
  }
  function awakeTick() {
    const want = awakeWanted();
    if (want !== awakeOn) { awakeOn = want; Bridge.call('keepAwake', { on: want }).catch(() => { }); }
    const b = $('#awake'); if (b) b.classList.toggle('hidden', !awakeOn);
  }
  setInterval(awakeTick, 10000);
  // a bot's hold on its timer (timer_wait): it lasts until it runs out, or until the bot is working AGAIN. The turn that asks for the hold is
  // still running when the hold is set, so busy only ends it once the chat has been seen idle since (Chief, 23 Oct 22:54: a live session's
  // hold was let go by its own closing turn, and the next nudge came 15 s later)
  function timerHeld(t, busy, now) {
    if (!t.holdUntil || now >= t.holdUntil) return false;
    if (!busy) { t.holdIdle = true; return true; }
    return !t.holdIdle;
  }
  let timerWatch = null;
  function timerWatchStart() { if (!timerWatch) timerWatch = setInterval(timerWatchTick, 2000); }
  function timerWatchTick() {
    const ids = Object.keys(S.timers);
    if (!ids.length) { clearInterval(timerWatch); timerWatch = null; return; }
    if (teamPaused()) return;   // Pause all: a timer Storm starts while paused waits for Resume before it nudges
    for (const id of ids) {
      const t = S.timers[id], chat = chatById(id);
      if (!t || !chat || t.paused) continue;   // paused by its bot until Storm's next message
      const mi = mirrorFor(chat);
      if (t.holdUntil) {   // held by its bot (timer_wait): no nudge until the hold runs out, or until the bot is working again
        if (timerHeld(t, mi ? mirrorBusy(mi, false) : !!S.flows[id], Date.now())) continue;
        t.holdUntil = 0; t.afterHold = true; t.busySeen = true; t.idleSince = 0; renderTimerChip();
      }
      // a diagnostic line, once per wait: a running timer that has waited over two minutes for its nudge says why
      const since = t.lastNudge || t.startedAt || 0;
      if (!t.waitLogged && since && Date.now() - since > 120000) {
        t.waitLogged = true;
        const why = (mi ? mirrorBusy(mi, false) : S.flows[id]) ? 'busy' : (mi && (mi.pending || []).some(p => Date.now() - p.at < 60000)) ? 'pending message' : !t.busySeen ? 'no work seen' : 'idle, settling';
        Bridge.call('log', { level: 'timer', msg: id + ' waiting over 2 min for a nudge: ' + why + ' (busySeen ' + t.busySeen + ', watch ' + (timerWatch ? 'on' : 'off') + ')' }).catch(() => {});
      }
      // only the session's real work counts: the 8 s "just sent" flag (from Storm, or from this timer's own nudge) doesn't
      if (mi ? mirrorBusy(mi, false) : S.flows[id]) { t.busySeen = true; if (!t.busyFrom) t.busyFrom = Date.now(); t.idleSince = 0; continue; }   // still working
      // a message sent in the last minute that the session hasn't shown yet: a nudge now would only stack up behind it.
      // (An idle session has no real queue: Claude Code starts on queued messages as soon as it's free.)
      if (mi && (mirrorBusy(mi) || (mi.pending || []).some(p => Date.now() - p.at < 60000))) { t.idleSince = 0; continue; }
      if (!t.busySeen) {
        // no work seen since the last nudge. Normally that means the nudge is still on its way, but a nudge that was lost (the relay was down),
        // or a turn too short for this 2 s watch to see, used to stall the timer for good: it waits for work that only a nudge starts. After
        // three quiet minutes it nudges anyway (Chief, 22 Oct: idle from 04:15 to 07:12 under a running timer).
        const quiet = Date.now() - (t.lastNudge || t.startedAt || 0);
        if (quiet < TIMER_STALL_MS) continue;
        if (updateReadyAt && Date.now() - updateReadyAt < UPDATE_HOLD_MS && !S.selftest) continue;   // let the waiting update go in first
        Bridge.call('log', { level: 'timer', msg: id + ' no work seen for ' + Math.round(quiet / 1000) + ' s: nudging anyway' }).catch(() => {});
        t.workedMs = 0; t.idleSince = 0; t.busyFrom = 0;
        timerTick(id);
        continue;
      }
      if (!t.idleSince) { t.idleSince = Date.now(); continue; }
      if (Date.now() - t.idleSince < TIMER_SETTLE_MS) continue;
      // a session that keeps finishing right away (it's only waiting on a long test, say) is nudged less and less often: 2, 4, 8, then
      // every 15 minutes, still pushing harder each time; one real piece of work puts it back to normal (Chief, 19 Oct: a minute-by-minute
      // nudge during a 30-minute test was burning Storm's plan)
      // Storm, 21 Oct: "make the timer completely force the bot to keep working for however long". So the timer no longer waits out the plan's
      // throttle (it was one nudge per 30 minutes), and a session that keeps finishing right away waits one minute between nudges, not up to an hour.
      const backoff = t.quick >= 2 ? 60000 : 0;
      if (backoff && Date.now() - t.lastNudge < backoff) continue;
      if (updateReadyAt && Date.now() - updateReadyAt < UPDATE_HOLD_MS && !S.selftest) continue;   // let the waiting update go in first
      t.workedMs = t.idleSince - (t.busyFrom || t.idleSince);   // how long the session really worked since the last nudge
      t.busySeen = false; t.idleSince = 0; t.busyFrom = 0;
      timerTick(id);
    }
  }
  function timerTick(chatId) {
    const t = S.timers[chatId], chat = chatById(chatId);
    if (!t || !chat) return;
    if (t.until !== Infinity && Date.now() >= t.until - 60000) { stopTimer(chatId, true); sendTimerNote(chat, TIMES_UP); return; }
    // a turn that finishes right after a nudge doesn't stop the timer (Storm: "Stopping quickly just means the timer should push harder not give up"):
    // the next note asks for a bigger step, and the timer keeps going until its time runs out or Storm stops it by hand
    // quick = the session worked under 40 s since the last nudge (measured from its own busy time, so the back-off's long waits don't count)
    // (the first nudge after a hold is not "push harder": the bot was told it could wait)
    const quickTurn = t.afterHold ? false : t.workedMs != null ? t.workedMs < TIMER_QUICK_MS : Date.now() - t.lastNudge < TIMER_QUICK_MS;
    t.workedMs = null; t.afterHold = false;
    t.quick = t.lastNudge && quickTurn ? t.quick + 1 : 0;
    t.lastNudge = Date.now(); t.waitLogged = false;
    Bridge.call('log', { level: 'timer', msg: chatId + ' nudge (' + (mirrorFor(chat) ? 'live' : 'local') + ', quick ' + t.quick + ')' }).catch(() => {});
    sendTimerNote(chat, (t.quick >= 1 && !usageTight() ? PUSH_HARDER : '') + timerNote(t));   // "push harder" asks for longer turns: not while throttled
  }
  function sendTimerNote(chat, note) {
    if (mirrorFor(chat)) {
      if (S.link.status !== 'on' && !NO_RELAY()) { stopTimer(chat.id, true); addMessage(chat, { who: APP, kind: 'event', text: '⏱ Work timer stopped: the live link is off.' }); return; }
      sendToMirror(chat, note, [], [], APP + ' (work timer): ');
    } else continueLocal(chat, note);
  }
  // THE TO DO DRIVE (Storm, 23 Oct: "When the chief is stopped in Squall I want it to be told and forced to complete anything in the todo list that
  // doesn't require me"). Each time a chief stops (busy, then idle for the settle time) while the list holds an open item that is not marked as
  // needing Storm, Squall tells it to take the next one, and keeps on after every turn until none is left. A running work timer drives it already
  // (its nudges carry TODO_IDLE_RULE), so the drive waits while one runs. An item that needs him is marked by its bot (todo_needs), shown to him as
  // "needs you", and left out; his next message to a chief clears the marks. No pause of its own (Storm took the bots' pause out on 19 Oct: "it
  // just slows down progress"), but his Stop holds it until he writes to that chief again. Turns that end at once are nudged once a minute.
  const DRIVE = {};
  let driveWatch = null;
  const driveOf = n => DRIVE[n] || (DRIVE[n] = { busySeen: false, busyFrom: 0, idleSince: 0, lastNudge: 0, quick: 0, held: false });
  const driveItems = () => TODO.items.filter(i => i.status !== 'done' && !i.needs);
  // HELD WHILE HE HAS PAUSED A BOT (Storm, 25 Oct, "Both"). He told Chief "Pause. Stop starting new work now ... Do not pick up the queue
  // again until I say so", and the drive went on telling it to take the next item after every short reply, once a minute. Now his own
  // message to a chief that pauses it holds the drive for that chief until a message of his lets it go again; any other message of his
  // (a new ask, an answer) leaves the pause as it is. Kept across Squall restarts (localStorage), unlike his Stop, which a message clears.
  const DRIVE_PAUSE_RX = /\b(pause|paused|just stop|stop for now|stop starting|stop working|hold off|don[’']?t (?:pick up|take|start) (?:the|any|anything)|do not (?:pick up|take|start) (?:the|any|anything))\b/i;
  // (not after "not" / "n't": "Do not pick up the queue" holds it. When both match, the pause wins: a wrong hold shows as a line in the
  // chat and is one word to undo, a wrong release starts the reminders again)
  const DRIVE_GO_RX = /(?<!\bnot |n[’']t )\b(resume|unpause|carry on|keep going|back to work|pick up the (?:queue|to ?do)|work (?:on )?the (?:queue|to ?do)|you can (?:go|continue|carry on)|go ahead with the (?:queue|to ?do))\b/i;
  let drivePaused = {};
  try { drivePaused = JSON.parse(localStorage.getItem('squall.drivePaused') || '{}') || {}; } catch (e) { drivePaused = {}; }
  function driveSetPaused(name, on, chat) {
    if (!!drivePaused[name] === on) return;
    if (on) drivePaused[name] = Date.now(); else delete drivePaused[name];
    try { localStorage.setItem('squall.drivePaused', JSON.stringify(drivePaused)); } catch (e) { }
    if (chat) addMessage(chat, { who: APP, kind: 'event', text: on ? '⏸ To do reminders held: you paused ' + name + '. Say “resume” or “carry on” to let them go again.' : '▶ To do reminders on again for ' + name + '.' });
  }
  function driveNote(name) {
    const open = driveItems();
    const shown = open.filter(i => i.status === 'doing').concat(open.filter(i => i.status !== 'doing')).slice(0, 8);
    return 'To do (Storm: when you stop, finish everything on the To do list that does not need him). Open now:\n' +
      shown.map(i => '- [' + i.id + '] ' + (i.status === 'doing' ? 'doing' + (i.who ? ' (' + i.who + (i.who === name ? ', you' : '') + ')' : '') : 'next') + ': ' + String(i.text || '').slice(0, 140)).join('\n') +
      (open.length > shown.length ? '\n- and ' + (open.length - shown.length) + ' more' : '') +
      '\nTake the first one that does not need Storm: mark it (todo_doing), do it, and close it (todo_done) in the reply that says so; then the next. One that needs him ' +
      '(his decision, his answer, his machine, a game he has open) is not skipped in silence: end your reply with ```squall {"actions":[{"do":"todo_needs","id":"<id>","why":"<one line>"}]}``` ' +
      'for each, and it waits until he writes to you.';
  }
  function driveStormWrote(name, text, chat) {
    // his words decide a pause (DRIVE_PAUSE_RX / DRIVE_GO_RX); a message that says neither keeps it as it is
    if (typeof text === 'string' && text) {
      if (DRIVE_PAUSE_RX.test(text)) driveSetPaused(name, true, chat);
      else if (DRIVE_GO_RX.test(text)) driveSetPaused(name, false, chat);
    }
    driveOf(name).held = false;
    let n = 0;
    for (const it of TODO.items) if (it.needs) { delete it.needs; delete it.needsBy; n++; }
    if (n) todoSave();
  }
  function driveTick() {
    if (S.selftest) return;   // the self-test drives its own chats
    if (teamPaused()) return;   // Pause all: no To do nudges
    for (const a of (S.chiefs && S.chiefs.length ? S.chiefs : (S.lead ? [S.lead] : []))) {
      const chat = chatById('dm:' + a.name), d = driveOf(a.name);
      if (!chat || d.held || drivePaused[a.name] || S.timers[chat.id]) { d.busySeen = false; d.idleSince = 0; continue; }
      const mi = mirrorFor(chat);
      if (mi ? mirrorBusy(mi, false) : S.flows[chat.id]) { d.busySeen = true; if (!d.busyFrom) d.busyFrom = Date.now(); d.idleSince = 0; continue; }   // working
      if (mi && (mirrorBusy(mi) || (mi.pending || []).some(p => Date.now() - p.at < 60000))) { d.idleSince = 0; continue; }   // a message on its way
      if (!d.busySeen) continue;                            // only a stop after work counts (the drive's own nudge has to start a turn first)
      if (!driveItems().length) { d.busySeen = false; d.idleSince = 0; continue; }
      if (!d.idleSince) { d.idleSince = Date.now(); continue; }
      if (Date.now() - d.idleSince < TIMER_SETTLE_MS) continue;
      const quickTurn = d.lastNudge && d.idleSince - (d.busyFrom || d.idleSince) < TIMER_QUICK_MS;
      if (quickTurn && d.quick >= 2 && Date.now() - d.lastNudge < 60000) continue;
      if (updateReadyAt && Date.now() - updateReadyAt < UPDATE_HOLD_MS) continue;   // let the waiting update go in first
      if (mi && S.link.status !== 'on' && !NO_RELAY()) continue;                    // the live link is off: nothing to say it through
      d.quick = quickTurn ? d.quick + 1 : 0;
      d.busySeen = false; d.idleSince = 0; d.busyFrom = 0; d.lastNudge = Date.now();
      Bridge.call('log', { level: 'timer', msg: chat.id + ' to do drive (' + driveItems().length + ' open, quick ' + d.quick + ')' }).catch(() => {});
      if (mi) sendToMirror(chat, driveNote(a.name), [], [], APP + ' (To do): ');
      else continueLocal(chat, driveNote(a.name));
    }
  }
  function driveWatchStart() { if (!driveWatch) driveWatch = setInterval(driveTick, 2000); }
  // Storm (19 Oct, via Chief): when he leaves Squall (the window loses focus), every bot that's working hears it once, in his words, and
  // keeps going on its own; when he's back, those bots welcome him with a report. Ten seconds of grace, so a quick alt-tab doesn't count.
  // Working: a live session mid-turn, a local reply being written, or a running work timer
  // Storm, 20 Oct ("Why does most of your regular messages show as thinking?"): a long message a session writes in the middle of a
  // turn can be lost before it reaches the transcript, so he saw only the app's one-line step summaries (💭); short lines and the
  // reply that ends a turn always arrive. So the welcome is one line now and the full report goes in the turn's last reply.
  const AWAY_NOTE = 'Storm has unfocused the app. Continue working autonomously from here without making dangerous changes. When Storm gets back, welcome him in one short line, and put your full report in the reply that ends your turn.';
  const BACK_NOTE = 'Storm is back in Squall. Welcome him now in one short line (a long message written mid-turn can be lost before it reaches him), then put your full report in the reply that ends your turn: what you did while he was away, and anything that needs him.';
  // polish (19 Oct, night): a minute of grace, and the welcome-back report only after 3 minutes away, at most once per 10 minutes a chat;
  // every short alt-tab had cost each working bot an away note and a full report
  // 20 Oct (Storm: "stop messaging bots so much dude you can tell what the usage is"): each note is a whole turn for the bot, so the away note goes
  // to a chat at most once in 45 minutes, only to a bot that is mid-turn WITHOUT a work timer (a timer keeps it going anyway), and not at all while
  // the plan is throttled; the welcome-back report is at most once in 30 minutes then
  const AWAY_GRACE_MS = 60000, BACK_MIN_AWAY_MS = 180000, BACK_GAP_MS = 600000, AWAY_GAP_MS = 45 * 60000, BACK_GAP_TIGHT_MS = 30 * 60000;
  const awaySaidAt = {};
  let awayTimer = 0, awayTold = [], awayAt = 0;
  const backSaidAt = {};
  const pendingNotes = {};   // chat id -> a note for its bots that goes when the chat's running reply ends (drainWoken)
  function workingChats() {
    return S.chats.filter(c => { const mi = mirrorFor(c); return (mi ? mirrorBusy(mi, false) : !!S.flows[c.id]) || !!S.timers[c.id]; });
  }
  function stormLeft() {
    if (document.hasFocus()) return;
    if (usageTight() || teamPaused()) return;   // throttled or paused: no "keep working on your own" note
    const chats = workingChats().filter(c => !S.timers[c.id] && Date.now() - (awaySaidAt[c.id] || 0) >= AWAY_GAP_MS);
    if (!chats.length) return;
    for (const c of chats) awaySaidAt[c.id] = Date.now();
    awayTold = chats.map(c => c.id); awayAt = Date.now();
    for (const c of chats) tellBots(c, AWAY_NOTE, 'away');
    Bridge.call('log', { level: 'away', msg: 'Storm left Squall: told ' + awayTold.join(', ') }).catch(() => {});
  }
  function stormBack() {
    clearTimeout(awayTimer);
    if (!awayTold.length) return;
    const told = awayTold; awayTold = [];
    if (Date.now() - awayAt < BACK_MIN_AWAY_MS) return;   // a short break: the bots just keep going, no report
    for (const id of told) {
      const c = chatById(id);
      if (!c || Date.now() - (backSaidAt[id] || 0) < (usageTight() ? BACK_GAP_TIGHT_MS : BACK_GAP_MS)) continue;
      backSaidAt[id] = Date.now();
      tellBots(c, BACK_NOTE, 'back');
    }
  }
  window.addEventListener('blur', () => { if (S.selftest) return; clearTimeout(awayTimer); awayTimer = setTimeout(stormLeft, AWAY_GRACE_MS); });
  window.addEventListener('focus', () => { if (!S.selftest) stormBack(); });
  // a live session gets the note through the relay (queued if it's mid-turn); local bots get it with their next turn
  function tellBots(chat, note, kind) {
    if (mirrorFor(chat)) { sendToMirror(chat, note, [], [], APP + ' (' + kind + '): ', APP, '', true); return; }
    if (S.flows[chat.id]) { pendingNotes[chat.id] = note; return; }
    runNote(chat, note, kind === 'away' ? 'You left ' + APP + ': the bots keep working on their own.' : 'You’re back: the bots are reporting.');
  }
  async function runNote(chat, note, label) {
    if (S.flows[chat.id]) { pendingNotes[chat.id] = note; return; }
    addMessage(chat, { who: APP, kind: 'event', text: label });
    beginFlow(chat);
    renderComposer(); renderTeam(); updateTitle();
    try { await converse(chat, '', note); }
    catch (e) { addMessage(chat, { who: APP, kind: 'error', text: String(e && e.message || e) }); }
    finally { endFlow(chat); renderComposer(); renderTeam(); updateTitle(); saveSoon(); onTurnEnd(chat.id); finishPing(chat.id); reloadIfIdle(); drainWoken(chat); }
  }

  // local agents: the chat's lead (or the dm's agent) takes another turn with the timer note
  async function continueLocal(chat, note) {
    if (S.flows[chat.id]) return;
    addMessage(chat, { who: APP, kind: 'event', text: '⏱ ' + note.split('. ')[0] });
    beginFlow(chat);
    renderComposer(); renderTeam(); updateTitle();
    try { await converse(chat, '', note); }
    catch (e) { addMessage(chat, { who: APP, kind: 'error', text: String(e && e.message || e) }); }
    finally { endFlow(chat); renderComposer(); renderTeam(); updateTitle(); saveSoon(); onTurnEnd(chat.id); finishPing(chat.id); reloadIfIdle(); drainWoken(chat); }
  }

  // ---------- messages from live sessions can wake the local bots ----------
  // A session's message (the relay's inbound line) wakes the local bots it's for, once: a DM's bot answers, and in a group the local
  // bots it @mentions. A bot is never woken by its own message. A flow already running in the chat makes the wake-up wait for it.
  // The caps of a chat turn apply, and at most MAX_ROUNDS wake-ups per chat in ten minutes, so sessions and bots can't loop.
  const INBOUND_WINDOW_MS = 10 * 60 * 1000;
  const inboundHits = {}, inboundWait = {};   // chat id -> when wake-ups started (last ten minutes); chat id -> the wake-up waiting for a flow
  // a local bot: no running session of its own is answering for it. A bot's Claude app session that isn't running doesn't count:
  // Squall runs the bot itself on that conversation (before, any app session counted, so Chief's roll call and Laptop's catch-up woke nobody)
  function localBot(name) {
    const peer = S.liveMode && S.link.status === 'on' ? peerFor(name) : null;
    return !!S.byName[name] && !(peer && peer.status !== 'offline');
  }
  function wakeLocalBots(chat, from, text) {
    const names = (chat.kind === 'dm' ? [chat.members[0]] : mentionsIn(text, chat, from)).filter(n => n !== from && localBot(n));
    if (!names.length) return;
    if (S.flows[chat.id]) {   // a flow is running here: the wake-up queues behind it
      const w = inboundWait[chat.id] || (inboundWait[chat.id] = { names: [], from, text });
      for (const n of names) if (!w.names.includes(n)) w.names.push(n);
      return;
    }
    wakeRun(chat, names, from, text);
  }
  function wakeRun(chat, names, from, text) {
    const now = Date.now();
    const hits = (inboundHits[chat.id] || []).filter(t => now - t < INBOUND_WINDOW_MS);
    inboundHits[chat.id] = hits;
    if (hits.length >= MAX_ROUNDS) {
      addMessage(chat, { who: APP, kind: 'event', text: 'Paused: messages from sessions woke the bots here ' + MAX_ROUNDS + ' times in ten minutes, so they stop there. Write to them to carry on.' });
      return;
    }
    hits.push(now);
    runWoken(chat, names, from + (chat.kind === 'dm' ? ' messaged you. Answer in this chat.' : ' mentioned you. Answer in this chat.'), text);
  }
  async function runWoken(chat, names, note, text) {
    beginFlow(chat);
    renderComposer(); renderTeam(); updateTitle();
    try { await converse(chat, text || '', note, names); }
    catch (e) { addMessage(chat, { who: APP, kind: 'error', text: String(e && e.message || e) }); }
    finally { endFlow(chat); renderComposer(); renderTeam(); updateTitle(); saveSoon(); onTurnEnd(chat.id); finishPing(chat.id); reloadIfIdle(); drainWoken(chat); }
  }
  // tasks a live chief handed out on its own (onInbound): each teammate takes its task at once, then the chief hears back and writes the
  // answer for Storm, as at the end of a team flow. A reply still being written in the chat goes first
  async function runAssigned(chat, lead, tasks) {
    for (let k = 0; S.flows[chat.id] && k < 600; k++) await sleep(500);
    const epoch = S.stopEpoch;
    beginFlow(chat);
    renderComposer(); renderTeam(); updateTitle();
    try {
      const results = await Promise.all(tasks.map(t => askAgent(chat, t.to, lead + ' assigned you: ' + t.task, epoch)));
      if (epoch === S.stopEpoch && results.some(r => r && !r.isError)) await askAgent(chat, lead, WRAP_UP, epoch);
    } catch (e) { addMessage(chat, { who: APP, kind: 'error', text: String(e && e.message || e) }); }
    finally { endFlow(chat); renderComposer(); renderTeam(); updateTitle(); saveSoon(); onTurnEnd(chat.id); finishPing(chat.id); reloadIfIdle(); drainWoken(chat); }
  }
  // a wake-up that queued behind a flow runs now, through the same limits
  function drainWoken(chat) {
    const pn = pendingNotes[chat.id];   // Storm left or came back while a reply was being written: the bots hear it now
    if (pn && !S.flows[chat.id]) { delete pendingNotes[chat.id]; runNote(chat, pn, pn === AWAY_NOTE ? 'You left ' + APP + ': the bots keep working on their own.' : 'You’re back: the bots are reporting.'); return; }
    const w = inboundWait[chat.id];
    if (!w) return;
    delete inboundWait[chat.id];
    if (!S.flows[chat.id]) wakeRun(chat, w.names, w.from, w.text);
  }

  $('#input').addEventListener('input', autosize);
  // the message box survives a restart: what Storm is typing is kept (in this window's storage) until it's sent
  const DRAFT_KEY = 'squall.draft';
  // ---------- sounds for everything (Storm: "Make the app have typing sounds and sounds for everything"): all made here with Web Audio,
  // short and quiet, and never the same sound in a burst. Settings → Sound: all sounds, just the finish ping, or off ----------
  const SFX_VOL = 0.16;
  function sfxCtx() {
    try { const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null; audioCtx = audioCtx || new AC(); if (audioCtx.state === 'suspended') audioCtx.resume(); return audioCtx; } catch (e) { return null; }
  }
  function sfxTone(f1, f2, dur, type, vol, delay) {
    const ac = sfxCtx(); if (!ac) return;
    const t0 = ac.currentTime + 0.005 + (delay || 0), o = ac.createOscillator(), g = ac.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(f1, t0);
    if (f2) o.frequency.exponentialRampToValueAtTime(f2, t0 + dur * 0.8);
    g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime((vol || 1) * SFX_VOL, t0 + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(ac.destination); o.start(t0); o.stop(t0 + dur + 0.03);
  }
  function sfxNoise(dur, freq, q, vol, sweepTo, delay) {
    const ac = sfxCtx(); if (!ac) return;
    const t0 = ac.currentTime + 0.005 + (delay || 0), n = Math.max(1, Math.floor(ac.sampleRate * dur)), buf = ac.createBuffer(1, n, ac.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 2);
    const src = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
    src.buffer = buf; f.type = 'bandpass'; f.frequency.setValueAtTime(freq, t0); if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t0 + dur); f.Q.value = q || 1;
    g.gain.setValueAtTime((vol || 1) * SFX_VOL, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f); f.connect(g); g.connect(ac.destination); src.start(t0);
  }
  const SFX = {
    key: () => sfxNoise(0.022, 2200 + Math.random() * 1600, 3.5, 0.32),
    send: () => { sfxNoise(0.07, 900, 0.9, 0.22, 3000); sfxTone(587, 880, 0.1, 'sine', 0.24, 0.02); },   // soft upward flick (was a long whoosh)
    reply: () => { sfxTone(660, 990, 0.11, 'sine', 0.42); sfxTone(990, 1320, 0.09, 'sine', 0.24, 0.07); },
    peek: () => sfxTone(880, 1180, 0.08, 'sine', 0.28),
    tick: () => sfxNoise(0.018, 3400, 5, 0.22),
    open: () => { sfxTone(660, 880, 0.09, 'sine', 0.2); sfxNoise(0.05, 1500, 1.4, 0.1, 2600); },
    close: () => { sfxTone(880, 620, 0.08, 'sine', 0.16); sfxNoise(0.05, 2400, 1.4, 0.08, 1200); },
    ask: () => { sfxTone(740, 0, 0.16, 'triangle', 0.32); sfxTone(988, 0, 0.22, 'triangle', 0.32, 0.12); },
    update: () => { [659, 880, 1319].forEach((f, i) => sfxTone(f, 0, 0.12, 'sine', 0.2, i * 0.04)); },
    error: () => { sfxTone(330, 247, 0.12, 'triangle', 0.3); sfxTone(247, 0, 0.08, 'triangle', 0.2, 0.08); },   // soft low two-step, no buzz
    voiceOn: () => sfxTone(520, 1040, 0.14, 'sine', 0.34),
    voiceOff: () => sfxTone(1040, 520, 0.14, 'sine', 0.28),
    // more of them (Storm: "There needs to be more sounds its kinda bland", "a cool animation and sound when changing layouts")
    layoutIn: () => { sfxNoise(0.34, 300, 0.7, 0.45, 3200); sfxTone(392, 784, 0.22, 'sine', 0.2, 0.04); sfxTone(587, 1175, 0.18, 'triangle', 0.12, 0.12); },
    layoutOut: () => { sfxNoise(0.34, 3200, 0.7, 0.4, 300); sfxTone(784, 392, 0.22, 'sine', 0.2, 0.04); sfxTone(1175, 587, 0.18, 'triangle', 0.1, 0.12); },
    chat: () => { sfxTone(1320, 1560, 0.05, 'sine', 0.16); sfxNoise(0.04, 5000, 4, 0.12, 0, 0.01); },
    copy: () => { sfxTone(1760, 2093, 0.06, 'sine', 0.2); sfxTone(2637, 0, 0.05, 'sine', 0.12, 0.05); },
    toggle: () => { sfxNoise(0.03, 1800, 6, 0.28); sfxTone(880, 0, 0.04, 'square', 0.06); },
    done: () => { sfxTone(784, 0, 0.08, 'sine', 0.22); sfxTone(1175, 0, 0.1, 'sine', 0.18, 0.05); },
    swoosh: () => sfxNoise(0.22, 600, 0.9, 0.3, 4200),
    // Storm, 28 Oct: "Make more sound effects for the UI" (and heavy ones are "too much"): one soft family, sine/triangle, under ~200 ms
    pop: () => sfxTone(990, 1320, 0.05, 'sine', 0.18),
    okNeed: () => { sfxTone(698, 0, 0.09, 'triangle', 0.26); sfxTone(932, 0, 0.11, 'triangle', 0.24, 0.08); },   // a bot needs your OK
    okYes: () => { sfxTone(784, 1046, 0.1, 'sine', 0.22); },
    okNo: () => { sfxTone(587, 440, 0.11, 'sine', 0.18); },
    question: () => { sfxTone(880, 0, 0.07, 'sine', 0.2); sfxTone(1175, 1245, 0.1, 'sine', 0.18, 0.07); },   // a question card shows up
    mention: () => sfxTone(1568, 1760, 0.04, 'sine', 0.14),
    born: () => { [523, 784, 1046, 1568].forEach((f, i) => sfxTone(f, 0, 0.13, 'sine', 0.17 - i * 0.025, i * 0.035)); sfxNoise(0.12, 6000, 3, 0.05, 9000, 0.06); },   // a new teammate: a little sparkle
    starxOn: () => { sfxTone(440, 660, 0.12, 'sine', 0.22); sfxTone(880, 0, 0.08, 'sine', 0.12, 0.08); },
    starxOff: () => { sfxTone(660, 440, 0.12, 'sine', 0.2); sfxTone(330, 0, 0.08, 'sine', 0.1, 0.08); },
  };
  // a dialog closing chimes only when nothing opens right after it (switching dialogs plays just the open)
  function sfxCloseSoon() { const t = performance.now(); setTimeout(() => { if ((sfxLast.open || 0) < t) sfx('close'); }, 0); }
  // Test sound with "All sounds" on: a short tour of the family (plays even when sounds are off, like the old test)
  const SFX_TOUR = ['send', 'reply', 'question', 'okNeed', 'okYes', 'okNo', 'open', 'close', 'chat', 'done', 'mention', 'update', 'starxOn', 'starxOff', 'born', 'error'];
  let sfxTouring = 0;
  function sfxTour() {
    clearTimeout(sfxTouring); let i = 0;
    const step = () => { if (i >= SFX_TOUR.length) { sfxSleepSoon(); return; } try { SFX[SFX_TOUR[i++]](); } catch (e) { } sfxTouring = setTimeout(step, 330); };
    step();
  }
  const sfxLast = {};
  let sfxIdle = 0;
  // the sound engine sleeps after a few quiet seconds: a running one keeps an audio thread busy even in silence
  function sfxSleepSoon() { clearTimeout(sfxIdle); sfxIdle = setTimeout(() => { try { if (audioCtx && audioCtx.state === 'running') audioCtx.suspend(); } catch (e) { } }, 4000); }
  function sfx(name) {
    if (S.sounds !== 'all' || S.selftest || !SFX[name]) return false;
    const now = performance.now();
    if (now - (sfxLast[name] || 0) < (name === 'key' ? 30 : name === 'reply' || name === 'error' || name === 'okNeed' || name === 'question' ? 700 : 120)) return false;
    if (name !== 'key' && now - (sfxLast._any || 0) < 70) return false;   // rapid events: one sound at a time, never a pile-up
    sfxLast[name] = now; if (name !== 'key') sfxLast._any = now;
    try { SFX[name](); } catch (e) { }
    sfxSleepSoon();
    return true;
  }
  $('#input').addEventListener('keydown', e => { if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Delete')) sfx('key'); });

  // ---------- an interactive background (Storm: "Make the squall background interactive"): soft motes drift behind the panels, a glow
  // follows the pointer and pushes them aside, a click on an empty spot sends a ripple, and a reply makes them pulse in the bot's color.
  // Light: about 30 frames a second, and it stops while Squall is minimized or hidden ----------
  const BG = { motes: [], ripples: [], pulse: null, mx: -1, my: -1, raf: 0, last: 0, w: 0, h: 0, ctx: null };
  function bgStart() {
    if (BG.ctx) return;
    const c = document.createElement('canvas');
    c.id = 'bg-fx';
    document.body.prepend(c);
    BG.ctx = c.getContext('2d');
    const fit = () => { const dpr = Math.min(2, window.devicePixelRatio || 1); BG.w = window.innerWidth; BG.h = window.innerHeight; c.width = Math.round(BG.w * dpr); c.height = Math.round(BG.h * dpr); c.style.width = BG.w + 'px'; c.style.height = BG.h + 'px'; BG.ctx.setTransform(dpr, 0, 0, dpr, 0, 0); };
    fit(); window.addEventListener('resize', fit);
    const n = Math.round(Math.min(90, BG.w * BG.h / 16000));
    for (let i = 0; i < n; i++) BG.motes.push({ x: Math.random() * BG.w, y: Math.random() * BG.h, vx: (Math.random() - 0.5) * 0.15, vy: (Math.random() - 0.5) * 0.15, r: 0.6 + Math.random() * 1.8, a: 0.15 + Math.random() * 0.35, hue: Math.random() < 0.5 ? 255 : 205 });
    window.addEventListener('pointermove', e => { BG.mx = e.clientX; BG.my = e.clientY; bgKick(); }, { passive: true });
    document.addEventListener('pointerleave', () => { BG.mx = -1; });
    window.addEventListener('pointerdown', e => { if (e.target === document.body || e.target.id === 'app' || e.target.id === 'bg-fx') { BG.ripples.push({ x: e.clientX, y: e.clientY, t: performance.now() }); sfx('pop'); bgKick(); } });
    document.addEventListener('visibilitychange', bgKick);
    bgKick();
  }
  // minimized: every animation pauses and the background stops drawing, so Squall costs nothing while Storm games (it measured about
  // 12% of a core minimized before this); everything picks up again when the window comes back
  function setWinState(minimized) {
    const was = !!S.winMin;
    S.winMin = !!minimized;
    document.body.classList.toggle('paused', S.winMin);
    if (S.winMin) { if (BG.raf) { cancelAnimationFrame(BG.raf); BG.raf = 0; } if (VG.raf) { cancelAnimationFrame(VG.raf); VG.raf = 0; } }   // stop now, not after the next frame
    if (S.winMin && !was && !(voiceOn && voiceMode === 'call')) Bridge.call('closeWarm').catch(() => { });   // bots kept ready for a follow-up let go of their memory
    if (was !== S.winMin) Bridge.call('log', { level: 'info', msg: S.winMin ? 'paused: minimized (no drawing until the window comes back)' : 'resumed: window back' }).catch(() => { });
    if (!S.winMin) { bgKick(); vgKick && vgKick(); if (S.renderPending) { S.renderPending = false; renderAll(); } if (S.liveMode && S.link.status === 'on' && Date.now() - (S.link.listedAt || 0) > 120000) listPeers(); }
  }
  Bridge.on('winstate', m => setWinState(m.minimized));
  function bgPulse(color) { BG.pulse = { color: color || '#a78bfa', t: performance.now() }; bgKick(); }
  function bgKick() { if (!BG.raf && BG.ctx && document.visibilityState !== 'hidden' && !S.winMin) BG.raf = requestAnimationFrame(bgFrame); }
  function bgFrame(now) {
    BG.raf = 0;
    if (document.visibilityState === 'hidden' || S.winMin) return;
    BG.raf = requestAnimationFrame(bgFrame);
    if (now - BG.last < 32) return;   // about 30 frames a second is plenty for a background
    BG.last = now;
    const ctx = BG.ctx, W = BG.w, H = BG.h;
    ctx.clearRect(0, 0, W, H);
    if (BG.mx >= 0) {   // the glow under the pointer
      const g = ctx.createRadialGradient(BG.mx, BG.my, 0, BG.mx, BG.my, 260);
      g.addColorStop(0, 'rgba(167, 139, 250, 0.10)'); g.addColorStop(1, 'rgba(167, 139, 250, 0)');
      ctx.fillStyle = g; ctx.fillRect(BG.mx - 260, BG.my - 260, 520, 520);
    }
    const pulse = BG.pulse && now - BG.pulse.t < 1400 ? BG.pulse : null;
    const pk = pulse ? 1 - (now - pulse.t) / 1400 : 0;
    for (const m of BG.motes) {
      if (BG.mx >= 0) { const dx = m.x - BG.mx, dy = m.y - BG.my, d2 = dx * dx + dy * dy; if (d2 < 22500 && d2 > 1) { const f = (1 - Math.sqrt(d2) / 150) * 0.35; m.vx += dx / Math.sqrt(d2) * f; m.vy += dy / Math.sqrt(d2) * f; } }
      for (const rp of BG.ripples) { const age = (now - rp.t) / 1000, rad = age * 420, dx = m.x - rp.x, dy = m.y - rp.y, d = Math.sqrt(dx * dx + dy * dy) || 1; if (Math.abs(d - rad) < 30) { m.vx += dx / d * 0.9 * (1 - age); m.vy += dy / d * 0.9 * (1 - age); } }
      m.vx = m.vx * 0.96 + (Math.random() - 0.5) * 0.01; m.vy = m.vy * 0.96 + (Math.random() - 0.5) * 0.01;
      m.x += m.vx + 0.04; m.y += m.vy - 0.02;
      if (m.x < -10) m.x = W + 10; if (m.x > W + 10) m.x = -10; if (m.y < -10) m.y = H + 10; if (m.y > H + 10) m.y = -10;
      ctx.beginPath(); ctx.arc(m.x, m.y, m.r * (1 + pk * 0.8), 0, Math.PI * 2);
      ctx.fillStyle = pulse ? pulse.color : 'hsl(' + m.hue + ', 80%, 78%)';
      ctx.globalAlpha = Math.min(1, m.a + pk * 0.4);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    BG.ripples = BG.ripples.filter(rp => now - rp.t < 1000);
    for (const rp of BG.ripples) { const age = Math.max(0, (now - rp.t) / 1000); if (age >= 1) continue; ctx.beginPath(); ctx.arc(rp.x, rp.y, age * 420, 0, Math.PI * 2); ctx.strokeStyle = 'rgba(196, 181, 253, ' + (0.35 * (1 - age)).toFixed(3) + ')'; ctx.lineWidth = 1.5; ctx.stroke(); }
  }
  SFX.pop = () => sfxTone(420, 640, 0.07, 'sine', 0.26);
  // ---------- a visual to-do list in the right pane (Storm: "I want a visual todo list on the right side"): workspace\shared\todo.json,
  // which Storm, his live sessions (Laptop keeps his requests there) and the bots all keep. Doing now, Next and Done, with progress ----------
  const TODO = { items: [] };
  function todoOpen() { try { return TODO.items.filter(i => i.status !== 'done').length; } catch (e) { return 0; } }   // safe before the list is set up
  async function todoLoad() {
    try { const d = JSON.parse((await Bridge.call('todoRead')) || '{}'); TODO.items = Array.isArray(d.items) ? d.items : []; } catch (e) { }
    renderLiveTabs();
    if (S.rightMode === 'todo') renderTodoPane();
  }
  function todoSave() { Bridge.call('todoSave', { items: TODO.items }).catch(() => { }); renderLiveTabs(); if (S.rightMode === 'todo') renderTodoPane(); }
  function todoAdd(text, by) {
    const tx = String(text || '').trim().slice(0, 300);
    if (!tx) return null;
    const it = { id: 't' + uid(), text: tx, status: 'todo', by: by || 'Storm', at: new Date().toISOString() };
    TODO.items.push(it); todoSave(); sfx('pop');
    return it;
  }
  const todoFind = key => TODO.items.find(x => x.id === key) || TODO.items.find(x => x.status !== 'done' && x.text.toLowerCase() === String(key || '').trim().toLowerCase());
  function todoSet(key, status) {
    const it = todoFind(key);
    if (!it) return false;
    it.status = status;
    if (status === 'done') { it.doneAt = new Date().toISOString(); sfx('done'); } else delete it.doneAt;
    todoSave();
    return true;
  }
  function todoDel(id) { TODO.items = TODO.items.filter(x => x.id !== id); todoSave(); }
  function renderTodoPane() {
    const body = $('#live-body'), items = TODO.items;
    const doing = items.filter(i => i.status === 'doing'), next = items.filter(i => i.status === 'todo'), done = items.filter(i => i.status === 'done').slice(-12).reverse();
    const n = items.length, d = items.filter(i => i.status === 'done').length;
    const row = it => '<div class="todo-row ' + esc(it.status) + '" data-k="' + esc(it.id) + '"><button class="todo-check" data-todo="' + (it.status === 'done' ? 'undo' : 'done') + '" data-id="' + esc(it.id) + '" title="' + (it.status === 'done' ? 'Not done after all' : 'Done') + '">' + (it.status === 'done' ? '✓' : '') + '</button>' +
      '<div class="todo-text">' + esc(it.text) + (it.needs && it.status !== 'done' ? ' <b class="todo-needs" style="color:#f59e0b" title="' + esc(it.needs) + '">needs you</b>' : '') + (it.by || it.who ? '<small>' + esc(it.by || '') + (it.who && it.status !== 'todo' ? (it.by ? ' · ' : '') + '<b class="todo-who" style="--c:' + esc((S.byName[it.who] || {}).color || '#a78bfa') + '">' + esc(it.who) + (it.status === 'done' ? ' did it' : ' is on it') + '</b>' : '') + '</small>' : '') + '</div>' +
      (it.status === 'todo' ? '<button class="todo-act" data-todo="doing" data-id="' + esc(it.id) + '" title="Doing this now">Start</button>' : '') +
      '<button class="todo-x" data-todo="del" data-id="' + esc(it.id) + '" title="Remove">×</button></div>';
    if (!body.querySelector('.todo-pane')) body.innerHTML = '<div class="todo-pane"><div class="todo-head"><b>To do</b><span class="todo-count"></span></div><div class="todo-bar"><i></i></div><div class="todo-add"><input id="todo-in" type="text" placeholder="Add a to-do…" maxlength="300" autocomplete="off"></div><div class="todo-list"></div></div>';
    body.querySelector('.todo-count').textContent = d + ' of ' + n + ' done';
    body.querySelector('.todo-bar i').style.width = (n ? Math.round(d / n * 100) : 0) + '%';
    patchHTML(body.querySelector('.todo-list'), (doing.length ? '<div class="todo-sec">Doing now</div>' + doing.map(row).join('') : '') + (next.length ? '<div class="todo-sec">Next</div>' + next.map(row).join('') : '') +
      (done.length ? '<div class="todo-sec">Done</div>' + done.map(row).join('') : '') + (!n ? '<div class="live-empty" data-k="none">Nothing yet. Add one above, or ask a bot or Laptop to keep their work here.</div>' : ''));
    $('#live-foot').innerHTML = '<span>Shared with your bots and sessions (workspace\\shared\\todo.json)</span>';
  }
  document.addEventListener('keydown', e => { if (e.target && e.target.id === 'todo-in' && e.key === 'Enter') { e.preventDefault(); if (todoAdd(e.target.value, 'Storm')) e.target.value = ''; } });
  // ---------- reply peeks: a bot's reply in a chat that isn't open pops out of its icon for a few seconds; a click goes there ----------
  const PEEK_MS = 7000;
  const peekText = t => String(t || '').replace(/```[\s\S]*?```/g, ' [code] ').replace(/`([^`]*)`/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_#>]+/g, '').replace(/\s+/g, ' ').trim();
  function showPeek(chat, m) {
    const text = peekText(m.text);
    if (!chat || chat.id === S.active || !text) return null;
    const key = chat.kind === 'dm' ? 'dm:' + chat.members[0] : chat.id;
    const anchor = document.querySelector('#agents [data-chat="' + key + '"] .avatar') || document.querySelector('#agents [data-chat="' + key + '"]');
    document.querySelectorAll('.peek').forEach(x => { if (x.dataset.peek === chat.id) x.remove(); });
    const a = S.byName[m.who];
    const el = document.createElement('div');
    el.className = 'peek';
    el.dataset.peek = chat.id;
    el.style.setProperty('--c', a ? a.color : '#a78bfa');
    el.innerHTML = '<b>' + esc(m.who) + (chat.kind !== 'dm' ? '<small> in ' + esc(chat.name) + '</small>' : '') + '</b><span>' + esc(text.length > 120 ? text.slice(0, 120) + '…' : text) + '</span>';
    document.body.append(el);
    sfx('peek');
    const r = anchor ? anchor.getBoundingClientRect() : { right: 230, top: 120, height: 40 };
    el.style.left = Math.max(8, Math.min(window.innerWidth - el.offsetWidth - 8, r.right + 10)) + 'px';
    el.style.top = Math.max(8, Math.min(window.innerHeight - el.offsetHeight - 8, r.top + r.height / 2 - el.offsetHeight / 2)) + 'px';
    let left = PEEK_MS, last = Date.now(), hover = false;
    el.addEventListener('mouseenter', () => { hover = true; });
    el.addEventListener('mouseleave', () => { hover = false; last = Date.now(); });
    el.addEventListener('click', () => { el.remove(); openChat(chat.id); });
    const tick = setInterval(() => {   // counts down only while Squall is on screen and the pointer isn't on it
      if (!el.isConnected) { clearInterval(tick); return; }
      const now = Date.now();
      if (!hover && document.visibilityState === 'visible') left -= now - last;
      last = now;
      if (left <= 0) { clearInterval(tick); el.classList.add('out'); setTimeout(() => el.remove(), 300); }
    }, 250);
    return el;
  }

  // ---------- Ctrl+K: jump to any teammate, chat or tool by typing a few letters ----------
  function quickItems() {
    const chiefs = S.chiefs && S.chiefs.length ? S.chiefs : (S.lead ? [S.lead] : []);
    const items = S.agents.map(a => ({ label: a.name, sub: (chiefs.includes(a) ? 'Chief · ' : '') + (a.needsOk ? 'waiting for your OK · ' : agentBusy(a) ? 'working · ' : isSleeping(a) ? 'napping · ' : '') + 'direct chat', color: a.color, go: () => openChat('dm:' + a.name) }));
    for (const c of S.chats) if (c.kind !== 'dm') items.push({ label: c.name, sub: c.kind === 'team' ? 'everyone' : 'group · ' + c.members.join(', '), color: '#a78bfa', go: () => openChat(c.id) });
    items.push({ label: 'Settings', sub: 'model, voice, approvals, recent updates', go: () => openSettings() });
    items.push({ label: 'Routines', sub: 'jobs at set times, and the Claude app’s scheduled tasks', go: () => openRoutines() });
    items.push({ label: 'New group', sub: 'make a group chat', go: () => { const b = document.querySelector('[data-act="newgroup"]'); if (b) b.click(); } });
    items.push({ label: 'Add a teammate', sub: 'a new bot', go: () => { const b = document.querySelector('[data-act="newteammate"]'); if (b) b.click(); } });
    items.push({ label: 'Voice call', sub: 'talk hands-free, and the replies show on screen', go: () => voiceToggle('call') });
    items.push({ label: 'Dictation', sub: 'talk, and it types into the box', go: () => voiceToggle('dictate') });
    items.push({ label: 'Obsidian vault', sub: 'search and read EVO', go: () => openVault() });
    items.push({ label: 'Find in this chat', sub: 'Ctrl+F', go: () => openFind() });
    items.push({ label: 'Keyboard shortcuts', sub: 'Ctrl+/', go: () => openKeys() });
    items.push({ label: 'Update log', sub: 'what changed in each update', go: () => openUpdateLog() });
    return items;
  }
  function openQuick() {
    closeQuick(); sfx('open');
    const box = document.createElement('div');
    box.className = 'qk-back';
    box.innerHTML = '<div class="qk"><input id="qk-q" type="text" placeholder="Jump to a teammate, chat or tool…" spellcheck="false" autocomplete="off"><div class="qk-list"></div><div class="qk-hint">↑ ↓ to move · Enter to open · Esc to close</div></div>';
    document.body.append(box);
    const q = box.querySelector('#qk-q'), list = box.querySelector('.qk-list');
    let shown = [], sel = 0;
    const render = () => {
      const s = q.value.trim().toLowerCase(), all = quickItems();
      shown = !s ? all : all.filter(x => x.label.toLowerCase().includes(s) || x.sub.toLowerCase().includes(s))
        .sort((x, y) => (y.label.toLowerCase().startsWith(s) ? 2 : y.label.toLowerCase().includes(s) ? 1 : 0) - (x.label.toLowerCase().startsWith(s) ? 2 : x.label.toLowerCase().includes(s) ? 1 : 0));
      sel = Math.min(sel, Math.max(0, shown.length - 1));
      list.innerHTML = shown.length ? shown.map((x, i) => '<button class="qk-item' + (i === sel ? ' on' : '') + '" data-qk="' + i + '" style="--c:' + esc(x.color || '#8592a0') + '"><i></i><b>' + esc(x.label) + '</b><span>' + esc(x.sub) + '</span></button>').join('') : '<div class="qk-none">Nothing matches.</div>';
      const on = list.querySelector('.qk-item.on');
      if (on) on.scrollIntoView({ block: 'nearest' });
    };
    const go = i => { const x = shown[i]; if (!x) return; closeQuick(); x.go(); };
    q.addEventListener('input', () => { sel = 0; render(); });
    q.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(shown.length - 1, sel + 1); render(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); render(); }
      else if (e.key === 'Enter') { e.preventDefault(); go(sel); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeQuick(); }
    });
    list.addEventListener('mousedown', e => { const b = e.target.closest('[data-qk]'); if (b) { e.preventDefault(); go(+b.dataset.qk); } });
    box.addEventListener('mousedown', e => { if (e.target === box) closeQuick(); });
    render();
    q.focus();
    return box;
  }
  function closeQuick() { const q = document.querySelectorAll('.qk-back'); if (q.length) sfxCloseSoon(); q.forEach(x => x.remove()); }
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); if (document.querySelector('.qk-back')) closeQuick(); else openQuick(); }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key === '/') { e.preventDefault(); if (document.querySelector('.keys-modal')) closeModal(); else openKeys(); }
  });
  // ---------- Ctrl+/ : every keyboard shortcut on one card ----------
  const SHORTCUTS = [
    ['Enter', 'Send'],
    ['Shift+Enter', 'New line'],
    ['↑', 'In an empty box: bring back your last message in this chat (press again for older ones, ↓ for newer)'],   // groky r101
    ['@', 'Name a teammate in a team or group chat (Tab or Enter picks)'],
    ['Ctrl+V', 'Paste an image or a file into your message'],
    ['Ctrl+K', 'Jump to a teammate, chat or tool'],
    ['Ctrl+F', 'Find in this chat or note: Enter for older matches, Shift+Enter for newer'],
    ['↑ ↓', 'In the graph search: move through the notes, Enter opens one'],
    ['Esc', 'Close a card, menu, search or note'],
    ['Alt+\u2191', 'Previous chat in the sidebar (Alt+\u2193 for the next one)'],   // groky r97
    ['Alt+Shift+\u2193', 'Next chat with unread messages (Alt+Shift+\u2191 goes back)'],   // groky r97
    ['Alt+\u2190', 'Back to the chat you had open before (Alt+\u2192 goes forward; the mouse side buttons work too)'],   // groky r98
    ['Ctrl+1 \u2026 8', 'Open the first to eighth chat in the sidebar (Ctrl+9 opens the last one)'],   // groky r99
    ['PgUp PgDn', 'Scroll the open chat while you type (Ctrl+End jumps to the latest message, Ctrl+Home to the top)'],   // groky r100
    ['Alt+C', 'Copy the latest reply in this chat'],   // groky r102
    ['Alt+R', 'Reply to the latest message: quotes it in the box'],   // groky r103
    ['Alt+N', 'Jump to the New messages line in this chat'],   // groky r104
    ['A \u2026 Z', 'Start typing anywhere and it goes into the message box'],   // groky r106
    ['Ctrl+click a chat', 'Open it beside this one (middle-click works too)'],   // groky r107
    ['Ctrl+\\', 'Open a second chat beside this one, or close it again'],   // groky r108
    ['Ctrl+Shift+M', 'Turn Squall\'s sounds off, or back on the way you had them'],   // groky r109
    ['Ctrl+,', 'Open Settings (press it again to close them)'],   // groky r110
    ['Ctrl+N', 'New teammate (press it again to close the card)'],   // groky r111
    ['Ctrl+O', 'Open the Obsidian vault with its search ready (press it again to close it)'],   // groky r112
    ['Ctrl+U', 'Open the Update log to see what changed (press it again to close it)'],   // groky r113
    ['Ctrl+J', 'Open Routines, the jobs your bots run on a schedule (press it again to close it)'],   // groky r114
    ['Ctrl+= Ctrl+-', 'Make message text bigger or smaller, remembered next time (Ctrl+0 puts it back)'],   // groky r116
    ['F2', 'Rename the teammate whose chat is open (or whose tile has the focus)'],   // groky r117
    ['Shift+Esc', 'Mark every chat as read'],   // groky r119
    ['Alt+Shift+C', 'Copy this whole chat as plain text, ready to paste'],   // groky r120
    ['Ctrl+V on selected text', 'Paste a link over words you selected in the box to turn them into that link'],   // groky r121
    ['Ctrl+B  Ctrl+I  Ctrl+E', 'Bold, italic or code for the words selected in the box (press again to undo)'],   // groky r122
    ['Shift+Enter in a list', 'Start the next bullet, number or checkbox (on an empty item it ends the list)'],   // groky r122
    ['Tab  Shift+Tab in a list', 'Indent or outdent the list items under the caret or selection'],   // groky r123
    ['Enter in a ``` code block', 'New line instead of sending (Ctrl+Enter sends). Enter after an opening ``` adds the closing one'],   // groky r124
    ['Ctrl+Shift+Up/Down in the box', 'Move the line under the caret, or the selected lines, up or down (handy for reordering a list)'],   // groky r125
    ['( [ { " or a backtick with text selected', 'Wrap the selected text in that bracket or quote pair instead of replacing it'],   // groky r126
    ['Ctrl+Shift+D in the message box', 'Duplicate the current line, or the selected text, right below it'],   // groky r127
    ['Ctrl+Shift+K in the message box', 'Delete the current line, or every line the selection touches'],   // groky r128
    ['Ctrl+L in the message box', 'Select the current line, press again to add the next line'],   // groky r129
    ['Ctrl+Shift+8 / Ctrl+Shift+7 in the message box', 'Turn the line or selected lines into a bulleted or numbered list, press again to undo'],   // groky r130
    ['Ctrl+Shift+. in the message box', 'Quote the line or selected lines with > (press again to unquote)'],   // groky r131
    ['Ctrl+Shift+X  Ctrl+Shift+H', 'Strike through or highlight the words selected in the box (press again to undo)'],   // groky r132
    ['Ctrl+Shift+U in the box', 'Change the case of the selected words, or the word at the caret: UPPER, then Title, then lower'],   // groky r133
    ['Home in the box', 'On a list, quote or indented line, jump to just after the bullet first; press again for the very start (Shift+Home selects)'],   // groky r134
    ['Shift+Enter in a quote', 'Continue the > quote on the next line (also inside quoted lists); on an empty quote line it ends the quote'],   // groky r135
    ['Ctrl+Shift+9 in the message box', 'Turn the line or selected lines into a - [ ] checklist, press again to drop the checkboxes'],   // groky r136
    ['Ctrl+Shift+J in the message box', 'Join the next line onto this one, or join every selected line into one'],   // groky r137
    ['Ctrl+Alt+1, 2, 3 or 0 in the message box', 'Make the line a heading of that size, press again (or 0) to make it plain text'],   // groky r138
    ['Ctrl+V with cells from a spreadsheet', 'Paste them into the message box as a table, Ctrl+Shift+V keeps the plain text'],   // groky r139
    ['Ctrl+V with text from a web page or doc', 'Keeps its links, bold, italics, headings and lists as markdown, Ctrl+Shift+V keeps the plain text'],   // groky r140
    ['Alt+X on a checklist line', 'Tick or untick the - [ ] item under the caret, or every selected item'],   // groky r141
    ['F9 with lines selected', 'Sort the selected lines A to Z, press again for Z to A'],   // groky r142
    ['Ctrl+Shift+L in the message box', 'Turn the selected words (or the word at the caret) into a [link](), with the caret ready for the address; a selected address gets its words slot instead'],   // groky r143
    ['Ctrl+Shift+E in the message box', 'Put the caret\'s line or the selected lines in a code block; pressing it again on a code block takes the fences off'],   // groky r144
    ['Ctrl+]  Ctrl+[ in the message box', 'Indent the caret\'s line or the selected lines by two spaces, or take two spaces off (works on any line, code included)'],   // groky r145
    ['Ctrl+/', 'This list'],
  ];
  function openKeys() {
    closeModal(); closeQuick(); sfx('open');
    const box = document.createElement('div');
    box.className = 'modal-back';
    box.innerHTML = '<div class="modal add-modal keys-modal"><div class="set-head"><h3>Keyboard shortcuts</h3><button class="set-x" data-t="close" title="Close">×</button></div>' +
      '<input class="keys-q" type="search" placeholder="Search shortcuts" autocomplete="off" spellcheck="false" aria-label="Search shortcuts">' +   // groky r118
      '<div class="keys-list">' + SHORTCUTS.map(s => '<div class="keys-row"><span class="keys-k">' + s[0].split('+').map(k => '<kbd>' + esc(k) + '</kbd>').join('<i>+</i>') + '</span><span>' + esc(s[1]) + '</span></div>').join('') + '</div><div class="keys-none" hidden>No shortcut matches that</div></div>';
    document.body.append(box);
    box.addEventListener('click', e => { if (e.target === box || e.target.closest('[data-t="close"]')) closeModal(); });
    // groky r118: type to filter the shortcuts by key or by what they do (every word has to match). Esc clears the search first,
    // a second Esc closes the card. Rows just hide; no motion, no glow.
    const kq = box.querySelector('.keys-q'), kmod = box.querySelector('.keys-modal'), knone = box.querySelector('.keys-none');
    const krows = [...box.querySelectorAll('.keys-row')].map(r => ({ r, t: r.textContent.toLowerCase().replace(/\s+/g, ' ') }));
    const kfilter = () => {
      const words = kq.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
      let shown = 0;
      krows.forEach(x => { const on = !words.length || words.every(w => x.t.includes(w)); x.r.hidden = !on; if (on) shown++; });
      kmod.classList.toggle('keys-filtered', words.length > 0);
      knone.hidden = shown > 0;
    };
    kq.addEventListener('input', () => { kmod.classList.add('keys-typed'); kfilter(); });
    kq.addEventListener('keydown', e => { if (e.key === 'Escape' && kq.value) { e.preventDefault(); e.stopPropagation(); kq.value = ''; kfilter(); } });
    setTimeout(() => { if (kq.isConnected) kq.focus(); }, 0);
    return box;
  }

  // ---------- @ names: typing @ suggests the chat's teammates. The strip hides the row of @ chips so the chat gets that height ----------
  let atPick = null;   // { start, end, items, i }
  function atCheck() {
    const inp = $('#input'), c = activeChat();
    const pos = inp.selectionStart, before = inp.value.slice(0, pos);
    const m = /(^|[\s(])@([A-Za-z][\w-]*)?$/.exec(before);
    if (!m || !c || c.kind === 'dm' || inp.disabled) { atClose(); return; }
    const q = (m[2] || '').toLowerCase();
    const items = c.members.filter(n => n.toLowerCase().startsWith(q) && n.toLowerCase() !== q).slice(0, 6);
    if (!items.length) { atClose(); return; }
    atPick = { start: pos - (m[2] || '').length - 1, end: pos, items, i: 0 };
    renderAtPop();
  }
  function renderAtPop() {
    let pop = $('#at-pop');
    if (!pop) {
      pop = document.createElement('div'); pop.id = 'at-pop'; pop.className = 'at-pop'; document.body.append(pop);
      pop.addEventListener('mousedown', e => { const b = e.target.closest('[data-at]'); if (b) { e.preventDefault(); atChoose(+b.dataset.at); } });
    }
    pop.innerHTML = atPick.items.map((n, i) => { const a = S.byName[n]; return '<button data-at="' + i + '" class="' + (i === atPick.i ? 'on' : '') + '" style="--c:' + esc(a ? a.color : '#a78bfa') + '"><i></i>@' + esc(n) + '</button>'; }).join('');
    const r = $('#input').getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(window.innerWidth - pop.offsetWidth - 8, r.left)) + 'px';
    pop.style.top = Math.max(4, r.top - pop.offsetHeight - 6) + 'px';
  }
  function atChoose(i) {
    if (!atPick) return;
    const inp = $('#input'), n = atPick.items[i];
    inp.value = inp.value.slice(0, atPick.start) + '@' + n + ' ' + inp.value.slice(atPick.end);
    const caret = atPick.start + n.length + 2;
    atClose(); sfx('mention');
    inp.setSelectionRange(caret, caret); inp.focus(); autosize(); saveDraft();
  }
  function atClose() { atPick = null; const p = $('#at-pop'); if (p) p.remove(); }
  $('#input').addEventListener('input', atCheck);
  $('#input').addEventListener('blur', () => setTimeout(atClose, 150));
  $('#input').addEventListener('keydown', e => {   // small detail: Up in an empty box brings back the last message Storm sent in this chat
    // groky r101: like a terminal, Up again (while the recalled text is untouched) steps to older messages and Down to newer ones; Down past the newest empties the box.
    // Arrow keys still move the caret inside a multi-line recall until it reaches the first or last line. No CSS, no motion.
    if ((e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || atPick || e.isComposing || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target, v = t.value, ch = activeChat();
    const h = sentHist && sentHist.chat === ch && sentHist.text === v ? sentHist : null;
    if (v && !h) { sentHist = null; return; }
    if (!v && e.key === 'ArrowDown') return;
    if (h && e.key === 'ArrowUp' && v.lastIndexOf('\n', t.selectionStart - 1) !== -1) return;
    if (h && e.key === 'ArrowDown' && v.indexOf('\n', t.selectionEnd) !== -1) return;
    const mine = ch.messages.filter(x => x.who === 'Storm' && x.text).map(x => x.text).filter((x, i, l) => i === 0 || x !== l[i - 1]).reverse();
    if (!mine.length) return;
    let i = h ? h.i + (e.key === 'ArrowUp' ? 1 : -1) : 0;
    if (i >= mine.length) { e.preventDefault(); return; }
    e.preventDefault();
    if (i < 0) { sentHist = null; t.value = ''; autosize(); return; }
    t.value = mine[i]; autosize(); t.setSelectionRange(mine[i].length, mine[i].length);
    sentHist = { chat: ch, i, text: mine[i] };
  });
  let sentHist = null;   // groky r101
  $('#input').addEventListener('keydown', e => {   // runs before Enter-to-send while the list is open
    if (!atPick) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); e.stopImmediatePropagation(); atPick.i = (atPick.i + (e.key === 'ArrowDown' ? 1 : atPick.items.length - 1)) % atPick.items.length; renderAtPop(); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopImmediatePropagation(); atChoose(atPick.i); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); atClose(); }
  }, true);
  function saveDraft() { try { const v = $('#input').value; if (v.trim()) localStorage.setItem(DRAFT_KEY, v); else localStorage.removeItem(DRAFT_KEY); } catch (e) { } }
  // groky r94: per-chat drafts. Leaving a chat parks the box text under that chat; opening a chat brings back its own text (or an empty box).
  // groky r95: which chats have unsent text parked by swapChatDraft (cached; cleared on every swap)
  let draftCache = null;
  function hasDraft(id) {
    if (!draftCache) { try { draftCache = JSON.parse(localStorage.getItem('squall.drafts') || '{}') || {}; } catch (e) { draftCache = {}; } }
    return id !== S.active && typeof draftCache[id] === 'string' && !!draftCache[id].trim();
  }
  function swapChatDraft(from, to) {
    draftCache = null; renderTeamSoon();
    if (S.selftest || voiceOn) return;   // never while dictating: the words keep going into the box they started in
    try {
      const K = 'squall.drafts', inp = $('#input'); let m = {}; try { m = JSON.parse(localStorage.getItem(K) || '{}') || {}; } catch (e) { m = {}; }
      if (inp.value.trim()) m[from] = inp.value; else delete m[from];
      const next = typeof m[to] === 'string' ? m[to] : ''; delete m[to];
      localStorage.setItem(K, JSON.stringify(m));
      inp.value = next; autosize(); saveDraft(); try { inp.setSelectionRange(next.length, next.length); } catch (e) { }
    } catch (e) { }
  }
  function clearDraft() { try { localStorage.removeItem(DRAFT_KEY); } catch (e) { } }
  function restoreDraft() { try { const d = localStorage.getItem(DRAFT_KEY); if (d && !$('#input').value) { $('#input').value = d; autosize(); } } catch (e) { } }
  $('#input').addEventListener('input', saveDraft);
  $('#input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  $('#send').addEventListener('click', send);
  $('#stop').addEventListener('click', stopAll);
  // Stop all is Chief's (Storm, 19 Oct: "the stop all button [is] for the chief, not a button for me"): the stop_all action, no brand button
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeModal(); closeLightbox(); closeTimerDial(); closeModelMenu(); } });
  // A message's text from its button's reference: "m:<id>" for Squall's own messages, "e:<key>" for a live session's entries.
  function messageTextOf(ref) {
    const id = String(ref || '').slice(2);
    if (String(ref)[0] === 'm') { const m = activeChat().messages.find(x => x.id === id); return m ? String(m.text || '') : ''; }
    const mi = mirrorFor(activeChat()), e = mi && mi.entries.find(x => x.k === id);
    let text = e ? String(e.text || '') : '';
    if (e && e.role === 'peer' && APP_NAME_RX.test(e.from || '')) text = stripBotOnly(text.replace(VIA_RX, '').replace(/\n\nHe[’']s watching this session live[\s\S]*$/, '')).replace(IMG_LINE_RX, '').replace(FILE_LINE_RX, '').trim();
    return text;
  }
  // Copy a message's text (the copy button shows on hover).
  function copyMessage(btn) {
    const text = messageTextOf(btn.dataset.copy);
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      btn.innerHTML = ICON.check; btn.classList.add('done'); sfx('copy');
      setTimeout(() => { btn.innerHTML = ICON.copy; btn.classList.remove('done'); }, 1200);
    }).catch(() => {});
  }

  // Reply to a message (the arrow beside copy): its opening lines go into the box as a > quote, with the cursor under it.
  const QUOTE_MAX = 320;
  function quoteText(raw) {
    let text = String(raw || '').replace(/```[\s\S]*?(```|$)/g, '[code]').split('\n').map(l => MD.stripMd(l.replace(/^\s*(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, ''))).filter(l => l.trim()).join('\n').trim();
    if (text.length > QUOTE_MAX) text = text.slice(0, QUOTE_MAX).replace(/\s+\S*$/, '') + '…';
    return text ? text.split('\n').slice(0, 6).map(l => '> ' + l).join('\n') + '\n\n' : '';
  }
  function quoteMessage(btn) {
    const inp = $('#input'), q = quoteText(messageTextOf(btn.dataset.quote));
    if (!q || inp.disabled) return;
    const cur = inp.value;
    inp.value = (cur.trim() ? cur.replace(/\s*$/, '') + '\n\n' : '') + q;
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length);
    btn.innerHTML = ICON.check; btn.classList.add('done'); sfx('copy');
    setTimeout(() => { btn.innerHTML = ICON.reply; btn.classList.remove('done'); }, 1200);
  }

  // ---------- Ctrl+F: find words in the open chat or note. Matches are painted with the CSS highlight API, so the chat's own HTML
  // never changes and re-renders carry on as usual. Enter steps to older matches (you start at the newest), Shift+Enter to newer ones ----------
  const FIND = { q: '', hits: [], i: -1, view: '', timer: 0 };
  const findOpen = () => !$('#find').classList.contains('hidden');
  function openFind() {
    const bar = $('#find'), q = $('#find-q');
    const sel = String(getSelection() || '').trim();
    if (sel && sel.length <= 80 && sel.indexOf('\n') < 0) q.value = sel;
    if (bar.classList.contains('hidden')) { bar.classList.remove('hidden'); sfx('open'); }
    q.focus(); q.select();
    findRun(false, true);
  }
  function closeFind() {
    if (!findOpen()) return;
    $('#find').classList.add('hidden');
    FIND.q = ''; FIND.hits = []; FIND.i = -1;
    if (window.CSS && CSS.highlights) { CSS.highlights.delete('find'); CSS.highlights.delete('find-cur'); }
    if (!$('#input').disabled) $('#input').focus();
  }
  // a folded team message or a long reply that holds the words opens up, so the match can be seen
  function findUnfold(s) {
    const c = activeChat();
    if (!c || S.noteView || S.sessView || mirrorFor(c)) return false;
    let changed = false;
    for (const m of c.messages) {
      if (m.kind !== 'agent' || String(m.text || '').toLowerCase().indexOf(s) < 0) continue;
      let ch = false;
      if (c.kind !== 'dm' && m.who !== c.lead && !m.expanded) { m.expanded = true; ch = true; }
      if (String(m.text || '').length > 1400 && !m.showAll) { m.showAll = true; ch = true; }
      if (ch) { msgCache.delete(m); changed = true; }
    }
    return changed;
  }
  function findRun(keepPlace, scroll) {
    const s = $('#find-q').value.trim().toLowerCase(), box = $('#chat');
    const moved = box.dataset.view !== FIND.view;
    if (s && (s !== FIND.q || moved) && findUnfold(s)) renderChat();
    FIND.view = box.dataset.view || '';
    if (s !== FIND.q || moved) keepPlace = false;
    FIND.q = s;
    const hits = [];
    if (s) {
      const walk = document.createTreeWalker(box, NodeFilter.SHOW_TEXT, { acceptNode: n => n.parentElement && n.parentElement.closest('button, .when, .tagpill, script, style') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
      for (let n = walk.nextNode(); n && hits.length < 999; n = walk.nextNode()) {
        const t = n.nodeValue.toLowerCase();
        let at = t.indexOf(s);
        if (at < 0 || (n.parentElement.checkVisibility && !n.parentElement.checkVisibility())) continue;
        for (; at >= 0 && hits.length < 999; at = t.indexOf(s, at + s.length)) { const r = document.createRange(); r.setStart(n, at); r.setEnd(n, at + s.length); hits.push(r); }
      }
    }
    FIND.hits = hits;
    if (!hits.length) FIND.i = -1;
    else if (keepPlace && FIND.i >= 0) FIND.i = Math.min(FIND.i, hits.length - 1);
    else {
      // start at the newest match that's in view or above it (the bottom of the chat is where Storm usually is)
      const bottom = box.getBoundingClientRect().bottom;
      let pick = 0;
      for (let i = 0; i < hits.length; i++) if (hits[i].getBoundingClientRect().top < bottom) pick = i;
      FIND.i = pick;
    }
    findPaint(scroll && !keepPlace);
  }
  function findPaint(scroll) {
    const H = window.CSS && CSS.highlights, cur = FIND.hits[FIND.i];
    if (H && typeof Highlight === 'function') {
      if (FIND.hits.length) H.set('find', new Highlight(...FIND.hits)); else H.delete('find');
      if (cur) H.set('find-cur', new Highlight(cur)); else H.delete('find-cur');
    }
    $('#find-n').textContent = !FIND.q ? '' : FIND.hits.length ? (FIND.i + 1) + ' of ' + FIND.hits.length : 'No matches';
    $('#find').classList.toggle('none', !!FIND.q && !FIND.hits.length);
    if (scroll && cur) {
      const box = $('#chat'), r = cur.getBoundingClientRect(), b = box.getBoundingClientRect();
      if (r.top < b.top + 50 || r.bottom > b.bottom - 50) box.scrollTo({ top: box.scrollTop + (r.top - b.top) - box.clientHeight / 2, behavior: 'smooth' });
    }
  }
  function findStep(d) {
    if (!FIND.hits.length) return;
    FIND.i = (FIND.i + d + FIND.hits.length) % FIND.hits.length;
    findPaint(true);
    sfx('tick');
  }
  $('#find-q').addEventListener('input', () => findRun(false, true));
  $('#find-q').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); findStep(e.shiftKey ? 1 : -1); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFind(); }
  });
  $('#find').addEventListener('click', e => { const b = e.target.closest('[data-find]'); if (!b) return; if (b.dataset.find === 'close') closeFind(); else findStep(b.dataset.find === 'next' ? 1 : -1); });
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); openFind(); }
  });
  // the chat redraws as replies stream in or Storm switches chats: find again (a moment later, once), keeping the current match
  new MutationObserver(() => {
    if (!findOpen() || !FIND.q) return;
    clearTimeout(FIND.timer);
    FIND.timer = setTimeout(() => findRun(true, false), 150);
  }).observe($('#chat'), { childList: true, subtree: true, characterData: true });

  // The strip rail's hover name (Chief, 19 Oct: the native tooltip was slow and easy to miss): at once, a small flyout to the right of the
  // avatar with the name, and what it's doing while it works. It is fixed to the window (so the rail's overflow can't clip it), shows only in the
  // narrow strip rail (the wide rail already writes the names), and gives way to the full hover card, which shows a moment later
  let railTipEl = null;
  function railTipShow(m) {
    const body = document.body;
    if (!body.classList.contains('strip') || body.classList.contains('rail-wide')) return;
    const a = S.byName[String(m.dataset.chat || '').slice(3)];
    const av = m.querySelector('.avatar');
    if (!a || !av) return;
    railTipHide();
    let tip = $('#rail-tip');
    if (!tip) { tip = document.createElement('div'); tip.id = 'rail-tip'; tip.className = 'rail-tip'; document.body.append(tip); }
    const doing = agentBusy(a) ? String(a.activity || 'Working').replace(/\s+/g, ' ').trim() : '';
    tip.style.setProperty('--c', a.color);
    tip.innerHTML = '<i></i><b>' + esc(a.name) + '</b>' + (doing ? '<small>' + esc(doing) + '</small>' : '');
    tip.classList.add('show');   // laid out now, so its size can be measured
    const r = av.getBoundingClientRect();
    tip.style.left = Math.max(8, Math.min(window.innerWidth - tip.offsetWidth - 8, r.right + 8)) + 'px';
    tip.style.top = Math.max(8, Math.min(window.innerHeight - tip.offsetHeight - 8, r.top + r.height / 2 - tip.offsetHeight / 2)) + 'px';
    railTipEl = m;
    if (m.title) { m.dataset.railTitle = m.title; m.removeAttribute('title'); }   // no second, native tooltip on top of it
  }
  function railTipHide() {
    const tip = $('#rail-tip');
    if (tip) tip.classList.remove('show');
    if (railTipEl) { if (railTipEl.dataset.railTitle) { railTipEl.title = railTipEl.dataset.railTitle; delete railTipEl.dataset.railTitle; } railTipEl = null; }
  }
  $('#agents').addEventListener('mouseover', e => { const m = e.target.closest('.member[data-chat^="dm:"]'); if (m && m !== railTipEl) railTipShow(m); });
  $('#agents').addEventListener('mouseout', e => { const m = e.target.closest('.member[data-chat^="dm:"]'); if (m && !m.contains(e.relatedTarget)) railTipHide(); });
  $('#agents').addEventListener('click', railTipHide);
  $('#agents').addEventListener('scroll', railTipHide, true);   // scroll doesn't bubble: captured, so the flyout never hangs where the rail scrolled from

  // Hovering a teammate's icon shows a card: status, what it's doing, whether its real session is here, its model.
  let cardTimer = 0, cardFor = '';
  function showCard(name, el) {
    const a = S.byName[name];
    if (!a) return;
    { const rt = $('#rail-tip'); if (rt) rt.classList.remove('show'); }   // the card has the name and more (the tooltip text comes back when the pointer leaves)
    cardFor = name;
    let card = $('#hovercard');
    if (!card) { card = document.createElement('div'); card.id = 'hovercard'; card.className = 'hovercard'; document.body.append(card); }
    card.innerHTML = cardHTML(a);
    const r = el.getBoundingClientRect(), side = $('#team').getBoundingClientRect();
    card.style.left = (side.right + 10) + 'px';
    card.style.top = Math.max(10, Math.min(window.innerHeight - card.offsetHeight - 10, r.top + r.height / 2 - card.offsetHeight / 2)) + 'px';
    card.classList.add('show');
  }
  function hideCard() { clearTimeout(cardTimer); cardFor = ''; const c = $('#hovercard'); if (c) c.classList.remove('show'); }
  function cardHTML(a) {
    const mi = S.liveMode ? S.mirror[a.name] : null, p = S.liveMode && S.link.status === 'on' ? peerFor(a.name) : null;
    const busy = agentBusy(a), needs = mi && mirrorNeedsYou(mi);
    const pill = needs ? '<span class="st-pill ask"><i></i>Needs you</span>' : busy ? '<span class="st-pill on"><i></i>Working</span>' : a.status === 'error' ? '<span class="st-pill err"><i></i>Error</span>' : '<span class="st-pill"><i></i>Idle</span>';
    const doing = mi ? mirrorActivity(mi) : (a.activity || 'Ready');
    const where = mi ? 'Real session on this PC · you can watch it live' : p && p.status !== 'offline' ? 'Real session on this PC' : p ? 'Real session offline · a stand-in answers' : S.liveMode ? 'Not running on this PC · a stand-in answers' : 'Local agent';
    const dm = chatById('dm:' + a.name);
    return '<div class="hc-top" style="--c:' + esc(a.color) + '">' + avatar(a.name, a.color) + '<div><div class="hc-name">' + esc(a.name) + pill + '</div><div class="hc-role">' + esc(a.lead ? 'Leads the team' : 'Generalist') + '</div></div></div>' +
      '<div class="hc-row"><span>Doing</span><b>' + esc(doing) + '</b></div>' +
      '<div class="hc-row"><span>Where</span><b>' + esc(where) + '</b></div>' +
      (a.model ? '<div class="hc-row"><span>Model</span><b>' + esc(prettyModel(a.model)) + '</b></div>' : '') +
      (dm && dm.unread ? '<div class="hc-row"><span>Unread</span><b>' + dm.unread + '</b></div>' : '') +
      '<div class="hc-hint">Click to open the chat</div>';
  }
  $('#agents').addEventListener('mouseover', e => {
    const m = e.target.closest('.member[data-chat^="dm:"]');
    if (!m) return;
    const name = m.dataset.chat.slice(3);
    if (cardFor === name) return;
    clearTimeout(cardTimer);
    cardTimer = setTimeout(() => showCard(name, m), 380);
  });
  $('#agents').addEventListener('mouseout', e => {
    const m = e.target.closest('.member[data-chat^="dm:"]');
    if (m && !m.contains(e.relatedTarget)) hideCard();
  });
  $('#agents').addEventListener('click', hideCard);

  // Full-size view of an image the session looked at; click anywhere or Esc to close.
  // groky r90: when the message, note or image strip holds more than one image, Left/Right arrows and two quiet side
  // buttons step through them in place, with a small "2 of 4" count; a single image behaves exactly as before.
  let lbSet = null, lbIdx = 0;
  // groky r91: zoom and pan in the image viewer. Scrolling zooms around the pointer (up to 6x), dragging pans while
  // zoomed, double-click toggles 2.5x and back, 0 resets. Clicking the image no longer closes it; the backdrop and Esc do.
  const lbZ = { s: 1, x: 0, y: 0, drag: null, moved: false };
  function lbZClamp(img) {
    const mx = (lbZ.s - 1) * img.offsetWidth / 2, my = (lbZ.s - 1) * img.offsetHeight / 2;
    lbZ.x = Math.max(-mx, Math.min(mx, lbZ.x)); lbZ.y = Math.max(-my, Math.min(my, lbZ.y));
  }
  function lbZApply(img) {
    if (!img) return;
    const on = lbZ.s > 1;
    img.style.translate = on ? lbZ.x.toFixed(1) + 'px ' + lbZ.y.toFixed(1) + 'px' : '';
    img.style.scale = on ? lbZ.s.toFixed(3) : '';
    const box = img.closest('.lightbox'); if (!box) return;
    box.classList.toggle('lb-zoomed', on);
    let tag = box.querySelector('.lb-zoomtag');
    if (on) { if (!tag) { tag = document.createElement('div'); tag.className = 'lb-zoomtag'; box.append(tag); } tag.textContent = Math.round(lbZ.s * 100) + '%'; }
    else if (tag) tag.remove();
  }
  function lbZReset(img) { lbZ.s = 1; lbZ.x = 0; lbZ.y = 0; lbZ.drag = null; lbZApply(img || document.querySelector('.lightbox img')); }
  function lbZTo(img, s, cx, cy) {
    s = Math.min(6, Math.max(1, s));
    if (s <= 1.02) { lbZReset(img); return; }
    const br = img.closest('.lightbox').getBoundingClientRect();
    const c0x = br.left + img.offsetLeft + img.offsetWidth / 2, c0y = br.top + img.offsetTop + img.offsetHeight / 2;
    const px = (cx - c0x - lbZ.x) / lbZ.s, py = (cy - c0y - lbZ.y) / lbZ.s;
    lbZ.x = cx - c0x - s * px; lbZ.y = cy - c0y - s * py; lbZ.s = s;
    lbZClamp(img); lbZApply(img);
  }
  document.addEventListener('wheel', e => {
    const box = e.target.closest && e.target.closest('.lightbox'); if (!box) return;
    const img = box.querySelector('img'); if (!img) return;
    e.preventDefault();
    lbZTo(img, lbZ.s * Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0018)), e.clientX, e.clientY);
  }, { passive: false });
  document.addEventListener('dblclick', e => {
    const img = e.target.closest && e.target.closest('.lightbox img'); if (!img) return;
    e.preventDefault();
    if (lbZ.s > 1) lbZReset(img); else lbZTo(img, 2.5, e.clientX, e.clientY);
  });
  document.addEventListener('pointerdown', e => {
    if (!e.target.closest || !e.target.closest('.lightbox')) return;
    lbZ.moved = false;
    const img = e.target.closest('.lightbox img');
    if (!img || lbZ.s <= 1 || e.button !== 0) return;
    e.preventDefault();
    lbZ.drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, x: lbZ.x, y: lbZ.y };
    try { img.setPointerCapture(e.pointerId); } catch (_) {}
    img.closest('.lightbox').classList.add('lb-drag');
  });
  document.addEventListener('pointermove', e => {
    const g = lbZ.drag; if (!g || e.pointerId !== g.id) return;
    const img = document.querySelector('.lightbox img'); if (!img) { lbZ.drag = null; return; }
    const dx = e.clientX - g.sx, dy = e.clientY - g.sy;
    if (Math.abs(dx) + Math.abs(dy) > 4) lbZ.moved = true;
    lbZ.x = g.x + dx; lbZ.y = g.y + dy; lbZClamp(img); lbZApply(img);
  });
  const lbZEnd = e => { if (!lbZ.drag || e.pointerId !== lbZ.drag.id) return; lbZ.drag = null; const b = document.querySelector('.lightbox'); if (b) b.classList.remove('lb-drag'); };
  document.addEventListener('pointerup', lbZEnd);
  document.addEventListener('pointercancel', lbZEnd);
  document.addEventListener('keydown', e => {
    if (e.key !== '0' || lbZ.s <= 1 || !document.querySelector('.lightbox')) return;
    e.preventDefault(); lbZReset();
  }, true);
  function openLightbox(src, cap, from) {
    closeLightbox();
    const box = document.createElement('div');
    box.className = 'lightbox';
    const scope = from && from.closest ? (from.closest('.msg, .note-view, .shots, #live-body') || from.parentElement) : null;
    if (scope) {
      const seen = new Set(), list = [];
      scope.querySelectorAll('[data-shot]').forEach(el => { const s = el.dataset.shot; if (!s || seen.has(s)) return; seen.add(s); list.push({ src: s, cap: el.dataset.cap || '' }); });
      const i = list.findIndex(x => x.src === src);
      if (list.length > 1 && i >= 0) { lbSet = list; lbIdx = i; }
    }
    box.innerHTML = '<img src="' + esc(src) + '" alt=""><div class="lb-cap">' + esc(cap || '') + '</div>' + (lbSet
      ? '<div class="lb-count">' + (lbIdx + 1) + ' of ' + lbSet.length + '</div>' +
        '<button class="lb-nav lb-prev" data-lbstep="-1" title="Previous image (Left arrow)" aria-label="Previous image"></button>' +
        '<button class="lb-nav lb-next" data-lbstep="1" title="Next image (Right arrow)" aria-label="Next image"></button>'
      : '');
    if (lbSet) box.classList.add('lb-multi');
    document.body.append(box);
  }
  function lbStep(dir) {
    const box = document.querySelector('.lightbox');
    if (!box || !lbSet) return;
    lbIdx = (lbIdx + dir + lbSet.length) % lbSet.length;
    const it = lbSet[lbIdx], img = box.querySelector('img'), cap = box.querySelector('.lb-cap'), n = box.querySelector('.lb-count');
    if (img) img.src = it.src; lbZReset(img);
    if (cap) cap.textContent = it.cap;
    if (n) n.textContent = (lbIdx + 1) + ' of ' + lbSet.length;
  }
  function closeLightbox() { lbSet = null; lbZ.s = 1; lbZ.x = 0; lbZ.y = 0; lbZ.drag = null; document.querySelectorAll('.lightbox').forEach(x => x.remove()); }
  document.addEventListener('keydown', e => {
    if (!lbSet || (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') || !document.querySelector('.lightbox')) return;
    e.preventDefault(); e.stopImmediatePropagation(); lbStep(e.key === 'ArrowRight' ? 1 : -1);
  }, true);
  Bridge.on('closing', () => { saveNow().finally(() => Bridge.call('closeReady').catch(() => {})); });
  // a page-only update was copied in (no restart): save, then reload into the new page; the "Squall updated" card shows after
  Bridge.on('reloadForUpdate', () => { saveNow().finally(() => location.reload()); });

  async function checkAuth() {
    if (S.mock) { S.signedIn = true; renderBanner(); return; }
    try { const st = await Bridge.call('authStatus'); S.signedIn = !!st.loggedIn; }
    catch (e) { S.signedIn = false; }
    renderBanner();
    if (S.signedIn && S.liveMode && S.link.status === 'off') startLink();
  }

  // ---------- self-test (demo mode only) ----------
  async function waitFor(fn, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (fn()) return true; await sleep(100); }
    throw new Error('timed out waiting');
  }
  // Timer probe (a diagnostic run, --timer-probe): how often a 2 s interval and a 1 s timeout chain fire while the window is
  // minimized. Long gaps mean the page's timers are throttled while hidden, which would stop the work timer's watch.
  async function timerProbe() {
    const R = { checks: [], errors: [], ok: true };
    const minutes = 7, t0 = Date.now();
    const iv = [], chain = [];
    let last = t0;
    const timerId = setInterval(() => { const t = Date.now(); iv.push(t - last); last = t; }, 2000);
    await new Promise(resolve => {
      const step = () => { chain.push(Date.now()); if (Date.now() - t0 < minutes * 60000) setTimeout(step, 1000); else resolve(); };
      setTimeout(step, 1000);
    });
    clearInterval(timerId);
    const stats = arr => { const s = arr.slice().sort((x, y) => x - y); return { n: arr.length, median: s.length ? s[Math.floor(s.length / 2)] : 0, max: s.length ? s[s.length - 1] : 0, over10s: arr.filter(g => g > 10000).length, over60s: arr.filter(g => g > 60000).length }; };
    R.checks.push({ name: 'probe: 2 s interval, minimized', ok: true, info: JSON.stringify(stats(iv.slice(1))) });
    R.checks.push({ name: 'probe: 1 s timeout chain, minimized', ok: true, info: JSON.stringify(stats(chain.slice(1).map((t, i) => t - chain[i]))) });
    R.checks.push({ name: 'probe: minutes measured', ok: true, info: String(Math.round((Date.now() - t0) / 1000)) + ' s' });
    await Bridge.call('selftestDone', R);
  }

  async function selfTest() {
    const R = { checks: [], errors: [] };
    const ok = (name, pass, info) => R.checks.push({ name, ok: !!pass, info: info == null ? null : String(info) });
    const idle = () => Object.keys(S.flows).length === 0;
    const say = async text => { $('#input').value = text; send(); await sleep(50); await waitFor(idle, 60000).catch(() => { throw new Error('timed out waiting for replies; still running: ' + Object.keys(S.flows).join(', ') + ' · relay jobs: ' + Object.keys(S.link.jobs || {}).length); }); };
    const sawClass = async (sel, rx, ms) => { try { await waitFor(() => Array.from(document.querySelectorAll(sel)).some(el => rx.test(el.className)), ms); return true; } catch (e) { return false; } };
    try {
      ok('team loaded', S.agents.length >= 3, S.agents.map(a => a.name).join(', '));
      {   // first (Storm, 20 Oct: "No relay. Direct messages. Now."): a message to a teammate with a Claude session runs that very session
          // through Squall's own run, from the session's folder, and nothing goes to the relay. Logged at once, so it can be read early
        const bot = S.agents.find(a => !a.lead) || S.lead;
        const dmc = chatById('dm:' + bot.name) || { id: 'dm:' + bot.name, kind: 'dm', name: bot.name, members: [bot.name], messages: [] };
        const realCall = Bridge.call, calls = [];
        Bridge.call = (cmd, args) => { calls.push({ cmd, args }); return realCall(cmd, args); };
        const keep = S.mirror[bot.name], sid = '12345678-1234-1234-1234-123456789abc';
        S.forceDirect = true;
        S.mirror[bot.name] = { entries: [], session: { transcript: 'C:\\nowhere\\' + sid + '.jsonl', cwd: 'C:\\', title: bot.name, exists: true }, loading: false, pending: [], status: { working: false } };
        let sent = false, err = '';
        try { sent = sendToMirror(dmc, 'direct test', [], []); } catch (e) { err = e.message; }
        await waitFor(() => calls.some(c => c.cmd === 'run'), 20000).catch(() => {});
        const run = calls.find(c => c.cmd === 'run');
        const viewOk = directView(run ? run.args.prompt : '').text === 'direct test';
        ok('direct: a message to a teammate runs its own session from its folder, never the relay', sent && !!run && run.args.cwd === 'C:\\' && run.args.sessionId === sid && viewOk && !calls.some(c => /^bridge/.test(c.cmd)),
          err || (run ? 'cwd ' + run.args.cwd + ', session ' + run.args.sessionId + ', view ' + viewOk + ', relay calls ' + calls.filter(c => /^bridge/.test(c.cmd)).length : 'no run started'));
        await waitFor(() => !isWorking(S.byName[bot.name]), 60000).catch(() => {});
        Bridge.call = realCall; S.forceDirect = false;
        if (keep) S.mirror[bot.name] = keep; else delete S.mirror[bot.name];
        const last = R.checks[R.checks.length - 1];
        Bridge.call('log', { level: 'selftest', msg: 'direct check: ' + (last.ok ? 'PASS' : 'FAIL') + ' (' + (last.info || '') + ')' }).catch(() => {});
      }
      {   // bot pictures: a picture a bot reads is a JPEG thumbnail on its turn, with the file it read (no server or model needed)
        const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
        const fake = { name: 'picture check', turns: [{ text: '', tools: [{ id: 'pic1', name: 'Read', status: 'running', input: { file_path: 'C:\\shots\\a.png' } }], images: [] }] };
        onToolResults(fake, { content: [{ type: 'tool_result', tool_use_id: 'pic1', is_error: false, content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }] }] });
        await Promise.all(fake.imgPending || []);
        const im = (fake.turns[0].images || [])[0];
        ok('bot pictures: a picture a bot reads is shown on its turn as a JPEG thumbnail, with its file', fake.turns[0].tools[0].status === 'ok' && !!im && /^data:image\/jpeg;base64,/.test(im.url) && im.path === 'C:\\shots\\a.png', im ? im.path : 'no thumbnail');
      }
      ok('the + tile adds a teammate and the voice button is on the page', !!document.querySelector('[data-act="newteammate"]') && !!$('#voice'), '');
      await Bridge.call('capture', { name: '0-plus-and-voice' });
      ok('the + Teammate tile is labelled Teammate', ((document.querySelector('[data-act="newteammate"] .mname') || {}).textContent || '') === 'Teammate', '');
      document.querySelector('[data-act="newteammate"]').click(); await sleep(150);
      ok('the + Teammate tile opens the add-a-teammate form', !!$('#at-name'), '');
      { const sb = document.querySelector('.add-modal.studio');
        ok('new teammate: a live preview shows the bot as you type', !!sb && !!sb.querySelector('.bs-av .avatar'), '');
        $('#at-name').value = 'Zed'; $('#at-name').dispatchEvent(new Event('input'));
        ok('new teammate: the preview follows the name', (sb.querySelector('.bs-name').textContent === 'Zed') && sb.querySelector('.bs-av .avatar').textContent === 'Z', sb.querySelector('.bs-name').textContent);
        $('#at-name').value = ''; $('#at-name').dispatchEvent(new Event('input'));
        sb.querySelector('[data-p="coder"]').click(); await sleep(50);
        ok('new teammate: a preset fills the role, the brief, the color and a name', $('#at-role').value === 'Coder' && /code/.test($('#at-prompt').value) && /^[A-Za-z][A-Za-z0-9]{1,19}$/.test($('#at-name').value) && sb.style.getPropertyValue('--c').trim().toUpperCase() === '#3D9BE9', $('#at-role').value + ' ' + $('#at-name').value);
        const n1 = $('#at-name').value; sb.querySelector('[data-t="dice"]').click();
        ok('new teammate: the dice suggests a free name', $('#at-name').value !== n1 && !botNameProblem($('#at-name').value), $('#at-name').value);
        $('#at-name').value = S.agents[0].name; $('#at-name').dispatchEvent(new Event('input'));
        ok('new teammate: a taken name is caught before sending', sb.querySelector('[data-t="add"]').classList.contains('off') && /already/.test($('#at-status').textContent), $('#at-status').textContent);
        $('#at-name').value = 'Zed'; $('#at-name').dispatchEvent(new Event('input'));
        await Bridge.call('capture', { name: '0-new-teammate-studio' }); }
      { const av = document.querySelector('.member:not(.add) .avatar:not(.gicon)'), cs = av ? getComputedStyle(av) : null;
        ok('bots look richer: avatars have a glass dome over their color and a status ring', !!cs && /radial-gradient/.test(cs.backgroundImage) && getComputedStyle(av, '::after').content !== 'none', cs ? cs.backgroundImage.slice(0, 60) : 'no avatar'); }
      closeModal(); await sleep(100);
      openSettings(); await sleep(150);
      $('#input').value = 'draft kept over a restart'; $('#input').dispatchEvent(new Event('input'));
      let draftSaved = null; try { draftSaved = localStorage.getItem('squall.draft'); } catch (e) { }
      ok('the message box keeps an unsent draft for after a restart', draftSaved === 'draft kept over a restart', String(draftSaved));
      $('#input').value = ''; $('#input').dispatchEvent(new Event('input'));
      let draftGone = 'x'; try { draftGone = localStorage.getItem('squall.draft'); } catch (e) { }
      ok('an emptied box leaves no draft behind', draftGone === null, String(draftGone));
      { const qh = buildMessageHTML({ id: 'queued-check', kind: 'user', text: 'queued check', time: now(), queued: true });
        ok('a message sent while a reply is being written shows as queued, with a × to drop it', /queued/.test(qh) && /data-dropq="queued-check"/.test(qh), qh.slice(0, 120)); }
      ok('Settings has no add-a-teammate row any more', !document.querySelector('[data-s="addteam"]'), '');
      closeModal(); await sleep(100);
      const crew = S.agents.filter(a => !a.lead);
      const A = crew[0].name, B = crew[1].name, Z = crew[crew.length - 1].name;
      const team = chatById('team');
      const t = parseTasks('plan\n```tempest\n{"tasks":[{"to":"' + A + '","task":"a"},{"to":"Nobody","task":"b"},{"to":"' + A.toLowerCase() + '","task":"c"}]}\n```', team);
      ok('parse tasks (merge, skip unknown)', t.length === 1 && t[0].to === A && /Also: c/.test(t[0].task), JSON.stringify(t));
      ok('mentions only match chat members', JSON.stringify(mentionsIn('hey @' + A + ' and @nobody, @' + B, team, B)) === JSON.stringify([A]));
      try { await Bridge.call('teamAdd', { name: '!' }); ok('add a teammate rejects a bad name', false); }
      catch (e) { ok('add a teammate rejects a bad name', /short name/.test(e.message), e.message); }
      const goalCheck = goalOf('/goal fix the leaderboard'), doneCheck = goalOf('/goal done');
      ok('/goal starts a goal, /goal done ends it', !!goalCheck && goalCheck.kind === 'start' && !!doneCheck && doneCheck.kind === 'done' && goalOf('hello') === null, JSON.stringify([goalCheck && goalCheck.kind, doneCheck && doneCheck.kind]));
      const hl = MD.highlight('lua', 'local score = 10 -- top 10\nprint("hi")');
      ok('code blocks get colors', /tk-kw">local/.test(hl) && /tk-cm">-- top 10/.test(hl) && /tk-st">&quot;hi&quot;/.test(hl) && /tk-nu">10/.test(hl) && /tk-fn">print/.test(hl), hl);
      await Bridge.call('capture', { name: '1-start' });

      const looks = new Set();
      for (const sh of Array.from(document.styleSheets)) {
        let rules = [];
        try { rules = Array.from(sh.cssRules || []); } catch (e) { }
        for (const r of rules) (String(r.selectorText || '').match(/\.anim-[wm]\d+/g) || []).forEach(x => looks.add(x));
      }
      const allLooks = ['w', 'm'].every(k => { for (let i = 1; i <= ANIMS; i++) if (!looks.has('.anim-' + k + i)) return false; return true; });
      ok('icons: ' + ANIMS + ' working + ' + ANIMS + ' messaging animations exist (Storm: 4x the animations)', allLooks && looks.size === ANIMS * 2, looks.size + ' looks');

      openChat('team');
      const teamRun = say('Plan a Roblox leaderboard for my game');
      const sawWork = await sawClass('#agents .member:not(.group) .av-wrap', /\banim-(w\d+|orbit)\b/, 20000);
      if (sawWork) await Bridge.call('capture', { name: '2a-working-animation' });
      const sawMsg = await sawClass('#agents .member:not(.group) .av-wrap', /\banim-m\d+\b/, 40000);
      if (sawMsg) await Bridge.call('capture', { name: '2b-messaging-animation' });
      await teamRun;
      ok('icons: working animation while an agent works', sawWork);
      ok('icons: messaging animation when Chief hands out work', sawMsg);
      const wrapBefore = document.querySelector('.member[data-chat="dm:' + A + '"] .av-wrap');
      renderTeam();
      ok('icons update in place, so animations keep running', !!wrapBefore && wrapBefore === document.querySelector('.member[data-chat="dm:' + A + '"] .av-wrap'));
      const leadMsgs = team.messages.filter(m => m.who === S.lead.name && m.kind === 'agent');
      ok('team chat: lead planned, then wrapped up', leadMsgs.length >= 2, leadMsgs.length);
      ok('team chat: 2 tasks assigned', team.messages.some(m => m.kind === 'event' && m.tasks && m.tasks.length === 2));
      ok('team chat: both teammates reported', team.messages.some(m => m.who === A) && team.messages.some(m => m.who === B));
      ok('team chat: tasks block hidden', !team.messages.some(m => /```tempest/.test(m.text || '')));
      ok('sessions kept per chat', !!S.sessions['team|' + S.lead.name] && !!S.sessions['team|' + A]);
      // the bug: a bot's Claude session is kept in the session map. Its second message resumes the first run's session, even after a Sessions refresh
      openChat('dm:' + A); await sleep(100);
      const dmKeyA = 'dm:' + A + '|' + A;
      await say('Remember this word for later: pineapple.');
      const firstSid = S.sessions[dmKeyA];
      ok('a bot’s Claude session is kept in the session map after its first message', typeof firstSid === 'string' && firstSid.length > 0, String(firstSid).slice(0, 24));
      setDesk(await Bridge.call('liveSessions'));
      ok('a Sessions refresh leaves the session map alone', !Array.isArray(S.sessions) && S.sessions[dmKeyA] === firstSid, Array.isArray(S.sessions) ? 'a list' : String(S.sessions[dmKeyA]).slice(0, 24));
      const realCallRun = Bridge.call, runCalls = [];
      Bridge.call = (cmd, args) => { if (cmd === 'run') runCalls.push(args); return realCallRun(cmd, args); };
      try { await say('What was the word I asked you to remember?'); } finally { Bridge.call = realCallRun; }
      const secondRun = runCalls[runCalls.length - 1] || {};
      ok('the second message to a bot resumes the first run’s session', !!firstSid && secondRun.sessionId === firstSid, 'sent ' + String(secondRun.sessionId || '(none)').slice(0, 24));
      let savedArgs = null;
      const realCallSave = Bridge.call;
      Bridge.call = (cmd, args) => { if (cmd === 'saveState') savedArgs = args; return realCallSave(cmd, args); };
      try { await saveNow(); } finally { Bridge.call = realCallSave; }
      const savedMap = JSON.parse(JSON.stringify((savedArgs && savedArgs.state && savedArgs.state.sessions) || null));
      ok('the session map survives a save and a restore (an old list starts over as {})', !!savedMap && !Array.isArray(savedMap) && savedMap[dmKeyA] === firstSid && savedSessions({ sessions: savedMap })[dmKeyA] === firstSid && Object.keys(savedSessions({ sessions: [] })).length === 0, '');
      // a session’s message wakes a local bot once (the relay’s inbound line); never a bot’s own message; the cap; a wake-up during a flow waits for it
      const wakeCalls = [];
      const realCallWake = Bridge.call;
      Bridge.call = (cmd, args) => { if (cmd === 'run') wakeCalls.push(args); return realCallWake(cmd, args); };
      const runsOf = n => wakeCalls.filter(r => r.agent === n).length;
      const inbound = (fromName, body) => onBridgeLine({ line: JSON.stringify({ type: 'user', origin: { kind: 'peer', name: fromName, body } }) });
      try {
        inbound('Laptop', '[dm:' + A + '] Please check the vault and say what changed.');
        await sleep(100); await waitFor(idle, 60000).catch(() => {});
        ok('a session’s message wakes its local bot once', runsOf(A) === 1, runsOf(A) + ' run(s)');
        // a bot whose Claude app session isn't running is woken too (before, any app session counted as live, so a roll call woke nobody)
        const sidA = S.sessions['dm:' + A + '|' + A];
        S.mirror[A] = { entries: [], session: { transcript: 'C:\\x\\00000000-0000-0000-0000-000000000000.jsonl' }, pending: [] };
        const beforeApp = runsOf(A);
        try {
          inbound('Laptop', '[dm:' + A + '] Roll call: reply with one short line.');
          await sleep(100); await waitFor(idle, 60000).catch(() => {});
        } finally { delete S.mirror[A]; if (sidA) S.sessions['dm:' + A + '|' + A] = sidA; }
        ok('a bot whose app session isn’t running is still woken by a session’s message', runsOf(A) === beforeApp + 1, (runsOf(A) - beforeApp) + ' run(s)');
        const beforeSelf = runsOf(A);
        inbound(A, '[dm:' + A + '] talking to myself');
        await sleep(100); await waitFor(idle, 60000).catch(() => {});
        ok('a bot is never woken by its own message', runsOf(A) === beforeSelf, '');
        const dmA = chatById('dm:' + A);
        inboundHits[dmA.id] = [Date.now(), Date.now(), Date.now(), Date.now(), Date.now(), Date.now()];
        const beforeCap = runsOf(A);
        inbound('Laptop', '[dm:' + A + '] again');
        await sleep(100); await waitFor(idle, 60000).catch(() => {});
        ok('wake-ups stop at the cap, with a note in the chat', runsOf(A) === beforeCap && dmA.messages.some(m => /Paused: messages from sessions/.test(m.text || '')), (runsOf(A) - beforeCap) + ' more run(s)');
        inboundHits[dmA.id] = [];
        S.flows[dmA.id] = true;
        const beforeQueue = runsOf(A);
        inbound('Laptop', '[dm:' + A + '] queued one');
        await sleep(50);
        const waiting = !!inboundWait[dmA.id] && runsOf(A) === beforeQueue;
        delete S.flows[dmA.id];
        drainWoken(dmA);
        await sleep(100); await waitFor(idle, 60000).catch(() => {});
        ok('a wake-up during a running flow waits for it, then runs once', waiting && runsOf(A) === beforeQueue + 1, (runsOf(A) - beforeQueue) + ' run(s) after');
        // a group: a session’s @mention wakes the local bot it names, and the cap stops a loop there too
        const gW = createGroup('Wake', [A, Z]);
        const beforeGroup = runsOf(A);
        inbound('Laptop', '[' + gW.id + '] @' + A + ' what do you think of the leaderboard?');
        await sleep(100); await waitFor(idle, 60000).catch(() => {});
        ok('a session’s @mention in a group wakes the local bot it names', runsOf(A) > beforeGroup, (runsOf(A) - beforeGroup) + ' run(s)');
        inboundHits[gW.id] = [Date.now(), Date.now(), Date.now(), Date.now(), Date.now(), Date.now()];
        const beforeLoop = runsOf(A);
        inbound('Laptop', '[' + gW.id + '] @' + A + ' and again');
        await sleep(100); await waitFor(idle, 60000).catch(() => {});
        ok('a mention loop stops at the cap', runsOf(A) === beforeLoop && gW.messages.some(m => /Paused: messages from sessions/.test(m.text || '')), (runsOf(A) - beforeLoop) + ' more run(s)');
        inboundHits[gW.id] = [];
      } finally { Bridge.call = realCallWake; }
      // what Squall adds for the bot only stays out of the chat (Storm: "Make it not show that it is telling the model plan usage in the Squall app")
      const botOnlyIn = 'check the build\n\nThis is your first message in Squall. Before anything else, read Obsidian: x\n\nSquall was updated since your last message:\nBuild 2026.10.19.0159: a; b\n(The full update log is workspace\\shared\\update-log.md.)\n\nPlan usage right now: 5-hour window 7%. End your reply with one short line giving this usage (session, week, and when it runs out if it will).';
      ok('bot-only notes (usage, what changed, first message) stay out of what the chat shows', stripBotOnly(botOnlyIn) === 'check the build', JSON.stringify(stripBotOnly(botOnlyIn)));
      // Storm leaving Squall: a bot mid-reply hears his words once, after that reply, and keeps going; when he's back it's asked for its report
      const dmAw = chatById('dm:' + A), awayRuns = [];
      const realAway = Bridge.call;
      Bridge.call = (cmd, args) => { if (cmd === 'run' && args.agent === A) awayRuns.push(String(args.prompt || '')); return realAway(cmd, args); };
      try {
        S.flows[dmAw.id] = true;
        const working = workingChats().some(c => c.id === dmAw.id);
        tellBots(dmAw, AWAY_NOTE, 'away');
        const heldBack = awayRuns.length === 0 && pendingNotes[dmAw.id] === AWAY_NOTE;
        delete S.flows[dmAw.id];
        drainWoken(dmAw);
        await sleep(100); await waitFor(idle, 60000).catch(() => {});
        ok('when Storm leaves, a working bot hears his words once, after the reply it was writing', working && heldBack && awayRuns.length === 1 && awayRuns[0].includes(AWAY_NOTE) && dmAw.messages.some(m => /You left Squall/.test(m.text || '')), awayRuns.length + ' run(s)');
        tellBots(dmAw, BACK_NOTE, 'back');
        await sleep(100); await waitFor(idle, 60000).catch(() => {});
        ok('when he’s back, that bot is asked for its report', awayRuns.length === 2 && awayRuns[1].includes('Storm is back'), awayRuns.length + ' run(s)');
      } finally { Bridge.call = realAway; delete pendingNotes[dmAw.id]; }
      // a chief hears about team changes (added, renamed, removed, promoted, demoted), a few seconds' worth in one notice; a local chief with its next message
      noteTeamChange('Testbot joined the team (added by Storm).'); noteTeamChange('Testbot was renamed to Newbot.', true);
      const teamNews = takeTeamNews(S.lead.name);
      ok('a chief is told about team changes, several in one notice, once', teamNews === 'Team changes in Squall since your last message: Testbot joined the team (added by Storm). Testbot was renamed to Newbot.' && !takeTeamNews(S.lead.name), teamNews);
      // Squall's "Updated to build" lines don't go to the bots as new messages (the update note covers them; a team prompt had 25)
      const vtBefore = S.vaultTold[S.lead.name], evTeam = chatById('team');
      addMessage(evTeam, { who: APP, kind: 'event', text: 'Updated to build 2026.10.19.9999 (from 2026.10.19.9998): a test line' });
      const evPrompt = buildPrompt(evTeam, S.lead.name, '', true).prompt;
      S.vaultTold[S.lead.name] = vtBefore;
      ok('Squall’s “Updated to build” lines stay out of what bots are sent', !evPrompt.includes('2026.10.19.9999'), '');
      // a live session thinking before it writes: the working row shows its newest thought (its reply only reaches the file once it's finished)
      const prev = mirrorActivity({ status: { working: true, at: new Date().toISOString() }, entries: [{ role: 'assistant', text: 'Earlier reply' }, { role: 'thought', text: 'Checking the build log before answering' }] });
      ok('a working session’s newest thought shows as Writing… in its working row', prev === 'Writing… Checking the build log before answering', prev);
      // a chief's own message to the team chat with a tasks block (not a reply in a flow): the task goes out, and the block isn't shown
      const tasksRuns = [], realTasks = Bridge.call;
      Bridge.call = (cmd, args) => { if (cmd === 'run') tasksRuns.push(args); return realTasks(cmd, args); };
      try {
        const tchat = chatById('team'), before = tchat.messages.length;
        onBridgeLine({ line: JSON.stringify({ type: 'user', origin: { kind: 'peer', name: S.lead.name, body: '[team] Splitting this up.\n```tempest\n{"tasks":[{"to":"' + A + '","task":"Check the leaderboard script"}]}\n```' } }) });
        await sleep(100); await waitFor(idle, 60000).catch(() => {});
        const shownMsg = tchat.messages.slice(before).find(m => m.who === S.lead.name && m.kind === 'agent');
        ok('a chief’s own team message hands out its tasks block, and the block isn’t shown', !!shownMsg && !/```tempest/.test(shownMsg.text) && tasksRuns.some(r => r.agent === A && /assigned you: Check the leaderboard script/.test(r.prompt || '')) && tchat.messages.slice(before).some(m => m.kind === 'event' && /assigned 1 task/.test(m.text || '')), tasksRuns.map(r => r.agent).join(', '));
      } finally { Bridge.call = realTasks; }
      clearChat(chatById('dm:' + A));   // the direct-chat checks below expect a fresh chat with A
      // vault writing per bot: every bot’s shared memory says Obsidian means EVO; "Can write to EVO" on the right-click menu saves to team.json and changes the prompt
      const promptRO = await Bridge.call('sysPrompt', { name: A });
      ok('every bot’s shared memory says EVO is the Obsidian vault', /when he says Obsidian, he means EVO/.test(promptRO), '');
      ok('a bot without the flag is read-only in EVO', /Don't edit files in the vault/.test(promptRO) && !/You may add and update notes/.test(promptRO), '');
      const menuTile = document.querySelector('.member[data-chat="dm:' + A + '"]');
      if (menuTile) menuTile.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 60, clientY: 240 }));
      await sleep(80);
      const vaultItem = document.querySelector('.bot-menu [data-botact="vault"]');
      ok('the right-click menu offers “Can write to EVO”, without a check while it’s off', !!vaultItem && !/✓/.test(vaultItem.textContent || ''), vaultItem ? vaultItem.textContent : 'no item');
      closeBotMenu();
      toggleVault(A);
      await waitFor(() => S.byName[A].vault === 'write', 10000).catch(() => {});
      const diskOn = await Bridge.call('teamFile', { name: A });
      ok('the “Can write to EVO” toggle saves to team.json', diskOn === 'write' && S.byName[A].vault === 'write', String(diskOn));
      const promptRW = await Bridge.call('sysPrompt', { name: A });
      ok('a bot that can write to EVO is taught diagrams and animations (Mermaid, Canvas, animated SVG)', /```mermaid/.test(promptRW) && /\.canvas/.test(promptRW) && /animated SVG/.test(promptRW), '');
      ok('the write flag changes the system prompt: add and update notes, never delete or move', /You may add and update notes in the vault/.test(promptRW) && /Never delete, move or rename files/.test(promptRW) && !/Don't edit files in the vault/.test(promptRW), '');
      toggleVault(A);
      await waitFor(() => !S.byName[A].vault, 10000).catch(() => {});
      const diskOff = await Bridge.call('teamFile', { name: A });
      ok('toggling again makes the bot read-only, saved to team.json', !diskOff && !S.byName[A].vault, String(diskOff));
      // sleep (Storm: "Make the bots have a very cozy sleeping animation when idle and wake up automatically and decide if it should work on
      // something or go back to sleep"): idle a few minutes = asleep with z's; a nap with nothing to do leaves no trace, a nap with work reports it
      const sb = S.byName[B], bTile = () => document.querySelector('.member[data-chat="dm:' + B + '"]');
      sb.status = 'idle'; sb.lastActive = Date.now() - SLEEP_AFTER_MS - 1000; renderTeam(); await sleep(60);
      ok('an idle teammate falls asleep, with three floating z’s and a moon', !!bTile() && bTile().classList.contains('sleeping') && bTile().querySelectorAll('.zzz i').length === 3 && !!bTile().querySelector('.moon'), bTile() ? bTile().className : 'no tile');
      openChat('dm:' + B); await sleep(60);
      ok('a sleeping teammate’s chat says it’s napping', /Napping/.test($('#chat-head').textContent) && !!document.querySelector('#chat-head .st-pill.nap'), $('#chat-head').textContent.slice(0, 90));
      let breath = ''; try { breath = getComputedStyle(bTile().querySelector('.avatar')).animationName; } catch (e) { }
      ok('the sleeping icon breathes slowly', /sleepBreath/.test(breath), breath);
      await Bridge.call('capture', { name: '2c-sleeping' });
      sb.lastActive = Date.now(); renderTeam(); await sleep(30);
      ok('a teammate that just worked is awake', !!bTile() && !bTile().classList.contains('sleeping'), bTile() ? bTile().className : '');
      sb.status = 'working'; sb.lastActive = 0; renderTeam(); await sleep(30);
      ok('a working teammate never sleeps', !!bTile() && !bTile().classList.contains('sleeping'), '');
      sb.status = 'idle'; renderTeam();
      const dmB = chatById('dm:' + B); clearChat(dmB);
      await wakeBot(sb);
      ok('a nap with nothing to do: the bot says sleep, the chat stays empty and it dozes off again', dmB.messages.length === 0 && isSleeping(sb) && !sb.waking && !S.flows[dmB.id], dmB.messages.length + ' message(s), asleep ' + isSleeping(sb));
      addMessage(dmB, { who: 'Storm', kind: 'user', text: 'nap test: there is work' });
      await wakeBot(sb);
      const napWork = dmB.messages.filter(m => m.who === B && m.kind === 'agent');
      ok('a nap that finds work: the bot reports it and stays awake a while', napWork.length === 1 && /found work/.test(napWork[0].text) && !isSleeping(sb), napWork.map(m => m.text).join(' | ') || '(no reply)');
      sb.lastWake = 0; sb.lastActive = 0; wakeTick();
      ok('Squall never wakes a bot by itself during the self-test', !sb.waking && !S.flows[dmB.id], '');
      clearChat(dmB); sb.lastActive = Date.now(); renderTeam();
      // approvals (Storm's must-have "Approve or deny risky actions from the app"): a bot asks to run a command and Storm answers on a card
      openChat('dm:' + A); await sleep(60);
      const dmAp = chatById('dm:' + A);
      clearChat(dmAp);
      const realCallAp = Bridge.call, apSent = [];
      Bridge.call = (cmd, args) => { const pr = realCallAp(cmd, args); if (cmd === 'approveAnswer') pr.then(x => apSent.push(x)).catch(() => { }); return pr; };
      try {
        const runAp1 = say('approval test: please run echo squall');
        await waitFor(() => dmAp.messages.some(m => m.kind === 'approve' && m.approve.state === 'waiting'), 15000).catch(() => { });
        await sleep(80);
        const apMsg = dmAp.messages.filter(m => m.kind === 'approve').pop();
        const apCard = document.querySelector('#chat .ok-card');
        ok('approvals: a bot asking to run a command shows a card with the command and Allow once, Always allow, Deny', !!apMsg && !!apCard && /echo squall/.test(apCard.textContent) && !!apCard.querySelector('[data-approve="once"]') && !!apCard.querySelector('[data-approve="always"]') && !!apCard.querySelector('[data-approve="deny"]'), apCard ? apCard.textContent.slice(0, 120) : 'no card');
        ok('approvals: the teammate shows a ? while it waits for the OK', !!document.querySelector('.member[data-chat="dm:' + A + '"] .qbadge'), '');
        await Bridge.call('capture', { name: '6h-approval-card' });
        if (apCard) apCard.querySelector('[data-approve="always"]').click();
        await runAp1;
        const sent1 = (apSent[0] && apSent[0].sent) || '';
        ok('approvals: Always allow lets the bot run it and saves the rule for that bot', !!apMsg && apMsg.approve.state === 'always' && /"behavior":"allow"/.test(sent1) && /updatedPermissions/.test(sent1) && dmAp.messages.some(m => m.who === A && /Ran it with Storm/.test(m.text || '')), sent1.slice(0, 160));
        const runAp2 = say('approval test: run it again');
        await waitFor(() => dmAp.messages.some(m => m.kind === 'approve' && m.approve.state === 'waiting'), 15000).catch(() => { });
        await sleep(80);
        const denyBtn = document.querySelector('#chat .ok-card.waiting [data-approve="deny"]');
        if (denyBtn) denyBtn.click();
        await runAp2;
        const sent2 = (apSent[1] && apSent[1].sent) || '';
        ok('approvals: Deny tells the bot no, and it carries on without it', /"behavior":"deny"/.test(sent2) && dmAp.messages.some(m => m.who === A && /Storm said no/.test(m.text || '')) && !document.querySelector('.member[data-chat="dm:' + A + '"] .qbadge'), sent2.slice(0, 160));
      } finally { Bridge.call = realCallAp; }
      clearChat(dmAp);
      openSettings(); await sleep(120);
      const apBtn = document.querySelector('[data-s="approvals"]');
      ok('approvals: Settings has the switch, on by default', !!apBtn && apBtn.textContent.trim() === 'On', apBtn ? apBtn.textContent : 'no button');
      closeModal();
      // five new bots in the team chat, then deleted (Storm: "Create 5 new bots to test the team chat", "Delete the 5 bots after")
      const FIVE = ['Nova', 'Pike', 'Rex', 'Sage', 'Tide'];
      const teamC = chatById('team'), agents0 = S.agents.length;
      for (const n of FIVE) await doAction({ do: 'create_bot', name: n, role: 'Test bot', prompt: 'You are ' + n + ', a test teammate.' }, teamC, 'Storm', true).catch(e => ok('five bots: ' + n + ' was added', false, e.message));
      await waitFor(() => FIVE.every(n => S.byName[n]), 10000).catch(() => { });
      await waitFor(() => FIVE.every(n => chatById('dm:' + n) && chatById('dm:' + n).messages.some(m => m.greet)), 60000).catch(() => { });
      openChat('team'); await sleep(120);
      ok('five bots: all five join the team, with a tile and a direct chat each', FIVE.every(n => S.byName[n] && document.querySelector('.member[data-chat="dm:' + n + '"]') && chatById('dm:' + n)) && S.agents.length === agents0 + 5, S.agents.length + ' teammates');
      ok('five bots: each one greets Storm once in its own chat (not the team chat)', FIVE.every(n => chatById('dm:' + n).messages.filter(m => m.greet).length === 1) && !chatById('team').messages.some(m => m.greet), FIVE.map(n => n + ':' + chatById('dm:' + n).messages.length).join(' '));
      ok('five bots: the team chat counts them as members', FIVE.every(n => chatById('team').members.includes(n)), chatById('team').members.join(', '));
      await Bridge.call('capture', { name: '6k-five-bots' });
      const five0 = chatById('team').messages.length;
      await say('Plan a Roblox leaderboard for my game');
      const fiveMsgs = chatById('team').messages.slice(five0);
      ok('five bots: a team goal with ' + S.agents.length + ' teammates still gets a plan, the work and a wrap-up', fiveMsgs.filter(m => m.who === S.lead.name && m.kind === 'agent').length >= 2 && fiveMsgs.some(m => m.kind === 'event' && m.tasks), fiveMsgs.length + ' messages');
      const five1 = chatById('team').messages.length;
      await say('ask @Tide what she thinks of the plan');
      ok('five bots: a new bot answers when asked in the team chat', chatById('team').messages.slice(five1).some(m => m.who === 'Tide' && m.kind === 'agent'), chatById('team').messages.slice(five1).map(m => m.who).join(', '));
      ok('five bots: no errors in the team chat', !chatById('team').messages.slice(five0).some(m => m.kind === 'error'), (chatById('team').messages.slice(five0).find(m => m.kind === 'error') || {}).text || '');
      for (const n of FIVE) await deleteBot(n).catch(e => ok('five bots: ' + n + ' was deleted', false, e.message));
      await waitFor(() => FIVE.every(n => !S.byName[n]), 10000).catch(() => { });
      await sleep(120);
      const diskAfter = await Bridge.call('teamFile', { name: 'Nova' }).catch(() => 'gone');
      ok('five bots: deleted again, with their tiles, chats and team.json entries gone', FIVE.every(n => !S.byName[n] && !document.querySelector('.member[data-chat="dm:' + n + '"]') && !chatById('dm:' + n)) && S.agents.length === agents0 && !FIVE.some(n => chatById('team').members.includes(n)), S.agents.length + ' teammates; team.json: ' + JSON.stringify(diskAfter));
      // a bot's own question card (Storm: "teach Obsidian how to use the question thing"): the block shows as a card, and the picks go back to the bot
      const sysQ = await Bridge.call('sysPrompt', { name: A });
      ok('every bot is taught the question card format', /```squall-ask/.test(sysQ) && /recommended option first/.test(sysQ), '');
      openChat('dm:' + A); await sleep(60);
      const qdm = chatById('dm:' + A);
      clearChat(qdm);
      addMessage(qdm, { who: A, kind: 'agent', text: 'Which way should I go?\n```squall-ask\n{"questions":[{"question":"Which color for the board?","header":"Color","multiSelect":false,"options":[{"label":"Blue (Recommended)","description":"calm"},{"label":"Red","description":"loud"}]}]}\n```' });
      await sleep(80);
      const qcard = document.querySelector('#chat .ask-card');
      ok('a bot’s question block shows as a card, with no raw JSON left in the chat', !!qcard && /Which color for the board\?/.test(qcard.textContent) && !/"questions"/.test($('#chat').textContent) && /Which way should I go\?/.test($('#chat').textContent), qcard ? qcard.textContent.slice(0, 100) : 'no card');
      await Bridge.call('capture', { name: '6m-bot-question-card' });
      const qopt = qcard && qcard.querySelector('[data-askopt][data-label="Red"]');
      if (qopt) qopt.click();
      await sleep(60);
      const qsend = document.querySelector('#chat .ask-card [data-asksend]');
      if (qsend) qsend.click();
      await sleep(80); await waitFor(idle, 60000).catch(() => { });
      const qans = qdm.messages.find(m => m.who === 'Storm' && /^My answers to your questions/.test(m.text || ''));
      ok('picking an answer sends it to the bot, and the bot replies', !!qans && /Color: Red/.test(qans.text) && qdm.messages.filter(m => m.who === A && m.kind === 'agent').length >= 2, qans ? qans.text : 'no answer sent');
      ok('the card shows it was answered', !document.querySelector('#chat .ask-card [data-asksend]'), '');
      clearChat(qdm);
      // other bots' messages fold in team and group chats (Storm: "Make other bot's messages collapsed until clicked"); the lead's stay open
      openChat('team'); await sleep(100);
      const folded = document.querySelectorAll('#chat .msg.folded');
      const leadOpen = Array.from(document.querySelectorAll('#chat .msg:not(.folded):not(.user)')).some(el => el.querySelector('.who') && el.querySelector('.who').textContent.startsWith(S.lead.name));
      ok('team chat: other bots’ messages are folded to one line, the lead’s stay open', folded.length > 0 && leadOpen, folded.length + ' folded');
      await Bridge.call('capture', { name: '6l-folded' });
      const fb = folded[0] && folded[0].querySelector('[data-expand]');
      const fid = fb && fb.dataset.expand;
      if (fb) fb.click();
      await sleep(80);
      const opened = fid && document.querySelector('#chat .msg[data-k="' + fid + '"]:not(.folded)');
      ok('a click opens a folded message, with Hide to fold it again', !!opened && !!opened.querySelector('[data-collapse]'), '');
      if (opened) opened.querySelector('[data-collapse]').click();
      await sleep(80);
      ok('Hide folds it again', !!(fid && document.querySelector('#chat .msg.folded[data-k="' + fid + '"]')), '');
      // the vault in Squall (Storm: "Make it able to show Obsidian inside the app with the graph view on the right sidebar")
      const vgd = await Bridge.call('vaultGraph').catch(e => ({ err: e.message }));
      ok('vault: the host reads EVO’s notes, their links and Obsidian’s graph colors', Array.isArray(vgd.nodes) && vgd.nodes.length > 20 && Array.isArray(vgd.edges) && vgd.edges.length > 20 && vgd.nodes.some(n => n.name === 'Claude Memory') && (vgd.groups || []).some(g => /path:Projects/.test(g.query || '')), vgd.err || (vgd.nodes || []).length + ' notes, ' + (vgd.edges || []).length + ' links');
      S.rightMode = 'vault'; renderLive();   // the Vault button opens Coreshell now; the graph pane is still checked
      await waitFor(() => VG.nodes.length > 0 && /notes/.test((document.querySelector('.vg-count') || {}).textContent || ''), 10000).catch(() => { });
      await sleep(1500);   // the layout settles a little for the screenshot
      ok('vault: the Vault tab shows the graph in the right pane', !!document.querySelector('#live-body #vg-canvas') && VG.nodes.length > 20 && VG.w > 50, (document.querySelector('.vg-count') || {}).textContent || '');
      // search results and filter chips (Storm's quality-of-life list, 2026-10-18)
      VG.q = 'tempest'; renderVgResults();
      const vgHitN = document.querySelectorAll('#live-body .vg-hit').length;
      ok('vault search: a search lists the notes it matches, each one clickable', vgHitN > 0 && /match/.test((document.querySelector('.vg-results') || {}).textContent || ''), vgHitN + ' results');
      VG.q = ''; renderVgResults(); const vgSearchBox = document.querySelector('#vg-q'); if (vgSearchBox) vgSearchBox.value = '';
      ok('vault search: clearing the search clears the list', document.querySelectorAll('#live-body .vg-hit').length === 0, '');
      renderVgChips();
      const vgChips = Array.from(document.querySelectorAll('#live-body .vg-chip'));
      ok('vault filters: chips for All, Linked, Orphans and the folders', vgChips.length >= 4 && vgChips[0].dataset.vf === 'all' && vgChips.some(b => b.dataset.vf === 'orphans') && vgChips.some(b => /^folder:/.test(b.dataset.vf || '')), vgChips.length + ' chips');
      const folderChip = vgChips.find(b => /^folder:/.test(b.dataset.vf || ''));
      if (folderChip) folderChip.click();
      await sleep(40);
      const keptFolder = vgFilterSet();
      ok('vault filters: a folder chip keeps that folder’s notes bright and dims the rest', !!folderChip && !!keptFolder && keptFolder.size > 0 && keptFolder.size < VG.nodes.length && VG.filter === folderChip.dataset.vf, folderChip ? folderChip.dataset.vf + ' · ' + (keptFolder ? keptFolder.size : 0) + ' notes' : 'no folder chip');
      const cntText = (document.querySelector('.vg-count') || {}).textContent || '';
      ok('vault filters: the count beside the search says how many notes the filter keeps', !!folderChip && /of \d+ notes/.test(cntText), cntText);
      const allChip = document.querySelector('#live-body .vg-chip[data-vf="all"]');
      if (allChip) allChip.click();
      await sleep(40);
      ok('vault filters: All brings every note back', VG.filter === 'all' && vgFilterSet() === null, VG.filter);
      VG.q = 'tempest'; renderVgResults(); VG.filter = 'orphans'; renderVgChips();
      const vgEsc = document.querySelector('#vg-q');
      if (vgEsc) { vgEsc.value = 'tempest'; vgEsc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); }
      await sleep(40);
      ok('vault search: Escape clears the search and the filter', VG.q === '' && VG.filter === 'all' && document.querySelectorAll('#live-body .vg-hit').length === 0, VG.filter);
      VG.q = 'claude'; renderVgResults();
      ok('vault search: a common word finds several notes to pick from', (VG.hits || []).length >= 2, (VG.hits || []).length + ' notes');
      ok('vault search: the typed part is marked inside each result name', !!document.querySelector('#live-body .vg-hit b mark') && /claude/i.test(document.querySelector('#live-body .vg-hit b mark').textContent), (document.querySelector('#live-body .vg-hit b mark') || {}).textContent || 'no mark');
      if ((VG.hits || []).length >= 2) {
        const vgArrowBox = document.querySelector('#vg-q');
        if (vgArrowBox) { vgArrowBox.value = 'claude'; vgArrowBox.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); }
        await sleep(20);
        const vgOn = document.querySelector('#live-body .vg-hit.on');
        ok('vault search: the arrow keys pick a result, and the picked one is marked', VG.sel === 1 && !!vgOn && vgOn.dataset.vgOpen === String(VG.hits[1]), 'picked ' + VG.sel);
      }
      VG.q = 'claude'; renderVgResults(); syncVgX();
      const vgXBtn = document.querySelector('#live-body #vg-x');
      ok('vault search: the ✕ shows while there is text to clear', !!vgXBtn && !vgXBtn.hidden, vgXBtn ? 'hidden ' + vgXBtn.hidden : 'missing');
      if (vgXBtn) vgXBtn.click();
      await sleep(30);
      ok('vault search: the ✕ clears the search and hides itself', VG.q === '' && !!vgXBtn && vgXBtn.hidden, VG.q);
      VG.q = ''; renderVgResults(); const vgArrowClear = document.querySelector('#vg-q'); if (vgArrowClear) vgArrowClear.value = '';
      VG.q = 'Okafor'; renderVgResults();   // (a word only inside notes: 'distillation' became a note's name, no-distillation.md, on 22 Oct)
      const vgDeep = document.querySelector('#live-body .vg-deep');
      ok('vault search: a word only in the text offers Search inside the notes', !!vgDeep && (VG.hits || []).length === 0, (VG.hits || []).length + ' name matches');
      if (vgDeep) vgDeep.click();
      await waitFor(() => document.querySelectorAll('#live-body [data-vg-note]').length > 0, 8000).catch(() => { });
      const vgDeepRows = document.querySelectorAll('#live-body [data-vg-note]').length;
      ok('vault search: Search inside the notes lists the notes whose text has the word', vgDeepRows > 0, vgDeepRows + ' notes');
      VG.q = ''; renderVgResults(); const vgDeepClear = document.querySelector('#vg-q'); if (vgDeepClear) vgDeepClear.value = '';
      // the call screen says what it is doing while a phrase waits for Whisper (Storm's voice call polish)
      voiceHold = 999;
      const csHold = callState();
      voiceHold = 0;
      ok('voice call: while a phrase waits for Whisper, the call says “Checking your words”', csHold === 'Checking your words', csHold);
      await Bridge.call('capture', { name: '6n-vault-graph' });
      // the names around a hovered note stay legible (Storm's screenshot: a hub's neighbours' names piled on each other)
      const hubIdx = VG.nodes.reduce((best, n, i) => (n.deg > VG.nodes[best].deg ? i : best), 0);
      VG.hover = hubIdx; vgKick(); await sleep(300);
      const hoverCount = (document.querySelector('.vg-count') || {}).textContent || '';
      ok('vault: the count line names the note under the pointer, with its links', VG.nodes[hubIdx] ? hoverCount.indexOf(VG.nodes[hubIdx].name) === 0 && /links?$/.test(hoverCount) : false, hoverCount);
      await Bridge.call('capture', { name: '6s-vault-hover' });
      VG.hover = -1; vgKick();
      ok('vault: hovering a hub note draws the graph with its name shown', VG.nodes.length > 20 && !!VG.nodes[hubIdx], VG.nodes[hubIdx] ? VG.nodes[hubIdx].name + ' · ' + VG.nodes[hubIdx].deg + ' links' : 'no hub');
      await openNote('Claude Memory.md');
      await waitFor(() => S.noteView && !S.noteView.loading, 8000).catch(() => { });
      await sleep(80);
      ok('vault: a note opens in the middle, read-only, with Back to chat', /Start here, Claude/.test($('#chat').textContent) && /Back to chat/.test($('#chat-head').textContent) && $('#input').disabled, $('#chat').textContent.slice(0, 80));
      ok('vault: its [[links]] are clickable and it lists the notes it links with', !!document.querySelector('#chat .note-view .md .wl[data-note]') && !!document.querySelector('#chat .note-links .wl'), '');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(40);
      ok('vault: Escape leaves a note and goes back to the chat', !S.noteView, S.noteView ? S.noteView.name : 'closed');
      await openNote('Claude Memory.md');
      await waitFor(() => S.noteView && !S.noteView.loading, 8000).catch(() => { });
      await sleep(40);
      const wl1 = document.querySelector('#chat .note-view .md .wl[data-note="Team rules"]') || document.querySelector('#chat .note-view .md .wl[data-note]');
      const wlName = wl1 ? wl1.dataset.note.split('/').pop().toLowerCase() : '';
      if (wl1) wl1.click();
      await waitFor(() => S.noteView && !S.noteView.loading && S.noteView.name.toLowerCase() === wlName, 8000).catch(() => { });
      ok('vault: clicking a link opens that note', !!S.noteView && S.noteView.name.toLowerCase() === wlName, S.noteView ? S.noteView.name : 'closed');
      await Bridge.call('capture', { name: '6o-vault-note' });
      // diagrams and animations in EVO (Storm: "Make it possible for bots to create diagrams and animations inside of Obsidian"): the example note
      if (VG.byKey['squall map'] !== undefined) {
        await openNote(VG.nodes[VG.byKey['squall map']].path);
        await waitFor(() => S.noteView && !S.noteView.loading, 8000).catch(() => { });
        await waitFor(() => { const im = document.querySelector('#chat .note-img'); return !!im && im.complete; }, 5000).catch(() => { });
        const anim = document.querySelector('#chat .note-img');
        ok('vault: a note’s animated SVG plays in Squall, and its Mermaid diagram is labelled', !!anim && anim.naturalWidth > 0 && /Mermaid diagram/.test($('#chat').textContent), anim ? anim.getAttribute('src') + ' ' + anim.naturalWidth : 'no image');
        await Bridge.call('capture', { name: '6p-vault-diagram' });
      }
      const closeBtn = document.querySelector('[data-act="closenote"]');
      if (closeBtn) closeBtn.click();
      await sleep(80);
      ok('vault: Back to chat closes the note', !S.noteView && !$('#input').disabled, '');
      S.rightMode = 'live'; renderLive();
      // the graph has physics (Storm: "They are crammed together and don't have physics"): settled notes never overlap, and dragging one pulls its neighbours
      S.rightMode = 'vault'; renderLive();
      await sleep(4500);
      const overlaps = () => { let n = 0; const N = VG.nodes; for (let i = 0; i < N.length; i++) for (let j = i + 1; j < N.length; j++) if (Math.hypot(N[i].x - N[j].x, N[i].y - N[j].y) < vgRadius(N[i]) + vgRadius(N[j]) - 0.5) n++; return n; };
      ok('vault: after it settles, no two notes overlap', VG.nodes.length > 20 && overlaps() === 0, overlaps() + ' overlapping pairs');
      const hubI = VG.nodes.reduce((b, n, i) => n.deg > VG.nodes[b].deg ? i : b, 0), hub = VG.nodes[hubI], nbr = hub.nb.map(j => VG.nodes[j]).sort((x, y) => x.deg - y.deg)[0];   // a lightly linked neighbour follows the most (hub springs are soft on purpose)
      const cr = VG.canvas.getBoundingClientRect(), hx = cr.left + VG.w / 2 + VG.panX + hub.x * VG.zoom, hy = cr.top + VG.h / 2 + VG.panY + hub.y * VG.zoom;
      const nb0 = nbr ? { x: nbr.x, y: nbr.y } : { x: 0, y: 0 };
      VG.canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: hx, clientY: hy, pointerId: 7, bubbles: true }));
      for (let s = 1; s <= 10; s++) { VG.canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: hx + s * 12, clientY: hy + s * 6, pointerId: 7, bubbles: true })); await sleep(40); }
      await sleep(300);
      const pulled = nbr ? Math.hypot(nbr.x - nb0.x, nbr.y - nb0.y) : 0;
      VG.canvas.dispatchEvent(new PointerEvent('pointerup', { clientX: hx + 120, clientY: hy + 60, pointerId: 7, bubbles: true }));
      ok('vault: dragging a note pulls its neighbours along (physics), and a drag doesn’t open the note', pulled > 4 && !S.noteView, pulled.toFixed(1) + ' px');
      await sleep(200);
      await Bridge.call('capture', { name: '6q-vault-physics' });
      S.rightMode = 'live'; renderLive();
      // the timer dial's ticks swell under the selector (Storm: "Make the lines get bigger when the timer selector line is over it")
      openTimerDial(); await sleep(120);
      const dialTicks = Array.from(document.querySelectorAll('.td-tick')), mags = dialTicks.map(tk => parseFloat(tk.style.getPropertyValue('--mag') || '1')), onI = dialTicks.findIndex(tk => tk.classList.contains('on'));
      ok('timer: the ticks under the selector swell, the far ones stay small', onI >= 0 && mags[onI] > 2 && Math.min.apply(null, mags) === 1, mags.slice(Math.max(0, onI - 3), onI + 4).map(x => x.toFixed(2)).join(' '));
      closeTimerDial();
      // sounds (Storm: "Make the app have typing sounds and sounds for everything") and the interactive background (Storm: "Make the squall background interactive")
      openSettings(); await sleep(100);
      const snd0 = S.sounds, sndSeen = [];
      for (let k = 0; k < 3; k++) { const sbtn = document.querySelector('[data-s="sound"]'); if (sbtn) sbtn.click(); await sleep(100); sndSeen.push(S.sounds); }
      closeModal();
      ok('Settings → Sound cycles all sounds, just the ping, and off', new Set(sndSeen).size === 3 && sndSeen.every(x => ['all', 'ping', 'off'].includes(x)) && S.sounds === snd0, snd0 + ' → ' + sndSeen.join(' → '));
      ok('every sound is made in the app (no files)', ['key', 'send', 'reply', 'peek', 'tick', 'open', 'ask', 'update', 'error', 'voiceOn', 'voiceOff', 'pop'].every(k => typeof SFX[k] === 'function'), '');
      ok('the interactive background runs behind the app', !!document.getElementById('bg-fx') && BG.motes.length > 10, BG.motes.length + ' motes');
      // minimized, everything pauses (Storm's laptop runs games; a minimized Squall measured about 12% of a core before)
      setWinState(true); await sleep(120);
      const pausedNow = document.body.classList.contains('paused') && !BG.raf;
      const animState = getComputedStyle(document.querySelector('.member .avatar') || document.body).animationPlayState;
      setWinState(false); await sleep(120);
      ok('minimized: animations pause and the background stops; restored: they run again', pausedNow && /paused/.test(animState) && !document.body.classList.contains('paused') && !!BG.raf, 'paused ' + pausedNow + ', ' + animState + ', running again ' + !!BG.raf);      // a bot's own permission mode (Storm: "Can you set Obsidian to bypass permissions mode?"): the right-click menu, saved to team.json
      openChat('team'); await sleep(60);
      setWinState(true); await sleep(60);
      addMessage(chatById('team'), { who: APP, kind: 'event', text: 'drawn after the window is back' });
      await sleep(60);
      const drewHidden = /drawn after the window is back/.test($('#chat').textContent);
      setWinState(false); await sleep(100);
      ok('minimized: nothing is redrawn until the window comes back, then all of it is', !drewHidden && /drawn after the window is back/.test($('#chat').textContent), 'drawn while minimized: ' + drewHidden);      const bpTile = document.querySelector('.member[data-chat="dm:' + B + '"]');
      if (bpTile) bpTile.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 60, clientY: 240 }));
      await sleep(80);
      const bpItem = document.querySelector('.bot-menu [data-botact="bypass"]');
      ok('the right-click menu offers Bypass permissions, unchecked while it’s off', !!bpItem && !/✓/.test(bpItem.textContent), bpItem ? bpItem.textContent : 'no item');
      closeBotMenu();
      await toggleBypass(B);
      const bpDisk = await Bridge.call('teamDisk', { name: B }).catch(() => null);
      ok('Bypass permissions saves to team.json', S.byName[B].permissionMode === 'bypassPermissions' && !!bpDisk && bpDisk.agent && bpDisk.agent.permissionMode === 'bypassPermissions', bpDisk ? JSON.stringify(bpDisk.agent).slice(0, 120) : '');
      await toggleBypass(B);
      const bpDisk2 = await Bridge.call('teamDisk', { name: B }).catch(() => null);
      ok('toggling again takes it off', !S.byName[B].permissionMode && !!bpDisk2 && bpDisk2.agent && !bpDisk2.agent.permissionMode, '');
      // the to-do list in the right pane (Storm: "I want a visual todo list on the right side")
      document.querySelector('[data-todotab]').click();
      await sleep(150);
      ok('to-do: the To do tab shows the list in the right pane', !!document.querySelector('#live-body .todo-pane') && !!document.querySelector('#todo-in'), '');
      const tdIn = document.querySelector('#todo-in');
      tdIn.value = 'Test the to-do list'; tdIn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await sleep(120);
      const tdItem = TODO.items.find(x => x.text === 'Test the to-do list');
      ok('to-do: typing one and Enter adds it under Next', !!tdItem && tdItem.status === 'todo' && /Test the to-do list/.test($('#live-body').textContent) && tdIn.value === '', tdItem ? tdItem.status : 'not added');
      document.querySelector('[data-todo="doing"][data-id="' + (tdItem && tdItem.id) + '"]').click(); await sleep(80);
      ok('to-do: Start moves it to Doing now', !!tdItem && tdItem.status === 'doing' && /Doing now/.test($('#live-body').textContent), tdItem ? tdItem.status : '');
      document.querySelector('[data-todo="done"][data-id="' + (tdItem && tdItem.id) + '"]').click(); await sleep(80);
      const tdNow = TODO.items.find(x => x.text === 'Test the to-do list') || tdItem;   // the list reloads from disk now and then, so look the item up again
      ok('to-do: the check marks it done and the progress bar moves', !!tdNow && tdNow.status === 'done' && /1 of \d+ done/.test($('#live-body').textContent), $('#live-body .todo-count').textContent);
      const tdDisk = JSON.parse((await Bridge.call('todoRead')) || '{}');
      ok('to-do: it’s saved in the shared file, so sessions and bots see it too', (tdDisk.items || []).some(x => x.text === 'Test the to-do list' && x.status === 'done'), JSON.stringify(tdDisk).slice(0, 120));
      await doAction({ do: 'todo_add', text: 'A bot’s to-do' }, chatById('team'), A, false);
      ok('to-do: a bot can add one with an action', TODO.items.some(x => x.text === 'A bot’s to-do' && x.by === A), '');
      // the bots see the list in every message, with rules for when to use it, and can take an item and close it
      const botTodo = TODO.items.find(x => x.text === 'A bot’s to-do');
      const seenPrompt = buildPrompt(chatById('dm:' + A), A, '', false).prompt;
      ok('to-do: each bot message shows the open items with their ids and when to use the list', !!botTodo && seenPrompt.indexOf('[' + botTodo.id + ']') >= 0 && /todo_doing/.test(seenPrompt) && /todo_done/.test(seenPrompt), seenPrompt.slice(seenPrompt.indexOf('To do list'), seenPrompt.indexOf('To do list') + 160));
      ok('to-do: a live session’s messages don’t get the list', buildPrompt(chatById('dm:' + A), A, '', true).prompt.indexOf('To do list') < 0, '');
      await doAction({ do: 'todo_doing', id: botTodo && botTodo.id }, chatById('team'), A, false);
      S.rightMode = 'todo'; renderLive(); await sleep(80);
      ok('to-do: a bot can take an item, and the pane shows it’s on it', !!botTodo && TODO.items.some(x => x.id === botTodo.id && x.status === 'doing' && x.who === A) && new RegExp(A + ' is on it').test($('#live-body').textContent), '');
      await doAction({ do: 'todo_done', id: botTodo && botTodo.id }, chatById('team'), A, false);
      ok('to-do: and close it when it’s finished', !!botTodo && TODO.items.some(x => x.id === botTodo.id && x.status === 'done'), '');
      await doAction({ do: 'todo_add', text: 'Started right away', start: true }, chatById('team'), A, false);
      ok('to-do: a bot can add an item and start it at once', TODO.items.some(x => x.text === 'Started right away' && x.status === 'doing' && x.who === A), '');
      for (const it of TODO.items.slice()) if (it.text === 'Started right away') todoDel(it.id);
      // the To do drive (Storm, 23 Oct): a chief that stops is told to take the next open item; one that needs Storm is marked and left out
      const dItem = todoAdd('A drive test item', A);
      const dNote = driveNote(A);
      ok('to do drive: the note lists the open items with their ids and the way to mark one that needs Storm', !!dItem && dNote.indexOf('[' + dItem.id + ']') >= 0 && /todo_needs/.test(dNote), '');
      await doAction({ do: 'todo_needs', id: dItem && dItem.id, why: 'his answer' }, chatById('team'), A, false);
      await sleep(60);
      ok('to do drive: an item marked as needing Storm leaves the drive and shows him "needs you"', !!dItem && !!dItem.needs && !driveItems().some(x => x.id === dItem.id) && /needs you/.test($('#live-body').innerHTML), '');
      driveStormWrote(A);
      await sleep(60);
      const dLive = dItem && TODO.items.find(x => x.id === dItem.id);   // (the list may have been read back from disk: look it up again)
      ok('to do drive: his next message to that bot clears the mark', !!dLive && !dLive.needs && driveItems().some(x => x.id === dLive.id), dLive ? String(dLive.needs || '') : 'gone');
      if (dItem) todoDel(dItem.id);
      await Bridge.call('capture', { name: '6r-todo' });
      for (const it of TODO.items.slice()) if (it.text === 'Test the to-do list' || it.text === 'A bot’s to-do') todoDel(it.id);
      await sleep(80);
      ok('to-do: × removes them', !TODO.items.some(x => x.text === 'Test the to-do list'), '');
      S.rightMode = 'live'; renderLive();
      // small details (Storm: "Make some more small details too")
      openChat('team'); await sleep(60);
      const sdB = chatById('dm:' + B);
      clearChat(sdB);
      addMessage(sdB, { who: B, kind: 'agent', text: 'Older message.' });
      sdB.unread = 0;
      addMessage(sdB, { who: B, kind: 'agent', text: 'First new one.' });
      addMessage(sdB, { who: B, kind: 'agent', text: 'Second new one.' });
      openChat('dm:' + B); await sleep(80);
      const nlEl = document.querySelector('#chat .new-line'), firstNew = sdB.messages.find(x => x.text === 'First new one.');
      ok('details: a “New messages” line shows where the unread ones start', !!nlEl && !!firstNew && nlEl.nextElementSibling && nlEl.nextElementSibling.getAttribute('data-k') === firstNew.id, nlEl ? 'line shown' : 'no line');
      addMessage(sdB, { who: 'Storm', kind: 'user', text: 'my earlier message' });
      $('#input').value = ''; $('#input').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
      ok('details: Up in an empty box brings back your last message', $('#input').value === 'my earlier message', JSON.stringify($('#input').value));
      $('#input').value = ''; autosize();
      addMessage(sdB, { who: B, kind: 'agent', text: 'Long reply. ' + 'This sentence makes it long. '.repeat(70) });
      await sleep(60);
      const moreBtn = document.querySelector('#chat .show-more');
      ok('details: a very long reply folds with Show more', !!moreBtn && !!document.querySelector('#chat .md.long'), '');
      if (moreBtn) moreBtn.click(); await sleep(60);
      ok('details: Show more opens it', !document.querySelector('#chat .md.long'), '');
      openChat('team'); await sleep(60);
      addMessage(chatById('team'), { who: S.lead.name, kind: 'agent', text: 'A message from the lead.' });
      await sleep(60);
      const nameEl = Array.from(document.querySelectorAll('#chat .who-name[data-openbot]')).pop();
      if (nameEl) nameEl.click(); await sleep(60);
      ok('details: clicking a bot’s name opens its chat', !!nameEl && S.active === 'dm:' + nameEl.dataset.openbot, S.active);
      // faster follow-ups (Storm: "Is there a way to get faster responses"): the bot in the open chat asks the host to stay ready for
      // 2.5 minutes after its reply; other chats, a minimized Squall and the switch in Settings don't
      const runArgs = [], realRunCall = Bridge.call;
      Bridge.call = function (name, args) { if (name === 'run') runArgs.push(Object.assign({}, args)); return realRunCall.apply(this, arguments); };
      openChat('dm:' + B); await sleep(60);
      $('#input').value = 'a quick follow-up test'; send();
      await waitFor(() => runArgs.some(x => x.agent === B), 8000).catch(() => { });
      Bridge.call = realRunCall;
      const ra = runArgs.find(x => x.agent === B);
      ok('speed: the bot in the open chat stays ready for a follow-up (2.5 minutes)', !!ra && ra.warm === true && ra.warmSecs === CHAT_WARM_S, ra ? JSON.stringify({ warm: ra.warm, warmSecs: ra.warmSecs }) : 'no run');
      await waitFor(idle, 60000).catch(() => { });
      S.winMin = true; const minWarm = warmFor(chatById('dm:' + B)); S.winMin = false;
      ok('speed: a chat that isn’t open, or a minimized Squall, keeps no bot waiting', warmFor(chatById('team')) === 0 && minWarm === 0 && warmFor(chatById('dm:' + B)) === CHAT_WARM_S, '');
      openSettings(); await sleep(60);
      const rdBtn = document.querySelector('.set-modal [data-s="ready"]');
      ok('speed: Settings has the Ready for follow-ups switch, on by default', !!rdBtn && rdBtn.textContent === 'On', rdBtn ? rdBtn.textContent : 'missing');
      await sleep(120);
      const vsLine = (document.getElementById('set-vstatus') || {}).textContent || '';
      ok('speech status: Settings says whether the warm server is running', /^Speech:/.test(vsLine), vsLine.slice(0, 90));
      if (rdBtn) rdBtn.click(); await sleep(60);
      const offWarm = warmFor(chatById('dm:' + B)), rdOff = document.querySelector('.set-modal [data-s="ready"]');
      ok('speed: switched off, every message starts its bot fresh', S.readyBots === false && offWarm === 0 && !!rdOff && rdOff.textContent === 'Off', rdOff ? rdOff.textContent : '');
      if (rdOff) rdOff.click(); await sleep(60);
      closeModal();
      ok('speed: and back on', S.readyBots !== false && warmFor(chatById('dm:' + B)) === CHAT_WARM_S, '');
      // true black (Storm, 20 Oct): on by default, pure black behind the panels, and the Look switch flips it both ways
      const tbBg = () => getComputedStyle(document.body).backgroundColor;
      ok('look: true black is on by default (pure black behind everything)', S.trueBlack !== false && document.body.classList.contains('trueblack') && tbBg() === 'rgb(0, 0, 0)', tbBg());
      openSettings(); await sleep(60);
      const tbBtn = document.querySelector('.set-modal [data-s="trueblack"]');
      if (tbBtn) tbBtn.click(); await sleep(60);
      const tbOff = document.querySelector('.set-modal [data-s="trueblack"]');
      ok('look: Settings > Look switches back to the glass background', !!tbBtn && S.trueBlack === false && !document.body.classList.contains('trueblack') && !!tbOff && tbOff.textContent === 'Glass', (tbOff ? tbOff.textContent : 'missing') + ' ' + tbBg());
      if (tbOff) tbOff.click(); await sleep(60);
      closeModal();
      ok('look: and back to true black', S.trueBlack !== false && document.body.classList.contains('trueblack'), '');
      const gameNow = await Bridge.call('gameCheck').catch(e => e.message);
      ok('speed: the host checks for a running game (no bot waits in memory then)', typeof gameNow === 'boolean', String(gameNow));
      // an update never restarts Squall during a game: the chip says it waits
      updateGame = true; showUpdate({ newer: true, build: '2099.01.01.0000', summary: [] });
      const gameChip = (document.getElementById('update-chip') || {}).textContent || '';
      ok('update: while a game is running the update waits, and the chip says so', /waits for your game/.test(gameChip) && !updateTimer, gameChip);
      updateGame = false; showUpdate(null);
      clearChat(sdB);
      // a real run through the bots' own code (opt-in: SQUALL_REAL_PROBE=1, since it uses Claude): it must ask before the command,
      // run it once allowed, and end by itself (Claude only exits once Squall closes its input after the result)
      if (S.info && S.info.realProbe) {
        const probe = { runId: null, approve: null, exit: null };
        Bridge.on('approve', m => { if (m.agent === 'Probe') probe.approve = m; });
        Bridge.on('exit', m => { if (probe.runId && m.runId === probe.runId) probe.exit = m; });
        try { probe.runId = await Bridge.call('realProbe', { warm: true }); } catch (e) { probe.err = e.message; }
        await waitFor(() => probe.approve || probe.exit, 120000).catch(() => { });
        ok('real run: Claude asks Squall before running a command', !!probe.approve && probe.approve.tool === 'Bash' && /mkdir probe-made-this/.test(JSON.stringify(probe.approve.input || {})), probe.err || (probe.approve ? probe.approve.tool + ' ' + JSON.stringify(probe.approve.input) : probe.exit ? 'ended without asking (code ' + probe.exit.code + ')' : 'nothing in 2 min'));
        if (probe.approve) await Bridge.call('approveAnswer', { runId: probe.approve.runId, requestId: probe.approve.requestId, decision: 'once' }).catch(() => { });
        await waitFor(() => probe.exit, 120000).catch(() => { });
        const made = await Bridge.call('probeMade').catch(() => false);
        ok('real run: allowed once, the command ran, and the run ended on its own', !!probe.exit && probe.exit.code === 0 && made, probe.exit ? 'exit ' + probe.exit.code + ', folder ' + made : 'still running after 2 min');
        // a call's next turn goes into the same running process (Storm: "Is there a way to get faster responses")
        const wi1 = await Bridge.call('warmInfo').catch(() => []), w1 = (wi1 || []).find(x => x.agent === 'Probe');
        ok('real run: a call’s bot stays running after its reply', !!w1 && !!w1.session, JSON.stringify(wi1));
        if (w1) {
          const p2 = { runId: null, exit: null };
          Bridge.on('exit', m => { if (p2.runId && m.runId === p2.runId) p2.exit = m; });
          const t0 = Date.now();
          p2.runId = await Bridge.call('realProbe', { warm: true, sessionId: w1.session, prompt: 'Reply with just the word two.' }).catch(() => null);
          await waitFor(() => p2.exit, 60000).catch(() => { });
          const wi2 = await Bridge.call('warmInfo').catch(() => []), w2 = (wi2 || []).find(x => x.agent === 'Probe');
          ok('real run: the next turn goes into the same running process', !!p2.exit && p2.exit.code === 0 && !!w2 && w2.pid === w1.pid, (p2.exit ? 'exit ' + p2.exit.code : 'no exit') + ', pid ' + w1.pid + ' then ' + (w2 && w2.pid) + ', ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
        }
        // a bot in bypass mode runs the command without asking
        const pb = { runId: null, approve: null, exit: null };
        Bridge.on('approve', m => { if (m.agent === 'ProbeB') pb.approve = m; });
        Bridge.on('exit', m => { if (pb.runId && m.runId === pb.runId) pb.exit = m; });
        pb.runId = await Bridge.call('realProbe', { bypass: true }).catch(() => null);
        await waitFor(() => pb.exit, 120000).catch(() => { });
        const madeB = await Bridge.call('probeMade', { name: 'ProbeB' }).catch(() => false);
        ok('real run: a bot in bypass mode runs the command without asking', !!pb.exit && pb.exit.code === 0 && madeB && !pb.approve, (pb.exit ? 'exit ' + pb.exit.code : 'no exit') + ', folder ' + madeB + ', asked ' + !!pb.approve);
      }
      // resizable sidebars (Storm: "I can't resize any of the sidebars"): drag the handle, the width changes and is saved; double-click resets
      const spl = document.querySelector('#team > .splitter.left'), spr = document.querySelector('#live > .splitter.right');
      ok('both sidebars have a drag handle', !!spl && !!spr, '');
      if (spl) {
        const sw0 = $('#team').getBoundingClientRect().width, sr = spl.getBoundingClientRect();
        const pe = (type, x) => spl.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: sr.top + 40, pointerId: 9 }));
        pe('pointerdown', sr.left + 2); pe('pointermove', sr.left + 82); pe('pointerup', sr.left + 82);
        await sleep(60);
        const sw1 = $('#team').getBoundingClientRect().width;
        ok('dragging the left handle widens the team column, and it is saved', sw1 > sw0 + 40 && S.sides.left > 0, Math.round(sw0) + ' → ' + Math.round(sw1) + ' px');
        spl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        await sleep(60);
        ok('double-clicking the handle puts the column back', !S.sides.left && Math.abs($('#team').getBoundingClientRect().width - SIDE.left.def) < 3, Math.round($('#team').getBoundingClientRect().width) + ' px');
      }
      // Stop on the right pane (Storm: "There's not a stop button"): a bot's run is stopped through the host, and its chat says so
      const realStop = Bridge.call, stopCalls = [];
      Bridge.call = (cmd, args) => { if (cmd === 'stop') stopCalls.push(args); return realStop(cmd, args); };
      try { stopAgentNow(B); } finally { Bridge.call = realStop; }
      ok('Stop on the right pane stops the bot and says so in its chat', stopCalls.length === 1 && stopCalls[0].agent === B && chatById('dm:' + B).messages.some(m => /Stopped /.test(m.text || '')), stopCalls.length + ' stop call(s)');
      // up to 4 chiefs (Storm: "Make it where I can have up to 4 chiefs"): a second chief is pinned with a crown, and can be turned back
      await toggleChief(B);
      await sleep(60);
      const pinnedChiefs = document.querySelectorAll('#agents .pinned .member.chief').length;
      ok('a second chief is pinned with a crown', S.byName[B].lead && S.chiefs.length === 2 && pinnedChiefs === 2, S.chiefs.map(c => c.name).join(', ') + ' · ' + pinnedChiefs + ' pinned');
      const botMenuChief = (() => { openBotMenu(B, 60, 240); const b = document.querySelector('.bot-menu [data-botact="chief"]'); const on = !!b && /✓/.test(b.textContent); closeBotMenu(); return on; })();
      ok('the right-click menu shows the Chief toggle as on', botMenuChief, '');
      await toggleChief(B);
      await sleep(60);
      ok('turning it back leaves one chief', !S.byName[B].lead && S.chiefs.length === 1 && document.querySelectorAll('#agents .pinned .member.chief').length === 1, S.chiefs.map(c => c.name).join(', '));      // error bubbles have × (Storm: "Why are these squall errors still here")
      const errChat = chatById('dm:' + B), em = { who: APP, kind: 'error', text: 'Test error to dismiss' };
      addMessage(errChat, em);
      openChat(errChat.id); await sleep(80);
      const xb = document.querySelector('[data-dismiss="' + em.id + '"]');
      if (xb) xb.click();
      await sleep(60);
      ok('an error bubble has × and dismissing it removes it', !!xb && !errChat.messages.some(m => m.id === em.id), xb ? '' : 'no ×');
      // the model picker on a live session asks Squall Control, since a session can't switch its own model
      const realSend = Bridge.call, sentJobs = [], oldLink = S.link.status, oldPeers = S.link.peers;
      try {
        S.link.status = 'on'; S.link.peers = oldPeers.concat([{ name: 'Squall Control', status: 'idle' }]);
        Bridge.call = (cmd, args) => { if (cmd === 'bridgeSend') { sentJobs.push(String(args && args.text || '')); return Promise.resolve(true); } return realSend(cmd, args); };
        switchLiveModel('claude-opus-5-5');
        await sleep(400);   // relay sends are batched for 150 ms (liveSend), so the job reaches bridgeSend a moment later
      } finally { Bridge.call = realSend; S.link.status = oldLink; S.link.peers = oldPeers; }
      ok('picking a model for a live session asks Squall Control to switch it', sentJobs.some(t => /to Squall Control/.test(t) && /switch the session "/.test(t) && /claude-opus-5-5/.test(t)), sentJobs.length + ' sent');
      // no turn limit any more (Storm, 19 Oct), so the bot menu has no "Long runs" item
      openBotMenu(A, 60, 240);
      ok('the bot menu has no Long runs item (bots have no turn limit)', !!document.querySelector('.bot-menu') && !document.querySelector('.bot-menu [data-botact="long"]'), '');
      closeBotMenu();
      // update ready: a newer staged build shows the chip with a Restart button, an older or equal one shows none; the apply script's plan is right
      showUpdate(await Bridge.call('updateCheck', { name: 'newer' }));
      const chipNew = document.getElementById('update-chip');
      ok('a newer staged build shows the “Update ready” chip with a Restart button', !!chipNew && /Update ready · build 2099/.test(chipNew.textContent) && !!chipNew.querySelector('[data-update="restart"]'), chipNew ? chipNew.textContent.slice(0, 60) : 'no chip');
      showUpdate(await Bridge.call('updateCheck', { name: 'older' }));
      ok('an older or equal build shows no chip', !document.getElementById('update-chip'), '');
      const plan = await Bridge.call('updatePlan', {});
      const planText = ((plan && plan.lines) || []).join('\n');
      ok('the copy plan backs up the exe, DLLs, web and src, copies the staged build in, and never copies team.json', /backup Squall\.exe/.test(planText) && /backup web/.test(planText) && /backup src/.test(planText) && /copy .*Squall\.exe/.test(planText) && /copy .*next.*web/.test(planText) && /copy .*next.*src/.test(planText) && !/copy .*team\.json/.test(planText) && !!plan && plan.exit === 0, (plan ? plan.exit : 'no plan') + ' exit, ' + ((plan && plan.lines) || []).length + ' lines');
      await sleep(250); await Bridge.call('capture', { name: '2-team-chat' });

      document.querySelector('.member[data-chat="dm:' + A + '"]').click();
      ok('clicking an icon opens its own chat', S.active === 'dm:' + A, S.active);
      await say('Any request limits I should know about?');
      const dm = chatById('dm:' + A);
      ok('direct chat: agent replied there', dm.messages.filter(m => m.who === A && m.kind === 'agent').length === 1, dm.messages.length);
      ok('direct chat stays separate from the team chat', !team.messages.some(m => m.who === 'Storm' && /Any request limits/.test(m.text || '')));
      await sleep(200); await Bridge.call('capture', { name: '3-direct-chat' });

      // pasting an image: the host saves it, the message shows it, and the agent gets its path to open
      const L2 = crew[2] ? crew[2].name : A;
      openChat('dm:' + L2);
      const cv = document.createElement('canvas'); cv.width = 96; cv.height = 60;
      const g2 = cv.getContext('2d'); g2.fillStyle = '#a78bfa'; g2.fillRect(0, 0, 96, 60); g2.fillStyle = '#4fe3c1'; g2.fillRect(12, 12, 40, 36);
      const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
      addImageFile(new File([blob], 'test.png', { type: 'image/png' }));
      await waitFor(() => S.attach.length === 1 && !!S.attach[0].path, 10000);
      await sleep(150); await Bridge.call('capture', { name: '3b-image-attached' });
      await say('What is in this image?');
      const im = chatById('dm:' + L2).messages.filter(m => m.who === 'Storm').pop();
      const thumb = document.querySelector('#chat .msg.user .shot');
      let thumbOk = false;
      try { await waitFor(() => !!thumb && thumb.complete && thumb.naturalWidth > 0, 6000); thumbOk = true; } catch (e) { }
      ok('pasted images attach to your message', !!im && (im.images || []).length === 1 && /paste-.*\.png$/i.test(im.images[0].path) && thumbOk, im && JSON.stringify(im.images));
      ok('the agent gets the image path to open', !!im && formatMsg(im).includes(im.images[0].path) && S.attach.length === 0);
      ok('messages have a copy button', !!document.querySelector('#chat .msg .mcopy'));
      const member = document.querySelector('.member[data-chat="dm:' + A + '"]');
      showCard(A, member); await sleep(250);
      const hcard = $('#hovercard');
      ok('hovering a teammate shows its card', !!hcard && hcard.classList.contains('show') && hcard.textContent.includes(A), hcard && hcard.textContent.slice(0, 80));
      await Bridge.call('capture', { name: '3d-hover-card' }); hideCard();
      // the strip rail's hover name: a small flyout to the right of the avatar, at once, fixed to the window so the rail can't clip it
      {
        const body = document.body, hadStrip = body.classList.contains('strip'), hadWide = body.classList.contains('rail-wide');
        body.classList.add('strip'); body.classList.remove('rail-wide');
        await sleep(80);
        const mem = document.querySelector('#agents .member[data-chat="dm:' + A + '"]');
        if (mem && mem.querySelector('.avatar')) {
          const hadTitle = !!mem.title;
          mem.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
          await sleep(60);
          const tip = $('#rail-tip'), ar = mem.querySelector('.avatar').getBoundingClientRect(), tr = tip ? tip.getBoundingClientRect() : { left: 0, top: 0, height: 0, width: 0 };
          const geo = 'avatar right ' + Math.round(ar.right) + ', flyout left ' + Math.round(tr.left) + ', centers ' + Math.round(ar.top + ar.height / 2) + ' / ' + Math.round(tr.top + tr.height / 2);
          ok('the strip rail shows the bot’s name in a flyout at once, to the right of its avatar', !!tip && tip.classList.contains('show') && tip.textContent.includes(A) && tr.left >= ar.right && Math.abs(tr.top + tr.height / 2 - (ar.top + ar.height / 2)) < 8, geo);
          await Bridge.call('capture', { name: '3e-rail-name-flyout' });
          ok('the flyout is fixed to the window (the rail can’t clip it), and the native tooltip steps aside', !!tip && getComputedStyle(tip).position === 'fixed' && !mem.title && (!hadTitle || !!mem.dataset.railTitle), 'position ' + (tip ? getComputedStyle(tip).position : 'none'));
          mem.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
          await sleep(40);
          ok('it goes away when the pointer leaves, and the tooltip text comes back', !!tip && !tip.classList.contains('show') && (!hadTitle || !!mem.title), '');
          body.classList.add('rail-wide');
          mem.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
          await sleep(40);
          ok('the wide rail already writes the names, so it shows no flyout', !tip.classList.contains('show'), '');
          mem.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
          body.classList.remove('rail-wide');
          body.classList.remove('strip');
          mem.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
          await sleep(40);
          ok('outside the strip it does nothing (the normal sidebar keeps its own card)', !tip.classList.contains('show'), '');
          mem.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
        }
        body.classList.toggle('strip', hadStrip); body.classList.toggle('rail-wide', hadWide);
        hideCard(); railTipHide();
      }
      await sleep(200); await Bridge.call('capture', { name: '3c-image-sent' });

      const g = createGroup('Squad', [A, Z]);
      openChat(g.id);
      await sleep(150); await Bridge.call('capture', { name: '4-new-group' });
      const groupRun = say('@' + A + ' ask ' + Z + ' what she thinks about the leaderboard');
      const sawPing = await sawClass('#agents .member[data-chat="dm:' + Z + '"] .av-wrap', /\banim-m\d+\b/, 40000);
      const sawGroupPing = sawPing && /\banim-m\d+\b/.test((document.querySelector('#agents .member[data-chat="' + g.id + '"] .av-wrap') || {}).className || '');
      await groupRun;
      ok('icons: @mentioned teammate and the group icon show messaging', sawPing && sawGroupPing);
      const aMsg = g.messages.find(m => m.who === A && m.kind === 'agent');
      const zMsg = g.messages.find(m => m.who === Z && m.kind === 'agent');
      ok('group: the mentioned agent answered first', !!aMsg, aMsg && aMsg.text);
      ok('group: agents message each other (@ mention)', !!aMsg && aMsg.text.includes('@' + Z) && !!zMsg && g.messages.indexOf(zMsg) > g.messages.indexOf(aMsg), zMsg && zMsg.text);
      ok('group: lead stayed quiet when someone was @mentioned', !g.messages.some(m => m.who === S.lead.name));
      await sleep(250); await Bridge.call('capture', { name: '5-group-chat' });

      openChat('dm:' + B);
      $('#input').value = 'Write a longer version'; send();
      await sleep(500); stopAll();
      await waitFor(idle, 15000);
      ok('stop works', S.byName[B].status === 'stopped', S.byName[B].status);

      const unreadBefore = chatById('team').unread;
      ok('chats keep their own history', chatById('team').messages.length > 3 && chatById('dm:' + A).messages.length === 2 && g.messages.length >= 3, [chatById('team').messages.length, chatById('dm:' + A).messages.length, g.messages.length].join('/'));
      ok('unread counts are tracked', unreadBefore >= 0);
      // Ctrl+F finds words in the open chat, steps through them and paints them without changing the chat's HTML
      openChat('team'); await sleep(250);
      const fWord = ((($('#chat .md') || {}).textContent || '').match(/[A-Za-z]{5,}/) || [''])[0];
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }));
      $('#find-q').value = fWord; findRun(false, true);
      const fHits = FIND.hits.length, fFirst = FIND.i;
      await sleep(150); await Bridge.call('capture', { name: '6b-find' });
      findStep(-1);
      ok('find: Ctrl+F opens the find bar and finds words in the chat', findOpen() && !!fWord && fHits > 0 && / of /.test($('#find-n').textContent) && (!window.CSS || !CSS.highlights || CSS.highlights.has('find')), fWord + ': ' + fHits + ' found, ' + $('#find-n').textContent);
      ok('find: Enter steps to another match', fHits < 2 || FIND.i !== fFirst, fFirst + ' then ' + FIND.i);
      $('#find-q').value = 'zzqxnomatchzz'; findRun(false, true);
      ok('find: a word that isn’t there says No matches', /No matches/.test($('#find-n').textContent) && $('#find').classList.contains('none'), $('#find-n').textContent);
      closeFind();
      ok('find: closing it clears the highlights', !findOpen() && !(window.CSS && CSS.highlights && CSS.highlights.has('find')), '');
      // the reply arrow beside copy quotes a message into the box
      const qBtn = $('#chat [data-quote]');
      $('#input').value = '';
      if (qBtn) quoteMessage(qBtn);
      ok('reply: the arrow beside copy quotes the message into the box', !!qBtn && /^> \S/.test($('#input').value) && /\n\n$/.test($('#input').value), JSON.stringify($('#input').value.slice(0, 80)));
      ok('reply: a long message is cut to a short quote', quoteText('word '.repeat(200)).length < QUOTE_MAX + 12 && /…\n\n$/.test(quoteText('word '.repeat(200))), quoteText('word '.repeat(200)).length + ' characters');
      $('#input').value = ''; $('#input').dispatchEvent(new Event('input', { bubbles: true }));
      // "Try again" on a teammate's failed reply sends Storm's last message again, and his draft stays in the box
      const retryChat = chatById('dm:' + B);
      openChat(retryChat.id); await waitFor(idle, 15000).catch(() => { });
      addMessage(retryChat, { who: 'Storm', kind: 'user', text: 'Retry this please' });
      const rErr = addMessage(retryChat, { who: B, kind: 'error', text: 'Test failure' });
      renderChat(); await sleep(120);
      $('#input').value = 'my unsent draft';
      const rBtn = document.querySelector('#chat [data-retry="' + (rErr && rErr.id) + '"]');
      if (rBtn) rBtn.click();
      await sleep(250);
      const resent = retryChat.messages.filter(x => x.who === 'Storm' && x.text === 'Retry this please').length;
      ok('try again: a teammate’s failed reply has Try again; it sends the last message again and keeps the draft', !!rBtn && resent === 2 && !retryChat.messages.some(x => x === rErr) && $('#input').value === 'my unsent draft', resent + ' sent, draft "' + $('#input').value + '"');
      await waitFor(idle, 30000).catch(() => { });
      $('#input').value = ''; $('#input').dispatchEvent(new Event('input', { bubbles: true }));
      // a long message gets a Summary button; its short version shows under it, and the message keeps it
      const sumMsg = addMessage(retryChat, { who: B, kind: 'agent', text: 'The build is finished and every test passed. ' + 'It changes the voice calls, the echo canceller and the To do list in several small ways that are listed here at length. '.repeat(6) });
      renderChat(); await sleep(100);
      const sumBtn = document.querySelector('#chat [data-sum="m:' + (sumMsg && sumMsg.id) + '"]');
      if (sumBtn) sumBtn.click();
      await waitFor(() => !!(sumMsg && sumMsg.summary), 8000).catch(() => { });
      await sleep(100);
      const sumBox = document.querySelector('#chat [data-k="' + (sumMsg && sumMsg.id) + '"] .sum');
      ok('summary: a long message has a Summary button, and its short version shows under it (and is kept)', !!sumBtn && !!sumBox && /In short/.test(sumBox.textContent) && /In short/.test(sumMsg.summary || ''), sumBox ? sumBox.textContent.slice(0, 80) : 'no summary');
      ok('summary: a short message has no button', sumHTML('m:x', 'Short reply.') === '', '');
      openChat('team'); await sleep(150);
      // a line with the day between messages from different days
      const dlNow = new Date(), dlYest = new Date(Date.now() - 86400000), dlOld = new Date(2026, 0, 5, 12);
      ok('day lines: Today, Yesterday, or the date', dayLabel(dlNow.toISOString()) === 'Today' && dayLabel(dlYest.toISOString()) === 'Yesterday' && /Jan/.test(dayLabel(dlOld.toISOString())), [dayLabel(dlNow.toISOString()), dayLabel(dlYest.toISOString()), dayLabel(dlOld.toISOString())].join(' / '));
      ok('day lines: the open chat shows the day above its messages', /Today|Yesterday|day|\d/.test((document.querySelector('#chat .day-sep') || {}).textContent || ''), (document.querySelector('#chat .day-sep') || {}).textContent || 'none');
      // Ctrl+/ lists every keyboard shortcut on one card
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '/', ctrlKey: true, bubbles: true, cancelable: true }));
      await sleep(150);
      const keyRows = document.querySelectorAll('.keys-modal .keys-row').length;
      if (keyRows) await Bridge.call('capture', { name: '6c-shortcuts' });
      ok('shortcuts: Ctrl+/ shows the keyboard shortcuts card', keyRows >= 8 && /Ctrl\+F|Find/.test(($('.keys-modal') || {}).textContent || ''), keyRows + ' rows');
      closeModal();
      openGroupModal(null); await sleep(200); await Bridge.call('capture', { name: '6-group-modal' }); closeModal();

      // work timer: a continuous one keeps a teammate going until its work runs out; a set one can be stopped by hand
      const tm = chatById('dm:' + A);
      openChat(tm.id);
      startTimer(tm, 'inf');
      await sleep(150);
      ok('work timer: continuous shows on the chip', !!S.timers[tm.id] && S.timers[tm.id].until === Infinity && /Continuous/.test($('#timer').textContent), $('#timer').textContent);
      $('#input').value = 'Start on the leaderboard and keep going'; send();
      ok('work timer: a message keeps a continuous timer going', !!S.timers[tm.id] && S.timers[tm.id].until === Infinity, '');
      await waitFor(() => tm.messages.some(m => /Push harder/.test(m.text || '')), 90000).catch(() => { });
      const tmEvents = tm.messages.map(m => m.text || '');
      ok('work timer: a turn that finishes right away pushes the teammate harder, and the timer keeps going', !!S.timers[tm.id] && tmEvents.some(t => /Work timer: Continuous/.test(t)) && tmEvents.some(t => /Push harder/.test(t)) && !tmEvents.some(t => /kept finishing right away/.test(t)), tmEvents.slice(-3).join(' | '));
      stopTimer(tm.id, true);   // Storm stops it by hand, as he would
      // a queued message is not cut to one small line (Storm: "Make a queued message not restricted to be small")
      let longQ = '';
      try { longQ = queuedHTML({ status: { queue: ['word '.repeat(150)] }, pending: [] }); } catch (e) { longQ = 'ERR ' + e.message; }
      ok('queued: a long queued message shows in full, not cut to one line', longQ.indexOf('…') < 0 && longQ.length > 700 && /q-item/.test(longQ), longQ.length + ' characters of HTML');
      startTimer(tm, 5);
      await sleep(100);
      ok('work timer: a set timer shows the time left', !!S.timers[tm.id] && /left/.test($('#timer').textContent), $('#timer').textContent);
      stopTimer(tm.id, true);
      await sleep(100);
      ok('work timer: stopping clears the chip', !S.timers[tm.id] && !/left|Continuous/.test($('#timer').textContent), $('#timer').textContent);
      // the judge: the chip under the send bar turns it on and off, and the host's judge command gives a verdict
      const judgeWas = !!S.judge;
      $('#judge').click(); await sleep(50);
      const judgeFlip = !!S.judge !== judgeWas && /Judge: (on|off)/.test($('#judge').textContent);
      $('#judge').click(); await sleep(50);
      const jv = await Bridge.call('judge', { ask: 'What is 2 + 2?', reply: '', bot: 'Tide' }).catch(e => ({ err: e.message }));
      ok('judge: the toggle under the send bar flips it, and an empty reply is sent back', judgeFlip && !!S.judge === judgeWas && jv.verdict === 'retry', (jv.err || jv.verdict || '') + ' · ' + $('#judge').textContent);
      // pause_timer was removed (Storm, 19 Oct): an old block does nothing, and the timer keeps going
      startTimer(tm, 'inf');
      await doAction({ do: 'pause_timer' }, tm, 'Tide', false);
      ok('work timer: an old pause_timer block no longer pauses it', !!S.timers[tm.id] && !S.timers[tm.id].paused && !/pause_timer/.test(timerNote(S.timers[tm.id])), '');
      stopTimer(tm.id, true);
      // timer_wait (Storm, 23 Oct: "Make a Squall feature for bots to make the timer pause for up to 10 mins"): a bot holds its timer, 10 minutes at most
      startTimer(tm, 'inf');
      await doAction({ do: 'timer_wait', minutes: 30, why: 'a long test' }, tm, 'Tide', false);
      const tw = S.timers[tm.id], heldMin = tw && tw.holdUntil ? Math.round((tw.holdUntil - Date.now()) / 60000) : 0;
      renderTimerChip();
      ok('work timer: timer_wait holds it for at most 10 minutes, the chip says who holds it, and every nudge tells the bots how', heldMin === 10 && /Held by Tide/.test($('#timer').textContent) && /timer_wait/.test(timerNote(tw)), heldMin + ' min · ' + $('#timer').textContent);
      // (the hold itself is judged by timerHeld: the test chat's own bot may be mid-turn here, which by design ends a hold)
      const hNow = Date.now();
      tw.holdIdle = false;
      const heldThroughOwnTurn = timerHeld(tw, true, hNow);              // the turn that asked for the hold is still running: held
      const heldIdle = timerHeld(tw, false, hNow);                       // idle: held (and now seen idle)
      const letGoWorking = !timerHeld(tw, true, hNow);                   // working again after that: let go
      ok('work timer: a hold survives the turn that asked for it, waits while the chat is idle, and lets go once the bot works again or it runs out',
         heldThroughOwnTurn && heldIdle && letGoWorking && !timerHeld(tw, false, tw.holdUntil + 1), JSON.stringify({ heldThroughOwnTurn, heldIdle, letGoWorking }));
      tw.holdUntil = Date.now() - 1; timerWatchTick();
      ok('work timer: when the hold runs out the timer picks up again, and its next nudge is not "push harder"', !tw.holdUntil && tw.afterHold === true && tw.busySeen === true && !/Held/.test($('#timer').textContent), JSON.stringify({ h: tw.holdUntil, a: tw.afterHold, b: tw.busySeen }) + ' · ' + $('#timer').textContent);
      stopTimer(tm.id, true);
      // running timers are saved, so they carry on after a restart
      startTimer(tm, 'inf');
      const savedCalls = [], realCall2 = Bridge.call;
      Bridge.call = (cmd, args) => { if (cmd === 'saveState') savedCalls.push(args); return realCall2(cmd, args); };
      try { await saveNow(); } finally { Bridge.call = realCall2; }
      const savedT = savedCalls.length ? ((savedCalls[0].state || {}).timers || {})[tm.id] : null;
      ok('work timer: a running timer is saved for after a restart', !!savedT && savedT.until === 'inf', JSON.stringify(savedT));
      stopTimer(tm.id, true);
      // a missed "turn ended" event can't stall the timer: the chat goes idle after work, and the watch nudges on its own
      startTimer(tm, 'inf');
      S.timers[tm.id].busySeen = true;
      const nudgesBefore = tm.messages.length;
      await waitFor(() => tm.messages.slice(nudgesBefore).some(m => m.kind === 'event' && /Work timer: Continuous/.test(m.text || '')), 20000).catch(() => { });
      ok('work timer: nudges by itself once the chat goes idle, with no turn-end event', tm.messages.slice(nudgesBefore).some(m => m.kind === 'event' && /Work timer: Continuous/.test(m.text || '')), '');
      stopTimer(tm.id, true);
      await sleep(200); await Bridge.call('capture', { name: '6b-work-timer' });
      await waitFor(idle, 60000).catch(() => { });

      // voice, offline and open source (Vosk listens, Piper speaks; Storm: "Get the dictation and voice call working").
      // First a real round trip with no microphone: Piper says a phrase into a sound file, and the same Vosk recognizer hears it back.
      const rt = await Bridge.call('voiceTest', { phrase: 'hello squall please check the timer' }).catch(e => ({ heard: '', err: e.message }));
      ok('voice: offline round trip, Piper speaks and Vosk hears it back', /hello/.test(rt.heard || '') && /timer/.test(rt.heard || ''), (rt.heard || rt.err || '') + (rt.seconds ? ' · ' + rt.seconds + ' s' : ''));
      // then the page's two modes, fed what the host would hear (the test window never opens the real microphone)
      openChat(tm.id);
      $('#input').value = ''; autosize();
      const fakeOn = mode => { voiceOn = true; voiceMode = mode; voiceBase = ''; voiceReady = false; clearInterval(voiceTimer); voiceTimer = setInterval(voiceTick, 500); if (mode === 'call') callOpen(); renderVoice(); };
      fakeOn('dictate');
      ok('dictation: the mic button lights up, the phone button doesn’t', $('#voice').classList.contains('on') && !$('#call').classList.contains('on'), '');
      voiceHeard('partial', 'hello th');
      ok('dictation: speech shows in the box as it is heard', $('#input').value === 'hello th', $('#input').value);
      const d0 = tm.messages.length;
      voiceHeard('final', 'hello there');
      await sleep(700);
      ok('dictation: a finished phrase stays in the box and isn’t sent', $('#input').value === 'hello there' && !tm.messages.slice(d0).some(m => m.who === 'Storm' && m.text === 'hello there'), $('#input').value);
      voiceStop(true);
      $('#input').value = ''; autosize();
      fakeOn('call');
      ok('voice call: the phone button lights up, the mic button doesn’t', $('#call').classList.contains('on') && !$('#voice').classList.contains('on'), '');
      // the call screen (Storm: "It doesn't pull up any visual voice chat")
      await sleep(80);
      const cui = $('#call-ui');
      ok('voice call: the call screen opens with the bot, its state and Hang up', !!cui && !!cui.querySelector('.call-orb .avatar') && !!cui.querySelector('.call-end') && /Listening/.test(cui.querySelector('.call-state').textContent), cui ? cui.querySelector('.call-state').textContent : 'no screen');
      ok('voice call: the call screen says you can end it by saying hang up', !!cui && /hang up/i.test((cui.querySelector('.call-tip') || {}).textContent || ''), '');
      voiceHeard('partial', 'run the');
      ok('voice call: what you say shows on the call screen, not in the message box', /run the/.test((cui && cui.querySelector('.call-heard').textContent) || '') && $('#input').value === '', $('#input').value);
      const c0 = tm.messages.length;
      voiceHeard('final', 'run the checks');
      await waitFor(() => tm.messages.slice(c0).some(m => m.who === 'Storm' && m.text === 'run the checks'), 5000).catch(() => { });
      ok('voice call: a finished phrase is sent like Enter', tm.messages.slice(c0).some(m => m.who === 'Storm' && m.text === 'run the checks'), '');
      await waitFor(idle, 60000).catch(() => { });
      const callShown = ((cui && cui.querySelector('.call-reply').textContent) || '').trim();
      ok('voice call: the reply shows on the call screen', callShown.length > 0, callShown.slice(0, 60));
      $('#input').value = 'a turn to keep busy'; send();
      voiceHeard('final', 'held phrase');
      ok('voice call: a phrase said while a reply is pending waits in the box', $('#input').value === 'held phrase' && !tm.messages.some(m => m.who === 'Storm' && m.text === 'held phrase'), $('#input').value);
      await waitFor(() => tm.messages.some(m => m.who === 'Storm' && m.text === 'held phrase'), 30000).catch(() => { });
      ok('voice call: the held phrase is sent once the reply is in', tm.messages.some(m => m.who === 'Storm' && m.text === 'held phrase'), '');
      await waitFor(idle, 60000).catch(() => { });
      voiceStop(true);
      await sleep(350);
      ok('voice call: hanging up turns the phone button off and closes the call screen', !$('#call').classList.contains('on') && !voiceOn && !document.querySelector('.call-ui'), '');
      ok('voice call: hanging up writes a short summary into the chat (length and phrases)', tm.messages.slice(-12).some(m => /Voice call ended · \d+:\d\d · \d+ phrases? sent/.test(m.text || '')), tm.messages.slice(-2).map(m => m.text || '').join(' | '));
      // the call screen shows the reply as it's written, then the finished reply; nothing is read aloud (Storm: "Remove the text to
      // speech voice from voice chat I don't like it")
      openChat('dm:' + A); await sleep(40);
      fakeOn('call'); await sleep(40);
      const sAgent = S.byName[A], replyBox = () => ((document.querySelector('#call-ui .call-reply') || {}).textContent || '');
      const realAudio = window.Audio;
      let played = 0;
      window.Audio = function () { played++; return { play: () => Promise.resolve(), pause: () => { } }; };
      let speakCalls = 0;
      const realCall = Bridge.call;
      Bridge.call = function (name, args) { if (name === 'speak') speakCalls++; return realCall.apply(this, arguments); };
      callStreamFeed(sAgent, 'First sentence. Sec');
      const streamed = replyBox();
      callReply('First sentence. Second **sentence**. Third part');
      const finished = replyBox();
      await sleep(200);
      Bridge.call = realCall; window.Audio = realAudio;
      ok('voice call: the reply shows on the call screen as it streams, then in full', streamed === 'First sentence. Sec' && finished === 'First sentence. Second sentence. Third part', JSON.stringify([streamed, finished]));
      ok('voice call: nothing is read aloud (no text to speech, no audio played)', speakCalls === 0 && played === 0, speakCalls + ' speak call(s), ' + played + ' sound(s)');
      voiceStop(true);
      await sleep(300);      ok('voice: no Windows speech engine is used any more', !/speechSynthesis|SpeechRecognition/.test(String(voiceStart) + String(callReply) + String(voiceStop)), '');
      // calls use Squall's own echo canceller (the browser's and its noise suppression stay off, so the canceller learns the plain mic);
      // with it switched off, the browser's comes back for calls; dictation never cancels echo
      const echoWas = S.echoOwn;
      S.echoOwn = true;
      const ownCall = micConstraints('call').audio, dict = micConstraints('dictate').audio;
      S.echoOwn = false;
      const browserCall = micConstraints('call').audio;
      S.echoOwn = echoWas;
      ok('voice: calls and dictation both use Squall’s own echo canceller and noise filter (the browser’s are off)', ownCall.echoCancellation === false && ownCall.noiseSuppression === false && browserCall.echoCancellation === true && dict.echoCancellation === false && dict.noiseSuppression === false, JSON.stringify([ownCall, browserCall, dict]));
      const echoRun = await Bridge.call('echoTest').catch(e => ({ err: e.message }));
      ok('echo: Squall’s own canceller finds the speakers in a test room and takes their sound out (15 dB or more)', echoRun.db >= 15 && 2037 - (echoRun.delay || 0) >= 32 && 2037 - (echoRun.delay || 0) <= 1024, echoRun.err || (echoRun.db + ' dB, delay ' + echoRun.delay + ' samples, moved ' + echoRun.moves + ' time(s)'));
      ok('echo: the call screen shows how much speaker sound it takes out', echoLine({ on: true, learned: true, db: 24 }) === 'Speakers −24 dB' && /quiet/.test(echoLine({ on: false })) && /learning/.test(echoLine({ on: true, learned: false, db: 0 })), '');
      const gameVoice = (await Bridge.call('gameCheck').catch(() => false)) === true;   // during a game the warm server rightly stays off and whisper-cli writes the words
      // Whisper (downloaded with Vosk; Storm: "Download both and use Vosk first"): a real offline round trip, then the page swapping Vosk's words for Whisper's
      const wt = await Bridge.call('whisperTest', { phrase: 'please check the leaderboard script' }).catch(e => ({ heard: '', err: e.message }));
      ok('voice: Whisper writes down what Piper said, offline', /leaderboard/i.test(wt.heard || '') && /script/i.test(wt.heard || ''), (wt.heard || wt.err || '') + (wt.seconds ? ' · ' + wt.seconds + ' s' : ''));
      // the warm server (Storm: "fix the dictation"): the same phrase written down by whisper-server, with the model already loaded
      const wsv = await Bridge.call('whisperServerTest', { phrase: 'please check the leaderboard script' }).catch(e => ({ heard: '', err: e.message }));
      ok(gameVoice ? 'voice: a game is running, so the warm Whisper server stays off and whisper-cli writes the phrase' : 'voice: the warm Whisper server writes the phrase down (it took the phrase itself)', /leaderboard/i.test(wsv.heard || '') && (gameVoice ? wsv.server !== true : wsv.server === true), (wsv.heard || wsv.err || '') + (wsv.seconds ? ' · ' + wsv.seconds + ' s' : '') + (wsv.server === true ? ' · from the server' : ' · not from the server'));
      // calls write each phrase with warm Parakeet (the helper process Squall starts): the model loads once, then a phrase takes about a second
      if (!gameVoice) {
        const pkw = await Bridge.call('parakeetWarmTest', { phrase: 'tell obsidian to update the notes' }).catch(e => ({ heard: '', err: e.message }));
        if (!pkw.skipped) ok('voice: warm Parakeet writes a call’s phrase down, the second time in a few seconds', /obsidian/i.test(pkw.heard || '') && /update the notes/i.test(pkw.heard || '') && pkw.seconds < 5, (pkw.heard || pkw.err || '') + ' · first ' + pkw.loadSeconds + ' s, then ' + pkw.seconds + ' s · ' + (pkw.note || ''));
      }
      // the dictation path end to end (Storm: "the voice dictation accuracy is so bad"): Piper says the phrase in place of the microphone, the chunks
      // go through the host as the mic's do, Vosk finds the phrase, the warm server writes each phrase down (voiceFix), and the five-pass vote follows
      const dfix = [], dfull = [];
      Bridge.on('voiceFix', m => dfix.push(m));
      Bridge.on('voiceFull', m => dfull.push(m));
      const dtest = await Bridge.call('dictationTest', { phrase: 'please check the leaderboard script' }).catch(e => ({ err: e.message }));
      await waitFor(() => dfix.length >= Math.max(1, dtest.phrases || 0), 30000).catch(() => { });   // each phrase's words
      const dcheck = await Bridge.call('dictationCheck').catch(() => ({}));   // read once the words are in: what the server wrote
      await waitFor(() => dfull.length > 0, 90000).catch(() => { });   // the five-pass vote
      const dtext = dfix.map(m => m.text || '').concat(dfull.map(m => m.text || '')).join(' | ');
      ok(gameVoice ? 'dictation, end to end during a game: Vosk hears the phrase, whisper-cli writes it down (the server stays off), and the vote follows' : 'dictation, end to end: Vosk hears the phrase, the warm server writes it down, and the vote follows', /leaderboard/i.test(dtext) && (gameVoice ? (dcheck.serverTakes || 0) === 0 : (dcheck.serverTakes || 0) > 0) && dfull.length > 0, (dtest.err || dtext || 'no words') + ' · ' + (dtest.phrases || 0) + ' phrase(s), ' + (dcheck.serverTakes || 0) + ' from the server · server: ' + (dcheck.note || ''));
      // with Parakeet installed: Whisper still writes each phrase (the warm server), and Parakeet writes the final words, which win
      const pkAvail = await Bridge.call('voiceEngines').catch(() => ({}));
      if (pkAvail && pkAvail.parakeet) {
        const pfix = [], pfull = [];
        Bridge.on('voiceFix', m => pfix.push(m));
        Bridge.on('voiceFull', m => pfull.push(m));
        const ptest = await Bridge.call('dictationTest', { phrase: 'please check the leaderboard script', parakeet: true }).catch(e => ({ err: e.message }));
        await waitFor(() => pfull.length > 0, 120000).catch(() => { });
        const pf = pfull[0] || {};
        ok('dictation with Parakeet: Whisper writes each phrase, then Parakeet writes the final words', ptest.parakeet === true && pf.by === 'Parakeet' && /leaderboard/i.test(pf.text || '') && pfix.length > 0, (ptest.err || '') + 'final by ' + (pf.by || 'none') + ': "' + (pf.text || '') + '" · ' + pfix.length + ' phrase(s) by Whisper');
      } else ok('dictation with Parakeet: not installed in this copy, so skipped', true, '');
      $('#input').value = ''; autosize();
      fakeOn('dictate');
      voiceHeard('final', 'do to', 901);
      const wBefore = $('#input').value;
      voiceFix(901, 'Do two.');
      ok('Whisper: its words replace what Vosk heard in the box', wBefore === 'do to' && $('#input').value === 'Do two.', wBefore + ' → ' + $('#input').value);
      voiceHeard('partial', 'and th');
      voiceHeard('final', 'and then', 902);
      voiceFix(902, 'And then.');
      ok('Whisper: a second phrase is swapped too, the first one stays', $('#input').value === 'Do two. And then.', $('#input').value);
      // noise and made-up words stay out (Storm: "Bro you gotta fix the dictation now"): a Whisper take that says other words is not swapped in
      voiceHeard('final', 'supporters', 920);
      voiceFix(920, 'Saponis');
      ok('dictation: a Whisper take that says other words is left out, Vosk’s words stay', $('#input').value.endsWith('supporters') && !/Saponis/.test($('#input').value), $('#input').value);
      // a take that sounds like what Vosk heard is trusted even when few words match (the 19:23 call: Vosk's guess was sent instead)
      ok('dictation: Whisper’s words replace Vosk’s rough guess when they sound alike', trustTake('Just the background noise.', 'this the bag that noise') && trustTake('is the voice of each working directly.', 'is the more you can i was incorrectly'), [sameSounds('Just the background noise.', 'this the bag that noise'), sameSounds('is the voice of each working directly.', 'is the more you can i was incorrectly')].map(x => x.toFixed(2)).join(' / '));
      ok('dictation: Whisper’s filler over noise stays out', !trustTake('Yeah, yeah.', 'you') && !trustTake('Thank you.', 'the') && trustTake('Yes.', 'yes'), '');
      $('#input').value = 'please check the leaderboard'; autosize();
      voiceFulls[930] = { pre: '', after: 'please check the leaderboard' };
      voiceFullPass(930, 'Lapornas. Okay. Yeah.');
      ok('dictation: a five-pass result that says other words is left out', $('#input').value === 'please check the leaderboard', $('#input').value);
      voiceFulls[931] = { pre: '', after: 'please check the leaderboard' };
      voiceFullPass(931, 'Please check the leaderboard script.');
      ok('dictation: a five-pass result that says the same words replaces the box', $('#input').value === 'Please check the leaderboard script.', $('#input').value);
      voiceStop(true);
      $('#input').value = ''; autosize();
      await waitFor(idle, 60000).catch(() => { });
      fakeOn('call');
      const w0 = tm.messages.length;
      S.callWait = false;   // the fastest position: the phrase is sent at once
      voiceHeard('final', 'check the timer', 903);
      await waitFor(() => tm.messages.slice(w0).some(m => m.who === 'Storm' && m.text === 'check the timer'), 2000).catch(() => { });
      ok('voice call: a finished phrase is sent at once, with no wait for Whisper', tm.messages.slice(w0).some(m => m.who === 'Storm' && m.text === 'check the timer'), tm.messages.slice(w0).filter(m => m.who === 'Storm').map(m => m.text).join(' | '));
      // accurate words (Storm, “Calls: Prioritize accurate words”, 2026-10-18): the phrase waits up to 1.5 s for Whisper's take, then goes
      S.callWait = true;
      const cw0 = tm.messages.length;
      voiceHeard('final', 'check the logs', 940);
      await sleep(300);
      const heldForFix = !tm.messages.slice(cw0).some(m => m.who === 'Storm');
      voiceFix(940, 'Check the logs.');
      await waitFor(() => tm.messages.slice(cw0).some(m => m.who === 'Storm' && m.text === 'Check the logs.'), 3000).catch(() => { });
      ok('voice call, accurate words: the phrase waits for Whisper’s words, then is sent', heldForFix && tm.messages.slice(cw0).some(m => m.who === 'Storm' && m.text === 'Check the logs.'), tm.messages.slice(cw0).filter(m => m.who === 'Storm').map(m => m.text).join(' | '));
      await waitFor(idle, 60000).catch(() => { });
      const cw1 = tm.messages.length;
      voiceHeard('final', 'check the timer again', 942);
      await waitFor(() => tm.messages.slice(cw1).some(m => m.who === 'Storm' && m.text === 'check the timer again'), CALL_WAIT_MS + 2500).catch(() => { });
      ok('voice call, accurate words: no Whisper take in time, so Vosk’s words are sent after 6 s', tm.messages.slice(cw1).some(m => m.who === 'Storm' && m.text === 'check the timer again'), tm.messages.slice(cw1).filter(m => m.who === 'Storm').map(m => m.text).join(' | '));
      await waitFor(idle, 60000).catch(() => { });
      S.callWait = true;
      await waitFor(idle, 60000).catch(() => { });
      voiceStop(true);
      await sleep(200);
      S.voiceEngine = 'vosk';
      openSettings(); await sleep(120);
      const veBtn = document.querySelector('[data-s="voiceengine"]');
      ok('Settings has a speech-to-text switch, Vosk by default', !!veBtn && veBtn.textContent.trim() === 'Vosk', veBtn ? veBtn.textContent : 'no button');
      if (veBtn) veBtn.click();
      await sleep(150);
      const veBtn2 = document.querySelector('[data-s="voiceengine"]');
      const pkOn = !!(S.voiceAvail && S.voiceAvail.parakeet);   // with Parakeet installed the switch goes Vosk → Parakeet → Whisper → Vosk
      ok('the switch turns ' + (pkOn ? 'Parakeet' : 'Whisper') + ' on and says what it does', S.voiceEngine === (pkOn ? 'parakeet' : 'whisper') && !!veBtn2 && (pkOn ? /Parakeet/ : /Whisper/).test(veBtn2.textContent) && (pkOn ? /three passes/ : /five passes/).test(veBtn2.parentElement.textContent), veBtn2 ? veBtn2.parentElement.textContent.slice(0, 120) : '');
      for (let i = 0; i < 3 && S.voiceEngine !== 'vosk'; i++) { const vb = document.querySelector('[data-s="voiceengine"]'); if (vb) vb.click(); await sleep(150); }
      closeModal();
      ok('the switch goes back to Vosk', S.voiceEngine === 'vosk', S.voiceEngine);
      S.voiceEngine = 'whisper';
      S.voiceEngineSet = false;   // the toggles above counted as Storm's pick: the self-test leaves the default (Whisper on) for next time
      const vEng = await Bridge.call('voiceEngines').catch(() => ({}));
      ok('voice: Squall knows which engines are installed (Whisper now; Parakeet once downloaded)', vEng.whisper === true && typeof vEng.parakeet === 'boolean', JSON.stringify(vEng));
      S.voiceAvail = vEng; openSettings(); await sleep(100);
      const vSec = (document.querySelector('[data-s="voiceengine"]') || {}).parentElement;
      ok('voice: Settings offers Parakeet, or says how to add it', vEng.parakeet ? !!vSec && /Parakeet/.test(vSec.textContent) : /Parakeet \(NVIDIA, 669 MB\)/.test((document.querySelector('.set-modal') || {}).textContent || ''), '');
      closeModal();      // dictation's last pass: Whisper over the whole recording replaces the dictated text, unless Storm edited the box meanwhile
      $('#input').value = 'Notes: low obsidian check the log'; voiceFulls[960] = { pre: 'Notes:', after: 'Notes: low obsidian check the log' };
      const fullOk = voiceFullPass(960, 'Yo Obsidian, check the log.');
      ok('dictation: the last pass over the whole recording replaces the dictated part', fullOk && $('#input').value === 'Notes: Yo Obsidian, check the log.', $('#input').value);
      $('#input').value = 'Storm edited this'; voiceFulls[961] = { pre: '', after: 'something else' };
      ok('dictation: the last pass leaves the box alone if Storm edited it', !voiceFullPass(961, 'Whisper text') && $('#input').value === 'Storm edited this', $('#input').value);
      $('#input').value = ''; autosize();
      // spoken messages are labelled for the bot (Storm: "voice chat should tell the bot that I'm using voice chat and to account for misspelling
      // or weird words"), and dictation never sends by itself while a call does (Storm: "Make sure voice dictation doesn't send the message immediately but voice chat does")
      openChat('dm:' + A); await sleep(60);
      const vdm = chatById('dm:' + A);
      clearChat(vdm);
      $('#input').value = ''; autosize();
      fakeOn('dictate');
      const vd0 = vdm.messages.length;
      voiceHeard('final', 'check the logs', 911); voiceFix(911, 'Check the logs.');
      voiceHeard('final', 'and the timer');
      await sleep(1300);
      ok('dictation: several phrases (and Whisper’s fixes) stay in the box; nothing is sent until Enter', vdm.messages.length === vd0 && /Check the logs\. and the timer/.test($('#input').value), $('#input').value);
      voiceStop(true);
      const runPrompts = [], realCallV = Bridge.call;
      Bridge.call = (cmd, args) => { if (cmd === 'run') runPrompts.push((args && args.prompt) || ''); return realCallV(cmd, args); };
      try {
        send(); await sleep(50); await waitFor(idle, 60000).catch(() => { });
        const dictMsg = vdm.messages.filter(m => m.who === 'Storm').pop();
        ok('dictation: a dictated message is marked as voice, and the bot is told to allow for misheard words', !!dictMsg && dictMsg.voice === 'dictated' && runPrompts.some(pr => /said this by voice/.test(pr)), dictMsg ? String(dictMsg.voice) : 'no message');
        const typedBefore = runPrompts.length;
        $('#input').value = 'a typed message'; send(); await sleep(50); await waitFor(idle, 60000).catch(() => { });
        const typedMsg = vdm.messages.filter(m => m.who === 'Storm').pop();
        ok('a typed message isn’t marked as voice', !!typedMsg && typedMsg.text === 'a typed message' && !typedMsg.voice && !runPrompts.slice(typedBefore).some(pr => /said this by voice/.test(pr)), typedMsg ? String(typedMsg.voice) : '');
        fakeOn('call');
        voiceHeard('final', 'run the build');
        await waitFor(() => vdm.messages.some(m => m.who === 'Storm' && m.text === 'run the build'), 5000).catch(() => { });
        const callMsg = vdm.messages.filter(m => m.who === 'Storm').pop();
        ok('voice call: the phrase is sent right away, marked as voice', !!callMsg && callMsg.text === 'run the build' && callMsg.voice === 'call', callMsg ? callMsg.text + ' / ' + callMsg.voice : '');
        await waitFor(idle, 60000).catch(() => { });
        voiceStop(true);
      } finally { Bridge.call = realCallV; }
      const realLiveSend = liveSend, mirSent = [], linkSaved = S.link.status;
      liveSend = (n, txt) => { mirSent.push(txt); return Promise.resolve({ ok: true }); };
      try { S.link.status = 'on'; sendToMirror(chatById('dm:Laptop') || vdm, 'hello by voice', [], [], undefined, undefined, 'call'); await sleep(30); }
      finally { liveSend = realLiveSend; S.link.status = linkSaved; }
      ok('a live session is told too when Storm talks by voice', mirSent.some(x => /hello by voice/.test(x) && /said this by voice/.test(x)), (mirSent[0] || '').slice(0, 120));
      clearChat(vdm);
      // the right pane lists only subagents and workflows running or finished in the last 10 minutes
      const fakeMi = { status: { runs: [
        { id: 'r1', kind: 'agent', title: 'Old finished run', status: 'done', started: new Date(Date.now() - 30 * 60000).toISOString(), ended: new Date(Date.now() - 20 * 60000).toISOString() },
        { id: 'r2', kind: 'agent', title: 'Recent finished run', status: 'done', started: new Date(Date.now() - 5 * 60000).toISOString(), ended: new Date(Date.now() - 2 * 60000).toISOString() },
        { id: 'r3', kind: 'workflow', title: 'Running workflow', status: 'running', started: new Date(Date.now() - 60 * 60000).toISOString(), ended: '' }] } };
      const rh = runsHTML(fakeMi);
      ok('the right pane shows only runs running or finished in the last 10 minutes', !/Old finished run/.test(rh) && /Recent finished run/.test(rh) && /Running workflow/.test(rh), '');
      // usage through Squall Control: its USAGE line fills the usage chip
      const usage0 = S.usage;
      onInbound('Squall Control', 'USAGE {"status":"ok","plan":"Max","windows":[{"label":"5-hour limit","percentUsed":19,"resetsIn":"3h 21m"},{"label":"Weekly · all models","percentUsed":14,"resetsIn":"6d 1h"}]}');
      await sleep(30);
      ok('usage: Squall Control’s report fills the usage chip', !!S.usage && S.usage.windows.length === 2 && S.usage.windows[0].percentUsed === 19 && !/not connected/.test($('#usage').textContent), $('#usage').textContent);
      // usage straight from Claude (Storm: "get it another way like straight from Claude not a session"): a run's rate_limit_event line fills the chip
      const usageSrc0 = S.usageSrc, nowS = Math.floor(Date.now() / 1000);
      onBridgeLine({ line: JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', isUsingOverage: false, unifiedWindows: { five_hour: { utilization: 0.42, resetsAt: nowS + 2 * 3600 + 5 * 60 }, seven_day: { utilization: 0.15, resetsAt: nowS + 6 * 86400 } } } }) });
      await sleep(30);
      ok('usage: Claude’s own rate-limit line fills the usage chip, no session needed', S.usageSrc === 'claude' && /5h 42%/.test($('#usage').textContent) && /resets in 2h [45]m/.test($('#usage').textContent), $('#usage').textContent);
      $('#usage').click(); await sleep(80);
      const usePop = document.querySelector('.use-pop');
      ok('usage: the usage menu shows the 5-hour and weekly windows', !!usePop && /5-hour limit/.test(usePop.textContent) && /42%/.test(usePop.textContent) && /Weekly · all models/.test(usePop.textContent) && /15%/.test(usePop.textContent), usePop ? usePop.textContent.slice(0, 140) : 'no menu');
      closeUsageMenu();
      usageRefresh(); await sleep(60);
      ok('usage: the minute refresh keeps Claude’s reading', S.usageSrc === 'claude' && /5h 42%/.test($('#usage').textContent), $('#usage').textContent);
      onBridgeLine({ line: JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.9, resetsAt: nowS - 60 }, seven_day: { utilization: 0.16, resetsAt: nowS + 6 * 86400 } } } }) });
      await sleep(30);
      ok('usage: a window whose reset time has passed shows 0%, with no prediction left over from the old window', /5h 0%/.test($('#usage').textContent) && !/at reset|runs out/.test($('#usage').textContent), $('#usage').textContent);
      // where the 5-hour window lands at its reset (Storm: "I want it to say what percentage I'll be at when it resets")
      S.usageHist = [{ t: Date.now() - 20 * 60000, p: 30 }];
      onBridgeLine({ line: JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.34, resetsAt: nowS + 3600 }, seven_day: { utilization: 0.16, resetsAt: nowS + 6 * 86400 } } } }) });
      await sleep(30);
      ok('usage: the chip says where the 5-hour window lands at its reset', /~4[56]% at reset/.test($('#usage').textContent), $('#usage').textContent);
      $('#usage').click(); await sleep(60);
      const usePop2 = document.querySelector('.use-pop');
      ok('usage: the menu says it in words', !!usePop2 && /you’ll be at about 4[56]% when it resets/.test(usePop2.textContent), usePop2 ? usePop2.textContent.slice(-90) : 'no menu');
      closeUsageMenu();
      S.usageHist = [{ t: Date.now() - 12 * 60000, p: 80 }];   // past the 10-minute minimum the pace needs
      onBridgeLine({ line: JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.95, resetsAt: nowS + 3600 }, seven_day: { utilization: 0.2, resetsAt: nowS + 6 * 86400 } } } }) });
      await sleep(30);
      ok('usage: if it would run out first, the chip says when instead', /runs out in \d+ min/.test($('#usage').textContent), $('#usage').textContent);
      // a minute of readings right after a reset predicts nothing (it had throttled the team at 4%)
      S.usageHist = [{ t: Date.now() - 60000, p: 1 }];
      onBridgeLine({ line: JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.04, resetsAt: nowS + 4 * 3600 }, seven_day: { utilization: 0.2, resetsAt: nowS + 6 * 86400 } } } }) });
      await sleep(30);
      ok('usage: a minute of readings makes no prediction and doesn’t throttle', !usagePace().ready && !/runs out|Throttled/.test($('#usage').textContent), $('#usage').textContent);
      S.usageHist = [];
      // the weekly limit gets its own prediction (Storm: "Make it predict the weekly limit too"): from this week's readings, in the chip and the menu
      const wkReset = new Date((nowS + 4 * 86400) * 1000).toISOString();
      S.usageHist7 = [{ t: Date.now() - 6 * 3600000, p: 10, reset: wkReset }];
      onBridgeLine({ line: JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.3, resetsAt: nowS + 3600 }, seven_day: { utilization: 0.14, resetsAt: nowS + 4 * 86400 } } } }) });
      const wkChip = $('#usage').textContent;
      ok('usage: the chip shows the week now and where it lands at reset', /week 14% → ~\d+%/.test(wkChip), wkChip);
      S.throttleTest = true; renderUsage();
      ok('throttle: on track to run out, the chip says Throttled and the bots are told to keep turns short', /Throttled/.test($('#usage').textContent) && /throttled/.test(usageForBots()), $('#usage').textContent);
      S.throttleTest = false; renderUsage();
      const wp7t = weekPace();
      ok('usage: the weekly prediction uses this week’s readings (six hours of them)', !!wp7t && wp7t.ready && wp7t.atReset > 14 && wp7t.atReset < 100, wp7t ? JSON.stringify({ ready: wp7t.ready, atReset: wp7t.atReset }) : 'none');
      ok('usage: each new reading of the week is kept, so the pace survives a restart', S.usageHist7.length >= 2 && S.usageHist7[S.usageHist7.length - 1].p === 14, String(S.usageHist7.length));
      // a week that sits at one reading counts down (Chief, 23 Oct: the bots were told "1h 8m" every time while the week sat at 99%): from the FIRST reading at 99, not the newest
      const mAgo = m => Date.now() - m * 60000;
      S.usageHist7 = [{ t: mAgo(3000), p: 50, reset: wkReset }, { t: mAgo(120), p: 98, reset: wkReset }].concat([60, 45, 30, 15, 0].map(m => ({ t: mAgo(m), p: 99, reset: wkReset })));
      const wpFlat = weekPace(), wantIn = 1 / ((99 - 50) / 3000) - 60;
      ok('usage: a week sitting at 99% counts down from when it got there', !!wpFlat && wpFlat.ready && Math.abs(wpFlat.hitIn - wantIn) < 0.5, wpFlat ? Math.round(wpFlat.hitIn * 10) / 10 + ' min, want ' + Math.round(wantIn * 10) / 10 : 'none');
      S.usageHist7 = [];
      renderUsage();
      ok('usage: Squall doesn’t ask a session for usage any more', typeof controlUsage === 'undefined', typeof controlUsage);
      S.usageSrc = usageSrc0;
      S.usage = usage0; renderUsage();
      await waitFor(idle, 60000).catch(() => { });
      $('#input').value = 'sent, so not kept'; $('#input').dispatchEvent(new Event('input'));
      send(); await waitFor(idle, 60000).catch(() => { });
      let afterSend = 'x'; try { afterSend = localStorage.getItem('squall.draft'); } catch (e) { }
      ok('sending clears the saved draft', afterSend === null, String(afterSend));

      // team tools: actions in a bot's reply, Storm's OK before deleting, renaming, routines
      const acts = parseActions('ok\n```tempest\n{"actions":[{"do":"add_routine","name":"Test routine","bot":"' + A + '","time":"09:00","days":"daily","prompt":"say hi"},{"do":"delete_bot","name":"' + Z + '"}]}\n```');
      ok('team tools: actions are read from a bot’s reply', acts.length === 2 && acts[0].do === 'add_routine', JSON.stringify(acts).slice(0, 120));
      const toolChat = chatById('dm:' + A);
      await runActions(toolChat, A, acts);
      const testRt = ((S.team && S.team.routines) || []).find(r => r.name === 'Test routine');
      ok('team tools: a bot can add a routine', !!testRt && testRt.bot === A, JSON.stringify(testRt || null).slice(0, 120));
      const delCard = toolChat.messages.filter(m => m.kind === 'confirm').pop();
      ok('team tools: deleting a bot waits for your OK', !!delCard && /wants to delete/.test(delCard.text) && S.agents.some(a => a.name === Z), delCard ? delCard.text : 'no card');
      openChat(toolChat.id); renderChat(); await sleep(120);
      const keepBtn = delCard && document.querySelector('#chat [data-confirm="' + delCard.id + '"][data-yes="0"]');
      if (keepBtn) keepBtn.click();
      await sleep(150);
      ok('team tools: Keep leaves the bot alone', !!delCard && /Kept/.test(delCard.resolved || '') && S.agents.some(a => a.name === Z) && !document.querySelector('#chat [data-confirm="' + delCard.id + '"]'), delCard ? String(delCard.resolved) : '');
      await Bridge.call('capture', { name: '6d-confirm-card' });
      const renamed = await Bridge.call('teamRename', { from: Z, to: 'Renamedbot' }).then(r => r.name).catch(e => 'error: ' + e.message);
      const renamedBack = await Bridge.call('teamRename', { from: 'Renamedbot', to: Z }).then(r => r.name).catch(e => 'error: ' + e.message);
      ok('team tools: a bot can be renamed (and back)', renamed === 'Renamedbot' && renamedBack === Z, renamed + ' / ' + renamedBack);
      const leadDel = await Bridge.call('teamRemove', { name: S.lead.name }).then(() => 'removed').catch(e => e.message);
      ok('team tools: the lead cannot be deleted', /leads the team/.test(leadDel), leadDel);
      await Bridge.call('teamAdd', { name: 'Tempbot', role: '', color: '', prompt: '' }).catch(() => { });
      const tempDel = await Bridge.call('teamRemove', { name: 'Tempbot' }).then(r => r.name).catch(e => 'error: ' + e.message);
      ok('team tools: a new bot can be added and deleted', tempDel === 'Tempbot', tempDel);
      // a routine runs when its time comes: the bot gets the job in its own chat
      const dNow = new Date(), hmNow = String(dNow.getHours()).padStart(2, '0') + ':' + String(dNow.getMinutes()).padStart(2, '0');
      const rtAdded = await Bridge.call('routineAdd', { name: 'Now routine', bot: A, time: hmNow, days: 'daily', prompt: 'Say the routine works.' });
      S.team.routines = rtAdded.routines;
      const rtBefore = toolChat.messages.length;
      routineTick();
      await waitFor(() => toolChat.messages.slice(rtBefore).some(m => /Routine "Now routine"/.test(m.text || '')), 10000).catch(() => { });
      ok('routines: a routine runs at its time', toolChat.messages.slice(rtBefore).some(m => /Routine "Now routine"/.test(m.text || '')), toolChat.messages.slice(rtBefore).map(m => m.text).join(' | ').slice(0, 160));
      await waitFor(idle, 60000).catch(() => { });
      // right-click a teammate: rename or delete (the lead has no delete); the Routines tile lists routines
      const zTile = document.querySelector('#agents .member[data-chat="dm:' + Z + '"]');
      if (zTile) zTile.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 60, clientY: 300 }));
      await sleep(60);
      const zMenu = document.querySelector('.bot-menu');
      ok('right-click a teammate: rename and delete', !!zMenu && /Rename/.test(zMenu.textContent) && /Delete/.test(zMenu.textContent), zMenu ? zMenu.textContent : 'no menu');
      await Bridge.call('capture', { name: '6e-bot-menu' });
      closeBotMenu();
      const leadTile = document.querySelector('#agents .member[data-chat="dm:' + S.lead.name + '"]');
      if (leadTile) leadTile.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 60, clientY: 200 }));
      await sleep(60);
      const leadMenu = document.querySelector('.bot-menu');
      ok('right-click the lead: no delete', !!leadMenu && /Rename/.test(leadMenu.textContent) && !/Delete…/.test(leadMenu.textContent), leadMenu ? leadMenu.textContent : 'no menu');
      closeBotMenu();
      document.querySelector('[data-act="routines"]').click();
      await sleep(120);
      const rtModal = document.querySelector('.routines-modal');
      ok('the Routines tile opens the routines list', !!rtModal && /Test routine/.test(rtModal.textContent) && /Now routine/.test(rtModal.textContent), rtModal ? rtModal.textContent.slice(0, 120) : 'no list');
      await waitFor(() => /Fixture digest/.test((document.querySelector('.routines-modal') || {}).textContent || ''), 8000).catch(() => {});
      const rtText = (document.querySelector('.routines-modal') || {}).textContent || '';
      ok('Routines lists the Claude app’s scheduled tasks, read-only', /From the Claude app/.test(rtText) && /Fixture digest/.test(rtText) && /Every day, about 10\sPM/.test(rtText) && /Weekday check/.test(rtText) && /Weekdays, about 9:30\sAM/.test(rtText), rtText.replace(/\s+/g, ' ').slice(rtText.indexOf('From the Claude app'), rtText.indexOf('From the Claude app') + 220));
      const pills = Array.from(document.querySelectorAll('.routines-modal .rt-row.app .rt-pill')).map(p => p.textContent);
      ok('a Claude app task shows On or Off, and the next run for one that’s on', pills.join(',') === 'On,Off' && /next (today|tomorrow)/.test(rtText) && /last ran/.test(rtText), pills.join(','));
      const cn = cronNext('0 22 * * *', new Date(2026, 9, 17, 23, 0)), cw = cronNext('30 9 * * 1-5', new Date(2026, 9, 17, 12, 0));
      ok('schedules in plain words, and the next run', cronText('*/15 * * * *') === 'Every 15 minutes' && cronText('0 */2 * * *') === 'Every 2 hours' && /^Weekends, about/.test(cronText('0 8 * * 0,6')) && /^Mondays, Fridays, about/.test(cronText('0 8 * * 1,5')) &&
        !!cn && cn.getDate() === 18 && cn.getHours() === 22 && !!cw && cw.getDay() === 1 && cw.getDate() === 19, [cn, cw].map(String).join(' | '));
      await Bridge.call('capture', { name: '6f-routines' });
      closeModal();
      for (const r of (S.team.routines || []).slice()) if (/^(Test|Now) routine$/.test(r.name)) { const rr = await Bridge.call('routineRemove', { id: r.id }); S.team.routines = rr.routines; }
      ok('routines: removed again', !(S.team.routines || []).some(r => /^(Test|Now) routine$/.test(r.name)), (S.team.routines || []).length + ' left');
      // the update card (Storm: "Just make it auto update so I can see it"): what changed shows after Squall updates itself
      const ap = await Bridge.call('appliedTest').catch(e => ({ err: e.message }));
      ok('updates: the host reports an applied update once, with what changed', !!ap.event && ap.event.build === '2099.01.01.1234' && Array.isArray(ap.event.summary) && ap.event.summary.length === 2 && /9\/9/.test(ap.event.tests || '') && !ap.again, JSON.stringify(ap).slice(0, 160));
      const teamN0 = chatById('team').messages.length;
      const wn = showUpdated(ap.event || { build: '2099.01.01.1234', from: '2099.01.01.1200', summary: ['First change', 'Second change'], tests: '9/9 self-test' });
      await sleep(80);
      ok('updates: a card shows the new build and what changed', !!document.querySelector('.wn-card') && /Squall updated/.test(wn.textContent) && /build 1234/.test(wn.textContent) && /First change/.test(wn.textContent) && /Second change/.test(wn.textContent), wn.textContent.slice(0, 120));
      // in the strip the card is a slim pill; What's new opens the list
      {
        const hadStrip = document.body.classList.contains('strip');
        document.body.classList.add('strip');
        const sc = showUpdated({ build: '2099.01.01.0001', from: '2099.01.01.0000', summary: ['First change', 'Second change', 'Third change'], tests: '1/1' });
        await sleep(80);
        const pillTall = sc.getBoundingClientRect().height;
        const moreB = sc.querySelector('.wn-more');
        if (moreB) moreB.click();
        await sleep(80);
        ok('updates: in the strip the card is a slim pill, and What’s new opens the list', !!moreB && pillTall < 48 && sc.classList.contains('open') && getComputedStyle(sc.querySelector('ul')).display !== 'none', Math.round(pillTall) + ' px tall');
        sc.remove();
        if (!hadStrip) document.body.classList.remove('strip');
      }
      // a message the session sent to another bot folds to one line; a click opens it
      {
        const se = { role: 'sent', k: 'sfold1', text: 'Please update the notes for the Squall build. '.repeat(5), to: 'Obsidian', time: new Date().toISOString() };
        const folded = mirrorEntryHTML(se, 'Barry', { color: '#3d9be9' });
        openSent.add('sfold1');
        const opened = mirrorEntryHTML(se, 'Barry', { color: '#3d9be9' });
        openSent.delete('sfold1');
        ok('live view: a message sent to another bot shows folded, and opens on a click', /sent-fold/.test(folded) && /data-sentfold/.test(folded) && /Barry → Obsidian/.test(folded) && !/sent-fold/.test(opened) && /Hide/.test(opened), '');
      }
      // Read now shows on messages waiting for a busy session
      {
        const rmi = { status: { working: true, at: new Date().toISOString(), queue: ['Storm (via his Squall app): check this'] }, pending: [], entries: [] };
        S.mirror.ReadNowBot = rmi;
        const rq = queuedHTML(rmi);
        delete S.mirror.ReadNowBot;
        ok('queue: a Read now button shows on messages waiting for a busy session', /data-readnow="ReadNowBot"/.test(rq) || !mirrorBusy(rmi, false), '');
      }
      ok('updates: the team chat gets the note with the changes', chatById('team').messages.slice(teamN0).some(m => /Updated to build 2099\.01\.01\.1234/.test(m.text || '') && /First change/.test(m.text || '')), '');
      await Bridge.call('capture', { name: '6g-update-card' });
      wn.querySelector('.wn-x').click(); await sleep(420);
      ok('updates: × closes the card', !document.querySelector('.wn-card'), '');
      openSettings(); await sleep(120);
      const aboutText = (document.querySelector('.set-about') || {}).textContent || '';
      ok('updates: Settings lists the recent updates', /Build 1234/.test(aboutText) && /First change/.test(aboutText), aboutText.slice(0, 120));
      closeModal();
      S.updates = (S.updates || []).filter(u => !/^2099/.test(u.build)); saveSoon();
      // @ names (the strip hides the row of @ chips): typing @ suggests the chat's teammates, and Enter picks one instead of sending
      openChat('team'); await sleep(60);
      const inpA = $('#input'), teamN1 = chatById('team').messages.length, pre = A.slice(0, 2);
      const expectAt = chatById('team').members.filter(n => n.toLowerCase().startsWith(pre.toLowerCase()) && n.toLowerCase() !== pre.toLowerCase())[0];
      inpA.focus(); inpA.value = 'hey @' + pre; inpA.setSelectionRange(inpA.value.length, inpA.value.length); inpA.dispatchEvent(new Event('input'));
      await sleep(40);
      const atPop = document.querySelector('#at-pop');
      ok('@ names: typing @ suggests matching teammates', !!atPop && atPop.textContent.includes('@' + expectAt), atPop ? atPop.textContent : 'no list');
      inpA.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await sleep(40);
      ok('@ names: Enter picks the name and doesn’t send', inpA.value === 'hey @' + expectAt + ' ' && chatById('team').messages.length === teamN1 && !document.querySelector('#at-pop'), JSON.stringify(inpA.value));
      inpA.value = 'hey @zz'; inpA.dispatchEvent(new Event('input')); await sleep(30);
      ok('@ names: no list when no teammate matches', !document.querySelector('#at-pop'), '');
      inpA.value = ''; inpA.dispatchEvent(new Event('input')); autosize();
      // reply peeks: a reply in a chat that isn't open pops out of the bot's icon; a click opens that chat
      openChat('team'); await sleep(60);
      const pkChat = chatById('dm:' + B);
      document.querySelectorAll('.peek').forEach(x => x.remove());
      addMessage(pkChat, { who: B, kind: 'agent', text: 'Peek test: **the leaderboard** is done and `saved`.' });
      await sleep(80);
      const pk = document.querySelector('.peek[data-peek="dm:' + B + '"]');
      ok('peeks: a reply in a chat that isn’t open pops out next to the bot', !!pk && pk.textContent.includes(B) && /the leaderboard is done and saved/.test(pk.textContent), pk ? pk.textContent : 'no peek');
      await Bridge.call('capture', { name: '6i-peek' });
      if (pk) pk.click();
      await sleep(80);
      ok('peeks: clicking it opens that chat', S.active === 'dm:' + B && !document.querySelector('.peek[data-peek="dm:' + B + '"]'), S.active);
      addMessage(pkChat, { who: B, kind: 'agent', text: 'No peek for the chat you are in.' });
      await sleep(50);
      ok('peeks: none for the chat you’re looking at', !document.querySelector('.peek[data-peek="dm:' + B + '"]'), '');
      clearChat(pkChat);
      // Ctrl+K: jump anywhere by typing
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }));
      await sleep(60);
      const qk = document.querySelector('.qk-back');
      ok('Ctrl+K opens the quick switcher with teammates, chats and tools', !!qk && qk.textContent.includes(A) && /Settings/.test(qk.textContent) && /Routines/.test(qk.textContent), qk ? qk.textContent.slice(0, 100) : 'not open');
      await Bridge.call('capture', { name: '6j-quick-switcher' });
      const qkIn = document.querySelector('#qk-q');
      if (qkIn) { qkIn.value = A.toLowerCase(); qkIn.dispatchEvent(new Event('input')); await sleep(30); qkIn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); }
      await sleep(80);
      ok('Ctrl+K: typing a name and Enter opens that chat', S.active === 'dm:' + A && !document.querySelector('.qk-back'), S.active);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }));
      await sleep(40);
      const qkIn2 = document.querySelector('#qk-q');
      if (qkIn2) qkIn2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await sleep(40);
      ok('Ctrl+K: Esc closes it', !document.querySelector('.qk-back'), '');
      // bots make routines on their own (Storm: "Make the bots able to create routines themselves"); who made it shows, and each bot keeps at most 4
      const sysR = await Bridge.call('sysPrompt', { name: A });
      ok('bots are told they may add a routine on their own', /add a routine on your own/.test(sysR) && /4 per bot/.test(sysR), '');
      const brChat = chatById('dm:' + A);
      await doAction({ do: 'add_routine', name: 'Bot routine 1', bot: A, time: '07:30', days: 'weekdays', prompt: 'check the build' }, brChat, A, false).catch(e => { });
      const br1 = (S.team.routines || []).find(x => x.name === 'Bot routine 1');
      ok('a bot can add a routine on its own, and Squall notes it in the chat', !!br1 && br1.by === A && brChat.messages.some(m => m.kind === 'event' && /added a routine: Bot routine 1/.test(m.text || '')), br1 ? JSON.stringify(br1).slice(0, 140) : 'not added');
      for (let i = 2; i <= 5; i++) await doAction({ do: 'add_routine', name: 'Bot routine ' + i, bot: A, time: '07:3' + i, days: 'daily', prompt: 'x' }, brChat, A, false).catch(e => { });
      const mine = (S.team.routines || []).filter(x => x.bot === A).length;
      ok('each bot keeps at most 4 routines; a 5th is refused with a note', mine === 4 && brChat.messages.some(m => /already has 4 routines/.test(m.text || '')), mine + ' routines');
      document.querySelector('[data-act="routines"]').click(); await sleep(150);
      ok('the Routines list says which bot made a routine', /made by/.test((document.querySelector('.routines-modal') || {}).textContent || ''), '');
      closeModal();
      for (const rr of (S.team.routines || []).slice()) if (/^Bot routine \d$/.test(rr.name)) { const res = await Bridge.call('routineRemove', { id: rr.id }); S.team.routines = res.routines; }
      clearChat(brChat);
      // routines in detail (Storm: "Test routines too"): the day rules, once a day, the 5-minute window, a busy bot gets it later
      const rtFired = [], realRunRoutine = runRoutine, rtSaved = S.team.routines;
      runRoutine = rt => rtFired.push(rt.name);
      try {
        const mkRt = (name, days) => ({ id: 'rt-test-' + name.replace(/\W/g, ''), name, bot: A, time: '09:00', days, prompt: 'test', lastRun: '' });
        S.team.routines = [mkRt('Daily nine', 'daily'), mkRt('Weekday nine', 'weekdays'), mkRt('Weekend nine', 'weekends')];
        routineTick(new Date(2026, 9, 17, 9, 2));   // a Saturday
        ok('routines: on a Saturday at 9:02 the daily and weekend routines run, the weekday one doesn’t', rtFired.join(',') === 'Daily nine,Weekend nine', rtFired.join(','));
        routineTick(new Date(2026, 9, 17, 9, 3));
        ok('routines: each runs once a day, not on every check', rtFired.length === 2, rtFired.join(','));
        rtFired.length = 0;
        routineTick(new Date(2026, 9, 19, 9, 1));   // a Monday
        ok('routines: on a Monday the weekday routine runs and the weekend one doesn’t', rtFired.join(',') === 'Daily nine,Weekday nine', rtFired.join(','));
        rtFired.length = 0; S.team.routines.forEach(x => { x.lastRun = ''; });
        routineTick(new Date(2026, 9, 20, 8, 59));
        ok('routines: nothing runs before its time', rtFired.length === 0, rtFired.join(','));
        routineTick(new Date(2026, 9, 20, 9, 6));
        ok('routines: more than 5 minutes late, it waits for the next day', rtFired.length === 0, rtFired.join(','));
        S.flows['dm:' + A] = true;
        routineTick(new Date(2026, 9, 21, 9, 1));
        const whileBusy = rtFired.length;
        delete S.flows['dm:' + A];
        routineTick(new Date(2026, 9, 21, 9, 4));
        ok('routines: a busy bot gets its routine on a later check, within the 5 minutes', whileBusy === 0 && rtFired.join(',') === 'Daily nine,Weekday nine', whileBusy + ' while busy, then ' + rtFired.join(','));
      } finally { runRoutine = realRunRoutine; S.team.routines = rtSaved; }

      // live mode against the demo relay (it pretends Fox is offline)
      S.liveMode = true; startLink();
      await waitFor(() => S.link.status === 'on' && S.link.peers.length >= S.agents.length, 15000);
      ok('live: relay lists the team', S.link.peers.length >= S.agents.length, S.link.peers.map(p => p.name + ':' + p.status).join(' '));
      {   // Storm, 20 Oct: the session on this PC wins over an idle Remote Control one with the same bot name (the laptop's "(Squall)" fill-ins)
        const keep = S.link.peers, ln = S.lead.name;
        S.link.peers = [{ name: ln + ' (Squall)', ref: 'rc1', kind: 'Remote Control', status: 'idle' }, { name: ln, ref: 'old1', kind: 'interactive', status: 'offline' },
          { name: ln, ref: 'here1', kind: 'interactive', status: 'idle' }];
        const pick = peerFor(ln);
        S.link.peers = [{ name: ln + ' (Squall)', ref: 'rc1', kind: 'Remote Control', status: 'idle' }, { name: ln, ref: 'old1', kind: 'interactive', status: 'offline' }];
        const only = peerFor(ln);
        S.link.peers = keep;
        ok('live: a bot\'s session on this PC wins over a Remote Control one', !!pick && pick.ref === 'here1' && !!only && only.ref === 'rc1', (pick && pick.ref) + ' / ' + (only && only.ref));
      }
      openChat('dm:' + S.lead.name);
      await say('ping from the self-test');
      const ldm = chatById('dm:' + S.lead.name);
      const lr = ldm.messages.filter(m => m.who === S.lead.name).pop();
      ok('live: real-session reply lands in the right chat', !!lr && lr.live === true && /live demo/.test(lr.text), lr && lr.text);
      const off = S.agents.find(a => { const p = peerFor(a.name); return p && p.status === 'offline'; });
      if (off) {
        openChat('dm:' + off.name);
        await say('are you there?');
        const om = chatById('dm:' + off.name).messages.filter(m => m.who === off.name).pop();
        ok('live: offline teammate gets a labeled stand-in', !!om && om.standIn === true && !om.live, om && om.text);
      }
      const lg = createGroup('Live squad', [A, B]);
      openChat(lg.id);
      await say('@' + A + ' ask ' + B + ' what he thinks');
      const la = lg.messages.find(m => m.who === A), lb = lg.messages.find(m => m.who === B);
      ok('live: real sessions @mention each other through the relay', !!la && la.live && la.text.includes('@' + B) && !!lb && lb.live, (la && la.text) + ' / ' + (lb && lb.text));
      await sleep(250); await Bridge.call('capture', { name: '7-live-group' });

      // live view of a real session on this PC (reads its real conversation file, if one exists)
      await startMirrors();
      const watched = Object.keys(S.mirror)[0];
      if (watched) {
        openChat('dm:' + watched);
        await waitFor(() => S.mirror[watched] && S.mirror[watched].entries.length > 0, 30000);
        const shown = document.querySelectorAll('#chat .msg').length;
        ok('live view shows the real ' + watched + ' session', shown > 0, S.mirror[watched].entries.length + ' entries, ' + shown + ' messages shown');
        const wmi = S.mirror[watched];
        ok('live view knows whether the session is working', !!wmi.status && typeof wmi.status.working === 'boolean', JSON.stringify(wmi.status));
        ok('live view shows a working row while the session works', !mirrorBusy(wmi) || !!document.querySelector('#chat .working-row'), mirrorActivity(wmi));
        await sleep(300); await Bridge.call('capture', { name: '8-live-view-' + watched.toLowerCase() });
        // an image pasted into the live chat goes to the real session with its path (watch what the relay is handed)
        const jobs = [], realCall = Bridge.call;
        Bridge.call = (cmd, args) => { if (cmd === 'bridgeSend') jobs.push(String((args && args.text) || '')); return realCall(cmd, args); };
        try {
          addImageFile(new File([blob], 'live.png', { type: 'image/png' }));
          await waitFor(() => S.attach.length === 1 && !!S.attach[0].path, 10000);
          $('#input').value = 'image test from the self-test'; send();
          await sleep(400);
        } finally { Bridge.call = realCall; }
        const job = jobs.find(j => j.includes('image test from the self-test')) || '';
        ok('images pasted into a live chat reach the real session', job.includes(IMG_NOTE) && /paste-.*\.png/.test(job), job.slice(0, 300));
        const asked = wmi.entries.filter(e => e.role === 'ask');
        if (asked.length) {
          const card = document.querySelectorAll('#chat .ask-card');
          // every question card the session can show: asks, plans (they're cards too), and the squall-ask blocks in its replies
          const shownCards = wmi.entries.filter(e => e.role === 'ask' || e.role === 'plan').length + wmi.entries.reduce((n, e) => n + (e.role === 'assistant' && /```squall-ask/.test(e.text || '') ? squallAsks(e.text).asks.length : 0), 0);
          ok('live view shows the questions the session asks you', card.length === shownCards, card.length + ' cards for ' + shownCards + ' questions');
          const answered = asked.filter(q => wmi.entries.some(e => e.role === 'answer' && e.id === q.id && !NO_ANSWER_RX.test(e.text || ''))).length;   // closed with no answer = still open in Squall
          if (answered) ok('question cards show your answer', document.querySelectorAll('#chat .ask-card.answered .ask-opt.on').length >= 1, answered + ' answered');
          card[card.length - 1].scrollIntoView({ block: 'center' }); await sleep(200); await Bridge.call('capture', { name: '11-question-card' });
        }
        if (wmi.entries.some(e => e.role === 'image')) {
          // thumbnails load lazily, so bring the newest one into view before checking it loaded
          const lastShot = Array.from(document.querySelectorAll('#chat img.shot')).pop();
          let loaded = false;
          if (lastShot) {
            lastShot.scrollIntoView({ block: 'center' });
            try { await waitFor(() => lastShot.complete && lastShot.naturalWidth > 0, 8000); loaded = true; } catch (e) { }
          }
          ok('live view shows the images the session looked at', loaded, document.querySelectorAll('#chat img.shot').length + ' images');
          if (lastShot) { await sleep(200); await Bridge.call('capture', { name: '9-live-images' }); lastShot.click(); await sleep(300); await Bridge.call('capture', { name: '10-image-view' }); closeLightbox(); }
        }
      }
      // live timer: a real session that goes idle after its work gets a work-timer note through the relay
      const bn = 'Barry', bchat = chatById('dm:' + bn);
      const hadMirror = !!S.mirror[bn];
      if (!hadMirror) S.mirror[bn] = { entries: [], session: {}, loading: false, pending: [] };
      const bmi = S.mirror[bn];
      bmi.kickAt = 0;
      openChat(bchat.id);
      startTimer(bchat, 'inf');
      bmi.status = { working: true, at: new Date().toISOString(), tool: '', detail: '' };
      await sleep(2600);   // long enough for the timer's watch to see it working
      bmi.status = { working: false, at: new Date().toISOString(), tool: '', detail: '' };   // its turn is over
      await waitFor(() => (bmi.pending || []).some(p => /Work timer/.test(p.raw || '')), 30000).catch(() => { });
      ok('work timer: a live session gets a work-timer note once it goes idle', (bmi.pending || []).some(p => /Work timer/.test(p.raw || '')), '');
      await sleep(20000);   // the session stays idle and hasn't read the nudge: the timer must not keep adding more
      const liveNudges = (bmi.pending || []).filter(p => /Work timer/.test(p.raw || '')).length;
      ok('work timer: one nudge at a time while the session sits idle', liveNudges === 1, liveNudges + ' nudge(s) waiting');
      // a session that holds the relay's messages (another permission mode): they show as held, the relay restarts in the next mode and
      // sends them again, and the mode that worked is kept for that session (Storm: "FIX THE QUEUED MESSAGES NOW")
      {
        const realSend = liveSend, modeBefore = S.link.mode || 'bypassPermissions';
        const tries = [];
        liveSend = (n, t, onLate) => { tries.push(S.link.mode || 'bypassPermissions'); return Promise.resolve(tries.length === 1 ? { ok: false, note: 'held by recipient session' } : { ok: true }); };
        S.link.tried = {}; if (S.relayModes) delete S.relayModes[bn];
        bmi.pending = [];
        sendToMirror(bchat, 'Held message test', [], [], undefined, undefined, '');
        // the held state lasts only while the relay restarts, so it is watched every 5 ms until the message has been sent again
        // (one look after a fixed 60 ms missed it when the test ran slowly under a running game)
        let heldShown = false;
        for (const t0 = Date.now(); Date.now() - t0 < 15000;) {
          if ((bmi.pending || []).some(p => p.text === 'Held message test' && p.held)) heldShown = true;
          if (tries.length >= 2 && (bmi.pending || []).some(p => p.text === 'Held message test' && p.sent && !p.held)) break;
          await sleep(5);
        }
        const heldItem = (bmi.pending || []).find(p => p.text === 'Held message test');
        ok('relay: a held message shows as held, then the relay restarts in another mode and sends it again', (heldShown || bchat.messages.some(m => /held Squall/.test(m.text || ''))) && tries.length >= 2 && tries[1] !== tries[0] && !!heldItem && heldItem.sent && !heldItem.held, tries.join(' → ') + (heldItem ? ' · ' + pendState(heldItem) : ''));
        ok('relay: the mode that worked is kept for that session', !!S.relayModes && S.relayModes[bn] === tries[tries.length - 1], JSON.stringify(S.relayModes || {}));
        ok('relay: the queue box counts what it shows, and says when the session is holding them', /Held by the session/.test(queuedHTML({ status: { working: true, queue: [] }, pending: [{ k: 'x', raw: 'a', text: 'a', at: Date.now(), held: true }] }).replace(/<[^>]+>/g, ' ')) || !mirrorBusy({ status: { working: true, queue: [] } }, false), '');
        liveSend = realSend;
        bmi.pending = [];
        if (S.relayModes) delete S.relayModes[bn];
        await relayRestart(modeBefore).catch(() => { });
      }
      // subagents and workflows show in the right pane for a live session
      bmi.status = Object.assign({}, bmi.status, { runs: [
        { id: 'r1', kind: 'agent', title: 'Check the timer log', type: 'Explore', background: false, status: 'done', started: new Date(Date.now() - 65000).toISOString(), ended: new Date(Date.now() - 5000).toISOString() },
        { id: 'r2', kind: 'workflow', title: 'review-changes', type: '', background: true, status: 'running', started: new Date(Date.now() - 20000).toISOString(), ended: '' }] });
      S.rightMode = 'live'; S.live = bn; renderLive();
      const paneText = $('#live-body').textContent;
      ok('the right pane lists a live session’s subagents and workflows', /Subagents and workflows/.test(paneText) && /Check the timer log/.test(paneText) && /review-changes/.test(paneText) && /Running/.test(paneText) && /Done/.test(paneText), paneText.slice(0, 160));
      await sleep(150); await Bridge.call('capture', { name: '8b-subagents-pane' });
      // the Computer tab names Starx and says whether it is on (Storm, 22 Oct: "Get the computer in Squall")
      S.rightMode = 'computer'; renderLive(); await sleep(1200);
      const compText = ($('#live-body') || {}).textContent || '';
      ok('the Computer tab names Starx and says whether it is on', /Starx/.test(compText) && /live|off|starting|stopped|not connected/.test(compText), compText.slice(0, 80));
      // every packet Squall relays to a bot carries the hidden queue line (Storm, 22 Oct: "I keep telling you to queue"); Storm's box shows only his words
      const relayed = relayPacket('queue check', [], []);
      ok('every relayed packet carries the queue line', /queue this/.test(relayed) && /narrate the queue/.test(relayed), relayed.slice(-100));
      await Bridge.call('capture', { name: '8b2-computer-tab' });
      S.rightMode = 'live'; renderLive();
      // a question shows as plain text in Squall, with no card and no buttons (Storm, 2026-10-21)
      bmi.entries.push({ role: 'ask', id: 'qtest', k: 'eqtest', questions: [{ question: 'Pick a color?', header: 'Color', options: [{ label: 'Teal' }, { label: 'Pink' }] }], time: new Date().toISOString() });
      openChat(bchat.id); renderChat(); await sleep(150);
      const tealOpt = document.querySelector('#chat .ask-opt[data-askopt][data-label="Teal"]');
      if (tealOpt) tealOpt.click();
      await sleep(100);
      const tealOn = !!document.querySelector('#chat .ask-opt.on[data-label="Teal"]');
      const sendAns = document.querySelector('#chat [data-asksend="eqtest"]');
      if (sendAns) sendAns.click();
      await sleep(250);
      ok('question cards can be answered in Squall', tealOn && (bmi.pending || []).some(p => /Color: Teal/.test(p.raw || '')), (bmi.pending || []).map(p => String(p.raw).slice(0, 60)).join(' | '));
      await Bridge.call('capture', { name: '8c-answer-card' });
      // a question card can be skipped: one message leaves the questions to the session, and the card closes for good
      bmi.entries.push({ role: 'ask', id: 'qskip', k: 'eqskip', questions: [{ question: 'Which font?', header: 'Font', options: [{ label: 'Serif' }, { label: 'Sans' }] }], time: new Date().toISOString() });
      openChat(bchat.id); renderChat(); await sleep(150);
      const skipOffered = !!document.querySelector('#chat [data-askskip="eqskip"]');   // offered before anything is picked
      await Bridge.call('capture', { name: '8c2-open-skip' });
      const skipBefore = (bmi.pending || []).filter(p => /Skipping your questions/.test(p.raw || '')).length;
      const skipBtn = document.querySelector('#chat [data-askskip="eqskip"]');
      if (skipBtn) skipBtn.click();
      await sleep(250);
      const skipCard = document.querySelector('#chat .ask-card[data-k="eqskip"]');
      const skipAfter = (bmi.pending || []).filter(p => /Skipping your questions/.test(p.raw || '')).length;
      ok('question cards can be skipped in Squall', skipOffered && skipAfter === skipBefore + 1 && !!skipCard && /Skipped from Squall/.test(skipCard.textContent) && !skipCard.querySelector('[data-askskip],[data-asksend],[data-askopt]'), (skipAfter - skipBefore) + ' skip message(s); ' + (skipCard ? skipCard.textContent.slice(0, 60) : 'no card'));
      await Bridge.call('capture', { name: '8d-skip-card' });
      // "Other…": Storm's own typed answer is the pick, and it goes to the session with Send answers; Enter in the box sends too
      bmi.entries.push({ role: 'ask', id: 'qother', k: 'eqother', questions: [{ question: 'Pick a color?', header: 'Color', options: [{ label: 'Teal' }, { label: 'Pink' }] }], time: new Date().toISOString() });
      openChat(bchat.id); renderChat(); await sleep(150);
      const otherOpt = document.querySelector('#chat [data-askother][data-ask="eqother"]');
      if (otherOpt) otherOpt.click();
      await sleep(100);
      const otherIn = document.querySelector('#chat [data-askin="eqother"]');
      if (otherIn) { otherIn.value = 'Teal-ish'; otherIn.dispatchEvent(new Event('input', { bubbles: true })); }
      await sleep(50);
      await Bridge.call('capture', { name: '8e-other-box' });
      const otherSend = document.querySelector('#chat [data-asksend="eqother"]');
      const otherReady = !!otherSend && !otherSend.disabled;
      if (otherSend) otherSend.click();
      await sleep(250);
      ok('Other: a typed answer counts as the pick and goes to the session', !!otherIn && otherReady && (bmi.pending || []).some(p => /Color: Teal-ish/.test(p.raw || '')), (bmi.pending || []).map(p => String(p.raw).slice(0, 60)).join(' | ').slice(0, 160));
      bmi.entries.push({ role: 'ask', id: 'qother2', k: 'eqother2', questions: [{ question: 'Pick a size?', header: 'Size', options: [{ label: 'Small' }, { label: 'Large' }] }], time: new Date().toISOString() });
      openChat(bchat.id); renderChat(); await sleep(150);
      const otherOpt2 = document.querySelector('#chat [data-askother][data-ask="eqother2"]');
      if (otherOpt2) otherOpt2.click();
      await sleep(100);
      const enterIn = document.querySelector('#chat [data-askin="eqother2"]');
      if (enterIn) { enterIn.value = 'Medium'; enterIn.dispatchEvent(new Event('input', { bubbles: true })); enterIn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); }
      await sleep(250);
      ok('Other: Enter in the box sends the answer', !!enterIn && (bmi.pending || []).some(p => /Size: Medium/.test(p.raw || '')), '');
      // a live session asks through a squall-ask block: an open card with its JSON hidden, and Send answers answers it
      bmi.entries.push({ role: 'assistant', k: 'e-sqask-test', text: 'Two quick things before I go on.\n\n```squall-ask\n{"questions":[{"question":"Which font?","header":"Font","multiSelect":false,"options":[{"label":"Serif","description":"classic"},{"label":"Sans","description":"clean"}]}]}\n```', time: new Date().toISOString() });
      openChat(bchat.id); renderChat(); await sleep(150);
      const sqCard = document.querySelector('#chat .ask-card.open[data-k="e-sqask-test#0"]');
      // the test message's own text: the chat around it can hold a real session's mirrored messages (21 Oct: Chief's live view quoted
      // "squall-ask" from the relay's instructions, and this check failed on words that were never this card's)
      const sqMsg = document.querySelector('#chat .msg[data-k="e-sqask-test"]');   // the card is its own block after the message
      const chatText = (sqMsg || document.querySelector('#chat') || {}).textContent || '';
      ok('squall-ask: an open question card, the JSON hidden, the text shown', !!sqCard && !/squall-ask|"questions"/.test(chatText) && /Which font\?/.test(sqCard.textContent) && /Two quick things/.test(chatText), sqCard ? 'card' : 'no card');
      const serifOpt = document.querySelector('#chat [data-askopt][data-ask="e-sqask-test#0"][data-label="Serif"]');
      if (serifOpt) serifOpt.click();
      await sleep(100);
      const sqSend = document.querySelector('#chat [data-asksend="e-sqask-test#0"]');
      if (sqSend) sqSend.click();
      await sleep(250);
      ok('squall-ask: Send answers queues "My answers to your questions: …"', (bmi.pending || []).some(p => /My answers to your questions:[\s\S]*Font: Serif/.test(p.raw || '')), '');
      // bad JSON in a squall-ask block: the text shows as it is, with no card
      bmi.entries.push({ role: 'assistant', k: 'e-sqbad-test', text: 'Broken block:\n```squall-ask\n{"questions": [oops\n```', time: new Date().toISOString() });
      openChat(bchat.id); renderChat(); await sleep(150);
      const badCard = document.querySelector('#chat .ask-card[data-k^="e-sqbad-test"]');
      ok('squall-ask: bad JSON shows as text, with no card', !badCard && /Broken block/.test((document.querySelector('#chat') || {}).textContent || ''), badCard ? 'card shown' : 'text only');
      // a live session's tempest block runs its actions (Storm: the To do block showed as raw code), once, with its JSON hidden
      const actEntry = { role: 'assistant', text: 'Added it.\n```tempest\n{"actions":[{"do":"todo_add","text":"selftest live action item"}]}\n```', time: new Date().toISOString() };
      onMirror({ agent: bn, reset: false, entries: [Object.assign({}, actEntry)] });
      onMirror({ agent: bn, reset: false, entries: [Object.assign({}, actEntry)] });   // the same reply delivered again: no second run
      await sleep(200);
      openChat(bchat.id); renderChat(); await sleep(150);
      const liveActs = TODO.items.filter(it => it.text === 'selftest live action item').length;
      // the reply's own chat: the split's right pane when the split holds it, else the left pane. The other pane can show a real session's
      // transcript (its own text may quote "actions"), so only the reply's own bubble is read
      const actPane = document.querySelector(S.split === bchat.id ? '#chat2' : '#chat');
      const actOn = !!actPane && (actPane.dataset.view || '').indexOf(bchat.id) >= 0;
      const actEnt = (bmi.entries || []).find(e => /selftest live action item/.test(e.text || ''));
      const actEl = actOn && actEnt ? actPane.querySelector('.msg[data-k="' + actEnt.k + '"]') : null;
      const actBubble = (actEl || {}).textContent || '';
      ok('live session: a tempest block runs its actions once, and its JSON stays hidden', actOn && liveActs === 1 && !!actEl && /Added it\./.test(actBubble) && !/"actions"|```tempest/.test(actBubble), liveActs + ' item(s)' + (actOn ? '' : '; pane shows ' + (actPane && actPane.dataset.view)) + (actEl ? '' : '; no bubble for the reply'));
      // a Squall note still waiting for its session stays out of the chat (its hints are for the bot); a plain waiting message shows
      const noteWait = { k: 'pn-note', raw: 'Work timer: zq-note-marker. End your reply with ```squall {"actions":[{"do":"timer_wait","minutes":10}]}```', text: normText('Work timer: zq-note-marker'), at: Date.now(), who: '', note: true };
      const plainWait = { k: 'pn-plain', raw: 'zq-plain-marker waiting', text: normText('zq-plain-marker waiting'), at: Date.now(), who: '' };
      bmi.pending = (bmi.pending || []).concat([noteWait, plainWait]); renderChat(); await sleep(60);
      const waitPane = document.querySelector(S.split === bchat.id ? '#chat2' : '#chat') || document.body;
      const plainShown = waitPane.textContent.indexOf('zq-plain-marker') >= 0;
      const noteShown = waitPane.textContent.indexOf('zq-note-marker') >= 0 || !!waitPane.querySelector('[data-k="pn-note"]');
      bmi.pending = bmi.pending.filter(p => p !== noteWait && p !== plainWait); renderChat();
      ok('a Squall note waiting for its session stays out of the chat; a plain waiting message shows', plainShown && !noteShown, (plainShown ? 'plain shown' : 'plain not shown') + (noteShown ? ', note shown' : ''));
      // the live view of a Squall note: a To do note stays out, and a work timer note shows its phase only (the rest is for the bot)
      const dvTodo = directView('Squall (To do): To do (Storm: when you stop, finish everything on the To do list). Open now:\n- [t1] next: x');
      const dvTimer = directView('Squall (work timer): Work timer: 9 min left of the 10 min Storm set. Keep working on what he asked. Waiting on a long job (a test, a build, a render) with nothing else to do meanwhile? End your reply with ```squall {"actions":[{"do":"timer_wait","minutes":10}]}``` to hold this timer.');
      ok('live view: a To do note stays out of the chat, and a work timer note shows only its phase', dvTodo.note === true && dvTimer.note === '⏱ Work timer: 9 min left of the 10 min Storm set', JSON.stringify(dvTodo) + ' ' + JSON.stringify(dvTimer));
      // a work-timer nudge that reaches the page as a peer message (Squall's cross-session copy) shows its phase only, as a quiet line
      const peerNudge = mirrorEntryHTML({ role: 'peer', from: 'Squall', k: 'pt-peer', time: new Date().toISOString(), text: 'Squall (work timer): Work timer: 9 min left of the 10 min Storm set. Keep working on what he asked. Waiting on a long job (a test, a build, a render) with nothing else to do meanwhile? End your reply with ```squall {"actions":[{"do":"timer_wait","minutes":10}]}``` to hold this timer.\n\nHe’s watching this session live in Squall, so just answer here normally.' }, 'Barry', { color: '#888' });
      ok('a work timer nudge from Squall shows its phase only, as a quiet line', /class="event"/.test(peerNudge) && /Work timer: 9 min left of the 10 min Storm set/.test(peerNudge) && !/End your reply|timer_wait/.test(peerNudge), peerNudge.slice(0, 120));
      // the split's right pane has its own send box: Enter there sends that box's text to the right pane's chat, and the left draft stays.
      // send is stubbed for this one call, so nothing reaches a session
      const sbKeep = { split: S.split, focusRight: S.focusRight, active: S.active, left: $('#input').value };
      const sbSend = send, sbSeen = [];
      send = async () => { sbSeen.push({ text: $('#input').value, chat: activeChat().id, focusRight: S.focusRight }); $('#input').value = ''; };
      try {
        if (S.active === bchat.id) S.active = 'team';
        S.split = bchat.id; S.focusRight = false; renderAll();
        $('#input').value = 'left draft kept'; $('#input2').value = 'right box text';
        $('#input2').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await sleep(60);
      } finally { send = sbSend; }
      const sbOk = sbSeen.length === 1 && sbSeen[0].text === 'right box text' && sbSeen[0].chat === bchat.id && sbSeen[0].focusRight === true && $('#input').value === 'left draft kept' && $('#input2').value === '';
      S.split = sbKeep.split; S.focusRight = sbKeep.focusRight; S.active = sbKeep.active; renderAll(); $('#input').value = sbKeep.left;
      ok('split send box: Enter there sends the right box to the right chat, and the left draft stays', sbOk, JSON.stringify(sbSeen).slice(0, 160));
      TODO.items = TODO.items.filter(it => it.text !== 'selftest live action item'); todoSave();
      // a message to another session names it (not "to Squall"), and a session's message looks unlike Storm's own
      bmi.entries.push({ role: 'sent', k: 'e-sent-chief', to: 'Chief (Squall) [91f3c7]', text: 'label test', time: new Date().toISOString() });
      bmi.entries.push({ role: 'peer', k: 'e-peer-look', from: 'Laptop [6e2fb2]', text: 'peer look test', time: new Date().toISOString() });
      openChat(bchat.id); renderChat(); await sleep(150);
      const sentEl = document.querySelector('#chat [data-k="e-sent-chief"]'), peerEl = document.querySelector('#chat [data-k="e-peer-look"]');
      ok('a message to "Chief (Squall) [ref]" says Chief (Squall), not Squall', !!sentEl && /Chief \(Squall\)/.test(sentEl.textContent) && !/\[91f3c7\]/.test(sentEl.textContent), sentEl ? sentEl.textContent.slice(0, 80) : 'missing');
      // the update log: the bots' file lists each build, and a bot hears about a new build once, on its next prompt
      const upsBefore = S.updates, toldBefore = S.updateTold[bn];
      S.updates = [{ build: '2099.01.01.0001', at: Date.now(), summary: ['selftest change'], tests: '1/1' }].concat(upsBefore || []);
      S.updateTold[bn] = '2000.01.01.0000';
      const p1 = buildPrompt(bchat, bn, '', false).prompt, p2 = buildPrompt(bchat, bn, '', false).prompt;
      ok('update log: the file lists the build, and a bot is told about it exactly once', /## Build 2099\.01\.01\.0001[\s\S]*- selftest change/.test(updateLogText()) && /Squall was updated[\s\S]*selftest change/.test(p1) && !/Squall was updated/.test(p2), '');
      S.updates = upsBefore; if (toldBefore === undefined) delete S.updateTold[bn]; else S.updateTold[bn] = toldBefore; saveSoon();
      ok('a session message sits apart from Storm’s own (peer look, no ref)', !!peerEl && peerEl.classList.contains('peer-msg') && !peerEl.classList.contains('user') && !/\[6e2fb2\]/.test(peerEl.textContent), peerEl ? peerEl.className : 'missing');
      // after a compaction the live session gets one "Squall (memory)" note: never twice for the same compaction, never on a reset
      const memBefore = (bmi.pending || []).filter(p => p.who === 'Squall (memory)').length;
      const compactEvt = { role: 'event', text: 'The session was summarized to free up memory (compacted).', compact: 'selftest-compact-1', time: new Date().toISOString() };
      onMirror({ agent: bn, reset: false, entries: [Object.assign({}, compactEvt)] });
      onMirror({ agent: bn, reset: false, entries: [Object.assign({}, compactEvt)] });   // the same compaction again
      onMirror({ agent: bn, reset: true, entries: [Object.assign({}, compactEvt, { compact: 'selftest-compact-0' })] });   // a first read or a mirror reset
      const memNotes = (bmi.pending || []).filter(p => p.who === 'Squall (memory)');
      ok('compaction: one "Squall (memory)" note per compaction, none on a reset', memNotes.length === memBefore + 1 && /You were just compacted/.test(memNotes[memNotes.length - 1].raw || ''), (memNotes.length - memBefore) + ' note(s)');
      // a local bot whose session was compacted starts its next prompt with the vault reminder, once per compaction
      const cA = chatById('dm:' + A);
      S.compacts[A] = Date.now() + 1;
      const memP1 = buildPrompt(cA, A, 'Storm: check the vault').prompt;
      const memP2 = buildPrompt(cA, A, 'Storm: and again').prompt;
      ok('compaction: a compacted bot starts its next prompt with the vault reminder, once', memP1.startsWith(BOT_REMINDER) && !memP2.startsWith(BOT_REMINDER), memP1.slice(0, 80));
      delete S.compacts[A]; delete S.compactNoted[A];
      // timers: a restored timer nudges once its chat has gone busy and then idle (the report: no nudge after a restart)
      S.mirror[bn].pending = []; S.mirror[bn].kickAt = 0;   // only this check's messages are in play
      S.timers[bchat.id] = { until: Infinity, mins: undefined, lastNudge: 0, quick: 0, pending: 0, busySeen: false, idleSince: 0, startedAt: Date.now(), waitLogged: false };
      timerWatchStart();
      onMirror({ agent: bn, reset: false, status: { working: true, at: new Date().toISOString(), tool: '', detail: '' }, entries: [] });
      await sleep(2600);
      onMirror({ agent: bn, reset: false, status: { working: false, at: new Date().toISOString(), tool: '', detail: '' }, entries: [{ role: 'assistant', text: 'All done for now.', time: new Date().toISOString() }] });
      await waitFor(() => !!S.timers[bchat.id] && S.timers[bchat.id].lastNudge > 0, 25000).catch(() => {});
      ok('a restored timer nudges once its chat has gone busy and then idle', !!S.timers[bchat.id] && S.timers[bchat.id].lastNudge > 0, S.timers[bchat.id] ? 'busySeen ' + S.timers[bchat.id].busySeen : 'timer gone');
      stopTimer(bchat.id, true);
      // Done on the timer dial: the length starts on this chat now; an idle chat gets its first nudge once; Off stops a running timer
      const zChat = chatById('dm:' + Z), savedWork = S.workFor;
      openChat(zChat.id); await sleep(100);
      const zRuns = [];
      const realCallZ = Bridge.call;
      Bridge.call = (cmd, args) => { if (cmd === 'run') zRuns.push(args); return realCallZ(cmd, args); };
      try {
        S.workFor = 10;
        applyTimerDial();
        ok('Done starts the timer on the active chat', !!S.timers[zChat.id] && S.timers[zChat.id].mins === 10, S.timers[zChat.id] ? 'running' : 'not running');
        // an idle chat's first nudge goes out right away (checked at once: a live peer answers through the relay, not a local run)
        const firstNudge = !!S.timers[zChat.id] && S.timers[zChat.id].lastNudge > 0;
        stopTimer(zChat.id, true);
        ok('an idle chat gets its first nudge right when Done is pressed', firstNudge, firstNudge ? 'nudged' : 'no nudge');
        await waitFor(idle, 60000).catch(() => {});
        S.workFor = 30; startTimer(zChat, 30);
        S.workFor = 'off'; applyTimerDial();
        ok('Done with Off stops a running timer, with the stopped note', !S.timers[zChat.id] && zChat.messages.some(m => /Work timer stopped/.test(m.text || '')), '');
      } finally { Bridge.call = realCallZ; S.workFor = savedWork; }
      stopTimer(bchat.id, true);
      if (!hadMirror) delete S.mirror[bn];
      stopMirrors();
      stopLink(); S.liveMode = false;
      // ---------- teammates end to end: the + Teammate form, Keep and Allow, rename through the menu, the bot actions, a removal during a run ----------
      const diskAgent = async n => (await Bridge.call('teamDisk', { name: n })).agent;
      const diskNames = async () => (await Bridge.call('teamDisk', { name: '' })).names;
      const namesBefore = JSON.stringify(await diskNames());
      const setForm = (name, role, prompt) => { document.getElementById('at-name').value = name; document.getElementById('at-role').value = role; document.getElementById('at-prompt').value = prompt; };
      const formAdd = () => document.querySelector('.add-modal [data-t="add"]').click();
      openAddTeammate();
      for (const [name, rx] of [['Storm', /taken by Storm/], [A.toLowerCase(), /already on the team/], ['a!', /short name/]]) {
        setForm(name, '', '');
        formAdd();
        await sleep(350);
        const st = document.getElementById('at-status').textContent;
        ok('the + Teammate form refuses "' + name + '", says why, and adds nothing', rx.test(st) && JSON.stringify(await diskNames()) === namesBefore, st);
      }
      setForm('Quill', 'Writer', 'Write short, clear notes.');
      document.querySelectorAll('.add-modal .add-color')[1].click();
      formAdd();
      await waitFor(() => !!chatById('dm:Quill'), 10000).catch(() => {});
      await sleep(200);
      const quillDisk = await diskAgent('Quill');
      ok('the form adds the teammate to team.json with its role, color and prompt', !!quillDisk && quillDisk.role === 'Writer' && quillDisk.color === '#3D9BE9' && /Write short/.test(quillDisk.prompt || ''), quillDisk ? quillDisk.role + ' ' + quillDisk.color : 'not on disk');
      await waitFor(() => !!document.querySelector('.member[data-chat="dm:Quill"]'), 10000).catch(() => { });
      { const pg = parseGreet('Hey Storm, I\'m Quill.\nWhat should my job be?\nJOBS: Write release notes | Tidy the vault | Draft messages');
        ok('a JOBS: line becomes three chips and leaves the greeting text', pg.chips.length === 3 && pg.chips[1] === 'Tidy the vault' && !/JOBS/.test(pg.text) && /job be\?$/.test(pg.text), JSON.stringify(pg));
        const qp = (S.greetPrompts || {}).Quill || '';
        ok('a new teammate’s own session is told it was just made: name, role, brief and who added it', /just created/.test(qp) && /Your name: Quill/.test(qp) && /Your role: Writer/.test(qp) && /Write short/.test(qp) && /Storm himself/.test(qp) && /JOBS:/.test(qp), qp.slice(0, 120));
        ok('while it writes the greeting, its chat shows it typing', !!(S.typing['dm:Quill'] || {}).Quill || chatById('dm:Quill').messages.some(m => m.greet), '');
        await waitFor(() => chatById('dm:Quill') && chatById('dm:Quill').messages.some(m => m.greet), 30000).catch(() => {});
        const qc = chatById('dm:Quill'); const gm = qc && qc.messages.find(m => m.greet);
        ok('a new teammate greets Storm in its chat (written by its session, the template only as a fallback)', !!gm && gm.who === 'Quill' && gm.kind === 'agent' && !!String(gm.text || '').trim() && !/JOBS:/.test(gm.text) && (gm.greetBy === 'claude' || /job/i.test(gm.text)) && !/brought me on/.test(gm.text) && (gm.chips || []).length === 3 && !(S.typing['dm:Quill'] || {}).Quill, gm ? (gm.greetBy + ': ' + gm.text.slice(0, 80)) : 'no greeting');
        openChat('dm:Quill'); await sleep(300); await Bridge.call('capture', { name: '0-new-teammate-greeting' }).catch(() => {}); }
      ok('the new teammate’s icon and direct chat appear', !!document.querySelector('.member[data-chat="dm:Quill"]') && !!chatById('dm:Quill'), '');
      // Quill gets a routine, a session, seen entries, a timer and a seat in a group, so Allow has something to clear
      await Bridge.call('routineAdd', { name: 'Quill check', bot: 'Quill', prompt: 'check the notes', time: '09:00', days: 'daily' }).then(r => { S.team.routines = r.routines; });
      S.sessions['dm:Quill|Quill'] = 'quill-session-1'; S.seen['dm:Quill|Quill'] = ['seen-1'];
      S.timers['dm:Quill'] = { until: Infinity, mins: 'inf', lastNudge: 0, quick: 0, pending: 0, busySeen: false, idleSince: 0, startedAt: Date.now(), waitLogged: false };
      timerWatchStart();
      const gQ = createGroup('Quill group', ['Quill', A]);
      // Right-click → Delete → Keep: nothing changes
      openBotMenu('Quill', 60, 240);
      document.querySelector('.bot-menu [data-botact="delete"]').click();
      await sleep(200);
      document.querySelector('.modal-back [data-t="close"]').click();   // Keep
      await sleep(200);
      ok('Keep leaves the teammate, its icon, its chat and its timer as they were', !!(await diskAgent('Quill')) && !!document.querySelector('.member[data-chat="dm:Quill"]') && !!S.timers['dm:Quill'] && !!chatById('dm:Quill'), '');
      // Right-click → Delete → Allow: the icon, chat, timer, session map, seen entries, routines and group seat all go
      openBotMenu('Quill', 60, 240);
      document.querySelector('.bot-menu [data-botact="delete"]').click();
      await sleep(200);
      document.querySelector('.modal-back .vault-go').click();   // Delete
      await waitFor(() => !chatById('dm:Quill'), 8000).catch(() => {});
      await sleep(300);
      const quillLeft = await diskAgent('Quill');
      const routinesLeft = ((await Bridge.call('teamDisk', { name: 'Quill' })).routines || []).filter(r => r.bot === 'Quill').length;
      ok('Allow removes the teammate and its routine from team.json', !quillLeft && routinesLeft === 0, (quillLeft ? 'still on disk' : 'gone') + ', routines left ' + routinesLeft);
      ok('Allow removes its icon, its direct chat and its timer', !document.querySelector('.member[data-chat="dm:Quill"]') && !chatById('dm:Quill') && !S.timers['dm:Quill'], '');
      ok('Allow removes its session-map and seen entries, and its seat in the group', !Object.keys(S.sessions).some(k => k.endsWith('|Quill')) && !Object.keys(S.seen).some(k => k.endsWith('|Quill')) && (!chatById(gQ.id) || !chatById(gQ.id).members.includes('Quill')), '');
      // the same name comes back as a fresh teammate: no old session
      openAddTeammate();
      setForm('Quill', 'Writer', 'Write again.');
      formAdd();
      await waitFor(() => !!chatById('dm:Quill'), 10000).catch(() => {});
      await sleep(200);
      ok('a removed name comes back as a fresh teammate, with no old session', !!(await diskAgent('Quill')) && !Object.values(Object.fromEntries(Object.entries(S.sessions).filter(([k]) => k.endsWith('|Quill')))).includes('quill-session-1'), '');
      await waitFor(() => !(S.greeting || {}).Quill, 30000).catch(() => {});
      // rename through the menu: the chat, icon, session, timer and routine follow the new name
      S.sessions['dm:Quill|Quill'] = 'quill-session-2';
      S.timers['dm:Quill'] = { until: Infinity, mins: 'inf', lastNudge: 0, quick: 0, pending: 0, busySeen: false, idleSince: 0, startedAt: Date.now(), waitLogged: false };
      await Bridge.call('routineAdd', { name: 'Quill check', bot: 'Quill', prompt: 'check the notes', time: '09:00', days: 'daily' }).then(r => { S.team.routines = r.routines; });
      openBotMenu('Quill', 60, 240);
      document.querySelector('.bot-menu [data-botact="rename"]').click();
      await sleep(200);
      document.getElementById('rb-name').value = 'Quip';
      document.querySelector('.modal-back .vault-go').click();   // Rename
      await waitFor(() => !!chatById('dm:Quip'), 10000).catch(() => {});
      await sleep(300);
      const quipRoutines = ((await Bridge.call('teamDisk', { name: 'Quip' })).routines || []).filter(r => r.bot === 'Quip').length;
      ok('rename through the menu: the chat, icon and session follow', !!chatById('dm:Quip') && !chatById('dm:Quill') && !!document.querySelector('.member[data-chat="dm:Quip"]') && !!S.sessions['dm:Quip|Quip'], '');
      ok('rename: team.json, the routine and the timer follow', !!(await diskAgent('Quip')) && !(await diskAgent('Quill')) && quipRoutines === 1 && !!S.timers['dm:Quip'], 'routines ' + quipRoutines);
      // the bot actions take the same paths: create_bot adds, delete_bot asks Storm first, Allow on the card removes
      const teamChat = chatById('team');
      await doAction({ do: 'create_bot', name: 'Kiwi', role: 'Helper', prompt: 'Help with small jobs.' }, teamChat, A, false);
      await sleep(200);
      ok('a bot’s create_bot action adds a teammate, on the same path as the form', !!(await diskAgent('Kiwi')) && !!chatById('dm:Kiwi'), '');
      await waitFor(() => chatById('dm:Kiwi') && chatById('dm:Kiwi').messages.some(m => m.greet), 30000).catch(() => {});
      { const kc = chatById('dm:Kiwi'), km = kc && kc.messages.find(m => m.greet), kp = (S.greetPrompts || {}).Kiwi || '';
        ok('a bot-made teammate greets Storm too: its session is told who brought it on, and it asks its job', !!km && km.who === 'Kiwi' && kp.includes('Mention that ' + A + ' brought you on') && /Help with small jobs/.test(kp) && (km.greetBy === 'claude' || km.text.includes(A + ' brought me on')) && (km.chips || []).length === 3, km ? (km.greetBy + ': ' + km.text.slice(0, 90)) : 'no greeting');
        const prevActive = S.active; openChat('dm:Kiwi'); await sleep(300);
        ok('the greeting shows its starter jobs as chips', document.querySelectorAll('#chat .qchip').length === 3, document.querySelectorAll('#chat .qchip').length + ' chips');
        await Bridge.call('capture', { name: '0-bot-made-greeting' }).catch(() => {}); openChat(prevActive); await sleep(150); }
      await doAction({ do: 'delete_bot', name: 'Kiwi' }, teamChat, A, false);
      const kiwiCard = teamChat.messages.slice().reverse().find(m => m.kind === 'confirm' && m.action && m.action.name === 'Kiwi');
      ok('delete_bot asks Storm first: a card, and nothing is removed yet', !!kiwiCard && !!(await diskAgent('Kiwi')), '');
      await resolveConfirm(kiwiCard.id, true);
      await sleep(250);
      ok('Allow on the card removes it, its chat included', !(await diskAgent('Kiwi')) && !chatById('dm:Kiwi'), '');
      // a teammate removed while it's running: its run stops, nothing sticks
      await doAction({ do: 'create_bot', name: 'Mo', role: 'Helper', prompt: 'Help.' }, teamChat, A, false);
      await sleep(200);
      openChat('dm:Mo'); await sleep(100);
      const midRun = say('Start a long task and keep going.');
      await sleep(400);
      const midRunning = !!S.flows['dm:Mo'];
      await deleteBot('Mo');
      await midRun.catch(() => {});
      await waitFor(() => !S.flows['dm:Mo'], 30000).catch(() => {});
      ok('a teammate removed mid-run stops cleanly: no stuck flow, gone from team.json and the page', midRunning && !S.flows['dm:Mo'] && !(await diskAgent('Mo')) && !chatById('dm:Mo'), midRunning ? 'it was running' : 'it had already finished');
      // the rest of the team keeps working
      openChat('team');
      const teamBefore = chatById('team').messages.length;
      await say('Quick check after the changes: who is still here?');
      ok('the team chat still gets replies after the team changes', chatById('team').messages.slice(teamBefore).some(m => m.kind === 'agent'), '');
      // Storm's message sent while a team round is running doesn't wait for the round: it is in the chat at once (not "queued"), a free member
      // answers it right away, a busy one gets it as its next message, and the chat ends with no round left running
      {
        const tchat = chatById('team'), runLog = [], realRun = Bridge.call;
        Bridge.call = (cmd, args) => { if (cmd === 'run') runLog.push({ agent: args.agent, prompt: String(args.prompt || '') }); return realRun(cmd, args); };
        try {
          openChat('team');
          const before = tchat.messages.length;
          $('#input').value = 'First thing for the team'; send();
          await sleep(400);
          const running = !!S.flows[tchat.id];
          $('#input').value = 'Second thing, sent mid-round'; send();
          await sleep(60);
          const second = tchat.messages.slice(before).find(m => m.who === 'Storm' && /Second thing/.test(m.text || ''));
          ok('a team message sent while a round runs is in the chat at once, not queued', running && !!second && !second.queued && !$('#chat').querySelector('.q-tag'), 'round running ' + running + ', message ' + (second ? (second.queued ? 'queued' : 'sent') : 'missing'));
          await waitFor(idle, 120000).catch(() => { });
          const members = tchat.members.filter(n => S.byName[n]);
          const got = members.filter(n => runLog.some(r => r.agent === n && /Second thing/.test(r.prompt)));
          ok('every member got the second message, a busy one as its next', got.length === members.length && members.length > 1, got.length + ' of ' + members.length);
          ok('after both rounds nothing is running and nothing is queued', !S.flows[tchat.id] && !Object.keys(flowN).length && !tchat.messages.some(m => m.queued), Object.keys(flowN).join(',') + ' ' + (S.flows[tchat.id] ? 'running' : 'idle'));
        } finally { Bridge.call = realRun; }
      }
      // bots can't rename Chief: a rename_bot action on the lead is refused with a note, the host is never asked, and Chief keeps its name
      {
        const lead = S.lead.name, teamChat = chatById('team'), seen = teamChat.messages.length;
        let hostAsked = 0;
        const realCall = Bridge.call;
        Bridge.call = (cmd, args) => { if (cmd === 'teamRename') hostAsked++; return realCall.call(Bridge, cmd, args); };
        try { await doAction({ do: 'rename_bot', from: lead.toLowerCase(), to: 'Boss' }, teamChat, 'Barry', false); }
        finally { Bridge.call = realCall; }
        const noted = teamChat.messages.slice(seen).some(m => String(m.text || '').includes('can only be renamed by Storm (right-click)'));
        ok('a bot can’t rename Chief: refused with a note in the team chat, the host is never asked, the name stays', S.lead.name === lead && hostAsked === 0 && noted, 'host asked ' + hostAsked + ', note ' + noted);
        let hostRefused = '';
        try { await Bridge.call('teamRename', { from: lead, to: 'Boss', byBot: true }); } catch (e) { hostRefused = e.message; }
        ok('the host also refuses a bot rename of Chief (byBot)', /can only be renamed by Storm/.test(hostRefused), hostRefused || 'no error');
      }
      await stripSelfTest(ok);
    } catch (e) { R.errors.push(String(e && e.stack || e)); }
    R.ok = R.errors.length === 0 && R.checks.every(c => c.ok);
    await Bridge.call('selftestDone', R);
  }

  // Tempest.exe --livetest <dir>: a real round trip through the live link to a teammate running on this PC.
  async function liveTest() {
    const R = { checks: [], errors: [] };
    const ok = (name, pass, info) => R.checks.push({ name, ok: !!pass, info: info == null ? null : String(info) });
    try {
      if (NO_RELAY()) {
        // direct (Storm, 20 Oct: "No relay. Direct messages. Now."): the message box sends to a teammate's own Claude session, run by
        // Squall itself, and its reply shows in that chat. Fox by default: a small session that isn't the lead
        const realCall = Bridge.call, calls = [];
        Bridge.call = (cmd, args) => { calls.push(cmd); return realCall(cmd, args); };
        await waitFor(() => Object.keys(S.mirror).length > 0, 60000);
        const me = S.agents.find(a => a.name === 'Fox' && S.mirror[a.name]) || S.agents.find(a => !a.lead && S.mirror[a.name]);
        ok('a teammate has its own Claude session on this PC', !!me, Object.keys(S.mirror).join(', '));
        if (me) {
          await waitFor(() => !S.mirror[me.name].loading, 30000).catch(() => {});
          const before = (S.mirror[me.name].entries || []).length;
          openChat('dm:' + me.name);
          $('#input').value = 'Squall direct-message test from Chief (no relay): reply with the single word pong.';
          send();
          await waitFor(() => (S.mirror[me.name].entries || []).slice(before).some(e => e.role === 'assistant' && /pong/i.test(e.text || '')), 240000).catch(() => {});
          const got = (S.mirror[me.name].entries || []).slice(before);
          const asked = got.find(e => e.role === 'user'), reply = got.filter(e => e.role === 'assistant').pop();
          ok('the message box sent it straight into ' + me.name + '’s session', !!asked && directView(asked.text).text === 'Squall direct-message test from Chief (no relay): reply with the single word pong.', asked && directView(asked.text).text);
          ok(me.name + '’s real reply shows in its chat', !!reply && /pong/i.test(reply.text || ''), reply && reply.text);
          ok('no relay was started or used', S.link.status !== 'on' && !calls.some(c => /^bridge/.test(c)), 'link ' + S.link.status + ', relay calls ' + calls.filter(c => /^bridge/.test(c)).length);
          await sleep(300); await Bridge.call('capture', { name: 'live-direct' });
        }
        Bridge.call = realCall;
        R.ok = R.errors.length === 0 && R.checks.every(c => c.ok);
        await Bridge.call('selftestDone', R);
        return;
      }
      await waitFor(() => S.link.status === 'on' && S.link.peers.length > 0, 90000);
      ok('real relay lists sessions on this PC', true, S.link.peers.map(p => p.name + ':' + p.status).join(' '));
      const me = S.agents.find(a => { const p = peerFor(a.name); return p && p.status !== 'offline'; });
      ok('a teammate is running live here', !!me, me && me.name);
      if (me) {
        openChat('dm:' + me.name);
        $('#input').value = 'Live test from Tempest: please reply with the word pong.';
        send();
        await sleep(100);
        await waitFor(() => !Object.keys(S.flows).length, 290000);
        const r = chatById('dm:' + me.name).messages.filter(m => m.who === me.name).pop();
        ok('the real reply arrived in the right chat', !!r && r.live === true, r && r.text);
        await sleep(300); await Bridge.call('capture', { name: 'live-real' });
      }
    } catch (e) { R.errors.push(String(e && e.stack || e)); }
    stopLink();
    R.ok = R.errors.length === 0 && R.checks.every(c => c.ok);
    await Bridge.call('selftestDone', R);
  }

  // ---------- strip layout: Squall docked in the strip below the work area ----------
  // The host posts {event:'strip', on} when the window moves into or out of the strip, and init carries the state.
  // In the strip the team column becomes one top bar (Squall mark, teammate row, chat name, Live, timer), the chat fills the
  // middle, the right pane is a drawer behind Live, and below 700 px the teammate row becomes a chat switcher (CSS).
  // Elements move instead of being copied, so their handlers and the teammates' animations keep working.
  let stripOn = false, stripLeaveTimer = 0, stripReturnTimer = 0;
  // the chat keeps its place when the layout changes (Storm: "When going from strip to full screen it makes the chat scroll up alot"):
  // at the bottom it stays at the bottom; otherwise the message at the top of the view stays at the top while the layout settles
  function chatPlace() {
    const box = $('#chat');
    if (!box) return null;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    let anchor = null, off = 0;
    if (!atBottom) {
      const top = box.getBoundingClientRect().top;
      for (const el of box.children) { const r = el.getBoundingClientRect(); if (r.bottom > top + 4) { anchor = el; off = r.top - top; break; } }
    }
    return { atBottom, anchor, off };
  }
  function restorePlace(pl) {
    const box = $('#chat');
    if (!box || !pl) return;
    if (pl.atBottom || !pl.anchor || !pl.anchor.isConnected) { box.scrollTop = box.scrollHeight; return; }
    box.scrollTop += (pl.anchor.getBoundingClientRect().top - box.getBoundingClientRect().top) - pl.off;
  }
  function keepPlace(pl, ms) { const t0 = performance.now(); const step = () => { restorePlace(pl); if (performance.now() - t0 < ms) requestAnimationFrame(step); }; requestAnimationFrame(step); }
  function applyStrip(on) {
    on = !!on;
    if (on === stripOn) return;
    stripOn = on;
    clearTimeout(stripLeaveTimer); clearTimeout(stripReturnTimer);
    const body = document.body, place = chatPlace();
    sfx(on ? 'layoutIn' : 'layoutOut');   // Storm: "Make it have a cool animation and sound when changing layouts"
    if (on) {
      body.classList.remove('strip-leave', 'strip-return');
      $('#team').insertBefore($('#chat-head'), $('#strip-live'));   // chat name, just before Live
      // the timer stays under the message box: the rail shows only the bots (Storm, 19 Oct: "Keep the rail, bots only")
      body.classList.add('strip');
      keepPlace(place, 600);
      return;
    }
    closeStripMenu();
    body.classList.remove('live-open');
    body.classList.add('strip-leave');                              // the top bar lifts away first...
    keepPlace(place, 240);
    stripLeaveTimer = setTimeout(() => {                            // ...then the normal layout comes back
      $('#center').insertBefore($('#chat-head'), $('#banner'));
      $('.under-row').insertBefore($('#timer'), $('#ctx'));
      body.classList.remove('strip', 'strip-leave');
      body.classList.add('strip-return');
      keepPlace(place, 700);
      stripReturnTimer = setTimeout(() => body.classList.remove('strip-return'), 340);
    }, 240);
  }
  function closeStripMenu() {
    document.querySelectorAll('.strip-menu').forEach(m => m.remove());
    const b = $('#strip-switch'); if (b) b.setAttribute('aria-expanded', 'false');
  }
  function toggleStripMenu() {
    if (document.querySelector('.strip-menu')) { closeStripMenu(); return; }
    const menu = document.createElement('div');
    menu.className = 'strip-menu';
    menu.innerHTML = S.chats.map(c => {
      const a = c.kind === 'dm' ? S.byName[c.members[0]] : null;
      return '<button class="sm-item' + (S.active === c.id ? ' on' : '') + '" data-chat="' + esc(c.id) + '">' + (a ? avatar(a.name, a.color) : groupIcon(c)) +
        '<span>' + esc(c.name) + '</span>' + badge(c.unread) + '</button>';
    }).join('');
    document.body.append(menu);
    $('#strip-switch').setAttribute('aria-expanded', 'true');
  }
  // the switcher button shows the active chat (narrow strip)
  function renderStripSwitch() {
    const b = $('#strip-switch'), c = activeChat();
    if (!b || !c) return;
    const a = c.kind === 'dm' ? S.byName[c.members[0]] : null;
    b.innerHTML = (a ? avatar(a.name, a.color) : groupIcon(c)) + '<span class="sw-name">' + esc(c.name) + '</span><span class="sw-caret">▾</span>';
  }
  $('#strip-switch').addEventListener('click', toggleStripMenu);
  // the rail is the bots only: in the strip the logo opens one menu with the brand's buttons (update log, settings, ...) and Live
  function toggleRailMenu() {
    if (document.querySelector('.rail-menu')) { closeStripMenu(); return; }
    closeStripMenu();
    const menu = document.createElement('div');
    menu.className = 'strip-menu rail-menu';
    const btns = [...document.querySelectorAll('#team .brand .icon-btn')].concat([$('#strip-live')]).filter(Boolean);
    btns.forEach((b, i) => {
      const it = document.createElement('button');
      it.className = 'sm-item';
      it.innerHTML = (b.querySelector('svg') ? b.querySelector('svg').outerHTML : '') + '<span>' + esc(b.id === 'strip-live' ? 'Live pane' : String(b.title || b.textContent || '').split(':')[0]) + '</span>';
      it.addEventListener('click', e => { e.stopPropagation(); closeStripMenu(); b.click(); });
      menu.append(it);
    });
    document.body.append(menu);
  }
  $('#team .brand .logo').addEventListener('click', e => { if (!stripOn) return; e.stopPropagation(); toggleRailMenu(); });
  $('#strip-live').addEventListener('click', () => document.body.classList.toggle('live-open'));
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && stripOn) { closeStripMenu(); document.body.classList.remove('live-open'); } });

  // self-test: the strip at 1910 x 340 and at 470 x 340, then back to the window's normal size and layout
  async function stripSelfTest(ok) {
    closeModal();   // the team checks before this can leave a dialog open, and the screenshots must show the strip
    const rectOf = el => el.getBoundingClientRect();
    // the test window is invisible, so CSS transitions may not advance on their own: finish them, so each check sees the end state
    const finishAll = () => document.getAnimations().forEach(a => { try { a.finish(); } catch (e) { } });
    const before = await Bridge.call('stripTest', { on: false });
    await Bridge.call('stripTest', { on: true, width: 1910, height: 340 });
    await sleep(120);
    const enterAnim = document.getAnimations().length > 0;
    finishAll();
    await sleep(340);
    const team = $('#team'), tb = rectOf(team), w0 = document.documentElement.clientWidth, h0 = document.documentElement.clientHeight;
    const logo = team.querySelector('.logo'), av = document.querySelector('#agents .member:not(.add) .avatar');
    const avPx = av ? rectOf(av).width : 0;
    ok('strip: the host’s strip state reaches the page', document.body.classList.contains('strip') && stripOn, '');
    ok('strip: switching into the strip animates (motion on)', enterAnim, '');
    // Storm: "Make the agent sidebar be on the left in the strip instead so I have more chat height"
    ok('strip wide: the team is a narrow rail on the left, the full height', tb.width <= 56 && tb.height >= h0 - 20 && tb.left <= 8 && !!logo && rectOf(logo).width > 20, Math.round(tb.width) + ' x ' + Math.round(tb.height) + ' of ' + h0);
    ok('strip wide: the chat gets the full height beside the rail', rectOf($('#center')).height >= h0 - 20 && rectOf($('#center')).left >= tb.right - 1, Math.round(rectOf($('#center')).height) + ' of ' + h0);
    ok('strip wide: the rail keeps 24–28 px avatars, and they still animate', avPx >= 24 && avPx <= 28 && !!document.querySelector('#agents .av-wrap'), Math.round(avPx) + ' px');
    const hd = $('#chat-head'), tm = $('#timer');
    // the rail is the bots only (Storm, 19 Oct): the timer stays under the message box, Live and the brand's buttons are in the logo's menu
    const brandBtnsHidden = [...team.querySelectorAll('.brand .icon-btn')].every(b => b.offsetParent === null) && $('#strip-live').offsetParent === null;
    logo.click(); await sleep(60);
    const railMenu = document.querySelector('.rail-menu');
    const railItems = railMenu ? railMenu.querySelectorAll('.sm-item').length : 0;
    closeStripMenu();
    ok('strip wide: the rail shows only the bots; the logo opens the menu with the buttons and Live', tm.parentElement !== team && brandBtnsHidden && railItems >= 2 && /Live/.test(railMenu ? railMenu.textContent : ''), railItems + ' menu items');
    ok('strip wide: the right pane is off screen until Live opens it', rectOf($('#live')).left >= w0 - 1, Math.round(rectOf($('#live')).left) + ' of ' + w0);
    $('#strip-live').click(); await sleep(330); finishAll();
    const drawerOpen = rectOf($('#live')).left < w0 - 40;
    $('#strip-live').click(); await sleep(330); finishAll();
    ok('strip wide: Live slides the right pane in as a drawer, and Live again slides it out', drawerOpen && rectOf($('#live')).left >= w0 - 1, '');
    // Storm: "Make the send bar go to the right of the 4 buttons when in the strip so I can see the chat more"
    const urr = rectOf(document.querySelector('#composer > .under-row')), irr = rectOf(document.querySelector('#composer > .input-row'));
    ok('strip wide: the four buttons sit left of the message box, on one line', Math.abs((urr.top + urr.bottom) / 2 - (irr.top + irr.bottom) / 2) < 16 && urr.right <= irr.left + 1 && irr.width > 300, Math.round(urr.right) + ' / ' + Math.round(irr.left));
    const input = $('#input');
    input.value = 'one\ntwo\nthree\nfour\nfive\nsix\nseven'; autosize(); await sleep(40);
    const grown = rectOf(input).height;
    input.value = ''; autosize();
    ok('strip wide: the composer grows to about 3 lines and no more', grown > 40 && grown <= 68, Math.round(grown) + ' px');
    const sw = document.documentElement.scrollWidth;
    ok('strip wide: the row of @ chips is hidden, so the chat gets that height', getComputedStyle($('#targets')).display === 'none', getComputedStyle($('#targets')).display);
    ok('strip wide: no horizontal scroll', sw <= w0 && $('#app').scrollWidth <= $('#app').clientWidth + 1, sw + ' of ' + w0);
    const bub = document.querySelector('#chat .bubble'), fs = bub ? parseFloat(getComputedStyle(bub).fontSize) : 0;
    ok('strip wide: messages are readable (13 px or more) in a chat 300 px or wider', fs >= 13 && rectOf($('#chat')).width >= 300, fs + ' px, chat ' + Math.round(rectOf($('#chat')).width) + ' px');
    await Bridge.call('capture', { name: 'strip-1910' });

    // the narrow slot: the teammate row gives way to a chat switcher
    await Bridge.call('stripTest', { on: true, width: 470, height: 340 });
    await sleep(120);
    const narrowAnim = document.getAnimations().length > 0;
    finishAll();
    await sleep(340);
    const nt = rectOf($('#team'));
    ok('strip narrow: the rail stays, and the chat still gets 300 px or more', nt.width <= 56 && rectOf($('#chat')).width >= 300, 'rail ' + Math.round(nt.width) + ' px, chat ' + Math.round(rectOf($('#chat')).width) + ' px');
    const otherChat = S.chats.find(c => c.id !== S.active && document.querySelector('#agents [data-chat="' + c.id + '"]'));
    if (otherChat) document.querySelector('#agents [data-chat="' + otherChat.id + '"]').click();
    await sleep(60);
    ok('strip narrow: a teammate in the rail opens its chat', !!otherChat && S.active === otherChat.id, String(S.active));
    const ir = rectOf($('#input')), sw2 = document.documentElement.scrollWidth;
    ok('strip narrow: no horizontal scroll, and the composer is usable', sw2 <= w0 && ir.width >= 150 && ir.height >= 18, sw2 + ' of ' + w0 + ', box ' + Math.round(ir.width) + ' px');
    await Bridge.call('capture', { name: 'strip-470' });

    // LIGHTNING's strip (Storm, 21 Oct: "Not going in the strip"): its body is 194 px tall there, and the strip layout must fit it
    await Bridge.call('stripTest', { on: true, width: 1910, height: 194 });
    await sleep(120); finishAll(); await sleep(340);
    const shortChat = rectOf($('#chat')), shortBox = rectOf($('#input')), shortVh = window.innerHeight;
    ok('strip short (194 px, LIGHTNING): the chat shows and the message box is on screen', shortVh <= 200 && shortChat.height >= 60 && shortBox.height >= 18 && shortBox.bottom <= shortVh + 1,
      'window ' + shortVh + ' px, chat ' + Math.round(shortChat.height) + ' px, box bottom ' + Math.round(shortBox.bottom));
    await Bridge.call('capture', { name: 'strip-194' });

    // back to the wide row: the switch animates the other way too
    await Bridge.call('stripTest', { on: true, width: 1910, height: 340 });
    await sleep(120);
    const wideAnim = document.getAnimations().length > 0;
    finishAll();
    await sleep(340);
    ok('strip wide again: the rail is still on the left and the chat has the full height', rectOf($('#team')).width <= 56 && rectOf($('#center')).height >= h0 - 20, Math.round(rectOf($('#team')).width) + ' px rail');

    // leaving the strip: the normal layout comes back
    await Bridge.call('stripTest', { on: false, width: before.width, height: before.height });
    await sleep(120);
    const leaveAnim = document.body.classList.contains('strip-leave') || document.getAnimations().length > 0;
    finishAll();
    await sleep(520);
    const tc = rectOf($('#team')), cc = rectOf($('#center')), lc = rectOf($('#live'));
    ok('leaving the strip restores the normal layout: team column, chat and right pane side by side', !document.body.classList.contains('strip') && tc.width > 150 && tc.height > 200 && cc.width > 300 && lc.width > 250 && lc.left >= cc.right - 1, [tc.width, cc.width, lc.width].map(Math.round).join(' / '));
    ok('leaving the strip puts the chat name back in the chat and the timer under the composer', hd.parentElement === $('#center') && tm.parentElement === document.querySelector('.under-row'), '');
    ok('leaving the strip animates the switch back', leaveAnim, '');
  }

  // ---------- boot ----------
  // groky r97: Alt+Up / Alt+Down step through the chats in sidebar order (wrapping); with Shift they jump to the next or previous chat that has unread messages.
  // Goes to whichever pane has the focus, like a click on the tile; ignored while a card, menu, viewer or Starx keyboard passthrough is open. No CSS, no motion.
  document.addEventListener('keydown', e => {
    if (!e.altKey || e.ctrlKey || e.metaKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || e.isComposing) return;
    if (document.querySelector('.modal-back, .qk-back, .lightbox, #at-pop:not(:empty)') || (e.target && e.target.closest && e.target.closest('#live-body .comp-pic'))) return;
    const ids = []; document.querySelectorAll('#agents .member[data-chat]').forEach(m => { const id = m.dataset.chat; if (id && !ids.includes(id) && chatById(id)) ids.push(id); });
    if (ids.length < 2) return;
    const cur = S.split && S.focusRight ? S.split : S.active, dir = e.key === 'ArrowDown' ? 1 : -1, n = ids.length;
    let i = ids.indexOf(cur); if (i < 0) i = dir > 0 ? -1 : 0;
    let to = null;
    if (e.shiftKey) { for (let k = 1; k <= n; k++) { const id = ids[((i + dir * k) % n + n) % n]; const c = chatById(id); if (id !== cur && c && c.unread > 0) { to = id; break; } } }
    else to = ids[((i + dir) % n + n) % n];
    e.preventDefault(); e.stopPropagation();
    if (!to || to === cur) return;
    openChat(to);
    requestAnimationFrame(() => { const m = document.querySelector('#agents .member.on'); if (m && m.scrollIntoView) m.scrollIntoView({ block: 'nearest' }); const inp = document.getElementById(S.split && S.focusRight ? 'input2' : 'input'); if (inp && !inp.disabled) inp.focus(); });
  });
  // groky r99: Ctrl+1..8 open the Nth chat in sidebar order, Ctrl+9 the last one, like browser tabs. Goes to whichever pane has the focus. No CSS, no motion.
  document.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.isComposing) return;
    const m = /^(?:Digit|Numpad)([1-9])$/.exec(e.code || ''); if (!m) return;
    if (document.querySelector('.modal-back, .qk-back, .lightbox, #at-pop:not(:empty)') || (e.target && e.target.closest && e.target.closest('#live-body .comp-pic'))) return;
    const ids = []; document.querySelectorAll('#agents .member[data-chat]').forEach(x => { const id = x.dataset.chat; if (id && !ids.includes(id) && chatById(id)) ids.push(id); });
    if (!ids.length) return;
    e.preventDefault(); e.stopPropagation();
    const k = +m[1], to = k === 9 ? ids[ids.length - 1] : ids[k - 1];
    const cur = S.split && S.focusRight ? S.split : S.active;
    if (!to || to === cur) return;
    openChat(to);
    requestAnimationFrame(() => { const t = document.querySelector('#agents .member.on'); if (t && t.scrollIntoView) t.scrollIntoView({ block: 'nearest' }); const inp = document.getElementById(S.split && S.focusRight ? 'input2' : 'input'); if (inp && !inp.disabled) inp.focus(); });
  });
  // groky r102: Alt+C copies the newest teammate reply in the open (left) chat, using that message's own copy button so its check mark shows. No new CSS, no glow.
  document.addEventListener('keydown', e => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.isComposing || (e.code !== 'KeyC' && e.key !== 'c' && e.key !== 'C')) return;
    if (document.querySelector('.modal-back, .qk-back, .lightbox, #at-pop:not(:empty)') || (e.target && e.target.closest && e.target.closest('#live-body .comp-pic'))) return;
    if (S.split && S.focusRight) return;
    const msgs = Array.from(document.querySelectorAll('#chat .msg:not(.user):not(.folded):not(.pending)'));
    let btn = null;
    for (let i = msgs.length - 1; i >= 0 && !btn; i--) { const b = msgs[i].querySelector('.mcopy[data-copy]'); if (b && messageTextOf(b.dataset.copy)) btn = b; }
    e.preventDefault(); e.stopPropagation();
    if (!btn) return;
    copyMessage(btn);
  });
  // groky r103: Alt+R quotes the newest teammate reply in the open (left) chat into the box, using that message's own reply arrow so its check mark shows. No new CSS, no glow.
  document.addEventListener('keydown', e => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.isComposing || (e.code !== 'KeyR' && e.key !== 'r' && e.key !== 'R')) return;
    if (document.querySelector('.modal-back, .qk-back, .lightbox, #at-pop:not(:empty)') || (e.target && e.target.closest && e.target.closest('#live-body .comp-pic'))) return;
    if (S.split && S.focusRight) return;
    const inp = $('#input');
    if (!inp || inp.disabled) return;
    const msgs = Array.from(document.querySelectorAll('#chat .msg:not(.user):not(.folded):not(.pending)'));
    let btn = null;
    for (let i = msgs.length - 1; i >= 0 && !btn; i--) { const b = msgs[i].querySelector('.mquote[data-quote]'); if (b && messageTextOf(b.dataset.quote)) btn = b; }
    e.preventDefault(); e.stopPropagation();
    if (!btn) return;
    quoteMessage(btn);
  });
  // groky r104: Alt+N scrolls the chat that owns the focus to its 'New messages' line, leaving a little room above it. No CSS, no glow, smooth scroll unless reduced motion.
  document.addEventListener('keydown', e => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.isComposing || (e.code !== 'KeyN' && e.key !== 'n' && e.key !== 'N')) return;
    if (document.querySelector('.modal-back, .qk-back, .lightbox, #at-pop:not(:empty)') || (e.target && e.target.closest && e.target.closest('#live-body .comp-pic'))) return;
    const t = e.target, ours = t && (t.id === 'input' || t.id === 'input2');
    const right = !!(S.split && (ours ? t.id === 'input2' : S.focusRight));
    const box = document.getElementById(right ? 'chat2' : 'chat');
    if (!box || box.offsetParent === null) return;
    const nl = box.querySelector('.new-line');
    e.preventDefault(); e.stopPropagation();
    if (!nl) return;
    const top = nl.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - Math.min(48, box.clientHeight * 0.12);
    const beh = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    box.scrollTo({ top: Math.max(0, top), behavior: beh });
  });
  // groky r100: Page Up / Page Down scroll the chat that owns the focus even while typing in its box; Ctrl+End jumps to the latest message and Ctrl+Home to the top
  // (only when the box is empty or the focus is not in a text field, so caret moves inside a draft still work). No CSS, no glow, smooth scroll unless reduced motion.
  document.addEventListener('keydown', e => {
    if (e.altKey || e.metaKey || e.isComposing || e.defaultPrevented) return;
    const pg = (e.key === 'PageUp' || e.key === 'PageDown') && !e.ctrlKey && !e.shiftKey;
    const he = (e.key === 'Home' || e.key === 'End') && e.ctrlKey && !e.shiftKey;
    if (!pg && !he) return;
    if (document.querySelector('.modal-back, .qk-back, .lightbox, #at-pop:not(:empty)') || (e.target && e.target.closest && e.target.closest('#live-body, .find-bar'))) return;
    const t = e.target, tag = t && t.tagName, inText = tag === 'TEXTAREA' || tag === 'INPUT' || (t && t.isContentEditable);
    const ours = t && (t.id === 'input' || t.id === 'input2');
    if (inText && !ours) return;
    if (he && ours && t.value) return;
    const right = !!(S.split && (ours ? t.id === 'input2' : S.focusRight));
    const box = document.getElementById(right ? 'chat2' : 'chat');
    if (!box || box.offsetParent === null || box.scrollHeight <= box.clientHeight + 2) return;
    if (!pg && !ours && !inText && t && t.closest && t.closest('.scroller, .set-modal, .vault-list, .vault-body, .note-view, pre, .table-wrap') && !box.contains(t)) return;
    e.preventDefault();
    const beh = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    if (pg) { box.scrollBy({ top: (e.key === 'PageUp' ? -1 : 1) * Math.max(120, box.clientHeight * 0.85), behavior: beh }); return; }
    if (e.key === 'End') { autoScrollAt = Date.now(); box.scrollTo({ top: box.scrollHeight, behavior: beh }); if (!right) hideJump(); }
    else box.scrollTo({ top: 0, behavior: beh });
  });
  // groky r106: start typing anywhere and it lands in the message box, like Slack or Discord. If the focus is on nothing in particular (after clicking a
  // message, the sidebar or a button) a plain letter, digit or symbol focuses the box of the pane that owns the focus and is typed at the end of any draft.
  // Never while a text field, card, menu, viewer, @ list or Starx keyboard passthrough has the keys, or while the box is read-only. Space and Enter keep
  // their normal jobs. Inserted with insertText so undo, autosize and the per-chat draft all work as if typed. No CSS, no motion, no glow.
  document.addEventListener('keydown', e => {
    if (e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey || e.isComposing || !e.key || e.key.length !== 1 || e.key === ' ') return;
    const t = e.target, tag = t && t.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
    if (t && t.closest && t.closest('#live-body .comp-pic, [data-askin], .bot-menu, .find-bar')) return;
    if (document.querySelector('.modal-back, .qk-back, .lightbox, .bot-menu, #at-pop:not(:empty)')) return;
    const inp = document.getElementById(S.split && S.focusRight ? 'input2' : 'input');
    if (!inp || inp.disabled || inp.readOnly || inp.offsetParent === null) return;
    e.preventDefault();
    inp.focus();
    const n = inp.value.length; try { inp.setSelectionRange(n, n); } catch (_) { }
    let ok = false; try { ok = document.execCommand('insertText', false, e.key); } catch (_) { }
    if (!ok) { inp.setRangeText(e.key, n, n, 'end'); inp.dispatchEvent(new Event('input', { bubbles: true })); }
  });
  // groky r107: open a chat beside the current one straight from the sidebar. Ctrl+click or middle-click a teammate, group or team tile and it
  // opens in the right split pane (making the split if there is none), with the focus and the cursor in that pane's box. The left chat stays put.
  // Ctrl+clicking the chat already on the left just focuses it. No CSS, no motion, no glow.
  function openBeside(id) {
    const c = chatById(id); if (!c) return;
    if (id === S.active) { if (S.split && S.focusRight) { S.focusRight = false; renderAll(); } const i1 = document.getElementById('input'); if (i1) i1.focus(); return; }
    if (S.split !== id) { S.split = id; sfx('chat'); }
    S.focusRight = true; c.unread = 0;
    renderAll(); renderTimerChip(); saveSoon(); updateTitle();
    const i2 = document.getElementById('input2'); if (i2) i2.focus();
  }
  const besideTile = t => (t && t.closest) ? t.closest('#agents .member[data-chat]') : null;
  document.addEventListener('mousedown', e => { if (e.button === 1 && besideTile(e.target)) e.preventDefault(); }, true);   // no autoscroll cursor
  document.addEventListener('auxclick', e => {
    if (e.button !== 1) return;
    const m = besideTile(e.target); if (!m || chatHistBlocked(e.target)) return;
    e.preventDefault(); railTipHide(); hideCard(); openBeside(m.dataset.chat);
  });
  window.addEventListener('click', e => {
    if (e.button !== 0 || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
    const m = besideTile(e.target); if (!m || chatHistBlocked(e.target)) return;
    e.preventDefault(); e.stopPropagation(); railTipHide(); hideCard(); openBeside(m.dataset.chat);
  }, true);
  // groky r108: Ctrl+\ toggles the split view from the keyboard, the same as the Split button. Opening puts the cursor in the new right-hand box;
  // closing puts it back in the left box. Skipped while a modal, Ctrl+K, the image viewer or the @ list is open. No CSS, no motion, no glow.
  document.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.isComposing || e.repeat) return;
    if (e.code !== 'Backslash' && e.key !== '\\') return;
    if (chatHistBlocked(e.target)) return;
    e.preventDefault(); e.stopPropagation();
    const had = !!S.split;
    railTipHide(); hideCard(); toggleSplit();
    if (!had && !S.split) return;
    sfx(had ? 'close' : 'chat');
    if (!had) { S.focusRight = true; renderAll(); }
    updateTitle();
    const box = document.getElementById(S.split ? 'input2' : 'input'); if (box) box.focus();
  });
  // groky r109: Ctrl+Shift+M mutes Squall's sounds from anywhere, and pressing it again brings back the level Storm had (all sounds or just the ping).
  // The message box placeholder says 'Sounds off' or 'Sounds on' for a moment, then goes back. Saved like the Settings switch. No CSS, no motion, no glow.
  let muteKeyWas = null, muteKeyTip = 0, muteKeyPh = null;
  document.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey || e.isComposing || e.repeat) return;
    if (e.code !== 'KeyM' && e.key !== 'M' && e.key !== 'm') return;
    if (chatHistBlocked(e.target)) return;
    e.preventDefault(); e.stopPropagation();
    if (S.sounds !== 'off') { muteKeyWas = S.sounds; S.sounds = 'off'; }
    else { S.sounds = muteKeyWas === 'ping' ? 'ping' : 'all'; muteKeyWas = null; }
    S.sound = S.sounds !== 'off'; saveSoon();
    if (S.sounds === 'all') sfx('done'); else if (S.sound) playPing();
    const box = document.getElementById(S.split && S.focusRight ? 'input2' : 'input');
    if (!box) return;
    clearTimeout(muteKeyTip);
    if (muteKeyPh === null || muteKeyPh.box !== box) { if (muteKeyPh) muteKeyPh.box.placeholder = muteKeyPh.text; muteKeyPh = { box, text: box.placeholder }; }
    box.placeholder = S.sound ? (S.sounds === 'ping' ? 'Sounds on: just the finish ping' : 'Sounds on') : 'Sounds off (Ctrl+Shift+M turns them back on)';
    const tipNow = box.placeholder; muteKeyTip = setTimeout(() => { if (muteKeyPh) { if (muteKeyPh.box.placeholder === tipNow) muteKeyPh.box.placeholder = muteKeyPh.text; muteKeyPh = null; } }, 1800);
  });
  // groky r119: Shift+Esc marks every chat as read, like Slack. Clears the unread counts on all chats (the sidebar badges and the (N) in the
  // window title go away), saves, and the focused box placeholder says how many were cleared for a moment. Nothing is deleted. No CSS, no motion, no glow.
  let readAllTip = 0, readAllPh = null;
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || e.isComposing || e.repeat) return;
    if (chatHistBlocked(e.target)) return;
    e.preventDefault(); e.stopPropagation();
    let n = 0, chats = 0;
    for (const c of S.chats) if (c.unread > 0) { n += c.unread; chats++; c.unread = 0; }
    if (n) { saveSoon(); renderTeamSoon(); updateTitle(); }
    const box = document.getElementById(S.split && S.focusRight ? 'input2' : 'input');
    if (!box || box.disabled) return;
    clearTimeout(readAllTip);
    if (readAllPh === null || readAllPh.box !== box) { if (readAllPh) readAllPh.box.placeholder = readAllPh.text; readAllPh = { box, text: box.placeholder }; }
    box.placeholder = n ? 'Marked ' + chats + (chats === 1 ? ' chat' : ' chats') + ' as read (' + n + (n === 1 ? ' message' : ' messages') + ')' : 'Everything is already read';
    const tipNow = box.placeholder; readAllTip = setTimeout(() => { if (readAllPh) { if (readAllPh.box.placeholder === tipNow) readAllPh.box.placeholder = readAllPh.text; readAllPh = null; } }, 1800);
  });
  // groky r120: Alt+Shift+C copies the whole open (left) chat as plain text, oldest first, as "Name, time" then the message, with a blank
  // line between messages, ready to paste into a note or another chat. Uses each message's own copy text (messageTextOf), so live-session
  // notes are stripped the same way as the copy button. The box placeholder says how many messages were copied for a moment. No CSS, no motion, no glow.
  let copyChatTip = 0, copyChatPh = null;
  document.addEventListener('keydown', e => {
    if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey || e.isComposing || e.repeat || (e.code !== 'KeyC' && e.key !== 'c' && e.key !== 'C')) return;
    if (chatHistBlocked(e.target)) return;
    if (S.split && S.focusRight) return;
    const chat = document.getElementById('chat');
    if (!chat || chat.offsetParent === null) return;
    e.preventDefault(); e.stopPropagation();
    const parts = [];
    chat.querySelectorAll('.msg:not(.pending)').forEach(m => {
      const b = m.querySelector('.mcopy[data-copy]');
      const text = b ? messageTextOf(b.dataset.copy).trim() : '';
      if (!text) return;
      const who = m.querySelector('.who'), nm = who && (who.querySelector('.who-name') || who.firstChild);
      const name = (nm && nm.textContent || (m.classList.contains('user') ? 'You' : '')).trim() || 'Message';
      const w = m.querySelector('.who .when'), when = w ? w.textContent.trim() : '';
      parts.push(name + (when ? ', ' + when : '') + '\n' + text);
    });
    const box = document.getElementById('input');
    const tip = msg => {
      if (!box || box.disabled) return;
      clearTimeout(copyChatTip);
      if (copyChatPh === null || copyChatPh.box !== box) { if (copyChatPh) copyChatPh.box.placeholder = copyChatPh.text; copyChatPh = { box, text: box.placeholder }; }
      box.placeholder = msg;
      const tipNow = box.placeholder; copyChatTip = setTimeout(() => { if (copyChatPh) { if (copyChatPh.box.placeholder === tipNow) copyChatPh.box.placeholder = copyChatPh.text; copyChatPh = null; } }, 1800);
    };
    if (!parts.length) { tip('Nothing to copy in this chat yet'); return; }
    navigator.clipboard.writeText(parts.join('\n\n') + '\n').then(() => { sfx('copy'); tip('Copied ' + parts.length + (parts.length === 1 ? ' message' : ' messages') + ' from this chat'); }).catch(() => tip('Couldn\u2019t copy the chat. Try again'));
  });
  // groky r139: cells copied from Excel, Google Sheets or any tab-separated table paste into the message box as a markdown table
  // (markdown.js already renders tables), first row as the header. Only when the clipboard is plain text with no files, at least two rows
  // and two columns, every row has the same number of tab-separated cells, and the caret is not inside a fenced code block. Ctrl+Shift+V
  // keeps the plain text. Blank lines are added around the table when needed so it renders. One insertText edit so Ctrl+Z undoes it.
  // Only in #input / #input2 when editable. No CSS, no motion, no glow.
  (function tablePaste() {
    let plainAt = 0;
    document.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === 'KeyV') plainAt = Date.now();
    }, true);
    document.addEventListener('paste', e => {
      const t = e.target;
      if (!t || (t.id !== 'input' && t.id !== 'input2') || t.disabled || t.readOnly) return;
      if (Date.now() - plainAt < 1500) { plainAt = 0; return; }
      const cd = e.clipboardData;
      if (!cd || Array.from(cd.items || []).some(i => i.kind === 'file')) return;
      let txt = cd.getData('text/plain') || '';
      if (!txt.includes('\t') || txt.length > 40000) return;
      txt = txt.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
      const rows = txt.split('\n');
      if (rows.length < 2 || rows.length > 300) return;
      const cells = rows.map(r => r.split('\t'));
      const n = cells[0].length;
      if (n < 2 || n > 30 || cells.some(c => c.length !== n)) return;
      if (cells.some(c => c.every(x => !x.trim()))) return;
      const v = t.value, a = t.selectionStart, b = t.selectionEnd;
      if (a == null || b == null) return;
      let inFence = false;
      for (const ln of v.slice(0, a).split('\n')) if (/^[ \t>]*(\x60{3,}|~{3,})/.test(ln)) inFence = !inFence;
      if (inFence) return;
      const cell = x => x.trim().replace(/\|/g, '\\|') || ' ';
      const line = c => '| ' + c.map(cell).join(' | ') + ' |';
      let out = [line(cells[0]), '| ' + cells[0].map(() => '---').join(' | ') + ' |'].concat(cells.slice(1).map(line)).join('\n');
      const before = v.slice(0, a), after = v.slice(b);
      if (before && !/\n\n$/.test(before)) out = (before.endsWith('\n') ? '\n' : '\n\n') + out;
      if (after && !/^\n\n/.test(after)) out += after.startsWith('\n') ? '\n' : '\n\n';
      e.preventDefault(); e.stopImmediatePropagation();
      let ok = false;
      try { ok = document.execCommand('insertText', false, out); } catch (_) {}
      if (!ok) { t.setRangeText(out, a, b, 'end'); t.dispatchEvent(new Event('input', { bubbles: true })); }
    }, true);
  })();
  // groky r140: text copied from a web page, Google Docs, Word or a Squall reply keeps its links, bold, italics, inline code, strikethrough,
  // headings, quotes and bullet or numbered lists as markdown when pasted into the message box (markdown.js renders all of them), so links
  // no longer turn into bare words. Only when the clipboard has HTML with at least one link, list, heading or emphasis, no files, no table
  // (r139 handles cells), is not a single URL (r121 handles that), the caret is not inside a fenced code block, and the markdown actually
  // adds something over the plain text. Parsed with DOMParser, which never runs scripts; images and styles are dropped. Ctrl+Shift+V keeps
  // the plain text. One insertText edit so Ctrl+Z undoes it. Only in #input / #input2 when editable. No CSS, no motion, no glow.
  (function richPaste() {
    let plainAt = 0;
    document.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === 'KeyV') plainAt = Date.now();
    }, true);
    const SKIP = /^(SCRIPT|STYLE|META|LINK|TITLE|HEAD|IMG|svg|SVG|NOSCRIPT|TEMPLATE|IFRAME|OBJECT|BUTTON|INPUT|SELECT|TEXTAREA)$/;
    const wrap = (inner, mk) => {
      const m = inner.match(/^(\s*)([\s\S]*?)(\s*)$/);
      if (!m || !m[2]) return inner;
      return m[1] + mk + m[2] + mk + m[3];
    };
    const weightOff = el => /font-weight\s*:\s*(normal|[1-4]00)\b/i.test(el.getAttribute('style') || '');
    function kids(el, ctx) { let o = ''; for (const c of el.childNodes) o += conv(c, ctx); return o; }
    function conv(n, ctx) {
      if (n.nodeType === 3) return ctx.pre ? n.nodeValue : n.nodeValue.replace(/[\s\u00a0]+/g, ' ');
      if (n.nodeType !== 1) return '';
      const tag = n.tagName.toUpperCase();
      if (SKIP.test(n.tagName)) return '';
      switch (tag) {
        case 'BR': return '\n';
        case 'HR': return '\n\n---\n\n';
        case 'A': {
          const inner = kids(n, ctx), href = (n.getAttribute('href') || '').trim();
          if (!/^https?:\/\//i.test(href) || ctx.inLink) return inner;
          const txt = inner.replace(/\s+/g, ' ').trim();
          if (!txt) return '';
          const url = href.replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\s/g, '%20');
          if (txt === href || txt === href.replace(/\/$/, '')) return ' ' + href + ' ';
          ctx.rich = true;
          const lt = inner.match(/^\s*/)[0] ? ' ' : '', tt = /\s$/.test(inner) ? ' ' : '';
          return lt + '[' + txt.replace(/[\[\]]/g, '\\  // groky r121: paste a link over selected words in the message box') + '](' + url + ')' + tt;
        }
        case 'STRONG': case 'B':
          if (tag === 'B' && weightOff(n)) return kids(n, ctx);
          { const i = kids(n, ctx); if (i.trim()) ctx.rich = true; return wrap(i, '**'); }
        case 'EM': case 'I':
          { const i = kids(n, ctx); if (i.trim()) ctx.rich = true; return wrap(i, '_'); }
        case 'DEL': case 'S': case 'STRIKE':
          { const i = kids(n, ctx); if (i.trim()) ctx.rich = true; return wrap(i, '~~'); }
        case 'CODE': case 'KBD': case 'SAMP':
          if (ctx.pre) return n.textContent;
          { const t = n.textContent.replace(/\s+/g, ' '); if (!t.trim()) return t; ctx.rich = true; return wrap(t, '\x60'); }
        case 'PRE': {
          ctx.rich = true;
          const t = n.textContent.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
          return '\n\n\x60\x60\x60\n' + t + '\n\x60\x60\x60\n\n';
        }
        case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': {
          const t = kids(n, ctx).replace(/\s+/g, ' ').trim();
          if (!t) return '';
          ctx.rich = true;
          return '\n\n' + '#'.repeat(Math.min(3, +tag[1])) + ' ' + t + '\n\n';
        }
        case 'BLOCKQUOTE': {
          const t = kids(n, ctx).replace(/\n{3,}/g, '\n\n').trim();
          if (!t) return '';
          ctx.rich = true;
          return '\n\n' + t.split('\n').map(l => l.trim() ? '> ' + l : '>').join('\n') + '\n\n';
        }
        case 'UL': case 'OL': {
          const depth = ctx.depth || 0, items = [];
          let k = parseInt(n.getAttribute('start') || '1', 10); if (!(k >= 0)) k = 1;
          for (const c of n.children) {
            if (c.tagName.toUpperCase() !== 'LI') continue;
            const body = kids(c, Object.assign({}, ctx, { depth: depth + 1, rich: false })).replace(/[ \t]+\n/g, '\n').replace(/\n{2,}/g, '\n').trim();
            const mk = tag === 'OL' ? (k++) + '. ' : '- ';
            items.push('  '.repeat(depth) + mk + body);
          }
          if (!items.length) return kids(n, ctx);
          ctx.rich = true;
          return (depth ? '\n' : '\n\n') + items.join('\n') + (depth ? '\n' : '\n\n');
        }
        case 'P': case 'SECTION': case 'ARTICLE': case 'HEADER': case 'FOOTER': case 'FIGURE': case 'ASIDE': case 'MAIN': case 'NAV':
          return '\n\n' + kids(n, ctx) + '\n\n';
        case 'DIV': case 'LI': case 'DT': case 'DD': case 'TR': case 'FIGCAPTION':
          return '\n' + kids(n, ctx) + '\n';
        default: return kids(n, ctx);
      }
    }
    document.addEventListener('paste', e => {
      const t = e.target;
      if (!t || (t.id !== 'input' && t.id !== 'input2') || t.disabled || t.readOnly) return;
      if (Date.now() - plainAt < 1500) { plainAt = 0; return; }
      const cd = e.clipboardData;
      if (!cd || Array.from(cd.items || []).some(i => i.kind === 'file')) return;
      const html = cd.getData('text/html') || '', plain = cd.getData('text/plain') || '';
      if (!html || html.length > 300000) return;
      if (/^\s*https?:\/\/\S+\s*$/i.test(plain)) return;
      let doc;
      try { doc = new DOMParser().parseFromString(html, 'text/html'); } catch (_) { return; }
      const body = doc && doc.body;
      if (!body || body.querySelector('table')) return;
      if (!body.querySelector('a[href], li, h1, h2, h3, h4, strong, b, em, i, del, s, blockquote, code')) return;
      const v = t.value, a = t.selectionStart, b = t.selectionEnd;
      if (a == null || b == null) return;
      let inFence = false;
      for (const ln of v.slice(0, a).split('\n')) if (/^[ \t>]*(\x60{3,}|~{3,})/.test(ln)) inFence = !inFence;
      if (inFence) return;
      const ctx = { depth: 0, rich: false };
      let out;
      try { out = conv(body, ctx); } catch (_) { return; }
      out = out.replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
      let fence = false;
      out = out.split('\n').map(l => {
        if (/^\x60{3}/.test(l)) { fence = !fence; return l; }
        if (fence) return l;
        if (/^\s*(- |\d+\. )/.test(l)) return l.replace(/(\S) {2,}/g, '$1 ');
        return l.trim().replace(/ {2,}/g, ' ');
      }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
      if (!ctx.rich || !out) return;
      const flat = x => x.replace(/\s+/g, ' ').trim();
      if (flat(out) === flat(plain)) return;
      e.preventDefault(); e.stopImmediatePropagation();
      let ok = false;
      try { ok = document.execCommand('insertText', false, out); } catch (_) {}
      if (!ok) { t.setRangeText(out, a, b, 'end'); t.dispatchEvent(new Event('input', { bubbles: true })); }
    }, true);
  })();
  // groky r121: paste a link over selected words in the message box and they become a markdown link, [words](url), like Slack or Notion.
  // Only when the clipboard is a single http(s) URL with no files, the selection is one line of plain words (not itself a URL, no brackets),
  // in #input or #input2 and the box is editable. Inserted with insertText so Ctrl+Z puts the words back and autosize/drafts/@ all see it.
  // Anything else pastes normally. No CSS, no motion, no glow.
  document.addEventListener('paste', e => {
    const t = e.target;
    if (!t || (t.id !== 'input' && t.id !== 'input2') || t.disabled || t.readOnly) return;
    const a = t.selectionStart, b = t.selectionEnd;
    if (a == null || b == null || b <= a) return;
    const cd = e.clipboardData;
    if (!cd || Array.from(cd.items || []).some(i => i.kind === 'file')) return;
    let url = (cd.getData('text/plain') || '').trim();
    if (url.length > 2000 || !/^https?:\/\/[^\s<>"]+$/i.test(url)) return;
    const sel = t.value.slice(a, b), core = sel.trim();
    if (!core || core.length > 300 || /[\r\n\[\]]/.test(sel) || /^(https?:\/\/|www\.)/i.test(core)) return;
    url = url.replace(/\(/g, '%28').replace(/\)/g, '%29');
    const lead = sel.slice(0, sel.indexOf(core)), trail = sel.slice(sel.indexOf(core) + core.length);
    const out = lead + '[' + core + '](' + url + ')' + trail;
    e.preventDefault(); e.stopImmediatePropagation();
    let ok = false;
    try { ok = document.execCommand('insertText', false, out); } catch (_) {}
    if (!ok) { t.setRangeText(out, a, b, 'end'); t.dispatchEvent(new Event('input', { bubbles: true })); }
  }, true);
  // groky r122: markdown helpers in the message box, like Slack or Notion. Ctrl+B / Ctrl+I / Ctrl+E wrap the selected words in **, _ or a
  // backtick (pressing again unwraps them); with nothing selected they drop an empty pair with the caret inside. Shift+Enter on a list line
  // (- item, * item, 1. item, - [ ] item) starts the next item with the same indent and the next number; on an empty item it clears the
  // marker to end the list. Only in #input / #input2, editable, not while the @ picker is open. All edits go through insertText so Ctrl+Z
  // undoes them and autosize, drafts and @ see the change. No CSS, no motion, no glow.
  (function composeHelpers() {
    const put = (t, a, b, text, selA, selB) => {
      t.focus(); try { t.setSelectionRange(a, b); } catch (_) {}
      let ok = false; try { ok = document.execCommand('insertText', false, text); } catch (_) {}
      if (!ok) { t.setRangeText(text, a, b, 'end'); t.dispatchEvent(new Event('input', { bubbles: true })); }
      if (selA != null) try { t.setSelectionRange(selA, selB == null ? selA : selB); } catch (_) {}
    };
    const MARK = { KeyB: '**', KeyI: '_', KeyE: String.fromCharCode(96) };
    function wrap(t, m) {
      const v = t.value; let a = t.selectionStart, b = t.selectionEnd;
      if (b > a) { // keep the spaces around a double-click selection outside the markers
        while (b > a && /\s/.test(v[b - 1])) b--;
        while (a < b && /\s/.test(v[a])) a++;
      }
      const L = m.length, sel = v.slice(a, b);
      if (b > a && sel.length >= 2 * L && sel.startsWith(m) && sel.endsWith(m)) { const inner = sel.slice(L, sel.length - L); put(t, a, b, inner, a, a + inner.length); return; }
      if (b > a && v.slice(a - L, a) === m && v.slice(b, b + L) === m) { put(t, a - L, b + L, sel, a - L, b - L); return; }
      if (b === a) { put(t, a, a, m + m, a + L); return; }
      put(t, a, b, m + sel + m, a + L, b + L);
    }
    const LIST = /^(\s*)(?:([-*+\u2022])|(\d{1,4})([.)]))(\s+)(\[[ xX]\]\s+)?(.*)$/;
    function listNext(t) {
      const v = t.value, a = t.selectionStart, b = t.selectionEnd;
      if (a !== b) return false;
      const ls = v.lastIndexOf('\n', a - 1) + 1, le0 = v.indexOf('\n', a), le = le0 < 0 ? v.length : le0;
      if (v.slice(a, le).trim()) return false; // caret in the middle of the item: plain new line
      const line = v.slice(ls, le), m = LIST.exec(line);
      if (!m) return false;
      if (!m[7].trim()) { put(t, ls, le, m[1].length ? m[1].slice(0, Math.max(0, m[1].length - 2)) : '', null); return true; }
      const mark = m[2] ? m[2] : (parseInt(m[3], 10) + 1) + m[4];
      const box = m[6] ? '[ ] ' : '';
      put(t, a, a, '\n' + m[1] + mark + m[5].replace(/\s+/, ' ') + box, null);
      return true;
    }
    document.addEventListener('keydown', e => {
      const t = e.target;
      if (!t || (t.id !== 'input' && t.id !== 'input2') || t.disabled || t.readOnly || e.isComposing) return;
      if (document.querySelector('#at-pop:not(:empty)')) return;
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && MARK[e.code]) {
        e.preventDefault(); e.stopImmediatePropagation(); wrap(t, MARK[e.code]); return;
      }
      if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        if (listNext(t)) { e.preventDefault(); e.stopImmediatePropagation(); }
      }
    }, true);
  })();
  // groky r123: Tab / Shift+Tab indent and outdent list items in the message box, like Notion or Obsidian. Works on the line under the
  // caret or every line of a selection, but only when each non-blank line touched is a list item (- * + bullets, 1. or 1) numbers,
  // [ ] checkboxes); anywhere else Tab keeps moving focus as before. Two spaces per level. Only in #input / #input2, editable, not
  // composing, not while the @ picker is open. One insertText edit so Ctrl+Z undoes it and autosize and drafts see it. No CSS, no motion.
  (function listIndent() {
    const LIST = /^(\s*)(?:[-*+\u2022]|\d{1,4}[.)])\s+/;
    document.addEventListener('keydown', e => {
      if (e.key !== 'Tab' || e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return;
      const t = e.target;
      if (!t || (t.id !== 'input' && t.id !== 'input2') || t.disabled || t.readOnly) return;
      if (document.querySelector('#at-pop:not(:empty)')) return;
      const v = t.value, a = t.selectionStart, b0 = t.selectionEnd;
      const b = b0 > a && v[b0 - 1] === '\n' ? b0 - 1 : b0; // a selection ending at a line start leaves that line alone
      const ls = v.lastIndexOf('\n', a - 1) + 1, le0 = v.indexOf('\n', b), le = le0 < 0 ? v.length : le0;
      const lines = v.slice(ls, le).split('\n');
      if (!lines.some(l => l.trim()) || !lines.every(l => !l.trim() || LIST.test(l))) return;
      e.preventDefault(); e.stopImmediatePropagation();
      const out = e.shiftKey;
      let first = 0;
      const next = lines.map((l, i) => {
        if (!l.trim()) return l;
        let d = 0, r = l;
        if (!out) { r = '  ' + l; d = 2; }
        else if (l[0] === '\t') { r = l.slice(1); d = -1; }
        else { const n = Math.min(2, l.length - l.trimStart().length); r = l.slice(n); d = -n; }
        if (i === 0) first = d;
        return r;
      });
      const text = next.join('\n');
      if (text === lines.join('\n')) return;
      t.focus(); try { t.setSelectionRange(ls, le); } catch (_) {}
      let ok = false; try { ok = document.execCommand('insertText', false, text); } catch (_) {}
      if (!ok) { t.setRangeText(text, ls, le, 'end'); t.dispatchEvent(new Event('input', { bubbles: true })); }
      try {
        if (a === b0) { const c = Math.max(ls, a + first); t.setSelectionRange(c, c); }
        else t.setSelectionRange(Math.max(ls, a + first), ls + text.length + (b0 - b));
      } catch (_) {}
    }, true);
  })();
  // groky r138: Ctrl+Alt+1/2/3 makes the caret's line, or every line the selection touches, a # / ## / ### heading (markdown.js
  // already renders h1-h3); pressing the same level again, or Ctrl+Alt+0, turns it back into plain text. An existing heading of another
  // level is switched, not stacked. Indentation and > quote prefixes stay in front; blank lines and lines inside a fenced code block are
  // skipped. Only in #input / #input2, editable, not composing, not while the @ picker is open. Plain Ctrl+1..9 chat jumps are untouched
  // since they need no Alt. One insertText edit so Ctrl+Z undoes it. No CSS, no motion, no glow.
  (function headingToggle() {
    const P = /^((?:[ \t]*>[ \t]?)*[ \t]*)(#{1,6}[ \t]+)?/;
    const put = (t, a, b, text) => {
      t.focus(); try { t.setSelectionRange(a, b); } catch (_) {}
      let ok = false; try { ok = document.execCommand('insertText', false, text); } catch (_) {}
      if (!ok) { t.setRangeText(text, a, b, 'select'); t.dispatchEvent(new Event('input', { bubbles: true })); }
    };
    document.addEventListener('keydown', e => {
      if (!(e.ctrlKey || e.metaKey) || !e.altKey || e.shiftKey || e.isComposing) return;
      const m = /^(?:Digit|Numpad)([0-3])$/.exec(e.code || ''); if (!m) return;
      const t = e.target;
      if (!t || (t.id !== 'input' && t.id !== 'input2') || t.disabled || t.readOnly) return;
      if (document.querySelector('#at-pop:not(:empty)')) return;
      e.preventDefault(); e.stopImmediatePropagation();
      const lvl = +m[1];
      const v = t.value, a = t.selectionStart, b = t.selectionEnd, st = t.scrollTop;
      const ls = v.lastIndexOf('\n', a - 1) + 1;
      const endAt = b > a && v[b - 1] === '\n' && b - 1 >= ls ? b - 1 : b;
      let le = v.indexOf('\n', Math.max(endAt, ls)); if (le < 0) le = v.length;
      let inFence = false;
      for (const ln of v.slice(0, ls).split('\n')) if (/^[ \t>]*(\x60{3,}|~{3,})/.test(ln)) inFence = !inFence;
      const lines = v.slice(ls, le).split('\n');
      const fenced = lines.map(ln => { const f = /^[ \t>]*(\x60{3,}|~{3,})/.test(ln); const r = inFence || f; if (f) inFence = !inFence; return r; });
      const live = lines.map((ln, i) => !fenced[i] && ln.replace(/^[ \t>]*/, '').trim() !== '');
      if (!live.some(Boolean)) return;
      const cur = ln => { const x = P.exec(ln); return x[2] ? x[2].replace(/[ \t]+$/, '').length : 0; };
      const want = lvl === 0 ? 0 : (lines.every((ln, i) => !live[i] || cur(ln) === lvl) ? 0 : lvl);
      let delta0 = 0;
      const out = lines.map((ln, i) => {
        if (!live[i]) return ln;
        const x = P.exec(ln), pre = x[1], old = x[2] || '';
        const nx = pre + (want ? '#'.repeat(want) + ' ' : '') + ln.slice(pre.length + old.length);
        if (i === 0) delta0 = nx.length - ln.length;
        return nx;
      }).join('\n');
      if (out === lines.join('\n')) return;
      const caretLine0 = a - ls, prefLen0 = P.exec(lines[0])[0].length;
      put(t, ls, le, out);
      if (a === b) {
        const pos = ls + Math.max(caretLine0 < prefLen0 ? P.exec(out.split('\n')[0])[0].length : caretLine0 + delta0, 0);
        try { t.setSelectionRange(pos, pos); } catch (_) {}
      } else { try { t.setSelectionRange(ls, ls + out.length); } catch (_) {} }
      t.scrollTop = st;
    }, true);
  })();
  // groky r137: Ctrl+Shift+J joins lines in the message box (editor-style). With no selection, or a selection inside one line, the
  // next line is pulled up onto the caret's line; with a selection across lines, every line it touches becomes one line. Each joined
  // line loses its leading indentation, and when both lines sit in a > quote the extra quote prefix goes too, so pasted wrapped text
  // reflows into one sentence. Lines are joined with a single space (none if the earlier line already ends in whitespace or the later
  // one is empty). Caret lands at the first join point. Ctrl+J (Routines) is untouched since that key has no Shift. Only in #input /
  // #input2, editable, not composing, not while the @ picker is open. One insertText edit so Ctrl+Z undoes it. No CSS, no motion.
  (function joinLines() {
    const Q = /^((?:[ \t]*>[ \t]?)+)/;
    const put = (t, a, b, text) => {
      t.focus(); try { t.setSelectionRange(a, b); } catch (_) {}
      let ok = false; try { ok = document.execCommand('insertText', false, text); } catch (_) {}
      if (!ok) { t.setRangeText(text, a, b, 'select'); t.dispatchEvent(new Event('input', { bubbles: true })); }
    };
    document.addEventListener('keydown', e => {
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey || e.isComposing) return;
      if (e.code !== 'KeyJ') return;
      const t = e.target;
      if (!t || (t.id !== 'input' && t.id !== 'input2') || t.disabled || t.readOnly) return;
      if (document.querySelector('#at-pop:not(:empty)')) return;
      e.preventDefault(); e.stopImmediatePropagation();
      const v = t.value, a = t.selectionStart, b = t.selectionEnd, st = t.scrollTop;
      const ls = v.lastIndexOf('\n', a - 1) + 1;
      const endAt = b > a && v[b - 1] === '\n' ? b - 1 : b;
      let le = v.indexOf('\n', Math.max(endAt, ls)); if (le < 0) le = v.length;
      if (v.slice(ls, le).indexOf('\n') < 0) {
        if (le >= v.length) return;
        let le2 = v.indexOf('\n', le + 1); le = le2 < 0 ? v.length : le2;
      }
      const lines = v.slice(ls, le).split('\n');
      const q0 = Q.exec(lines[0]);
      let out = lines[0], firstJoin = -1;
      for (let i = 1; i < lines.length; i++) {
        let nx = lines[i];
        if (q0) { const q = Q.exec(nx); if (q) nx = nx.slice(q[1].length); }
        nx = nx.replace(/^[ \t]+/, '');
        const sep = (!nx || /[ \t]$/.test(out) || !out.trim() || (q0 && out === q0[1])) ? '' : ' ';
        if (firstJoin < 0) firstJoin = out.length;
        out += sep + nx;
      }
      if (out === lines.join('\n')) return;
      put(t, ls, le, out);
      const pos = ls + (firstJoin < 0 ? out.length : firstJoin);
      try { t.setSelectionRange(pos, pos); } catch (_) {}
      t.scrollTop = st;
    }, true);
  })();
  // groky r145: Ctrl+] indents the caret's line, or every line the selection touches, by two spaces in the message box; Ctrl+[ takes up
  // to two spaces (or one tab) off each. Works on any line, so code and plain text can be indented, not just list items (Tab does lists).
  // Blank lines skipped. Caret stays on its character; a multi-line selection stays on the same lines. Only in #input / #input2, editable,
  // not composing, @ picker closed. One insertText edit so Ctrl+Z undoes it. No CSS, no motion, no glow.
  (function lineIndent() {
    const put = (t, a, b, txt, ca, cb) => {
      t.focus(); try { t.setSelectionRange(a, b); } catch (_) {}
      let ok = false; try { ok = document.execCommand('insertText', false, txt); } catch (_) {}
      if (!ok) { t.setRangeText(txt, a, b, 'end'); t.dispatchEvent(new Event('input', { bubbles: true })); }
      try { t.setSelectionRange(ca, cb); } catch (_) {}
    };
    document.addEventListener('keydown', e => {
      if ((e.code !== 'BracketRight' && e.code !== 'BracketLeft') || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.isComposing) return;
      const t = e.target;
      if (!t || (t.id !== 'input' && t.id !== 'input2') || t.disabled || t.readOnly) return;
      if (document.querySelector('#at-pop:not(:empty)')) return;
      const v = t.value, st = t.scrollTop, a = t.selectionStart, b = t.selectionEnd;
      if (a == null || b == null) return;
      e.preventDefault(); e.stopImmediatePropagation();
      const out = e.code === 'BracketLeft';
      const ls = v.lastIndexOf('\n', a - 1) + 1;
      let le = (b > a && v[b - 1] === '\n') ? b - 1 : v.indexOf('\n', b);
      if (le < 0) le = v.length;
      if (le < ls) le = ls;
      const lines = v.slice(ls, le).split('\n');
      let changed = false, da = 0, db = 0, pos = ls;
      const next = lines.map(l => {
        const start = pos; pos += l.length + 1;
        let n = l;
        if (!out) { if (l.trim()) n = '  ' + l; }
        else if (l[0] === '\t') n = l.slice(1);
        else { const m = /^ {1,2}/.exec(l); if (m) n = l.slice(m[0].length); }
        const d0 = n.length - l.length;
        if (d0) changed = true;
        // shift for a and b when they sit at or after this line's start
        const shift = x => { if (x < start) return 0; if (d0 >= 0) return d0; return Math.max(d0, start - x); };
        if (a >= start && a <= start + l.length) da += shift(a); else if (a > start + l.length) da += d0;
        if (b >= start && b <= start + l.length) db += shift(b); else if (b > start + l.length) db += d0;
        return n;
      });
      if (!changed) return;
      const txt = next.join('\n');
      if (lines.length > 1) put(t, ls, le, txt, ls, ls + txt.length);
      else put(t, ls, le, txt, Math.max(ls, a + da), Math.max(ls, b + db));
      t.scrollTop = st;
    }, true);
  })();
  // groky r144: Ctrl+Shift+E puts the caret's line, or every line the selection touches, inside a fenced code block in the message box
  // and keeps that text selected. On an empty line it drops an empty block with the caret inside. Pressing it again when the lines sit
  // right inside a fence pair (or the selection includes both fence lines) takes the fences off. Plain Ctrl+E inline code untouched.
  // Only in #input / #input2, editable, not composing, @ picker closed. One insertText edit so Ctrl+Z undoes it. No CSS, no motion, no glow.
  (function codeBlockWrap() {
    const BT = String.fromCharCode(96).repeat(3);
    const OPEN = /^[ \t]*(?:\x60{3,}|~{3,})[\w+#.-]*[ \t]*$/, CLOSE = /^[ \t]*(?:\x60{3,}|~{3,})[ \t]*$/;
    const inFence = (v, at) => { let n = 0; const re = /^[ \t]*(?:>[ \t]?)*[ \t]*\x60\x60\x60/gm; let m; while ((m = re.exec(v)) && m.index < at) n++; return n % 2 === 1; };
    const put = (t, a, b, txt, ca, cb) => {
      t.focus(); try { t.setSelectionRange(a, b); } catch (_) {}
      let ok = false; try { ok = document.execCommand('insertText', false, txt); } catch (_) {}
      if (!ok) { t.setRangeText(txt, a, b, 'end'); t.dispatchEvent(new Event('input', { bubbles: true })); }
      try { t.setSelectionRange(ca, cb); } catch (_) {}
    };
    document.addEventListener('keydown', e => {
      if (e.code !== 'KeyE' || !(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey || e.isComposing) return;
      const t = e.target;
      if (!t || (t.id !== 'input' && t.id !== 'input2') || t.disabled || t.readOnly) return;
      if (document.querySelector('#at-pop:not(:empty)')) return;
      const v = t.value, st = t.scrollTop, a = t.selectionStart, b = t.selectionEnd;
      if (a == null || b == null) return;
      const ls = v.lastIndexOf('\n', a - 1) + 1;
      let le = (b > a && v[b - 1] === '\n') ? b - 1 : v.indexOf('\n', b);
      if (le < 0) le = v.length;
      if (le < ls) le = ls;
      const block = v.slice(ls, le), lines = block.split('\n');
      // selection already includes both fence lines: take them off
      if (lines.length >= 2 && OPEN.test(lines[0]) && CLOSE.test(lines[lines.length - 1])) {
        e.preventDefault(); e.stopImmediatePropagation();
        const inner = lines.slice(1, -1).join('\n');
        put(t, ls, le, inner, ls, ls + inner.length); t.scrollTop = st; return;
      }
      // lines sit right inside a fence pair: take the fences off
      if (ls > 0 && le < v.length) {
        const ps = v.lastIndexOf('\n', ls - 2) + 1, prev = v.slice(ps, ls - 1);
        let ne = v.indexOf('\n', le + 1); if (ne < 0) ne = v.length;
        const next = v.slice(le + 1, ne);
        if (OPEN.test(prev) && CLOSE.test(next) && !inFence(v, ps)) {
          e.preventDefault(); e.stopImmediatePropagation();
          put(t, ps, ne, block, ps, ps + block.length); t.scrollTop = st; return;
        }
      }
      if (inFence(v, ls)) return;
      e.preventDefault(); e.stopImmediatePropagation();
      if (!block.trim()) { put(t, ls, le, BT + '\n\n' + BT, ls + 4, ls + 4); t.scrollTop = st; return; }
      put(t, ls, le, BT + '\n' + block + '\n' + BT, ls + 4, ls + 4 + block.length);
      t.scrollTop = st;
    }, true);
  })();
  // groky r143: Ctrl+Shift+L makes a markdown link in the message box. Selected words (or the word at the caret) become [words]() with
  // the caret between the parentheses, ready for the address. A selected http(s) or www address becomes [](address) with the caret in
  // the brackets, ready for the words. With nothing to wrap it inserts []() with the caret in the brackets. Only in #input / #input2,
  // editable, not composing, @ picker closed, one line at most, never inside a fenced code block. One insertText edit so Ctrl+Z undoes it. No CSS, no motion, no glow.
  (function linkWrap() {
    const URL_RE = /^(?:https?:\/\/|www\.)\S+$/i;
    const inFence = (v, at) => { let n = 0; const re = /^[ \t]*(?:>[ \t]?)*[ \t]*\x60\x60\x60/gm; let m; while ((m = re.exec(v)) && m.index < at) n++; return n % 2 === 1; };
    const put = (t, a, b, txt, ca, cb) => {
      t.focus(); try { t.setSelectionRange(a, b); } catch (_) {}
      let ok = false; try { ok = document.execCommand('insertText', false, txt); } catch (_) {}
      if (!ok) { t.setRangeText(txt, a, b, 'end'); t.dispatchEvent(new Event('input', { bubbles: true })); }
      try { t.setSelectionRange(ca, cb); } catch (_) {}
    };
    document.addEventListener('keydown', e => {
      if (e.code !== 'KeyL' || !(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey || e.isComposing) return;
      const t = e.target;
      if (!t || (t.id !== 'input' && t.id !== 'input2') || t.disabled || t.readOnly) return;
      if (document.querySelector('#at-pop:not(:empty)')) return;
      const v = t.value, st = t.scrollTop;
      let a = t.selectionStart, b = t.selectionEnd;
      if (a == null || b == null) return;
      if (inFence(v, a)) return;
      if (a === b) {
        const left = /[^\s\[\]()]*$/.exec(v.slice(0, a))[0], right = /^[^\s\[\]()]*/.exec(v.slice(a))[0];
        if (left.length + right.length) { a -= left.length; b += right.length; }
      }
      let sel = v.slice(a, b);
      const lead = /^\s*/.exec(sel)[0], trail = /\s*$/.exec(sel.slice(lead.length))[0];
      a += lead.length; b -= trail.length; sel = v.slice(a, b);
      if (sel.includes('\n')) return;
      e.preventDefault(); e.stopImmediatePropagation();
      let txt, ca, cb;
      if (!sel) { txt = '[]()'; ca = cb = a + 1; }
      else if (URL_RE.test(sel)) { const u = /^www\./i.test(sel) ? 'https://' + sel : sel; txt = '[](' + u + ')'; ca = cb = a + 1; }
      else { txt = '[' + sel + ']()'; ca = cb = a + txt.length - 1; }
      put(t, a, b, txt, ca, cb);
      t.scrollTop = st;
    }, true);
  })();
  // groky r142: F9 sorts the lines a multi-line selection touches in the message box, A to Z; pressing it again on lines that are
  // already A to Z sorts them Z to A. Natural, case-insensitive order (item 2 before item 10), compared on the text after any indent,
  // > quote prefix, bullet, number and [ ] checkbox. When every line is a numbered item the numbers are rewritten in order from the
  // first one. Blank lines inside the selection stay at the end. Only in #input / #input2, editable, not composing, @ picker closed,
  // and only with a selection over two or more lines. One insertText edit so Ctrl+Z undoes it. No CSS, no motion, no glow.
  (function sortLines() {
    const PRE = /^((?:[ \t]*>[ \t]?)*[ \t]*)((?:[-*+\u2022]|(\d{1,6})([.)]))[ \t]+)?(\[[ xX]\][ \t]+)?/;
    const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    document.addEventListener('keydown', e => {
      if (e.key !== 'F9' || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || e.isComposing) return;
      const t = e.target;
      if (!t || (t.id !== 'input' && t.id !== 'input2') || t.disabled || t.readOnly) return;
      if (document.querySelector('#at-pop:not(:empty)')) return;
      const v = t.value, a = t.selectionStart, b = t.selectionEnd, st = t.scrollTop;
      if (a == null || b == null || b <= a) return;
      const ls = v.lastIndexOf('\n', a - 1) + 1;
      const endAt = v[b - 1] === '\n' ? b - 1 : b;
      const le0 = v.indexOf('\n', Math.max(endAt, ls)), le = le0 < 0 ? v.length : le0;
      const lines = v.slice(ls, le).split('\n');
      if (lines.length < 2) return;
      e.preventDefault(); e.stopImmediatePropagation();
      const full = lines.filter(l => l.trim()), blanks = lines.filter(l => !l.trim());
      if (full.length < 2) return;
      const info = full.map(l => { const m = PRE.exec(l) || ['', '', '']; return { l, key: l.slice(m[0].length).trim(), num: m[3], sep: m[4], head: m[1] }; });
      const cmp = (x, y) => coll.compare(x.key, y.key) || coll.compare(x.l, y.l);
      let asc = true;
      for (let i = 1; i < info.length; i++) if (cmp(info[i - 1], info[i]) > 0) { asc = false; break; }
      const sorted = info.slice().sort(asc ? (x, y) => cmp(y, x) : cmp);
      if (info.every(x => x.num)) {
        let n = parseInt(info[0].num, 10);
        sorted.forEach(x => { const m = /^((?:[ \t]*>[ \t]?)*[ \t]*)\d{1,6}([.)])/.exec(x.l); if (m) x.l = m[1] + (n++) + m[2] + x.l.slice(m[0].length); });
      }
      const out = sorted.map(x => x.l).concat(blanks).join('\n');
      if (out === lines.join('\n')) return;
      t.focus(); try { t.setSelectionRange(ls, le); } catch (_) {}
      let ok = false; try { ok = document.execCommand('insertText', false, out); } catch (_) {}
      if (!ok) { t.setRangeText(out, ls, le, 'end'); t.dispatchEvent(new Event('input', { bubbles: true })); }
      try { t.setSelectionRange(ls, ls + out.length); } catch (_) {}
      t.scrollTop = st;
    }, true);
  })();
  // groky r141: Alt+X ticks or unticks checklist items in the message box, the companion to the r136 Ctrl+Shift+9 checklist toggle.
  // Acts on the caret's line, or every line the selection touches, that is a '- [ ]' / '1. [x]' task item (> quote prefixes and indent
  // kept). If any of those items is still open they all get ticked, otherwise they all get unticked. Lines that are not task items are left
  // alone, and when none of the lines is a task item the key does nothing. Only in #input / #input2, editable, not composing, not while the
  // @ picker is open. One insertText edit so Ctrl+Z undoes it; caret or selection kept on the same text. No CSS, no motion, no glow.
  (function taskTick() {
    const RE = /^((?:[ \t]*>[ \t]?)*[ \t]*(?:[-*+\u2022]|\d{1,4}[.)])[ \t]+\[)([ xX])(\].*)$/;
    document.addEventListener('keydown', e => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.isComposing || e.code !== 'KeyX') return;
      const t = e.target;
      if (!t || (t.id !== 'input' && t.id !== 'input2') || t.disabled || t.readOnly) return;
      if (document.querySelector('#at-pop:not(:empty)')) return;
      const v = t.value, a = t.selectionStart, b = t.selectionEnd, st = t.scrollTop;
      if (a == null || b == null) return;
      const ls = v.lastIndexOf('\n', a - 1) + 1;
      const endAt = b > a && v[b - 1] === '\n' ? b - 1 : b;
      const le0 = v.indexOf('\n', Math.max(endAt, ls)), le = le0 < 0 ? v.length : le0;
      const lines = v.slice(ls, le).split('\n');
      const parsed = lines.map(l => RE.exec(l));
      const tasks = parsed.filter(Boolean);
      e.preventDefault();
      if (!tasks.length) return;
      e.stopImmediatePropagation();
      const tick = tasks.some(m => m[2] === ' ');
      const out = lines.map((l, i) => parsed[i] ? parsed[i][1] + (tick ? 'x' : ' ') + parsed[i][3] : l).join('\n');
      if (out === lines.join('\n')) return;
      t.focus(); try { t.setSelectionRange(ls, le); } catch (_) {}
      let ok = false; try { ok = document.execCommand('insertText', false, out); } catch (_) {}
      if (!ok) { t.setRangeText(out, ls, le, 'end'); t.dispatchEvent(new Event('input', { bubbles: true })); }
      try { t.setSelectionRange(a, b); } catch (_) {}
      t.scrollTop = st;
    }, true);
  })();
  // groky r136: Ctrl+Shift+9 checklist toggle in the message box, next to the r130 bullet (8) and number (7) keys. Makes the caret's
  // line, or every line the selection touches, a '- [ ] ' task item (Squall already renders these as tick boxes). Bullets keep their
  // marker, numbered lines keep their number, > quote prefixes and indentation are kept, blank lines are skipped. If every non-blank line
  // is already a task item, the checkboxes come off and the bullets or numbers stay. Only in #input / #input2, editable, not composing,
  // not while the @ picker is open. One insertText edit so Ctrl+Z undoes it. No CSS, no motion, no glow.
  (function checklistToggle() {
    const RE = /^((?:[ \t]*>[ \t]?)*)([ \t]*)(?:([-*+\u2022]|\d{1,4}[.)])([ \t]+))?(\[[ xX]\][ \t]+)?(.*)$/;
    const put = (t, a, b, text) => {
      t.focus(); try { t.setSelectionRange(a, b); } catch (_) {}
      let ok = false; try { ok = document.execCommand('insertText', false, text); } catch (_) {}
      if (!ok) { t.setRangeText(text, a, b, 'select'); t.dispatchEvent(new Event('input', { bubbles: true })); }
    };
    document.addEventListener('keydown', e => {
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey || e.isComposing) return;
      if (e.code !== 'Digit9' && e.code !== 'Numpad9') return;
      const t = e.target;
      if (!t || (t.id !== 'input' && t.id !== 'input2') || t.disabled || t.readOnly) return;
      if (document.querySelector('#at-pop:not(:empty)')) return;
      e.preventDefault(); e.stopImmediatePropagation();
      const v = t.value, a = t.selectionStart, b = t.selectionEnd, st = t.scrollTop;
      const ls = v.lastIndexOf('\n', a - 1) + 1;
      let endAt = b > a && v[b - 1] === '\n' ? b - 1 : b;
      const le0 = v.indexOf('\n', Math.max(endAt, ls)), le = le0 < 0 ? v.length : le0;
      const lines = v.slice(ls, le).split('\n');
      const parsed = lines.map(l => RE.exec(l));
      const real = parsed.filter((m, i) => m && lines[i].trim());
      const allTask = real.length > 0 && real.every(m => m[3] && m[5]);
      const out = lines.map((l, i) => {
        const m = parsed[i];
        if (!m || !l.trim()) return l;
        if (allTask) return m[1] + m[2] + m[3] + m[4] + m[6];
        if (m[3] && m[5]) return l;
        if (m[3]) return m[1] + m[2] + m[3] + m[4] + '[ ] ' + m[6];
        if (!m[6].trim()) return l;
        return m[1] + m[2] + '- [ ] ' + m[6];
      }).join('\n');
      if (out === lines.join('\n')) return;
      const single = a === b;
      put(t, ls, le, out);
      if (single) { const pos = ls + (out.split('\n')[0].length); try { t.setSelectionRange(pos, pos); } catch (_) {} }
      else { try { t.setSelectionRange(ls, ls + out.length); } catch (_) {} }
      t.scrollTop = st;
    }, true);
  })();
  // groky r135: Shift+Enter continues a > quote in the message box, like Slack or Obsidian. With the caret at the end of a quoted line,
  // Shift+Enter starts the next line with the same > prefix (nested levels kept); inside a quoted list it also adds the next bullet,
  // number or checkbox. On an empty quote line it takes one quote level off (ending the quote), and on an empty quoted list item it clears
  // the marker. Plain lists are still handled by the r122 helper, which runs first. Only in #input / #input2, editable, not composing,
  // not while the @ picker is open. One insertText edit so Ctrl+Z undoes it and autosize and drafts see it. No CSS, no motion, no glow.
  (function quoteNext() {
    const QRE = /^((?:[ \t]*>[ \t]?)+)(.*)$/;
    const LIST = /^(\s*)(?:([-*+\u2022])|(\d{1,4})([.)]))(\s+)(\[[ xX]\]\s+)?(.*)$/;
    const put = (t, a, b, text) => {
      t.focus(); try { t.setSelectionRange(a, b); } catch (_) {}
      let ok = false; try { ok = document.execCommand('insertText', false, text); } catch (_) {}
      if (!ok) { t.setRangeText(text, a, b, 'end'); t.dispatchEvent(new Event('input', { bubbles: true })); }
    };
    document.addEventListener('keydown', e => {
      if (e.key !== 'Enter' || !e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return;
      const t = e.target;
      if (!t || (t.id !== 'input' && t.id !== 'input2') || t.disabled || t.readOnly) return;
      if (document.querySelector('#at-pop:not(:empty)')) return;
      const v = t.value, a = t.selectionStart;
      if (a !== t.selectionEnd) return;
      const ls = v.lastIndexOf('\n', a - 1) + 1, le0 = v.indexOf('\n', a), le = le0 < 0 ? v.length : le0;
      if (v.slice(a, le).trim()) return;   // caret in the middle of the line: plain new line
      const m = QRE.exec(v.slice(ls, le));
      if (!m) return;
      const pre = m[1].replace(/[ \t]+$/, '') + ' ', rest = m[2];
      e.preventDefault(); e.stopImmediatePropagation();
      if (!rest.trim()) {   // empty quote line: drop one level
        const lvl = pre.replace(/[ \t]*>[ \t]*$/, '');
        put(t, ls, le, lvl.includes('>') ? lvl.replace(/[ \t]+$/, '') + ' ' : '');
        return;
      }
      const L = LIST.exec(rest);
      if (L) {
        if (!L[7].trim()) { put(t, ls, le, pre + L[1]); return; }
        const mark = L[2] ? L[2] : (parseInt(L[3], 10) + 1) + L[4];
        put(t, a, a, '\n' + pre + L[1] + mark + ' ' + (L[6] ? '[ ] ' : ''));
        return;
      }
      put(t, a, a, '\n' + pre);
    }, true);
  })();
  // groky r134: smart Home in the message box. On a line that starts with indentation, a list marker (- * + or 1. 1)),
  // a checkbox or a > quote, Home first puts the caret just after that prefix (where the words start); pressing Home again there
  // goes to the very start of the line as usual. Shift+Home selects the same way. Lines without a prefix keep the native Home.
  // Only in #input / #input2, no Ctrl/Alt/Meta, not composing, not while the @ picker is open. Caret move only, no edit, no CSS, no motion.
  (function smartHome() {
    const PRE = /^(?:[ \t]*>[ \t]?)*[ \t]*(?:(?:[-*+]|\d{1,4}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)?/;
    document.addEventListener('keydown', e => {
      if (e.key !== 'Home' || e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return;
      const t = e.target;
      if (!t || (t.id !== 'input' && t.id !== 'input2') || t.disabled) return;
      if (document.querySelector('#at-pop:not(:empty)')) return;
      const v = t.value, a = t.selectionStart, b = t.selectionEnd;
      const back = t.selectionDirection === 'backward';
      const caret = e.shiftKey ? (back ? a : b) : (a === b ? a : (back ? a : b));
      const ls = v.lastIndexOf('\n', caret - 1) + 1;
      let le = v.indexOf('\n', ls); if (le < 0) le = v.length;
      const m = PRE.exec(v.slice(ls, le));
      const plen = m ? m[0].length : 0;
      if (!plen) return;
      const target = ls + plen;
      if (caret <= target) return;   // already at or before where the words start: native Home goes to the line start
      // a wrapped line: only take over when the caret is on the first visual row, so Home on a later row still goes to that row's start
      if (t.scrollWidth <= t.clientWidth && caret - ls > 0) {
        const cs = getComputedStyle(t), lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.3;
        const probe = document.createElement('div');
        probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre-wrap;word-wrap:break-word;overflow-wrap:break-word;top:0;left:-9999px;box-sizing:' + cs.boxSizing + ';width:' + t.clientWidth + 'px;padding:' + cs.padding + ';border:0;font:' + cs.font + ';letter-spacing:' + cs.letterSpacing + ';tab-size:' + (cs.tabSize || 8);
        probe.textContent = v.slice(ls, caret) || ' ';
        document.body.appendChild(probe);
        const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
        const rows = Math.round((probe.scrollHeight - pad) / lh);
        probe.remove();
        if (rows > 1) return;
      }
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.shiftKey) {
        const anchorPos = a === b ? a : (back ? b : a);
        if (target <= anchorPos) t.setSelectionRange(target, anchorPos, 'backward');
        else t.setSelectionRange(anchorPos, target, 'forward');
      } else t.setSelectionRange(target, target);
    }, true);
  })();
  // groky r133: change case in the message box. Ctrl/Meta+Shift+U cycles the selected text (or the word at the caret when
  // nothing is selected) through UPPER, Title and lower case, keeping the same text selected so pressing again moves on.
  // One insertText edit so Ctrl+Z works. Only in #input / #input2, editable, not composing, not while the @ picker is open.
  // Ctrl+U alone (Update log) is untouched. No CSS, no motion.
  (function caseCycle() {
    const put = (t, a, b, text) => {
      const st = t.scrollTop;
      t.focus(); try { t.setSelectionRange(a, b); } catch (_) {}
      let ok = false; try { ok = document.execCommand('insertText', false, text); } catch (_) {}
      if (!ok || t.value.slice(a, a + text.length) !== text) { t.setRangeText(text, a, b, 'end'); t.dispatchEvent(new Event('input', { bubbles: true })); }
      try { t.setSelectionRange(a, a + text.length); } catch (_) {}
      t.scrollTop = st;
    };
    const title = x => x.toLowerCase().replace(/(^|[^\p{L}\p{N}'’])(\p{L})/gu, (m, pre, c) => pre + c.toUpperCase());
    const W = /[\p{L}\p{N}_'’-]/u;
    document.addEventListener('keydown', e => {
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey || e.isComposing || e.code !== 'KeyU') return;
      const t = e.target;
      if (!t || (t.id !== 'input' && t.id !== 'input2') || t.disabled || t.readOnly) return;
      if (document.querySelector('#at-pop:not(:empty)')) return;
      e.preventDefault(); e.stopImmediatePropagation();
      const v = t.value;
      let a = t.selectionStart, b = t.selectionEnd;
      if (b === a) { while (a > 0 && W.test(v[a - 1])) a--; while (b < v.length && W.test(v[b])) b++; }
      if (b <= a || b - a > 20000) return;
      const sel = v.slice(a, b);
      if (!/\p{L}/u.test(sel)) return;
      const up = sel.toUpperCase(), lo = sel.toLowerCase(), ti = title(sel);
      let next;
      if (sel === up && up !== lo) next = ti !== up ? ti : lo;
      else if (sel === ti && ti !== lo) next = lo;
      else next = up;
      if (next === sel) next = lo !== sel ? lo : up;
      if (next === sel) return;
      put(t, a, b, next);
    }, true);
  })();
  // groky r132: strikethrough and highlight in the message box. Ctrl/Meta+Shift+X wraps the selected words in ~~ and
  // Ctrl/Meta+Shift+H in == (both already render as <del> and <mark>); pressing again unwraps them, and with nothing selected
  // an empty pair goes in with the caret inside. Spaces at the edges of a selection stay outside the markers. One insertText
  // edit so Ctrl+Z works. Only in #input / #input2, editable, not composing, not while the @ picker is open. No CSS, no motion.
  (function strikeMark() {
    const MARK = { KeyX: '~~', KeyH: '==' };
    const put = (t, a, b, text, selA, selB) => {
      const st = t.scrollTop;
      t.focus(); try { t.setSelectionRange(a, b); } catch (_) {}
      let ok = false; try { ok = document.execCommand('insertText', false, text); } catch (_) {}
      if (!ok || t.value.slice(a, a + text.length) !== text) { t.setRangeText(text, a, b, 'end'); t.dispatchEvent(new Event('input', { bubbles: true })); }
      try { t.setSelectionRange(selA, selB == null ? selA : selB); } catch (_) {}
      t.scrollTop = st;
    };
    document.addEventListener('keydown', e => {
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey || e.isComposing || !MARK[e.code]) return;
      const t = e.target;
      if (!t || (t.id !== 'input' && t.id !== 'input2') || t.disabled || t.readOnly) return;
      if (document.querySelector('#at-pop:not(:empty)')) return;
      e.preventDefault(); e.stopImmediatePropagation();
      const m = MARK[e.code], L = m.length, v = t.value;
      let a = t.selectionStart, b = t.selectionEnd;
      if (b > a) { while (b > a && /\s/.test(v[b - 1])) b--; while (a < b && /\s/.test(v[a])) a++; }
      const sel = v.slice(a, b);
      if (b > a && sel.length >= 2 * L && sel.startsWith(m) && sel.endsWith(m)) { const inner = sel.slice(L, sel.length - L); put(t, a, b, inner, a, a + inner.length); return; }
      if (b > a && v.slice(a - L, a) === m && v.slice(b, b + L) === m) { put(t, a - L, b + L, sel, a - L, b - L); return; }
      if (b === a) { put(t, a, a, m + m, a + L); return; }
      put(t, a, b, m + sel + m, a + L, b + L);
    }, true);
  })();
  // groky r131: quote toggle in the message box. Ctrl/Meta+Shift+. (e.code Period) puts "> " in front of the caret's
  // line, or every line the selection touches; if every non-blank line is already quoted, one level of "> " comes off
  // instead. Blank lines inside a quoted block get a bare ">" so the quote stays one block. One insertText edit so
  // Ctrl+Z works. Only in #input / #input2, editable, not composing, not while the @ picker is open. No CSS, no motion.
  (function quoteToggle() {
    const Q = /^(\s{0,3})>\s?/;
    document.addEventListener('keydown', e => {
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey || e.isComposing) return;
      if (e.code !== 'Period' && e.code !== 'NumpadDecimal') return;
      const t = e.target;
      if (!t || (t.id !== 'input' && t.id !== 'input2') || t.disabled || t.readOnly) return;
      if (document.querySelector('#at-pop:not(:empty)')) return;
      e.preventDefault(); e.stopImmediatePropagation();
      const v = t.value, a = t.selectionStart, b = t.selectionEnd;
      const from = v.lastIndexOf('\n', a - 1) + 1;
      const endPos = b > a && v[b - 1] === '\n' && b - 1 >= from ? b - 1 : b;
      let to = v.indexOf('\n', endPos); if (to < 0) to = v.length;
      const lines = v.slice(from, to).split('\n');
      const filled = lines.filter(l => l.trim());
      const off = filled.length > 0 && filled.every(l => Q.test(l));
      let first = 0, last = lines.length - 1;
      while (first < last && !lines[first].trim()) first++;
      while (last > first && !lines[last].trim()) last--;
      const out = lines.map((l, i) => {
        if (off) return l.replace(Q, '$1');
        if (!l.trim()) return i > first && i < last ? '>' : l;
        return '> ' + l;
      });
      const next = out.join('\n'), prev = v.slice(from, to);
      if (next === prev) return;
      const st = t.scrollTop;
      t.focus();
      t.setSelectionRange(from, to);
      let ok = false;
      try { ok = document.execCommand('insertText', false, next); } catch (_) {}
      if (!ok || t.value.slice(from, from + next.length) !== next) {
        t.setRangeText(next, from, to, 'end');
        t.dispatchEvent(new Event('input', { bubbles: true }));
      }
      try {
        if (b > a || lines.length > 1) t.setSelectionRange(from, from + next.length);
        else { const c = Math.max(from, Math.min(from + next.length, a + (next.length - prev.length))); t.setSelectionRange(c, c); }
      } catch (_) {}
      t.scrollTop = st;
    }, true);
  })();
  // groky r130: list toggles in the message box. Ctrl/Meta+Shift+8 makes the caret's line, or every line the selection
  // touches, a "- " bullet list; Ctrl/Meta+Shift+7 makes it a "1. 2. 3." numbered list. If every non-blank line already
  // has that kind of marker, the markers come off instead; a list of the other kind is converted. Indent is kept, blank
  // lines are left alone, and numbering restarts per indent level. One insertText edit so Ctrl+Z works. Only in
  // #input / #input2, editable, not composing, not while the @ picker is open. No CSS, no motion, no glow.
  (function listToggles() {
    const BUL = /^(\s*)([-*+])\s+(\[[ xX]\]\s+)?/, NUM = /^(\s*)(\d{1,4})[.)]\s+/;
    document.addEventListener('keydown', e => {
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey || e.isComposing) return;
      const kind = e.code === 'Digit8' || e.code === 'Numpad8' ? 'b' : e.code === 'Digit7' || e.code === 'Numpad7' ? 'n' : '';
      if (!kind) return;
      const t = e.target;
      if (!t || (t.id !== 'input' && t.id !== 'input2') || t.disabled || t.readOnly) return;
      if (document.querySelector('#at-pop:not(:empty)')) return;
      e.preventDefault(); e.stopImmediatePropagation();
      const v = t.value, a = t.selectionStart, b = t.selectionEnd;
      const from = v.lastIndexOf('\n', a - 1) + 1;
      let endPos = b > a && v[b - 1] === '\n' && b - 1 >= from ? b - 1 : b;
      let to = v.indexOf('\n', endPos); if (to < 0) to = v.length;
      const lines = v.slice(from, to).split('\n');
      const filled = lines.filter(l => l.trim());
      const mine = kind === 'b' ? BUL : NUM;
      const off = filled.length > 0 && filled.every(l => mine.test(l));
      const strip = l => l.replace(BUL, '$1').replace(NUM, '$1');
      const counters = {};
      const out = lines.map(l => {
        if (!l.trim()) return l;
        const ind = (l.match(/^\s*/) || [''])[0], body = strip(l).slice(ind.length);
        if (off) return ind + body;
        if (kind === 'b') {
          const box = (l.match(BUL) || [])[3] || '';
          return ind + '- ' + box + body;
        }
        Object.keys(counters).forEach(k => { if (+k > ind.length) delete counters[k]; });
        counters[ind.length] = (counters[ind.length] || 0) + 1;
        return ind + counters[ind.length] + '. ' + body;
      });
      const next = out.join('\n'), prev = v.slice(from, to);
      if (next === prev) return;
      const st = t.scrollTop;
      t.focus();
      t.setSelectionRange(from, to);
      let ok = false;
      try { ok = document.execCommand('insertText', false, next); } catch (_) {}
      if (!ok || t.value.slice(from, from + next.length) !== next) {
        t.setRangeText(next, from, to, 'end');
        t.dispatchEvent(new Event('input', { bubbles: true }));
      }
      try {
        if (b > a || lines.length > 1) t.setSelectionRange(from, from + next.length);
        else { const c = Math.max(from, Math.min(from + next.length, a + (next.length - prev.length))); t.setSelectionRange(c, c); }
      } catch (_) {}
      t.scrollTop = st;
    }, true);
  })();
  // groky r129: select line in the message box. Ctrl/Meta+L selects the whole line under the caret including its line
  // break; pressing it again while whole lines are selected extends the selection by the next line. Only in #input / #input2,
  // editable, not composing, not while the @ picker is open. Default always prevented there so WebView2 never jumps to an
  // address bar. Selection only, no edit. No CSS, no motion, no glow.
  (function selectLines() {
    document.addEventListener('keydown', e => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.isComposing) return;
      if (e.code !== 'KeyL') return;
      const t = e.target;
      if (!t || (t.id !== 'input' && t.id !== 'input2') || t.disabled) return;
      if (document.querySelector('#at-pop:not(:empty)')) return;
      e.preventDefault(); e.stopImmediatePropagation();
      const v = t.value; if (!v) return;
      const a = t.selectionStart, b = t.selectionEnd;
      const ls = v.lastIndexOf('\n', a - 1) + 1;
      const whole = b > a && a === ls && (b === v.length || v[b - 1] === '\n');
      let from = ls, to;
      if (whole) {
        if (b >= v.length) return;
        to = v.indexOf('\n', b); to = to < 0 ? v.length : to + 1;
      } else {
        to = v.indexOf('\n', Math.max(a, b > a ? b - 1 : b)); to = to < 0 ? v.length : to + 1;
      }
      try { t.setSelectionRange(from, to, 'forward'); } catch (_) {}
    }, true);
  })();
  // groky r128: delete line in the message box. Ctrl/Meta+Shift+K removes the line under the caret, or every line the
  // selection touches (a selection ending at the start of a line leaves that line alone), together with its line break, and
  // puts the caret on the line that moves up into its place at the same column. Only in #input / #input2, editable, not
  // composing, not while the @ picker is open. One edit so Ctrl+Z brings the lines back. No CSS, no motion, no glow.
  (function deleteLines() {
    document.addEventListener('keydown', e => {
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey || e.isComposing) return;
      if (e.code !== 'KeyK') return;
      const t = e.target;
      if (!t || (t.id !== 'input' && t.id !== 'input2') || t.disabled || t.readOnly) return;
      if (document.querySelector('#at-pop:not(:empty)')) return;
      e.preventDefault(); e.stopImmediatePropagation();
      const v = t.value; if (!v) return;
      const a = t.selectionStart; let b = t.selectionEnd; const st = t.scrollTop;
      if (b > a && v[b - 1] === '\n') b--;
      const ls = v.lastIndexOf('\n', a - 1) + 1;
      let le = v.indexOf('\n', Math.max(a, b)); if (le < 0) le = v.length;
      const col = a - ls;
      let from, to;
      if (le < v.length) { from = ls; to = le + 1; }
      else if (ls > 0) { from = ls - 1; to = le; }
      else { from = 0; to = le; }
      t.focus();
      try { t.setSelectionRange(from, to); } catch (_) {}
      let ok = false; try { ok = document.execCommand('delete', false); } catch (_) {}
      if (!ok || t.value.length !== v.length - (to - from)) {
        t.value = v; t.setRangeText('', from, to, 'start'); t.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const nv = t.value;
      const lineStart = le < v.length ? ls : (ls > 0 ? nv.lastIndexOf('\n', from - 1) + 1 : 0);
      let lineEnd = nv.indexOf('\n', lineStart); if (lineEnd < 0) lineEnd = nv.length;
      const c = Math.min(lineStart + col, lineEnd);
      try { t.setSelectionRange(c, c); } catch (_) {}
      t.scrollTop = st;
    }, true);
  })();
  // groky r127: duplicate line or selection in the message box. Ctrl/Meta+Shift+D with no selection copies the line under the
  // caret onto a new line below it and moves the caret down with it; with a selection it inserts a copy right after the
  // selection and selects the copy, so pressing again keeps repeating it. Only in #input / #input2, editable, not composing,
  // not while the @ picker is open. One insertText edit so Ctrl+Z undoes it and autosize and drafts see it. No CSS, no motion, no glow.
  (function dupLines() {
    document.addEventListener('keydown', e => {
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey || e.isComposing) return;
      if (e.code !== 'KeyD') return;
      const t = e.target;
      if (!t || (t.id !== 'input' && t.id !== 'input2') || t.disabled || t.readOnly) return;
      if (document.querySelector('#at-pop:not(:empty)')) return;
      e.preventDefault(); e.stopImmediatePropagation();
      const v = t.value, a = t.selectionStart, b = t.selectionEnd, st = t.scrollTop;
      let at, text, selA, selB;
      if (b > a) {
        if (b - a > 20000) return;
        at = b; text = v.slice(a, b); selA = b; selB = b + text.length;
      } else {
        const ls = v.lastIndexOf('\n', a - 1) + 1;
        let le = v.indexOf('\n', a); if (le < 0) le = v.length;
        const line = v.slice(ls, le);
        at = le; text = '\n' + line; selA = selB = a + line.length + 1;
      }
      t.focus();
      try { t.setSelectionRange(at, at); } catch (_) {}
      let ok = false; try { ok = document.execCommand('insertText', false, text); } catch (_) {}
      if (!ok) { t.setRangeText(text, at, at, 'end'); t.dispatchEvent(new Event('input', { bubbles: true })); }
      try { t.setSelectionRange(selA, selB); } catch (_) {}
      t.scrollTop = st;
    }, true);
  })();
  // groky r126: wrap a selection in brackets or quotes, like VS Code. With text selected in the message box, typing ( [ { " or a
  // backtick puts the pair around the selection instead of replacing it, and keeps the same text selected so it can be wrapped again.
  // With no selection typing is untouched. Only in #input / #input2, editable, not composing, not while the @ picker is open.
  // One insertText edit so Ctrl+Z undoes it and autosize and drafts see it. No CSS, no motion, no glow.
  (function wrapPairs() {
    const P = { '(': ')', '[': ']', '{': '}', '"': '"', '\x60': '\x60' };
    document.addEventListener('keydown', e => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing || e.repeat) return;
      const close = P[e.key]; if (!close) return;
      const t = e.target;
      if (!t || (t.id !== 'input' && t.id !== 'input2') || t.disabled || t.readOnly) return;
      if (document.querySelector('#at-pop:not(:empty)')) return;
      const a = t.selectionStart, b = t.selectionEnd;
      if (b <= a || b - a > 4000) return;
      e.preventDefault(); e.stopImmediatePropagation();
      const text = e.key + t.value.slice(a, b) + close;
      const st = t.scrollTop;
      t.focus();
      let ok = false; try { ok = document.execCommand('insertText', false, text); } catch (_) {}
      if (!ok) { t.setRangeText(text, a, b, 'end'); t.dispatchEvent(new Event('input', { bubbles: true })); }
      try { t.setSelectionRange(a + 1, b + 1); } catch (_) {}
      t.scrollTop = st;
    }, true);
  })();
  // groky r125: move lines in the message box, like VS Code. Ctrl+Shift+Up/Down swaps the line under the caret (or every line the
  // selection touches) with the line above or below, keeping the caret or selection on the same text; holding the keys keeps moving.
  // A one-line box keeps the native Ctrl+Shift+Up/Down selection. Only in #input / #input2, editable, not composing, not while the @
  // picker is open. One insertText edit so Ctrl+Z undoes it and autosize and drafts see it. No CSS, no motion, no glow.
  (function moveLines() {
    document.addEventListener('keydown', e => {
      if ((e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || !(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey || e.isComposing) return;
      const t = e.target;
      if (!t || (t.id !== 'input' && t.id !== 'input2') || t.disabled || t.readOnly) return;
      if (document.querySelector('#at-pop:not(:empty)')) return;
      const v = t.value;
      if (v.indexOf('\n') < 0) return;
      e.preventDefault(); e.stopImmediatePropagation();
      const a = t.selectionStart, b = t.selectionEnd;
      const bb = b > a && v[b - 1] === '\n' ? b - 1 : b;
      const ls = a > 0 ? v.lastIndexOf('\n', a - 1) + 1 : 0, le0 = v.indexOf('\n', bb), le = le0 < 0 ? v.length : le0;
      const block = v.slice(ls, le);
      let from, to, text, shift;
      if (e.key === 'ArrowUp') {
        if (ls === 0) return;
        from = ls >= 2 ? v.lastIndexOf('\n', ls - 2) + 1 : 0; to = le;
        text = block + '\n' + v.slice(from, ls - 1); shift = from - ls;
      } else {
        if (le >= v.length) return;
        const ne0 = v.indexOf('\n', le + 1), ne = ne0 < 0 ? v.length : ne0;
        from = ls; to = ne;
        const next = v.slice(le + 1, ne);
        text = next + '\n' + block; shift = next.length + 1;
      }
      const st = t.scrollTop;
      t.focus(); try { t.setSelectionRange(from, to); } catch (_) {}
      let ok = false; try { ok = document.execCommand('insertText', false, text); } catch (_) {}
      if (!ok) { t.setRangeText(text, from, to, 'end'); t.dispatchEvent(new Event('input', { bubbles: true })); }
      try { t.setSelectionRange(a + shift, b + shift); } catch (_) {}
      t.scrollTop = st;
    }, true);
  })();
  // groky r124: code blocks in the message box, like Slack or Discord. Enter at the end of an opening fence line (three backticks or
  // tildes, optionally a language like js or c++) adds the closing fence and puts the caret on the empty line between, unless a closer
  // already follows. While the caret sits inside an open fenced block, plain Enter inserts a new line keeping the line's indent instead of
  // sending; on the closing fence line, or with Ctrl+Enter, it sends as before. Only in #input / #input2, editable, not composing, not
  // while the @ picker is open. Edits go through insertText so Ctrl+Z undoes them and autosize and drafts see them. No CSS, no motion.
  (function fenceKeys() {
    const FENCE = /^\s*(\x60{3,}|~{3,})(.*)$/;
    const put = (t, a, b, text, caret) => {
      t.focus(); try { t.setSelectionRange(a, b); } catch (_) {}
      let ok = false; try { ok = document.execCommand('insertText', false, text); } catch (_) {}
      if (!ok) { t.setRangeText(text, a, b, 'end'); t.dispatchEvent(new Event('input', { bubbles: true })); }
      if (caret != null) try { t.setSelectionRange(caret, caret); } catch (_) {}
    };
    const closes = (m, open) => m && m[1][0] === open[0] && m[1].length >= open.length && !m[2].trim();
    function openAt(v, ls) {
      const lines = v.slice(0, ls).split('\n'); lines.pop();
      let open = null;
      for (const l of lines) { const m = FENCE.exec(l); if (!m) continue; if (!open) open = m[1]; else if (closes(m, open)) open = null; }
      return open;
    }
    function closerAfter(v, le, open) {
      if (le >= v.length) return false;
      for (const l of v.slice(le + 1).split('\n')) { const m = FENCE.exec(l); if (m) return closes(m, open); }
      return false;
    }
    document.addEventListener('keydown', e => {
      if (e.key !== 'Enter' || e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return;
      const t = e.target;
      if (!t || (t.id !== 'input' && t.id !== 'input2') || t.disabled || t.readOnly) return;
      if (document.querySelector('#at-pop:not(:empty)')) return;
      const v = t.value, a = t.selectionStart, b = t.selectionEnd;
      const ls = v.lastIndexOf('\n', a - 1) + 1, le0 = v.indexOf('\n', a), le = le0 < 0 ? v.length : le0;
      const line = v.slice(ls, le), m = FENCE.exec(line), open = openAt(v, ls);
      if (!open) {
        if (!m || a !== b || v.slice(a, le).trim()) return;
        if (!/^[\w+#.-]*$/.test(m[2].trim())) return; // a one-line inline fence is left alone
        const ind = /^[ \t]*/.exec(line)[0];
        e.preventDefault(); e.stopImmediatePropagation();
        if (closerAfter(v, le, m[1])) put(t, a, b, '\n' + ind, null);
        else put(t, a, b, '\n' + ind + '\n' + ind + m[1], a + 1 + ind.length);
        return;
      }
      if (closes(m, open) || e.shiftKey) return; // closing line sends as usual; Shift+Enter is already a new line
      e.preventDefault(); e.stopImmediatePropagation();
      put(t, a, b, '\n' + /^[ \t]*/.exec(v.slice(ls, a))[0], null);
    }, true);
  })();
  // groky r117: F2 renames, like in Explorer: the teammate whose sidebar tile has the keyboard focus, otherwise the teammate whose DM is open
  // in the focused pane. Group, team, session and vault views are left alone. Uses the existing openRenameBot card. No CSS, no motion, no glow.
  document.addEventListener('keydown', e => {
    if (e.key !== 'F2' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.isComposing || e.repeat) return;
    if (chatHistBlocked(e.target)) return;
    const tile = e.target && e.target.closest && e.target.closest('#agents .member[data-chat]');
    const id = tile ? tile.dataset.chat : (S.split && S.focusRight ? S.split : S.active);
    const name = id && id.indexOf('dm:') === 0 ? id.slice(3) : '';
    if (!name || !S.byName[name]) return;
    e.preventDefault(); e.stopPropagation();
    if (typeof closeBotMenu === 'function') closeBotMenu();
    openRenameBot(name);
  });
  // groky r110: Ctrl+, opens Settings from anywhere, like most desktop apps; pressing it again while Settings is open closes it.
  // Skipped while another card, Ctrl+K, the image viewer or the @ list is open. Uses the existing openSettings/closeModal. No CSS, no motion, no glow.
  document.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.isComposing || e.repeat) return;
    if (e.code !== 'Comma' && e.key !== ',') return;
    if (document.querySelector('.modal-back .set-modal')) { e.preventDefault(); e.stopPropagation(); closeModal(); const b = document.getElementById(S.split && S.focusRight ? 'input2' : 'input'); if (b && !b.disabled) b.focus(); return; }
    if (chatHistBlocked(e.target)) return;
    e.preventDefault(); e.stopPropagation();
    openSettings();
  });
  // groky r111: Ctrl+N opens the New teammate card from anywhere; pressing it again while that card is open closes it.
  // Skipped while another card, Ctrl+K, the image viewer or the @ list is open. Uses the existing openAddTeammate/closeModal. No CSS, no motion, no glow.
  document.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.isComposing || e.repeat) return;
    if (e.code !== 'KeyN' && e.key !== 'n' && e.key !== 'N') return;
    if (document.querySelector('.modal-back .add-modal.studio')) { e.preventDefault(); e.stopPropagation(); closeModal(); const b = document.getElementById(S.split && S.focusRight ? 'input2' : 'input'); if (b && !b.disabled) b.focus(); return; }
    if (chatHistBlocked(e.target)) return;
    e.preventDefault(); e.stopPropagation();
    openAddTeammate();
  });
  // groky r112: Ctrl+O opens the EVO vault card with the search box focused, like Obsidian's quick switcher; pressing it again while the vault card is open closes it.
  // Skipped while another card, Ctrl+K, the image viewer or the @ list is open. Uses the existing openVault/closeModal. No CSS, no motion, no glow.
  document.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.isComposing || e.repeat) return;
    if (e.code !== 'KeyO' && e.key !== 'o' && e.key !== 'O') return;
    if (document.querySelector('.modal-back .vault-modal')) { e.preventDefault(); e.stopPropagation(); closeModal(); const b = document.getElementById(S.split && S.focusRight ? 'input2' : 'input'); if (b && !b.disabled) b.focus(); return; }
    e.preventDefault();
    if (chatHistBlocked(e.target)) return;
    e.stopPropagation();
    openVault();
    const q = document.getElementById('vault-q'); if (q) q.focus();
  });
  // groky r113: Ctrl+U opens the Update log card (what changed in each build); pressing it again while it is open closes it and refocuses the box.
  // The default is always prevented so WebView2's view-source never opens. Skipped while another card, Ctrl+K, the image viewer or the @ list is open. No CSS, no motion, no glow.
  document.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.isComposing || e.repeat) return;
    if (e.code !== 'KeyU' && e.key !== 'u' && e.key !== 'U') return;
    e.preventDefault();
    if (document.querySelector('.modal-back .uplog-modal')) { e.stopPropagation(); closeModal(); const b = document.getElementById(S.split && S.focusRight ? 'input2' : 'input'); if (b && !b.disabled) b.focus(); return; }
    if (chatHistBlocked(e.target)) return;
    e.stopPropagation();
    openUpdateLog();
  });
  // groky r114: Ctrl+J opens the Routines card (scheduled jobs for bots) with the Name field focused only when there are no routines yet; pressing it again while it is open closes it and refocuses the box.
  // The default is always prevented so WebView2's downloads page never opens. Skipped while another card, Ctrl+K, the image viewer or the @ list is open. No CSS, no motion, no glow.
  document.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.isComposing || e.repeat) return;
    if (e.code !== 'KeyJ' && e.key !== 'j' && e.key !== 'J') return;
    e.preventDefault();
    if (document.querySelector('.modal-back .routines-modal')) { e.stopPropagation(); closeModal(); const b = document.getElementById(S.split && S.focusRight ? 'input2' : 'input'); if (b && !b.disabled) b.focus(); return; }
    if (chatHistBlocked(e.target)) return;
    e.stopPropagation();
    openRoutines();
    const rs = (S.team && S.team.routines) || [];
    if (!rs.length) { const n = document.getElementById('rt-name'); if (n) n.focus(); }
  });
  // groky r115: chat links are <a data-url> with no href, so hovering one never showed where it goes. After a short hover a quiet
  // one-line peek shows the site and path at the bottom-left of that chat pane, like a browser status bar. One element, fade only, no glow.
  (function linkPeek() {
    let el = null, timer = 0, cur = null;
    const fmt = u => { try { const x = new URL(u); return { host: x.hostname.replace(/^www\./, ''), rest: (x.pathname === '/' ? '' : x.pathname) + x.search + x.hash }; } catch (_) { return { host: u, rest: '' }; } };
    const hide = () => { clearTimeout(timer); timer = 0; cur = null; if (el) el.classList.remove('show'); };
    const show = a => {
      if (!el) { el = document.createElement('div'); el.id = 'link-peek'; el.setAttribute('aria-hidden', 'true'); el.innerHTML = '<b></b><span></span>'; document.body.appendChild(el); }
      const f = fmt(a.dataset.url || '');
      el.firstChild.textContent = f.host; el.lastChild.textContent = f.rest;
      const pane = a.closest('#chat, #chat2, #live-body, .note-view, .modal') || document.body;
      const r = pane.getBoundingClientRect();
      el.style.left = Math.max(6, Math.round(r.left + 10)) + 'px';
      el.style.bottom = Math.max(6, Math.round(window.innerHeight - Math.min(r.bottom, window.innerHeight) + 10)) + 'px';
      el.style.maxWidth = Math.max(200, Math.round(Math.min(r.width - 20, window.innerWidth * 0.6))) + 'px';
      el.classList.add('show');
    };
    document.addEventListener('mouseover', e => {
      const a = e.target && e.target.closest ? e.target.closest('a[data-url]') : null;
      if (a === cur) return;
      hide(); if (!a || !a.dataset.url) return;
      cur = a; timer = setTimeout(() => { if (cur === a && a.isConnected) show(a); }, 280);
    }, true);
    document.addEventListener('mouseout', e => { if (cur && (!e.relatedTarget || !cur.contains(e.relatedTarget))) hide(); }, true);
    for (const ev of ['mousedown', 'keydown', 'wheel', 'blur']) (ev === 'blur' ? window : document).addEventListener(ev, hide, { capture: true, passive: true });
    document.addEventListener('scroll', hide, { capture: true, passive: true });
  })();
  // groky r116: Ctrl+= and Ctrl+- make just the message text in the chats bigger or smaller (90% to 135%), Ctrl+0 puts it back.
  // Remembered in localStorage. The open chats keep the message Storm was reading in place, or stay at the end if he was there.
  // The message box placeholder says the new size for a moment. Skipped while a card, Ctrl+K, the image viewer or the @ list is open. No glow, no motion.
  (function msgTextSize() {
    const STEPS = [0.9, 1, 1.1, 1.2, 1.35], KEY = 'squall.msgZoom';
    let z = 1; try { const v = parseFloat(localStorage.getItem(KEY)); if (STEPS.includes(v)) z = v; } catch (e) {}
    const apply = () => { if (z === 1) document.documentElement.style.removeProperty('--msg-zoom'); else document.documentElement.style.setProperty('--msg-zoom', String(z)); };
    apply();
    let tip = 0, ph = null;
    document.addEventListener('keydown', e => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.isComposing) return;
      const k = e.key, c = e.code; let dir;
      if (k === '=' || k === '+' || c === 'Equal' || c === 'NumpadAdd') dir = 1;
      else if ((k === '-' || k === '_' || c === 'Minus' || c === 'NumpadSubtract')) dir = -1;
      else if (!e.shiftKey && (k === '0' || c === 'Digit0' || c === 'Numpad0')) dir = 0;
      else return;
      e.preventDefault();
      if (chatHistBlocked(e.target)) return;
      e.stopPropagation();
      const i = Math.max(0, STEPS.indexOf(z)), was = z;
      const nz = dir === 0 ? 1 : STEPS[Math.max(0, Math.min(STEPS.length - 1, i + dir))];
      if (nz !== z) {
        const keep = ['chat', 'chat2'].map(id => document.getElementById(id)).filter(p => p && p.offsetParent !== null).map(p => {
          const end = p.scrollHeight - p.scrollTop - p.clientHeight < 80, top = p.getBoundingClientRect().top;
          let a = null; if (!end) for (const m of p.querySelectorAll('.msg')) { const r = m.getBoundingClientRect(); if (r.bottom > top + 4) { a = { m, off: r.top - top }; break; } }
          return { p, end, a };
        });
        z = nz; apply();
        try { if (z === 1) localStorage.removeItem(KEY); else localStorage.setItem(KEY, String(z)); } catch (e2) {}
        keep.forEach(({ p, end, a }) => { if (end) p.scrollTop = p.scrollHeight; else if (a && a.m.isConnected) p.scrollTop += a.m.getBoundingClientRect().top - p.getBoundingClientRect().top - a.off; });
      }
      const box = document.getElementById(S.split && S.focusRight ? 'input2' : 'input');
      if (!box) return;
      clearTimeout(tip);
      if (ph === null || ph.box !== box) { if (ph) ph.box.placeholder = ph.text; ph = { box, text: box.placeholder }; }
      const pc = Math.round(z * 100) + '%';
      box.placeholder = 'Message text ' + pc + (dir !== 0 && nz === was ? ', as far as it goes' : '') + (z === 1 ? '' : ' (Ctrl+0 puts it back)');
      tip = setTimeout(() => { if (ph) { ph.box.placeholder = ph.text; ph = null; } }, 1800);
    });
  })();
  async function boot() {
    refreshFarside(); setInterval(refreshFarside, 60000);
    if (!Bridge.host) { $('#banner').className = 'banner warn'; $('#banner').innerHTML = '<span class="grow">Open <b>Squall</b> to use the team. This page needs its host.</span>'; return; }
    const info = await Bridge.call('init');
    S.info = info; S.mock = !!info.mock; S.selftest = !!info.selftest;
    if (info.team && info.team.forceModel && MODELS.some(m => m.id === info.team.forceModel)) S.model = info.team.forceModel;
    if (info.team && info.team.mobile && !info.selftest) { S.mobileOn = true; mobileSet('state'); }   // phone access stays on across restarts
    setupTeam(info.team);
    setupChats(info.state);
    applySides(); setupSplitters();
    // plan usage comes straight from Claude's own run output (usageFromClaude); Squall Control only switches models and presses Stop
    S.bootAt = Date.now();
    bgStart();
    if (info.minimized) setWinState(true);   // started minimized (an update restart): stay paused until the window comes back
    todoLoad(); setInterval(todoLoad, 8000);   // the to-do list follows edits by Laptop and the bots
    Bridge.call('voiceEngines').then(av => { S.voiceAvail = av || {}; if (!S.voiceEngineSet && S.voiceAvail.parakeet) S.voiceEngine = 'parakeet'; }).catch(() => { S.voiceAvail = {}; });
    if (!S.selftest) { setInterval(idleWorkTick, IDLE_EVERY_MS); setInterval(wakeTick, 60000); setInterval(renderTeamSoon, 30000); }   // naps: sleeping shows, and a teammate wakes now and then
    Bridge.call('setModel', { model: S.model }).catch(() => {});
    if (S.selftest) S.sound = false;
    if (info.livetest) S.liveMode = true;
    else if (S.selftest) S.liveMode = false;
    applyLook();
    setTimeout(() => { try { addStarxOnce(); } catch (e) { } }, 4000);
    renderAll(); renderBanner(); updateTitle(); renderTimerChip(); applyStrip(!!info.strip);
    if (!S.selftest) restoreDraft();
    usageRefresh(); setInterval(usageRefresh, 60000);
    setInterval(routineTick, 20000);
    await checkAuth();
    if (S.liveMode && (S.signedIn || S.mock)) startLink();
    if (S.liveMode) startMirrors();
    if (!S.selftest) setInterval(() => { if (S.liveMode) startMirrors(); }, 60000);   // a session started later, or a first list that failed
    saveUpdateLog();   // the bots' copy of the update log exists from the start, with the history Squall kept
    if (info.livetest) setTimeout(liveTest, 400);
    else if (S.selftest) setTimeout(S.info.probe ? timerProbe : selfTest, 400);
  }
  // groky r85: WebView2 keeps a history of everything typed into text fields and drops a browser autofill list under them
  // (Rename, Group name, Vault search, Compact with focus, Other answer, routine fields...). Squall's fields are not web forms,
  // so turn that off for every one-line text field the moment it is pointed at or focused, unless it already says otherwise.
  // The chat composers are textareas and keep their spellcheck; nothing visual changes.
  const noAutofill = e => {
    const t = e.target;
    if (!t || t.tagName !== 'INPUT' || t.hasAttribute('autocomplete')) return;
    const ty = (t.getAttribute('type') || 'text').toLowerCase();
    if (ty === 'text' || ty === 'search' || ty === 'url' || ty === 'email' || ty === 'number' || ty === 'tel') t.setAttribute('autocomplete', 'off');
  };
  document.addEventListener('pointerdown', noAutofill, true);
  document.addEventListener('focusin', noAutofill, true);
  // groky r86: a picture in a message whose link is dead used to show Chromium's broken-image icon and an empty box.
  // Swap it for a quiet one-line note with the alt text and the site it came from; the full address is in the tooltip.
  document.addEventListener('error', e => {
    const t = e.target;
    if (!t || t.tagName !== 'IMG' || !t.closest || !t.closest('.md')) return;
    let host = '';
    try { host = new URL(t.src).hostname.replace(/^www\./, ''); } catch (_) {}
    const s = document.createElement('span'), b = document.createElement('span');
    s.className = 'img-miss'; s.title = t.src || '';
    b.textContent = (t.alt && t.alt.trim() ? t.alt.trim() : 'Image') + ' didn’t load' + (host ? ' · ' + host : '');
    s.appendChild(b); t.replaceWith(s);
  }, true);
  boot().catch(e => { $('#banner').className = 'banner warn'; $('#banner').innerHTML = '<span class="grow">' + APP + ' failed to start: ' + esc(e.message) + '</span>'; });
})();
