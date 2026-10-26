/* Tile to Table's engine: the content registry and its validation, mini-markdown, code highlighting,
 * a seeded RNG, Leitner scheduling, study queues, coverage, mixed rounds, the slide-imaging
 * estimator, and (de)serialization of saved progress. No DOM; the page and the Node tests load the same file.
 * Content files push plain objects onto globalThis.TT_DECKS, TT_SCENARIOS and TT_STORIES before
 * this runs. Attaches to globalThis.TT.
 */
(function (TT) {
  'use strict';

  const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;
  TT.MIN = MIN;
  TT.DAY = DAY;

  // ---------- content registry ----------

  // Every function below takes explicit inputs where it can; these read what the content files loaded.
  TT.decks = () => (globalThis.TT_DECKS || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  TT.cards = (decks) => (decks || TT.decks()).flatMap((d) => (d.cards || []).map((c) => Object.assign({ deck: d.id }, c)));
  TT.scenarios = () => (globalThis.TT_SCENARIOS || []).slice().sort((a, b) => cmp(a.id, b.id));
  TT.stories = () => (globalThis.TT_STORIES || []).slice().sort((a, b) => cmp(a.id, b.id));
  TT.glossary = (decks) => (decks || TT.decks())
    .flatMap((d) => (d.glossary || []).map((g) => ({ term: g.term, def: g.def, deck: d.id })))
    .sort((a, b) => String(a.term).localeCompare(String(b.term), 'en', { sensitivity: 'base' }));

  function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

  // ---------- validation ----------

  TT.LANGS = ['sql', 'python', 'bash', 'yaml', 'json', 'text'];

  const isStr = (v) => typeof v === 'string' && v.trim() !== '';
  const isStrArr = (v, min) => Array.isArray(v) && v.length >= (min || 0) && v.every(isStr);

  /* Check loaded content against the format: ids, required fields, levels, code/language pairs and
   * diagram edges. Returns error strings; empty means clean. Pass { decks, scenarios, stories } to
   * check something other than the loaded globals. */
  TT.validate = function (content) {
    const c = content || {};
    const decks = c.decks || globalThis.TT_DECKS || [];
    const scenarios = c.scenarios || globalThis.TT_SCENARIOS || [];
    const stories = c.stories || globalThis.TT_STORIES || [];
    const errs = [];
    const ids = new Set();
    const claim = (id, where) => {
      if (!isStr(id)) { errs.push(`${where}: missing id`); return false; }
      if (ids.has(id)) errs.push(`${where}: duplicate id ${id}`);
      ids.add(id);
      return true;
    };
    const need = (o, keys, where) => { for (const k of keys) if (!isStr(o[k])) errs.push(`${where}: missing ${k}`); };
    const needArr = (o, keys, where, min) => {
      for (const k of keys) if (!isStrArr(o[k], min)) errs.push(`${where}: ${k} must be ${min ? 'a non-empty' : 'an'} array of strings`);
    };
    const optArr = (o, keys, where) => { for (const k of keys) if (o[k] != null && !isStrArr(o[k])) errs.push(`${where}: ${k} must be an array of strings`); };
    const pairs = (o, key, fields, where) => {
      if (!Array.isArray(o[key]) || !o[key].length) { errs.push(`${where}: ${key} must be a non-empty array`); return; }
      o[key].forEach((x, i) => { for (const f of fields) if (!x || !isStr(x[f])) errs.push(`${where}: ${key}[${i}] missing ${f}`); });
    };

    for (const d of decks) {
      const dw = `deck ${d && d.id}`;
      if (!d || !claim(d.id, 'deck')) continue;
      if (!/^[a-z][a-z0-9]*$/.test(d.id)) errs.push(`${dw}: id must be lowercase letters and digits`);
      need(d, ['title', 'blurb'], dw);
      if (typeof d.order !== 'number') errs.push(`${dw}: order must be a number`);
      if (!Array.isArray(d.cards)) { errs.push(`${dw}: cards must be an array`); continue; }
      const re = new RegExp(`^${d.id}-\\d{2}$`);
      for (const card of d.cards) {
        const w = `card ${card && card.id}`;
        if (!card || !claim(card.id, `${dw} card`)) continue;
        if (!re.test(card.id)) errs.push(`${w}: id must look like ${d.id}-NN`);
        need(card, ['topic', 'q', 'a'], w);
        if (![1, 2, 3].includes(card.level)) errs.push(`${w}: level must be 1, 2 or 3`);
        for (const [body, lang] of [['setup', 'setupLang'], ['code', 'codeLang']]) {
          const hasBody = card[body] != null, hasLang = card[lang] != null;
          if (hasBody && !isStr(card[body])) errs.push(`${w}: ${body} must be a non-empty string`);
          if (hasBody !== hasLang) errs.push(`${w}: ${lang} is required if and only if ${body} is set`);
          if (hasLang && !TT.LANGS.includes(card[lang])) errs.push(`${w}: ${lang} must be one of ${TT.LANGS.join(', ')}`);
        }
        needArr(card, ['points'], w, 1);
        optArr(card, ['followups', 'pitfalls'], w);
      }
      if (d.glossary != null) {
        if (!Array.isArray(d.glossary)) errs.push(`${dw}: glossary must be an array`);
        else d.glossary.forEach((g, i) => need(g || {}, ['term', 'def'], `${dw} glossary[${i}]`));
      }
    }

    for (const s of scenarios) {
      const w = `scenario ${s && s.id}`;
      if (!s || !claim(s.id, 'scenario')) continue;
      if (!/^sd-\d{2}$/.test(s.id)) errs.push(`${w}: id must look like sd-NN`);
      need(s, ['title', 'prompt'], w);
      if (![1, 2, 3].includes(s.level)) errs.push(`${w}: level must be 1, 2 or 3`);
      if (!(s.minutes > 0)) errs.push(`${w}: minutes must be a positive number`);
      needArr(s, ['clarify', 'assumptions', 'rubric', 'redFlags'], w, 1);
      const nodeIds = new Set();
      if (!Array.isArray(s.nodes) || !s.nodes.length) errs.push(`${w}: nodes must be a non-empty array`);
      else {
        for (const n of s.nodes) {
          if (!n || !isStr(n.id)) { errs.push(`${w}: node missing id`); continue; }
          if (nodeIds.has(n.id)) errs.push(`${w}: duplicate node ${n.id}`);
          nodeIds.add(n.id);
          if (!isStr(n.label)) errs.push(`${w}: node ${n.id} missing label`);
          if (!Number.isInteger(n.col) || n.col < 0) errs.push(`${w}: node ${n.id} col must be an integer >= 0`);
          if (n.note != null && typeof n.note !== 'string') errs.push(`${w}: node ${n.id} note must be a string`);
        }
      }
      if (!Array.isArray(s.edges)) errs.push(`${w}: edges must be an array`);
      else {
        s.edges.forEach((e, i) => {
          if (!Array.isArray(e) || e.length < 2) { errs.push(`${w}: edge ${i} must be [from, to, label?]`); return; }
          for (const end of [e[0], e[1]]) if (!nodeIds.has(end)) errs.push(`${w}: edge ${i} references unknown node ${end}`);
          if (e[2] != null && typeof e[2] !== 'string') errs.push(`${w}: edge ${i} label must be a string`);
        });
      }
      pairs(s, 'components', ['name', 'why'], w);
      pairs(s, 'deepDives', ['q', 'a'], w);
      pairs(s, 'tradeoffs', ['choice', 'pro', 'con'], w);
    }

    for (const st of stories) {
      const w = `story ${st && st.id}`;
      if (!st || !claim(st.id, 'story')) continue;
      if (!/^st-\d{2}$/.test(st.id)) errs.push(`${w}: id must look like st-NN`);
      need(st, ['theme', 'prompt'], w);
      needArr(st, ['listenFor', 'pitfalls'], w, 1);
      optArr(st, ['variants'], w);
    }

    return errs;
  };

  // ---------- mini-markdown ----------

  TT.esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

  // Inline code is set aside first, so asterisks inside backticks stay literal and bold can wrap code.
  function inline(s) {
    const code = [];
    return s.replace(/`([^`]+)`/g, (m, c) => `\u0000${code.push(c) - 1}\u0000`)
      .replace(/\*\*(?=\S)([^*]+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\u0000(\d+)\u0000/g, (m, i) => `<code>${code[i]}</code>`);
  }

  /* Paragraphs split on blank lines; runs of "- " or "1. " lines become lists, even when they follow
   * a line of text in the same paragraph. Everything is escaped before any markup is added. NUL is
   * stripped first, as inline() uses it to mark where code spans go. */
  TT.md = function (str) {
    const out = [];
    for (const block of TT.esc(str).replace(/\u0000/g, '').replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/)) {
      let text = [], list = null;
      const flushText = () => { if (text.length) out.push(`<p>${text.map(inline).join(' ')}</p>`); text = []; };
      const flushList = () => { if (list) out.push(`<${list.tag}>${list.items.map((x) => `<li>${inline(x)}</li>`).join('')}</${list.tag}>`); list = null; };
      for (const raw of block.split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        const ul = /^- +(.*)$/.exec(line), ol = /^\d+\. +(.*)$/.exec(line);
        const tag = ul ? 'ul' : ol ? 'ol' : null;
        if (tag) {
          flushText();
          if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
          list.items.push((ul || ol)[1]);
        } else if (list && /^\s{2,}/.test(raw)) {
          list.items[list.items.length - 1] += ' ' + line; // an indented continuation of the last item
        } else {
          flushList();
          text.push(line);
        }
      }
      flushText();
      flushList();
    }
    return out.join('');
  };

  // ---------- code highlighting ----------

  // Non-capturing groups: highlight() wraps these in its own group to split on them.
  const KW = {
    sql: /\b(?:SELECT|FROM|WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|FULL|CROSS|ON|GROUP|BY|ORDER|HAVING|LIMIT|WITH|AS|AND|OR|NOT|IN|IS|NULL|CASE|WHEN|THEN|ELSE|END|OVER|PARTITION|ROWS|RANGE|BETWEEN|UNION|ALL|DISTINCT|INSERT|INTO|VALUES|UPDATE|SET|DELETE|MERGE|USING|MATCHED|CREATE|REPLACE|TABLE|VIEW|INDEX|PRIMARY|KEY|REFERENCES|EXISTS|QUALIFY|INTERVAL|ASC|DESC|PRECEDING|FOLLOWING|CURRENT|ROW|UNBOUNDED|FILTER|LATERAL|RECURSIVE|EXPLAIN|ANALYZE|TRUE|FALSE)\b/,
    python: /\b(?:def|return|import|from|as|for|in|if|elif|else|while|with|class|try|except|finally|raise|yield|lambda|None|True|False|and|or|not|is|async|await|pass|break|continue)\b/,
  };
  const KW_SPLIT = Object.fromEntries(Object.entries(KW).map(([k, re]) => [k, new RegExp(`(${re.source})`)]));

  /* A light touch of color for code: keywords and line comments only, as HTML. Works on the raw text
   * and escapes every piece, so nothing from the content is ever injected. A comment marker inside a
   * string literal is taken as a comment too; that only changes the color. */
  TT.highlight = function (code, lang) {
    const kw = KW_SPLIT[lang];
    const cm = lang === 'sql' ? /--/ : ['python', 'bash', 'yaml'].includes(lang) ? /(^|\s)#/ : null;
    return String(code == null ? '' : code).split('\n').map((line) => {
      let body = line, note = '';
      const m = cm && cm.exec(line);
      if (m) { const at = m.index + (m[1] ? m[1].length : 0); body = line.slice(0, at); note = line.slice(at); }
      const hb = kw ? body.split(kw).map((p, i) => (i % 2 ? `<span class="kw">${TT.esc(p)}</span>` : TT.esc(p))).join('') : TT.esc(body);
      return hb + (note ? `<span class="cm">${TT.esc(note)}</span>` : '');
    }).join('\n');
  };

  // Plain text for screen-reader announcements and file exports: no markup, no backticks or asterisks.
  TT.plain = (str) => String(str == null ? '' : str).replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/\s+/g, ' ').trim();

  // ---------- seeded randomness ----------

  // FNV-1a, so string seeds (a date, a deck id) work as well as numbers.
  function seedOf(seed) {
    if (typeof seed === 'number' && Number.isFinite(seed)) return seed >>> 0;
    let h = 2166136261;
    for (const ch of String(seed)) h = Math.imul(h ^ ch.codePointAt(0), 16777619);
    return h >>> 0;
  }

  // mulberry32: small, fast, and plenty for shuffling a deck.
  TT.rng = function (seed) {
    let a = seedOf(seed);
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  // Fisher-Yates on a copy; the input is left alone.
  TT.shuffle = function (arr, rng) {
    const r = rng || Math.random, a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  // ---------- spaced repetition (Leitner) ----------

  TT.GRADES = ['again', 'hard', 'good', 'easy'];
  TT.INTERVALS = [0, DAY, 3 * DAY, 7 * DAY, 16 * DAY, 35 * DAY];
  TT.SOLID = 3; // box 3 and up counts as solid

  /* The next state for one card. Again sends it back to box 1 for ten minutes; hard keeps the box
   * and waits half its interval; good moves up one box, easy two (box 5 is the top). Pure. */
  TT.grade = function (prev, g, now) {
    if (!TT.GRADES.includes(g)) throw new Error(`unknown grade ${g}`);
    const p = prev || { box: 0, seen: 0 };
    const box0 = Math.min(5, Math.max(0, p.box | 0));
    let box, wait;
    if (g === 'again') { box = 1; wait = 10 * MIN; }
    else if (g === 'hard') { box = Math.max(1, box0); wait = Math.max(10 * MIN, TT.INTERVALS[box] / 2); }
    else { box = Math.min(5, box0 + (g === 'good' ? 1 : 2)); wait = TT.INTERVALS[box]; }
    return { box, due: now + wait, seen: (p.seen | 0) + 1, last: g, at: now };
  };

  // How long each grade would wait, for the labels under the grade buttons.
  TT.preview = (prev, now) => Object.fromEntries(TT.GRADES.map((g) => [g, TT.grade(prev, g, now).due - now]));

  // "10 min", "12 hr", "3 days".
  TT.fmtWait = function (ms) {
    if (ms < HOUR) return `${Math.max(1, Math.round(ms / MIN))} min`;
    if (ms < DAY) return `${Math.round(ms / HOUR)} hr`;
    const d = Math.round(ms / DAY);
    return d === 1 ? '1 day' : `${d} days`;
  };

  // ---------- queues, coverage, rounds ----------

  const seen = (p) => !!p && (p.seen | 0) > 0;

  TT.filter = function (cards, o) {
    const opt = o || {};
    const set = (v) => (v && v.length ? new Set(v) : null);
    const decks = set(opt.decks), levels = set(opt.levels), topics = set(opt.topics);
    return cards.filter((c) => (!decks || decks.has(c.deck)) && (!levels || levels.has(c.level)) && (!topics || topics.has(c.topic)));
  };

  // Round-robin across decks, keeping each deck's own order. Decks take turns in order of first appearance.
  function interleave(cards) {
    const groups = new Map();
    for (const c of cards) {
      if (!groups.has(c.deck)) groups.set(c.deck, []);
      groups.get(c.deck).push(c);
    }
    const lists = [...groups.values()], out = [];
    for (let i = 0; out.length < cards.length; i++) for (const l of lists) if (i < l.length) out.push(l[i]);
    return out;
  }

  /* What to study next. Due cards first, most overdue first; then cards never seen, shuffled by
   * the seed and interleaved across decks; then, only with includeNotDue, everything else by how
   * soon it comes due. Options: decks, levels, topics, now, limit, seed, includeNotDue. */
  TT.queue = function (cards, progress, o) {
    const opt = o || {}, prog = progress || {};
    const now = opt.now == null ? Date.now() : opt.now;
    const pool = TT.filter(cards, opt);
    const byDue = (a, b) => prog[a.id].due - prog[b.id].due || cmp(a.id, b.id);
    const due = pool.filter((c) => seen(prog[c.id]) && prog[c.id].due <= now).sort(byDue);
    const fresh = interleave(TT.shuffle(pool.filter((c) => !seen(prog[c.id])), TT.rng(opt.seed == null ? 1 : opt.seed)));
    const rest = opt.includeNotDue ? pool.filter((c) => seen(prog[c.id]) && prog[c.id].due > now).sort(byDue) : [];
    return due.concat(fresh, rest).slice(0, opt.limit == null ? Infinity : opt.limit);
  };

  /* How far along each deck is: total, seen, solid (box >= 3), learning (seen, not solid), unseen,
   * and due now. Returns { decks: { [deckId]: row }, total: row }. */
  TT.coverage = function (cards, progress, now) {
    const prog = progress || {}, t = now == null ? Date.now() : now;
    const row = () => ({ total: 0, seen: 0, solid: 0, learning: 0, unseen: 0, due: 0 });
    const decks = {}, total = row();
    for (const c of cards) {
      const r = decks[c.deck] || (decks[c.deck] = row());
      const p = prog[c.id];
      for (const x of [r, total]) {
        x.total++;
        if (!seen(p)) { x.unseen++; continue; }
        x.seen++;
        if (p.box >= TT.SOLID) x.solid++; else x.learning++;
        if (p.due <= t) x.due++;
      }
    }
    return { decks, total };
  };

  /* n cards for a timed mixed round, spread evenly across decks: each deck is shuffled, the decks
   * take turns in a shuffled order, and decks that run out drop out. */
  TT.round = function (cards, n, seed) {
    const rng = TT.rng(seed == null ? 1 : seed);
    const groups = new Map();
    for (const c of cards) {
      if (!groups.has(c.deck)) groups.set(c.deck, []);
      groups.get(c.deck).push(c);
    }
    const lists = TT.shuffle([...groups.keys()].sort(), rng).map((k) => TT.shuffle(groups.get(k), rng));
    const out = [], want = Math.min(n, cards.length);
    for (let i = 0; out.length < want; i++) for (const l of lists) if (i < l.length && out.length < want) out.push(l[i]);
    return out;
  };

  // ---------- back-of-envelope ----------

  TT.ESTIMATE_DEFAULTS = {
    slidesPerDay: 1500, gbPerSlide: 1.5, scanHours: 16, years: 10, copies: 2,
    width: 100000, height: 80000, tile: 256, tilesPerSec: 400,
  };

  /* Pyramid levels for one image: level 0 is full resolution, and each level halves (rounding up)
   * until the whole image fits in one tile. */
  TT.pyramid = function (width, height, tile) {
    const t = Math.max(1, Math.round(tile));
    let w = Math.max(1, Math.ceil(width)), h = Math.max(1, Math.ceil(height));
    const levels = [];
    for (;;) {
      levels.push({ level: levels.length, width: w, height: h, cols: Math.ceil(w / t), rows: Math.ceil(h / t), tiles: Math.ceil(w / t) * Math.ceil(h / t) });
      if (w <= t && h <= t) return levels;
      w = Math.ceil(w / 2);
      h = Math.ceil(h / 2);
    }
  };

  /* Storage, bandwidth, tile counts and GPU time for a slide-imaging setup. Decimal units
   * (1 TB = 1000 GB), as storage is sold. Pure. */
  TT.estimate = function (inputs) {
    const o = Object.assign({}, TT.ESTIMATE_DEFAULTS, inputs);
    const num = (v, min) => (Number.isFinite(+v) ? Math.max(min, +v) : min);
    const slides = num(o.slidesPerDay, 0), gb = num(o.gbPerSlide, 0), hours = num(o.scanHours, 0.1);
    const years = num(o.years, 0), copies = num(o.copies, 1), tps = num(o.tilesPerSec, 0.001);
    const levels = TT.pyramid(num(o.width, 1), num(o.height, 1), num(o.tile, 1));
    const fullResTiles = levels[0].tiles;
    const tilesPerSlide = levels.reduce((s, l) => s + l.tiles, 0);
    const tbPerDay = (slides * gb) / 1000;
    const gpuHoursPerDay = (slides * fullResTiles) / tps / 3600;
    return {
      tbPerDay,
      tbPerYear: tbPerDay * 365,
      pbRetained: (tbPerDay * 365 * years * copies) / 1000,
      mbPerSec: (slides * gb * 1000) / (hours * 3600),
      levels,
      levelCount: levels.length,
      fullResTiles,
      tilesPerSlide,
      tilesPerDay: slides * tilesPerSlide,
      gpuHoursPerDay,
      gpusAllDay: Math.ceil(gpuHoursPerDay / 24),
    };
  };

  // ---------- saved state ----------

  /* Everything the page keeps: per-card progress, rubric checks per scenario, STAR notes per story,
   * and a few preferences. v is the format version. */
  TT.fresh = () => ({ v: 1, progress: {}, rubric: {}, stories: {}, prefs: {} });

  TT.dump = (state) => JSON.stringify(Object.assign(TT.fresh(), state, { v: 1 }));

  const plainObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  // Keys copied out of saved JSON: content-style ids only, so "__proto__" and the like never land.
  const okKey = (k) => /^[A-Za-z0-9][\w-]{0,63}$/.test(k);

  /* Parse saved state. Anything that isn't a v1 object comes back as a fresh state; progress for
   * card ids not in `cardIds` (default: the loaded cards) is dropped, as are malformed entries. */
  TT.load = function (str, cardIds) {
    let raw;
    try { raw = JSON.parse(str); } catch (e) { return TT.fresh(); }
    if (!plainObj(raw) || raw.v !== 1) return TT.fresh();
    const known = new Set(cardIds || TT.cards().map((c) => c.id));
    const st = TT.fresh();
    if (plainObj(raw.progress)) {
      for (const [id, p] of Object.entries(raw.progress)) {
        if (!known.has(id) || !plainObj(p)) continue;
        if (!Number.isInteger(p.box) || p.box < 0 || p.box > 5 || !Number.isFinite(p.due)) continue;
        st.progress[id] = {
          box: p.box,
          due: p.due,
          seen: Number.isInteger(p.seen) && p.seen >= 0 ? p.seen : 1,
          last: TT.GRADES.includes(p.last) ? p.last : null,
          at: Number.isFinite(p.at) ? p.at : 0,
        };
      }
    }
    if (plainObj(raw.rubric)) {
      for (const [id, r] of Object.entries(raw.rubric)) {
        if (okKey(id) && plainObj(r) && Array.isArray(r.checked)) {
          // Each item once, so a repeated index can't inflate the score.
          const checked = [...new Set(r.checked.filter((i) => Number.isInteger(i) && i >= 0 && i < 1000))];
          st.rubric[id] = { checked, at: Number.isFinite(r.at) ? r.at : 0 };
        }
      }
    }
    if (plainObj(raw.stories)) {
      for (const [id, n] of Object.entries(raw.stories)) {
        if (!okKey(id) || !plainObj(n)) continue;
        const note = {};
        for (const k of ['s', 't', 'a', 'r']) note[k] = typeof n[k] === 'string' ? n[k] : '';
        st.stories[id] = note;
      }
    }
    // Preferences are one object per view; the page checks each field before using it.
    if (plainObj(raw.prefs)) for (const [k, v] of Object.entries(raw.prefs)) if (okKey(k) && plainObj(v)) st.prefs[k] = v;
    return st;
  };

  // ---------- story notes export ----------

  /* All stories as one Markdown file: the prompt, then whatever S / T / A / R notes exist. */
  TT.storiesMd = function (stories, notes, date) {
    const n = notes || {};
    const lines = ['# Tile to Table: story notes', ''];
    if (date) lines.push(`Exported ${date}.`, '');
    const parts = [['s', 'Situation'], ['t', 'Task'], ['a', 'Action'], ['r', 'Result']];
    for (const s of stories) {
      lines.push(`## ${s.id} · ${TT.plain(s.theme)}`, '', `> ${TT.plain(s.prompt)}`, '');
      const note = n[s.id] || {};
      const any = parts.some(([k]) => (note[k] || '').trim());
      if (!any) { lines.push('_No notes yet._', ''); continue; }
      for (const [k, label] of parts) {
        const v = (note[k] || '').trim();
        if (v) lines.push(`**${label}.** ${v}`, '');
      }
    }
    return lines.join('\n');
  };
})(globalThis.TT = globalThis.TT || {});
