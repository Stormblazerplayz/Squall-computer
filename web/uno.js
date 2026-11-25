// Squall Uno in the Squall window: each agent's own computer, live.
//
// Squall Uno is Squall's computer-using agent (docs/squall-uno.md). Every Squall agent (Chief and each bot) has its own small
// Linux computer in Docker on this PC. This file is the window's half:
//   - a "Squall Uno" section in the left sidebar, under the team chats: one row per agent's computer, with a live dot;
//   - the Squall Uno view in the middle: the live screen (frames pushed by the host), what it is doing now, what it did,
//     a task box, Stop / Stop everything / Take the wheel, and Squall Uno's settings (API key, max steps, Docker).
// Everything shown comes from the host (ops through Bridge.call('link', { do: 'uno', op, ... }) and the pushes "uno",
// "unoState" and "unoFrame"). Nothing here is made up: when the host isn't there, the view says so.
// app.js calls SquallUno.wire(hooks) once; the pure parts are tested with Node in tests/web/uno.test.mjs.
(function (root) {
  'use strict';

  const CHIEF = 'chief';
  const MAX_EVENTS = 1500;          // kept in the window (all computers); the host keeps the rest
  const MAX_SESSIONS = 60;
  const STATE_PAGE = 300;           // the host answers at most 300 events per state call
  const RUNNING = ['starting', 'running', 'you'];
  const CLICK_KINDS = ['click', 'left_click', 'double_click', 'triple_click', 'right_click', 'middle_click'];

  // ---------------------------------------------------------------- ids

  // The computer id the host uses for an agent: "pc-" + agentId, lower-cased, anything outside [a-z0-9-] turned into "-".
  function computerIdFor(agentId) {
    return ('pc-' + String(agentId == null ? '' : agentId).toLowerCase().replace(/[^a-z0-9-]/g, '-')).slice(0, 40);
  }

  // Squall's agents as Uno computers: [{ agentId, agentName, color, lead }], the lead ("chief") first.
  // ids: name -> agent id, from SquallLinkCore.botIds (the same ids the phone uses).
  function agentsForUno(agents, ids) {
    const out = [];
    for (const a of agents || []) {
      if (!a || !a.name || !ids || !ids[a.name]) continue;
      out.push({ agentId: ids[a.name], agentName: a.name, color: /^#[0-9a-fA-F]{3,8}$/.test(a.color || '') ? a.color : '#8b5cf6', lead: ids[a.name] === CHIEF });
    }
    out.sort((x, y) => (y.agentId === CHIEF) - (x.agentId === CHIEF));
    return out;
  }

  // ---------------------------------------------------------------- the store (what the host told us)

  function newStore() {
    return { settings: null, computers: [], sessions: [], events: [], seqs: new Set(), lastSeq: 0, frames: {} };
  }

  // A push may arrive flat ({ event, computerId, ... }) or wrapped ({ event, data: {...} }): its fields either way.
  function payloadOf(m) {
    if (m && m.data && typeof m.data === 'object' && !Array.isArray(m.data)) return m.data;
    return m || {};
  }

  const isEvent = e => !!e && typeof e === 'object' && !Array.isArray(e) && Number.isFinite(+e.seq) && typeof e.kind === 'string';

  // The Event inside a "uno" push. The host sends { event: "uno", event: {...} } per the contract, which can't both be
  // kept in one JSON object, so this looks in every place it can be.
  function eventOf(m) {
    if (!m || typeof m !== 'object') return null;
    const d = m.data && typeof m.data === 'object' ? m.data : null;
    for (const c of [m.event, d && d.event, d, m.ev, m.item, m.unoEvent, m]) if (isEvent(c)) return c;
    return null;
  }

  // Adds events (any order, duplicates ignored), keeps them sorted by seq and capped. Returns the ones that were new.
  function addEvents(store, list) {
    const fresh = [];
    for (const e of Array.isArray(list) ? list : []) {
      if (!isEvent(e)) continue;
      const seq = +e.seq;
      if (store.seqs.has(seq)) continue;
      store.seqs.add(seq);
      fresh.push(e);
    }
    if (!fresh.length) return fresh;
    store.events = store.events.concat(fresh).sort((a, b) => a.seq - b.seq);
    while (store.events.length > MAX_EVENTS) store.seqs.delete(+store.events.shift().seq);
    return fresh;
  }

  const sessionTime = s => +(s && s.startedAt) || 0;

  // Merges a state answer or an "unoState" push into the store. fromAll: the answer covered every session (not one
  // sessionId), so its lastSeq is safe to ask "since" from next time.
  function mergeState(store, p, fromAll) {
    if (!p || typeof p !== 'object') return [];
    if (Array.isArray(p.computers)) {
      store.computers = p.computers.filter(c => c && c.id);
      // a computer that went off (or is gone) shows no old screen when it comes back
      for (const id of Object.keys(store.frames)) { const c = store.computers.find(x => x.id === id); if (!c || c.state === 'off') delete store.frames[id]; }
    }
    if (Array.isArray(p.sessions)) {
      const byId = new Map(store.sessions.map(s => [s.id, s]));
      for (const s of p.sessions) if (s && s.id) byId.set(s.id, Object.assign({}, byId.get(s.id), s));
      store.sessions = Array.from(byId.values()).sort((a, b) => sessionTime(b) - sessionTime(a)).slice(0, MAX_SESSIONS);
    }
    if (p.settings && typeof p.settings === 'object') store.settings = p.settings;
    const fresh = addEvents(store, p.events);
    if (fromAll && Number.isFinite(+p.lastSeq)) store.lastSeq = Math.max(store.lastSeq, +p.lastSeq);
    return fresh;
  }

  // A live event: it goes into the feed, and moves "since" on.
  function takeEvent(store, e) {
    const fresh = addEvents(store, [e]);
    if (fresh.length) store.lastSeq = Math.max(store.lastSeq, +e.seq);
    return fresh[0] || null;
  }

  // Keeps the newest frame per computer. Returns the frame when it is newer than the one kept, else null.
  function takeFrame(store, m) {
    const f = payloadOf(m);
    if (!f || !f.computerId || typeof f.jpeg !== 'string' || !f.jpeg) return null;
    const old = store.frames[f.computerId];
    const seq = Number.isFinite(+f.seq) ? +f.seq : 0;
    if (old && seq && old.seq && seq <= old.seq) return null;
    const frame = { computerId: f.computerId, seq, width: +f.width || 0, height: +f.height || 0, cursorX: f.cursorX, cursorY: f.cursorY, jpeg: f.jpeg };
    store.frames[f.computerId] = frame;
    return frame;
  }

  function computerOf(store, agentId) {
    return (store.computers || []).find(c => c.agentId === agentId) || (store.computers || []).find(c => c.id === computerIdFor(agentId)) || null;
  }

  // The session that belongs on a computer's view: the one running on it, else its newest one.
  function currentSession(store, agentId) {
    const comp = computerOf(store, agentId);
    const cid = comp ? comp.id : computerIdFor(agentId);
    if (comp && comp.sessionId) { const s = store.sessions.find(x => x.id === comp.sessionId); if (s) return s; }
    return store.sessions.filter(s => s.computerId === cid || (!s.computerId && s.agentId === agentId)).sort((a, b) => sessionTime(b) - sessionTime(a))[0] || null;
  }

  function sessionsFor(store, agentId) {
    const comp = computerOf(store, agentId);
    const cid = comp ? comp.id : computerIdFor(agentId);
    return store.sessions.filter(s => s.computerId === cid || (!s.computerId && s.agentId === agentId)).sort((a, b) => sessionTime(b) - sessionTime(a));
  }

  // A session's events, newest first.
  function sessionEvents(store, sessionId) {
    if (!sessionId) return [];
    return store.events.filter(e => e.sessionId === sessionId).sort((a, b) => b.seq - a.seq);
  }

  const isRunning = s => !!s && RUNNING.indexOf(s.state) >= 0;
  const num = v => v !== null && v !== undefined && v !== '' && Number.isFinite(+v);
  function anyRunning(store) { return store.sessions.some(isRunning) || store.computers.some(c => c.state === 'starting'); }

  // ---------------------------------------------------------------- words

  // The state line for a computer and its session: { key, label, detail, live, dot }
  //   key: off | starting | live | you | done | stopped | error | on
  //   live: the screen is moving (LIVE pill); dot: the sidebar's live dot (anything running)
  function statusOf(computer, session) {
    const cs = computer && computer.state ? computer.state : 'off';
    const ss = session ? session.state : '';
    const stateText = computer && computer.stateText ? String(computer.stateText) : '';
    const R = (key, label, detail) => ({ key, label, detail: detail || '', live: key === 'live' || key === 'you', dot: key === 'live' || key === 'you' || key === 'starting' });
    if (ss === 'you') return R('you', 'You have the wheel', 'Squall Uno is paused. Hand it back when you’re done.');
    if (ss === 'running') return R('live', 'Live', '');
    if (ss === 'starting' || cs === 'starting') return R('starting', 'Starting…', stateText || 'Getting the computer ready.');
    if (cs === 'error') return R('error', 'Error', stateText || 'The computer had a problem.');
    if (cs === 'off' || !computer) {
      const last = ss === 'done' ? 'Last task: done.' : ss === 'stopped' ? 'Last task: stopped.' : ss === 'error' ? 'Last task stopped with an error' + (session.error ? ': ' + session.error : '.') : '';
      return R('off', 'Off', last || stateText);
    }
    if (ss === 'error') return R('error', 'Error', session.error || 'Squall Uno stopped with an error.');
    if (ss === 'done') return R('done', 'Done', '');
    if (ss === 'stopped') return R('stopped', 'Stopped', '');
    return R('on', 'On', stateText || 'Ready for a task.');
  }

  // A session's own state, for the recent list
  const SESSION_WORDS = { starting: 'Starting…', running: 'Live', you: 'You have the wheel', done: 'Done', stopped: 'Stopped', error: 'Error' };
  function sessionLabel(s) { return (s && SESSION_WORDS[s.state]) || 'Unknown'; }

  // The "NOW · step N" line: { label, text }
  function nowLine(session) {
    if (!session) return { label: 'NOW', text: '' };
    const n = Math.max(0, Math.round(+session.steps || 0));
    const label = (isRunning(session) ? 'NOW' : 'LAST') + (n ? ' · step ' + n : '');
    const text = String(session.now || session.lastText || (session.state === 'starting' ? 'Getting ready…' : '')).trim();
    return { label, text };
  }

  function ago(at, now) {
    const t = +at;
    if (!Number.isFinite(t) || t <= 0) return '';
    const s = Math.max(0, Math.round(((now == null ? Date.now() : now) - t) / 1000));
    if (s < 5) return 'now';
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    const d = Math.round(s / 86400);
    return d + (d === 1 ? ' day ago' : ' days ago');
  }

  // per kind: [icon, color]
  const KIND_LOOK = {
    start: ['play', '#8b5cf6'],
    screenshot: ['camera', '#c3c7d4'], zoom: ['zoom', '#c3c7d4'],
    click: ['pointer', '#5fb2ff'], left_click: ['pointer', '#5fb2ff'], double_click: ['pointer', '#5fb2ff'], triple_click: ['pointer', '#5fb2ff'],
    right_click: ['pointer', '#5fb2ff'], middle_click: ['pointer', '#5fb2ff'], mouse_down: ['pointer', '#5fb2ff'], mouse_up: ['pointer', '#5fb2ff'],
    move: ['move', '#3b87d6'], cursor: ['move', '#3b87d6'], drag: ['drag', '#3b87d6'],
    type: ['keyboard', '#b9a7ff'], key: ['keyboard', '#b9a7ff'], hold_key: ['keyboard', '#b9a7ff'],
    scroll: ['scroll', '#5fb2ff'],
    wait: ['clock', '#7d8197'],
    say: ['chat', '#eceaf6'], message: ['chat', '#eceaf6'],
    takeover: ['hand', '#8b5cf6'], handback: ['hand', '#8b5cf6'],
    done: ['check', '#4ade80'], stopped: ['stop', '#f5b14a'], error: ['alert', '#f87171'],
  };
  const KIND_WORDS = {
    start: 'Started', screenshot: 'Looked at the screen', zoom: 'Zoomed in', click: 'Clicked', left_click: 'Clicked', double_click: 'Double-clicked',
    triple_click: 'Triple-clicked', right_click: 'Right-clicked', middle_click: 'Middle-clicked', mouse_down: 'Pressed the mouse', mouse_up: 'Let go of the mouse',
    move: 'Moved the mouse', cursor: 'Checked where the mouse is', drag: 'Dragged', type: 'Typed', key: 'Pressed a key', hold_key: 'Held a key', scroll: 'Scrolled',
    wait: 'Waited', say: 'Said something', message: 'Message', takeover: 'You took the wheel', handback: 'You handed it back', done: 'Done', stopped: 'Stopped', error: 'Error',
  };

  // One "WHAT IT DID" row: { seq, icon, color, text, who, you, when, cls }
  function feedRow(e, now) {
    const look = KIND_LOOK[e && e.kind] || ['dot', '#a9adc0'];
    let text = String((e && e.text) || '').trim();
    if (!text) {
      text = KIND_WORDS[e && e.kind] || 'Did something';
      if (num(e.x) && num(e.y)) text += ' at (' + Math.round(+e.x) + ', ' + Math.round(+e.y) + ')';
    }
    const who = e && (e.who === 'you' || e.who === 'system') ? e.who : 'uno';
    return { seq: +e.seq, icon: look[0], color: look[1], text, who, you: who === 'you', when: ago(e.at, now), cls: 'k-' + String((e && e.kind) || 'x').replace(/[^a-z_]/g, '') };
  }

  const isClick = e => !!e && CLICK_KINDS.indexOf(e.kind) >= 0 && num(e.x) && num(e.y);

  // ---------------------------------------------------------------- coordinates

  // A point on the computer's screen (width × height pixels) as percentages of the shown picture, or null.
  function framePct(x, y, width, height) {
    if (!num(x) || !num(y) || !(+width > 0) || !(+height > 0)) return null;
    const c = v => Math.max(0, Math.min(100, v));
    return { left: c(+x / +width * 100), top: c(+y / +height * 100) };
  }

  // The cursor from a frame: { left, top } percentages, or null when the frame has no cursor.
  function cursorPct(frame, fallbackW, fallbackH) {
    if (!frame) return null;
    return framePct(frame.cursorX, frame.cursorY, frame.width || fallbackW, frame.height || fallbackH);
  }

  // A point in the shown box (px, py from its top-left, the box boxW × boxH, the picture drawn with object-fit: contain)
  // to the computer's screen pixels. Null when the point is outside the picture (in the letterbox) or nothing is known.
  function displayToScreen(px, py, boxW, boxH, width, height) {
    if (!(boxW > 0) || !(boxH > 0) || !(width > 0) || !(height > 0) || !Number.isFinite(px) || !Number.isFinite(py)) return null;
    const scale = Math.min(boxW / width, boxH / height);
    const dw = width * scale, dh = height * scale;
    const ox = (boxW - dw) / 2, oy = (boxH - dh) / 2;
    const rx = px - ox, ry = py - oy;
    if (rx < 0 || ry < 0 || rx > dw || ry > dh) return null;
    return { x: Math.max(0, Math.min(width - 1, Math.floor(rx / scale))), y: Math.max(0, Math.min(height - 1, Math.floor(ry / scale))) };
  }

  // The size to draw a width × height screen at inside an area: { w, h } that fits both and keeps the shape.
  function fitBox(areaW, areaH, width, height) {
    if (!(areaW > 0) || !(areaH > 0) || !(width > 0) || !(height > 0)) return { w: 0, h: 0 };
    const scale = Math.min(areaW / width, areaH / height);
    return { w: Math.floor(width * scale), h: Math.floor(height * scale) };
  }

  // ---------------------------------------------------------------- settings words

  const clampSteps = v => Math.max(10, Math.min(300, Math.round(+v || 0) || 80));

  function keyText(st) {
    if (!st) return 'Not checked yet.';
    if (st.keySource === 'env') return 'Using the SQUALL_UNO_KEY variable' + (st.keyHint ? ' (' + st.keyHint + ')' : '') + '.';
    if (st.keySource === 'saved' || st.hasKey) return 'Saved on this PC' + (st.keyHint ? ' (' + st.keyHint + ')' : '') + '.';
    return 'No key yet. Squall Uno needs an Anthropic API key to work.';
  }

  function fmtNum(n) { return Math.max(0, Math.round(+n || 0)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  function tokensText(st) {
    const t = st && st.tokensToday;
    if (!t) return 'No tokens used today.';
    const i = +t.input || 0, o = +t.output || 0;
    if (!i && !o) return 'No tokens used today.';
    return fmtNum(i) + ' in · ' + fmtNum(o) + ' out today';
  }

  // A failed op as a plain sentence, or '' when it worked
  function errorText(resOrErr) {
    if (!resOrErr) return 'Squall didn’t answer.';
    if (resOrErr instanceof Error || (typeof resOrErr === 'object' && 'message' in resOrErr && !('ok' in resOrErr))) {
      const msg = String(resOrErr.message || '');
      if (/unknown link request/i.test(msg)) return 'This copy of Squall doesn’t have Squall Uno yet. Update Squall on this PC.';
      if (/needs its host|open the .* app/i.test(msg)) return 'Squall Uno needs the Squall app on this PC.';
      return msg || 'Something went wrong.';
    }
    if (typeof resOrErr === 'object' && resOrErr.ok === false) return String(resOrErr.error || 'That didn’t work.');
    return '';
  }

  // ---------------------------------------------------------------- the window

  const ICONS = {
    bolt: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M13.2 2 5 13.4h5.6L9.4 22l8.6-12h-5.7z"/></svg>',
    play: '<path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/>',
    camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
    zoom: '<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5M11 8v6M8 11h6"/>',
    pointer: '<path d="M5 3l6 17 2.5-7L21 10.5z" fill="currentColor" stroke="none"/>',
    move: '<path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/>',
    drag: '<path d="M5 19 19 5M19 5h-6M19 5v6"/>',
    keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
    scroll: '<path d="M12 4v16M8 8l4-4 4 4M8 16l4 4 4-4"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    chat: '<path d="M4 5h16v11H9l-5 4z"/>',
    hand: '<path d="M8 12V5.5a1.5 1.5 0 0 1 3 0V11M11 10V4.5a1.5 1.5 0 0 1 3 0V11M14 10.5V6a1.5 1.5 0 0 1 3 0v8a6 6 0 0 1-6 6h-1a6 6 0 0 1-5-2.7L3 13.5a1.5 1.5 0 0 1 2.5-1.7L8 14"/>',
    check: '<path d="M4.5 12.5 9.5 17.5 19.5 6.5"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
    alert: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h.01"/>',
    dot: '<circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    back: '<path d="M15 6l-6 6 6 6"/>',
  };
  const svg = (name, size) => name === 'bolt' ? ICONS.bolt : '<svg viewBox="0 0 24 24" width="' + (size || 14) + '" height="' + (size || 14) + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + (ICONS[name] || ICONS.dot) + '</svg>';
  const CURSOR_SVG = '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M4 2.5 4 19l4.4-4.2 2.9 6.7 2.6-1.1-2.9-6.6H17z" fill="#fff" stroke="#0b0a12" stroke-width="1.4" stroke-linejoin="round"/></svg>';

  function wire(h) {
    if (!h || !h.Bridge || typeof document === 'undefined') return null;
    const Bridge = h.Bridge, S = h.S || {};
    const esc = h.esc || (s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]));
    const available = !!Bridge.host;
    const store = newStore();
    const ui = {
      open: false, agentId: null, agentName: '', watching: null, viewSession: null, wheelLocal: false, clickMode: 'left_click',
      settings: false, err: '', note: '', checkText: '', busy: {}, lastPush: 0, loaded: false, missing: '', refreshing: false,
      shownSeq: 0, screenW: 1280, screenH: 800, hover: null, cursor: null, localClickAt: 0,
    };

    // ---------------- talking to the host ----------------

    async function op(name, fields) {
      if (!available) return { ok: false, error: 'Squall Uno needs the Squall app on this PC.' };
      try {
        const res = await Bridge.call('link', Object.assign({ do: 'uno', op: name }, fields || {}));
        if (res && res.ok === false) return { ok: false, error: errorText(res) };
        return Object.assign({ ok: true }, res || {});
      } catch (e) { return { ok: false, error: errorText(e) }; }
    }

    async function refresh(sessionId) {
      if (!available || (ui.refreshing && !sessionId)) return;
      if (!sessionId) ui.refreshing = true;
      try {
        let since = sessionId ? 0 : store.lastSeq;
        for (let page = 0; page < 10; page++) {
          const res = await op('state', sessionId ? { since, sessionId } : { since });
          if (!res.ok) {
            if (!ui.loaded) ui.missing = res.error;
            else if (sessionId) flash(res.error);
            break;
          }
          ui.loaded = true; ui.missing = '';
          mergeState(store, res, !sessionId);
          const evs = Array.isArray(res.events) ? res.events : [];
          if (evs.length < STATE_PAGE) break;
          since = Math.max(since, ...evs.map(e => +e.seq || 0));
        }
      } finally { if (!sessionId) ui.refreshing = false; }
      changed();
    }

    // ---------------- pushes ----------------

    Bridge.on('unoState', m => { ui.lastPush = Date.now(); const before = watchedComputer(); mergeState(store, payloadOf(m), false); ui.loaded = true; ui.missing = ''; changed(); rewatchIfNeeded(before); });
    Bridge.on('uno', m => { const e = eventOf(m); if (e) onEvent(e); });
    Bridge.on('unoFrame', m => onFrame(m));
    // the contract's "uno" push puts the Event under "event", where the bridge looks for the push's name: catch it here too
    try {
      const wv = root.chrome && root.chrome.webview;
      if (wv) wv.addEventListener('message', ev => { const m = ev && ev.data; if (m && m.event && typeof m.event === 'object' && !m.id) { const e = eventOf(m); if (e) onEvent(e); } });
    } catch (e) { /* no webview */ }

    function onEvent(e) {
      ui.lastPush = Date.now();
      const fresh = takeEvent(store, e);
      if (!fresh) return;
      const comp = watchedComputer();
      const here = ui.open && comp && fresh.computerId === comp.id;
      // your own clicks from this window already rippled when you clicked
      if (here && isClick(fresh) && !(fresh.who === 'you' && Date.now() - ui.localClickAt < 4000)) ripple(+fresh.x, +fresh.y, fresh.who === 'you');
      if (here && num(fresh.x) && num(fresh.y) && fresh.kind !== 'scroll') moveCursor(+fresh.x, +fresh.y);
      // a session's last word changes the state too: ask once, quietly
      if (/^(done|stopped|error|takeover|handback|start)$/.test(fresh.kind)) setTimeout(() => refresh(), 250);
      changedSoon();
    }

    let paintReq = 0;
    function onFrame(m) {
      ui.lastPush = Date.now();
      const f = takeFrame(store, m);
      if (!f) return;
      const comp = watchedComputer();
      if (!ui.open || !comp || f.computerId !== comp.id) return;
      if (!paintReq) paintReq = requestAnimationFrame(() => { paintReq = 0; paintFrame(); });
    }

    // when the pushes stop coming (an older host, or a hiccup) and something is running, ask now and then
    let tick = 0;
    setInterval(() => {
      if (!available || document.hidden) return;
      tick++;
      if (!ui.loaded) { if (tick % 20 === 0) refresh(); return; }
      if (Date.now() - ui.lastPush < 6000 || !anyRunning(store)) { if (ui.open) renderFeedTimes(); return; }
      if (ui.open || tick % 4 === 0) refresh();
    }, 3000);

    // ---------------- the sidebar section ----------------

    function agents() {
      const core = root.SquallLinkCore;
      const list = S.agents || [];
      const lead = S.lead ? S.lead.name : null;
      const ids = core && core.botIds ? core.botIds(list, lead) : {};
      return agentsForUno(list, ids);
    }

    function iconFor(a, big) {
      if (!a || a.lead) return '<span class="uno-ic bolt' + (big ? ' big' : '') + '">' + ICONS.bolt + '</span>';
      return '<span class="uno-ic' + (big ? ' big' : '') + '" style="--c:' + esc(a.color) + '">' + esc(String(a.agentName || '?').charAt(0).toUpperCase()) + '</span>';
    }

    function sidebarHTML() {
      const list = agents();
      if (!list.length) return available ? '' : '<div class="uno-side" data-k="uno-side"><div class="uno-side-head" data-k="uno-side-head"><span class="uno-side-bolt">' + ICONS.bolt + '</span>Squall Uno</div><div class="uno-side-note">Squall Uno needs the Squall app on this PC.</div></div>';
      let live = 0;
      const rows = list.map(a => {
        const comp = computerOf(store, a.agentId), sess = currentSession(store, a.agentId);
        const st = available && ui.loaded ? statusOf(comp, sess) : null;
        if (st && st.dot) live++;
        const label = !available ? 'Needs the app' : !ui.loaded ? (ui.missing ? 'Not here yet' : '…') : st.label;
        const on = ui.open && ui.agentId === a.agentId;
        return '<button class="uno-row' + (on ? ' on' : '') + (st && st.dot ? ' live' : '') + (st ? ' s-' + st.key : '') + '" data-k="uno:' + esc(a.agentId) + '" data-uno-open="' + esc(a.agentId) + '" title="' + esc(a.agentName + '’s computer' + (st ? ' · ' + st.label + (st.detail ? ' · ' + st.detail : '') : '')) + '">' +
          iconFor(a) + '<span class="uno-rt"><span class="uno-nm">' + esc(a.agentName) + '</span><span class="uno-st">' + esc(label) + '</span></span>' +
          (st && st.dot ? '<i class="uno-dot ' + (st.key === 'starting' ? 'starting' : 'live') + '"></i>' : '') + '</button>';
      }).join('');
      return '<div class="uno-side" data-k="uno-side"><div class="uno-side-head" data-k="uno-side-head"><span class="uno-side-bolt">' + ICONS.bolt + '</span>Squall Uno' +
        (live ? '<span class="uno-side-live"><i></i>' + live + ' live</span>' : '') + '</div>' + rows + '</div>';
    }

    document.addEventListener('click', e => {
      const t = e.target && e.target.closest ? e.target : null;
      if (!t) return;
      const row = t.closest('[data-uno-open]');
      if (row) { open(row.getAttribute('data-uno-open')); }
    });

    // ---------------- the view ----------------

    let view = null;   // #uno-view
    const $u = sel => view ? view.querySelector(sel) : null;

    function watchedComputer() { return ui.agentId ? computerOf(store, ui.agentId) : null; }
    function agentInfo() { return agents().find(a => a.agentId === ui.agentId) || { agentId: ui.agentId, agentName: ui.agentName || ui.agentId, color: '#8b5cf6', lead: ui.agentId === CHIEF }; }
    function shownSession() {
      if (ui.viewSession) { const s = store.sessions.find(x => x.id === ui.viewSession); if (s) return s; }
      return currentSession(store, ui.agentId);
    }

    function setWatch(computerId) {
      if (!available) return;
      if (ui.watching === computerId) return;
      ui.watching = computerId;
      op('watch', { computerId: computerId || null }).then(r => { if (!r.ok && computerId) flash(r.error); });
    }
    function rewatchIfNeeded(before) {
      const comp = watchedComputer();
      if (!ui.open || !comp) return;
      // the computer just turned on: say again that we're watching it (the host may have had nothing to watch before)
      if (!before || before.state !== comp.state) { ui.watching = null; setWatch(comp.id); }
    }

    function open(agentId) {
      if (!agentId) return;
      const a = agents().find(x => x.agentId === agentId);
      if (h.beforeOpen) { try { h.beforeOpen(); } catch (e) { /* the chat side couldn't close something: the view still opens */ } }
      const same = ui.open && ui.agentId === agentId;
      ui.open = true; ui.agentId = agentId; ui.agentName = a ? a.agentName : agentId;
      if (!same) { ui.viewSession = null; ui.wheelLocal = false; ui.err = ''; ui.note = ''; ui.shownSeq = 0; ui.settings = false; }
      build();
      const center = document.getElementById('center');
      if (center) center.classList.add('uno-on');
      const comp = watchedComputer();
      setWatch(comp ? comp.id : computerIdFor(agentId));
      if (available && !ui.loaded) refresh();
      const cur = currentSession(store, agentId);
      if (cur) refresh(cur.id);
      render();
      if (h.renderTeamSoon) h.renderTeamSoon();
      if (h.sfx) try { h.sfx('chat'); } catch (e) { }
    }

    function close() {
      if (!ui.open) return;
      ui.open = false;
      setWatch(null);
      const center = document.getElementById('center');
      if (center) center.classList.remove('uno-on');
      if (view) view.hidden = true;
      if (h.renderTeamSoon) h.renderTeamSoon();
    }

    function build() {
      const center = document.getElementById('center');
      if (!center) return;
      if (!view) {
        view = document.createElement('section');
        view.id = 'uno-view';
        view.setAttribute('aria-label', 'Squall Uno');
        center.appendChild(view);
        view.addEventListener('click', onClick);
        view.addEventListener('keydown', onKey);
        view.addEventListener('wheel', onWheel, { passive: false });
        view.addEventListener('mousemove', onMove);
        view.addEventListener('mouseleave', () => { ui.hover = null; paintChip(); });
        if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => layoutScreen()).observe(view);
        else root.addEventListener('resize', layoutScreen);
      }
      view.hidden = false;
      if (view.dataset.agent === ui.agentId && view.firstChild) return;
      view.dataset.agent = ui.agentId;
      view.innerHTML =
        '<div class="uno-head"></div>' +
        '<div class="uno-flash" hidden></div>' +
        '<div class="uno-body">' +
          '<div class="uno-main">' +
            '<div class="uno-stage"><div class="uno-box"><img class="uno-img" alt="" draggable="false"><div class="uno-cursor" hidden>' + CURSOR_SVG + '</div><div class="uno-ripples"></div><div class="uno-chip" hidden></div><div class="uno-empty" hidden></div></div></div>' +
            '<div class="uno-now"><span class="uno-now-l"></span><span class="uno-now-t"></span></div>' +
            '<div class="uno-ctrls"></div>' +
            '<div class="uno-wheel" hidden>' +
              '<div class="uno-wheel-row"><span class="uno-lbl">Click</span><div class="uno-seg" role="group" aria-label="Click mode">' +
                '<button data-u="mode" data-uv="left_click" class="on">Click</button><button data-u="mode" data-uv="double_click">Double</button><button data-u="mode" data-uv="right_click">Right click</button></div>' +
                '<span class="uno-tip">Click the screen to click there.</span></div>' +
              '<div class="uno-wheel-row"><input class="uno-in uno-type" type="text" placeholder="Type something on the computer…" spellcheck="false" autocomplete="off"><button data-u="type" class="uno-btn">Type it</button></div>' +
              '<div class="uno-wheel-row uno-keys"><span class="uno-lbl">Keys</span><button data-u="key" data-uv="Escape" class="uno-key">Esc</button><button data-u="key" data-uv="Tab" class="uno-key">Tab</button><button data-u="key" data-uv="Return" class="uno-key">Enter</button><button data-u="key" data-uv="ctrl+z" class="uno-key">Ctrl+Z</button>' +
                '<span class="uno-gap"></span><button data-u="scroll" data-uv="up" class="uno-key" title="Scroll up">' + svg('scroll', 12) + ' Up</button><button data-u="scroll" data-uv="down" class="uno-key" title="Scroll down">' + svg('scroll', 12) + ' Down</button></div>' +
              '<div class="uno-wheel-row uno-handback"><input class="uno-in uno-note" type="text" placeholder="A note for Squall Uno (optional)" spellcheck="true" autocomplete="off"><button data-u="handback" class="uno-btn primary">Hand back</button></div>' +
            '</div>' +
            '<div class="uno-task">' +
              '<div class="uno-msg" hidden><div class="uno-lbl uno-msg-l">Tell Squall Uno something</div><div class="uno-row2"><input class="uno-in uno-msg-in" type="text" placeholder="It reads this before its next step…" spellcheck="true" autocomplete="off"><button data-u="message" class="uno-btn">Send</button></div></div>' +
              '<div class="uno-new"><div class="uno-lbl">What should Squall Uno do?</div><div class="uno-row2"><textarea class="uno-in uno-task-in" rows="2" placeholder="For example: find the weather in Paris and tell me" spellcheck="true"></textarea><button data-u="start" class="uno-btn primary">Start</button></div></div>' +
            '</div>' +
          '</div>' +
          '<div class="uno-side-col">' +
            '<div class="uno-card uno-settings" hidden></div>' +
            '<div class="uno-card"><div class="uno-card-h">What it did</div><div class="uno-feed"></div></div>' +
            '<div class="uno-card"><div class="uno-card-h">Recent sessions</div><div class="uno-recent"></div></div>' +
          '</div>' +
        '</div>';
      buildSettings();
    }

    function buildSettings() {
      const box = $u('.uno-settings');
      if (!box) return;
      box.innerHTML =
        '<div class="uno-card-h">Squall Uno settings<button class="uno-x" data-u="settings" title="Close settings">×</button></div>' +
        '<div class="uno-set"><div class="uno-set-l">API key</div><div class="uno-set-v uno-key-st"></div>' +
          '<div class="uno-row2"><input class="uno-in uno-key-in" type="password" placeholder="Paste an Anthropic API key" autocomplete="off" spellcheck="false"><button data-u="saveKey" class="uno-btn primary">Save key to this PC</button></div>' +
          '<div class="uno-set-note">The key stays on this PC (locked to your Windows account). Or set the SQUALL_UNO_KEY variable instead.</div>' +
          '<div class="uno-row2"><button data-u="removeKey" class="uno-btn">Remove key</button><button data-u="check" class="uno-btn">Check it works</button></div>' +
          '<div class="uno-set-v uno-check" hidden></div></div>' +
        '<div class="uno-set"><div class="uno-set-l">Max steps per task</div><div class="uno-row2 uno-steps"><button data-u="steps" data-uv="-10" class="uno-key" title="10 fewer">−</button><span class="uno-steps-v"></span><button data-u="steps" data-uv="10" class="uno-key" title="10 more">+</button></div></div>' +
        '<div class="uno-set"><div class="uno-set-l">Docker</div><div class="uno-set-v uno-docker"></div></div>' +
        '<div class="uno-set"><div class="uno-set-l">Used today</div><div class="uno-set-v uno-tokens"></div></div>' +
        '<div class="uno-set"><div class="uno-set-l">Model</div><div class="uno-set-v uno-model"></div></div>';
    }

    // ---------------- drawing ----------------

    let changeReq = 0;
    function changed() { if (h.renderTeamSoon) h.renderTeamSoon(); if (ui.open) render(); }
    function changedSoon() { if (!changeReq) changeReq = setTimeout(() => { changeReq = 0; changed(); }, 120); }

    function render() {
      if (!ui.open || !view) return;
      build();
      const a = agentInfo(), comp = watchedComputer(), cur = currentSession(store, ui.agentId), sess = shownSession();
      const st = statusOf(comp, cur);
      const past = sess && cur && sess.id !== cur.id;
      if (comp && comp.width && comp.height) { ui.screenW = +comp.width; ui.screenH = +comp.height; }
      const wheel = wheelOn();

      // header
      const title = (comp && comp.name) || (a.agentName + '’s computer');
      const sub = !available ? 'Needs the Squall app on this PC'
        : ui.missing ? ui.missing
        : !ui.loaded ? 'Checking…'
        : st.label + (st.detail ? ' · ' + st.detail : '');
      setHTML('.uno-head',
        '<button class="uno-back" data-u="close" title="Back to the chat">' + svg('back', 16) + '</button>' +
        iconFor(a, true) +
        '<div class="uno-head-t"><div class="uno-title">' + esc(title) + (st.live && available && ui.loaded ? '<span class="uno-livepill"><i></i>LIVE</span>' : '') + '</div>' +
        '<div class="uno-sub s-' + esc(available && ui.loaded ? st.key : 'off') + '">' + esc(sub) + '</div></div>' +
        (available ? '<button class="uno-gear' + (ui.settings ? ' on' : '') + '" data-u="settings" title="Squall Uno settings">' + svg('gear', 16) + '</button>' : ''));

      // the flash line (errors from ops)
      const fl = $u('.uno-flash');
      if (fl) { fl.hidden = !ui.err; fl.textContent = ui.err; }

      // the screen
      paintEmpty(comp, st);
      paintFrame();

      // now
      const nl = nowLine(sess);
      setText('.uno-now-l', past ? 'THEN' + (sess.steps ? ' · step ' + sess.steps : '') : nl.label);
      setText('.uno-now-t', nl.text || (sess ? '' : available && ui.loaded ? 'Nothing yet. Give it a task below.' : ''));
      const nowEl = $u('.uno-now'); if (nowEl) { nowEl.classList.toggle('live', isRunning(sess) && !past); nowEl.hidden = !available; }

      // the buttons
      const running = isRunning(cur);
      const anyRun = store.sessions.some(isRunning);
      const b = ui.busy;
      let ctrls = '';
      if (available && ui.loaded) {
        if (running && cur.state !== 'you') ctrls += '<button class="uno-btn wheel" data-u="takeover"' + (b.takeover ? ' disabled' : '') + '>' + svg('hand') + 'Take the wheel</button>';
        if (!running && comp && comp.state === 'on' && !ui.wheelLocal) ctrls += '<button class="uno-btn" data-u="drive">' + svg('hand') + 'Use it yourself</button>';
        if (running) ctrls += '<button class="uno-btn" data-u="stop"' + (b.stop ? ' disabled' : '') + '>' + svg('stop') + 'Stop</button>';
        if (anyRun) ctrls += '<button class="uno-btn danger" data-u="stopAll"' + (b.stopAll ? ' disabled' : '') + ' title="Stops every Squall Uno task on every computer">' + svg('stop') + 'Stop everything</button>';
        if (!running && comp && comp.state !== 'off') ctrls += '<button class="uno-btn quiet" data-u="computerOff"' + (b.computerOff ? ' disabled' : '') + ' title="Turns this computer off. Its files go away.">Turn off</button>';
        if (past) ctrls += '<button class="uno-btn quiet" data-u="backNow">Back to now</button>';
      }
      setHTML('.uno-ctrls', ctrls);

      // wheel mode
      const wh = $u('.uno-wheel');
      if (wh) {
        wh.hidden = !wheel;
        wh.querySelectorAll('[data-u="mode"]').forEach(x => x.classList.toggle('on', x.getAttribute('data-uv') === ui.clickMode));
        const hb = wh.querySelector('[data-u="handback"]'); if (hb) { hb.textContent = cur && cur.state === 'you' ? 'Hand back' : 'Done'; hb.disabled = !!b.handback; }
        const nt = wh.querySelector('.uno-note'); if (nt) nt.hidden = !(cur && cur.state === 'you');
      }
      const stage = $u('.uno-stage'); if (stage) stage.classList.toggle('wheel', wheel);

      // the task box
      const task = $u('.uno-task');
      if (task) task.hidden = !available || !ui.loaded;
      const msg = $u('.uno-msg'), nw = $u('.uno-new');
      const talkTo = past ? sess : cur;
      if (msg) {
        msg.hidden = !talkTo || wheel;
        const ml = msg.querySelector('.uno-msg-l');
        if (ml && talkTo) ml.textContent = isRunning(talkTo) ? 'Tell Squall Uno something' : 'Keep going on “' + clip(talkTo.task, 40) + '”';
        const mi = msg.querySelector('.uno-msg-in');
        if (mi && talkTo) mi.placeholder = isRunning(talkTo) ? 'It reads this before its next step…' : 'What should it do next?';
        const mb = msg.querySelector('[data-u="message"]'); if (mb) mb.disabled = !!b.message;
      }
      if (nw) {
        nw.hidden = running;
        const sb = nw.querySelector('[data-u="start"]'); if (sb) { sb.disabled = !!b.start; sb.textContent = b.start ? 'Starting…' : 'Start'; }
        const lbl = nw.querySelector('.uno-lbl'); if (lbl) lbl.textContent = talkTo ? 'Or give it a new task' : 'What should Squall Uno do?';
      }

      renderFeed(sess);
      renderRecent(cur, sess);
      renderSettings();
      layoutScreen();
    }

    const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
    function setHTML(sel, html) { const el = $u(sel); if (el && el._html !== html) { el.innerHTML = html; el._html = html; } }
    function setText(sel, text) { const el = $u(sel); if (el && el.textContent !== text) el.textContent = text; }

    function wheelOn() {
      const cur = currentSession(store, ui.agentId), comp = watchedComputer();
      if (cur && cur.state === 'you') return true;
      return ui.wheelLocal && !!comp && comp.state === 'on' && !isRunning(cur);
    }

    function paintEmpty(comp, st) {
      const el = $u('.uno-empty');
      if (!el) return;
      const frame = comp ? store.frames[comp.id] : null;
      let html = '';
      if (available && ui.loaded && frame && comp && (comp.state === 'on' || comp.state === 'starting')) html = '';
      else if (!available) html = '<div class="uno-empty-ic">' + svg('monitor', 28) + '</div><b>Squall Uno needs the Squall app</b><span>Open Squall on your PC to see and use the agents’ computers here.</span>';
      else if (ui.missing) html = '<div class="uno-empty-ic">' + svg('alert', 28) + '</div><b>Squall Uno isn’t ready</b><span>' + esc(ui.missing) + '</span>';
      else if (!ui.loaded) html = '<div class="uno-empty-ic">' + svg('clock', 28) + '</div><b>Checking…</b>';
      else if (!comp || comp.state === 'off') html = '<div class="uno-empty-ic">' + svg('monitor', 28) + '</div><b>This computer is off</b><span>Give Squall Uno a task below to turn this computer on.</span>';
      else if (comp.state === 'starting') html = '<div class="uno-empty-ic spin">' + svg('clock', 28) + '</div><b>Starting…</b><span>' + esc(comp.stateText || 'Getting the computer ready.') + '</span>';
      else if (comp.state === 'error') html = '<div class="uno-empty-ic">' + svg('alert', 28) + '</div><b>The computer had a problem</b><span>' + esc(comp.stateText || st.detail || 'Try turning it off and starting a task again.') + '</span>';
      else if (!frame) html = '<div class="uno-empty-ic spin">' + svg('clock', 28) + '</div><b>Waiting for the screen…</b>';
      if (el._html !== html) { el.innerHTML = html; el._html = html; }
      el.hidden = !html;
      const img = $u('.uno-img');
      if (img && html) img.hidden = true;
    }

    function paintFrame() {
      const comp = watchedComputer();
      const frame = comp ? store.frames[comp.id] : null;
      const img = $u('.uno-img');
      if (!img) return;
      if (!frame || !comp || comp.state === 'off') { if (img.getAttribute('src')) img.removeAttribute('src'); img.hidden = true; const c = $u('.uno-cursor'); if (c) c.hidden = true; return; }
      if (frame.width && frame.height && (frame.width !== ui.screenW || frame.height !== ui.screenH)) { ui.screenW = frame.width; ui.screenH = frame.height; layoutScreen(); }
      if (ui.shownSeq !== frame.seq || !img.getAttribute('src')) {
        ui.shownSeq = frame.seq;
        img.src = 'data:image/jpeg;base64,' + frame.jpeg;
      }
      img.hidden = false;
      paintEmpty(comp, statusOf(comp, currentSession(store, ui.agentId)));
      if (frame.cursorX != null && frame.cursorY != null) moveCursor(+frame.cursorX, +frame.cursorY);
    }

    function moveCursor(x, y) {
      const c = $u('.uno-cursor');
      if (!c) return;
      const p = framePct(x, y, ui.screenW, ui.screenH);
      if (!p) { c.hidden = true; return; }
      c.hidden = false;
      c.style.left = p.left + '%'; c.style.top = p.top + '%';
      ui.cursor = { x: Math.round(x), y: Math.round(y) };
      paintChip();
    }

    function paintChip() {
      const chip = $u('.uno-chip');
      if (!chip) return;
      const p = ui.hover && wheelOn() ? ui.hover : ui.cursor;
      chip.hidden = !p;
      if (p) chip.textContent = (ui.hover && wheelOn() ? 'you · ' : '') + p.x + ', ' + p.y;
    }

    function ripple(x, y, mine) {
      const box = $u('.uno-ripples');
      const p = framePct(x, y, ui.screenW, ui.screenH);
      if (!box || !p) return;
      const r = document.createElement('i');
      r.className = 'uno-ripple' + (mine ? ' you' : '');
      r.style.left = p.left + '%'; r.style.top = p.top + '%';
      box.appendChild(r);
      setTimeout(() => r.remove(), 900);
      while (box.childElementCount > 8) box.firstChild.remove();
    }

    function layoutScreen() {
      if (!ui.open || !view) return;
      const stage = $u('.uno-stage'), box = $u('.uno-box');
      if (!stage || !box) return;
      const areaW = stage.clientWidth;
      const areaH = Math.max(200, Math.min((root.innerHeight || 800) * 0.56, 640));
      const fit = fitBox(areaW, areaH, ui.screenW || 1280, ui.screenH || 800);
      if (!fit.w) return;
      box.style.width = fit.w + 'px'; box.style.height = fit.h + 'px';
      stage.style.height = fit.h + 'px';
    }

    function renderFeed(sess) {
      const box = $u('.uno-feed');
      if (!box) return;
      if (!available || !ui.loaded) { setHTML('.uno-feed', ''); return; }
      const evs = sess ? sessionEvents(store, sess.id) : [];
      if (!evs.length) { setHTML('.uno-feed', '<div class="uno-none">' + (sess ? 'Nothing yet.' : 'When Squall Uno works, every click and key shows up here.') + '</div>'); return; }
      const t = Date.now();
      setHTML('.uno-feed', evs.slice(0, 200).map(e => {
        const r = feedRow(e, t);
        return '<div class="uno-ev ' + esc(r.cls) + (r.you ? ' you' : '') + (r.who === 'system' ? ' sys' : '') + '" style="--k:' + esc(r.color) + '"><span class="uno-ev-ic">' + svg(r.icon, 13) + '</span>' +
          '<span class="uno-ev-t">' + (r.you ? '<em class="uno-you">you</em>' : '') + esc(r.text) + '</span><span class="uno-ev-w" data-at="' + esc(String(e.at || '')) + '">' + esc(r.when) + '</span></div>';
      }).join(''));
    }

    function renderFeedTimes() {
      const t = Date.now();
      if (view) view.querySelectorAll('.uno-ev-w[data-at]').forEach(el => { const w = ago(+el.getAttribute('data-at'), t); if (el.textContent !== w) el.textContent = w; });
    }

    function renderRecent(cur, sess) {
      if (!available || !ui.loaded) { setHTML('.uno-recent', ''); return; }
      const list = sessionsFor(store, ui.agentId).slice(0, 12);
      if (!list.length) { setHTML('.uno-recent', '<div class="uno-none">No sessions yet.</div>'); return; }
      const t = Date.now();
      setHTML('.uno-recent', list.map(s => '<button class="uno-sess' + (sess && sess.id === s.id ? ' on' : '') + ' s-' + esc(s.state || '') + '" data-u="session" data-uv="' + esc(s.id) + '">' +
        '<span class="uno-sess-t">' + esc(clip(s.task || '(no task)', 80)) + '</span>' +
        '<span class="uno-sess-m"><i></i>' + esc(sessionLabel(s)) + (s.startedAt ? ' · ' + esc(ago(s.startedAt, t)) : '') + (cur && cur.id === s.id && isRunning(s) ? ' · now' : '') + '</span></button>').join(''));
    }

    function renderSettings() {
      const box = $u('.uno-settings');
      if (!box) return;
      box.hidden = !ui.settings || !available;
      if (box.hidden) return;
      const st = store.settings;
      const q = sel => box.querySelector(sel);
      const ks = q('.uno-key-st'); if (ks) { ks.textContent = keyText(st); ks.classList.toggle('bad', !!st && !st.hasKey); }
      const rm = q('[data-u="removeKey"]'); if (rm) rm.hidden = !(st && st.keySource === 'saved');
      const sv = q('[data-u="saveKey"]'); if (sv) sv.disabled = !!ui.busy.saveKey;
      const ck = q('[data-u="check"]'); if (ck) { ck.disabled = !!ui.busy.check; ck.textContent = ui.busy.check ? 'Checking…' : 'Check it works'; }
      const ct = q('.uno-check'); if (ct) { ct.hidden = !ui.checkText; ct.textContent = ui.checkText; }
      const sp = q('.uno-steps-v'); if (sp) sp.textContent = st && st.maxSteps ? String(st.maxSteps) : '–';
      const dk = q('.uno-docker'); if (dk) { dk.textContent = st ? (st.dockerText || (st.dockerReady ? 'Docker is running.' : 'Docker isn’t running.')) + (st.dockerReady && st.imageReady === false ? ' The computer picture gets built the first time (a few minutes, once).' : '') : 'Not checked yet.'; dk.classList.toggle('bad', !!st && !st.dockerReady); }
      const tk = q('.uno-tokens'); if (tk) tk.textContent = tokensText(st);
      const md = q('.uno-model'); if (md) md.textContent = st && st.model ? st.model : '–';
    }

    function flash(text) {
      ui.err = text || '';
      const fl = $u('.uno-flash');
      if (fl) { fl.hidden = !ui.err; fl.textContent = ui.err; fl.classList.remove('pop'); void fl.offsetWidth; fl.classList.add('pop'); }
      clearTimeout(flash.t);
      if (ui.err) flash.t = setTimeout(() => { ui.err = ''; const f = $u('.uno-flash'); if (f) f.hidden = true; }, 9000);
    }

    // ---------------- doing things ----------------

    async function run(name, fields, after) {
      if (ui.busy[name]) return null;
      ui.busy[name] = true; render();
      let res;
      try { res = await op(name, fields); }
      finally { ui.busy[name] = false; }
      if (!res.ok) flash(res.error);
      else {
        flash('');
        if (res.settings) store.settings = res.settings;
        if (after) after(res);
      }
      render();
      return res;
    }

    function input(action, extra) {
      const comp = watchedComputer();
      if (!comp) return;
      op('input', Object.assign({ computerId: comp.id, action }, extra || {})).then(r => { if (!r.ok) flash(r.error); });
    }

    function onClick(e) {
      const t = e.target;
      // a click on the screen while you have the wheel
      const box = t.closest('.uno-box');
      if (box && wheelOn() && !t.closest('.uno-empty:not([hidden])')) {
        const rect = box.getBoundingClientRect();
        const p = displayToScreen(e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height, ui.screenW, ui.screenH);
        if (p) { ui.localClickAt = Date.now(); ripple(p.x, p.y, true); input(ui.clickMode, { x: p.x, y: p.y }); }
        return;
      }
      const b = t.closest('[data-u]');
      if (!b || b.disabled) return;
      const what = b.getAttribute('data-u'), v = b.getAttribute('data-uv');
      const cur = currentSession(store, ui.agentId), sess = shownSession();
      const a = agentInfo();
      switch (what) {
        case 'close': close(); if (h.onClose) h.onClose(); break;
        case 'settings': ui.settings = !ui.settings; ui.checkText = ''; render(); if (ui.settings) refresh(); break;
        case 'mode': ui.clickMode = v || 'left_click'; render(); break;
        case 'type': { const inp = $u('.uno-type'); const text = inp ? inp.value : ''; if (!text) return; input('type', { text }); inp.value = ''; inp.focus(); break; }
        case 'key': input('key', { text: v }); break;
        case 'scroll': { const p = ui.cursor || { x: Math.round(ui.screenW / 2), y: Math.round(ui.screenH / 2) }; input('scroll', { x: p.x, y: p.y, direction: v === 'up' ? 'up' : 'down' }); break; }
        case 'handback': {
          if (cur && cur.state === 'you') { const nt = $u('.uno-note'); const note = nt ? nt.value.trim() : ''; run('handback', note ? { sessionId: cur.id, note } : { sessionId: cur.id }, () => { if (nt) nt.value = ''; }); }
          else { ui.wheelLocal = false; render(); }
          break;
        }
        case 'takeover': if (cur) run('takeover', { sessionId: cur.id }); break;
        case 'drive': ui.wheelLocal = true; render(); break;
        case 'stop': if (cur) run('stop', { sessionId: cur.id }); break;
        case 'stopAll': run('stopAll', {}, res => { if (res.stopped === 0) flash('Nothing was running.'); refresh(); }); break;
        case 'computerOff': {
          const comp = watchedComputer();
          if (comp && root.confirm && !root.confirm('Turn off ' + (comp.name || 'this computer') + '? What’s on it goes away. Its next task starts it fresh.')) return;
          if (comp) run('computerOff', { computerId: comp.id }, () => { delete store.frames[comp.id]; ui.wheelLocal = false; refresh(); });
          break;
        }
        case 'backNow': ui.viewSession = null; render(); break;
        case 'session': {
          ui.viewSession = cur && cur.id === v ? null : v;
          render();
          refresh(v);
          break;
        }
        case 'start': {
          const ta = $u('.uno-task-in');
          const task = ta ? ta.value.trim() : '';
          if (!task) { flash('Write what Squall Uno should do first.'); if (ta) ta.focus(); return; }
          run('start', { agentId: a.agentId, agentName: a.agentName, task }, res => {
            if (ta) ta.value = '';
            ui.viewSession = null; ui.wheelLocal = false;
            if (res.computerId) { ui.watching = null; setWatch(res.computerId); }
            refresh();
          });
          break;
        }
        case 'message': {
          const target = sess && cur && sess.id !== cur.id ? sess : cur;
          const mi = $u('.uno-msg-in');
          const text = mi ? mi.value.trim() : '';
          if (!target || !text) { if (mi) mi.focus(); return; }
          run('message', { sessionId: target.id, text }, () => { if (mi) mi.value = ''; ui.viewSession = null; refresh(); });
          break;
        }
        case 'saveKey': {
          const ki = $u('.uno-key-in');
          const key = ki ? ki.value.trim() : '';
          if (!key) { flash('Paste the key first.'); if (ki) ki.focus(); return; }
          if (ki) ki.value = '';   // the key never stays on the page
          run('saveKey', { key });
          break;
        }
        case 'removeKey':
          if (root.confirm && !root.confirm('Remove the saved API key from this PC? Squall Uno stops working until you add one again.')) return;
          run('removeKey', {});
          break;
        case 'check': ui.checkText = ''; run('check', {}, res => { ui.checkText = String(res.text || 'It works.'); }); break;
        case 'steps': {
          const cur2 = store.settings && store.settings.maxSteps ? +store.settings.maxSteps : 80;
          const next = clampSteps(cur2 + (+v || 0));
          if (next !== cur2) run('setMaxSteps', { value: next });
          break;
        }
      }
    }

    function onKey(e) {
      const t = e.target;
      if (e.key !== 'Enter' || e.isComposing) return;
      if (t.classList.contains('uno-type')) { e.preventDefault(); const b = $u('[data-u="type"]'); if (b) b.click(); }
      else if (t.classList.contains('uno-note')) { e.preventDefault(); const b = $u('[data-u="handback"]'); if (b) b.click(); }
      else if (t.classList.contains('uno-msg-in')) { e.preventDefault(); const b = $u('[data-u="message"]'); if (b) b.click(); }
      else if (t.classList.contains('uno-key-in')) { e.preventDefault(); const b = $u('[data-u="saveKey"]'); if (b) b.click(); }
      else if (t.classList.contains('uno-task-in') && !e.shiftKey) { e.preventDefault(); const b = $u('[data-u="start"]'); if (b) b.click(); }
    }

    let wheelAt = 0;
    function onWheel(e) {
      const box = e.target.closest && e.target.closest('.uno-box');
      if (!box || !wheelOn()) return;
      e.preventDefault();
      if (Date.now() - wheelAt < 180) return;   // one scroll per flick, not dozens
      wheelAt = Date.now();
      const rect = box.getBoundingClientRect();
      const p = displayToScreen(e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height, ui.screenW, ui.screenH);
      if (p) input('scroll', { x: p.x, y: p.y, direction: e.deltaY < 0 ? 'up' : 'down' });
    }

    function onMove(e) {
      const box = e.target.closest && e.target.closest('.uno-box');
      if (!box || !wheelOn()) { if (ui.hover) { ui.hover = null; paintChip(); } return; }
      const rect = box.getBoundingClientRect();
      ui.hover = displayToScreen(e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height, ui.screenW, ui.screenH);
      paintChip();
    }

    // Esc leaves the settings, then the view (unless a text box or a dialog is in front)
    document.addEventListener('keydown', e => {
      if (!ui.open || e.key !== 'Escape') return;
      if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName || '')) return;
      if (document.querySelector('.modal-back, .qk-pop, .qk-back, .use-pop, .cx-pop, .mm-pop, .lightbox')) return;
      if (ui.settings) { ui.settings = false; render(); return; }
      close(); if (h.onClose) h.onClose();
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && ui.open) { paintFrame(); renderFeedTimes(); } });

    // first look
    if (available) refresh();

    const api = { sidebarHTML, open, close, isOpen: () => ui.open, refresh, store };
    root.SquallUnoUI = api;
    return api;
  }

  const api = {
    CHIEF, computerIdFor, agentsForUno, newStore, payloadOf, eventOf, addEvents, mergeState, takeEvent, takeFrame,
    computerOf, currentSession, sessionsFor, sessionEvents, isRunning, anyRunning, statusOf, sessionLabel, nowLine, ago,
    feedRow, isClick, framePct, cursorPct, displayToScreen, fitBox, clampSteps, keyText, tokensText, errorText, wire,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SquallUno = api;
})(typeof window !== 'undefined' ? window : globalThis);
