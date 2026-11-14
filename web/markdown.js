/* Coreshell markdown.
   Obsidian-flavored markdown to HTML, block by block (so Live mode can edit one block at a time),
   plus a fast scanner that pulls links, tags, headings and properties out of a note.
   No libraries. Everything from a note is escaped; only a few harmless inline tags are let through. */
(function (global) {
  'use strict';

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ESC[c]);

  // ---------- helpers ----------
  function cols(ws) { let c = 0; for (const ch of ws) c = ch === '\t' ? c + 4 - (c % 4) : c + 1; return c; }
  function leadCols(line) { return cols(/^[ \t]*/.exec(line)[0]); }
  function dedent(line, n) {
    let c = 0, i = 0;
    while (i < line.length && c < n && (line[i] === ' ' || line[i] === '\t')) {
      const w = line[i] === '\t' ? 4 - (c % 4) : 1;
      if (c + w > n) return ' '.repeat(c + w - n) + line.slice(i + 1);
      c += w; i++;
    }
    return line.slice(i);
  }
  function runLen(s, k, ch) { let r = k; while (r < s.length && s[r] === ch) r++; return r - k; }
  function slug(s) { return String(s).toLowerCase().trim().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-'); }
  function stripBlockId(s) { return s.replace(/\s+\^[A-Za-z0-9-]+\s*$/, ''); }
  const abs = (map, i) => (map ? map[i] : i);

  // ---------- wikilinks ----------
  function parseWiki(inner) {
    let t = inner, alias = null;
    const bar = inner.search(/\\?\|/);
    if (bar !== -1) { alias = inner.slice(bar).replace(/^\\?\|/, ''); t = inner.slice(0, bar); }
    let heading = null, block = null;
    const hash = t.indexOf('#');
    if (hash !== -1) {
      heading = t.slice(hash + 1); t = t.slice(0, hash);
      if (heading.startsWith('^')) { block = heading.slice(1); heading = null; }
    }
    return { target: t.trim(), heading: heading ? heading.trim() : null, block, alias: alias ? alias.trim() : null };
  }

  // ---------- properties (YAML frontmatter, the subset notes use) ----------
  function splitInline(s) {
    const out = []; let cur = '', q = null, depth = 0;
    for (const ch of s) {
      if (q) { if (ch === q) q = null; cur += ch; continue; }
      if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
      if (ch === '[' || ch === '{') depth++;
      if (ch === ']' || ch === '}') depth--;
      if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
      cur += ch;
    }
    if (cur.trim()) out.push(cur);
    return out.map(x => x.trim()).filter(x => x !== '');
  }
  function scalar(v) {
    v = String(v).trim();
    if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    if (v.length >= 2 && v[0] === "'" && v[v.length - 1] === "'") return v.slice(1, -1).replace(/''/g, "'");
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (v === 'null' || v === '~' || v === '') return null;
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
    return v;
  }
  function parseYaml(src) {
    const out = {}; let key = null;
    for (const raw of src.split('\n')) {
      if (!raw.trim() || /^\s*#/.test(raw)) continue;
      const item = /^\s*-\s+(.*)$/.exec(raw) || /^\s*-$/.exec(raw);
      if (item && key !== null) {
        if (!Array.isArray(out[key])) out[key] = out[key] == null ? [] : [out[key]];
        if (item[1] !== undefined) out[key].push(scalar(item[1]));
        continue;
      }
      const kv = /^([^\s:#][^:]*?):(?:\s+(.*)|\s*)$/.exec(raw);
      if (kv) {
        key = kv[1].trim();
        const v = (kv[2] || '').trim();
        if (v === '') out[key] = null;
        else if (v[0] === '[' && v[v.length - 1] === ']' && !(v.startsWith('[[') && v.endsWith(']]'))) out[key] = splitInline(v.slice(1, -1)).map(scalar);
        else out[key] = scalar(v);
      }
    }
    return out;
  }
  function frontmatter(L) {
    if (!L.length || L[0].trimEnd() !== '---') return null;
    for (let i = 1; i < L.length; i++) {
      const t = L[i].trimEnd();
      if (t === '---' || t === '...') {
        const raw = L.slice(1, i).join('\n');
        return { data: parseYaml(raw), raw, start: 0, end: i };
      }
    }
    return null;
  }

  // ---------- block structure ----------
  const RX = {
    fence: /^ {0,3}(`{3,}|~{3,})(.*)$/,
    fenceClose: /^ {0,3}(`{3,}|~{3,})[ \t]*$/,
    heading: /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/,
    hr: /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/,
    quote: /^ {0,3}>/,
    item: /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+|$)(.*)$/,
    delim: /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/,
    setext1: /^ {0,3}=+[ \t]*$/,
    setext2: /^ {0,3}-+[ \t]*$/,
    math: /^\s*\$\$/,
    comment: /^\s*%%/,
  };

  function splitRow(line) {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
    const cells = []; let cur = '', depth = 0, code = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '\\' && s[i + 1] === '|') { cur += depth > 0 ? '\\|' : '|'; i++; continue; }
      if (c === '`') code = !code;
      if (!code && c === '[' && s[i + 1] === '[') depth++;
      if (!code && c === ']' && s[i + 1] === ']' && depth > 0) depth--;
      if (c === '|' && !code && depth === 0) { cells.push(cur.trim()); cur = ''; continue; }
      cur += c;
    }
    cells.push(cur.trim());
    return cells;
  }
  function isTableStart(L, j, to) {
    if (j + 1 >= to || !L[j].includes('|') || !L[j + 1].includes('-') || !RX.delim.test(L[j + 1])) return false;
    return splitRow(L[j]).length === splitRow(L[j + 1]).length;
  }
  function isItemStart(line, interrupting) {
    const m = RX.item.exec(line);
    if (!m || RX.hr.test(line)) return false;
    if (interrupting) {
      if (!m[4].trim()) return false;
      if (/\d/.test(m[2]) && parseInt(m[2], 10) !== 1) return false;
    }
    return true;
  }
  function isCommentStart(line) {
    const t = line.trim();
    return t.startsWith('%%') && t.indexOf('%%', 2) === -1;
  }
  function startsBlock(L, j, to, interrupting) {
    const line = L[j];
    return RX.fence.test(line) || RX.heading.test(line) || RX.quote.test(line) || isCommentStart(line) ||
      (RX.hr.test(line) && !RX.setext2.test(line)) || RX.math.test(line) ||
      isItemStart(line, interrupting) || isTableStart(L, j, to);
  }
  function listEnd(L, i, to) {
    let j = i + 1;
    while (j < to) {
      const ln = L[j];
      if (!ln.trim()) {
        let k = j + 1;
        while (k < to && !L[k].trim()) k++;
        if (k < to && (isItemStart(L[k], false) || /^(?: {2,}|\t)/.test(L[k]))) { j = k; continue; }
        break;
      }
      if (isItemStart(ln, false) || /^(?: {2,}|\t)/.test(ln)) { j++; continue; }
      if (!startsBlock(L, j, to, true) && L[j - 1].trim()) { j++; continue; }   // lazy continuation
      break;
    }
    return j;
  }

  function parseBlocks(L, from, to) {
    const blocks = [];
    let i = from;
    while (i < to) {
      const line = L[i];
      if (!line.trim()) { i++; continue; }
      let m;
      if ((m = RX.fence.exec(line)) && !(m[1][0] === '`' && m[2].includes('`'))) {
        const fence = m[1]; const body = []; let j = i + 1;
        while (j < to) {
          const c = RX.fenceClose.exec(L[j]);
          if (c && c[1][0] === fence[0] && c[1].length >= fence.length) break;
          body.push(L[j]); j++;
        }
        blocks.push({ type: 'code', lang: m[2].trim().split(/\s+/)[0] || '', text: body.join('\n'), s: i, e: Math.min(j, to - 1) });
        i = j + 1; continue;
      }
      if (RX.math.test(line)) {
        const rest = line.trim().slice(2);
        if (rest.endsWith('$$') && rest.length >= 2) { blocks.push({ type: 'math', text: rest.slice(0, -2), s: i, e: i }); i++; continue; }
        const body = [rest]; let j = i + 1;
        while (j < to && !L[j].includes('$$')) { body.push(L[j]); j++; }
        if (j < to) body.push(L[j].slice(0, L[j].indexOf('$$')));
        blocks.push({ type: 'math', text: body.join('\n').trim(), s: i, e: Math.min(j, to - 1) });
        i = j + 1; continue;
      }
      if (isCommentStart(line)) {
        let j = i + 1;
        while (j < to && !L[j].includes('%%')) j++;
        const e = Math.min(j, to - 1);
        blocks.push({ type: 'comment', text: L.slice(i, e + 1).join('\n'), s: i, e });
        i = e + 1; continue;
      }
      if ((m = RX.heading.exec(line))) { blocks.push({ type: 'heading', level: m[1].length, text: m[2] || '', s: i, e: i }); i++; continue; }
      if (RX.hr.test(line)) { blocks.push({ type: 'hr', s: i, e: i }); i++; continue; }
      if (RX.quote.test(line)) {
        let j = i + 1;
        while (j < to && RX.quote.test(L[j])) j++;
        blocks.push({ type: 'quote', s: i, e: j - 1 }); i = j; continue;
      }
      if (isTableStart(L, i, to)) {
        let j = i + 2;
        while (j < to && L[j].trim() && L[j].includes('|')) j++;
        blocks.push({ type: 'table', s: i, e: j - 1 }); i = j; continue;
      }
      if (isItemStart(line, false)) {
        const j = listEnd(L, i, to);
        blocks.push({ type: 'list', s: i, e: j - 1 }); i = j; continue;
      }
      let j = i + 1, setext = 0;
      while (j < to && L[j].trim()) {
        if (RX.setext1.test(L[j])) { setext = 1; break; }
        if (RX.setext2.test(L[j])) { setext = 2; break; }
        if (startsBlock(L, j, to, true)) break;
        j++;
      }
      if (setext) {
        blocks.push({ type: 'heading', level: setext, text: L.slice(i, j).map(x => x.trim()).join(' '), s: i, e: j });
        i = j + 1; continue;
      }
      blocks.push({ type: 'para', s: i, e: j - 1 });
      i = j;
    }
    return blocks;
  }

  // ---------- inline ----------
  function findCodeClose(s, from, run) {
    let k = from;
    while (k < s.length) {
      if (s[k] === '`') { const r = runLen(s, k, '`'); if (r === run) return k; k += r; } else k++;
    }
    return -1;
  }
  function matchBracket(s, i) {
    let depth = 0;
    for (let k = i; k < s.length; k++) {
      const c = s[k];
      if (c === '\\') { k++; continue; }
      if (c === '`') { const r = runLen(s, k, '`'); const close = findCodeClose(s, k + r, r); k = (close !== -1 ? close + r : k + r) - 1; continue; }
      if (c === '[') depth++;
      else if (c === ']') { depth--; if (depth === 0) return k; }
    }
    return -1;
  }
  function matchParen(s, i) {
    let depth = 0;
    for (let k = i; k < s.length; k++) {
      const c = s[k];
      if (c === '\\') { k++; continue; }
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) return k; }
    }
    return -1;
  }
  function findEmphClose(s, from, ch, run) {
    for (let k = from; k < s.length; k++) {
      const c = s[k];
      if (c === '\\') { k++; continue; }
      if (c === '`') { const r = runLen(s, k, '`'); const close = findCodeClose(s, k + r, r); k = (close !== -1 ? close + r : k + r) - 1; continue; }
      if (c === '[' && s[k + 1] === '[') { const close = s.indexOf(']]', k + 2); if (close !== -1) { k = close + 1; continue; } }
      if (c === ch) {
        const r = runLen(s, k, ch);
        const prev = s[k - 1], after = s[k + r];
        const okPrev = k > from && prev !== undefined && !/\s/.test(prev);
        const okNext = ch !== '_' || after === undefined || !/[\p{L}\p{N}]/u.test(after);
        if (okPrev && okNext) {
          if (r === run) return k;
          if (r > run && r <= 3) return k + (r - run);
        }
        k += r - 1;
      }
    }
    return -1;
  }
  const SAFE_TAG = /^<\/?(br|kbd|u|sub|sup|s|b|i|em|strong|mark)\s*\/?>/i;
  const URL_RX = /^(?:https?:\/\/|www\.)[^\s<]*[^\s<.,:;"')\]!?*_~]/;
  const TAG_RX = /^[\p{L}\p{N}_\-/]+/u;

  function inline(s, ctx) {
    let out = '', i = 0;
    const n = s.length;
    while (i < n) {
      const c = s[i];
      if (c === '\\' && i + 1 < n && /[!-/:-@[-`{-~]/.test(s[i + 1])) { out += esc(s[i + 1]); i += 2; continue; }
      if (c === '`') {
        const r = runLen(s, i, '`');
        const close = findCodeClose(s, i + r, r);
        if (close !== -1) {
          let code = s.slice(i + r, close);
          if (code.length > 2 && code[0] === ' ' && code[code.length - 1] === ' ' && code.trim()) code = code.slice(1, -1);
          out += '<code>' + esc(code) + '</code>'; i = close + r; continue;
        }
        out += esc(s.slice(i, i + r)); i += r; continue;
      }
      if (c === '%' && s[i + 1] === '%') {
        const close = s.indexOf('%%', i + 2);
        if (close !== -1) { i = close + 2; continue; }
      }
      if ((c === '[' && s[i + 1] === '[') || (c === '!' && s[i + 1] === '[' && s[i + 2] === '[')) {
        const embed = c === '!';
        const start = i + (embed ? 3 : 2);
        const close = s.indexOf(']]', start);
        if (close > start) {
          const inner = s.slice(start, close);
          if (!inner.includes('[[') && !inner.includes('\n')) { out += ctx.wikilink(inner, embed); i = close + 2; continue; }
        }
      }
      if ((c === '!' && s[i + 1] === '[') || c === '[') {
        const isImg = c === '!';
        const lb = isImg ? i + 1 : i;
        if (s[lb + 1] !== '^') {
          const rb = matchBracket(s, lb);
          if (rb !== -1 && s[rb + 1] === '(') {
            const rp = matchParen(s, rb + 1);
            if (rp !== -1) {
              const text = s.slice(lb + 1, rb);
              let dest = s.slice(rb + 2, rp).trim(), title = '';
              const tm = /^(\S+)\s+["'(](.*)["')]$/.exec(dest);
              if (tm) { dest = tm[1]; title = tm[2]; }
              if (dest.startsWith('<') && dest.endsWith('>')) dest = dest.slice(1, -1);
              out += isImg ? ctx.image(dest, text, title) : ctx.link(dest, inline(text, ctx), title);
              i = rp + 1; continue;
            }
          }
        }
      }
      if (c === '<') {
        const al = /^<((?:https?|mailto):[^\s<>]+)>/i.exec(s.slice(i));
        if (al) { out += ctx.link(al[1], esc(al[1]), ''); i += al[0].length; continue; }
        const tg = SAFE_TAG.exec(s.slice(i));
        if (tg) { out += tg[0].toLowerCase().replace(/\s+/g, ''); i += tg[0].length; continue; }
      }
      if ((c === 'h' || c === 'w') && (i === 0 || /[\s(*_~"']/.test(s[i - 1]))) {
        const um = URL_RX.exec(s.slice(i));
        if (um) {
          const url = um[0].startsWith('www.') ? 'https://' + um[0] : um[0];
          out += ctx.link(url, esc(um[0]), ''); i += um[0].length; continue;
        }
      }
      if (c === '*' || c === '_') {
        const r = runLen(s, i, c);
        const prev = i > 0 ? s[i - 1] : ' ', next = i + r < n ? s[i + r] : ' ';
        const canOpen = !/\s/.test(next) && !(c === '_' && /[\p{L}\p{N}]/u.test(prev));
        if (canOpen && r <= 3) {
          const close = findEmphClose(s, i + r, c, r);
          if (close !== -1) {
            const inner = inline(s.slice(i + r, close), ctx);
            out += r === 3 ? '<strong><em>' + inner + '</em></strong>' : r === 2 ? '<strong>' + inner + '</strong>' : '<em>' + inner + '</em>';
            i = close + r; continue;
          }
        }
        out += esc(s.slice(i, i + r)); i += r; continue;
      }
      if ((c === '~' || c === '=') && s[i + 1] === c && s[i + 2] !== c) {
        const close = s.indexOf(c + c, i + 2);
        if (close > i + 2 && !/\s/.test(s[i + 2]) && !/\s/.test(s[close - 1])) {
          const inner = inline(s.slice(i + 2, close), ctx);
          out += c === '~' ? '<del>' + inner + '</del>' : '<mark>' + inner + '</mark>';
          i = close + 2; continue;
        }
      }
      if (c === '#' && (i === 0 || /[\s(]/.test(s[i - 1]))) {
        const tm = TAG_RX.exec(s.slice(i + 1));
        if (tm && /\D/.test(tm[0])) { out += ctx.tag(tm[0]); i += 1 + tm[0].length; continue; }
      }
      out += ESC[c] || c;
      i++;
    }
    return out;
  }

  // ---------- blocks to HTML ----------
  const CALLOUT_ALIAS = {
    summary: 'abstract', tldr: 'abstract', abstract: 'abstract', info: 'info', todo: 'todo',
    tip: 'tip', hint: 'tip', important: 'tip', success: 'success', check: 'success', done: 'success',
    question: 'question', help: 'question', faq: 'question', warning: 'warning', caution: 'warning', attention: 'warning',
    failure: 'failure', fail: 'failure', missing: 'failure', danger: 'danger', error: 'danger', bug: 'bug',
    example: 'example', quote: 'quote', cite: 'quote', note: 'note',
  };
  const CALLOUT_ICON = {
    note: '✎', abstract: '☰', info: 'i', todo: '✓', tip: '✦', success: '✓', question: '?',
    warning: '!', failure: '✕', danger: '⚡', bug: '✱', example: '≡', quote: '❝',
  };
  const TASK_RX = /^\[(.)\](?:[ \t]+|$)/;

  function codeHTML(lang, text) {
    const lnN = String(text || '').replace(/\n+$/, '').split('\n').length; /* groky r219: quiet line count on longer code blocks */
    const lnA = lang && String(lang).toLowerCase() !== 'mermaid' && lnN >= 10 ? ' data-lines="' + lnN + '"' : '';
    return '<div class="code-block">' + (lang ? '<span class="code-lang"' + lnA + '>' + esc(lang) + '</span>' : '') +
      '<button class="copy" type="button" title="Copy">Copy</button><pre><code>' + (global.MD && global.MD.highlight ? global.MD.highlight(lang, text) : esc(text)) + '</code></pre></div>';
  }
  function renderBlocks(L, map, ctx, st, tight) {
    return parseBlocks(L, 0, L.length).map(b => renderBlock(L, b, ctx, st, map, tight)).join('');
  }
  function renderBlock(L, b, ctx, st, map, tight) {
    switch (b.type) {
      case 'heading': {
        const text = stripBlockId(b.text);
        let id = slug(stripMd(text)) || 'section';
        if (st.ids[id]) id += '-' + (++st.ids[id]); else st.ids[id] = 1;
        const line = abs(map, b.s);
        st.headings.push({ level: b.level, text: stripMd(text), id, line });
        return '<h' + b.level + ' id="' + esc(id) + '" data-line="' + line + '">' + inline(text, ctx) + '</h' + b.level + '>';
      }
      case 'hr': return '<hr>';
      case 'code': return codeHTML(b.lang, b.text);
      case 'math': return '<div class="math">' + esc(b.text) + '</div>';
      case 'comment': return '<div class="md-comment">' + esc(b.text) + '</div>';
      case 'quote': return quoteHTML(L, b, ctx, st, map);
      case 'table': return tableHTML(L, b, ctx);
      case 'list': return itemsHTML(listItems(L, b.s, b.e), ctx, st, map);
      default: return paraHTML(L, b, ctx, tight);
    }
  }
  function paraHTML(L, b, ctx, tight) {
    const lines = L.slice(b.s, b.e + 1);
    if (ctx.embedBlock && lines.every(l => /^\s*!\[\[[^\]\n]+\]\]\s*$/.test(l))) {
      const parts = lines.map(l => ctx.embedBlock(l.trim().slice(3, -2)));
      if (parts.every(p => p != null)) return parts.join('');
    }
    const body = lines.map(l => inline(stripBlockId(l.replace(/^[ \t]+/, '')), ctx)).join('<br>');
    return tight ? '<div class="li-p">' + body + '</div>' : '<p>' + body + '</p>';
  }
  function quoteHTML(L, b, ctx, st, map) {
    const IL = [], IM = [];
    for (let i = b.s; i <= b.e; i++) { IL.push(L[i].replace(/^ {0,3}> ?/, '')); IM.push(abs(map, i)); }
    const cm = /^\[!([\w-]+)\]([+-]?)[ \t]*(.*)$/.exec(IL[0]);
    if (cm) {
      const type = CALLOUT_ALIAS[cm[1].toLowerCase()] || 'note';
      const title = cm[3].trim() || cm[1].charAt(0).toUpperCase() + cm[1].slice(1).toLowerCase();
      const inner = IL.length > 1 ? renderBlocks(IL.slice(1), IM.slice(1), ctx, st) : '';
      const head = '<span class="callout-icon">' + esc(CALLOUT_ICON[type]) + '</span><span class="callout-title-text">' + inline(title, ctx) + '</span>';
      if (cm[2]) {
        return '<details class="callout c-' + type + '"' + (cm[2] === '+' ? ' open' : '') + '><summary class="callout-title">' + head +
          '</summary><div class="callout-body">' + inner + '</div></details>';
      }
      return '<div class="callout c-' + type + '"><div class="callout-title">' + head + '</div>' + (inner ? '<div class="callout-body">' + inner + '</div>' : '') + '</div>';
    }
    return '<blockquote>' + renderBlocks(IL, IM, ctx, st) + '</blockquote>';
  }
  function tableHTML(L, b, ctx) {
    const head = splitRow(L[b.s]);
    const al = splitRow(L[b.s + 1]).map(c => /^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : /^:-/.test(c) ? 'left' : '');
    /* groky r220: a column of plain numbers (no alignment given) lines up on the right so digits stack */
    const NUMC = /^[~≈<>±+\-−]?\s?[$€£¥]?\s?\d[\d,]*(?:\.\d+)?\s?(?:%|[kKMBx×°]|ms|s|h|min|GB|MB|KB|TB|px|fps)?$/;
    const numCol = head.map((_, k) => { if (al[k]) return false; let n = 0; for (let i = b.s + 2; i <= b.e; i++) { const v = String(splitRow(L[i])[k] || '').replace(/[*_`]/g, '').trim(); if (!v || /^[-–—]$/.test(v)) continue; if (!NUMC.test(v)) return false; n++; } return n > 0; });
    const st = k => (al[k] ? ' style="text-align:' + al[k] + '"' : numCol[k] ? ' class="num"' : '');
    let h = '<div class="table-wrap"><table><thead><tr>';
    head.forEach((c, k) => { h += '<th' + st(k) + '>' + inline(c, ctx) + '</th>'; });
    h += '</tr></thead><tbody>';
    for (let i = b.s + 2; i <= b.e; i++) {
      const cells = splitRow(L[i]);
      h += '<tr>';
      for (let k = 0; k < head.length; k++) h += '<td' + st(k) + '>' + inline(cells[k] || '', ctx) + '</td>';
      h += '</tr>';
    }
    return h + '</tbody></table></div>';
  }
  function listItems(L, s, e) {
    const items = [];
    let i = s;
    while (i <= e) {
      const m = RX.item.exec(L[i]);
      if (!m || RX.hr.test(L[i])) {
        if (items.length) { const last = items[items.length - 1]; last.lines.push(L[i].trim()); last.nos.push(i); }
        i++; continue;
      }
      const markerCols = cols(m[1]);
      const gap = m[3] ? cols(m[3]) : 1;
      const contentIndent = markerCols + m[2].length + (gap >= 1 && gap <= 4 ? gap : 1);
      const it = { line: i, ordered: /\d/.test(m[2]), num: parseInt(m[2], 10), lines: [m[4]], nos: [i] };
      let j = i + 1;
      while (j <= e) {
        const ln = L[j];
        if (!ln.trim()) { it.lines.push(''); it.nos.push(j); j++; continue; }
        if (leadCols(ln) >= contentIndent) { it.lines.push(dedent(ln, contentIndent)); it.nos.push(j); j++; continue; }
        if (RX.item.exec(ln) && !RX.hr.test(ln)) break;
        const prev = it.lines[it.lines.length - 1];
        if (prev.trim() && !startsBlock(L, j, e + 1, true)) { it.lines.push(ln.trim()); it.nos.push(j); j++; continue; }
        break;
      }
      while (it.lines.length > 1 && !it.lines[it.lines.length - 1].trim()) { it.lines.pop(); it.nos.pop(); }
      items.push(it);
      i = j;
      while (i <= e && !L[i].trim()) i++;
    }
    return items;
  }
  function itemsHTML(items, ctx, st, map) {
    let h = '', i = 0;
    while (i < items.length) {
      const ordered = items[i].ordered;
      let j = i;
      while (j < items.length && items[j].ordered === ordered) j++;
      const group = items.slice(i, j);
      const tasks = group.some(it => TASK_RX.test(it.lines[0]));
      h += ordered ? '<ol' + (group[0].num !== 1 ? ' start="' + group[0].num + '"' : '') + '>' : '<ul' + (tasks ? ' class="contains-task"' : '') + '>';
      for (const it of group) h += itemHTML(it, ctx, st, map);
      h += ordered ? '</ol>' : '</ul>';
      i = j;
    }
    return h;
  }
  function itemHTML(it, ctx, st, map) {
    const line = abs(map, it.line);
    let first = it.lines[0], task = null;
    const tm = TASK_RX.exec(first);
    if (tm) { task = tm[1]; first = first.slice(tm[0].length); }
    const IL = [first].concat(it.lines.slice(1));
    const IM = it.nos.map(no => abs(map, no));
    const body = renderBlocks(IL, IM, ctx, st, true);
    if (task !== null) {
      const done = task !== ' ';
      return '<li class="task' + (done ? ' done' : '') + '" data-line="' + line + '" data-task="' + esc(task) + '"><input type="checkbox" class="task-box" data-line="' +
        line + '"' + (done ? ' checked' : '') + ' tabindex="-1">' + body + '</li>';
    }
    return '<li data-line="' + line + '">' + body + '</li>';
  }

  // ---------- defaults so the renderer works on its own ----------
  function propValueDefault(v) {
    if (Array.isArray(v)) return v.map(x => '<span class="chip">' + esc(x) + '</span>').join(' ');
    return esc(v == null ? '' : v);
  }
  const defaultCtx = {
    wikilink(inner, embed) {
      const w = parseWiki(inner);
      const label = w.alias || (w.target + (w.heading ? ' > ' + w.heading : ''));
      return '<a class="wl' + (embed ? ' embed-link' : '') + '" data-target="' + esc(w.target) + '" href="#">' + esc(label) + '</a>';
    },
    link(dest, html) {
      return /^(https?:|mailto:)/i.test(dest) ? '<a class="ext" href="' + esc(dest) + '">' + html + '</a>' : '<a class="wl" data-target="' + esc(dest) + '" href="#">' + html + '</a>';
    },
    image(dest, alt) { /* groky r89: lazy, async decode, click to view full size */ return /^https?:/i.test(dest) ? '<img src="' + esc(dest) + '" alt="' + esc(alt) + '" loading="lazy" decoding="async" data-shot="' + esc(dest) + '" data-cap="' + esc(alt) + '">' : esc(alt); },
    tag(t) { return '<a class="tag" data-tag="' + esc(t) + '" href="#">#' + esc(t) + '</a>'; },
    props(fm) {
      const rows = Object.keys(fm).map(k => '<div class="prop"><span class="prop-k">' + esc(k) + '</span><span class="prop-v">' + propValueDefault(fm[k]) + '</span></div>');
      return rows.length ? '<div class="props">' + rows.join('') + '</div>' : '';
    },
    embedBlock: null,
  };

  // Render a whole note. Returns top-level blocks with their source line ranges.
  function render(text, ctx) {
    ctx = Object.assign({}, defaultCtx, ctx || {});
    const L = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    const out = { blocks: [], headings: [], fm: null, fmEnd: -1, lines: L };
    let start = 0;
    const f = frontmatter(L);
    if (f) {
      out.fm = f.data; out.fmEnd = f.end; start = f.end + 1;
      out.blocks.push({ type: 'props', s: 0, e: f.end, html: ctx.props(f.data, f.raw) });
    }
    const st = { headings: out.headings, ids: Object.create(null) };
    for (const b of parseBlocks(L, start, L.length)) { b.html = renderBlock(L, b, ctx, st, null, false); out.blocks.push(b); }
    out.html = out.blocks.map(b => b.html).join('\n');
    return out;
  }

  // Plain text of a line of markdown (for outlines, snippets and titles).
  function stripMd(s) {
    return String(s)
      .replace(/!?\[\[([^\]\n]+)\]\]/g, (m, inner) => { const w = parseWiki(inner); return w.alias || w.target + (w.heading ? ' > ' + w.heading : ''); })
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/(\*\*|__|~~|==)(.+?)\1/g, '$2')
      .replace(/(^|[^\p{L}\p{N}])[*_]([^*_\s][^*_]*?)[*_](?![\p{L}\p{N}])/gu, '$1$2')
      .replace(/%%.*?%%/g, '')
      .replace(/\s+\^[A-Za-z0-9-]+\s*$/, '')
      .trim();
  }

  // ---------- scanner: links, tags, headings, properties ----------
  const WIKI_G = /(!?)\[\[([^[\]\n]+?)\]\]/g;
  const MDLINK_G = /(!?)\[([^\]\n]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
  const TAG_G = /(^|[\s(])#([\p{L}\p{N}_\-/]+)/gu;
  const WORD_G = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;

  function linksIn(text, line, into) {
    let m;
    WIKI_G.lastIndex = 0;
    while ((m = WIKI_G.exec(text))) { const w = parseWiki(m[2]); w.embed = m[1] === '!'; w.line = line; into.push(w); }
    MDLINK_G.lastIndex = 0;
    while ((m = MDLINK_G.exec(text))) {
      const dest = m[3];
      if (/^[a-z][a-z0-9+.-]*:/i.test(dest) || dest.startsWith('#')) continue;
      let target;
      try { target = decodeURIComponent(dest); } catch (e) { target = dest; }
      const hash = target.indexOf('#');
      const heading = hash !== -1 ? target.slice(hash + 1) : null;
      if (hash !== -1) target = target.slice(0, hash);
      into.push({ target: target.trim(), heading, block: null, alias: m[2] || null, embed: m[1] === '!', line, md: true });
    }
  }
  function scan(text) {
    const L = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    const res = { fm: null, fmEnd: -1, links: [], tags: [], headings: [], words: 0, chars: 0, tasks: 0, done: 0 };
    let i = 0;
    const f = frontmatter(L);
    if (f) {
      res.fm = f.data; res.fmEnd = f.end; i = f.end + 1;
      const ft = f.data.tags != null ? f.data.tags : f.data.tag;
      if (ft != null) for (const t of [].concat(ft)) if (t != null && String(t).trim()) res.tags.push(String(t).trim().replace(/^#/, ''));
      for (let k = 1; k < f.end; k++) if (L[k].includes('[[')) linksIn(L[k], k, res.links);
    }
    let fence = null;
    for (; i < L.length; i++) {
      const line = L[i];
      const fm = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (fence) { if (fm && fm[1][0] === fence[0] && fm[1].length >= fence.length && !line.trim().slice(fm[1].length).trim()) fence = null; continue; }
      if (fm) { fence = fm[1]; continue; }
      const hd = RX.heading.exec(line);
      if (hd) res.headings.push({ level: hd[1].length, text: stripMd(hd[2] || ''), line: i });
      const plain = line.indexOf('`') === -1 ? line : line.replace(/(`+)[^`]*?\1/g, '');
      const noComment = plain.indexOf('%%') === -1 ? plain : plain.replace(/%%.*?%%/g, '');
      if (noComment.includes('[') ) linksIn(noComment, i, res.links);
      if (noComment.includes('#')) {
        let m; TAG_G.lastIndex = 0;
        const body = hd ? noComment.replace(/^ {0,3}#{1,6}\s*/, '') : noComment;
        while ((m = TAG_G.exec(body))) if (/\D/.test(m[2])) res.tags.push(m[2]);
      }
      const tk = /^\s*(?:[-*+]|\d+[.)])\s+\[(.)\]/.exec(line);
      if (tk) { res.tasks++; if (tk[1] !== ' ') res.done++; }
      const words = noComment.match(WORD_G);
      if (words) res.words += words.length;
      res.chars += line.length;
    }
    return res;
  }

  global.MD = { render, scan, inline, parseWiki, parseYaml, frontmatter, splitRow, stripMd, slug, esc, parseBlocks };
})(window);
