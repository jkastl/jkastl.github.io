/* Pyramid Scheme's engine: the pyramid's arithmetic, a tile cache, tissue detection, patch
 * selection and the at-scale estimates. No DOM; the page and the Node tests load the same file.
 * Attaches to globalThis.PS and expects shared/tissue.js (globalThis.Tissue) loaded first.
 */
(function (PS) {
  'use strict';
  const T = globalThis.Tissue;

  PS.CONFIG = {
    seed: 4021,
    tile: 256, // px per tile edge, every level
    // Rough JPEG sizes for a 256 px tile at quality ~80: glass compresses to almost nothing,
    // tissue doesn't. Real numbers vary by scanner and stain; these are in the usual range.
    bytesGlass: 2200,
    bytesTissue: 23000,
    contentCellUm: 32, // resolution of the content map used for size estimates
  };

  // ---------- the pyramid ----------

  /* Every level halves the one below until the whole slide fits in a single tile. Level 0 is
   * full resolution. (Deep Zoom halves; many scanner formats quarter instead, with fewer levels.) */
  PS.levels = function (slide) {
    const t = PS.CONFIG.tile;
    const w0 = Math.round(slide.widthUm / T.MPP0), h0 = Math.round(slide.heightUm / T.MPP0);
    const out = [];
    for (let L = 0; ; L++) {
      const d = 2 ** L;
      const w = Math.ceil(w0 / d), h = Math.ceil(h0 / d);
      const cols = Math.ceil(w / t), rows = Math.ceil(h / t);
      out.push({ level: L, downsample: d, ps: T.MPP0 * d, width: w, height: h, cols, rows, tiles: cols * rows });
      if (cols === 1 && rows === 1) break;
    }
    return out;
  };

  // Equivalent objective magnification: 40× is 0.25 µm per pixel by convention.
  PS.magnification = (psUm) => 10 / psUm;

  /* The level to read for a screen whose device pixels are screenPs µm wide: the coarsest
   * level that still has at least one image pixel per screen pixel. */
  PS.chooseLevel = function (levels, screenPs) {
    let pick = 0;
    for (const lv of levels) if (lv.ps <= screenPs * 1.0001) pick = lv.level;
    return pick;
  };

  // Column and row range of the tiles of `lv` that overlap [x0, x1) × [y0, y1) in µm, clipped to
  // the slide. Empty when c1 < c0 or r1 < r0.
  PS.tileRange = function (lv, x0, y0, x1, y1) {
    const span = PS.CONFIG.tile * lv.ps;
    return {
      c0: Math.max(0, Math.floor(x0 / span)), c1: Math.min(lv.cols - 1, Math.floor((x1 - 1e-9) / span)),
      r0: Math.max(0, Math.floor(y0 / span)), r1: Math.min(lv.rows - 1, Math.floor((y1 - 1e-9) / span)),
    };
  };

  // Tiles of `lv` that overlap the rectangle [x0, x1) × [y0, y1) in µm, nearest the centre first.
  PS.tilesInView = function (lv, x0, y0, x1, y1) {
    const span = PS.CONFIG.tile * lv.ps;
    const { c0, c1, r0, r1 } = PS.tileRange(lv, x0, y0, x1, y1);
    const cx = (x0 + x1) / 2 / span - 0.5, cy = (y0 + y1) / 2 / span - 0.5;
    const out = [];
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) out.push({ level: lv.level, col: c, row: r });
    out.sort((a, b) => Math.hypot(a.col - cx, a.row - cy) - Math.hypot(b.col - cx, b.row - cy));
    return out;
  };

  // The tile's extent in µm, clipped to the slide.
  PS.tileRect = function (slide, lv, col, row) {
    const span = PS.CONFIG.tile * lv.ps;
    const x = col * span, y = row * span;
    return { x, y, w: Math.min(span, slide.widthUm - x), h: Math.min(span, slide.heightUm - y) };
  };

  PS.tileKey = (t) => `${t.level}/${t.col}/${t.row}`;

  // ---------- size estimates ----------

  /* A coarse map of where there's anything on the glass (tissue or ink), as a summed-area
   * table so the content fraction of any rectangle is four lookups. */
  PS.contentMap = function (slide) {
    if (slide._content) return slide._content;
    const cell = PS.CONFIG.contentCellUm;
    const w = Math.ceil(slide.widthUm / cell), h = Math.ceil(slide.heightUm / cell);
    const sat = new Float64Array((w + 1) * (h + 1));
    for (let j = 0; j < h; j++) {
      let rowSum = 0;
      for (let i = 0; i < w; i++) {
        const x = (i + 0.5) * cell, y = (j + 0.5) * cell;
        const v = T.tissueAt(slide, x, y) || T.inkAt(slide, x, y) > 0.3 ? 1 : 0;
        rowSum += v;
        sat[(j + 1) * (w + 1) + i + 1] = sat[j * (w + 1) + i + 1] + rowSum;
      }
    }
    slide._content = { cell, w, h, sat };
    return slide._content;
  };

  PS.contentFrac = function (map, x0, y0, x1, y1) {
    const { cell, w, h, sat } = map;
    const i0 = Math.max(0, Math.min(w, Math.round(x0 / cell))), i1 = Math.max(0, Math.min(w, Math.round(x1 / cell)));
    const j0 = Math.max(0, Math.min(h, Math.round(y0 / cell))), j1 = Math.max(0, Math.min(h, Math.round(y1 / cell)));
    const n = (i1 - i0) * (j1 - j0);
    if (n <= 0) return 0;
    const W = w + 1;
    return (sat[j1 * W + i1] - sat[j0 * W + i1] - sat[j1 * W + i0] + sat[j0 * W + i0]) / n;
  };

  PS.tileBytes = function (slide, lv, col, row) {
    const r = PS.tileRect(slide, lv, col, row);
    const f = PS.contentFrac(PS.contentMap(slide), r.x, r.y, r.x + r.w, r.y + r.h);
    const area = (r.w * r.h) / (PS.CONFIG.tile * lv.ps) ** 2; // edge tiles are smaller
    return Math.round(area * (PS.CONFIG.bytesGlass + f * (PS.CONFIG.bytesTissue - PS.CONFIG.bytesGlass)));
  };

  // Estimated bytes per level and for the whole file.
  PS.fileSize = function (slide) {
    if (slide._size) return slide._size;
    const levels = PS.levels(slide);
    const perLevel = levels.map((lv) => {
      let b = 0;
      for (let r = 0; r < lv.rows; r++) for (let c = 0; c < lv.cols; c++) b += PS.tileBytes(slide, lv, c, r);
      return b;
    });
    slide._size = { perLevel, total: perLevel.reduce((a, b) => a + b, 0) };
    return slide._size;
  };

  // ---------- tile cache ----------

  // Least-recently-used cache: a Map keeps insertion order, so re-inserting on a hit moves a
  // key to the back and the front is always the coldest.
  PS.LRU = class {
    constructor(capacity) {
      this.capacity = capacity;
      this.map = new Map();
      this.hits = 0;
      this.misses = 0;
      this.evictions = 0;
    }
    get(key) {
      if (!this.map.has(key)) { this.misses++; return undefined; }
      const v = this.map.get(key);
      this.map.delete(key);
      this.map.set(key, v);
      this.hits++;
      return v;
    }
    peek(key) { return this.map.get(key); }
    has(key) { return this.map.has(key); }
    set(key, v) {
      if (this.map.has(key)) this.map.delete(key);
      this.map.set(key, v);
      while (this.map.size > this.capacity) {
        this.map.delete(this.map.keys().next().value);
        this.evictions++;
      }
    }
    get size() { return this.map.size; }
  };

  // ---------- tissue detection ----------

  // Otsu's method: the threshold that maximises the between-class variance of a histogram.
  PS.otsu = function (hist) {
    let total = 0, sum = 0;
    for (let i = 0; i < hist.length; i++) { total += hist[i]; sum += i * hist[i]; }
    let wB = 0, sumB = 0, best = -1, t = 0;
    for (let i = 0; i < hist.length; i++) {
      wB += hist[i];
      if (wB === 0) continue;
      const wF = total - wB;
      if (wF === 0) break;
      sumB += i * hist[i];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; t = i; }
    }
    return t;
  };

  // Marker ink is blue-green: unlike anything stained with H&E, its green and blue both beat red.
  PS.isInk = (r, g, b) => g - r > 12 && b - r > 20;

  /* Score every thumbnail pixel (brightness: darker is tissue; saturation: more colorful is
   * tissue), threshold it with Otsu or a manual value, and optionally drop ink. */
  PS.tissueMask = function (rgba, w, h, opts) {
    const method = opts.method || 'saturation';
    const score = new Uint8Array(w * h);
    const hist = new Uint32Array(256);
    for (let i = 0; i < w * h; i++) {
      const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
      let v;
      if (method === 'brightness') {
        v = 255 - Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      } else {
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        v = mx === 0 ? 0 : Math.round((255 * (mx - mn)) / mx);
      }
      score[i] = v;
      hist[v]++;
    }
    const auto = PS.otsu(hist);
    const threshold = opts.threshold == null ? auto : opts.threshold;
    const mask = new Uint8Array(w * h);
    let inkDropped = 0;
    for (let i = 0; i < w * h; i++) {
      if (score[i] <= threshold) continue;
      if (opts.removeInk && PS.isInk(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2])) { inkDropped++; continue; }
      mask[i] = 1;
    }
    return { mask, hist, auto, threshold, inkDropped };
  };

  /* Lay a grid of square patches over the slide and keep the ones whose tissue fraction (from
   * the mask, at the mask's resolution) reaches minFrac. Each patch also gets the truth from the
   * synthetic slide, so the page can show which kept patches are really glass or ink. Squares the
   * mask doesn't touch are left out, except solid tissue the mask missed entirely, which still
   * counts as dropped. */
  PS.patches = function (slide, mask, mw, mh, maskPs, patchUm, minFrac) {
    const truth = PS.truthGrid(slide, patchUm);
    const { cols, rows } = truth;
    const out = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x0 = c * patchUm, y0 = r * patchUm;
        const i0 = Math.floor(x0 / maskPs), i1 = Math.max(i0 + 1, Math.floor((x0 + patchUm) / maskPs));
        const j0 = Math.floor(y0 / maskPs), j1 = Math.max(j0 + 1, Math.floor((y0 + patchUm) / maskPs));
        let on = 0, n = 0;
        for (let j = j0; j < Math.min(j1, mh); j++) for (let i = i0; i < Math.min(i1, mw); i++) { on += mask[j * mw + i]; n++; }
        const frac = n ? on / n : 0;
        const k = r * cols + c, trueTissue = truth.tissue[k], trueInk = truth.ink[k];
        if (frac === 0 && minFrac > 0 && trueTissue < 0.8) continue;
        out.push({ col: c, row: r, x: x0, y: y0, frac, kept: frac >= minFrac && frac > 0, trueTissue, trueInk });
      }
    }
    return out;
  };

  // truth() for every square of the patch grid. It depends only on the slide and the patch size,
  // not on the mask, so it's worked out once per size and kept on the slide.
  PS.truthGrid = function (slide, patchUm) {
    const all = slide._truth || (slide._truth = {});
    if (all[patchUm]) return all[patchUm];
    const cols = Math.floor(slide.widthUm / patchUm), rows = Math.floor(slide.heightUm / patchUm);
    const tissue = new Float32Array(cols * rows), ink = new Float32Array(cols * rows);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const t = PS.truth(slide, c * patchUm, r * patchUm, patchUm);
        tissue[r * cols + c] = t.trueTissue;
        ink[r * cols + c] = t.trueInk;
      }
    }
    all[patchUm] = { cols, rows, tissue, ink };
    return all[patchUm];
  };

  // What's really in a patch: a 5×5 sample of the synthetic slide's own fields.
  PS.truth = function (slide, x, y, size) {
    let tissue = 0, ink = 0;
    for (let j = 0; j < 5; j++) {
      for (let i = 0; i < 5; i++) {
        const px = x + ((i + 0.5) / 5) * size, py = y + ((j + 0.5) / 5) * size;
        if (T.inkAt(slide, px, py) > 0.3) ink++;
        else if (T.tissueAt(slide, px, py)) tissue++;
      }
    }
    return { trueTissue: tissue / 25, trueInk: ink / 25 };
  };

  // A kept patch that's mostly glass or ink is junk; a dropped patch that's solid tissue was missed.
  // Candidates are the squares the mask touches at all.
  PS.patchStats = function (patches) {
    let candidates = 0, kept = 0, junk = 0, inkJunk = 0, missed = 0;
    for (const p of patches) {
      if (p.frac > 0) candidates++;
      if (p.kept) {
        kept++;
        if (p.trueTissue < 0.3) { junk++; if (p.trueInk >= 0.3) inkJunk++; }
      } else if (p.trueTissue >= 0.8) missed++;
    }
    return { candidates, kept, junk, inkJunk, missed };
  };

  // Manifest rows as they'd land in a table: coordinates into the pyramid, not pixels.
  PS.manifest = function (slideId, patches, patchUm, level) {
    const lvPs = T.MPP0 * 2 ** level;
    const size = Math.round(patchUm / lvPs);
    return patches.filter((p) => p.kept).map((p, i) => ({
      slide_id: slideId,
      patch_id: `${slideId}-${String(i).padStart(5, '0')}`,
      level,
      x: Math.round(p.x / T.MPP0), // level-0 pixel coordinates, the OpenSlide convention
      y: Math.round(p.y / T.MPP0),
      size_px: size,
      tissue_frac: Math.round(p.frac * 1000) / 1000,
    }));
  };

  PS.toCsv = function (rows) {
    if (!rows.length) return '';
    const cols = Object.keys(rows[0]);
    return [cols.join(','), ...rows.map((r) => cols.map((c) => r[c]).join(','))].join('\n') + '\n';
  };

  // ---------- at scale ----------

  /* Back-of-envelope numbers for a whole lab. Inputs: slides per day, tissue area per slide
   * (mm²), how much glass gets scanned around the tissue (×), scan resolution (µm/px),
   * hours per day the scanners run, and years kept. */
  PS.scale = function (o) {
    const c = PS.CONFIG;
    const tileUm = c.tile * o.mpp;
    const tilesPerMm2 = 1e6 / (tileUm * tileUm);
    const tissueTiles = o.tissueMm2 * tilesPerMm2;
    const glassTiles = o.tissueMm2 * (o.overscan - 1) * tilesPerMm2;
    const base = tissueTiles * c.bytesTissue + glassTiles * c.bytesGlass;
    const bytesPerSlide = base * (4 / 3); // the pyramid above level 0 adds about a third
    const pixels = (o.tissueMm2 * o.overscan * 1e6) / (o.mpp * o.mpp);
    const perDay = bytesPerSlide * o.slidesPerDay;
    // Training patches: 256 px at 0.5 µm/px (20×) over tissue only.
    const patchUm = 256 * 0.5;
    const patchesPerSlide = (o.tissueMm2 * 1e6) / (patchUm * patchUm);
    return {
      gigapixels: pixels / 1e9,
      bytesPerSlide,
      tilesPerSlide: (tissueTiles + glassTiles) * (4 / 3),
      bytesPerDay: perDay,
      bytesPerYear: perDay * 365,
      bytesRetained: perDay * 365 * o.years,
      mbPerSec: perDay / (o.shiftHours * 3600) / 1e6,
      patchesPerDay: patchesPerSlide * o.slidesPerDay,
      // Writing patches out as PNGs (about 120 KB each) instead of keeping coordinates.
      patchPngBytesPerDay: patchesPerSlide * o.slidesPerDay * 120e3,
      manifestBytesPerDay: patchesPerSlide * o.slidesPerDay * 48,
    };
  };

  PS.fmtBytes = function (b) {
    const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB'];
    let i = 0;
    while (Math.abs(b) >= 1000 && i < u.length - 1) { b /= 1000; i++; }
    return `${b >= 100 || i === 0 ? Math.round(b) : b.toFixed(1)} ${u[i]}`;
  };
})(globalThis.PS = globalThis.PS || {});
