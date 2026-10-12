/* Off Color's page: the four scanner panels, the OD scatter, one-dye views, and the stream. */
(function () {
  'use strict';
  const T = globalThis.Tissue, OC = globalThis.OC;
  const $ = (id) => document.getElementById(id);
  const fmtInt = (n) => Math.round(n).toLocaleString('en-US');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const stat = (label, value, note) =>
    `<div class="stat"><span class="stat-label">${label}</span><span class="stat-value">${value}</span>${note ? `<span class="stat-note">${note}</span>` : ''}</div>`;
  const COLORS = { A: '#3987e5', B: '#d95926', C: '#199e70', Y: '#c98500' };
  const cal = OC.calibrate();

  const tip = $('tip');
  function showTip(html, x, y) {
    tip.innerHTML = html;
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    tip.style.left = Math.min(window.innerWidth - r.width - 8, x + 14) + 'px';
    tip.style.top = Math.max(8, y - r.height - 10) + 'px';
  }
  const hideTip = () => { tip.hidden = true; };

  function toCanvas(canvas, px, w, h) {
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').putImageData(new ImageData(px, w, h), 0, 0);
  }

  // ======================================================================
  // One spot, four scanners
  // ======================================================================
  const SZ = 160, PS = 0.6, N = SZ * SZ;
  const spotSlide = T.makeSlide(1187);
  const spot = { x: 18161, y: 4915 }; // a crowded patch of tissue, clear of the pen mark
  const scanners = [
    ...OC.SCANNERS.map((s) => ({ id: s.id, name: s.profile.name, sub: s.site, color: COLORS[s.id], profile: s.profile })),
    { id: 'Y', name: 'Your scanner', sub: 'the sliders below', color: COLORS.Y, profile: null },
  ];
  $('scanners').innerHTML = scanners.map((s) => `
    <div class="panel scan" id="sc-${s.id}">
      <h3><i class="sw" style="background:${s.color}"></i>${esc(s.name)} <span class="tok">${esc(s.sub)}</span></h3>
      <canvas class="raw" aria-label="${esc(s.name)} as scanned"></canvas>
      <p class="row-l"><span>as scanned</span><span>ΔE vs A <b class="de-raw">–</b></span></p>
      <canvas class="nrm" aria-label="${esc(s.name)} after normalization"></canvas>
      <p class="row-l"><span>normalized</span><span>ΔE vs A <b class="de-nrm">–</b></span></p>
    </div>`).join('');

  const results = {};
  let pick = 'B';

  function yourProfile() {
    return OC.adjust(T.STAIN_REF, {
      name: 'Your scanner',
      hStrength: +$('y-h').value,
      eStrength: +$('y-e').value,
      hBlue: +$('y-b').value,
      warm: +$('y-w').value,
      bright: +$('y-l').value,
    });
  }

  function computeScanner(s) {
    const prof = s.id === 'Y' ? yourProfile() : s.profile;
    const px = T.render(spotSlide, spot.x - (SZ * PS) / 2, spot.y - (SZ * PS) / 2, SZ, SZ, PS, prof);
    const white = OC.glassWhite(spotSlide, prof);
    const est = OC.macenko(px, N, { white });
    const nrm = est ? OC.normalize(px, N, est, cal.target) : px;
    results[s.id] = { px, nrm, est, white };
  }

  function renderScanners() {
    const a = results.A;
    for (const s of scanners) {
      const r = results[s.id];
      const el = $('sc-' + s.id);
      toCanvas(el.querySelector('.raw'), r.px, SZ, SZ);
      toCanvas(el.querySelector('.nrm'), r.nrm, SZ, SZ);
      el.querySelector('.de-raw').textContent = s.id === 'A' ? '0' : OC.deltaE(r.px, a.px, N).toFixed(1);
      el.querySelector('.de-nrm').textContent = s.id === 'A' ? '0' : OC.deltaE(r.nrm, a.nrm, N).toFixed(1);
    }
    renderOD();
    renderUnmix();
  }

  // ---------- OD scatter ----------
  const th = cal.target.h;
  const te = (() => { const d = th[0] * cal.target.e[0] + th[1] * cal.target.e[1] + th[2] * cal.target.e[2]; return T.norm3(cal.target.e.map((v, k) => v - d * th[k])); })();
  const proj = (od) => [od[0] * th[0] + od[1] * th[1] + od[2] * th[2], od[0] * te[0] + od[1] * te[1] + od[2] * te[2]];
  let odPts = [];

  function renderOD() {
    const W = 360, H = 260, pad = { l: 34, r: 12, t: 12, b: 30 };
    const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
    const xmax = 1.6, ymin = -0.25, ymax = 0.55;
    const X = (v) => pad.l + (v / xmax) * iw, Y = (v) => pad.t + ((ymax - v) / (ymax - ymin)) * ih;
    odPts = [];
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Pixels of each scanner in optical density space, with estimated dye directions">`;
    for (const v of [0, 0.5, 1, 1.5]) svg += `<line class="gridline" x1="${X(v)}" x2="${X(v)}" y1="${pad.t}" y2="${pad.t + ih}"/><text class="axis-t" x="${X(v)}" y="${H - 14}" text-anchor="middle">${v}</text>`;
    for (const v of [-0.2, 0, 0.2, 0.4]) svg += `<line class="gridline" x1="${pad.l}" x2="${W - pad.r}" y1="${Y(v)}" y2="${Y(v)}"/><text class="axis-t" x="${pad.l - 6}" y="${Y(v) + 4}" text-anchor="end">${v}</text>`;
    svg += `<text class="axis-t" x="${pad.l + iw / 2}" y="${H - 1}" text-anchor="middle">along reference hematoxylin →</text>`;
    for (const s of scanners) {
      const r = results[s.id];
      let k = 0;
      for (let i = 0; i < N && k < 300; i += 23) {
        const od = [0, 1, 2].map((c) => -Math.log10(Math.max(1, r.px[i * 4 + c]) / r.white[c]));
        if (od[0] + od[1] + od[2] < 0.12) continue;
        const [x, y] = proj(od);
        if (x > xmax || y < ymin || y > ymax) continue;
        odPts.push({ s, x: X(x), y: Y(y), od });
        svg += `<circle class="od-pt" cx="${X(x).toFixed(1)}" cy="${Y(y).toFixed(1)}" r="1.8" fill="${s.color}"/>`;
        k++;
      }
    }
    for (const s of scanners) {
      const est = results[s.id].est;
      if (!est) continue;
      for (const [vec, lab] of [[est.h, 'H'], [est.e, 'E']]) {
        const [x, y] = proj(vec.map((v) => v * 1.35));
        svg += `<line class="ray" x1="${X(0)}" y1="${Y(0)}" x2="${X(x).toFixed(1)}" y2="${Y(y).toFixed(1)}" stroke="${s.color}"/>`;
        if (s.id === pick) svg += `<text class="lab" x="${(X(x) + 4).toFixed(1)}" y="${(Y(y) + 4).toFixed(1)}">${lab}</text>`;
      }
    }
    svg += '</svg>';
    $('od').innerHTML = svg;
    const el = $('od').querySelector('svg');
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      const mx = ((e.clientX - r.left) / r.width) * W, my = ((e.clientY - r.top) / r.height) * H;
      let best = null, bd = 64;
      for (const p of odPts) { const d = (p.x - mx) ** 2 + (p.y - my) ** 2; if (d < bd) { bd = d; best = p; } }
      if (!best) return hideTip();
      showTip(`<span class="tl">${esc(best.s.name)} pixel</span><br>OD r ${best.od[0].toFixed(2)} · g ${best.od[1].toFixed(2)} · b ${best.od[2].toFixed(2)}`, e.clientX, e.clientY);
    });
    el.addEventListener('pointerleave', hideTip);
  }
  $('od-legend').innerHTML = scanners.map((s) => `<span><i class="sw" style="background:${s.color}"></i>${esc(s.name)}</span>`).join('');

  // ---------- one dye at a time ----------
  $('unmix-pick').innerHTML = scanners.map((s) => `<button type="button" data-id="${s.id}" aria-pressed="${s.id === pick}">${s.id === 'Y' ? 'Yours' : s.id}</button>`).join('');
  $('unmix-pick').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    pick = b.dataset.id;
    $('unmix-pick').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    renderOD();
    renderUnmix();
  });

  function renderUnmix() {
    const r = results[pick];
    const est = r.est;
    const hpx = new Uint8ClampedArray(N * 4), epx = new Uint8ClampedArray(N * 4);
    const od = [0, 0, 0], c2 = [0, 0];
    for (let i = 0; i < N; i++) {
      for (let c = 0; c < 3; c++) od[c] = -Math.log10(Math.max(1, r.px[i * 4 + c]) / r.white[c]);
      OC.unmix(od, est.h, est.e, c2);
      for (let c = 0; c < 3; c++) {
        hpx[i * 4 + c] = 255 * Math.pow(10, -Math.max(0, c2[0]) * cal.target.h[c]);
        epx[i * 4 + c] = 255 * Math.pow(10, -Math.max(0, c2[1]) * cal.target.e[c]);
      }
      hpx[i * 4 + 3] = 255;
      epx[i * 4 + 3] = 255;
    }
    toCanvas($('ch-h'), hpx, SZ, SZ);
    toCanvas($('ch-e'), epx, SZ, SZ);
    const v = (a) => `[${a.map((x) => x.toFixed(2)).join(', ')}]`;
    const s = scanners.find((x) => x.id === pick);
    $('vecs').textContent =
`${s.name}, estimated from its pixels
hematoxylin  ${v(est.h)}  strength ${est.maxH.toFixed(2)}
eosin        ${v(est.e)}  strength ${est.maxE.toFixed(2)}
glass white  ${v(est.I0.map((x) => x / 255))}
reference H  ${v(cal.target.h)}  strength ${cal.target.maxH.toFixed(2)}`;
  }

  // Sliders for your scanner.
  const yFmt = { 'y-h': (v) => `${(+v).toFixed(2)}×`, 'y-e': (v) => `${(+v).toFixed(2)}×`, 'y-b': (v) => `${Math.round(v * 100)}%`, 'y-w': (v) => (+v).toFixed(1), 'y-l': (v) => `${Math.round(v * 100)}%` };
  let yRaf = 0;
  for (const id of Object.keys(yFmt)) {
    $(id + '-o').textContent = yFmt[id]($(id).value);
    $(id).addEventListener('input', () => {
      $(id + '-o').textContent = yFmt[id]($(id).value);
      if (yRaf) return;
      yRaf = requestAnimationFrame(() => {
        yRaf = 0;
        computeScanner(scanners[3]);
        renderScanners();
      });
    });
  }
  for (const s of scanners) computeScanner(s);
  renderScanners();

  // ======================================================================
  // The stream
  // ======================================================================
  const C = OC.CONFIG;
  const TOTAL = OC.totalEvents();
  const START = Date.UTC(2026, 9, 5, 0, 0, 0); // the simulated Monday the stream starts
  let mon, next, simHour, playing, speed = 4, normOn = false, lastT = 0, raf = 0, skipping = false, lastDraw = 0;

  function reset() {
    mon = new OC.Monitor();
    next = 0;
    simHour = 0;
    playing = false;
    skipping = false;
    $('feed').innerHTML = '';
    $('evjson').textContent = 'Nothing yet. Press Play.';
    $('play').textContent = '▶ Play';
    drawStream(true);
  }

  const clockText = (h) => {
    if (h >= C.hours) return 'Day 3 · 24:00';
    const d = Math.floor(h / 24) + 1, hh = Math.floor(h % 24), mm = Math.floor((h % 1) * 60);
    return `Day ${d} · ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  };
  const when = (h) => (h >= C.hours ? 'end' : clockText(h).replace(' · ', ', '));

  function step(budgetMs) {
    const t0 = performance.now();
    let added = 0;
    while (next < TOTAL && OC.eventMeta(next).hour <= simHour && performance.now() - t0 < budgetMs) {
      addFeed(mon.process(next));
      next++;
      added++;
    }
    if (next >= TOTAL && !mon.done) {
      mon.flush();
      mon.done = true;
      playing = false;
      $('play').textContent = '▶ Play';
    }
    return added;
  }

  function loop(t) {
    raf = 0;
    const dt = lastT ? Math.min(0.1, (t - lastT) / 1000) : 0;
    lastT = t;
    if (skipping) {
      simHour = C.hours + 1;
      step(45);
    } else if (playing) {
      // Don't let the clock run ahead of what's been processed.
      const behind = next < TOTAL && OC.eventMeta(next).hour < simHour - 1;
      if (!behind) simHour = Math.min(C.hours, simHour + dt * speed);
      step(30);
      if (simHour >= C.hours && next < TOTAL) simHour = C.hours + 1;
    }
    if (t - lastDraw > 90 || mon.done) { drawStream(); lastDraw = t; }
    if ((playing || skipping) && !mon.done) raf = requestAnimationFrame(loop);
    else { skipping = false; drawStream(); }
  }
  const go = () => { lastT = 0; if (!raf) raf = requestAnimationFrame(loop); };

  $('play').addEventListener('click', () => {
    if (mon.done) reset();
    playing = !playing;
    $('play').textContent = playing ? '❚❚ Pause' : '▶ Play';
    if (playing) go();
  });
  $('skip').addEventListener('click', () => { if (mon.done) return; skipping = true; playing = false; $('play').textContent = '▶ Play'; go(); });
  $('reset').addEventListener('click', () => { if (raf) cancelAnimationFrame(raf); raf = 0; reset(); });
  $('speed').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    speed = +b.dataset.speed;
    $('speed').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  });
  $('norm').addEventListener('change', (e) => { normOn = e.target.checked; drawStream(true); });

  // ---------- feed and event JSON ----------
  const feedMax = 6;
  function addFeed(ev) {
    const li = document.createElement('li');
    li.className = 'new';
    const cv = document.createElement('canvas');
    toCanvas(cv, ev.px, C.patch, C.patch);
    const pred = normOn ? ev.predNorm : ev.predRaw;
    let status;
    if (ev.quarantined) status = `<span class="tag warn">${ev.reason || 'out of focus'} → rescan</span>`;
    else status = `<span class="tag ${pred === ev.dense ? '' : 'bad'}">${pred ? 'atypical' : 'typical'}${pred === ev.dense ? '' : ' ✗'}</span>`;
    li.innerHTML = `<span></span><span><span class="id">${esc(ev.slide)}</span><span class="meta"><i class="sw" style="background:${COLORS[ev.scanner]}"></i>Scanner ${ev.scanner} · ${clockText(ev.hour).split(' · ')[1]}</span></span>${status}`;
    li.firstChild.replaceWith(cv);
    const feed = $('feed');
    feed.prepend(li);
    while (feed.children.length > feedMax) feed.lastChild.remove();
    lastEvent = ev;
  }
  let lastEvent = null;

  function eventJson(ev) {
    const r3 = (a) => a.map((x) => +x.toFixed(3));
    const o = {
      event_id: `scan-${String(ev.i).padStart(6, '0')}`,
      scanner_id: ev.scanner,
      slide_id: ev.slide,
      scanned_at: new Date(START + ev.hour * 3600e3).toISOString().slice(0, 19) + 'Z',
      qc: { focus: Math.round(ev.focus), passed: !ev.quarantined },
    };
    if (!ev.quarantined) {
      o.stain = { hematoxylin: r3(ev.est.h), eosin: r3(ev.est.e), h_strength: +ev.est.maxH.toFixed(3), glass_white: ev.est.I0.map(Math.round) };
      o.model = { version: normOn ? 'atypia-v3-norm' : 'atypia-v3', atypical: normOn ? ev.predNorm : ev.predRaw };
    } else {
      o.routed_to = 'scans.rescan';
    }
    return JSON.stringify(o, null, 2)
      .replace(/("[\w]+"):/g, '<span class="k">$1</span>:')
      .replace(/: ("[^"]*")/g, ': <span class="s">$1</span>')
      .replace(/(-?\d+\.?\d*)(,?\n)/g, '<span class="n">$1</span>$2');
  }

  // ---------- charts ----------
  const CHARTS = [
    { el: 'c-maxH', title: 'Hematoxylin strength', sub: '4-hour window mean of each patch\'s estimate', metric: 'maxH', dom: [0.6, 1.8], ticks: [0.8, 1.2, 1.6], fmt: (v) => v.toFixed(2), get: (w) => w.medians.maxH },
    { el: 'c-white', title: 'Glass brightness', sub: 'mean of the slide\'s bare-glass white, 0 to 255', metric: 'white', dom: [140, 255], ticks: [160, 200, 240], fmt: (v) => Math.round(v), get: (w) => w.medians.white },
    { el: 'c-acc', title: 'Model accuracy', sub: '', metric: null, dom: [0, 1], ticks: [0, 0.5, 1], fmt: (v) => Math.round(v * 100) + '%', get: (w) => (normOn ? w.accNorm : w.accRaw) },
  ];
  const W = 640, H = 168, pad = { l: 40, r: 34, t: 34, b: 22 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const X = (h) => pad.l + (h / C.hours) * iw;
  const xMid = (w) => (w.start + w.end) / 2;

  function chartSvg(ch) {
    const Y = (v) => pad.t + ((ch.dom[1] - v) / (ch.dom[1] - ch.dom[0])) * ih;
    const sub = ch.metric ? ch.sub : normOn ? 'per 4-hour window · model trained and served on normalized patches' : 'per 4-hour window · model trained on Site A, served raw pixels';
    let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${ch.title} per scanner over 72 hours">`;
    s += `<text class="ttl" x="${pad.l}" y="12">${ch.title}</text><text class="sub" x="${pad.l}" y="26">${sub}</text>`;
    s += `<rect class="base-band" x="${X(0)}" y="${pad.t}" width="${X(24) - X(0)}" height="${ih}"/>`;
    // Labels go where the lines aren't: under the lines for accuracy (which sits near 100%), above otherwise.
    const labY = ch.metric ? pad.t + 11 : pad.t + ih - 6;
    s += `<text class="axis-t" x="${X(12)}" y="${labY}" text-anchor="middle">baseline (day 1)</text>`;
    for (const v of ch.ticks) s += `<line class="gridline" x1="${pad.l}" x2="${W - pad.r}" y1="${Y(v)}" y2="${Y(v)}"/><text class="axis-t" x="${pad.l - 6}" y="${Y(v) + 4}" text-anchor="end">${ch.fmt(v)}</text>`;
    for (const d of [0, 1, 2]) s += `<text class="axis-t" x="${X(d * 24 + 12)}" y="${H - 5}" text-anchor="middle">day ${d + 1}</text>`;
    for (const d of [24, 48]) s += `<line class="gridline" x1="${X(d)}" x2="${X(d)}" y1="${pad.t + ih}" y2="${pad.t + ih + 5}"/>`;
    const nowH = shownHour();
    for (const inc of OC.INCIDENTS) {
      if (nowH < inc.at) continue;
      s += `<line class="incident" x1="${X(inc.at)}" x2="${X(inc.at)}" y1="${pad.t}" y2="${pad.t + ih}"/>`;
      if (ch.metric === 'maxH' || !ch.metric) s += `<text class="incident-l" x="${X(inc.at) + 4}" y="${labY}">${inc.scanner}: ${inc.kind === 'step' ? 'new dye lot' : 'lamp dimming'}</text>`;
      else s += `<text class="incident-l" x="${X(inc.at) + 4}" y="${labY}">${inc.scanner}</text>`;
    }
    const ends = [];
    for (const sc of OC.SCANNERS) {
      const ws = mon.windows[sc.id];
      if (!ws.length) continue;
      const pts = ws.map((w) => [X(xMid(w)), Y(Math.max(ch.dom[0], Math.min(ch.dom[1], ch.get(w))))]);
      s += `<path class="ln" stroke="${COLORS[sc.id]}" d="M${pts.map((p) => p.map((v) => v.toFixed(1)).join(',')).join('L')}"/>`;
      if (ch.metric) {
        ws.forEach((w, i) => { if (w.alert[ch.metric]) s += `<circle class="alert-dot" cx="${pts[i][0].toFixed(1)}" cy="${pts[i][1].toFixed(1)}" r="5" fill="${COLORS[sc.id]}"/>`; });
      }
      const last = pts[pts.length - 1];
      ends.push({ id: sc.id, x: last[0] + 6, y: last[1] + 4 });
    }
    // End labels: lines that finish together share one label instead of overprinting.
    ends.sort((a, b) => a.y - b.y);
    const groups = [];
    for (const e of ends) {
      const g = groups[groups.length - 1];
      if (g && Math.abs(e.y - g.y) < 10 && Math.abs(e.x - g.x) < 30) g.ids.push(e.id);
      else groups.push({ x: e.x, y: e.y, ids: [e.id] });
    }
    for (const g of groups) s += `<text class="lab" x="${g.x.toFixed(1)}" y="${g.y.toFixed(1)}">${g.ids.sort().join(' ')}</text>`;
    s += `<line class="xhair" x1="0" x2="0" y1="${pad.t}" y2="${pad.t + ih}" visibility="hidden"/>`;
    s += '</svg>';
    return s;
  }

  function wireHover(ch) {
    const el = $(ch.el), svg = el.querySelector('svg'), xh = svg.querySelector('.xhair');
    svg.addEventListener('pointermove', (e) => {
      const r = svg.getBoundingClientRect();
      const h = (((e.clientX - r.left) / r.width) * W - pad.l) / iw * C.hours;
      const idx = Math.floor(h / C.windowHours);
      const rows = OC.SCANNERS.map((sc) => ({ sc, w: mon.windows[sc.id].find((w) => w.index === idx) })).filter((x) => x.w);
      if (h < 0 || h > C.hours || !rows.length) { xh.setAttribute('visibility', 'hidden'); return hideTip(); }
      const xm = X(idx * C.windowHours + C.windowHours / 2);
      xh.setAttribute('x1', xm);
      xh.setAttribute('x2', xm);
      xh.setAttribute('visibility', 'visible');
      const t0 = idx * C.windowHours;
      showTip(`<span class="tl">${clockText(t0)}–${String((t0 + C.windowHours) % 24).padStart(2, '0')}:00</span><br>` +
        rows.map(({ sc, w }) => `<i class="sw" style="background:${COLORS[sc.id]}"></i> ${sc.id}: ${ch.fmt(ch.get(w))}${ch.metric && w.alert[ch.metric] ? ' · alert' : ''}`).join('<br>'), e.clientX, e.clientY);
    });
    svg.addEventListener('pointerleave', () => { xh.setAttribute('visibility', 'hidden'); hideTip(); });
  }

  $('s-legend').innerHTML = OC.SCANNERS.map((s) => `<span><i class="sw" style="background:${COLORS[s.id]}"></i>Scanner ${s.id}</span>`).join('') +
    '<span><svg width="12" height="12" aria-hidden="true"><circle cx="6" cy="6" r="4.5" fill="var(--ink-2)"/></svg>alert raised</span>' +
    '<span><svg width="14" height="12" aria-hidden="true"><line x1="7" x2="7" y1="0" y2="12" stroke="var(--ink-2)" stroke-dasharray="3 3"/></svg>what actually happened</span>';

  // Accuracy over the events in the last `hrs` hours, for the chosen path.
  function recentAcc(hrs, norm) {
    const evs = mon.events.filter((e) => !e.quarantined && e.hour > simHourNow() - hrs);
    if (!evs.length) return null;
    return evs.filter((e) => (norm ? e.predNorm : e.predRaw) === e.dense).length / evs.length;
  }
  const simHourNow = () => (mon.events.length ? mon.events[mon.events.length - 1].hour : 0);
  // The hour on the clock and charts. Running to the end sets simHour past the end to let every
  // scan through, so follow the scans processed so far instead.
  const shownHour = () => (mon.done ? C.hours : skipping ? simHourNow() : Math.min(C.hours, simHour));

  function drawStream(force) {
    for (const ch of CHARTS) { $(ch.el).innerHTML = chartSvg(ch); wireHover(ch); }
    $('clock').textContent = mon.done ? 'Day 3 · 24:00 · done' : clockText(shownHour());
    const a = recentAcc(12, normOn), b = recentAcc(12, !normOn);
    $('sstats').innerHTML = [
      stat('Scans processed', fmtInt(mon.events.length), `of ${fmtInt(TOTAL)}`),
      stat('Sent to rescan', fmtInt(mon.quarantined), 'failed focus or stain QC'),
      stat('Alerts', mon.alerts.length, mon.alerts.length ? `latest: Scanner ${mon.alerts[mon.alerts.length - 1].scanner}` : 'quiet so far'),
      stat('Accuracy, last 12 h', a == null ? '–' : Math.round(a * 100) + '%', normOn ? 'with normalization' : 'raw pixels'),
      stat(normOn ? 'If served raw' : 'If normalized', b == null ? '–' : Math.round(b * 100) + '%', 'same scans, last 12 h'),
    ].join('');
    if (lastEvent) $('evjson').innerHTML = eventJson(lastEvent);
    renderAlerts();
    renderMsg();
    if (force || mon.done) renderTable();
  }

  function renderAlerts() {
    const el = $('alerts');
    el.innerHTML = mon.alerts.map((al) => {
      const inc = OC.INCIDENTS.find((x) => x.scanner === al.scanner && x.at <= al.at);
      const fmt = al.metric === 'white' ? (v) => Math.round(v) : al.metric === 'hAngle' ? (v) => v.toFixed(1) + '°' : (v) => v.toFixed(2);
      const lag = inc ? `${Math.round(al.at - inc.at)} h after the real cause: ${inc.label[0].toLowerCase() + inc.label.slice(1)}` : 'no known cause: a false alarm';
      return `<li><span class="when">${when(al.at)}</span><span><strong>Scanner ${al.scanner}: ${al.label.toLowerCase()} ${al.dir}</strong>,
        ${fmt(al.base)} → ${fmt(al.value)} (z = ${al.z.toFixed(1)}). Page the lab.<span class="delay">Raised ${lag}</span></span></li>`;
    }).join('');
  }

  // Accuracy of a scanner's windows in an hour range, for the chosen path.
  function accIn(sid, h0, h1, norm) {
    const evs = mon.events.filter((e) => e.scanner === sid && !e.quarantined && e.hour >= h0 && e.hour < h1);
    if (evs.length < 8) return null;
    return evs.filter((e) => (norm ? e.predNorm : e.predRaw) === e.dense).length / evs.length;
  }

  function renderMsg() {
    const el = $('smsg');
    const pc = (v) => Math.round(v * 100) + '%';
    if (!mon.events.length) {
      el.className = 'msg';
      el.innerHTML = 'Press <strong>Play</strong>. Day one is quiet: it\'s the baseline every scanner will be compared against.';
      return;
    }
    if (!mon.done) {
      const last = mon.alerts[mon.alerts.length - 1];
      el.className = last ? 'msg warn' : 'msg';
      el.innerHTML = last
        ? `<strong>Scanner ${last.scanner} alerted at ${when(last.at)}.</strong> The monitor only saw pixels: ${last.label.toLowerCase()} moved
          ${Math.abs(last.z).toFixed(1)} standard deviations from that scanner's own baseline, and the CUSUM crossed its limit.`
        : shownHour() < 24 ? 'Learning the baseline: each scanner\'s normal range of stain strength, hue and glass brightness.' : 'Monitoring. Nothing has moved beyond normal variation yet.';
      return;
    }
    const bBefore = accIn('B', 24, 30, false), bAfter = accIn('B', 36, 72, false), bNorm = accIn('B', 36, 72, true);
    const cEarly = accIn('C', 44, 60, false), cLate = accIn('C', 64, 72, false);
    const cAlert = mon.alerts.find((a) => a.scanner === 'C');
    const bAlert = mon.alerts.find((a) => a.scanner === 'B');
    el.className = 'msg ' + (normOn ? 'good' : 'warn');
    el.innerHTML = normOn
      ? `<strong>With normalization at ingest the model held up:</strong> Scanner B stayed at ${pc(bNorm)} after the new dye lot.
        The alerts still fired, and they should: a dye lot that shifts color this much is worth a call to the lab even when the
        model copes. Untick the box to see what the same scans did to the raw-pixel model.`
      : `<strong>Raw pixels:</strong> Scanner B's accuracy went from ${pc(bBefore)} to ${pc(bAfter)} after the new dye lot, and the
        monitor flagged it ${bAlert ? Math.round(bAlert.at - 30) + ' hours' : 'soon'} after it started. Scanner C's lamp dimmed slowly; the
        monitor caught it at ${cAlert ? when(cAlert.at) : '–'}, while the model was still at ${pc(cEarly)}. It only started failing
        near the end (${pc(cLate)} in the last 8 hours). Tick <em>Normalize at ingest</em> to replay the same scans through the fixed pipeline.`;
  }

  function renderTable() {
    const rows = [];
    for (const sc of OC.SCANNERS) for (const w of mon.windows[sc.id]) rows.push(`<tr><td>${sc.id}</td><td>${w.start}–${w.end} h</td><td>${w.medians.maxH.toFixed(2)}</td><td>${Math.round(w.medians.white)}</td><td>${Math.round(w.accRaw * 100)}%</td><td>${Math.round(w.accNorm * 100)}%</td></tr>`);
    $('c-table').innerHTML = `<caption>Window means per scanner</caption><thead><tr><th>Scanner</th><th>Window</th><th>Hematoxylin strength</th><th>Glass brightness</th><th>Accuracy, raw</th><th>Accuracy, normalized</th></tr></thead><tbody>${rows.join('')}</tbody>`;
  }

  reset();
})();
