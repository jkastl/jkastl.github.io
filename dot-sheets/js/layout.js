/* Dot placement, region labels and outline tracing: segmentation (from simplify.js) -> page geometry.
 *
 *   DotLayout.dots(seg, opts)     -> [{x, y, s, c}]           letters/dots, mm, sorted by y then x
 *   DotLayout.stats(dots, sizes)  -> {total, byColor, bySize, byColorSize}
 *   DotLayout.labels(seg, opts)   -> {labels: [{x, y, size, c, region}], tooSmall: [regionId]}
 *   DotLayout.outlines(seg, opts) -> {d, length}               one SVG path, mm
 *
 * Every output is in millimetres from the image's top-left corner (x right, y down); opts.mmPerPx
 * (mm per seg pixel) is required everywhere.
 *
 * All three share one distance field: for every point, the Euclidean distance to the nearest region
 * boundary (a pixel crack between two different regions, or the image border). It is computed once
 * per seg (cached) by an exact distance transform (Felzenszwalb-Huttenlocher) on a half-pixel grid,
 * where crack midpoints and pixel corners are the seeds, so it measures the distance to the real
 * boundary polygon rather than to pixel centres.
 *
 * Dots, style 'flow' (default): like Lifelines FlowArt / opus vermiculatum. Each region gets rows of
 * evenly spaced dots that follow its outline: iso-contours of the distance field at depths
 * d_k = inset + r_0, d_k + (r_k + r_k+1 + gap), ... The outermost row(s) use the smallest dot so
 * edges read crisply; inner rows of thick regions step up to bigger dots. Each closed row is spaced
 * so it divides evenly (no seam). Leftover space (collapsed cores, medial-axis seams) is filled
 * deepest-first with the biggest dot that fits; in a region's core only its top size and the one
 * below go in, so big flat areas stay tidy rows of one size. Thin stripes become a single line of
 * smallest dots along their ridge. Style 'stipple': one traced edge row, then a Poisson-disc
 * (Bridson) fill per size level, biggest first.
 *
 * dots opts: mmPerPx (required), sizes [1.6, 2.4, 3.4] (dot radii mm, 1-4 levels, any order),
 * gap 0.35, edgeInset 0.15, density 0.85 (1 = as tight as gap allows; scales the target row and
 * in-row spacing by 1/sqrt(density)), seed 1, skipPaper true, style 'flow' | 'stipple',
 * edgeRows 1 (rows of smallest dots before stepping up), coreSpread 1 (sizes below the top allowed
 * in a core fill), thinParts true (dot lines along thin parts of bigger regions).
 * Every dot keeps `gap` clear of every other dot and its disc `edgeInset` inside its region, except
 * smallest dots on tiny/thin parts, which only need 30% of their disc on their region.
 *
 * Classic script: attaches to globalThis.DotLayout, so the page, a Web Worker
 * (importScripts('color.js', 'layout.js')) and Node (require) all load the same file.
 * No DOM. Deterministic for a given seg, options and seed.
 */
