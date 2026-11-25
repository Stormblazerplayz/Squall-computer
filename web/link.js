// Squall on the iPhone and iPad (the Squall app from Squall-mobile).
//
// The host's SquallLink (src/SquallLink) runs the phone API from Squall-mobile docs/pairing.md. This file is the window's half:
//   - every 2 seconds it hands the host the phone's view of the team (bots, chats, groups, approvals), built from Squall's
//     real state: nothing here is made up, and what Squall doesn't have (routines, jobs) is simply left out;
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
    // Squall's shared To do list (workspace\\shared\\todo.json), when this Squall has one
    if (view && Array.isArray(view.todo)) state.todo = phoneTodo(view.todo, ids, view.lead || leadName);
    // Squall's own version, for the phone's Settings > Computer (only what the updater really knows)
    const d = view && view.desktop;
    if (d && d.current) {
      state.desktop = { version: String(d.current), updating: !!d.busy };
      if (d.ready) state.desktop.latest = String(d.ready);
    }
    state.version = hash(JSON.stringify(state));
    return state;
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
      case 'todo.add': case 'todo.set': case 'todo.give': case 'todo.delete': case 'todo.clearDone':
        return routeTodo(view, a, type);
      case 'settings.save': return { do: 'none' };
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
        todo: h.todo ? h.todo.items() : undefined,
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
        case 'todoAdd': {
          const it = h.todo.add(r.text, 'Storm');
          if (!it) return { ok: false, error: 'Couldn’t add that to-do.' };
          if (r.bot) {
            if (!h.send(r.chat.raw, giveText(it), false)) return { ok: false, id: it.id, error: 'Added to the list, but ' + r.bot + ' is busy. Give it to ' + r.bot + ' again in a moment.' };
            h.todo.set(it.id, 'doing', r.bot);
          }
          return { ok: true, id: it.id };
        }
        case 'todoSet': return h.todo.set(r.id, r.status) ? { ok: true } : { ok: false, error: TODO_GONE };
        case 'todoGive': {
          if (!h.send(r.chat.raw, r.text, false)) return { ok: false, error: r.bot + ' is busy or Squall isn’t signed in to Claude. Try again in a moment.' };
          h.todo.set(r.id, 'doing', r.bot);
          return { ok: true };
        }
        case 'todoDel': return h.todo.del(r.id) ? { ok: true } : { ok: false, error: TODO_GONE };
        case 'todoClearDone': h.todo.clearDone(); return { ok: true };
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

  const api = { CHIEF, botIds, hash, buildState, phoneMessages, phoneTodo, giveText, routeAction, chatFor, speakable, wire };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SquallLinkCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
