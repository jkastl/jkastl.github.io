/* Tile to Table's page: hash-routed views for the overview, drill, timed round, system design,
 * stories and glossary. Scheduling, validation, markdown and the estimator live in js/engine.js;
 * this file only draws, wires up the controls, and keeps state in localStorage (when it can).
 */
(function () {
  'use strict';
  const TT = globalThis.TT;
  const $ = (id) => document.getElementById(id);
  const esc = TT.esc, md = TT.md;
  const KEY = 'tt.v1';
  const fmtInt = (n) => Math.round(n).toLocaleString('en-US');
  const fmt = (n, d) => n.toLocaleString('en-US', { maximumFractionDigits: d });
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const smooth = () => (reduced.matches ? 'auto' : 'smooth');

  // ---------------------------------------------------------------- content
  const DECKS = TT.decks().map((d, i) => Object.assign({ color: `var(--s${(i % 6) + 1})` }, d));
  const deckById = new Map(DECKS.map((d) => [d.id, d]));
  const CARDS = TT.cards(DECKS);
  const SCENS = TT.scenarios();
  const STORIES = TT.stories();
  const GLOSS = TT.glossary(DECKS);
  const LEVELS = { 1: 'fundamentals', 2: 'working depth', 3: 'senior depth' };
  const GRADE_LABEL = { again: 'Again', hard: 'Hard', good: 'Good', easy: 'Easy' };
  {
    const errs = TT.validate();
    if (errs.length) console.warn(`Tile to Table: ${errs.length} content problems\n${errs.join('\n')}`);
  }

  // ---------------------------------------------------------------- storage
  // Every access is wrapped: private windows, blocked storage and full quotas all throw.
  let storeOk = true;
  try {
    localStorage.setItem(KEY + '.probe', '1');
    localStorage.removeItem(KEY + '.probe');
  } catch (e) { storeOk = false; }
  let state = TT.fresh();
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) state = TT.load(raw, CARDS.map((c) => c.id));
  } catch (e) { storeOk = false; }
  function save() {
    try { localStorage.setItem(KEY, TT.dump(state)); storeOk = true; } catch (e) { storeOk = false; }
    $('no-store').hidden = storeOk;
  }
  const prefs = (k) => (state.prefs[k] && typeof state.prefs[k] === 'object' ? state.prefs[k] : {});

  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  // Clear first, so the same sentence twice is still read out.
  function announce(id, text) {
    const el = $(id);
    el.textContent = '';
    setTimeout(() => { el.textContent = text; }, 60);
  }

  // ---------------------------------------------------------------- small pieces
  const codeBlock = (code, lang, cap) => `
    <figure class="codefig">
      <figcaption><span>${esc(cap)}</span><span class="lang">${esc(lang)}</span></figcaption>
      <pre class="code" tabindex="0" aria-label="${esc(cap)}, ${esc(lang)}">${TT.highlight(code, lang)}</pre>
    </figure>`;
  const bullets = (items, cls) => (items && items.length ? `<ul class="${cls || 'blist'}">${items.map((x) => `<li>${md(x)}</li>`).join('')}</ul>` : '');
  const deckTag = (id) => { const d = deckById.get(id); return d ? `<span class="tag deck" style="--deck:${d.color}">${esc(d.title)}</span>` : ''; };
  const clip = (s, n) => { const t = TT.plain(s); return t.length > n ? t.slice(0, n - 1).replace(/\s+\S*$/, '').replace(/[\s.,;:]+$/, '') + '…' : t; };

  const tip = $('tip');
  function showTip(html, x, y) {
    tip.innerHTML = html;
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    tip.style.left = Math.max(8, Math.min(window.innerWidth - r.width - 8, x + 14)) + 'px';
    tip.style.top = Math.max(8, y - r.height - 12) + 'px';
  }
  const hideTip = () => { tip.hidden = true; };

  // ---------------------------------------------------------------- countdowns
  const clock = (ms) => { const s = Math.ceil(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

  /* A countdown that keeps a deadline rather than counting ticks, so a throttled background tab
   * doesn't slow it down. onTick gets the time left; onDone fires once at zero. */
  function countdown(total, onTick, onDone) {
    let left = total, deadline = 0, iv = 0;
    const tick = () => {
      const l = Math.max(0, deadline - Date.now());
      onTick(l, total);
      if (l <= 0) { clearInterval(iv); iv = 0; left = 0; if (onDone) onDone(); }
    };
    return {
      get running() { return !!iv; },
      get left() { return iv ? Math.max(0, deadline - Date.now()) : left; },
      start() { if (iv || left <= 0) return; deadline = Date.now() + left; iv = setInterval(tick, 250); tick(); },
      pause() { if (!iv) return; left = Math.max(0, deadline - Date.now()); clearInterval(iv); iv = 0; onTick(left, total); },
      reset() { if (iv) clearInterval(iv); iv = 0; left = total; onTick(left, total); },
    };
  }

  /* The clock widget used by design scenarios and stories: time, a thin bar, Start/Pause and Reset.
   * Milestones are announced through a polite live region, not every second. */
  function timerWidget(host, minutes, liveId, label) {
    const total = minutes * 60000;
    host.innerHTML = `
      <div class="timer">
        <span class="clock" role="timer" aria-label="${esc(label)}">${clock(total)}</span>
        <span class="tbar" aria-hidden="true"><i></i></span>
        <button type="button" class="btn primary" data-t="go">Start</button>
        <button type="button" class="btn ghost" data-t="reset">Reset</button>
      </div>`;
    const el = host.querySelector('.timer'), face = el.querySelector('.clock'), bar = el.querySelector('.tbar i'), go = el.querySelector('[data-t="go"]');
    // At most one message per moment: on a two-minute clock, halfway is also one minute left.
    const marks = [[5 * 60000, 'Five minutes left.'], [60000, 'One minute left.'], [total / 2, 'Halfway.']]
      .filter(([t], i, all) => t < total && t >= 60000 && all.findIndex(([u]) => u === t) === i);
    let prev = total;
    const t = countdown(total, (l) => {
      face.textContent = clock(l);
      bar.style.width = `${(100 * l) / total}%`;
      el.classList.toggle('low', l > 0 && l <= Math.min(60000, total / 4));
      el.classList.toggle('out', l <= 0);
      for (const [at, msg] of marks) if (prev > at && l <= at && l > 0) announce(liveId, msg);
      prev = l;
    }, () => { announce(liveId, 'Time is up.'); go.textContent = 'Start'; go.disabled = true; });
    go.addEventListener('click', () => {
      if (t.running) { t.pause(); go.textContent = 'Continue'; } else { t.start(); go.textContent = 'Pause'; }
    });
    el.querySelector('[data-t="reset"]').addEventListener('click', () => { t.reset(); prev = total; go.disabled = false; go.textContent = 'Start'; });
    return { pause() { if (t.running) { t.pause(); go.textContent = 'Continue'; } } };
  }

  // ---------------------------------------------------------------- the card
  /* One practice card: prompt, optional setup code, a scratch answer box, then the model answer and
   * grade buttons. Shared by the drill and the timed round. Options: prefix (for ids), status (HTML),
   * onReveal, onGrade(g, checked), onSkip, skipLabel. */
  function cardView(host, card, o) {
    const d = deckById.get(card.deck), p = o.prefix;
    const wait = TT.preview(state.progress[card.id], Date.now());
    host.innerHTML = `
      <article class="panel qcard" style="--deck:${d.color}" aria-labelledby="${p}-q">
        <div class="qmeta">
          ${deckTag(card.deck)}
          <span class="tag">${esc(card.topic)}</span>
          <span class="tag lvl" title="${esc(LEVELS[card.level])}">Level ${esc(card.level)}</span>
          <span class="qstate">${o.status || ''}</span>
        </div>
        <div class="q prose" id="${p}-q" tabindex="-1">${md(card.q)}</div>
        ${card.setup ? codeBlock(card.setup, card.setupLang, 'Setup') : ''}
        <div class="ans-wrap">
          <label class="lbl" for="${p}-ans">Your answer (optional, not saved)</label>
          <textarea class="input ans" id="${p}-ans" rows="3"></textarea>
        </div>
        <div class="answer" id="${p}-answer" tabindex="-1" role="region" aria-labelledby="${p}-answer-h" hidden>
          <h3 class="alabel" id="${p}-answer-h">Model answer</h3>
          <div class="prose">${md(card.a)}</div>
          ${card.code ? codeBlock(card.code, card.codeLang, 'Reference code') : ''}
          <fieldset class="points">
            <legend class="alabel">Key points <span class="hint">tick what you covered</span></legend>
            ${(card.points || []).map((pt, i) => `<label class="pt"><input type="checkbox" data-pt="${i}"><span class="prose">${md(pt)}</span></label>`).join('')}
          </fieldset>
          <div class="extras">
            ${card.pitfalls && card.pitfalls.length ? `<div class="extra pit"><h3 class="alabel">Pitfalls</h3>${bullets(card.pitfalls)}</div>` : ''}
            ${card.followups && card.followups.length ? `<div class="extra fu"><h3 class="alabel">Follow-ups</h3>${bullets(card.followups)}</div>` : ''}
          </div>
        </div>
        <div class="actbar">
          <div class="pre">
            <button type="button" class="btn primary" data-act="reveal">Reveal <kbd>Space</kbd></button>
            <button type="button" class="btn ghost" data-act="skip">${esc(o.skipLabel || 'Skip')}</button>
          </div>
          <div class="grades" role="group" aria-label="Grade your answer" hidden>
            ${TT.GRADES.map((g, i) => `
              <button type="button" class="gbtn g-${g}" data-grade="${g}" aria-label="${GRADE_LABEL[g]}: next review in ${TT.fmtWait(wait[g])}">
                <span class="g-l">${GRADE_LABEL[g]} <kbd>${i + 1}</kbd></span>
                <span class="g-i">${TT.fmtWait(wait[g])}</span>
              </button>`).join('')}
          </div>
        </div>
      </article>`;
    const art = host.querySelector('article'), ans = art.querySelector('.answer');
    const ctl = {
      card,
      el: art,
      revealed: false,
      reveal(fromTimer) {
        if (ctl.revealed) return;
        ctl.revealed = true;
        ans.hidden = false;
        ans.classList.add('in');
        art.querySelector('.pre').hidden = true;
        art.querySelector('.grades').hidden = false;
        art.classList.add('revealed');
        // When the clock reveals it, leave the cursor where it is if they are still typing.
        const typing = fromTimer && art.contains(document.activeElement) && document.activeElement.tagName === 'TEXTAREA';
        if (!typing) {
          ans.focus({ preventScroll: true });
          ans.scrollIntoView({ block: 'nearest', behavior: smooth() });
        }
        if (o.onReveal) o.onReveal(fromTimer);
      },
      checked: () => [...art.querySelectorAll('[data-pt]')].filter((x) => x.checked).map((x) => +x.dataset.pt),
      grade(g) { if (ctl.revealed && o.onGrade) o.onGrade(g, ctl.checked()); },
      focus() {
        art.querySelector('.q').focus({ preventScroll: true });
        if (art.getBoundingClientRect().top < 60) art.scrollIntoView({ block: 'start', behavior: smooth() });
      },
    };
    art.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.act === 'reveal') ctl.reveal();
      else if (b.dataset.act === 'skip' && o.onSkip) o.onSkip();
      else if (b.dataset.grade) ctl.grade(b.dataset.grade);
    });
    return ctl;
  }

  function cardStatus(card, now) {
    const p = state.progress[card.id];
    if (!p || !p.seen) return '<span class="st st-new">New</span>';
    const box = `<span class="st-box">box ${p.box} of 5</span>`;
    if (p.due <= now) return `<span class="st st-due">Due</span> ${box}`;
    return `<span class="st">Due in ${TT.fmtWait(p.due - now)}</span> ${box}`;
  }

  // ================================================================ Overview
  function renderOverview() {
    const now = Date.now();
    const cov = TT.coverage(CARDS, state.progress, now);
    const t = cov.total;
    const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);
    const stat = (label, value, note) => `<div class="stat"><span class="stat-label">${label}</span><span class="stat-value">${value}</span>${note ? `<span class="stat-note">${note}</span>` : ''}</div>`;
    $('ov-stats').innerHTML = [
      stat('Cards', fmtInt(t.total), `${DECKS.length} decks`),
      stat('Seen', fmtInt(t.seen), `${pct(t.seen, t.total)}% of all cards`),
      stat('Solid', fmtInt(t.solid), 'box 3 or higher'),
      stat('Due now', fmtInt(t.due), t.due ? 'start with these' : 'nothing waiting'),
      stat('Design scenarios', fmtInt(SCENS.length), `${Object.keys(state.rubric).filter((id) => SCENS.some((s) => s.id === id)).length} scored`),
      stat('Stories', fmtInt(STORIES.length), `${STORIES.filter((s) => hasNotes(s.id)).length} with notes`),
    ].join('');
    $('ov-legend').innerHTML = '<span><i class="sw sw-solid"></i>Solid</span><span><i class="sw sw-learn"></i>Learning</span><span><i class="sw sw-unseen"></i>Unseen</span>';
    $('ov-decks').innerHTML = DECKS.map((d) => {
      const r = cov.decks[d.id] || { total: 0, seen: 0, solid: 0, learning: 0, unseen: 0, due: 0 };
      const topics = new Set(d.cards.map((c) => c.topic)).size;
      const w = (n) => (r.total ? (100 * n) / r.total : 0);
      return `
        <article class="panel deck-tile" style="--deck:${d.color}" aria-labelledby="dk-${esc(d.id)}">
          <div class="dt-head">
            <h3 id="dk-${esc(d.id)}">${esc(d.title)}</h3>
            <span class="dt-n">${fmtInt(r.total)} cards · ${topics} topics</span>
          </div>
          <p class="dt-blurb">${esc(TT.plain(d.blurb))}</p>
          <div class="sbar" aria-hidden="true"><i class="b-solid" style="width:${w(r.solid)}%"></i><i class="b-learn" style="width:${w(r.learning)}%"></i></div>
          <p class="sbar-n"><span><i class="sw sw-solid"></i>${r.solid} solid</span><span><i class="sw sw-learn"></i>${r.learning} learning</span><span><i class="sw sw-unseen"></i>${r.unseen} unseen</span></p>
          <div class="dt-foot">
            <span class="${r.due ? 'tag warn' : 'dt-none'}">${r.due ? `${r.due} due` : 'Nothing due'}</span>
            <button type="button" class="btn" data-drill="${esc(d.id)}" aria-label="Drill the ${esc(d.title)} deck">Drill this deck</button>
          </div>
        </article>`;
    }).join('');
    $('ov-design-s').textContent = `${SCENS.length} whiteboard problems with a reference flow and a rubric.`;
    $('ov-stories-s').textContent = `${STORIES.length} prompts about past work, with Situation, Task, Action, Result notes.`;
    return $('overview-h');
  }

  $('ov-decks').addEventListener('click', (e) => {
    const b = e.target.closest('[data-drill]');
    if (!b) return;
    Object.assign(drill, { decks: [b.dataset.drill], level: 0, topic: '', practice: false, current: null });
    saveDrillPrefs();
    location.hash = '#drill';
  });

  function dataMsg(text, kind) {
    const m = $('data-msg');
    m.className = `msg ${kind || ''}`;
    m.textContent = text;
    m.hidden = false;
  }
  $('export').addEventListener('click', () => {
    download(`tile-to-table-progress-${today()}.json`, TT.dump(state), 'application/json');
    dataMsg(`Exported progress for ${Object.keys(state.progress).length} cards.`, 'good');
  });
  $('import-file').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    let text = '', raw = null;
    try { text = await file.text(); raw = JSON.parse(text); } catch (err) { raw = null; }
    if (!raw || typeof raw !== 'object' || raw.v !== 1) return dataMsg("That file isn't a Tile to Table export, so nothing changed.", 'bad');
    state = TT.load(text, CARDS.map((c) => c.id));
    save();
    drill.current = null;
    renderOverview();
    dataMsg(`Imported progress for ${Object.keys(state.progress).length} cards, ${Object.keys(state.rubric).length} rubric scores and ${Object.keys(state.stories).length} sets of story notes.`, 'good');
  });
  $('reset').addEventListener('click', () => {
    if (!window.confirm('Reset all progress, rubric scores and story notes on this device? This cannot be undone. Export first if you want a copy.')) return;
    state = TT.fresh();
    save();
    Object.assign(drill, { decks: [], level: 0, topic: '', current: null, practice: false });
    renderOverview();
    dataMsg('Everything is reset.', '');
  });

  // ================================================================ Drill
  const dp = prefs('drill');
  const drill = {
    decks: Array.isArray(dp.decks) ? dp.decks.filter((id) => deckById.has(id)) : [],
    level: [0, 1, 2, 3].includes(dp.level) ? dp.level : 0,
    topic: typeof dp.topic === 'string' ? dp.topic : '',
    seed: Date.now() % 1e9,
    practice: false,
    current: null,
    skipped: new Set(),
    counts: { again: 0, hard: 0, good: 0, easy: 0 },
    ctl: null,
  };
  function saveDrillPrefs() {
    state.prefs.drill = { decks: drill.decks, level: drill.level, topic: drill.topic };
    save();
  }
  const drillOpts = () => ({ decks: drill.decks, levels: drill.level ? [drill.level] : [], topics: drill.topic ? [drill.topic] : [] });

  function renderFilters() {
    $('f-decks').innerHTML = `<button type="button" class="chip" data-deck="" aria-pressed="${!drill.decks.length}">All decks</button>` +
      DECKS.map((d) => `<button type="button" class="chip" data-deck="${esc(d.id)}" style="--deck:${d.color}" aria-pressed="${drill.decks.includes(d.id)}"><i class="dot"></i>${esc(d.title)}</button>`).join('');
    $('f-level').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.level === drill.level)));
    // Topics from the chosen decks and level; a topic that no longer applies falls back to all.
    const pool = TT.filter(CARDS, { decks: drill.decks, levels: drill.level ? [drill.level] : [] });
    const topics = new Map();
    for (const c of pool) topics.set(c.topic, (topics.get(c.topic) || 0) + 1);
    if (drill.topic && !topics.has(drill.topic)) drill.topic = '';
    $('f-topic').innerHTML = `<option value="">All topics (${pool.length})</option>` +
      [...topics].sort((a, b) => a[0].localeCompare(b[0])).map(([t, n]) => `<option value="${esc(t)}"${t === drill.topic ? ' selected' : ''}>${esc(t)} (${n})</option>`).join('');
    const cov = TT.coverage(TT.filter(CARDS, drillOpts()), state.progress, Date.now()).total;
    $('f-sum').innerHTML = `<strong>${cov.total}</strong> cards match · <strong>${cov.due}</strong> due · <strong>${cov.unseen}</strong> new`;
  }

  function renderSession() {
    const c = drill.counts, n = c.again + c.hard + c.good + c.easy;
    $('drill-session').innerHTML = n
      ? `<strong>${n}</strong> graded this session <span class="sess-b">${TT.GRADES.map((g) => `<span class="sg sg-${g}">${c[g]} ${g}</span>`).join('')}</span>`
      : 'Nothing graded yet this session';
  }

  function pickNext() {
    const q = TT.queue(CARDS, state.progress, Object.assign(drillOpts(), { now: Date.now(), seed: drill.seed, includeNotDue: drill.practice }));
    const cur = drill.current && drill.current.id;
    let next = q.find((c) => c.id !== cur && !drill.skipped.has(c.id));
    if (!next && drill.skipped.size) {
      drill.skipped.clear();
      next = q.find((c) => c.id !== cur);
    }
    // The only card left is the one just shown (skipped, or practising): show it again rather than nothing.
    return next || q.find((c) => c.id === cur) || null;
  }

  function showDrillCard(focus) {
    renderFilters();
    renderSession();
    const host = $('drill-card');
    const card = drill.current;
    if (!card) {
      drill.ctl = null;
      const any = TT.filter(CARDS, drillOpts()).length;
      host.innerHTML = `
        <div class="panel empty">
          <p class="empty-t">${any ? 'Nothing due here right now.' : CARDS.length ? 'No cards match these filters.' : 'No cards are loaded.'}</p>
          <p class="empty-s">${any ? "You've seen every card in this selection and none are due yet. Come back later, widen the filters, or keep going with cards that aren't due." : 'Try a different deck, level or topic.'}</p>
          <div class="controls">
            ${any ? '<button type="button" class="btn primary" data-act="practice">Practice cards not yet due</button>' : ''}
            <button type="button" class="btn" data-act="clear">Clear filters</button>
          </div>
        </div>`;
      announce('drill-live', any ? 'Nothing due in this selection.' : 'No cards match these filters.');
      return;
    }
    drill.ctl = cardView(host, card, {
      prefix: 'dr',
      status: cardStatus(card, Date.now()),
      onGrade(g) {
        state.progress[card.id] = TT.grade(state.progress[card.id], g, Date.now());
        save();
        drill.counts[g]++;
        drill.current = pickNext();
        showDrillCard(true);
      },
      onSkip() {
        drill.skipped.add(card.id);
        drill.current = pickNext();
        showDrillCard(true);
      },
    });
    // Moving focus to the prompt reads it out; announce it only when focus stays put (filter changes).
    if (focus) drill.ctl.focus();
    else announce('drill-live', `${deckById.get(card.deck).title}, ${card.topic}. ${clip(card.q, 220)}`);
  }

  $('drill-card').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'practice') { drill.practice = true; drill.current = pickNext(); showDrillCard(true); }
    if (b.dataset.act === 'clear') filtersChanged({ decks: [], level: 0, topic: '' });
  });

  function filtersChanged(patch) {
    Object.assign(drill, patch, { practice: false });
    drill.skipped.clear();
    saveDrillPrefs();
    drill.current = pickNext();
    showDrillCard(false);
  }
  $('f-decks').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const id = b.dataset.deck;
    let decks = id ? (drill.decks.includes(id) ? drill.decks.filter((x) => x !== id) : drill.decks.concat(id)) : [];
    if (decks.length === DECKS.length) decks = [];
    filtersChanged({ decks });
    $('f-decks').querySelector(`[data-deck="${CSS.escape(id)}"]`).focus();
  });
  $('f-level').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) filtersChanged({ level: +b.dataset.level });
  });
  $('f-topic').addEventListener('change', (e) => filtersChanged({ topic: e.target.value }));

  function renderDrill() {
    // Coming back to the drill keeps the card on screen as it was: typed answer, reveal and ticks.
    if (drill.current && drill.ctl && drill.ctl.card === drill.current && $('drill-card').contains(drill.ctl.el)) {
      renderFilters();
      renderSession();
      drill.ctl.el.querySelector('.qstate').innerHTML = cardStatus(drill.current, Date.now());
      return $('drill-h');
    }
    if (!drill.current || !CARDS.some((c) => c.id === drill.current.id)) drill.current = pickNext();
    showDrillCard(false);
    return $('drill-h');
  }

  // ================================================================ Round
  const rp = prefs('round');
  const round = {
    phase: 'setup',
    n: [5, 10, 15].includes(rp.n) ? rp.n : 10,
    mins: [2, 3, 5].includes(rp.mins) ? rp.mins : 3,
    cards: [], i: 0, results: [], timer: null, ctl: null, started: 0,
  };

  function renderRound() {
    const host = $('round-body');
    if (round.phase === 'setup') {
      host.innerHTML = `
        <div class="panel rsetup">
          <div class="rs-row">
            <span class="lbl" id="rs-n-l">Cards</span>
            <div class="seg" role="group" aria-labelledby="rs-n-l" id="rs-n">${[5, 10, 15].map((n) => `<button type="button" data-n="${n}" aria-pressed="${n === round.n}">${n}</button>`).join('')}</div>
          </div>
          <div class="rs-row">
            <span class="lbl" id="rs-m-l">Minutes per card</span>
            <div class="seg" role="group" aria-labelledby="rs-m-l" id="rs-m">${[2, 3, 5].map((m) => `<button type="button" data-m="${m}" aria-pressed="${m === round.mins}">${m}</button>`).join('')}</div>
          </div>
          <p class="rs-sum" id="rs-sum">${round.n} cards, about ${round.n * round.mins} minutes, drawn evenly from ${DECKS.length} decks.</p>
          <button type="button" class="btn primary" id="rs-go"${CARDS.length ? '' : ' disabled'}>Start the round</button>
        </div>`;
      const pick = (id, key, attr) => $(id).addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        round[key] = +b.dataset[attr];
        $(id).querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        $('rs-sum').textContent = `${round.n} cards, about ${round.n * round.mins} minutes, drawn evenly from ${DECKS.length} decks.`;
        state.prefs.round = { n: round.n, mins: round.mins };
        save();
      });
      pick('rs-n', 'n', 'n');
      pick('rs-m', 'mins', 'm');
      $('rs-go').addEventListener('click', startRound);
    } else if (round.phase === 'run') {
      showRoundCard(false);
    } else {
      renderRoundEnd();
    }
    return $('round-h');
  }

  function startRound() {
    Object.assign(round, { phase: 'run', cards: TT.round(CARDS, round.n, Date.now()), i: 0, results: [], started: Date.now() });
    showRoundCard(true);
  }

  function showRoundCard(focus) {
    const card = round.cards[round.i];
    const total = round.mins * 60000;
    $('round-body').innerHTML = `
      <div class="panel rhead">
        <p class="rprog"><span class="lbl">Card</span> <strong>${round.i + 1}</strong> <span class="lbl">of ${round.cards.length}</span></p>
        <div class="rclock">
          <span class="clock" role="timer" aria-label="Time left on this card" id="r-clock">${clock(total)}</span>
          <span class="tbar" aria-hidden="true"><i id="r-bar"></i></span>
        </div>
        <button type="button" class="btn ghost" id="r-end">End round</button>
      </div>
      <div id="r-card"></div>`;
    const head = $('round-body').querySelector('.rhead');
    let prev = total;
    const entry = { card, grade: null, checked: [], used: 0 };
    const stopClock = () => { if (round.timer) { entry.used = total - round.timer.left; round.timer.pause(); } };
    round.timer = countdown(total, (l) => {
      $('r-clock').textContent = clock(l);
      $('r-bar').style.width = `${(100 * l) / total}%`;
      head.classList.toggle('low', l > 0 && l <= 30000);
      head.classList.toggle('out', l <= 0);
      if (prev > 60000 && l <= 60000 && l > 0) announce('round-live', 'One minute left.');
      prev = l;
    }, () => {
      entry.used = total;
      if (round.ctl && !round.ctl.revealed) { round.ctl.reveal(true); announce('round-live', 'Time is up. The answer is showing.'); }
    });
    round.ctl = cardView($('r-card'), card, {
      prefix: 'rc',
      status: cardStatus(card, Date.now()),
      skipLabel: 'Skip',
      onReveal(fromTimer) { if (!fromTimer) stopClock(); },
      onGrade(g, checked) {
        state.progress[card.id] = TT.grade(state.progress[card.id], g, Date.now());
        save();
        Object.assign(entry, { grade: g, checked });
        nextRoundCard(entry);
      },
      onSkip() { stopClock(); entry.grade = 'skipped'; nextRoundCard(entry); },
    });
    $('r-end').addEventListener('click', () => {
      // A card that was revealed but not graded still shows on the summary, as not graded.
      stopClock();
      if (round.ctl.revealed) { entry.checked = round.ctl.checked(); round.results.push(entry); }
      endRound();
    });
    // When focus moves to the prompt it is read out, so the announcement only says where you are.
    announce('round-live', `Card ${round.i + 1} of ${round.cards.length}. ${deckById.get(card.deck).title}.${focus ? '' : ` ${clip(card.q, 200)}`}`);
    round.timer.start();
    if (focus) round.ctl.focus();
  }

  function nextRoundCard(entry) {
    round.results.push(entry);
    round.i++;
    if (round.i < round.cards.length) showRoundCard(true);
    else endRound();
  }
  function endRound() {
    if (round.timer) round.timer.pause();
    round.timer = null;
    round.ctl = null;
    round.phase = 'done';
    renderRoundEnd();
    $('round-h').focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: smooth() });
    announce('round-live', 'Round finished.');
  }

  function renderRoundEnd() {
    const rs = round.results;
    const graded = rs.filter((r) => TT.GRADES.includes(r.grade));
    const pts = graded.reduce((a, r) => [a[0] + r.checked.length, a[1] + (r.card.points || []).length], [0, 0]);
    const used = rs.reduce((a, r) => a + r.used, 0);
    const gradeTag = (g) => (g ? `<span class="tag gt-${g}">${g === 'skipped' ? 'Skipped' : GRADE_LABEL[g]}</span>` : '<span class="tag">Not graded</span>');
    const stat = (label, value, note) => `<div class="stat"><span class="stat-label">${label}</span><span class="stat-value">${value}</span>${note ? `<span class="stat-note">${note}</span>` : ''}</div>`;
    $('round-body').innerHTML = `
      <div class="stats rstats">
        ${stat('Answered', `${graded.length} of ${round.cards.length}`, `${rs.filter((r) => r.grade === 'skipped').length} skipped`)}
        ${stat('Graded again', graded.filter((r) => r.grade === 'again').length, 'back in ten minutes')}
        ${stat('Key points covered', pts[1] ? `${Math.round((100 * pts[0]) / pts[1])}%` : '–', `${pts[0]} of ${pts[1]}`)}
        ${stat('Average time', rs.length ? clock(used / rs.length) : '–', `of ${round.mins}:00 per card`)}
      </div>
      ${rs.length ? `
      <div class="panel">
        <div class="tbl-wrap">
          <table class="compare rtable">
            <thead><tr><th scope="col">#</th><th scope="col">Prompt</th><th scope="col">Grade</th><th scope="col" class="c-wide">Points</th><th scope="col" class="c-wide">Time</th></tr></thead>
            <tbody>${rs.map((r, i) => `
              <tr>
                <td class="num">${i + 1}</td>
                <td><div class="rt-meta">${deckTag(r.card.deck)} <span class="rt-topic">${esc(r.card.topic)}</span></div>${esc(clip(r.card.q, 140))}
                  ${r.checked.length ? `<ul class="rt-pts">${r.checked.map((k) => `<li>${md(r.card.points[k])}</li>`).join('')}</ul>` : ''}</td>
                <td>${gradeTag(r.grade)}<span class="c-narrow">${TT.GRADES.includes(r.grade) ? `${r.checked.length}/${(r.card.points || []).length} points<br>` : ''}${clock(r.used)}</span></td>
                <td class="num c-wide">${TT.GRADES.includes(r.grade) ? `${r.checked.length}/${(r.card.points || []).length}` : '–'}</td>
                <td class="num c-wide">${clock(r.used)}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>` : '<p class="msg">The round ended before any card was answered.</p>'}
      <div class="controls rend">
        <button type="button" class="btn primary" id="r-again">New round</button>
        <a class="btn" href="#drill">Go to the drill</a>
        <a class="btn ghost" href="#overview">Overview</a>
      </div>`;
    $('r-again').addEventListener('click', () => { round.phase = 'setup'; renderRound(); $('rs-go').focus(); });
  }

  // ================================================================ Design
  const SECTIONS = ['Clarify', 'Assumptions', 'Reference flow', 'Components', 'Deep dives', 'Trade-offs', 'Rubric', 'Red flags'];
  const designOpen = {}; // scenario id -> sections revealed, for this visit
  let designTimer = null;

  function rubricScore(s) {
    const r = state.rubric[s.id];
    return r ? r.checked.filter((i) => i < s.rubric.length).length : null;
  }

  function renderDesign(sub) {
    const s = SCENS.find((x) => x.id === sub);
    $('design-list').hidden = !!s;
    $('design-one').hidden = !s;
    if (designTimer) { designTimer.pause(); designTimer = null; }
    hideTip();
    if (!s) {
      renderScenarioList();
      return $('design-h');
    }
    return renderScenario(s);
  }

  function renderScenarioList() {
    $('scen-list').innerHTML = SCENS.length ? SCENS.map((s) => {
      const sc = rubricScore(s);
      return `
        <li>
          <a class="panel scen" href="#design/${esc(s.id)}">
            <span class="scen-top"><span class="scen-id">${esc(s.id)}</span><span class="tag">Level ${esc(s.level)}</span><span class="tag">${esc(s.minutes)} min</span>${sc != null ? `<span class="tag good">Rubric ${sc}/${s.rubric.length}</span>` : ''}</span>
            <span class="scen-t">${esc(s.title)}</span>
            <span class="scen-p">${esc(clip(s.prompt, 150))}</span>
          </a>
        </li>`;
    }).join('') : '<li class="msg">No design scenarios are loaded.</li>';
  }

  function renderScenario(s) {
    const i = SCENS.indexOf(s);
    const prev = SCENS[i - 1], next = SCENS[i + 1];
    const rub = state.rubric[s.id] ? new Set(state.rubric[s.id].checked) : new Set();
    const body = [
      bullets(s.clarify),
      bullets(s.assumptions),
      diagram(s),
      `<dl class="comps">${s.components.map((c) => `<div><dt>${esc(c.name)}</dt><dd class="prose">${md(c.why)}</dd></div>`).join('')}</dl>`,
      `<div class="dives">${s.deepDives.map((d) => `<details class="dive"><summary>${esc(TT.plain(d.q))}</summary><div class="prose">${md(d.a)}</div></details>`).join('')}</div>`,
      `<div class="tbl-wrap"><table class="compare tradeoffs"><thead><tr><th scope="col">Choice</th><th scope="col">For</th><th scope="col">Against, or for the other side</th></tr></thead><tbody>${s.tradeoffs.map((t) => `<tr><th scope="row">${esc(t.choice)}</th><td class="prose">${md(t.pro)}</td><td class="prose">${md(t.con)}</td></tr>`).join('')}</tbody></table></div>`,
      `<fieldset class="points rubric"><legend class="sr-only">Rubric</legend>${s.rubric.map((r, k) => `<label class="pt"><input type="checkbox" data-rub="${k}"${rub.has(k) ? ' checked' : ''}><span class="prose">${md(r)}</span></label>`).join('')}</fieldset><p class="rscore" id="ds-score" aria-live="polite"></p>`,
      bullets(s.redFlags, 'blist flags'),
    ];
    const open = designOpen[s.id] || 0;
    $('design-one').innerHTML = `
      <a class="back" href="#design">← All scenarios</a>
      <div class="sc-head">
        <div class="sc-title">
          <p class="kicker">${esc(s.id)} · Level ${esc(s.level)} · ${esc(s.minutes)} minutes</p>
          <h2 class="section-h" id="ds-h" tabindex="-1">${esc(s.title)}</h2>
        </div>
        <div id="ds-timer"></div>
      </div>
      <div class="panel prompt prose">${md(s.prompt)}</div>
      <ol class="stepper" id="ds-steps" aria-label="Sections">${SECTIONS.map((n, k) => `<li class="${k < open ? 'done' : ''}"><span>${k + 1}</span>${n}</li>`).join('')}</ol>
      <div class="dsecs">
        ${SECTIONS.map((n, k) => `
          <section class="panel dsec" id="ds-${k}" aria-labelledby="ds-${k}-h"${k < open ? '' : ' hidden'}>
            <h3 class="dsec-h" id="ds-${k}-h" tabindex="-1"><span class="dsec-n">${k + 1}</span>${n}</h3>
            ${body[k]}
          </section>`).join('')}
      </div>
      <div class="controls sc-next" id="ds-next"></div>
      <nav class="pn" aria-label="Other scenarios">
        ${prev ? `<a href="#design/${esc(prev.id)}">← ${esc(prev.title)}</a>` : '<span></span>'}
        ${next ? `<a href="#design/${esc(next.id)}">${esc(next.title)} →</a>` : ''}
      </nav>`;
    designTimer = timerWidget($('ds-timer'), s.minutes, 'design-live', `Time left for ${s.title}`);
    wireDiagram($('design-one'), s);

    const score = () => {
      const k = rubricScore(s);
      $('ds-score').textContent = k == null ? 'Tick what your answer covered. The score is saved on this device.' : `Score: ${k} of ${s.rubric.length}, saved.`;
    };
    score();
    $('design-one').querySelector('.rubric').addEventListener('change', () => {
      state.rubric[s.id] = { checked: [...$('design-one').querySelectorAll('[data-rub]')].filter((x) => x.checked).map((x) => +x.dataset.rub), at: Date.now() };
      save();
      score();
    });

    const nextBar = () => {
      const k = designOpen[s.id] || 0;
      $('ds-next').innerHTML = k < SECTIONS.length
        ? `<button type="button" class="btn primary" data-reveal="1">Show ${k ? 'next' : 'first'}: ${SECTIONS[k]}</button><button type="button" class="btn ghost" data-reveal="all">Show all</button>`
        : '<p class="lbl">Everything is showing. Score yourself with the rubric above.</p>';
    };
    const reveal = (upto) => {
      const from = designOpen[s.id] || 0;
      designOpen[s.id] = upto;
      for (let k = from; k < upto; k++) { const sec = $(`ds-${k}`); sec.hidden = false; sec.classList.add('in'); }
      $('ds-steps').querySelectorAll('li').forEach((li, k) => li.classList.toggle('done', k < upto));
      nextBar();
      const h = $(`ds-${from}-h`);
      h.focus({ preventScroll: true });
      h.closest('section').scrollIntoView({ block: 'start', behavior: smooth() });
    };
    nextBar();
    $('ds-next').addEventListener('click', (e) => {
      const b = e.target.closest('[data-reveal]');
      if (!b) return;
      reveal(b.dataset.reveal === 'all' ? SECTIONS.length : (designOpen[s.id] || 0) + 1);
    });
    return $('ds-h');
  }

  // ---------- the reference flow diagram ----------

  function wrapText(s, max) {
    const lines = [];
    let cur = '';
    for (let w of String(s).split(/\s+/).filter(Boolean)) {
      while (w.length > max) { if (cur) { lines.push(cur); cur = ''; } lines.push(w.slice(0, max - 1) + '-'); w = w.slice(max - 1); }
      if (!cur) cur = w;
      else if (cur.length + 1 + w.length <= max) cur += ' ' + w;
      else { lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);
    return lines;
  }

  /* Lay nodes out by column (a column per stage), stack each column and center it vertically, then
   * connect: forward edges are S-curves between facing sides, with ports spread so several edges
   * don't share a point; edges within a column bulge out to the right; edges going back loop under. */
  function diagram(s) {
    const NW = 140, GAP = 92, PAD = 16, LH = 16, VG = 26;
    const nodes = s.nodes.map((n) => Object.assign({}, n, { lines: wrapText(n.label, 17) }));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const ncol = Math.max(...nodes.map((n) => n.col)) + 1;
    const cols = Array.from({ length: ncol }, () => []);
    for (const n of nodes) { n.h = 22 + n.lines.length * LH; cols[n.col].push(n); }
    const colH = cols.map((c) => c.reduce((a, n) => a + n.h, 0) + Math.max(0, c.length - 1) * VG);
    const inner = Math.max(...colH);
    cols.forEach((c, ci) => {
      let y = PAD + 8 + (inner - colH[ci]) / 2;
      for (const n of c) { n.x = PAD + ci * (NW + GAP); n.y = y; y += n.h + VG; }
    });
    const edges = s.edges.map(([a, b, label]) => ({ a: byId.get(a), b: byId.get(b), label })).filter((e) => e.a && e.b);
    const backs = edges.filter((e) => e.b.col < e.a.col);
    backs.forEach((e, k) => { e.lane = k; });
    // Room on the right for edges that bulge out of the last column.
    const W = PAD * 2 + ncol * NW + (ncol - 1) * GAP + (edges.some((e) => e.a.col === e.b.col && e.a.col === ncol - 1) ? 84 : 0);
    const laneY = (k) => PAD + 8 + inner + 22 + k * 12;
    const H = inner + PAD * 2 + 16 + (backs.length ? 22 + backs.length * 12 : 0);
    const cy = (n) => n.y + n.h / 2;

    // Spread ports along each side, ordered by where the other end is, so lines don't cross at the box.
    const outs = new Map(), ins = new Map();
    for (const e of edges) {
      if (e.b.col <= e.a.col) continue;
      (outs.get(e.a) || outs.set(e.a, []).get(e.a)).push(e);
      (ins.get(e.b) || ins.set(e.b, []).get(e.b)).push(e);
    }
    for (const [n, list] of outs) list.sort((p, q) => cy(p.b) - cy(q.b)).forEach((e, k) => { e.sy = n.y + (n.h * (k + 1)) / (list.length + 1); });
    for (const [n, list] of ins) list.sort((p, q) => cy(p.a) - cy(q.a)).forEach((e, k) => { e.ty = n.y + (n.h * (k + 1)) / (list.length + 1); });

    const f = (v) => v.toFixed(1);
    let paths = '', labels = '';
    /* Labels try the middle of their edge first, then slide along it, sitting just above or below the
     * line, until they clear the boxes and the labels already placed. Sizes are estimates: about
     * 6 px a character at 11 px. */
    const taken = nodes.map((n) => ({ x0: n.x - 2, x1: n.x + NW + 2, y0: n.y - 2, y1: n.y + n.h + 2 }));
    const hits = (r) => taken.some((t) => r.x0 < t.x1 && r.x1 > t.x0 && r.y0 < t.y1 && r.y1 > t.y0);
    function place(pt, ls) {
      const w = Math.max(...ls.map((l) => l.length)) * 6 + 6, h = ls.length * 12 + 2;
      const at = (t, dy) => {
        const [x, y] = pt(t);
        const cx = Math.min(W - w / 2 - 2, Math.max(w / 2 + 2, x));
        return { x: cx, x0: cx - w / 2, x1: cx + w / 2, y0: y + dy - h + 2, y1: y + dy + 2 };
      };
      let best = at(0.5, -4);
      search: for (const t of [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74]) {
        for (const dy of [-4, h + 2]) {
          const r = at(t, dy);
          if (r.y0 < 2 || r.y1 > H - 2) continue;
          if (!hits(r)) { best = r; break search; }
        }
      }
      taken.push(best);
      return best;
    }
    edges.forEach((e, k) => {
      let d, pt;
      const curve = (x0, y0, x1, y1, x2, y2, x3, y3) => {
        d = `M${f(x0)} ${f(y0)} C${f(x1)} ${f(y1)} ${f(x2)} ${f(y2)} ${f(x3)} ${f(y3)}`;
        const b = (t, p0, p1, p2, p3) => { const u = 1 - t; return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3; };
        pt = (t) => [b(t, x0, x1, x2, x3), b(t, y0, y1, y2, y3)];
      };
      if (e.b.col > e.a.col) {
        const sx = e.a.x + NW, tx = e.b.x - 3, dx = Math.max(28, (tx - sx) / 2);
        curve(sx, e.sy, sx + dx, e.sy, tx - dx, e.ty, tx, e.ty);
      } else if (e.b.col === e.a.col) {
        const x = e.a.x + NW, bulge = 44;
        curve(x, cy(e.a), x + bulge, cy(e.a), x + bulge, cy(e.b), x + 3, cy(e.b));
      } else {
        // Going back: out of the left side, down the gap, along a lane under every box, up the gap
        // beside the target, and in from its right. Rounded corners; each edge gets its own lane.
        const r = 8, k = e.lane % 4, L = laneY(e.lane), sy = cy(e.a), ty = cy(e.b);
        const x1 = e.a.x - 16 - k * 8, x2 = e.b.x + NW + 16 + k * 8;
        d = `M${f(e.a.x)} ${f(sy)} H${f(x1 + r)} Q${f(x1)} ${f(sy)} ${f(x1)} ${f(sy + r)} V${f(L - r)} Q${f(x1)} ${f(L)} ${f(x1 - r)} ${f(L)}` +
          ` H${f(x2 + r)} Q${f(x2)} ${f(L)} ${f(x2)} ${f(L - r)} V${f(ty + r)} Q${f(x2)} ${f(ty)} ${f(x2 - r)} ${f(ty)} H${f(e.b.x + NW + 3)}`;
        pt = (t) => [x2 + (x1 - x2) * t, L];
      }
      paths += `<path class="ed" d="${d}" data-a="${esc(e.a.id)}" data-b="${esc(e.b.id)}" marker-end="url(#tt-arrow)"/>`;
      if (e.label) {
        const ls = wrapText(e.label, 16).slice(0, 2);
        const spot = place(pt, ls), y0 = spot.y0 + 10, mx = spot.x;
        labels += `<text class="elab" data-a="${esc(e.a.id)}" data-b="${esc(e.b.id)}" x="${f(mx)}" y="${f(y0)}" text-anchor="middle">${ls.map((l, j) => `<tspan x="${f(mx)}" dy="${j ? 12 : 0}">${esc(l)}</tspan>`).join('')}</text>`;
      }
    });
    const boxes = nodes.map((n) => {
      const ty = n.y + (n.h - n.lines.length * LH) / 2 + LH - 4;
      return `
        <g class="nd${n.note ? ' has-note' : ''}" data-id="${esc(n.id)}" style="--c:var(--s${(n.col % 6) + 1})">
          <rect class="box" x="${f(n.x)}" y="${f(n.y)}" width="${NW}" height="${n.h}" rx="8"/>
          <rect class="strip" x="${f(n.x + 6)}" y="${f(n.y + 8)}" width="3" height="${n.h - 16}" rx="1.5"/>
          <text class="nl" x="${f(n.x + NW / 2 + 3)}" y="${f(ty)}" text-anchor="middle">${n.lines.map((l, j) => `<tspan x="${f(n.x + NW / 2 + 3)}" dy="${j ? LH : 0}">${esc(l)}</tspan>`).join('')}</text>
          ${n.note ? `<circle class="ni" cx="${f(n.x + NW - 10)}" cy="${f(n.y + 10)}" r="3"/>` : ''}
        </g>`;
    }).join('');
    const svg = `
      <svg class="dg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="min-width:${Math.round(W * 0.78)}px" role="img" aria-label="Reference flow for ${esc(s.title)}. The same flow is listed as text below the diagram.">
        <defs><marker id="tt-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="ah" d="M0 1L9 5L0 9z"/></marker></defs>
        <g class="eds">${paths}</g><g class="labs">${labels}</g><g class="nds">${boxes}</g>
      </svg>`;
    const notes = cols.map((c, ci) => `
      <li><span class="stage" style="--c:var(--s${(ci % 6) + 1})">Stage ${ci + 1}</span>
        <ul>${c.map((n) => `<li><strong>${esc(n.label)}</strong>${n.note ? `: ${esc(n.note)}` : ''}</li>`).join('')}</ul></li>`).join('');
    const flow = edges.map((e) => `<li>${esc(e.a.label)} → ${esc(e.b.label)}${e.label ? ` <span class="lbl">(${esc(e.label)})</span>` : ''}</li>`).join('');
    return `
      <div class="dg-wrap" tabindex="0" role="region" aria-label="Reference flow diagram; scrolls sideways on small screens">${svg}</div>
      <p class="dg-hint lbl">Hover or tap a box for its note. Dotted boxes have one.</p>
      <div class="dg-text">
        <ol class="stages">${notes}</ol>
        <details class="flow-t"><summary>Connections as text</summary><ul class="blist">${flow}</ul></details>
      </div>`;
  }

  // Hover or tap a box: show its note and light up the edges that touch it.
  function wireDiagram(root, s) {
    const svg = root.querySelector('svg.dg');
    if (!svg) return;
    const nodes = new Map(s.nodes.map((n) => [n.id, n]));
    const focusOn = (id) => {
      svg.classList.toggle('focusing', !!id);
      svg.querySelectorAll('.ed, .elab').forEach((p) => p.classList.toggle('hl', !!id && (p.dataset.a === id || p.dataset.b === id)));
      svg.querySelectorAll('.nd').forEach((g) => g.classList.toggle('hl', g.dataset.id === id));
    };
    const showFor = (g, x, y) => {
      const n = nodes.get(g.dataset.id);
      focusOn(g.dataset.id);
      if (n && n.note) showTip(`<strong>${esc(n.label)}</strong><br>${esc(n.note)}`, x, y);
      else hideTip();
    };
    svg.addEventListener('pointermove', (e) => {
      const g = e.target.closest('.nd');
      if (g) showFor(g, e.clientX, e.clientY);
      else if (e.pointerType === 'mouse') { focusOn(null); hideTip(); }
    });
    svg.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') { focusOn(null); hideTip(); } });
    svg.addEventListener('click', (e) => {
      const g = e.target.closest('.nd');
      if (g) { const r = g.getBoundingClientRect(); showFor(g, r.left + r.width / 2, r.top); } else { focusOn(null); hideTip(); }
    });
    root.querySelector('.dg-wrap').addEventListener('scroll', hideTip, { passive: true });
  }

  // ---------- back-of-envelope ----------

  const BOTE = [
    ['slidesPerDay', 'Slides per day', 'slides', 1],
    ['gbPerSlide', 'Average size per slide, compressed', 'GB', 0.01],
    ['scanHours', 'Scanning hours per day', 'h', 1, 24],
    ['years', 'Retention', 'years', 1],
    ['copies', 'Copies kept', 'copies', 1],
    ['width', 'Image width at full resolution', 'px', 1],
    ['height', 'Image height at full resolution', 'px', 1],
    ['tile', 'Tile size', 'px', 16],
    ['tilesPerSec', 'Inference speed per GPU', 'tiles/s', 1],
  ];
  // In range means what the input's min and max say, so the figures shown are the ones computed.
  const inRange = (v, min, max) => Number.isFinite(v) && v >= min && (!max || v <= max);
  const bp = prefs('bote');
  const bote = Object.assign({}, TT.ESTIMATE_DEFAULTS);
  for (const [k, , , min, max] of BOTE) if (inRange(bp[k], min, max)) bote[k] = bp[k];

  $('bote-form').innerHTML = BOTE.map(([k, label, unit, min, max]) => `
    <label class="field" for="b-${k}">
      <span class="lbl">${label}</span>
      <span class="inwrap"><input class="input" type="number" id="b-${k}" data-k="${k}" value="${bote[k]}" step="any" min="${min}"${max ? ` max="${max}"` : ''} inputmode="decimal"><span class="unit">${unit}</span></span>
    </label>`).join('') + '<button type="button" class="btn ghost mini b-reset" id="b-reset">Back to the defaults</button>';
  $('bote-form').addEventListener('submit', (e) => e.preventDefault());

  function renderBote() {
    const e = TT.estimate(bote);
    const stat = (label, value, note) => `<div class="stat"><span class="stat-label">${label}</span><span class="stat-value">${value}</span><span class="stat-note">${note}</span></div>`;
    const gbit = (e.mbPerSec * 8) / 1000;
    const big = (n) => (n >= 100 ? fmtInt(n) : fmt(n, n >= 10 ? 1 : 2));
    $('bote-out').innerHTML = [
      stat('New images per day', `${big(e.tbPerDay)} TB`, `${big(e.tbPerYear)} TB a year, one copy`),
      stat('Kept over retention', `${big(e.pbRetained)} PB`, `${fmt(bote.years, 1)} years × ${fmt(bote.copies, 1)} copies`),
      stat('Sustained upload', `${big(e.mbPerSec)} MB/s`, `${fmt(gbit, 2)} Gbit/s over ${fmt(bote.scanHours, 1)} scanning hours`),
      stat('Pyramid levels', fmtInt(e.levelCount), `halving down to one ${fmtInt(bote.tile)} px tile`),
      stat('Tiles per slide', fmtInt(e.tilesPerSlide), `${fmtInt(e.fullResTiles)} at full resolution`),
      stat('GPU-hours per day', big(e.gpuHoursPerDay), `about ${fmtInt(e.gpusAllDay)} GPU${e.gpusAllDay === 1 ? '' : 's'} running all day, every full-res tile`),
    ].join('');
    $('bote-levels').innerHTML = `<thead><tr><th scope="col">Level</th><th scope="col">Size (px)</th><th scope="col">Grid</th><th scope="col">Tiles</th></tr></thead><tbody>` +
      e.levels.map((l) => `<tr><td>${l.level}</td><td>${fmtInt(l.width)} × ${fmtInt(l.height)}</td><td>${fmtInt(l.cols)} × ${fmtInt(l.rows)}</td><td>${fmtInt(l.tiles)}</td></tr>`).join('') +
      `<tr class="tot"><td>All</td><td></td><td></td><td>${fmtInt(e.tilesPerSlide)}</td></tr></tbody>`;
  }
  $('bote-form').addEventListener('input', (e) => {
    const k = e.target.dataset.k;
    if (!k) return;
    const [, , , min, max] = BOTE.find(([x]) => x === k);
    const v = parseFloat(e.target.value);
    const ok = inRange(v, min, max);
    e.target.setAttribute('aria-invalid', String(!ok));
    if (!ok) return;
    bote[k] = v;
    state.prefs.bote = Object.assign({}, bote);
    save();
    renderBote();
    announceBote();
  });
  // The figures redraw on every keystroke, so screen readers hear one summary once typing pauses.
  let boteT = 0;
  function announceBote() {
    clearTimeout(boteT);
    boteT = setTimeout(() => {
      const e = TT.estimate(bote);
      announce('design-live', `${fmt(e.tbPerDay, 2)} TB a day, ${fmt(e.pbRetained, 2)} PB kept, ${fmt(e.mbPerSec, 0)} MB/s upload, ${fmt(e.gpuHoursPerDay, 0)} GPU-hours a day.`);
    }, 900);
  }
  $('b-reset').addEventListener('click', () => {
    Object.assign(bote, TT.ESTIMATE_DEFAULTS);
    for (const [k] of BOTE) { $(`b-${k}`).value = bote[k]; $(`b-${k}`).removeAttribute('aria-invalid'); }
    delete state.prefs.bote;
    save();
    renderBote();
    announceBote();
  });
  renderBote();

  // ================================================================ Stories
  const STAR = [
    ['s', 'Situation', 'Where you were and what was at stake. One or two lines.'],
    ['t', 'Task', 'What you specifically owned.'],
    ['a', 'Action', 'What you did: the decisions, the trade-offs, who you brought in.'],
    ['r', 'Result', 'What changed, with a number if you have one, and what you would do differently.'],
  ];
  let storyTimer = null, storySaveT = 0;
  const hasNotes = (id) => { const n = state.stories[id]; return !!n && STAR.some(([k]) => (n[k] || '').trim()); };

  function renderStories(sub) {
    const st = STORIES.find((x) => x.id === sub);
    $('stories-list').hidden = !!st;
    $('story-one').hidden = !st;
    if (storyTimer) { storyTimer.pause(); storyTimer = null; }
    if (!st) {
      $('story-list').innerHTML = STORIES.length ? STORIES.map((s) => `
        <li>
          <a class="panel story" href="#stories/${esc(s.id)}">
            <span class="story-top"><span class="tag">${esc(s.theme)}</span>${hasNotes(s.id) ? '<span class="tag good">Notes saved</span>' : ''}</span>
            <span class="story-p">${esc(TT.plain(s.prompt))}</span>
          </a>
        </li>`).join('') : '<li class="msg">No stories are loaded.</li>';
      return $('stories-h');
    }
    const i = STORIES.indexOf(st), prev = STORIES[i - 1], next = STORIES[i + 1];
    const note = state.stories[st.id] || {};
    $('story-one').innerHTML = `
      <a class="back" href="#stories">← All stories</a>
      <div class="sc-head">
        <div class="sc-title">
          <p class="kicker">${esc(st.id)} · ${esc(st.theme)}</p>
          <h2 class="story-q" id="st-h" tabindex="-1">${esc(TT.plain(st.prompt))}</h2>
          ${st.variants && st.variants.length ? `<div class="variants"><span class="lbl">Also asked as</span>${bullets(st.variants)}</div>` : ''}
        </div>
        <div id="st-timer"></div>
      </div>
      <div class="star">
        ${STAR.map(([k, label, hint]) => `
          <div class="field star-f">
            <label for="st-${k}"><span class="star-k">${label[0]}</span>${label}</label>
            <p class="hint" id="st-${k}-hint">${hint}</p>
            <textarea class="input" id="st-${k}" data-k="${k}" rows="4" aria-describedby="st-${k}-hint">${esc(note[k] || '')}</textarea>
          </div>`).join('')}
      </div>
      <p class="saved lbl" id="st-saved">${storeOk ? 'Notes save on this device as you type.' : "Notes can't be saved in this browser; export them before you leave."}</p>
      <div class="grid2 st-lists">
        <div class="panel"><h3 class="alabel">Listen for</h3>${bullets(st.listenFor, 'blist good-l')}</div>
        <div class="panel"><h3 class="alabel">Where these go wrong</h3>${bullets(st.pitfalls, 'blist flags')}</div>
      </div>
      <div class="controls st-actions"><button type="button" class="btn" data-export-notes>Export notes</button></div>
      <nav class="pn" aria-label="Other stories">
        ${prev ? `<a href="#stories/${esc(prev.id)}">← ${esc(prev.theme)}</a>` : '<span></span>'}
        ${next ? `<a href="#stories/${esc(next.id)}">${esc(next.theme)} →</a>` : ''}
      </nav>`;
    storyTimer = timerWidget($('st-timer'), 2, 'stories-live', 'Speaking time left');
    $('story-one').querySelector('.star').addEventListener('input', (e) => {
      const k = e.target.dataset.k;
      if (!k) return;
      const n = state.stories[st.id] || (state.stories[st.id] = { s: '', t: '', a: '', r: '' });
      n[k] = e.target.value;
      clearTimeout(storySaveT);
      storySaveT = setTimeout(() => {
        storySaveT = 0;
        save();
        $('st-saved').textContent = storeOk ? `Saved at ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : "Notes can't be saved in this browser; export them before you leave.";
      }, 400);
    });
    return $('st-h');
  }

  // Notes typed in the last moment before the tab closes would otherwise wait on the debounce.
  window.addEventListener('pagehide', () => { if (storySaveT) { clearTimeout(storySaveT); storySaveT = 0; save(); } });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('[data-export-notes]')) return;
    download(`tile-to-table-stories-${today()}.md`, TT.storiesMd(STORIES, state.stories, today()), 'text/markdown');
  });

  // ================================================================ Glossary
  function renderGlossary() {
    const q = $('g-q').value.trim().toLowerCase();
    const hits = GLOSS.filter((g) => !q || `${g.term} ${TT.plain(g.def)}`.toLowerCase().includes(q));
    $('g-list').innerHTML = hits.map((g) => `<div class="gi"><dt>${esc(g.term)} ${deckTag(g.deck)}</dt><dd class="prose">${md(g.def)}</dd></div>`).join('');
    $('g-count').textContent = !GLOSS.length ? 'No glossary is loaded.' : q ? `${hits.length} of ${GLOSS.length} terms match.` : `${GLOSS.length} terms.`;
    return $('glossary-h');
  }
  $('g-q').addEventListener('input', renderGlossary);

  // ================================================================ routing
  const VIEWS = { overview: renderOverview, drill: renderDrill, round: renderRound, design: renderDesign, stories: renderStories, glossary: renderGlossary };
  const TITLES = { overview: 'Tile to Table', drill: 'Drill', round: 'Timed round', design: 'System design', stories: 'Stories', glossary: 'Glossary' };
  let current = null;

  function route(initial) {
    let hash = location.hash.slice(1);
    try { hash = decodeURIComponent(hash); } catch (e) { /* a malformed escape: use it as typed */ }
    const [v0, sub] = hash.split('/');
    const view = Object.prototype.hasOwnProperty.call(VIEWS, v0) ? v0 : 'overview';
    // Clocks stop when their view is left; the design and story clocks start over on return.
    if (current === 'round' && view !== 'round' && round.timer) round.timer.pause();
    if (current !== view) {
      if (designTimer) designTimer.pause();
      if (storyTimer) storyTimer.pause();
    }
    hideTip();
    for (const v of Object.keys(VIEWS)) $(`v-${v}`).hidden = v !== view;
    document.querySelectorAll('.topnav a[data-view]').forEach((a) => {
      const on = a.dataset.view === view;
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    const wasRound = current === 'round';
    current = view;
    const target = VIEWS[view](sub);
    // Coming back to a round in progress picks the clock up where it stopped.
    if (view === 'round' && !wasRound && round.phase === 'run' && round.ctl && !round.ctl.revealed) round.timer.start();
    document.title = view === 'overview' ? TITLES.overview : `${TITLES[view]} · Tile to Table`;
    if (!initial) {
      window.scrollTo(0, 0);
      if (target) target.focus({ preventScroll: true });
    }
  }

  // Leaving the round view rebuilds it on return; keep the running card instead of redrawing it.
  const renderRoundFresh = renderRound;
  VIEWS.round = function () {
    if (round.phase === 'run' && $('r-card') && $('r-card').firstElementChild) return $('round-h');
    return renderRoundFresh();
  };

  // ---------------------------------------------------------------- keyboard
  /* Space reveals, 1-4 grade. Never while typing, and Space is left alone on anything that already
   * uses it (buttons, links, checkboxes, scrollable code). */
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target;
    if (t.isContentEditable || /^(TEXTAREA|SELECT)$/.test(t.tagName)) return;
    if (t.tagName === 'INPUT' && !/^(checkbox|radio)$/.test(t.type)) return;
    const ctl = current === 'drill' ? drill.ctl : current === 'round' && round.phase === 'run' ? round.ctl : null;
    if (!ctl) return;
    if (e.key === ' ' || e.key === 'Spacebar') {
      if (e.shiftKey || t.closest('button, a, summary, input, label, select, [tabindex]:not([tabindex="-1"])')) return;
      if (!ctl.revealed) { e.preventDefault(); ctl.reveal(); }
    } else if (/^[1-4]$/.test(e.key) && ctl.revealed) {
      e.preventDefault();
      ctl.grade(TT.GRADES[+e.key - 1]);
    }
  });

  // ---------------------------------------------------------------- start
  $('no-store').hidden = storeOk;
  $('no-content').hidden = CARDS.length > 0 || SCENS.length > 0;
  window.addEventListener('hashchange', () => route(false));
  route(true);
})();