(function (L) {
  'use strict';

  const DC = globalThis.DotColor || (typeof require === 'function' ? require('./color.js') : null);
  if (!DC) throw new Error('DotLayout needs color.js (DotColor) loaded first');

  const INF = 1e20;

  function num(v, d) { const n = Number(v); return v == null || !isFinite(n) ? d : n; }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function mmOf(opts, who) {
    const mm = Number(opts && opts.mmPerPx);
    if (!(mm > 0) || !isFinite(mm)) throw new Error('DotLayout.' + who + ': opts.mmPerPx is required');
    return mm;
  }

  /* ---------------------------------------------------------------- distance field */

  // 1-D squared distance transform of sampled function f (Felzenszwalb & Huttenlocher 2012).
  function dt1(f, n, d, v, z) {
    let k = 0;
    v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < n; q++) {
      const fq = f[q] + q * q;
      let p = v[k];
      let s = (fq - (f[p] + p * p)) / (2 * q - 2 * p);
      while (s <= z[k]) {
        k--; p = v[k];
        s = (fq - (f[p] + p * p)) / (2 * q - 2 * p);
      }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      const dq = q - v[k];
      d[q] = dq * dq + f[v[k]];
    }
  }

  const cache = typeof WeakMap === 'function' ? new WeakMap() : null;

  // Distance field + per-region facts. Grid node (i, j) sits at (i/2, j/2) px: odd/odd nodes are
  // pixel centres, even ones lie on pixel cracks and corners.
  function analyze(seg) {
    if (cache && cache.has(seg)) {
      const A = cache.get(seg);
      if (A.w === seg.width && A.h === seg.height && A.R === seg.region) return A;
    }
    const w = seg.width | 0, h = seg.height | 0, R = seg.region, IX = seg.index;
    if (!(w > 0 && h > 0) || !R || R.length < w * h || !IX) throw new Error('DotLayout: bad seg');
    const W = 2 * w + 1, H = 2 * h + 1;
    const g = new Float64Array(W * H).fill(INF);
    // Seeds: pixel corners where pixels of different regions meet (or the border)...
    for (let y = 0; y <= h; y++) {
      for (let x = 0; x <= w; x++) {
        let seed;
        if (x === 0 || y === 0 || x === w || y === h) seed = true;
        else {
          const a = R[(y - 1) * w + x - 1];
          seed = a !== R[(y - 1) * w + x] || a !== R[y * w + x - 1] || a !== R[y * w + x];
        }
        if (seed) g[2 * y * W + 2 * x] = 0;
      }
    }
    // ...and midpoints of vertical and horizontal cracks between different regions.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x <= w; x++) {
        if (x === 0 || x === w || R[y * w + x - 1] !== R[y * w + x]) g[(2 * y + 1) * W + 2 * x] = 0;
      }
    }
    for (let y = 0; y <= h; y++) {
      for (let x = 0; x < w; x++) {
        if (y === 0 || y === h || R[(y - 1) * w + x] !== R[y * w + x]) g[2 * y * W + 2 * x + 1] = 0;
      }
    }
    const n = Math.max(W, H);
    const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
    for (let i = 0; i < W; i++) {
      for (let j = 0; j < H; j++) f[j] = g[j * W + i];
      dt1(f, H, d, v, z);
      for (let j = 0; j < H; j++) g[j * W + i] = d[j];
    }
    const D = new Float32Array(W * H); // px
    for (let j = 0; j < H; j++) {
      const o = j * W;
      for (let i = 0; i < W; i++) f[i] = g[o + i];
      dt1(f, W, d, v, z);
      for (let i = 0; i < W; i++) D[o + i] = Math.sqrt(d[i]) / 2;
    }

    // Regions: area, palette index, centroid, pole of inaccessibility (max D at pixel centres;
    // ties go to the pixel nearest the centroid).
    let nreg = 0;
    for (let p = 0; p < w * h; p++) if (R[p] + 1 > nreg) nreg = R[p] + 1;
    const area = new Int32Array(nreg), cIdx = new Int32Array(nreg).fill(-1);
    const cx = new Float64Array(nreg), cy = new Float64Array(nreg);
    for (let y = 0, p = 0; y < h; y++) {
      for (let x = 0; x < w; x++, p++) {
        const r = R[p];
        area[r]++; cx[r] += x + 0.5; cy[r] += y + 0.5;
        if (cIdx[r] < 0) cIdx[r] = IX[p];
      }
    }
    for (let r = 0; r < nreg; r++) if (area[r]) { cx[r] /= area[r]; cy[r] /= area[r]; }
    const maxD = new Float64Array(nreg).fill(-1), poleX = new Float64Array(nreg), poleY = new Float64Array(nreg);
    const best2 = new Float64Array(nreg);
    for (let y = 0, p = 0; y < h; y++) {
      const o = (2 * y + 1) * W + 1;
      for (let x = 0; x < w; x++, p++) {
        const r = R[p], dd = D[o + 2 * x];
        if (dd < maxD[r] - 1e-6) continue;
        const ex = x + 0.5 - cx[r], ey = y + 0.5 - cy[r], e2 = ex * ex + ey * ey;
        if (dd > maxD[r] + 1e-6 || e2 < best2[r]) {
          maxD[r] = dd; poleX[r] = x + 0.5; poleY[r] = y + 0.5; best2[r] = e2;
        }
      }
    }
    const pal = seg.palette || [];
    const paper = new Uint8Array(nreg);
    for (let r = 0; r < nreg; r++) paper[r] = pal[cIdx[r]] && pal[cIdx[r]].paper ? 1 : 0;

    let pixStart = null, pixList = null;
    const A = {
      w, h, W, H, D, R, IX, nreg, area, cIdx, cx, cy, maxD, poleX, poleY, paper,
      // Pixel indices grouped by region (counting sort), built on first use.
      pixels() {
        if (!pixList) {
          pixStart = new Int32Array(nreg + 1);
          for (let p = 0; p < w * h; p++) pixStart[R[p] + 1]++;
          for (let r = 0; r < nreg; r++) pixStart[r + 1] += pixStart[r];
          const fill = pixStart.slice(0, nreg);
          pixList = new Int32Array(w * h);
          for (let p = 0; p < w * h; p++) pixList[fill[R[p]]++] = p;
        }
        return { start: pixStart, list: pixList };
      },
    };
    if (cache) cache.set(seg, A);
    return A;
  }

  // Bilinear distance (px) at a point given in px.
  function sampleD(A, x, y) {
    let gx = 2 * x, gy = 2 * y;
    const W = A.W, H = A.H;
    if (gx < 0) gx = 0; else if (gx > W - 1) gx = W - 1;
    if (gy < 0) gy = 0; else if (gy > H - 1) gy = H - 1;
    let i = gx | 0, j = gy | 0;
    if (i > W - 2) i = W - 2;
    if (j > H - 2) j = H - 2;
    const fx = gx - i, fy = gy - j, o = j * W + i, D = A.D;
    const top = D[o] + (D[o + 1] - D[o]) * fx, bot = D[o + W] + (D[o + W + 1] - D[o + W]) * fx;
    return top + (bot - top) * fy;
  }

  function regionAt(A, x, y) {
    let xi = Math.floor(x), yi = Math.floor(y);
    if (xi < 0) xi = 0; else if (xi >= A.w) xi = A.w - 1;
    if (yi < 0) yi = 0; else if (yi >= A.h) yi = A.h - 1;
    return A.R[yi * A.w + xi];
  }

  // Region pixels ordered by distance field, deepest first (ties: scan order).
  function deepestPixels(A, r, limit) {
    const { start, list } = A.pixels();
    const arr = Array.from(list.subarray(start[r], start[r + 1]));
    const W = A.W, D = A.D, w = A.w;
    const dv = p => D[(2 * ((p / w) | 0) + 1) * W + 2 * (p % w) + 1];
    arr.sort((a, b) => dv(b) - dv(a) || a - b);
    return limit && arr.length > limit ? arr.slice(0, limit) : arr;
  }

  /* ---------------------------------------------------------------- iso-contours */

  // Closed iso-contours of the distance field, per region, at several depths per region.
  // levels[r] = ascending Float64Array of depths (px) or null. Returns [{reg, k, xs, ys}] in px.
  // Contours of a positive depth never touch a boundary, so each lies inside a single region.
  function isoContours(A, levels) {
    const { w, W, H, D, R } = A;
    let K = 1;
    for (const l of levels) if (l && l.length > K) K = l.length;
    const span = 2 * W * H;
    const idOf = new Map();
    const px = [], py = [], n0 = [], n1 = [], keyOf = [];
    function node(key, x, y) {
      let id = idOf.get(key);
      if (id === undefined) {
        id = px.length; idOf.set(key, id);
        px.push(x); py.push(y); n0.push(-1); n1.push(-1); keyOf.push(key);
      }
      return id;
    }
    function link(a, b) {
      if (n0[a] < 0) n0[a] = b; else n1[a] = b;
      if (n0[b] < 0) n0[b] = a; else n1[b] = a;
    }
    for (let j = 0; j < H - 1; j++) {
      const rowR = (j >> 1) * w;
      for (let i = 0; i < W - 1; i++) {
        const reg = R[rowR + (i >> 1)], lv = levels[reg];
        if (!lv) continue;
        const o = j * W + i;
        const a = D[o], b = D[o + 1], c = D[o + W + 1], d = D[o + W];
        let mx = a > b ? a : b; if (c > mx) mx = c; if (d > mx) mx = d;
        if (mx < lv[0]) continue;
        let mn = a < b ? a : b; if (c < mn) mn = c; if (d < mn) mn = d;
        for (let k = 0; k < lv.length; k++) {
          const t = lv[k];
          if (t > mx) break;
          if (t <= mn) continue;
          const base = (reg * K + k) * span;
          const cs = (a >= t ? 8 : 0) | (b >= t ? 4 : 0) | (c >= t ? 2 : 0) | (d >= t ? 1 : 0);
          // Edge crossing points: top (a-b), right (b-c), bottom (d-c), left (a-d).
          const T = () => node(base + 2 * o, (i + (t - a) / (b - a)) / 2, j / 2);
          const Rt = () => node(base + 2 * (o + 1) + 1, (i + 1) / 2, (j + (t - b) / (c - b)) / 2);
          const B = () => node(base + 2 * (o + W), (i + (t - d) / (c - d)) / 2, (j + 1) / 2);
          const Lf = () => node(base + 2 * o + 1, i / 2, (j + (t - a) / (d - a)) / 2);
          switch (cs) {
            case 1: case 14: link(Lf(), B()); break;
            case 2: case 13: link(B(), Rt()); break;
            case 3: case 12: link(Lf(), Rt()); break;
            case 4: case 11: link(T(), Rt()); break;
            case 6: case 9: link(T(), B()); break;
            case 7: case 8: link(Lf(), T()); break;
            case 5: case 10: {
              const ctr = (a + b + c + d) / 4 >= t;
              // Inside corners b,d (5) or a,c (10); the centre decides which pair connects.
              if ((cs === 5) === ctr) { link(Lf(), T()); link(B(), Rt()); } else { link(T(), Rt()); link(Lf(), B()); }
              break;
            }
          }
        }
      }
    }
    const seen = new Uint8Array(px.length), loops = [];
    for (let s = 0; s < px.length; s++) {
      if (seen[s]) continue;
      const xs = [], ys = [];
      let cur = s, prev = -1;
      while (cur >= 0 && !seen[cur]) {
        seen[cur] = 1; xs.push(px[cur]); ys.push(py[cur]);
        const nx = n0[cur] !== prev ? n0[cur] : n1[cur];
        prev = cur; cur = nx;
      }
      const bi = Math.floor(keyOf[s] / span);
      loops.push({ reg: Math.floor(bi / K), k: bi % K, xs, ys });
    }
    return loops;
  }

  /* ---------------------------------------------------------------- dots */

  function dots(seg, opts) {
    opts = opts || {};
    const mm = mmOf(opts, 'dots');
    const sizesMM = (Array.isArray(opts.sizes) && opts.sizes.length ? opts.sizes : [1.6, 2.4, 3.4]).map(Number);
    if (sizesMM.some(r => !(r > 0))) throw new Error('DotLayout.dots: sizes must be positive radii in mm');
    const order = sizesMM.map((r, i) => i).sort((a, b) => sizesMM[a] - sizesMM[b] || a - b);
    const rad = order.map(i => sizesMM[i] / mm); // px, ascending; "lv" below indexes this
    const nl = rad.length;
    const gap = Math.max(0, num(opts.gap, 0.35)) / mm;
    const inset = Math.max(0, num(opts.edgeInset, 0.15)) / mm;
    const density = clamp(num(opts.density, 0.85), 0.2, 1);
    const fac = 1 / Math.sqrt(density); // stretch of the target centre spacing
    const skipPaper = opts.skipPaper !== false;
    const style = opts.style === 'stipple' ? 'stipple' : 'flow';
    const edgeRows = Math.max(0, Math.round(num(opts.edgeRows, 1)));
    const rand = DC.rng(num(opts.seed, 1));
    const EPS = 0.04; // px of slack against interpolation error
    // Fill sizes allowed in a region's core: its top level and this many below it.
    const coreSpread = Math.max(0, Math.round(num(opts.coreSpread, 1)));

    const A = analyze(seg);
    const { w, h, nreg, maxD, cIdx } = A;
    const skip = new Uint8Array(nreg);
    for (let r = 0; r < nreg; r++) skip[r] = (skipPaper && A.paper[r]) || A.area[r] === 0 ? 1 : 0;

    // Row schedule of a region with max depth M: the size level of each row, outermost first.
    const off0 = Math.max(inset, gap / 2) + EPS; // outer row: dot edge this far inside the boundary
    function rowSeq(top, k) {
      if (edgeRows === 0 || top === 0) return top;
      if (k < edgeRows) return 0;
      return Math.min(top, k - edgeRows + 1);
    }
    function rows(M, top, onlyEdge) {
      const out = [];
      let d = 0, prev = -1;
      for (let k = 0; k < 4096; k++) {
        const lv = rowSeq(top, k);
        d = prev < 0 ? off0 + rad[lv] : d + (rad[prev] + rad[lv] + gap) * fac + EPS;
        if (d > M) break;
        out.push({ d, lv });
        prev = lv;
        if (onlyEdge && k + 1 >= Math.max(1, edgeRows)) break;
      }
      return out;
    }
    // Biggest level for a region: its first row must sit at least one dot radius short of the core,
    // so a big level is only used where it gets a proper ring, not a lone dot.
    const maxLv = new Int8Array(nreg).fill(-1);
    const core = new Float64Array(nreg).fill(Infinity);
    const sched = new Array(nreg).fill(null);
    for (let r = 0; r < nreg; r++) {
      if (skip[r] || maxD[r] < rad[0] + inset) continue;
      let top = 0;
      for (let lv = nl - 1; lv > 0; lv--) {
        const rs = rows(Infinity, lv, false);
        let first = -1;
        for (let k = 0; k < rs.length; k++) if (rs[k].lv === lv) { first = rs[k].d; break; }
        if (first >= 0 && first + rad[lv] <= maxD[r]) { top = lv; break; }
      }
      maxLv[r] = top;
      const rs = rows(maxD[r], top, style === 'stipple');
      // Core: deeper than the inner edge of the transition rows, where only the region's own big
      // sizes go, so a big flat area reads as tidy rows of one size.
      if (top > 0) {
        for (const e of rows(Infinity, top, false)) if (e.lv === top) { core[r] = e.d - rad[top]; break; }
      }
      if (rs.length) sched[r] = rs;
    }

    // Placed dots (px) + spatial hash.
    const X = [], Y = [], Lv = [], Rg = [];
    const count = new Int32Array(nreg);
    const cs = (2 * rad[nl - 1] + gap) * fac + 1e-6;
    const gw = Math.floor(w / cs) + 1, gh = Math.floor(h / cs) + 1;
    const head = new Int32Array(gw * gh).fill(-1), next = [];
    function clearAt(x, y, lv, minSame) {
      const r = rad[lv];
      const gx = Math.floor(x / cs), gy = Math.floor(y / cs);
      for (let yy = gy - 1; yy <= gy + 1; yy++) {
        if (yy < 0 || yy >= gh) continue;
        for (let xx = gx - 1; xx <= gx + 1; xx++) {
          if (xx < 0 || xx >= gw) continue;
          for (let j = head[yy * gw + xx]; j >= 0; j = next[j]) {
            let need = r + rad[Lv[j]] + gap;
            if (Lv[j] === lv && minSame > need) need = minSame;
            const dx = X[j] - x, dy = Y[j] - y;
            if (dx * dx + dy * dy < need * need) return false;
          }
        }
      }
      return true;
    }
    function add(x, y, lv, reg) {
      const id = X.length;
      X.push(x); Y.push(y); Lv.push(lv); Rg.push(reg);
      const cell = Math.floor(y / cs) * gw + Math.floor(x / cs);
      next.push(head[cell]); head[cell] = id;
      count[reg]++;
      return id;
    }
    // Normal placement: inside a dotted region, disc (plus inset) inside it, clear of all dots.
    function tryPlace(x, y, lv, minSame) {
      if (!(x >= 0 && y >= 0 && x < w && y < h)) return false;
      const reg = regionAt(A, x, y);
      if (skip[reg] || lv > maxLv[reg]) return false;
      if (sampleD(A, x, y) < rad[lv] + inset) return false;
      if (!clearAt(x, y, lv, minSame)) return false;
      add(x, y, lv, reg);
      return true;
    }

    // 1. Tiny and thin regions (can't hold the smallest dot anywhere): smallest dots along the
    //    region's ridge, starting at its most interior point, wherever the region covers >= 30% of
    //    the dot's disc. A small blob gets a single dot in its middle (if its area is >= 30% of the
    //    disc), a thin stripe becomes a single line of dots, a hairline gets none. These are the
    //    only dots allowed to stick out of their region. Placed first so they always get room.
    const disc = Math.PI * rad[0] * rad[0], MIN_COVER = 0.3;
    const tiny = [];
    for (let r = 0; r < nreg; r++) if (!skip[r] && maxLv[r] < 0 && A.area[r] >= MIN_COVER * disc) tiny.push(r);
    tiny.sort((a, b) => maxD[a] - maxD[b] || a - b);
    for (const r of tiny) {
      // The pole is the deepest ridge pixel nearest the centroid, so thinLine starts there and
      // works outward; a stripe gets evenly spaced dots from its middle to both ends.
      thinLine(r, Infinity, MIN_COVER);
      if (count[r]) continue;
      for (const p of deepestPixels(A, r, 64)) {
        const x = p % w + 0.5, y = ((p / w) | 0) + 0.5;
        if (clearAt(x, y, 0, 0) && cover(x, y, r) >= MIN_COVER) { add(x, y, 0, r); break; }
      }
    }

    // Disc coverage: share of the smallest dot's disc at (x, y) that lies on region reg's pixels.
    function cover(x, y, reg) {
      const r = rad[0], R = A.R;
      let n = 0;
      const y0 = Math.max(0, Math.floor(y - r)), y1 = Math.min(h - 1, Math.floor(y + r));
      for (let yy = y0; yy <= y1; yy++) {
        const dy = yy + 0.5 - y, hw = r * r - dy * dy;
        if (hw < 0) continue;
        const s = Math.sqrt(hw);
        const x0 = Math.max(0, Math.ceil(x - s - 0.5)), x1 = Math.min(w - 1, Math.floor(x + s - 0.5));
        for (let xx = x0; xx <= x1; xx++) if (R[yy * w + xx] === reg) n++;
      }
      return n / disc;
    }
    // Smallest dots along the ridge (local maxima of depth) of region r where the
    // depth is below `below`, each covering >= minCover of its disc with region pixels.
    function thinLine(r, below, minCover) {
      const W = A.W, D = A.D, R = A.R;
      const dpx = (x, y) => (x < 0 || y < 0 || x >= w || y >= h || R[y * w + x] !== r) ? 0 : D[(2 * y + 1) * W + 2 * x + 1];
      const { start, list } = A.pixels();
      const cand = [];
      for (let i = start[r]; i < start[r + 1]; i++) {
        const p = list[i], x = p % w, y = (p / w) | 0, d = dpx(x, y);
        if (d >= below) continue;
        // Ridge = depth not exceeded by any of the 8 neighbours (the medial axis of a thin part;
        // excludes pixel-staircase bumps and the axes running into corners).
        let ridge = d > 0;
        for (let dy = -1; dy <= 1 && ridge; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && dpx(x + dx, y + dy) > d) { ridge = false; break; }
        if (ridge) cand.push(p);
      }
      const c2 = p => { const ex = p % w + 0.5 - A.cx[r], ey = ((p / w) | 0) + 0.5 - A.cy[r]; return ex * ex + ey * ey; };
      cand.sort((a, b) => dpx(b % w, (b / w) | 0) - dpx(a % w, (a / w) | 0) || c2(a) - c2(b) || a - b);
      const same = (2 * rad[0] + gap) * fac;
      for (const p of cand) {
        const x = p % w + 0.5, y = ((p / w) | 0) + 0.5;
        if (clearAt(x, y, 0, same) && cover(x, y, r) >= minCover) add(x, y, 0, r);
      }
    }

    // 2. Contour rows. Outer rows of every region go first (thin regions first), so all edges get
    //    their tracing row before any interior work.
    const levels = sched.map(s => (s ? Float64Array.from(s, e => e.d) : null));
    const loops = isoContours(A, levels);
    loops.forEach((lp, i) => { lp.i = i; });
    loops.sort((a, b) => a.k - b.k || maxD[a.reg] - maxD[b.reg] || a.reg - b.reg || a.i - b.i);
    for (const lp of loops) placeRow(lp, sched[lp.reg][lp.k].lv);

    function placeRow(lp, lv) {
      const xs = lp.xs, ys = lp.ys, n = xs.length;
      const sp = (2 * rad[lv] + gap) * fac + EPS;
      const cum = new Float64Array(n + 1);
      let mx = 0, my = 0;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        cum[i + 1] = cum[i] + Math.hypot(xs[j] - xs[i], ys[j] - ys[i]);
        mx += xs[i]; my += ys[i];
      }
      mx /= n; my /= n;
      const len = cum[n];
      let ext = 0;
      for (let i = 0; i < n; i++) ext = Math.max(ext, Math.hypot(xs[i] - mx, ys[i] - my));
      // A ring too small to hold two dots collapses to one dot at its middle.
      if (2 * ext < sp || len < 2 * sp) { single(); return; }
      const phase = rand();
      let cnt = Math.floor(len / sp), P = null;
      for (let tries = 0; cnt >= 2; tries++, cnt--) {
        P = positions(cnt, phase);
        if (tries >= 3) break;
        let ok = true;
        for (let m = 0; m < cnt && ok; m++) {
          const q = (m + 1) % cnt;
          if (Math.hypot(P[2 * q] - P[2 * m], P[2 * q + 1] - P[2 * m + 1]) < sp - 2 * EPS) ok = false;
        }
        if (ok) break;
      }
      if (cnt < 2) { single(); return; }
      // A dot blocked (where rows from opposite sides meet) may slide a little along its row.
      const P2 = positions(cnt * 5, 5 * phase - 2);
      for (let m = 0; m < cnt; m++) {
        if (tryPlace(P[2 * m], P[2 * m + 1], lv, 0)) continue;
        for (const o of [1, 3, 0, 4]) if (tryPlace(P2[10 * m + 2 * o], P2[10 * m + 2 * o + 1], lv, 0)) break;
      }

      // Points at arc length (m + phase) * len / cnt, m = 0..cnt-1 (phase may be any real).
      function positions(cnt, phase) {
        const out = new Float64Array(2 * cnt);
        for (let m = 0; m < cnt; m++) {
          let s = ((m + phase) * len / cnt) % len;
          if (s < 0) s += len;
          let lo = 0, hi = n - 1;
          while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid - 1; }
          const j = (lo + 1) % n, l = cum[lo + 1] - cum[lo], t = l > 0 ? (s - cum[lo]) / l : 0;
          out[2 * m] = xs[lo] + (xs[j] - xs[lo]) * t;
          out[2 * m + 1] = ys[lo] + (ys[j] - ys[lo]) * t;
        }
        return out;
      }
      function single() {
        if (tryPlace(mx, my, lv, 0)) return;
        let bi = 0, bd = -1;
        for (let i = 0; i < n; i++) { const d = sampleD(A, xs[i], ys[i]); if (d > bd) { bd = d; bi = i; } }
        tryPlace(xs[bi], ys[bi], lv, 0);
      }
    }

    // 3. Fill what the rows left.
    if (style === 'stipple') {
      // Bridson Poisson-disc growth per level, biggest first, seeded by every dot so far and by
      // each region's pole; then a sweep over all pixel centres to close leftover holes.
      for (let lv = nl - 1; lv >= 0; lv--) {
        const r = rad[lv], same = (2 * r + gap) * fac;
        for (let reg = 0; reg < nreg; reg++) if (maxLv[reg] >= lv) tryPlace(A.poleX[reg], A.poleY[reg], lv, same);
        const active = [];
        for (let i = 0; i < X.length; i++) active.push(i);
        while (active.length) {
          const ai = Math.floor(rand() * active.length), a = active[ai];
          const base = Lv[a] === lv ? same : (rad[Lv[a]] + r + gap) * fac;
          let ok = false;
          for (let t = 0; t < 16 && !ok; t++) {
            const ang = rand() * 2 * Math.PI, dist = base + rand() * 0.5 * same;
            if (tryPlace(X[a] + Math.cos(ang) * dist, Y[a] + Math.sin(ang) * dist, lv, same)) {
              active.push(X.length - 1); ok = true;
            }
          }
          if (!ok) { active[ai] = active[active.length - 1]; active.pop(); }
        }
        sweep(lv, same, true);
      }
    } else {
      for (let lv = nl - 1; lv >= 0; lv--) sweep(lv, 0, false);
    }

    // Try every pixel centre that could hold a dot of this level: deepest first (flow: fills
    // collapsed cores from the middle out), or in shuffled order with jitter (stipple).
    function sweep(lv, minSame, shuffle) {
      const need = rad[lv] + inset, W = A.W, D = A.D, R = A.R;
      const cand = [];
      for (let y = 0, p = 0; y < h; y++) {
        const o = (2 * y + 1) * W + 1;
        for (let x = 0; x < w; x++, p++) {
          const r = R[p], dd = D[o + 2 * x];
          if (dd >= need && maxLv[r] >= lv && !skip[r] && (dd < core[r] || lv >= maxLv[r] - coreSpread)) cand.push(p);
        }
      }
      if (shuffle) {
        for (let i = cand.length - 1; i > 0; i--) {
          const j = Math.floor(rand() * (i + 1)), t = cand[i]; cand[i] = cand[j]; cand[j] = t;
        }
        for (const p of cand) {
          tryPlace(p % w + 0.5 + (rand() - 0.5) * 0.6, ((p / w) | 0) + 0.5 + (rand() - 0.5) * 0.6, lv, minSame);
        }
      } else {
        // Bucket sort by depth (quarter-pixel buckets), deepest first, stable in scan order.
        const dv = p => D[(2 * ((p / w) | 0) + 1) * W + 2 * (p % w) + 1];
        let top = 0;
        for (const p of cand) top = Math.max(top, (dv(p) * 4) | 0);
        const cnt = new Int32Array(top + 2);
        for (const p of cand) cnt[top - ((dv(p) * 4) | 0) + 1]++;
        for (let i = 1; i < cnt.length; i++) cnt[i] += cnt[i - 1];
        const sorted = new Int32Array(cand.length);
        for (const p of cand) sorted[cnt[top - ((dv(p) * 4) | 0)]++] = p;
        for (const p of sorted) tryPlace(p % w + 0.5, ((p / w) | 0) + 0.5, lv, minSame);
      }
    }

    // 4. Thin parts of bigger regions (whiskers, stems, tails too narrow for a contour row): a line
    //    of smallest dots along the ridge, a bit stricter on coverage than for wholly thin regions.
    if (opts.thinParts !== false) {
      for (let r = 0; r < nreg; r++) if (!skip[r] && maxLv[r] >= 0) thinLine(r, rad[0] + inset, 0.45);
    }

    // 5. Coverage: any region that can hold the smallest dot but got none tries every pixel.
    for (let r = 0; r < nreg; r++) {
      if (skip[r] || maxLv[r] < 0 || count[r]) continue;
      for (const p of deepestPixels(A, r, 0)) {
        if (tryPlace(p % w + 0.5, ((p / w) | 0) + 0.5, 0, 0)) break;
      }
    }

    const out = new Array(X.length);
    const rnd = v => Math.round(v * mm * 1000) / 1000;
    for (let i = 0; i < X.length; i++) out[i] = { x: rnd(X[i]), y: rnd(Y[i]), s: order[Lv[i]], c: cIdx[Rg[i]] };
    out.sort((a, b) => a.y - b.y || a.x - b.x || a.s - b.s || a.c - b.c);
    return out;
  }

  // Counts for the UI ("~N dots") and the marker shopping list.
  function stats(list, sizes) {
    const nl = Array.isArray(sizes) && sizes.length ? sizes.length : 1 + list.reduce((m, d) => Math.max(m, d.s), -1);
    const bySize = new Array(Math.max(0, nl)).fill(0), byColor = {}, byColorSize = {};
    for (const d of list) {
      bySize[d.s] = (bySize[d.s] || 0) + 1;
      byColor[d.c] = (byColor[d.c] || 0) + 1;
      if (!byColorSize[d.c]) byColorSize[d.c] = new Array(bySize.length).fill(0);
      byColorSize[d.c][d.s] = (byColorSize[d.c][d.s] || 0) + 1;
    }
    return { total: list.length, byColor, bySize, byColorSize };
  }

  /* ---------------------------------------------------------------- labels */

  // A capital A-H in a bold sans is about 0.65 em wide and 0.72 em tall: half its diagonal is
  // ~0.49 em. A font size of 1.8 * R keeps the letter inside a circle of radius R with a margin.
  const FONT_PER_RADIUS = 1.8;

  function labels(seg, opts) {
    opts = opts || {};
    const mm = mmOf(opts, 'labels');
    const minFont = num(opts.minFont, 1.8), maxFont = Math.max(minFont, num(opts.maxFont, 6));
    const skipPaper = opts.skipPaper !== false;
    const minSep = num(opts.minSep, 40) / mm; // px, between labels of the same region
    const maxPer = Math.max(1, Math.round(num(opts.maxPerRegion, 3)));
    const A = analyze(seg);
    const { w, W, D, nreg, maxD } = A;
    const out = [], tooSmall = [];
    const font = dpx => dpx * mm * FONT_PER_RADIUS;
    const rnd = v => Math.round(v * mm * 100) / 100;
    for (let r = 0; r < nreg; r++) {
      if (!A.area[r] || (skipPaper && A.paper[r])) continue;
      const f0 = font(maxD[r]);
      if (f0 < minFont) { tooSmall.push(r); continue; }
      const mine = [[A.poleX[r], A.poleY[r]]];
      out.push({ x: rnd(A.poleX[r]), y: rnd(A.poleY[r]), size: Math.round(Math.min(maxFont, f0) * 100) / 100, c: A.cIdx[r], region: r });
      // Long shapes (area well beyond a disc at the pole) get extra labels along their length.
      const elong = A.area[r] / (Math.PI * maxD[r] * maxD[r]);
      if (maxPer < 2 || elong < 3) continue;
      const floorD = Math.max(minFont / (mm * FONT_PER_RADIUS), 0.5 * maxD[r]);
      const pix = deepestPixels(A, r, 0);
      while (mine.length < maxPer) {
        let found = null;
        for (const p of pix) {
          const x = p % w + 0.5, y = ((p / w) | 0) + 0.5;
          const dd = D[(2 * ((p / w) | 0) + 1) * W + 2 * (p % w) + 1];
          if (dd < floorD) break;
          if (mine.every(q => Math.hypot(q[0] - x, q[1] - y) >= minSep)) { found = [x, y, dd]; break; }
        }
        if (!found) break;
        mine.push(found);
        out.push({ x: rnd(found[0]), y: rnd(found[1]), size: Math.round(Math.min(maxFont, font(found[2])) * 100) / 100, c: A.cIdx[r], region: r });
      }
    }
    out.sort((a, b) => a.y - b.y || a.x - b.x || a.region - b.region);
    return { labels: out, tooSmall };
  }

  /* ---------------------------------------------------------------- outlines */

  // Ramer-Douglas-Peucker on an open polyline (flat [x0,y0,x1,y1,...]); keeps both ends.
  function rdp(pts, tol) {
    const n = pts.length / 2;
    if (n <= 2) return pts.slice();
    const keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1;
    const stack = [0, n - 1], t2 = tol * tol;
    while (stack.length) {
      const b = stack.pop(), a = stack.pop();
      const ax = pts[2 * a], ay = pts[2 * a + 1], dx = pts[2 * b] - ax, dy = pts[2 * b + 1] - ay;
      const l2 = dx * dx + dy * dy;
      let bi = -1, bd = t2;
      for (let i = a + 1; i < b; i++) {
        const px = pts[2 * i] - ax, py = pts[2 * i + 1] - ay;
        let d2;
        if (l2 === 0) d2 = px * px + py * py;
        else { const c = px * dy - py * dx; d2 = c * c / l2; }
        if (d2 > bd) { bd = d2; bi = i; }
      }
      if (bi >= 0) { keep[bi] = 1; stack.push(a, bi, bi, b); }
    }
    const out = [];
    for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[2 * i], pts[2 * i + 1]);
    return out;
  }

  // Light Laplacian smoothing of a polyline (flat array) to take out the pixel staircase before
  // simplifying. Ends of open chains (junctions) stay fixed.
  function relax(p, closed, passes) {
    const n = p.length / 2;
    if (n < 3) return p;
    let a = p.slice(), b = p.slice();
    for (let k = 0; k < passes; k++) {
      for (let i = 0; i < n; i++) {
        if (!closed && (i === 0 || i === n - 1)) { b[2 * i] = a[2 * i]; b[2 * i + 1] = a[2 * i + 1]; continue; }
        const ip = (i - 1 + n) % n, inx = (i + 1) % n;
        b[2 * i] = 0.25 * a[2 * ip] + 0.5 * a[2 * i] + 0.25 * a[2 * inx];
        b[2 * i + 1] = 0.25 * a[2 * ip + 1] + 0.5 * a[2 * i + 1] + 0.25 * a[2 * inx + 1];
      }
      const t = a; a = b; b = t;
    }
    return a;
  }

  // Cubic Bezier controls through every point (Catmull-Rom direction P[i+1] - P[i-1], which leans
  // toward the longer chord, with each handle a third of its own chord so short chords don't
  // overshoot). Turns sharper than ~75 degrees stay corners. Ends of open chains are fixed and
  // their tangent points along the first/last chord.
  function smoothSegs(p, closed) {
    const n = p.length / 2, segs = [];
    const tin = new Float64Array(2 * n), tout = new Float64Array(2 * n);
    const COS_CORNER = Math.cos(75 * Math.PI / 180);
    for (let i = 0; i < n; i++) {
      let ip = i - 1, inx = i + 1;
      if (closed) { ip = (i - 1 + n) % n; inx = (i + 1) % n; }
      let ax = 0, ay = 0, bx = 0, by = 0, la = 0, lb = 0;
      if (ip >= 0) { ax = p[2 * i] - p[2 * ip]; ay = p[2 * i + 1] - p[2 * ip + 1]; la = Math.hypot(ax, ay); }
      if (inx < n) { bx = p[2 * inx] - p[2 * i]; by = p[2 * inx + 1] - p[2 * i + 1]; lb = Math.hypot(bx, by); }
      let ix, iy, ox, oy;
      if (!la || !lb) {
        const tx = la ? ax / la : bx / (lb || 1), ty = la ? ay / la : by / (lb || 1);
        ix = ox = tx; iy = oy = ty;
      } else if ((ax * bx + ay * by) / (la * lb) < COS_CORNER) {
        ix = ax / la; iy = ay / la; ox = bx / lb; oy = by / lb;
      } else {
        const tx = ax + bx, ty = ay + by, l = Math.hypot(tx, ty) || 1;
        ix = ox = tx / l; iy = oy = ty / l;
      }
      tin[2 * i] = ix; tin[2 * i + 1] = iy; tout[2 * i] = ox; tout[2 * i + 1] = oy;
    }
    const m = closed ? n : n - 1;
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % n;
      const x0 = p[2 * i], y0 = p[2 * i + 1], x3 = p[2 * j], y3 = p[2 * j + 1];
      const h = Math.hypot(x3 - x0, y3 - y0) / 3;
      segs.push([x0, y0, x0 + tout[2 * i] * h, y0 + tout[2 * i + 1] * h, x3 - tin[2 * j] * h, y3 - tin[2 * j + 1] * h, x3, y3]);
    }
    return segs;
  }

  function bezLen(s) {
    let len = 0, px = s[0], py = s[1];
    for (let k = 1; k <= 8; k++) {
      const t = k / 8, u = 1 - t;
      const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
      const x = a * s[0] + b * s[2] + c * s[4] + d * s[6], y = a * s[1] + b * s[3] + c * s[5] + d * s[7];
      len += Math.hypot(x - px, y - py); px = x; py = y;
    }
    return len;
  }

  function outlines(seg, opts) {
    opts = opts || {};
    const mm = mmOf(opts, 'outlines');
    const tol = Math.max(0, num(opts.tolerance, 0.25)) / mm;
    const smooth = opts.smooth !== false;
    const w = seg.width | 0, h = seg.height | 0, R = seg.region;
    if (!(w > 0 && h > 0) || !R) throw new Error('DotLayout: bad seg');
    const VW = w + 1; // vertex (x, y) id = y * VW + x
    // Crack ids: horizontal crack under row y-1 / over row y at column x: x + y*w (y in 1..h-1);
    // vertical crack left of column x in row y: HC + y*VW + x (x in 1..w-1).
    const HC = w * (h + 1);
    const has = new Uint8Array(HC + h * VW);
    const deg = new Uint8Array(VW * (h + 1));
    for (let y = 1; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (R[(y - 1) * w + x] !== R[y * w + x]) {
          has[y * w + x] = 1; deg[y * VW + x]++; deg[y * VW + x + 1]++;
        }
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 1; x < w; x++) {
        if (R[y * w + x - 1] !== R[y * w + x]) {
          has[HC + y * VW + x] = 1; deg[y * VW + x]++; deg[(y + 1) * VW + x]++;
        }
      }
    }
    const isJ = v => {
      const x = v % VW, y = (v / VW) | 0;
      return deg[v] !== 2 || x === 0 || y === 0 || x === w || y === h;
    };
    const used = new Uint8Array(has.length);
    // The cracks at a vertex: [crackId, otherVertex].
    function around(v) {
      const x = v % VW, y = (v / VW) | 0, res = [];
      if (x < w && y > 0 && y < h && has[y * w + x]) res.push([y * w + x, v + 1]);
      if (x > 0 && y > 0 && y < h && has[y * w + x - 1]) res.push([y * w + x - 1, v - 1]);
      if (y < h && x > 0 && x < w && has[HC + y * VW + x]) res.push([HC + y * VW + x, v + VW]);
      if (y > 0 && x > 0 && x < w && has[HC + (y - 1) * VW + x]) res.push([HC + (y - 1) * VW + x, v - VW]);
      return res;
    }
    const vx = v => v % VW, vy = v => (v / VW) | 0;
    // Walk from vertex v along crack c; returns flat points: crack midpoints, then the end vertex.
    function walk(v, c, other, pts) {
      for (;;) {
        used[c] = 1;
        pts.push((vx(v) + vx(other)) / 2, (vy(v) + vy(other)) / 2);
        v = other;
        if (isJ(v)) return v;
        let nxt = null;
        for (const e of around(v)) if (!used[e[0]]) { nxt = e; break; }
        if (!nxt) return v; // closed loop back at its start
        c = nxt[0]; other = nxt[1];
      }
    }
    const chains = []; // {pts, closed}
    for (let v = 0; v < deg.length; v++) {
      if (!deg[v] || !isJ(v)) continue;
      for (const [c, o] of around(v)) {
        if (used[c]) continue;
        const pts = [vx(v), vy(v)];
        const end = walk(v, c, o, pts);
        pts.push(vx(end), vy(end));
        chains.push({ pts, closed: false });
      }
    }
    // Remaining cracks form closed loops through degree-2 vertices only (islands).
    for (let c = 0; c < has.length; c++) {
      if (!has[c] || used[c]) continue;
      let v, o;
      if (c < HC) { const y = (c / w) | 0, x = c % w; v = y * VW + x; o = v + 1; }
      else { const k = c - HC, y = (k / VW) | 0, x = k % VW; v = y * VW + x; o = v + VW; }
      const pts = [];
      walk(v, c, o, pts);
      chains.push({ pts, closed: true });
    }

    const parts = [];
    let length = 0;
    const f = v => String(Math.round(v * mm * 100) / 100);
    for (const ch of chains) {
      let p = ch.pts;
      // Crack midpoints already sit on the diagonal of a staircase; a few smoothing passes take out
      // the rest of the pixel noise and the flat runs of raster curves (fewer passes on short chains,
      // which would shrink).
      if (smooth && p.length / 2 >= 8) p = relax(p, ch.closed, Math.min(8, (p.length / 8) | 0));
      if (ch.closed) {
        // Split at the point farthest from the first, simplify both halves, rejoin.
        const n = p.length / 2;
        let far = 0, fd = -1;
        for (let i = 1; i < n; i++) { const d = Math.hypot(p[2 * i] - p[0], p[2 * i + 1] - p[1]); if (d > fd) { fd = d; far = i; } }
        const a = rdp(p.slice(0, 2 * far + 2), tol);
        const b = rdp(p.slice(2 * far).concat(p.slice(0, 2)), tol);
        p = a.concat(b.slice(2, b.length - 2));
        if (p.length < 6) p = ch.pts.length >= 6 ? ch.pts : p; // degenerate: keep the raw ring
      } else {
        p = rdp(p, tol);
      }
      const n = p.length / 2;
      let s = 'M' + f(p[0]) + ' ' + f(p[1]);
      if (smooth && n > 2) {
        for (const q of smoothSegs(p, ch.closed)) {
          s += 'C' + f(q[2]) + ' ' + f(q[3]) + ' ' + f(q[4]) + ' ' + f(q[5]) + ' ' + f(q[6]) + ' ' + f(q[7]);
          length += bezLen(q);
        }
      } else {
        for (let i = 1; i < n; i++) {
          s += 'L' + f(p[2 * i]) + ' ' + f(p[2 * i + 1]);
          length += Math.hypot(p[2 * i] - p[2 * i - 2], p[2 * i + 1] - p[2 * i - 1]);
        }
        if (ch.closed) length += Math.hypot(p[0] - p[2 * n - 2], p[1] - p[2 * n - 1]);
      }
      if (ch.closed) s += 'Z';
      parts.push(s);
    }
    return { d: parts.join(''), length: Math.round(length * mm * 100) / 100 };
  }

  Object.assign(L, { dots, stats, labels, outlines, _analyze: analyze, _sampleD: sampleD });
})(typeof globalThis.DotLayout === 'object' ? globalThis.DotLayout : (globalThis.DotLayout = {}));

if (typeof module === 'object' && module.exports) module.exports = globalThis.DotLayout;
