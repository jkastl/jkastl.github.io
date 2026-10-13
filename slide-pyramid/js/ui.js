/* Slide Pyramid's page: the tiled viewer, the training-set panel and the scale estimates. */
(function () {
  'use strict';
  const T = globalThis.Tissue, P = globalThis.SP;
  const $ = (id) => document.getElementById(id);
  const fmtInt = (n) => Math.round(n).toLocaleString('en-US');
  const fmtB = P.fmtBytes;
  const pct = (a, b) => {
    const v = (100 * a) / b;
    return v === 0 ? '0%' : v < 0.01 ? '<0.01%' : v < 1 ? v.toFixed(2) + '%' : v.toFixed(1) + '%';
  };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const stat = (label, value, note) =>
    `<div class="stat"><span class="stat-label">${label}</span><span class="stat-value">${value}</span>${note ? `<span class="stat-note">${note}</span>` : ''}</div>`;

  const slide = T.makeSlide(P.CONFIG.seed);
  const SLIDE_ID = 'S26-4021-A1';
  const levels = P.levels(slide);
  const TOP = levels.length - 1;
  const size = P.fileSize(slide);
  const FULL_RGB = levels[0].width * levels[0].height * 3;

  // ---------- tooltip ----------
  const tip = $('tip');
  function showTip(html, x, y) {
    tip.innerHTML = html;
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    tip.style.left = Math.min(window.innerWidth - r.width - 8, x + 14) + 'px';
    tip.style.top = Math.max(8, y - r.height - 10) + 'px';
  }
  const hideTip = () => { tip.hidden = true; };

  // ======================================================================
  // Viewer
  // ======================================================================
  const stage = $('stage'), canvas = $('view'), ctx = canvas.getContext('2d');
  const mini = $('mini'), mctx = mini.getContext('2d');
  let cssW = 1, cssH = 1, dpr = 1;
  const view = { cx: slide.widthUm / 2, cy: slide.heightUm / 2, ps: 40 }; // ps: µm per CSS pixel
  const MIN_PS = T.MPP0 / 4;
  const cache = new P.LRU(320);
  const queue = [];
  const queued = new Set();
  const st = { fetched: 0, bytes: 0, requests: 0, hits: 0, cancelled: 0 };
  const readPerLevel = new Array(levels.length).fill(0);
  let inView = new Set();
  let showGrid = false;
  let lastL = TOP, lastWant = 0;

  function makeTile(t) {
    const lv = levels[t.level];
    const r = P.tileRect(slide, lv, t.col, t.row);
    const w = Math.max(1, Math.round(r.w / lv.ps)), h = Math.max(1, Math.round(r.h / lv.ps));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d').putImageData(new ImageData(T.render(slide, r.x, r.y, w, h, lv.ps), w, h), 0, 0);
    return { canvas: c, rect: r, ps: lv.ps };
  }
  // The single top tile is the fallback under everything, so it's loaded first and kept.
  const topTile = makeTile({ level: TOP, col: 0, row: 0 });
  st.fetched = 1;
  st.bytes = P.tileBytes(slide, levels[TOP], 0, 0);
  readPerLevel[TOP] = st.bytes;

  const fitPs = () => Math.max(slide.widthUm / cssW, slide.heightUm / cssH) * 1.06;
  const maxPs = () => fitPs() * 1.6;

  function clampView() {
    view.ps = Math.min(maxPs(), Math.max(MIN_PS, view.ps));
    view.cx = Math.min(slide.widthUm, Math.max(0, view.cx));
    view.cy = Math.min(slide.heightUm, Math.max(0, view.cy));
  }

  // Device-pixel rectangle for a µm rectangle, with edges rounded so neighbouring tiles meet.
  function devRect(x0, y0, r) {
    const k = dpr / view.ps;
    const X0 = Math.round((r.x - x0) * k), Y0 = Math.round((r.y - y0) * k);
    const X1 = Math.round((r.x + r.w - x0) * k), Y1 = Math.round((r.y + r.h - y0) * k);
    return [X0, Y0, X1 - X0, Y1 - Y0];
  }

  // Draw the part of a cached tile `src` that covers µm rect r.
  function drawPart(src, r, x0, y0) {
    const sx = (r.x - src.rect.x) / src.ps, sy = (r.y - src.rect.y) / src.ps;
    const sw = r.w / src.ps, sh = r.h / src.ps;
    const [X, Y, W, H] = devRect(x0, y0, r);
    ctx.drawImage(src.canvas, sx, sy, sw, sh, X, Y, W, H);
  }

  function enqueue(t, key) {
    if (queued.has(key)) return;
    queued.add(key);
    queue.push(Object.assign({ key }, t));
  }

  let raf = 0;
  const schedule = () => { if (!raf) raf = requestAnimationFrame(frame); };

  // Each frame "fetches" queued tiles for up to ~12 ms, then redraws with whatever has arrived.
  function frame() {
    raf = 0;
    const t0 = performance.now();
    while (queue.length && performance.now() - t0 < 12) {
      const t = queue.shift();
      queued.delete(t.key);
      if (cache.has(t.key)) continue;
      cache.set(t.key, makeTile(t));
      const b = P.tileBytes(slide, levels[t.level], t.col, t.row);
      st.fetched++;
      st.bytes += b;
      readPerLevel[t.level] += b;
    }
    draw();
    if (queue.length) schedule();
  }

  function draw() {
    const W = canvas.width, H = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0b0b0b';
    ctx.fillRect(0, 0, W, H);
    const ps = view.ps;
    const x0 = view.cx - (cssW / 2) * ps, y0 = view.cy - (cssH / 2) * ps;
    const x1 = x0 + cssW * ps, y1 = y0 + cssH * ps;
    const L = P.chooseLevel(levels, ps / dpr);
    const lv = levels[L];
    // Past full resolution, show the pixels rather than smearing them.
    ctx.imageSmoothingEnabled = !(L === 0 && ps / dpr < T.MPP0 * 0.7);
    ctx.imageSmoothingQuality = 'high';

    drawPart(topTile, { x: 0, y: 0, w: slide.widthUm, h: slide.heightUm }, x0, y0);

    const want = P.tilesInView(lv, x0, y0, x1, y1);
    const now = new Set();
    for (const t of want) {
      const key = P.tileKey(t);
      now.add(key);
      if (!inView.has(key)) {
        st.requests++;
        if (cache.has(key) || L === TOP) st.hits++;
        else enqueue(t, key);
      }
      const r = P.tileRect(slide, lv, t.col, t.row);
      const tile = L === TOP ? topTile : cache.get(key);
      if (tile) { drawPart(tile, r, x0, y0); continue; }
      // Not here yet: stretch the nearest coarser level that is.
      for (let k = L + 1; k < TOP; k++) {
        const anc = cache.peek(`${k}/${t.col >> (k - L)}/${t.row >> (k - L)}`);
        if (anc) { drawPart(anc, r, x0, y0); break; }
      }
    }
    // Requests for tiles that scrolled away are dropped before they're "read".
    for (let i = queue.length - 1; i >= 0; i--) {
      if (!now.has(queue[i].key)) { queued.delete(queue[i].key); queue.splice(i, 1); st.cancelled++; }
    }
    // Centre-first order follows the current view.
    const order = new Map(want.map((t, i) => [P.tileKey(t), i]));
    queue.sort((a, b) => order.get(a.key) - order.get(b.key));
    inView = now;

    if (showGrid) drawGrid(lv, want, x0, y0);
    lastL = L;
    lastWant = want.length;
    $('badge').hidden = queue.length === 0;
    $('badge').textContent = `loading ${queue.length} tile${queue.length === 1 ? '' : 's'}`;
    updateStats(L, want, x0, y0, x1, y1);
    drawMini(x0, y0, x1, y1);
  }

  function drawGrid(lv, want, x0, y0) {
    ctx.lineWidth = Math.max(1, dpr);
    ctx.font = `600 ${11 * dpr}px ui-monospace, Menlo, Consolas, monospace`;
    ctx.textBaseline = 'top';
    for (const t of want) {
      const [X, Y, W, H] = devRect(x0, y0, P.tileRect(slide, lv, t.col, t.row));
      ctx.strokeStyle = cache.has(P.tileKey(t)) || lv.level === TOP ? 'rgba(122,167,255,0.9)' : 'rgba(224,165,38,0.9)';
      ctx.strokeRect(X + 0.5, Y + 0.5, W - 1, H - 1);
      if (W > 70 * dpr && H > 24 * dpr) {
        const label = `${t.level}/${t.col}/${t.row}`;
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = 'rgba(14,26,51,0.85)';
        ctx.fillRect(X + 4 * dpr, Y + 4 * dpr, tw + 8 * dpr, 17 * dpr);
        ctx.fillStyle = '#e8eefc';
        ctx.fillText(label, X + 8 * dpr, Y + 7 * dpr);
      }
    }
  }

  // ---------- overview ----------
  let miniImg = null, miniW = 0;
  function renderMini() {
    const w = Math.round(mini.clientWidth * dpr);
    if (!w || Math.abs(w - miniW) < 4) return;
    miniW = w;
    const h = Math.round((w * slide.heightUm) / slide.widthUm);
    mini.width = w;
    mini.height = h;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d').putImageData(new ImageData(T.render(slide, 0, 0, w, h, slide.widthUm / w), w, h), 0, 0);
    miniImg = c;
  }
  function drawMini(x0, y0, x1, y1) {
    if (!miniImg) return;
    const k = mini.width / slide.widthUm;
    mctx.drawImage(miniImg, 0, 0);
    mctx.strokeStyle = '#7aa7ff';
    mctx.lineWidth = 2 * dpr;
    const X = x0 * k, Y = y0 * k, W = Math.max(4 * dpr, (x1 - x0) * k), H = Math.max(4 * dpr, (y1 - y0) * k);
    mctx.strokeRect(X, Y, W, H);
  }
  function miniTo(e) {
    const r = mini.getBoundingClientRect();
    view.cx = ((e.clientX - r.left) / r.width) * slide.widthUm;
    view.cy = ((e.clientY - r.top) / r.height) * slide.heightUm;
    clampView();
    schedule();
  }
  let miniDrag = false;
  mini.addEventListener('pointerdown', (e) => { miniDrag = true; mini.setPointerCapture(e.pointerId); miniTo(e); });
  mini.addEventListener('pointermove', (e) => { if (miniDrag) miniTo(e); });
  mini.addEventListener('pointerup', () => { miniDrag = false; });

  // ---------- stats ----------
  const pyrBody = $('pyr').querySelector('tbody');
  const maxShare = Math.max(...size.perLevel);
  pyrBody.innerHTML = levels.map((lv) => `<tr data-l="${lv.level}">
      <td>${lv.level}${lv.level === 0 ? ' (full)' : ''}</td>
      <td>${lv.ps < 1 ? lv.ps.toFixed(2) : lv.ps.toFixed(lv.ps < 10 ? 1 : 0)}</td>
      <td>${fmtInt(lv.width)} × ${fmtInt(lv.height)}</td>
      <td>${fmtInt(lv.tiles)}</td>
      <td><span class="bar"><i style="width:${Math.max(0.5, (78 * size.perLevel[lv.level]) / maxShare)}%"></i><span>${pct(size.perLevel[lv.level], size.total)}</span></span></td>
      <td>${fmtB(size.perLevel[lv.level])}</td>
      <td class="rd">0 B</td></tr>`).join('');
  const pyrRows = [...pyrBody.rows];

  function updateStats(L, want, x0, y0, x1, y1) {
    const lv = levels[L];
    const mag = P.magnification(view.ps);
    const loading = want.filter((t) => L !== TOP && !cache.has(P.tileKey(t))).length;
    const hitRate = st.requests ? Math.round((100 * st.hits) / st.requests) + '%' : '–';
    $('vstats').innerHTML = [
      stat('Level read', `${L} of ${TOP}`, `${lv.ps < 1 ? lv.ps.toFixed(2) : lv.ps.toFixed(1)} µm per pixel`),
      stat('On screen', `≈ ${mag >= 10 ? Math.round(mag) : mag.toFixed(mag < 1 ? 2 : 1)}×`, `${(view.ps < 1 ? view.ps.toFixed(2) : view.ps.toFixed(1))} µm per screen px`),
      stat('Tiles in view', want.length, loading ? `${loading} still arriving` : 'all here'),
      stat('Read from file', fmtB(st.bytes), `${pct(st.bytes, size.total)} of ${fmtB(size.total)}`),
      stat('Tile requests', fmtInt(st.requests), `${hitRate} from cache`),
      stat('Cancelled', fmtInt(st.cancelled), 'scrolled away first'),
      stat('In memory', fmtB(cache.size * 256 * 256 * 3), `${cache.size} tiles; ${fmtInt(cache.evictions)} evicted`),
      stat('All of it, decoded', fmtB(FULL_RGB), `${(FULL_RGB / 3 / 1e9).toFixed(1)} gigapixels`),
    ].join('');

    pyrRows.forEach((tr, i) => {
      tr.classList.toggle('on', i === L);
      tr.querySelector('.rd').textContent = fmtB(readPerLevel[i]);
    });

    // Compare with reading the same view from level 0. Zoomed out that's up to every one of its
    // tiles, so count them from the range rather than listing them.
    const l0 = levels[0];
    const g = P.tileRange(l0, x0, y0, x1, y1);
    const n0 = Math.max(0, g.c1 - g.c0 + 1) * Math.max(0, g.r1 - g.r0 + 1);
    let b0 = 0;
    if (n0 < 20000) for (let r = g.r0; r <= g.r1; r++) for (let c = g.c0; c <= g.c1; c++) b0 += P.tileBytes(slide, l0, c, r);
    else b0 = size.perLevel[0] * (n0 / l0.tiles);
    let msg;
    if (view.ps / dpr < T.MPP0 * 0.7) {
      msg = `<strong>You're past the scanner's resolution.</strong> Each image pixel now covers several screen pixels, so
        there's nothing finer to read. Level 0 is the bottom of the pyramid.`;
    } else if (L === 0) {
      msg = `<strong>Full resolution.</strong> This view needs ${want.length} tiles of level 0, about ${fmtB(b0)}. At this
        zoom a quarter of a micrometre is one pixel: the dots in the purple are cell nuclei, the pink is everything else.`;
    } else {
      msg = `This view needs <strong>${want.length} tile${want.length === 1 ? '' : 's'}</strong> from level ${L}. Drawing the
        same view from full resolution would mean ${fmtInt(n0)} tiles and about <strong>${fmtB(b0)}</strong>, then
        throwing most of the pixels away to shrink them.`;
    }
    $('vmsg').innerHTML = msg;

    const btns = $('objectives').querySelectorAll('button');
    const fit = Math.abs(view.ps / fitPs() - 1) < 0.02;
    btns.forEach((b) => {
      const on = b.hasAttribute('data-fit') ? fit : Math.abs(P.magnification(view.ps) / +b.dataset.mag - 1) < 0.03;
      b.setAttribute('aria-pressed', String(on));
    });
  }

  // ---------- interaction ----------
  function zoomAt(sx, sy, f) {
    const wx = view.cx + (sx - cssW / 2) * view.ps, wy = view.cy + (sy - cssH / 2) * view.ps;
    view.ps *= f;
    clampView();
    view.cx = wx - (sx - cssW / 2) * view.ps;
    view.cy = wy - (sy - cssH / 2) * view.ps;
    clampView();
    schedule();
  }
  const hint = $('hint');
  const dismissHint = () => { hint.hidden = true; };

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const d = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(d * 0.0016));
    dismissHint();
  }, { passive: false });

  const pointers = new Map();
  let pinch = null;
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) };
    }
    dismissHint();
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const r = canvas.getBoundingClientRect();
    if (pointers.size === 1) {
      view.cx -= (e.clientX - p.x) * view.ps;
      view.cy -= (e.clientY - p.y) * view.ps;
      clampView();
      schedule();
    }
    p.x = e.clientX;
    p.y = e.clientY;
    if (pointers.size === 2 && pinch) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d > 0 && pinch.d > 0) zoomAt((a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top, pinch.d / d);
      pinch.d = d;
    }
  });
  const up = (e) => { pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null; };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('dblclick', (e) => {
    const r = canvas.getBoundingClientRect();
    zoomAt(e.clientX - r.left, e.clientY - r.top, e.shiftKey ? 2 : 0.5);
  });
  canvas.addEventListener('keydown', (e) => {
    const step = 120 * view.ps;
    const k = e.key;
    if (k === 'ArrowLeft') view.cx -= step;
    else if (k === 'ArrowRight') view.cx += step;
    else if (k === 'ArrowUp') view.cy -= step;
    else if (k === 'ArrowDown') view.cy += step;
    else if (k === '+' || k === '=') view.ps /= 1.5;
    else if (k === '-' || k === '_') view.ps *= 1.5;
    else return;
    e.preventDefault();
    clampView();
    schedule();
  });

  $('objectives').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.hasAttribute('data-fit')) {
      view.ps = fitPs();
      view.cx = slide.widthUm / 2;
      view.cy = slide.heightUm / 2;
    } else {
      // Zooming in from the overview lands on tissue rather than glass.
      if (Math.abs(view.ps / fitPs() - 1) < 0.02) {
        const f = slide.fragments[1] || slide.fragments[0];
        view.cx = f.cx;
        view.cy = f.cy;
      }
      view.ps = 10 / +b.dataset.mag;
    }
    clampView();
    schedule();
  });
  $('grid').addEventListener('change', (e) => { showGrid = e.target.checked; schedule(); });
  $('flush').addEventListener('click', () => {
    cache.map.clear();
    inView = new Set();
    schedule();
  });

  function resize() {
    const r = stage.getBoundingClientRect();
    const wasFit = Math.abs(view.ps / fitPs() - 1) < 0.02;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    cssW = Math.max(1, r.width);
    cssH = Math.max(1, r.height);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    if (wasFit || !resize.done) view.ps = fitPs();
    resize.done = true;
    clampView();
    renderMini();
    schedule();
  }
  new ResizeObserver(resize).observe(stage);

  // ======================================================================
  // Training set
  // ======================================================================
  const MASK_PS = 32; // µm per thumbnail pixel
  const TW = Math.round(slide.widthUm / MASK_PS), TH = Math.round(slide.heightUm / MASK_PS);
  const thumb = $('thumb'), tctx = thumb.getContext('2d');
  thumb.width = TW;
  thumb.height = TH;
  let thumbRgba = null;
  const ts = { method: 'saturation', auto: true, thr: 40, ink: false, minFrac: 0.5, patchUm: 128, level: 1, show: 'patches' };
  let result = null;

  function computeTraining() {
    if (!thumbRgba) {
      thumbRgba = T.render(slide, 0, 0, TW, TH, MASK_PS);
    }
    const m = P.tissueMask(thumbRgba, TW, TH, { method: ts.method, threshold: ts.auto ? null : ts.thr, removeInk: ts.ink });
    if (ts.auto) ts.thr = m.auto;
    const patches = P.patches(slide, m.mask, TW, TH, MASK_PS, ts.patchUm, ts.minFrac);
    result = { m, patches, stats: P.patchStats(patches), rows: P.manifest(SLIDE_ID, patches, ts.patchUm, ts.level) };
    renderTraining();
  }

  function drawThumb() {
    const { m, patches } = result;
    if (ts.show === 'mask') {
      const img = tctx.createImageData(TW, TH);
      for (let i = 0; i < TW * TH; i++) {
        const v = m.mask[i] ? 235 : 28;
        img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
      }
      tctx.putImageData(img, 0, 0);
      return;
    }
    tctx.putImageData(new ImageData(thumbRgba, TW, TH), 0, 0);
    if (ts.show !== 'patches') return;
    const s = ts.patchUm / MASK_PS;
    const inset = s >= 6 ? 1 : 0;
    for (const p of patches) {
      if (!p.kept) continue;
      const junk = p.trueTissue < 0.3;
      tctx.fillStyle = junk ? 'rgba(226,85,85,0.95)' : 'rgba(122,167,255,0.55)';
      tctx.fillRect(p.x / MASK_PS + inset, p.y / MASK_PS + inset, s - 2 * inset, s - 2 * inset);
    }
  }

  function drawHist() {
    const { m } = result;
    const bins = 64, per = 256 / bins;
    const counts = new Array(bins).fill(0);
    for (let i = 0; i < 256; i++) counts[Math.floor(i / per)] += m.hist[i];
    const W = 320, H = 130, pad = { l: 6, r: 6, t: 14, b: 22 };
    const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
    const ymax = Math.sqrt(Math.max(...counts));
    const bw = iw / bins;
    const xOf = (score) => pad.l + (score / 256) * iw;
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Histogram of pixel scores with the threshold at ${ts.thr}">`;
    svg += `<line class="gridline" x1="${pad.l}" x2="${W - pad.r}" y1="${pad.t + ih}" y2="${pad.t + ih}"/>`;
    counts.forEach((c, i) => {
      const h = ymax ? (Math.sqrt(c) / ymax) * ih : 0;
      const on = (i + 1) * per - 1 > ts.thr;
      svg += `<rect class="bin${on ? ' on' : ''}" data-i="${i}" x="${(pad.l + i * bw + 0.5).toFixed(2)}" y="${(pad.t + ih - h).toFixed(2)}" width="${Math.max(1, bw - 1).toFixed(2)}" height="${Math.max(0, h).toFixed(2)}" rx="1"/>`;
    });
    if (!ts.auto && m.auto !== ts.thr) {
      svg += `<line class="thr-auto" x1="${xOf(m.auto)}" x2="${xOf(m.auto)}" y1="${pad.t}" y2="${pad.t + ih}"/>`;
      svg += `<text class="axis-t" x="${xOf(m.auto) + 3}" y="${pad.t + 9}">Otsu ${m.auto}</text>`;
    }
    svg += `<line class="thr" x1="${xOf(ts.thr)}" x2="${xOf(ts.thr)}" y1="${pad.t - 6}" y2="${pad.t + ih}"/>`;
    const right = xOf(ts.thr) > W - 90;
    svg += `<text class="lab" x="${xOf(ts.thr) + (right ? -4 : 4)}" y="${pad.t - 2}" text-anchor="${right ? 'end' : 'start'}">threshold ${ts.thr}</text>`;
    svg += `<text class="axis-t" x="${pad.l}" y="${H - 6}">0 · glass</text>`;
    svg += `<text class="axis-t" x="${W - pad.r}" y="${H - 6}" text-anchor="end">255 · ${ts.method === 'brightness' ? 'darkest' : 'most colorful'}</text>`;
    svg += `<rect x="0" y="0" width="${W}" height="${H}" fill="transparent" class="hit"/>`;
    svg += '</svg>';
    const el = $('hist');
    el.innerHTML = svg;
    const s = el.querySelector('svg');
    s.addEventListener('pointermove', (e) => {
      const r = s.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * W;
      const i = Math.floor((x - pad.l) / bw);
      if (i < 0 || i >= bins) return hideTip();
      s.querySelectorAll('.bin').forEach((b) => b.classList.toggle('hl', +b.dataset.i === i));
      showTip(`<span class="tl">scores ${i * per}–${(i + 1) * per - 1}</span><br>${fmtInt(counts[i])} pixels · ${(i + 1) * per - 1 > ts.thr ? 'counted as tissue' : 'counted as glass'}`, e.clientX, e.clientY);
    });
    s.addEventListener('pointerleave', hideTip);
    $('hist-sub').textContent = ts.method === 'brightness'
      ? 'Darkness of each thumbnail pixel (255 minus brightness). Square-root scale so the small tissue hump is visible next to the glass.'
      : 'Saturation of each thumbnail pixel: glass is grey, stain is colorful. Square-root scale so the tissue hump is visible next to the glass.';
  }

  function renderTraining() {
    const { m, stats, rows } = result;
    $('thr').value = ts.thr;
    $('thr').disabled = ts.auto;
    $('thr-o').textContent = ts.auto ? `${ts.thr} (Otsu)` : ts.thr;
    $('min-o').textContent = Math.round(ts.minFrac * 100) + '%';
    $('tlegend').hidden = ts.show !== 'patches';
    drawThumb();
    drawHist();

    const sizePx = rows.length ? rows[0].size_px : Math.round(ts.patchUm / (T.MPP0 * 2 ** ts.level));
    $('tstats').innerHTML = [
      stat('Grid squares touching tissue', fmtInt(stats.candidates), `of ${fmtInt(Math.floor(slide.widthUm / ts.patchUm) * Math.floor(slide.heightUm / ts.patchUm))} on the slide`),
      stat('Patches kept', fmtInt(stats.kept), `${sizePx} × ${sizePx} px each`),
      stat('Kept, but glass or ink', fmtInt(stats.junk), stats.inkJunk ? `${fmtInt(stats.inkJunk)} of them are ink` : 'none of them ink'),
      stat('Solid tissue dropped', fmtInt(stats.missed), 'at least 80% tissue, not kept'),
    ].join('');

    let msg, cls = '';
    if (stats.inkJunk > 0 && !ts.ink) {
      cls = 'warn';
      msg = `<strong>The pen circle got in.</strong> Someone circled an area on the glass with a marker. Ink is dark and
        colorful, so both scores call it tissue, and ${fmtInt(stats.inkJunk)} patches of ink would go into the training
        set. Tick <em>Drop marker ink</em>: no H&amp;E stain is blue-green, so a color rule removes it.`;
    } else if (stats.missed > stats.kept * 0.1) {
      cls = 'warn';
      msg = `<strong>Too strict.</strong> ${fmtInt(stats.missed)} patches of solid tissue were dropped. Lower the threshold or
        the minimum tissue fraction.`;
    } else if (stats.junk > stats.kept * 0.05) {
      cls = 'warn';
      msg = `<strong>Too loose.</strong> ${fmtInt(stats.junk)} of the kept patches are mostly empty glass. Raise the threshold or
        the minimum tissue fraction.`;
    } else {
      cls = 'good';
      msg = `<strong>Clean.</strong> ${fmtInt(stats.kept)} patches, and only ${fmtInt(stats.junk)} of them are mostly glass or ink.
        ${pct(stats.kept, Math.floor(slide.widthUm / ts.patchUm) * Math.floor(slide.heightUm / ts.patchUm))} of the
        grid survives: everything else would have been spent training on nothing.`;
    }
    $('tmsg').className = 'msg ' + cls;
    $('tmsg').innerHTML = msg;

    // Manifest preview.
    const table = $('manifest');
    $('mcount').textContent = `${fmtInt(rows.length)} rows`;
    if (rows.length) {
      const cols = Object.keys(rows[0]);
      table.tHead.innerHTML = `<tr>${cols.map((c) => `<th scope="col">${c}</th>`).join('')}</tr>`;
      table.tBodies[0].innerHTML = rows.slice(0, 7).map((r) => `<tr>${cols.map((c) => `<td>${esc(r[c])}</td>`).join('')}</tr>`).join('') +
        (rows.length > 7 ? `<tr><td colspan="${cols.length}">… ${fmtInt(rows.length - 7)} more</td></tr>` : '');
    } else {
      table.tHead.innerHTML = '';
      table.tBodies[0].innerHTML = '<tr><td>No patches kept.</td></tr>';
    }
    const csvBytes = P.toCsv(rows).length;
    const pngBytes = rows.length * sizePx * sizePx * 3 * 0.6;
    $('store').innerHTML = `As PNG files these ${fmtInt(rows.length)} patches would be about <strong>${fmtB(pngBytes)}</strong>.
      As manifest rows they're <strong>${fmtB(csvBytes)}</strong> of CSV, ${pngBytes && csvBytes ? fmtInt(pngBytes / csvBytes) + ' times smaller' : ''},
      and the slide they point into is stored once.`;
  }

  function wireSeg(id, attr, fn) {
    $(id).addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      $(id).querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      fn(b.dataset[attr], b);
    });
  }
  wireSeg('method', 'method', (v) => { ts.method = v; ts.auto = true; $('auto').checked = true; computeTraining(); });
  wireSeg('tshow', 'show', (v) => { ts.show = v; renderTraining(); });
  wireSeg('psize', 'um', (v, b) => { ts.patchUm = +v; ts.level = +b.dataset.level; computeTraining(); });
  $('auto').addEventListener('change', (e) => { ts.auto = e.target.checked; computeTraining(); });
  $('ink').addEventListener('change', (e) => { ts.ink = e.target.checked; computeTraining(); });
  $('thr').addEventListener('input', (e) => { ts.thr = +e.target.value; computeTraining(); });
  $('minfrac').addEventListener('input', (e) => { ts.minFrac = +e.target.value / 100; computeTraining(); });
  $('csv').addEventListener('click', () => {
    const blob = new Blob([P.toCsv(result.rows)], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${SLIDE_ID}-patches.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  // ======================================================================
  // At scale
  // ======================================================================
  const sc = { mpp: 0.25 };
  const sliders = [
    ['s-n', (v) => fmtInt(v)],
    ['s-a', (v) => `${v} mm²`],
    ['s-o', (v) => `${(+v).toFixed(2).replace(/\.?0+$/, '')}×`],
    ['s-h', (v) => `${v} h`],
    ['s-y', (v) => `${v} yr`],
  ];
  function renderScale() {
    for (const [id, f] of sliders) $(id + '-o').textContent = f($(id).value);
    const o = {
      slidesPerDay: +$('s-n').value, tissueMm2: +$('s-a').value, overscan: +$('s-o').value,
      shiftHours: +$('s-h').value, years: +$('s-y').value, mpp: sc.mpp,
    };
    const r = P.scale(o);
    const gbit = (r.mbPerSec * 8) / 1000;
    $('sstats').innerHTML = [
      stat('Per slide', fmtB(r.bytesPerSlide), `${r.gigapixels.toFixed(1)} gigapixels, ${fmtInt(r.tilesPerSlide)} tiles`),
      stat('Per day', fmtB(r.bytesPerDay), `${fmtB(r.bytesPerYear)} a year`),
      stat('Sustained ingest', `${r.mbPerSec >= 100 ? fmtInt(r.mbPerSec) : r.mbPerSec.toFixed(1)} MB/s`, `${gbit.toFixed(2)} Gbit/s for ${o.shiftHours} h a day`),
      stat(`Kept ${o.years} years`, fmtB(r.bytesRetained), 'before any copies or backups'),
      stat('Training patches', `${(r.patchesPerDay / 1e6).toFixed(1)} M/day`, '256 px at 20×, tissue only'),
      stat('Those patches as PNGs', `${fmtB(r.patchPngBytesPerDay)}/day`, `vs ${fmtB(r.manifestBytesPerDay)}/day as manifest rows`),
    ].join('');
    const share = r.patchPngBytesPerDay / r.bytesPerDay;
    $('smsg').innerHTML = `Saving patches as image files would add <strong>${Math.round(share * 100)}%</strong> on top of the
      slides themselves, every day, and those copies go stale the moment the tissue detector changes. Keeping
      coordinates instead costs ${fmtB(r.manifestBytesPerDay * 365)} a year.`;
  }
  ['s-n', 's-a', 's-o', 's-h', 's-y'].forEach((id) => $(id).addEventListener('input', renderScale));
  wireSeg('s-r', 'mpp', (v) => { sc.mpp = +v; renderScale(); });
  renderScale();

  // The thumbnail takes a moment to compute; do it after the viewer's first frame.
  setTimeout(computeTraining, 60);
})();
