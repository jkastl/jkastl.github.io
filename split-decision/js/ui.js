/* Split Decision's page: controls, the AUC bars, the neighbour scatter, the key hierarchy and SQL. */
(function () {
  'use strict';
  const SD = globalThis.SD;
  const $ = (id) => document.getElementById(id);
  const fmtInt = (n) => Math.round(n).toLocaleString('en-US');
  const f2 = (v) => v.toFixed(2);
  const pc = (v) => Math.round(v * 100) + '%';
  const sgn = (v) => (Math.abs(v) < 0.005 ? '±' : v > 0 ? '+' : '−') + Math.abs(v).toFixed(2);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const stat = (label, value, note, cls) =>
    `<div class="stat${cls ? ' ' + cls : ''}"><span class="stat-label">${label}</span><span class="stat-value">${value}</span>${note ? `<span class="stat-note">${note}</span>` : ''}</div>`;
  const SITE_COLORS = { A: '#3987e5', B: '#d95926', C: '#199e70', D: '#c98500' };
  const LABEL_COLORS = { 0: '#3987e5', 1: '#d95926' };
  const SAME = '#e25555';

  const tip = $('tip');
  function showTip(html, x, y) {
    tip.innerHTML = html;
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    tip.style.left = Math.min(window.innerWidth - r.width - 8, x + 14) + 'px';
    tip.style.top = Math.max(8, y - r.height - 10) + 'px';
  }
  const hideTip = () => { tip.hidden = true; };

  const state = { seed: SD.DEFAULTS.seed, patient: SD.DEFAULTS.patient, site: SD.DEFAULTS.site, norm: false, pick: 'patch', colorBy: 'site' };
  let run = null, job = 0;

  // ---------- compute, a step per frame so the page stays responsive ----------
  function compute() {
    const my = ++job;
    $('status').textContent = 'Building the cohort…';
    const opts = { seed: state.seed, patient: state.patient, site: state.site };
    const steps = [];
    const r = { results: {} };
    steps.push(() => {
      r.cohort = SD.makeCohort(opts);
      r.patches = state.norm ? SD.normalizeSites(r.cohort.patches) : r.cohort.patches;
    });
    for (const s of SD.STRATEGIES) {
      steps.push(() => { $('status').textContent = `Training and testing: ${s.name.toLowerCase()}…`; });
      steps.push(() => { r.results[s.id] = SD.evaluate(r.patches, s.id); });
    }
    steps.push(() => { $('status').textContent = 'Scoring Site D…'; });
    steps.push(() => { r.external = SD.external(r.cohort, state.norm); });
    steps.push(() => { r.xy = SD.pca2(r.patches.map((p) => p.x)); });
    let i = 0;
    const tick = () => {
      if (my !== job) return; // a newer request superseded this one
      steps[i++]();
      if (i < steps.length) { setTimeout(tick, 0); return; }
      run = r;
      const c = r.cohort;
      $('status').textContent = `${fmtInt(c.patients.length)} patients · ${fmtInt(c.slides.length)} slides · ${fmtInt(c.patches.length)} patches · cohort #${state.seed}`;
      renderAll();
    };
    setTimeout(tick, 0);
  }

  // ---------- controls ----------
  function syncControls() {
    $('pat').value = state.patient;
    $('site').value = state.site;
    $('pat-o').textContent = state.patient === 0 ? 'not at all' : state.patient.toFixed(1);
    $('site-o').textContent = state.site === 0 ? 'none' : state.site.toFixed(1);
    $('norm').checked = state.norm;
  }
  let deb = 0;
  const later = () => { clearTimeout(deb); deb = setTimeout(compute, 180); };
  $('pat').addEventListener('input', (e) => { state.patient = +e.target.value; syncControls(); later(); });
  $('site').addEventListener('input', (e) => { state.site = +e.target.value; syncControls(); later(); });
  $('norm').addEventListener('change', (e) => { state.norm = e.target.checked; compute(); });
  $('reseed').addEventListener('click', () => { state.seed++; compute(); });
  $('defaults').addEventListener('click', () => {
    Object.assign(state, { seed: SD.DEFAULTS.seed, patient: SD.DEFAULTS.patient, site: SD.DEFAULTS.site, norm: false });
    syncControls();
    compute();
  });

  function select(id) {
    state.pick = id;
    renderAll();
  }
  $('pick').innerHTML = SD.STRATEGIES.map((s) => `<button type="button" data-id="${s.id}" aria-pressed="false">${s.name}</button>`).join('');
  $('pick').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) select(b.dataset.id); });
  $('colorby').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.colorBy = b.dataset.c;
    $('colorby').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    drawScatter();
  });

  function renderAll() {
    if (!run) return;
    $('pick').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.id === state.pick)));
    drawBars();
    renderDetails();
    drawScatter();
    renderKeys();
  }

  // ---------- bars ----------
  function drawBars() {
    const ext = run.external.patchAuc;
    // Drawn at the container's own width so the text stays readable on a phone.
    const W = Math.max(320, Math.round($('bars').clientWidth || 600));
    const narrow = W < 480;
    const rowH = 46, pad = { l: narrow ? 104 : 132, r: narrow ? 74 : 92, t: 30, b: 26 };
    const H = pad.t + rowH * SD.STRATEGIES.length + pad.b;
    const lo = 0.3, hi = 1;
    const X = (v) => pad.l + ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * (W - pad.l - pad.r);
    let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="AUC reported by each split, with the real AUC at a new site">`;
    for (const v of [0.3, 0.5, 0.7, 0.9, 1]) {
      s += `<line class="${v === 0.5 ? 'chance' : 'gridline'}" x1="${X(v)}" x2="${X(v)}" y1="${pad.t - 6}" y2="${H - pad.b}"/>`;
      if (narrow && (v === 0.3 || v === 0.9)) continue;
      s += `<text class="axis-t" x="${X(v)}" y="${H - 8}" text-anchor="middle">${v.toFixed(1)}${v === 0.5 && !narrow ? ' coin flip' : ''}</text>`;
    }
    SD.STRATEGIES.forEach((st, i) => {
      const r = run.results[st.id];
      const y = pad.t + i * rowH + 10, bh = 22;
      const on = st.id === state.pick;
      const v = r.patchAuc;
      const x0 = X(0.5), x1 = X(v);
      const left = Math.min(x0, x1), w = Math.max(2, Math.abs(x1 - x0));
      const rx = 4;
      // Rounded at the value end, square at the 0.5 baseline.
      const path = x1 >= x0
        ? `M${left},${y}H${left + w - rx}Q${left + w},${y} ${left + w},${y + rx}V${y + bh - rx}Q${left + w},${y + bh} ${left + w - rx},${y + bh}H${left}Z`
        : `M${left + w},${y}H${left + rx}Q${left},${y} ${left},${y + rx}V${y + bh - rx}Q${left},${y + bh} ${left + rx},${y + bh}H${left + w}Z`;
      s += `<g data-id="${st.id}">`;
      s += `<rect class="row-hit" x="0" y="${y - 10}" width="${W}" height="${rowH}"/>`;
      s += `<path class="bar${on ? ' on' : ''}" d="${path}"/>`;
      s += `<text class="name${on ? ' on' : ''}" x="0" y="${y + 15}">${st.name}</text>`;
      const vx = Math.max(x1, x0) + 6;
      s += `<text class="val" x="${vx}" y="${y + 15}">${f2(v)}</text>`;
      s += `<text class="gap" x="${vx + 32}" y="${y + 15}">${sgn(v - ext)}</text>`;
      s += '</g>';
    });
    s += `<line class="truth" x1="${X(ext)}" x2="${X(ext)}" y1="${pad.t - 10}" y2="${H - pad.b}"/>`;
    s += `<text class="lab" x="${X(ext)}" y="${pad.t - 14}" text-anchor="middle">Site D, next year: ${f2(ext)}</text>`;
    s += '</svg>';
    const el = $('bars');
    el.innerHTML = s;
    el.querySelectorAll('g[data-id]').forEach((g) => {
      const id = g.dataset.id, r = run.results[id], st = SD.STRATEGIES.find((x) => x.id === id);
      g.addEventListener('click', () => select(id));
      g.addEventListener('pointermove', (e) => showTip(`<strong>${st.name}</strong><br><span class="tl">${st.short}</span><br>patch AUC ${f2(r.patchAuc)} · slide AUC ${f2(r.slideAuc)}<br>${sgn(r.patchAuc - ext)} vs Site D · ${r.leaked.length} patients on both sides`, e.clientX, e.clientY));
      g.addEventListener('pointerleave', hideTip);
    });
  }

  // ---------- details ----------
  function renderDetails() {
    const r = run.results[state.pick], ext = run.external;
    const gap = r.patchAuc - ext.patchAuc;
    const nPat = run.cohort.patients.length;
    const gaps = SD.STRATEGIES.map((s) => ({ id: s.id, g: Math.abs(run.results[s.id].patchAuc - ext.patchAuc) }));
    const closest = gaps.reduce((a, b) => (b.g < a.g ? b : a)).id;
    $('dstats').innerHTML = [
      stat('Reported AUC', f2(r.patchAuc), `slide level ${f2(r.slideAuc)}`),
      stat('Off from Site D by', sgn(gap), `Site D: ${f2(ext.patchAuc)} patch, ${f2(ext.slideAuc)} slide`, Math.abs(gap) > 0.1 ? 'bad' : Math.abs(gap) < 0.05 ? 'good' : ''),
      stat('Patients on both sides', fmtInt(r.leaked.length), `of ${nPat}`, r.leaked.length ? 'bad' : 'good'),
      stat('Nearest is same patient', pc(r.samePatient), 'test patches whose closest training patch is the same person', r.samePatient > 0.05 ? 'bad' : ''),
      stat('Nearest is same site', pc(r.sameSite), `${fmtInt(r.train)} train · ${fmtInt(r.test)} test patches`),
    ].join('');
    let msg, cls = 'warn';
    const over = gap > 0 ? `overstates Site D by ${f2(gap)}` : `understates Site D by ${f2(-gap)}`;
    if (state.pick === 'patch') {
      msg = `<strong>Every patient is on both sides</strong> (${r.leaked.length} of ${nPat}). For ${pc(r.samePatient)} of test patches the
        closest training patch belongs to the same person, so the model is recognizing people, not tumor. The score ${over}.`;
    } else if (state.pick === 'slide') {
      msg = `<strong>Whole slides aren't enough.</strong> ${r.leaked.length} patients have one slide in train and another in test, and
        ${pc(r.samePatient)} of test patches still find their own patient first. The score ${over}.`;
    } else if (state.pick === 'patient') {
      msg = state.norm
        ? `<strong>No patient leaks</strong>, and with each site's average color removed the score ${over}. What's left is the
          ordinary gap between new patients at familiar sites and new patients at an unfamiliar one.`
        : `<strong>No patient leaks</strong>, and the score still ${over}. ${pc(r.sameSite)} of test patches find a training patch
          from their own site first: the model learned each site's color, and site predicts diagnosis because the referral center's
          patients are mostly positive. Try <em>Normalize stain color per site</em>.`;
      if (Math.abs(gap) < 0.05) cls = 'good';
    } else {
      msg = `<strong>The test hospital's color was never in training</strong>, so the color shortcut can't help, and the score ${over}.
        Validation should look like deployment: if the model will meet new hospitals, test it on one.`;
      if (Math.abs(gap) < 0.07) cls = 'good';
    }
    if (closest === state.pick) msg += ' <strong>This is the closest of the four to what Site D will see.</strong>';
    $('dmsg').className = 'msg ' + cls;
    $('dmsg').innerHTML = msg;
  }

  // ---------- scatter ----------
  const canvas = $('scatter'), ctx = canvas.getContext('2d');
  let pts = [], view = null;
  function drawScatter() {
    if (!run) return;
    const r = run.results[state.pick];
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = canvas.clientWidth, H = canvas.clientHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const xy = run.xy;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [x, y] of xy) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const pad = 16, sx = (W - 2 * pad) / (x1 - x0), sy = (H - 2 * pad) / (y1 - y0), sc = Math.min(sx, sy);
    const ox = pad + (W - 2 * pad - (x1 - x0) * sc) / 2, oy = pad + (H - 2 * pad - (y1 - y0) * sc) / 2;
    const P = ([x, y]) => [ox + (x - x0) * sc, oy + (y1 - y) * sc];
    const index = new Map(run.patches.map((p, i) => [p.id, i]));
    view = { P, index };
    pts = run.patches.map((p, i) => ({ p, xy: P(xy[i]) }));
    const colorOf = (p) => (state.colorBy === 'site' ? SITE_COLORS[p.site] : LABEL_COLORS[p.label]);
    ctx.globalAlpha = 0.45;
    for (const { p, xy: [x, y] } of pts) {
      ctx.fillStyle = colorOf(p);
      ctx.fillRect(x - 1.4, y - 1.4, 2.8, 2.8);
    }
    ctx.globalAlpha = 1;
    // A fixed sample of test patches, every n-th, so the picture is stable.
    const step = Math.max(1, Math.floor(r.sample.length / 90));
    const lines = r.sample.filter((_, i) => i % step === 0);
    for (const same of [false, true]) {
      for (const s of lines) {
        if ((s.nearest.patient === s.p.patient) !== same) continue;
        const a = pts[index.get(s.p.id)].xy, b = pts[index.get(s.nearest.id)].xy;
        ctx.strokeStyle = same ? SAME : 'rgba(220,220,220,0.45)';
        ctx.lineWidth = same ? 1.6 : 1;
        ctx.setLineDash(same ? [] : [3, 3]);
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);
    for (const s of lines) {
      const [x, y] = pts[index.get(s.p.id)].xy;
      ctx.fillStyle = colorOf(s.p);
      ctx.strokeStyle = '#121212';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, 2 * Math.PI);
      ctx.stroke();
      ctx.fill();
    }
    const sw = (c) => `<i class="sw" style="background:${c}"></i>`;
    const ln = (c, dash) => `<svg width="18" height="10" aria-hidden="true"><line x1="1" x2="17" y1="5" y2="5" stroke="${c}" stroke-width="2"${dash ? ' stroke-dasharray="3 3"' : ''}/></svg>`;
    const groups = state.colorBy === 'site'
      ? SD.SITES.map((s) => `<span>${sw(SITE_COLORS[s.id])}${s.name}, ${s.note} (${pc(s.prevalence)} positive)</span>`)
      : [`<span>${sw(LABEL_COLORS[0])}slide negative</span>`, `<span>${sw(LABEL_COLORS[1])}slide positive</span>`];
    const nSame = lines.filter((s) => s.nearest.patient === s.p.patient).length;
    $('sc-legend').innerHTML = groups.join('') +
      `<span>${ln(SAME)}nearest is the same patient (${nSame} of ${lines.length})</span><span>${ln('rgba(220,220,220,0.7)', true)}a different patient</span>`;
  }
  canvas.addEventListener('pointermove', (e) => {
    if (!pts.length) return;
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    let best = null, bd = 49;
    for (const q of pts) { const d = (q.xy[0] - mx) ** 2 + (q.xy[1] - my) ** 2; if (d < bd) { bd = d; best = q; } }
    if (!best) return hideTip();
    const p = best.p;
    const site = SD.SITES.find((s) => s.id === p.site);
    showTip(`<span class="tl">${esc(p.id)}</span><br>patient ${esc(p.patient)} · ${site.name}<br>slide ${p.label ? 'positive' : 'negative'}${p.tumor ? ', tumor in this patch' : ''}`, e.clientX, e.clientY);
  });
  canvas.addEventListener('pointerleave', hideTip);
  new ResizeObserver(() => drawScatter()).observe(canvas);
  let barsW = 0;
  new ResizeObserver(() => {
    const w = $('bars').clientWidth;
    if (run && Math.abs(w - barsW) > 8) { barsW = w; drawBars(); }
  }).observe($('bars'));

  // ---------- keys and SQL ----------
  const LEVELS = [
    { id: 'site', name: 'Site', key: 'site_id', count: (c) => new Set(c.patients.map((p) => p.site)).size, note: 'stain, scanner, case mix' },
    { id: 'patient', name: 'Patient', key: 'patient_id', count: (c) => c.patients.length, note: 'anatomy, age, history' },
    { id: 'case', name: 'Case', key: 'accession_id', count: (c) => c.cases.length, note: 'one procedure' },
    { id: 'slide', name: 'Block and slide', key: 'slide_id', count: (c) => c.slides.length, note: 'one section, one stain run' },
    { id: 'patch', name: 'Patch', key: 'patch_id', count: (c) => c.patches.length, note: 'a 256 px tile' },
  ];
  function renderKeys() {
    const c = run.cohort, r = run.results[state.pick];
    const k = LEVELS.findIndex((l) => l.id === state.pick);
    $('hier').innerHTML = LEVELS.map((l, i) => {
      const cls = i === k ? 'key' : i < k ? 'leak' : '';
      const tag = i === k ? '<span class="tag">split here</span>' : i < k ? '<span class="tag bad">on both sides</span>' : '<span class="tag good">stays together</span>';
      return `${i ? '<span class="arrow" aria-hidden="true">→</span>' : ''}<div class="lvl ${cls}"><b>${l.name}</b><span class="n">${fmtInt(l.count(c))}</span><code>${l.key}</code><br>${l.note}<br>${tag}</div>`;
    }).join('');

    const st = SD.STRATEGIES.find((s) => s.id === state.pick);
    const expr = state.pick === 'site'
      ? `IF(s.site_id = 'C', 'test', 'train')`
      : `IF(MOD(ABS(FARM_FINGERPRINT(CONCAT('v3:', ${state.pick === 'patch' ? 'p.patch_id' : state.pick === 'slide' ? 'p.slide_id' : 's.patient_id'}))), 10) &lt; 8,
     'train', 'test')`;
    $('sql-split').innerHTML =
`<span class="cm">-- ${esc(st.name)}: ${esc(st.short)}</span>
<span class="kw">CREATE OR REPLACE TABLE</span> ml.patch_split_v3 <span class="kw">AS</span>
<span class="kw">SELECT</span>
  p.patch_id, p.slide_id, s.patient_id, s.site_id,
  ${expr} <span class="kw">AS</span> split
<span class="kw">FROM</span> pathology.patches <span class="kw">AS</span> p
<span class="kw">JOIN</span> pathology.slides <span class="kw">AS</span> s <span class="kw">USING</span> (slide_id);`;
    $('sql-leak').innerHTML =
`<span class="kw">SELECT</span> patient_id <span class="kw">FROM</span> ml.patch_split_v3 <span class="kw">WHERE</span> split = 'train'
<span class="kw">INTERSECT DISTINCT</span>
<span class="kw">SELECT</span> patient_id <span class="kw">FROM</span> ml.patch_split_v3 <span class="kw">WHERE</span> split = 'test';`;
    const n = r.leaked.length;
    $('leak-result').className = 'msg ' + (n ? 'bad' : 'good');
    $('leak-result').innerHTML = n
      ? `<strong>${fmtInt(n)} rows. Build fails.</strong> First few: <code>${r.leaked.slice(0, 3).map(esc).join('</code>, <code>')}</code>${n > 3 ? ', …' : ''}`
      : '<strong>0 rows. Build passes.</strong> No patient is on both sides.';
  }

  syncControls();
  compute();
})();
