// Squall Uno in the Squall window: each agent's own computer, live.
//
// Squall Uno is Squall's computer-using agent (docs/squall-uno.md). Every Squall agent (Chief and each bot) has its own small
// Linux computer in Docker on this PC. This file is the window's half:
//   - a "Squall Uno" section in the left sidebar, under the team chats: one row per agent's computer, with a live dot;
//   - the Squall Uno view in the middle: the live screen (frames pushed by the host), what it is doing now, what it did,
//     a task box, Pause / Resume, Stop / Stop everything / Take the wheel, and Squall Uno's settings (API key, max steps, Docker).
// Everything shown comes from the host (ops through Bridge.call('link', { do: 'uno', op, ... }) and the pushes "uno",
// "unoState" and "unoFrame"). Nothing here is made up: when the host isn't there, the view says so.
// app.js calls SquallUno.wire(hooks) once; the pure parts are tested with Node in tests/web/uno.test.mjs.
(function (root) {
  'use strict';

  const CHIEF = 'chief';
  const MAX_EVENTS = 1500;          // kept in the window (all computers); the host keeps the rest
  const MAX_SESSIONS = 60;
  const STATE_PAGE = 300;           // the host answers at most 300 events per state call
  const RUNNING = ['starting', 'running', 'paused', 'you'];   // a paused task still holds its computer
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
  //   key: off | starting | live | paused | you | done | stopped | error | on
  //   live: the screen is moving (LIVE pill); dot: the sidebar's live dot (anything running)
  function statusOf(computer, session) {
    const cs = computer && computer.state ? computer.state : 'off';
    const ss = session ? session.state : '';
    const stateText = computer && computer.stateText ? String(computer.stateText) : '';
    const R = (key, label, detail) => ({ key, label, detail: detail || '', live: key === 'live' || key === 'you', dot: key === 'live' || key === 'you' || key === 'starting' });
    if (ss === 'you') return R('you', 'You have the wheel', 'Squall Uno is waiting. Hand it back when you’re done.');
    if (ss === 'paused') return Object.assign(R('paused', 'Paused', 'Squall Uno is waiting. Press Resume to let it carry on.'), { dot: true });
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
  const SESSION_WORDS = { starting: 'Starting…', running: 'Live', paused: 'Paused', you: 'You have the wheel', done: 'Done', stopped: 'Stopped', error: 'Error' };
  function sessionLabel(s) { return (s && SESSION_WORDS[s.state]) || 'Unknown'; }

  // Which of Pause / Resume a session's controls show: 'pause' (starting or running), 'resume' (paused), or null
  // (ended, or you have the wheel: hand it back first).
  function pauseAction(s) {
    if (!s) return null;
    if (s.state === 'paused') return 'resume';
    if (s.state === 'running' || s.state === 'starting') return 'pause';
    return null;
  }

  // The class of a computer's live dot: starting (amber), paused (still), else live (red, pulsing).
  function dotClass(st) { return st && (st.key === 'starting' || st.key === 'paused') ? st.key : 'live'; }

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
    pause: ['pause', '#7dd3fc'], resume: ['play', '#7dd3fc'],
    done: ['check', '#4ade80'], stopped: ['stop', '#f5b14a'], error: ['alert', '#f87171'],
  };
  const KIND_WORDS = {
    start: 'Started', screenshot: 'Looked at the screen', zoom: 'Zoomed in', click: 'Clicked', left_click: 'Clicked', double_click: 'Double-clicked',
    triple_click: 'Triple-clicked', right_click: 'Right-clicked', middle_click: 'Middle-clicked', mouse_down: 'Pressed the mouse', mouse_up: 'Let go of the mouse',
    move: 'Moved the mouse', cursor: 'Checked where the mouse is', drag: 'Dragged', type: 'Typed', key: 'Pressed a key', hold_key: 'Held a key', scroll: 'Scrolled',
    wait: 'Waited', say: 'Said something', message: 'Message', takeover: 'You took the wheel', handback: 'You handed it back', pause: 'Paused by you', resume: 'Resumed', done: 'Done', stopped: 'Stopped', error: 'Error',
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

  // ---------------------------------------------------------------- motion (what the live screen animates)
  // Only real events and frames move anything here: a glide to where the mouse really went, a ripple where it really
  // clicked, the text it really typed, the keys it really pressed. With "reduce motion" on, everything shows at once.

  const GLIDE_MS = 250;             // the cursor's glide to a new spot
  const DRAG_MS = 380;              // a drag's glide and trail
  const TICKER_MAX_MS = 1200;       // typed text always finishes within this
  const TICKER_CHAR_MS = 45;        // ...and short text types at this pace

  // Ease out (cubic): quick start, soft landing. t from 0 to 1.
  function easeOut(t) {
    const k = Math.max(0, Math.min(1, +t || 0));
    return 1 - Math.pow(1 - k, 3);
  }

  // Where a glide from `from` to `to` that began at `start` is at `now` (ms): { x, y, done }. No `from`: already there.
  function glideAt(from, to, start, now, ms) {
    if (!to) return null;
    const d = ms == null ? GLIDE_MS : +ms;
    if (!from || !(d > 0)) return { x: to.x, y: to.y, done: true };
    const t = (now - start) / d;
    if (!(t < 1)) return { x: to.x, y: to.y, done: true };
    const k = easeOut(t);
    return { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k, done: false };
  }

  // How fast typed text appears: { step: ms per character, total: ms }. Short text types at a steady pace;
  // long text speeds up so it always finishes within maxMs.
  function tickerTiming(length, maxMs, charMs) {
    const n = Math.max(0, Math.floor(+length || 0));
    const max = maxMs == null ? TICKER_MAX_MS : +maxMs, per = charMs == null ? TICKER_CHAR_MS : +charMs;
    if (!n || !(max > 0) || !(per > 0)) return { step: 0, total: 0 };
    const step = Math.min(per, max / n);
    return { step, total: step * n };
  }

  // How many characters of the typed text show `elapsed` ms after it starts (the first one right away).
  function tickerShown(length, elapsed, maxMs, charMs) {
    const n = Math.max(0, Math.floor(+length || 0));
    const t = tickerTiming(n, maxMs, charMs);
    if (!n) return 0;
    if (!(t.step > 0) || !(elapsed >= 0)) return elapsed >= 0 ? n : 1;
    return Math.max(1, Math.min(n, Math.floor(elapsed / t.step) + 1));
  }

  // What a "type" event typed: its text reads 'Typed "hello"'. '' when it can't tell (nothing is made up).
  function typedText(e) {
    if (!e || e.kind !== 'type') return '';
    const m = /^\s*Typ(?:ed|ing)\s+"([\s\S]*)"\s*$/.exec(String(e.text || ''));
    return m ? m[1] : '';
  }

  const KEY_NAMES = {
    ctrl: 'Ctrl', control: 'Ctrl', alt: 'Alt', option: 'Alt', shift: 'Shift', super: 'Win', meta: 'Win', win: 'Win', cmd: 'Win', command: 'Win',
    return: 'Enter', enter: 'Enter', kp_enter: 'Enter', escape: 'Esc', esc: 'Esc', backspace: 'Backspace', delete: 'Delete', del: 'Delete',
    tab: 'Tab', iso_left_tab: 'Tab', space: 'Space', up: '↑', down: '↓', left: '←', right: '→',
    page_up: 'Page Up', prior: 'Page Up', pageup: 'Page Up', page_down: 'Page Down', next: 'Page Down', pagedown: 'Page Down',
    home: 'Home', end: 'End', insert: 'Insert', caps_lock: 'Caps Lock', print: 'Print Screen', menu: 'Menu',
    minus: '-', plus: '+', equal: '=', period: '.', comma: ',', slash: '/', backslash: '\\', semicolon: ';', apostrophe: '\'',
    grave: '`', bracketleft: '[', bracketright: ']',
  };

  // One key or chord, the way it looks on a keyboard: "ctrl+l" -> "Ctrl + L", "Return" -> "Enter", "ctrl++" -> "Ctrl + +".
  function prettyKey(chord) {
    const s = String(chord == null ? '' : chord).trim();
    if (!s) return '';
    return s.split(/\+(?=.)/).map(part => {
      const raw = part.trim();
      if (!raw) return '+';
      const low = raw.toLowerCase();
      const name = KEY_NAMES[low] || KEY_NAMES[low.replace(/_[lr]$/, '')];
      if (name) return name;
      if (/^f\d{1,2}$/.test(low)) return raw.toUpperCase();
      if (raw.length === 1) return raw.toUpperCase();
      return raw.charAt(0).toUpperCase() + raw.slice(1);
    }).join(' + ');
  }

  // A row of keys pressed one after another ("ctrl+l Return", or "ctrl+l, Return" from the feed): "Ctrl + L, Enter".
  function prettyKeys(text) {
    return String(text == null ? '' : text).split(/[\s,]+/).filter(Boolean).map(prettyKey).join(', ');
  }

  // The keycap chip for a "key" or "hold_key" event, from its text ("Pressed ctrl+l, Return 2 times", "Held shift for
  // 1 second"): { keys: [["Ctrl", "L"], ["Enter"]], label: "Ctrl + L, Enter ×2", times, hold }, or null.
  function keyChip(e) {
    if (!e || (e.kind !== 'key' && e.kind !== 'hold_key')) return null;
    const text = String(e.text || '');
    let keys = '', times = 1;
    const hold = e.kind === 'hold_key';
    if (hold) {
      const m = /^\s*H(?:eld|olding)\s+(.+?)\s+for\s+/.exec(text);
      if (m) keys = m[1];
    } else {
      const m = /^\s*Press(?:ed|ing)\s+([\s\S]+?)(?:\s+(\d+)\s+times)?\s*$/.exec(text);
      if (m) { keys = m[1]; times = m[2] ? Math.max(1, +m[2]) : 1; }
    }
    const list = keys.split(/[\s,]+/).filter(k => k && k.indexOf('…') < 0).map(prettyKey).filter(Boolean);   // a key cut short by the feed is left out
    if (!list.length) return null;
    const label = list.join(', ') + (times > 1 ? ' ×' + times : '');
    return { keys: list.map(k => k.split(' + ')), label, times, hold };
  }

  // Which way a "scroll" event went, from its text ("Scrolled down 3 at (640, 400)"): up | down | left | right | ''.
  function scrollDir(e) {
    if (!e || e.kind !== 'scroll') return '';
    const m = /\b(up|down|left|right)\b/i.exec(String(e.text || ''));
    return m ? m[1].toLowerCase() : '';
  }

  // What the live screen shows for one real event, or null:
  //   { kind: 'click', at, count }      a ripple (count 2 or 3 for double and triple clicks), the cursor glides there
  //   { kind: 'move', to }              the cursor glides there
  //   { kind: 'drag', from, to }        a short trail, and the cursor glides along it
  //   { kind: 'type', text }            the typed text appears letter by letter near the cursor
  //   { kind: 'key', keys, label, … }   a keycap chip near the cursor
  //   { kind: 'scroll', dir, at }       an arrow at the spot (at null: where the cursor is)
  //   { kind: 'flash', box }            a camera flash on the screen's edge (a zoom also outlines what it looked at)
  function motionOf(e) {
    if (!isEvent(e)) return null;
    const pt = num(e.x) && num(e.y) ? { x: +e.x, y: +e.y } : null;
    const end = num(e.x2) && num(e.y2) ? { x: +e.x2, y: +e.y2 } : null;
    switch (e.kind) {
      case 'drag':
        if (pt && end) return { kind: 'drag', from: pt, to: end };
        return pt || end ? { kind: 'move', to: end || pt } : null;
      case 'move': case 'cursor': case 'mouse_down': case 'mouse_up':
        return pt ? { kind: 'move', to: pt } : null;
      case 'type': { const text = typedText(e); return text ? { kind: 'type', text } : null; }
      case 'key': case 'hold_key': { const k = keyChip(e); return k ? Object.assign({ kind: 'key' }, k) : null; }
      case 'scroll': { const dir = scrollDir(e); return dir ? { kind: 'scroll', dir, at: pt } : null; }
      case 'screenshot': return { kind: 'flash', box: null };
      case 'zoom':
        return { kind: 'flash', box: pt && end ? { x: Math.min(pt.x, end.x), y: Math.min(pt.y, end.y), w: Math.abs(end.x - pt.x), h: Math.abs(end.y - pt.y) } : null };
    }
    if (CLICK_KINDS.indexOf(e.kind) >= 0) return pt ? { kind: 'click', at: pt, count: e.kind === 'double_click' ? 2 : e.kind === 'triple_click' ? 3 : 1 } : null;
    return null;
  }

  // A drag's trail as a box-relative line: { left, top } (percent, where it starts), length (px) and angle (degrees),
  // for a box boxW × boxH px showing a width × height screen. Null when anything is missing.
  function trailGeom(from, to, width, height, boxW, boxH) {
    const a = from && framePct(from.x, from.y, width, height), b = to && framePct(to.x, to.y, width, height);
    if (!a || !b || !(boxW > 0) || !(boxH > 0)) return null;
    const dx = (b.left - a.left) / 100 * boxW, dy = (b.top - a.top) / 100 * boxH;
    return { left: a.left, top: a.top, length: Math.sqrt(dx * dx + dy * dy), angle: Math.atan2(dy, dx) * 180 / Math.PI };
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

  // ---------------------------------------------------------------- tokens (real counts from the host)
  //
  // No dollar price here on purpose: a session's inputTokens adds plain input, cache writes and cache reads together
  // (UnoHub.Run.cs), and those cost different amounts, so any price worked out from the total would be wrong.

  // A token count, short: 680, 1.2k, 12.3k, 123k, 1.2M
  function fmtTokens(n) {
    const v = Math.max(0, Math.round(+n || 0));
    if (v < 1000) return String(v);
    const one = x => (Number.isInteger(x) ? String(x) : x.toFixed(1));
    const k1 = Math.round(v / 100) / 10;
    if (k1 < 100) return one(k1) + 'k';
    const k0 = Math.round(v / 1000);
    if (k0 < 1000) return k0 + 'k';
    const m1 = Math.round(v / 100000) / 10;
    if (m1 < 100) return one(m1) + 'M';
    return Math.round(v / 1000000) + 'M';
  }

  // "12.3k tokens in · 680 out" for one session, or '' before it has used any
  function sessionTokensText(s) {
    const i = Math.max(0, +(s && s.inputTokens) || 0), o = Math.max(0, +(s && s.outputTokens) || 0);
    if (!i && !o) return '';
    return fmtTokens(i) + ' tokens in · ' + fmtTokens(o) + ' out';
  }

  // "Today: 124k tokens" for the Uno tab's header, or '' before the settings came
  function todayTokensText(st) {
    if (!st || typeof st !== 'object') return '';
    const t = st.tokensToday || {};
    const total = Math.max(0, +t.input || 0) + Math.max(0, +t.output || 0);
    return total ? 'Today: ' + fmtTokens(total) + ' tokens' : 'Today: no tokens yet';
  }

  // ---------------------------------------------------------------- starting a task from the Uno tab

  // The session running on an agent's computer right now, or null
  function runningOn(store, agentId) {
    const comp = computerOf(store, agentId);
    const cid = comp ? comp.id : computerIdFor(agentId);
    if (comp && comp.sessionId) { const s = store.sessions.find(x => x.id === comp.sessionId); if (isRunning(s)) return s; }
    return store.sessions.find(s => (s.computerId === cid || (!s.computerId && s.agentId === agentId)) && isRunning(s)) || null;
  }

  // Can a new task start on this agent's computer? { ok, kind: '' | 'busy' | 'key' | 'docker', why, sessionId }
  // st: the settings (null = not known yet: let the host decide); running: the session on that computer now.
  function quickStartCheck(st, running, agentName) {
    const who = String(agentName || '').trim() || 'This agent';
    if (isRunning(running)) return { ok: false, kind: 'busy', why: who + '’s computer is busy with a task. Tell it something instead, or stop it first.', sessionId: running.id || null };
    if (st && st.hasKey === false) return { ok: false, kind: 'key', why: 'Squall Uno needs an Anthropic API key first. Add it in Settings.', sessionId: null };
    if (st && st.dockerReady === false) return { ok: false, kind: 'docker', why: String(st.dockerText || '').trim() || 'Docker Desktop isn’t running on this PC yet.', sessionId: null };
    return { ok: true, kind: '', why: '', sessionId: null };
  }

  // The agent the picker has on: the one picked if it's still there, else Chief, else the first.
  function pickAgent(list, picked) {
    const l = Array.isArray(list) ? list : [];
    return l.find(a => a.agentId === picked) || l.find(a => a.agentId === CHIEF) || l[0] || null;
  }

  // "Run again" is for tasks that ended (done, stopped or error) and had words
  function canRunAgain(s) {
    return !!s && ['done', 'stopped', 'error'].indexOf(s.state) >= 0 && !!String(s.task || '').trim();
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
    pause: '<rect x="6.5" y="5" width="4" height="14" rx="1.2" fill="currentColor" stroke="none"/><rect x="13.5" y="5" width="4" height="14" rx="1.2" fill="currentColor" stroke="none"/>',
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
    download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  };
  const svg = (name, size) => name === 'bolt' ? ICONS.bolt : '<svg viewBox="0 0 24 24" width="' + (size || 14) + '" height="' + (size || 14) + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + (ICONS[name] || ICONS.dot) + '</svg>';
  const CURSOR_SVG = '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M4 2.5 4 19l4.4-4.2 2.9 6.7 2.6-1.1-2.9-6.6H17z" fill="#fff" stroke="#0b0a12" stroke-width="1.4" stroke-linejoin="round"/></svg>';

  // ---------------- replay pictures (the filmstrip) ----------------

  const MAX_SHOTS = 200;
  const isShot = x => !!x && typeof x === 'object' && Number.isFinite(+x.id) && typeof x.sessionId === 'string';
  /** Merges shots (no pictures) into a session's list: by id, oldest first, the newest MAX_SHOTS kept. */
  function addShots(list, incoming) {
    const by = new Map((list || []).map(x => [+x.id, x]));
    (Array.isArray(incoming) ? incoming : [incoming]).filter(isShot).forEach(x => by.set(+x.id, x));
    const out = Array.from(by.values()).sort((a, b) => +a.id - +b.id);
    return out.length > MAX_SHOTS ? out.slice(out.length - MAX_SHOTS) : out;
  }
  /** The shot delta steps away from id (clamped to the ends); the first one when id isn't in the list. */
  function shotNeighbor(list, id, delta) {
    if (!list || !list.length) return null;
    const i = list.findIndex(x => +x.id === +id);
    if (i < 0) return list[delta < 0 ? list.length - 1 : 0];
    return list[Math.max(0, Math.min(list.length - 1, i + (delta || 0)))];
  }
  /** "Step 7 · Clicked at (412, 230)" */
  function shotLabel(shot) {
    if (!shot) return '';
    const text = String(shot.text || '').replace(/\s+/g, ' ').trim();
    return (num(shot.step) && +shot.step > 0 ? 'Step ' + (+shot.step) : 'Start') + (text ? ' · ' + text : '');
  }

  // ---------------- saving a replay as an animated GIF (web/gif.js makes it, in the page) ----------------

  const GIF_MAX_W = 800, GIF_CAPTION_H = 30, GIF_STEP_MS = 900, GIF_LAST_MS = 2500;
  /** The GIF's size for a width × height screen: at most 800 px wide, the picture keeping its shape, a caption strip under it. */
  function gifFrameSize(width, height) {
    const w0 = +width > 0 ? +width : 1280, h0 = +height > 0 ? +height : 800;
    const w = Math.max(2, Math.min(GIF_MAX_W, Math.round(w0)));
    const picH = Math.max(2, Math.round(h0 * w / w0));
    return { w, picH, h: picH + GIF_CAPTION_H, caption: GIF_CAPTION_H };
  }
  /** "squall-uno-nova-2026-11-25-0905.gif": whose computer, and when the task started (local time; now if not known). */
  function gifFileName(agentName, at) {
    const who = String(agentName || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'agent';
    const d = new Date(num(at) && +at > 0 ? +at : Date.now());
    const p = n => String(n).padStart(2, '0');
    return 'squall-uno-' + who + '-' + d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + '.gif';
  }

  // Shortens text with … until it fits in maxW pixels (g: a canvas 2D context).
  function fitText(g, text, maxW) {
    if (g.measureText(text).width <= maxW) return text;
    let lo = 0, hi = text.length;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (g.measureText(text.slice(0, mid).trimEnd() + '…').width <= maxW) lo = mid; else hi = mid - 1; }
    return text.slice(0, lo).trimEnd() + '…';
  }

  // One GIF frame on g: the step's picture (fitted, letterboxed if its size differs), the ring where the pointer was
  // (as in the replay), and the caption strip: shotLabel(shot) on the left, "4 of 12" on the right.
  function drawGifFrame(g, size, img, shot, at, total) {
    g.fillStyle = '#0b0a12';
    g.fillRect(0, 0, size.w, size.h);
    const iw = img.naturalWidth, ih = img.naturalHeight;
    const fit = fitBox(size.w, size.picH, iw, ih);
    const ox = Math.floor((size.w - fit.w) / 2), oy = Math.floor((size.picH - fit.h) / 2);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, ox, oy, fit.w, fit.h);
    const p = num(shot.cursorX) && num(shot.cursorY) ? framePct(+shot.cursorX, +shot.cursorY, +shot.width || iw, +shot.height || ih) : null;
    if (p) {
      g.beginPath();
      g.arc(ox + p.left / 100 * fit.w, oy + p.top / 100 * fit.h, 8, 0, Math.PI * 2);
      g.lineWidth = 2.5;
      g.strokeStyle = '#5fb2ff';
      g.stroke();
    }
    g.fillStyle = '#16141f';
    g.fillRect(0, size.picH, size.w, size.caption);
    g.textBaseline = 'middle';
    const y = size.picH + size.caption / 2 + 0.5;
    g.font = '500 12px "Segoe UI", system-ui, sans-serif';
    const count = at + ' of ' + total;
    const countW = g.measureText(count).width;
    g.fillStyle = '#a9adc0';
    g.textAlign = 'right';
    g.fillText(count, size.w - 12, y);
    g.font = '600 13px "Segoe UI", system-ui, sans-serif';
    g.fillStyle = '#eceaf6';
    g.textAlign = 'left';
    g.fillText(fitText(g, shotLabel(shot), size.w - 36 - countW), 12, y);
  }

  /**
   * A task's replay as an animated GIF: one frame per shot whose picture is still kept, 0.9 s each and the last 2.5 s,
   * looping. io: { Gif (web/gif.js), canvas, picOf(shot) -> base64 JPEG or null, loadPic(base64) -> a loaded image or
   * null, progress(done, total), pause() (lets the window draw) }. Answers { bytes (null when no picture was kept),
   * frames, missing, width, height }.
   */
  async function makeReplayGif(shots, io) {
    const list = Array.isArray(shots) ? shots : [];
    const g = io.canvas.getContext('2d', { willReadFrequently: true });
    let gif = null, size = null, pending = null, frames = 0, missing = 0;
    for (let i = 0; i < list.length; i++) {
      const shot = list[i];
      const pic = await io.picOf(shot);
      const img = pic ? await io.loadPic(pic) : null;
      if (!img) missing++;
      else {
        if (!size) {
          size = gifFrameSize(img.naturalWidth, img.naturalHeight);
          io.canvas.width = size.w;
          io.canvas.height = size.h;
          gif = io.Gif.createGif(size.w, size.h, { loop: 0 });
        }
        drawGifFrame(g, size, img, shot, i + 1, list.length);
        // each frame waits for the next one, so the last can be held longer
        if (pending) gif.addFrame(pending, GIF_STEP_MS);
        pending = g.getImageData(0, 0, size.w, size.h).data;
        frames++;
      }
      if (io.progress) io.progress(i + 1, list.length);
      if (io.pause) await io.pause();
    }
    if (!pending) return { bytes: null, frames: 0, missing, width: 0, height: 0 };
    gif.addFrame(pending, GIF_LAST_MS);
    return { bytes: gif.finish(), frames, missing, width: size.w, height: size.h };
  }

  function wire(h) {
    if (!h || !h.Bridge || typeof document === 'undefined') return null;
    const Bridge = h.Bridge, S = h.S || {};
    const esc = h.esc || (s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]));
    const available = !!Bridge.host;
    const store = newStore();
    const film = { lists: {}, loaded: {}, loading: {}, pics: new Map(), asked: new Set(), replay: null, playing: 0, sessionId: null, saving: null, savedAt: 0 };
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
    Bridge.on('unoShot', m => onShot(m));
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
      // the screen shows what it just did: the cursor glides, clicks ripple, typing and keys show up near the cursor
      if (here) animate(fresh);
      // a session's last word changes the state too: ask once, quietly
      if (/^(done|stopped|error|takeover|handback|pause|resume|start)$/.test(fresh.kind)) setTimeout(() => refresh(), 250);
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
          (st && st.dot ? '<i class="uno-dot ' + dotClass(st) + '"></i>' : '') + '</button>';
      }).join('');
      return '<div class="uno-side" data-k="uno-side"><div class="uno-side-head" data-k="uno-side-head"><span class="uno-side-bolt">' + ICONS.bolt + '</span>Squall Uno' +
        (live ? '<span class="uno-side-live"><i></i>' + live + ' live</span>' : '') + '</div>' + rows + '</div>';
    }

    // ---------------- the Uno tab in the right pane: every computer at a glance ----------------

    // pane: the Uno tab's own state. text/agentId: the "New task" box (kept here so a redraw never loses what you typed);
    // qsErr: why the last Start or "Tell it" didn't work (stays until you try again or change the text).
    const pane = { stopping: false, err: '', text: '', agentId: null, starting: false, telling: false, qsErr: '', again: {} };

    function paneHead(n) {
      const st = store.settings;
      const today = available && ui.loaded ? todayTokensText(st) : '';
      return '<div class="uno-pane-head" data-k="uno-pane-head"><span class="uno-side-bolt">' + ICONS.bolt + '</span><b>Squall Uno</b>' +
        (n ? '<span class="uno-side-live"><i></i>' + n + ' live</span>' : '') +
        (today ? '<span class="uno-pane-today" title="' + esc('Tokens Squall Uno used today: ' + tokensText(st)) + '">' + esc(today) + '</span>' : '') +
        (available ? '<button class="uno-pane-gear" data-uno-pane="settings" title="Squall Uno settings: API key, steps, Docker">Settings</button>' : '') + '</div>';
    }

    // The "New task" box at the top of the Uno tab: what to do, whose computer, Start.
    // It always sits right under the header and the text box comes first in it, so a redraw keeps the box you type in.
    function quickStartHTML(list) {
      const a = pickAgent(list, pane.agentId);
      const running = a ? runningOn(store, a.agentId) : null;
      const chk = a ? quickStartCheck(store.settings, running, a.agentName) : { ok: false, kind: 'none', why: 'Squall has no agents to give a task to yet.' };
      const chips = list.map(x => {
        const busy = runningOn(store, x.agentId);
        const on = a && x.agentId === a.agentId;
        return '<button class="uno-qs-chip' + (on ? ' on' : '') + (busy ? ' busy' : '') + '" data-k="uno-qs-chip:' + esc(x.agentId) + '" data-uno-pane="pick" data-agent="' + esc(x.agentId) + '" role="radio" aria-checked="' + (on ? 'true' : 'false') + '"' +
          ' title="' + esc(x.agentName + '’s computer' + (busy ? ' · busy: ' + (busy.task || 'a task') : ' · free')) + '">' +
          iconFor(x) + '<span>' + esc(x.agentName) + '</span>' + (busy ? '<i class="uno-dot ' + (busy.state === 'starting' ? 'starting' : 'live') + '"></i><em>busy</em>' : '') + '</button>';
      }).join('');
      const starting = pane.starting, telling = pane.telling;
      let btns = '<button class="uno-btn primary" data-k="uno-qs-start" data-uno-pane="qsStart"' + (!chk.ok || starting ? ' disabled' : '') + (chk.why ? ' title="' + esc(chk.why) + '"' : '') + '>' + (starting ? 'Starting…' : 'Start') + '</button>';
      if (chk.kind === 'busy') btns += '<button class="uno-btn" data-k="uno-qs-tell" data-uno-pane="qsTell"' + (telling ? ' disabled' : '') + ' title="Sends this to the task that’s running, before its next step">' + (telling ? 'Sending…' : 'Tell it instead') + '</button>';
      if (chk.kind === 'key') btns += '<button class="uno-btn quiet" data-k="uno-qs-key" data-uno-pane="settings">Open Settings</button>';
      return '<div class="uno-qs" data-k="uno-qs">' +
        '<input class="uno-in uno-qs-in" data-k="uno-qs-in" type="text" placeholder="What should it do?" aria-label="What should it do?" maxlength="4000" spellcheck="true" autocomplete="off" value="' + esc(pane.text) + '">' +
        '<div class="uno-qs-chips" data-k="uno-qs-chips" role="radiogroup" aria-label="Whose computer">' + chips + '</div>' +
        '<div class="uno-qs-row" data-k="uno-qs-row">' + btns + '</div>' +
        (chk.why ? '<div class="uno-qs-why" data-k="uno-qs-why">' + esc(chk.why) + '</div>' : '') +
        (pane.qsErr ? '<div class="uno-pane-err" data-k="uno-qs-err">' + esc(pane.qsErr) + '</div>' : '') +
        '</div>';
    }

    // One "Recent tasks" row: open the computer, the tokens it used, and Run again once it ended
    function recentRowHTML(r, now) {
      const toks = sessionTokensText(r);
      let again = '';
      if (canRunAgain(r)) {
        const chk = quickStartCheck(store.settings, runningOn(store, r.agentId), r.agentName);
        const busy = !!pane.again[r.id];
        again = '<button class="uno-btn uno-prow-again" data-k="uno-again:' + esc(r.id) + '" data-uno-pane="again" data-sid="' + esc(r.id) + '"' + (!chk.ok || busy ? ' disabled' : '') +
          ' title="' + esc(chk.ok ? 'Starts “' + clip(r.task, 60) + '” again on ' + (r.agentName || 'the same') + '’s computer' : chk.why) + '">' + (busy ? 'Starting…' : 'Run again') + '</button>';
      }
      return '<div class="uno-prow s-' + esc(r.state) + '" data-k="uno-prow:' + esc(r.id) + '">' +
        '<button class="uno-prow-open" data-uno-open="' + esc(r.agentId) + '" title="Open ' + esc(r.agentName || 'that') + '’s computer">' +
        '<span class="uno-prow-task">' + esc(r.task || 'A task') + '</span><span class="uno-prow-meta">' + esc((r.agentName || '') + ' · ' + sessionLabel(r) + (r.startedAt ? ' · ' + ago(+r.startedAt, now) : '')) + '</span>' +
        (toks ? '<span class="uno-prow-tok">' + esc(toks) + '</span>' : '') + '</button>' + again + '</div>';
    }

    function paneHTML() {
      if (!available) return '<div class="uno-pane" data-k="uno-pane">' + paneHead(0) + '<div class="uno-pane-note" data-k="uno-pane-note">Squall Uno needs the Squall app on this PC.</div></div>';
      if (!ui.loaded) return '<div class="uno-pane" data-k="uno-pane">' + paneHead(0) + '<div class="uno-pane-note" data-k="uno-pane-note">' + esc(ui.missing || 'Asking Squall Uno…') + '</div></div>';
      const list = agents(), now = Date.now();
      let live = 0;
      const cards = list.map(a => {
        const comp = computerOf(store, a.agentId), sess = currentSession(store, a.agentId);
        const st = statusOf(comp, sess);
        if (st.dot) live++;
        const line = sess && isRunning(sess) ? nowLine(sess) : st.detail;
        return '<button class="uno-pcard' + (st.dot ? ' live' : '') + ' s-' + st.key + '" data-k="uno-pcard:' + esc(a.agentId) + '" data-uno-open="' + esc(a.agentId) + '" title="Open ' + esc(a.agentName) + '’s computer">' +
          iconFor(a, true) + '<span class="uno-pcard-t"><span class="uno-pcard-nm">' + esc(a.agentName) + '’s computer</span>' +
          '<span class="uno-pcard-st">' + esc(st.label) + (sess && isRunning(sess) && sess.steps ? ' · step ' + esc(sess.steps) : '') + '</span>' +
          (line ? '<span class="uno-pcard-now">' + esc(line) + '</span>' : '') + '</span>' +
          (st.dot ? '<i class="uno-dot ' + dotClass(st) + '"></i>' : '') + '</button>';
      }).join('');
      const s = store.settings || null;
      let hints = '';
      if (s && s.hasKey === false) hints += '<button class="uno-pane-hint" data-k="uno-hint-key" data-uno-pane="settings">Squall Uno needs an Anthropic API key first. Click to add it in Settings.</button>';
      if (s && s.dockerReady === false) hints += '<div class="uno-pane-hint" data-k="uno-hint-docker">' + esc(s.dockerText || 'Squall Uno needs Docker Desktop running on this PC.') + '</div>';
      const stopAll = anyRunning(store)
        ? '<button class="uno-btn danger uno-pane-stop" data-k="uno-pane-stop" data-uno-pane="stopAll"' + (pane.stopping ? ' disabled' : '') + ' title="Stops every Squall Uno task on every computer">' + (pane.stopping ? 'Stopping everything…' : 'Stop everything') + '</button>' : '';
      const recent = store.sessions.slice().sort((x, y) => (+y.startedAt || 0) - (+x.startedAt || 0)).slice(0, 8);
      const rec = recent.length
        ? recent.map(r => recentRowHTML(r, now)).join('')
        : '<div class="uno-pane-note" data-k="uno-rec-none">No tasks yet. Write one above and press Start.</div>';
      return '<div class="uno-pane" data-k="uno-pane">' + paneHead(live) + quickStartHTML(list) +
        (pane.err ? '<div class="uno-pane-err" data-k="uno-pane-err">' + esc(pane.err) + '</div>' : '') + hints + stopAll +
        '<div class="uno-pane-sec" data-k="uno-sec-pcs">Computers</div><div class="uno-pcards" data-k="uno-pcards">' + cards + '</div>' +
        '<div class="uno-pane-sec" data-k="uno-sec-rec">Recent tasks</div><div class="uno-prows" data-k="uno-prows">' + rec + '</div></div>';
    }

    // Starts a task from the Uno tab, then opens that agent's live view so you watch it right away.
    // Gives back the plain error, or '' when it started.
    async function startFromPane(agentId, agentName, task) {
      const res = await op('start', { agentId, agentName, task });
      if (!res.ok) return res.error || 'That didn’t start.';
      open(agentId);
      ui.viewSession = null; ui.wheelLocal = false;
      if (res.computerId) { ui.watching = null; setWatch(res.computerId); }
      refresh();
      return '';
    }

    function qsText() {
      // what's in the box right now (the page's own copy wins over the last one we saw)
      const el = document.querySelector && document.querySelector('.uno-qs-in');
      if (el && typeof el.value === 'string') pane.text = el.value;
      return String(pane.text || '').trim();
    }

    function qsFocus() { const el = document.querySelector && document.querySelector('.uno-qs-in'); if (el && el.focus) el.focus(); }

    async function paneDo(what, el) {
      if (what === 'settings') {
        const first = agents()[0];
        open(ui.agentId || (first ? first.agentId : CHIEF));
        ui.settings = true; render();
        return;
      }
      if (what === 'stopAll' && !pane.stopping) {
        pane.stopping = true; pane.err = ''; paneChanged();
        const res = await op('stopAll', {});
        pane.stopping = false;
        pane.err = res.ok ? (res.stopped === 0 ? 'Nothing was running.' : '') : res.error;
        if (pane.err) setTimeout(() => { pane.err = ''; paneChanged(); }, 6000);
        refresh();
        return;
      }
      if (what === 'pick') {
        const id = el && el.getAttribute ? el.getAttribute('data-agent') : null;
        if (id && id !== pane.agentId) { pane.agentId = id; pane.qsErr = ''; paneChanged(); }
        qsFocus();
        return;
      }
      if (what === 'qsStart' || what === 'qsTell') {
        if (pane.starting || pane.telling) return;
        const a = pickAgent(agents(), pane.agentId);
        const task = qsText();
        if (!a) { pane.qsErr = 'Squall has no agents to give a task to yet.'; paneChanged(); return; }
        if (!task) { pane.qsErr = 'Write what it should do first.'; paneChanged(); qsFocus(); return; }
        const running = runningOn(store, a.agentId);
        const chk = quickStartCheck(store.settings, running, a.agentName);
        if (what === 'qsTell') {
          if (chk.kind !== 'busy' || !chk.sessionId) { pane.qsErr = a.agentName + '’s computer isn’t running a task right now. Press Start instead.'; paneChanged(); return; }
          pane.telling = true; pane.qsErr = ''; paneChanged();
          const res = await op('message', { sessionId: chk.sessionId, text: task });
          pane.telling = false;
          if (!res.ok) pane.qsErr = res.error;
          else { pane.text = ''; open(a.agentId); refresh(); }
          paneChanged();
          return;
        }
        if (!chk.ok) { pane.qsErr = chk.why; paneChanged(); return; }
        pane.starting = true; pane.qsErr = ''; paneChanged();
        const err = await startFromPane(a.agentId, a.agentName, task);
        pane.starting = false;
        if (err) pane.qsErr = err;   // the text stays so you can try again
        else pane.text = '';
        paneChanged();
        return;
      }
      if (what === 'again') {
        const sid = el && el.getAttribute ? el.getAttribute('data-sid') : null;
        const s = sid ? store.sessions.find(x => x.id === sid) : null;
        if (!s || !canRunAgain(s) || pane.again[sid]) return;
        const known = agents().find(x => x.agentId === s.agentId);
        const name = (known && known.agentName) || s.agentName || s.agentId;
        const chk = quickStartCheck(store.settings, runningOn(store, s.agentId), name);
        if (!chk.ok) { pane.err = chk.why; paneChanged(); setTimeout(() => { pane.err = ''; paneChanged(); }, 6000); return; }
        pane.again[sid] = true; pane.err = ''; paneChanged();
        const err = await startFromPane(s.agentId, name, String(s.task).trim());
        delete pane.again[sid];
        if (err) { pane.err = err; setTimeout(() => { pane.err = ''; paneChanged(); }, 9000); }
        paneChanged();
      }
    }
    function paneChanged() { if (h.renderPaneSoon) h.renderPaneSoon(); }

    document.addEventListener('click', e => {
      const t = e.target && e.target.closest ? e.target : null;
      if (!t) return;
      const pd = t.closest('[data-uno-pane]');
      if (pd) { if (!pd.disabled) paneDo(pd.getAttribute('data-uno-pane'), pd); return; }
      const row = t.closest('[data-uno-open]');
      if (row) { open(row.getAttribute('data-uno-open')); }
    });
    // the "New task" box: remember what's typed (redraws keep it), Enter presses Start (or "Tell it instead" when busy)
    document.addEventListener('input', e => {
      const t = e.target;
      if (!t || !t.classList || !t.classList.contains('uno-qs-in')) return;
      pane.text = t.value;
      if (pane.qsErr) { pane.qsErr = ''; paneChanged(); }
    });
    document.addEventListener('keydown', e => {
      const t = e.target;
      if (!t || !t.classList || !t.classList.contains('uno-qs-in') || e.key !== 'Enter' || e.isComposing) return;
      e.preventDefault();
      const box = t.closest ? t.closest('.uno-qs') : null;
      const start = box && box.querySelector('[data-uno-pane="qsStart"]');
      const tell = box && box.querySelector('[data-uno-pane="qsTell"]');
      if (start && !start.disabled) paneDo('qsStart', start);
      else if (tell && !tell.disabled) paneDo('qsTell', tell);
      else paneDo('qsStart', start);
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
    function changed() { if (h.renderTeamSoon) h.renderTeamSoon(); if (h.renderPaneSoon) h.renderPaneSoon(); if (ui.open) render(); }
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
        '<div class="uno-sub s-' + esc(available && ui.loaded ? st.key : 'off') + '">' + esc(sub) + '</div>' + headTokensHTML(sess) + '</div>' +
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
      const nowEl = $u('.uno-now'); if (nowEl) { nowEl.classList.toggle('live', isRunning(sess) && !past && sess.state !== 'paused'); nowEl.classList.toggle('paused', !!sess && sess.state === 'paused' && !past); nowEl.hidden = !available; }

      // the buttons
      const running = isRunning(cur);
      const anyRun = store.sessions.some(isRunning);
      const b = ui.busy;
      let ctrls = '';
      if (available && ui.loaded) {
        if (running && cur.state !== 'you') ctrls += '<button class="uno-btn wheel" data-u="takeover"' + (b.takeover ? ' disabled' : '') + '>' + svg('hand') + 'Take the wheel</button>';
        if (!running && comp && comp.state === 'on' && !ui.wheelLocal) ctrls += '<button class="uno-btn" data-u="drive">' + svg('hand') + 'Use it yourself</button>';
        const pa = pauseAction(cur);
        if (pa === 'pause') ctrls += '<button class="uno-btn" data-u="pause"' + (b.pause ? ' disabled' : '') + ' title="Lets the step it is on finish, then waits (Space)">' + svg('pause') + 'Pause</button>';
        if (pa === 'resume') ctrls += '<button class="uno-btn resume" data-u="resume"' + (b.resume ? ' disabled' : '') + ' title="Lets Squall Uno carry on (Space)">' + svg('play') + 'Resume</button>';
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
      renderFilm(sess);
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
      if (html && view) view.querySelectorAll('.uno-box .uno-img').forEach(im => { im.hidden = true; });
    }

    function paintFrame() {
      const comp = watchedComputer();
      const frame = comp ? store.frames[comp.id] : null;
      const list = screenImgs();
      if (!list.length) return;
      if (!frame || !comp || comp.state === 'off') {
        for (const im of list) { if (im.getAttribute('src')) im.removeAttribute('src'); im.hidden = true; im.classList.remove('top', 'fading', 'in'); }
        fade.token++;
        const c = $u('.uno-cursor'); if (c) c.hidden = true;
        return;
      }
      if (frame.width && frame.height && (frame.width !== ui.screenW || frame.height !== ui.screenH)) { ui.screenW = frame.width; ui.screenH = frame.height; layoutScreen(); }
      const front = list[fade.front] || list[0];
      if (ui.shownSeq !== frame.seq || !front.getAttribute('src')) {
        ui.shownSeq = frame.seq;
        showJpeg(list, 'data:image/jpeg;base64,' + frame.jpeg);
      }
      for (const im of list) im.hidden = !im.getAttribute('src');
      paintEmpty(comp, statusOf(comp, currentSession(store, ui.agentId)));
      // a frame grabbed just before the newest event can still show the mouse where it was: don't glide back for it
      if (frame.cursorX != null && frame.cursorY != null && !(Date.now() - glide.eventAt < 350)) moveCursor(+frame.cursorX, +frame.cursorY);
    }

    // ---------------- motion on the live screen (only from real events and frames) ----------------

    const tnow = () => (root.performance && typeof root.performance.now === 'function' ? root.performance.now() : Date.now());
    const raf = f => (typeof root.requestAnimationFrame === 'function' ? root.requestAnimationFrame(f) : setTimeout(() => f(tnow()), 16));
    const unraf = id => { if (!id) return; if (typeof root.cancelAnimationFrame === 'function') root.cancelAnimationFrame(id); else clearTimeout(id); };
    function reduced() {
      try { return !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; }
    }

    // The layer the effects live in, and a second picture for the crossfade. Added once per view, inside the screen box.
    function ensureFx() {
      const box = $u('.uno-box');
      if (!box) return null;
      let fx = box.querySelector('.uno-fx');
      if (fx) return fx;
      const img = box.querySelector('.uno-img');
      if (img && box.querySelectorAll('.uno-img').length < 2) {
        const b = document.createElement('img');
        b.className = 'uno-img'; b.alt = ''; b.draggable = false; b.hidden = true;
        img.insertAdjacentElement('afterend', b);
      }
      fade.front = 0; fade.token++;
      fx = document.createElement('div');
      fx.className = 'uno-fx';
      fx.setAttribute('aria-hidden', 'true');
      fx.innerHTML = '<div class="uno-camflash"></div><div class="uno-bubble uno-typing" hidden></div><div class="uno-bubble uno-keycap" hidden></div>';
      box.appendChild(fx);
      return fx;
    }
    function screenImgs() { ensureFx(); return view ? Array.from(view.querySelectorAll('.uno-box .uno-img')) : []; }

    // New frames fade in over the old one (two stacked pictures take turns), unless motion is reduced.
    const fade = { front: 0, token: 0 };
    function showJpeg(list, src) {
      const front = list[fade.front] || list[0];
      const back = list.length > 1 ? list[1 - fade.front] : null;
      fade.token++;
      if (!back || reduced() || !front.getAttribute('src') || front.hidden) {
        front.src = src; front.hidden = false;
        front.classList.remove('fading', 'in'); front.classList.add('top');
        if (back) { back.classList.remove('top', 'fading', 'in'); if (back.getAttribute('src')) back.removeAttribute('src'); back.hidden = true; }
        return;
      }
      const token = fade.token;
      back.classList.remove('in');
      back.classList.add('top', 'fading');
      back.src = src;
      back.hidden = false;
      const go = () => {
        if (token !== fade.token) return;
        front.classList.remove('top');
        void back.offsetWidth;
        back.classList.add('in');
        fade.front = list.indexOf(back);
      };
      if (typeof back.decode === 'function') back.decode().then(go, go); else go();
    }

    // The cursor glides (eased, ~250 ms) to each new real position.
    const glide = { from: null, to: null, at: null, start: 0, ms: GLIDE_MS, raf: 0, eventAt: 0 };
    function placeCursor(c, pt) {
      const p = framePct(pt.x, pt.y, ui.screenW, ui.screenH);
      if (!p) return;
      c.style.left = p.left + '%'; c.style.top = p.top + '%';
    }
    function moveCursor(x, y, ms, from) {
      const c = $u('.uno-cursor');
      if (!c) return;
      if (!framePct(x, y, ui.screenW, ui.screenH)) { c.hidden = true; glide.at = null; return; }
      const to = { x: +x, y: +y };
      ui.cursor = { x: Math.round(to.x), y: Math.round(to.y) };
      paintChip();
      if (from && !c.hidden) { glide.at = { x: +from.x, y: +from.y }; placeCursor(c, glide.at); }   // a drag glides from where it started
      else if (!c.hidden && glide.to && glide.to.x === to.x && glide.to.y === to.y) return;          // already there or on its way
      if (c.hidden || !glide.at || reduced()) {
        unraf(glide.raf); glide.raf = 0;
        glide.from = null; glide.to = to; glide.at = to;
        placeCursor(c, to);
        c.hidden = false;
        return;
      }
      glide.from = { x: glide.at.x, y: glide.at.y }; glide.to = to; glide.start = tnow(); glide.ms = ms || GLIDE_MS;
      c.hidden = false;
      if (!glide.raf) glide.raf = raf(stepCursor);
    }
    function stepCursor() {
      glide.raf = 0;
      const c = $u('.uno-cursor');
      if (!c || !glide.to) return;
      const p = glideAt(glide.from, glide.to, glide.start, tnow(), glide.ms);
      glide.at = { x: p.x, y: p.y };
      placeCursor(c, glide.at);
      if (!p.done) glide.raf = raf(stepCursor);
    }
    // Where effects that follow the cursor go: where it is heading, else where it is.
    const cursorSpot = () => glide.to || glide.at || (ui.cursor ? { x: ui.cursor.x, y: ui.cursor.y } : null);

    // One real event, drawn on the screen.
    function animate(e) {
      const m = motionOf(e);
      if (!m) return;
      const mine = e.who === 'you';
      if (m.kind === 'click' || m.kind === 'move' || m.kind === 'drag') glide.eventAt = Date.now();
      switch (m.kind) {
        case 'click':
          // your own clicks from this window already rippled when you clicked
          if (!(mine && Date.now() - ui.localClickAt < 4000)) { ripple(m.at.x, m.at.y, mine); if (m.count > 1) setTimeout(() => ripple(m.at.x, m.at.y, mine), 140); }
          moveCursor(m.at.x, m.at.y);
          break;
        case 'move': moveCursor(m.to.x, m.to.y); break;
        case 'drag': trail(m.from, m.to, mine); moveCursor(m.to.x, m.to.y, DRAG_MS, m.from); break;
        case 'type': typeTicker(m.text); break;
        case 'key': keycap(m); break;
        case 'scroll': scrollArrow(m.dir, m.at || cursorSpot()); break;
        case 'flash': camFlash(m.box); break;
      }
    }

    // Puts a bubble next to a point on the screen, flipped so it stays inside the picture.
    function placeNear(el, pt) {
      const p = pt ? framePct(pt.x, pt.y, ui.screenW, ui.screenH) : null;
      const at = p || { left: 50, top: 50 };
      el.style.left = at.left + '%'; el.style.top = at.top + '%';
      el.classList.toggle('flip-x', at.left > 62);
      el.classList.toggle('flip-y', at.top < 22);
    }
    function bubbleOut(el, delay) {
      clearTimeout(el._out);
      el._out = setTimeout(() => {
        el.classList.add('out');
        el._out = setTimeout(() => { el.hidden = true; el.classList.remove('out'); }, reduced() ? 0 : 320);
      }, delay);
    }

    // A "type" event: the text it typed appears letter by letter near the cursor (≤1.2 s however long), then fades.
    const ticker = { raf: 0, start: 0, chars: [] };
    function typeTicker(text) {
      const fx = ensureFx(), el = fx && fx.querySelector('.uno-typing');
      if (!el) return;
      unraf(ticker.raf); ticker.raf = 0;
      clearTimeout(el._out);
      placeNear(el, cursorSpot());
      el.classList.remove('out');
      el.hidden = false;
      ticker.chars = Array.from(text);
      if (reduced()) { el.classList.remove('typing'); el.textContent = text; bubbleOut(el, 1600); return; }
      el.classList.add('typing');
      el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
      ticker.start = tnow();
      const step = () => {
        ticker.raf = 0;
        const n = tickerShown(ticker.chars.length, tnow() - ticker.start);
        const shown = ticker.chars.slice(0, n).join('');
        if (el.textContent !== shown) el.textContent = shown;
        if (n < ticker.chars.length) ticker.raf = raf(step);
        else { el.classList.remove('typing'); bubbleOut(el, 900); }
      };
      step();
    }

    // A "key" event: a keycap chip like [Ctrl] + [L], briefly.
    function keycap(k) {
      const fx = ensureFx(), el = fx && fx.querySelector('.uno-keycap');
      if (!el) return;
      clearTimeout(el._out);
      placeNear(el, cursorSpot());
      el.innerHTML = k.keys.map(chord => chord.map(key => '<kbd>' + esc(key) + '</kbd>').join('<b>+</b>')).join('<span class="uno-kc-sep">,</span>') +
        (k.times > 1 ? '<span class="uno-kc-x">×' + esc(String(k.times)) + '</span>' : '') + (k.hold ? '<span class="uno-kc-x">held</span>' : '');
      el.setAttribute('title', k.label);
      el.classList.remove('out', 'pop');
      el.hidden = false;
      if (!reduced()) { void el.offsetWidth; el.classList.add('pop'); }
      bubbleOut(el, 1100);
    }

    // A drag: a short line from where it started to where it let go, drawn as it goes.
    function trail(from, to, mine) {
      const fx = ensureFx(), box = $u('.uno-box');
      if (!fx || !box) return;
      const g = trailGeom(from, to, ui.screenW, ui.screenH, box.clientWidth, box.clientHeight);
      if (!g || g.length < 2) return;
      const el = document.createElement('div');
      el.className = 'uno-trail' + (mine ? ' you' : '') + (reduced() ? ' still' : '');
      el.style.left = g.left + '%'; el.style.top = g.top + '%';
      el.style.width = g.length.toFixed(1) + 'px';
      el.style.transform = 'rotate(' + g.angle.toFixed(2) + 'deg)';
      el.style.setProperty('--uno-drag', DRAG_MS + 'ms');
      el.innerHTML = '<i></i>';
      fx.appendChild(el);
      setTimeout(() => el.remove(), DRAG_MS + 900);
      const all = fx.querySelectorAll('.uno-trail');
      for (let i = 0; i < all.length - 4; i++) all[i].remove();
    }

    // A scroll: a short arrow at the spot, pointing the way it went.
    function scrollArrow(dir, at) {
      const fx = ensureFx();
      const p = at ? framePct(at.x, at.y, ui.screenW, ui.screenH) : null;
      if (!fx || !p) return;
      const el = document.createElement('div');
      el.className = 'uno-scrollfx d-' + dir + (reduced() ? ' still' : '');
      el.style.left = p.left + '%'; el.style.top = p.top + '%';
      el.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v15M6 13l6 6 6-6"/></svg>';
      fx.appendChild(el);
      setTimeout(() => el.remove(), 800);
      const all = fx.querySelectorAll('.uno-scrollfx');
      for (let i = 0; i < all.length - 3; i++) all[i].remove();
    }

    // A screenshot or zoom: a quick, soft flash on the screen's edge (and, for a zoom, the part it looked at).
    function camFlash(box) {
      if (reduced()) return;
      const fx = ensureFx();
      if (!fx) return;
      const f = fx.querySelector('.uno-camflash');
      if (f) { f.classList.remove('go'); void f.offsetWidth; f.classList.add('go'); }
      if (box && box.w > 0 && box.h > 0) {
        const a = framePct(box.x, box.y, ui.screenW, ui.screenH), b = framePct(box.x + box.w, box.y + box.h, ui.screenW, ui.screenH);
        if (!a || !b) return;
        const el = document.createElement('div');
        el.className = 'uno-zoomfx';
        el.style.left = a.left + '%'; el.style.top = a.top + '%';
        el.style.width = (b.left - a.left) + '%'; el.style.height = (b.top - a.top) + '%';
        fx.appendChild(el);
        setTimeout(() => el.remove(), 1000);
      }
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
        '<span class="uno-sess-m"><i></i>' + esc(sessionLabel(s)) + (s.startedAt ? ' · ' + esc(ago(s.startedAt, t)) : '') + (cur && cur.id === s.id && isRunning(s) ? ' · now' : '') + '</span>' +
        sessionTokensHTML(s, 'uno-sess-tok') + '</button>').join(''));
    }

    // The small "12.3k tokens in · 680 out" line: under the live view's title, and in each session row
    function sessionTokensHTML(s, cls) {
      const t = sessionTokensText(s);
      return t ? '<span class="' + cls + '" title="Tokens this task used">' + esc(t) + '</span>' : '';
    }
    function headTokensHTML(sess) {
      return available && ui.loaded && sess ? sessionTokensHTML(sess, 'uno-head-tok') : '';
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

    // ---------------- the replay filmstrip: real pictures of each step (docs/squall-uno.md "Replay pictures") ----------------

    function onShot(m) {
      const p = payloadOf(m);
      const shot = p && p.shot;
      if (!isShot(shot)) return;
      film.lists[shot.sessionId] = addShots(film.lists[shot.sessionId], shot);
      if (!ui.open) return;
      const sess = shownSession();
      if (sess && sess.id === shot.sessionId) renderFilm(sess);
    }

    async function loadShots(sessionId) {
      if (!available || film.loading[sessionId]) return;
      film.loading[sessionId] = true;
      try {
        const res = await op('shots', { sessionId });
        if (res.ok) film.lists[sessionId] = addShots(film.lists[sessionId], res.shots || []);
        film.loaded[sessionId] = true;
      } finally { film.loading[sessionId] = false; }
      const sess = shownSession();
      if (ui.open && sess && sess.id === sessionId) renderFilm(sess);
    }

    /** The picture of one shot, as base64 (kept for the 80 newest asked). */
    async function shotPic(shot) {
      const key = +shot.id;
      if (film.pics.has(key)) return film.pics.get(key);
      if (film.asked.has(key)) return null;
      film.asked.add(key);
      const res = await op('shot', { sessionId: shot.sessionId, id: key });
      film.asked.delete(key);
      if (!res.ok || !res.shot || !res.shot.jpeg) return null;
      film.pics.set(key, res.shot.jpeg);
      while (film.pics.size > 80) film.pics.delete(film.pics.keys().next().value);
      return res.shot.jpeg;
    }

    function ensureFilmEls() {
      let row = $u('.uno-film');
      if (!row) {
        const now = $u('.uno-now');
        if (!now) return null;
        row = document.createElement('div');
        row.className = 'uno-film';
        row.innerHTML = '<div class="uno-film-h"><span class="uno-lbl">Replay</span><span class="uno-film-n"></span>' +
          '<button class="uno-key uno-film-play" data-u="shotPlay" title="Play the steps">' + svg('play', 12) + '<span>Play</span></button>' +
          '<button class="uno-key uno-film-save" data-u="saveGif" title="Save this task’s replay as an animated GIF">' + svg('download', 12) + '<span>Save replay</span></button></div>' +
          '<div class="uno-film-strip" role="list"></div>';
        now.insertAdjacentElement('afterend', row);
        if (typeof IntersectionObserver !== 'undefined') {
          film.io = new IntersectionObserver(entries => entries.forEach(en => { if (en.isIntersecting) fillThumb(en.target); }), { root: row.querySelector('.uno-film-strip'), rootMargin: '0px 200px' });
        }
      }
      const box = $u('.uno-box');
      if (box && !box.querySelector('.uno-replay')) {
        const ov = document.createElement('div');
        ov.className = 'uno-replay';
        ov.hidden = true;
        ov.innerHTML = '<img class="uno-replay-img" alt="" draggable="false"><i class="uno-replay-dot" hidden></i>' +
          '<div class="uno-replay-bar"><button class="uno-replay-nav" data-u="shotPrev" title="Step back (←)">‹</button><span class="uno-replay-t"></span>' +
          '<button class="uno-replay-nav" data-u="shotNext" title="Step forward (→)">›</button>' +
          '<button class="uno-btn uno-replay-save" data-u="saveGif" title="Save this task’s replay as an animated GIF">' + svg('download', 13) + '<span>Save replay</span></button>' +
          '<button class="uno-btn primary uno-replay-live" data-u="shotLive">Back to live</button></div>';
        box.appendChild(ov);
      }
      return row;
    }

    function renderFilm(sess) {
      const row = ensureFilmEls();
      if (!row) return;
      if (!available || !ui.loaded || !sess) { row.hidden = true; return; }
      if (film.sessionId !== sess.id) {
        film.sessionId = sess.id;
        if (film.replay && film.replay.sessionId !== sess.id) { stopPlay(); film.replay = null; paintReplay(); }
      }
      if (!film.loaded[sess.id]) loadShots(sess.id);
      const list = film.lists[sess.id] || [];
      row.hidden = !list.length;
      if (!list.length) return;
      const n = row.querySelector('.uno-film-n');
      const label = list.length + (list.length === 1 ? ' picture' : ' pictures');
      if (n && n.textContent !== label) n.textContent = label;
      const pb = row.querySelector('.uno-film-play');
      if (pb) { pb.classList.toggle('on', !!film.playing); const sp = pb.querySelector('span'); if (sp) sp.textContent = film.playing ? 'Pause' : 'Play'; }
      paintSave();
      const strip = row.querySelector('.uno-film-strip');
      const have = new Set(Array.from(strip.children).map(el => el.getAttribute('data-uv')));
      const atEnd = strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 30;
      // remove dropped ones, add new ones at the end (they slide in)
      Array.from(strip.children).forEach(el => { if (!list.some(x => String(x.id) === el.getAttribute('data-uv'))) el.remove(); });
      let added = false;
      list.forEach(x => {
        if (have.has(String(x.id))) return;
        const b = document.createElement('button');
        b.className = 'uno-thumb new';
        b.setAttribute('data-u', 'shot');
        b.setAttribute('data-uv', String(x.id));
        b.setAttribute('role', 'listitem');
        b.title = shotLabel(x);
        b.innerHTML = '<img alt="" draggable="false"><span>' + esc(num(x.step) && +x.step > 0 ? String(+x.step) : '·') + '</span>';
        strip.appendChild(b);
        requestAnimationFrame(() => requestAnimationFrame(() => b.classList.remove('new')));
        if (film.io) film.io.observe(b); else fillThumb(b);
        added = true;
      });
      const on = film.replay && film.replay.id;
      strip.querySelectorAll('.uno-thumb').forEach(el => el.classList.toggle('on', String(on) === el.getAttribute('data-uv')));
      if (added && atEnd && !film.replay) strip.scrollTo({ left: strip.scrollWidth, behavior: 'smooth' });
    }

    async function fillThumb(el) {
      if (!el || el._filled) return;
      el._filled = true;
      const list = film.lists[film.sessionId] || [];
      const shot = list.find(x => String(x.id) === el.getAttribute('data-uv'));
      if (!shot) return;
      const pic = await shotPic(shot);
      const img = el.querySelector('img');
      if (pic && img) img.src = 'data:image/jpeg;base64,' + pic;
      else { el._filled = false; el.classList.add('gone'); }
    }

    async function showShot(id) {
      const sess = shownSession();
      const list = sess ? film.lists[sess.id] || [] : [];
      const shot = list.find(x => String(x.id) === String(id));
      if (!shot) return;
      film.replay = { sessionId: shot.sessionId, id: +shot.id };
      renderFilm(sess);
      paintReplay();
      const pic = await shotPic(shot);
      if (!film.replay || film.replay.id !== +shot.id) return;
      if (!pic) { flash('That picture isn’t kept anymore.'); return; }
      paintReplay(pic);
      const el = view && view.querySelector('.uno-thumb[data-uv="' + shot.id + '"]');
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
    }

    function paintReplay(pic) {
      const ov = $u('.uno-replay');
      if (!ov) return;
      if (!film.replay) { ov.hidden = true; ov.classList.remove('on'); return; }
      const list = film.lists[film.replay.sessionId] || [];
      const shot = list.find(x => +x.id === film.replay.id);
      ov.hidden = false;
      requestAnimationFrame(() => ov.classList.add('on'));
      const t = ov.querySelector('.uno-replay-t');
      if (t) t.textContent = shotLabel(shot) + (shot ? '  (' + (list.indexOf(shot) + 1) + ' of ' + list.length + ')' : '');
      const img = ov.querySelector('.uno-replay-img');
      if (img && pic) { img.classList.remove('fade'); void img.offsetWidth; img.src = 'data:image/jpeg;base64,' + pic; img.classList.add('fade'); }
      const dot = ov.querySelector('.uno-replay-dot');
      const p = shot && num(shot.cursorX) && num(shot.cursorY) ? framePct(+shot.cursorX, +shot.cursorY, +shot.width || ui.screenW, +shot.height || ui.screenH) : null;
      if (dot) { dot.hidden = !p; if (p) { dot.style.left = p.left + '%'; dot.style.top = p.top + '%'; } }
    }

    function stepShot(delta) {
      const sess = shownSession();
      const list = sess ? film.lists[sess.id] || [] : [];
      const next = shotNeighbor(list, film.replay ? film.replay.id : null, delta);
      if (next) showShot(next.id);
    }

    function play() {
      const sess = shownSession();
      const list = sess ? film.lists[sess.id] || [] : [];
      if (!list.length) return;
      if (!film.replay || +film.replay.id === +list[list.length - 1].id) showShot(list[0].id);
      film.playing = setInterval(() => {
        const s2 = shownSession();
        const l2 = s2 ? film.lists[s2.id] || [] : [];
        if (!film.replay || !l2.length || +film.replay.id >= +l2[l2.length - 1].id) { stopPlay(); return; }
        stepShot(1);
      }, 500);
      renderFilm(sess);
    }

    function stopPlay() {
      if (film.playing) clearInterval(film.playing);
      film.playing = 0;
      const pb = $u('.uno-film-play');
      if (pb) { pb.classList.remove('on'); const sp = pb.querySelector('span'); if (sp) sp.textContent = 'Play'; }
    }

    // ---------------- Save replay: the task's pictures as one animated GIF, made here in the page ----------------

    function paintSave() {
      if (!view) return;
      const saved = !film.saving && Date.now() - film.savedAt < 3000;
      const text = film.saving ? 'Making GIF… ' + film.saving.done + '/' + film.saving.total : saved ? 'Saved' : 'Save replay';
      view.querySelectorAll('[data-u="saveGif"]').forEach(b => {
        b.disabled = !!film.saving;
        b.classList.toggle('busy', !!film.saving);
        const sp = b.querySelector('span');
        if (sp && sp.textContent !== text) sp.textContent = text;
      });
    }

    // A shot's JPEG (base64): the one the filmstrip already has, else asked for. Null once it isn't kept anymore.
    async function shotJpeg(shot) {
      const key = +shot.id;
      if (film.pics.has(key)) return film.pics.get(key);
      const res = await op('shot', { sessionId: shot.sessionId, id: key });
      return res.ok && res.shot && res.shot.jpeg ? res.shot.jpeg : null;
    }

    function loadPic(b64) {
      return new Promise(resolve => {
        const img = new Image();
        img.onload = () => resolve(img.naturalWidth > 0 ? img : null);
        img.onerror = () => resolve(null);
        img.src = 'data:image/jpeg;base64,' + b64;
      });
    }

    function downloadBlob(blob, name) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }

    async function saveGif() {
      if (film.saving) return;
      const sess = shownSession();
      const list = sess ? (film.lists[sess.id] || []).slice() : [];
      if (!list.length) { flash('This task has no pictures to save yet.'); return; }
      const Gif = root.SquallGif;
      const canvas = document.createElement('canvas');
      if (!Gif || !canvas.getContext || !canvas.getContext('2d', { willReadFrequently: true })) { flash('This copy of Squall can’t make GIFs. Update Squall on this PC.'); return; }
      const who = agentInfo().agentName || sess.agentName || sess.agentId;
      film.saving = { done: 0, total: list.length };
      paintSave();
      try {
        const made = await makeReplayGif(list, {
          Gif, canvas, picOf: shotJpeg, loadPic,
          progress: done => { film.saving.done = done; paintSave(); },
          pause: () => new Promise(r => setTimeout(r, 0)),   // let the window draw between frames
        });
        if (!made.bytes) { flash('This task’s pictures aren’t kept anymore, so there’s nothing to save.'); return; }
        downloadBlob(new Blob([made.bytes], { type: 'image/gif' }), gifFileName(who, sess.startedAt));
        film.savedAt = Date.now();
        setTimeout(paintSave, 3100);
        if (made.missing) flash('Saved the GIF. ' + made.missing + (made.missing === 1 ? ' picture isn’t' : ' pictures aren’t') + ' kept anymore, so ' + (made.missing === 1 ? 'it’s' : 'they’re') + ' not in it.');
      } catch (e) {
        flash('Couldn’t make the GIF: ' + (String(errorText(e) || '').replace(/[.\s]+$/, '') || 'something went wrong') + '.');
      } finally {
        film.saving = null;
        paintSave();
      }
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
      if (box && wheelOn() && !t.closest('.uno-empty:not([hidden])') && !t.closest('.uno-replay:not([hidden])')) {
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
        case 'pause': if (cur) run('pause', { sessionId: cur.id }); break;
        case 'resume': if (cur) run('resume', { sessionId: cur.id }); break;
        case 'stop': if (cur) run('stop', { sessionId: cur.id }); break;
        case 'stopAll': run('stopAll', {}, res => { if (res.stopped === 0) flash('Nothing was running.'); refresh(); }); break;
        case 'computerOff': {
          const comp = watchedComputer();
          if (comp && root.confirm && !root.confirm('Turn off ' + (comp.name || 'this computer') + '? What’s on it goes away. Its next task starts it fresh.')) return;
          if (comp) run('computerOff', { computerId: comp.id }, () => { delete store.frames[comp.id]; ui.wheelLocal = false; refresh(); });
          break;
        }
        case 'backNow': ui.viewSession = null; render(); break;
        case 'shot': showShot(v); break;
        case 'shotLive': stopPlay(); film.replay = null; paintReplay(); renderFilm(shownSession()); break;
        case 'shotPrev': stepShot(-1); break;
        case 'shotNext': stepShot(1); break;
        case 'shotPlay': if (film.playing) stopPlay(); else play(); break;
        case 'saveGif': saveGif(); break;
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
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && film.replay && !/INPUT|TEXTAREA|SELECT/.test(t.tagName || '')) {
        e.preventDefault(); stepShot(e.key === 'ArrowLeft' ? -1 : 1); return;
      }
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

    // Esc leaves the settings, then the view; Space pauses or resumes the task (unless a text box, a button or a dialog is in front)
    document.addEventListener('keydown', e => {
      if (!ui.open || (e.key !== 'Escape' && e.key !== ' ')) return;
      if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName || '')) return;
      if (document.querySelector('.modal-back, .qk-pop, .qk-back, .use-pop, .cx-pop, .mm-pop, .lightbox')) return;
      if (e.key === ' ') {
        const tag = (e.target && e.target.tagName) || '';
        if (e.repeat || e.ctrlKey || e.altKey || e.metaKey || tag === 'BUTTON' || tag === 'A' || (e.target && e.target.isContentEditable)) return;
        const b = $u('[data-u="pause"], [data-u="resume"]');
        if (b && !b.disabled) { e.preventDefault(); b.click(); }
        return;
      }
      if (ui.settings) { ui.settings = false; render(); return; }
      if (film.replay) { stopPlay(); film.replay = null; paintReplay(); renderFilm(shownSession()); return; }
      close(); if (h.onClose) h.onClose();
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && ui.open) { paintFrame(); renderFeedTimes(); } });

    // first look
    if (available) refresh();

    const api = { sidebarHTML, paneHTML, liveCount: () => (available && ui.loaded ? agents().filter(a => statusOf(computerOf(store, a.agentId), currentSession(store, a.agentId)).dot).length : 0), open, close, isOpen: () => ui.open, refresh, store };
    root.SquallUnoUI = api;
    return api;
  }

  const api = {
    CHIEF, computerIdFor, agentsForUno, newStore, payloadOf, eventOf, addEvents, mergeState, takeEvent, takeFrame,
    computerOf, currentSession, sessionsFor, sessionEvents, isRunning, anyRunning, statusOf, sessionLabel, pauseAction, dotClass, nowLine, ago,
    addShots, shotNeighbor, shotLabel, gifFrameSize, gifFileName, makeReplayGif,
    feedRow, isClick, framePct, cursorPct, displayToScreen, fitBox, clampSteps, keyText, tokensText, errorText, wire,
    easeOut, glideAt, tickerTiming, tickerShown, typedText, prettyKey, prettyKeys, keyChip, scrollDir, motionOf, trailGeom,
    fmtTokens, sessionTokensText, todayTokensText, runningOn, quickStartCheck, pickAgent, canRunAgain,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SquallUno = api;
})(typeof window !== 'undefined' ? window : globalThis);
