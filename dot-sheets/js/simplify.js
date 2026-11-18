/* Image pipeline: photo -> a few big, flat, bold color regions (a cartoon / poster), either in colors
 * picked from the image itself or in the marker colors the user owns.
 *
 *   DotSimplify.simplify({width, height, data: RGBA}, opts) -> seg
 *
 * opts: maxSide (480), colors (8, 2..16 inks, paper not counted), detail (0.5, 0 poster .. 1
 * detailed), boost (0.35, caricature punch), paper (false: every area gets a marker; true: very
 * light neutral areas stay blank paper), pool ([{id, hex}] markers the user owns, or null to pick
 * colors from the photo), choose ('best' subset of at most `colors` | 'all'), seed (1).
 * seg: {width, height, index, region, regions: [{id, index, area}], palette: [{hex, rgb, lab, area,
 * paper, poolId}] (by area, paper last), preview: RGBA}.
 *
 * Steps: area-average downscale -> Lab -> "boost" (levels, S-curve, chroma, local contrast) ->
 * iterated bilateral filter (flattens texture, keeps edges) -> k-means++ in Lab on samples weighted
 * toward busy areas and skin -> (pool mode: fit tones to the pool, pick markers, map clusters to
 * markers keeping touching shapes apart) -> label smoothing (blurred one-hot argmax, gives round
 * boundaries) -> merge regions below the minimum area -> connected regions + palette.
 *
 * Classic script: attaches to globalThis.DotSimplify, so the page, a Web Worker
 * (importScripts('color.js', 'simplify.js')) and Node (require) all load the same file.
 * Pure typed-array code, no DOM. Deterministic for a given input, options and seed.
 */
(function (S) {
  'use strict';

  const DC = globalThis.DotColor || (typeof require === 'function' ? require('./color.js') : null);
  if (!DC) throw new Error('DotSimplify needs color.js (DotColor) loaded first');

  const PAPER_HEX = '#ffffff';
  const PAPER_LAB = [100, 0, 0];

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }

  /* ---------------------------------------------------------------- downscale + Lab */

  // Area-average resample so the longer side is <= maxSide (never upscales). Transparent pixels are
  // composited onto white. Returns interleaved RGB floats 0..255.
  function downscale(img, maxSide) {
    const sw = img.width, sh = img.height, src = img.data;
    const scale = Math.min(1, maxSide / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * scale)), h = Math.max(1, Math.round(sh * scale));
    // Premultiplied-on-white RGB of the source.
    const fx = sw / w, fy = sh / h;
    // Horizontal pass: sw x sh -> w x sh.
    const tmp = new Float32Array(w * sh * 3);
    const xs0 = new Int32Array(w), xs1 = new Int32Array(w);
    const xw = []; // per output column: weights for source columns xs0..xs1-1
    for (let x = 0; x < w; x++) {
      const a = x * fx, b = (x + 1) * fx;
      const i0 = Math.floor(a), i1 = Math.min(sw, Math.ceil(b));
      xs0[x] = i0; xs1[x] = i1;
      const ws = new Float32Array(i1 - i0);
      for (let i = i0; i < i1; i++) ws[i - i0] = (Math.min(b, i + 1) - Math.max(a, i)) / fx;
      xw.push(ws);
    }
    for (let y = 0; y < sh; y++) {
      const row = y * sw;
      for (let x = 0; x < w; x++) {
        const ws = xw[x], i0 = xs0[x], i1 = xs1[x];
        let r = 0, g = 0, bb = 0;
        for (let i = i0; i < i1; i++) {
          const o = (row + i) * 4, al = src[o + 3] / 255, wt = ws[i - i0];
          const wa = 255 * (1 - al);
          r += wt * (src[o] * al + wa); g += wt * (src[o + 1] * al + wa); bb += wt * (src[o + 2] * al + wa);
        }
        const t = (y * w + x) * 3;
        tmp[t] = r; tmp[t + 1] = g; tmp[t + 2] = bb;
      }
    }
    // Vertical pass: w x sh -> w x h.
    const out = new Float32Array(w * h * 3);
    for (let y = 0; y < h; y++) {
      const a = y * fy, b = (y + 1) * fy;
      const j0 = Math.floor(a), j1 = Math.min(sh, Math.ceil(b));
      for (let j = j0; j < j1; j++) {
        const wt = (Math.min(b, j + 1) - Math.max(a, j)) / fy;
        const so = j * w * 3, dO = y * w * 3;
        for (let k = 0; k < w * 3; k++) out[dO + k] += wt * tmp[so + k];
      }
    }
    return { w, h, rgb: out };
  }

  function rgbToLabArray(rgb, n) {
    const lab = new Float32Array(n * 3);
    for (let p = 0, o = 0; p < n; p++, o += 3) {
      const c = DC.rgbToLab(rgb[o], rgb[o + 1], rgb[o + 2]);
      lab[o] = c[0]; lab[o + 1] = c[1]; lab[o + 2] = c[2];
    }
    return lab;
  }

  /* ---------------------------------------------------------------- blurs */

  // Box blur of one plane (in place), radius r, clipped window (edge-renormalized). tmp: scratch.
  function boxBlur(plane, w, h, r, tmp) {
    if (r <= 0) return;
    for (let y = 0; y < h; y++) {
      const o = y * w;
      let s = 0;
      const e0 = Math.min(w - 1, r);
      for (let x = 0; x <= e0; x++) s += plane[o + x];
      for (let x = 0; x < w; x++) {
        const lo = Math.max(0, x - r), hi = Math.min(w - 1, x + r);
        tmp[o + x] = s / (hi - lo + 1);
        if (x + r + 1 < w) s += plane[o + x + r + 1];
        if (x - r >= 0) s -= plane[o + x - r];
      }
    }
    for (let x = 0; x < w; x++) {
      let s = 0;
      const e0 = Math.min(h - 1, r);
      for (let y = 0; y <= e0; y++) s += tmp[y * w + x];
      for (let y = 0; y < h; y++) {
        const lo = Math.max(0, y - r), hi = Math.min(h - 1, y + r);
        plane[y * w + x] = s / (hi - lo + 1);
        if (y + r + 1 < h) s += tmp[(y + r + 1) * w + x];
        if (y - r >= 0) s -= tmp[(y - r) * w + x];
      }
    }
  }

  /* ---------------------------------------------------------------- boost */

  function boostLab(lab, w, h, boost) {
    const n = w * h;
    // Auto-levels on L (1st..99th percentile), partly, so flat/dim photos get a full tonal range.
    const hist = new Int32Array(201);
    for (let p = 0; p < n; p++) hist[clamp(Math.round(lab[p * 3] * 2), 0, 200)]++;
    let acc = 0, lo = 0, hi = 200;
    for (let i = 0; i <= 200; i++) { acc += hist[i]; if (acc >= n * 0.01) { lo = i; break; } }
    acc = 0;
    for (let i = 200; i >= 0; i--) { acc += hist[i]; if (acc >= n * 0.01) { hi = i; break; } }
    lo /= 2; hi /= 2;
    let gain = hi - lo > 1 ? 100 / (hi - lo) : 1;
    gain = Math.min(gain, 1.8);
    const mid = (lo + hi) / 2;
    // Only stretch a real tonal range: a flat or near-solid picture keeps its lightness.
    const levels = (0.4 + 0.6 * boost) * clamp((hi - lo - 10) / 30, 0, 1);
    const sk = 0.9 * boost;                 // S-curve strength
    // Chroma scale; dull photos (low 90th-percentile chroma) get pushed further.
    const ch = new Int32Array(161);
    for (let p = 0; p < n; p++) ch[Math.min(160, Math.round(Math.hypot(lab[p * 3 + 1], lab[p * 3 + 2])))]++;
    let c90 = 160;
    acc = 0;
    for (let i = 0; i <= 160; i++) { acc += ch[i]; if (acc >= n * 0.9) { c90 = Math.max(1, i); break; } }
    const cs = (1 + 0.6 * boost) * Math.pow(clamp(40 / c90, 1, 2), boost);
    const L = new Float32Array(n);
    for (let p = 0; p < n; p++) {
      const o = p * 3;
      let l = lab[o];
      const st = clamp(50 + (l - mid) * gain, 0, 100);
      l = l + levels * (st - l);
      const t = l / 100, sm = t * t * (3 - 2 * t);
      l = 100 * (t + sk * (sm - t));
      L[p] = l;
      let a = lab[o + 1] * cs, b = lab[o + 2] * cs;
      const C = Math.hypot(a, b);
      if (C > 115) { a *= 115 / C; b *= 115 / C; }
      lab[o + 1] = a; lab[o + 2] = b;
    }
    // Local contrast: unsharp mask on L with a large radius.
    if (boost > 0) {
      const bl = Float32Array.from(L), tmp = new Float32Array(n);
      const r = Math.max(2, Math.round(Math.max(w, h) / 40));
      boxBlur(bl, w, h, r, tmp); boxBlur(bl, w, h, r, tmp);
      const amt = 0.8 * boost;
      for (let p = 0; p < n; p++) L[p] = L[p] + amt * (L[p] - bl[p]);
    }
    for (let p = 0; p < n; p++) lab[p * 3] = clamp(L[p], 0, 100);
  }

  /* ---------------------------------------------------------------- bilateral */

  // One iteration of a bilateral filter in Lab (interleaved). Circular window of radius r.
  function bilateral(src, dst, w, h, r, sigmaR) {
    const offs = [], sw = [];
    const ss = Math.max(1, r / 1.5);
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const d2 = dx * dx + dy * dy;
      if (d2 > r * r + r) continue;
      offs.push(dx, dy); sw.push(Math.exp(-d2 / (2 * ss * ss)));
    }
    const nt = sw.length;
    const LUTN = 1024, maxD2 = 9 * sigmaR * sigmaR, lscale = (LUTN - 1) / maxD2;
    const lut = new Float32Array(LUTN);
    for (let i = 0; i < LUTN; i++) lut[i] = Math.exp(-(i / lscale) / (2 * sigmaR * sigmaR));
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 3;
        const L0 = src[o], a0 = src[o + 1], b0 = src[o + 2];
        let sL = 0, sa = 0, sb = 0, sW = 0;
        const inner = x >= r && x < w - r && y >= r && y < h - r;
        for (let t = 0; t < nt; t++) {
          let xx = x + offs[2 * t], yy = y + offs[2 * t + 1];
          if (!inner) {
            if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue;
          }
          const q = (yy * w + xx) * 3;
          const dL = src[q] - L0, da = src[q + 1] - a0, db = src[q + 2] - b0;
          const d2 = dL * dL + da * da + db * db;
          if (d2 >= maxD2) continue;
          const wt = sw[t] * lut[(d2 * lscale) | 0];
          sL += wt * src[q]; sa += wt * src[q + 1]; sb += wt * src[q + 2]; sW += wt;
        }
        dst[o] = sL / sW; dst[o + 1] = sa / sW; dst[o + 2] = sb / sW;
      }
    }
  }

  /* ---------------------------------------------------------------- k-means */

  // Sample pixel indices with probability proportional to `weight` (systematic sampling, seeded).
  function sampleIndices(weight, n, count, rand) {
    if (n <= count) { const a = new Int32Array(n); for (let i = 0; i < n; i++) a[i] = i; return a; }
    let tot = 0;
    for (let p = 0; p < n; p++) tot += weight[p];
    const a = new Int32Array(count), step = tot / count;
    let next = rand() * step, acc = 0, k = 0;
    for (let p = 0; p < n && k < count; p++) {
      acc += weight[p];
      while (acc > next && k < count) { a[k++] = p; next += step; }
    }
    while (k < count) a[k++] = n - 1;
    return a;
  }

  // Where the picture is busy (faces, eyes, text) rather than flat (sky, walls): blurred gradient
  // magnitude, plus a bonus for skin tones. Sampling by it spends the palette on the subject
  // instead of on big backgrounds.
  function busyWeight(lab, w, h) {
    const n = w * h, g = new Float32Array(n), tmp = new Float32Array(n);
    let sum = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = y * w + x, o = p * 3;
      const ox = (x < w - 1 ? p + 1 : p) * 3, oy = (y < h - 1 ? p + w : p) * 3;
      const v = Math.hypot(lab[ox] - lab[o], lab[ox + 1] - lab[o + 1], lab[ox + 2] - lab[o + 2])
        + Math.hypot(lab[oy] - lab[o], lab[oy + 1] - lab[o + 1], lab[oy + 2] - lab[o + 2]);
      g[p] = v; sum += v;
    }
    const r = Math.max(2, Math.round(Math.max(w, h) / 30));
    boxBlur(g, w, h, r, tmp); boxBlur(g, w, h, r, tmp);
    const mean = sum / n || 1;
    for (let p = 0; p < n; p++) {
      // Skin tones get extra weight so faces keep a light and a shadow tone instead of being
      // swallowed by a background or clothing color.
      const o = p * 3, L = lab[o], a = lab[o + 1], b = lab[o + 2];
      const C = Math.hypot(a, b), hue = Math.atan2(b, a) * 57.29578;
      let skin = 0;
      if (L > 30 && L < 92 && C > 8 && C < 60 && hue > 15 && hue < 85) {
        skin = Math.min(1, (hue - 15) / 15, (85 - hue) / 15, (C - 8) / 8, (L - 30) / 15);
      }
      g[p] = (0.3 + Math.min(3, g[p] / mean)) * (1 + 1.5 * skin);
    }
    return g;
  }

  // k-means++ on samples (Float64Array m*3). Returns {centers: Float64Array(k*3), k}.
  function kmeans(samp, m, k, rand) {
    k = Math.max(1, Math.min(k, m));
    const centers = new Float64Array(k * 3);
    const d = new Float64Array(m).fill(Infinity);
    let first = Math.floor(rand() * m);
    centers[0] = samp[first * 3]; centers[1] = samp[first * 3 + 1]; centers[2] = samp[first * 3 + 2];
    let kk = 1;
    for (; kk < k; kk++) {
      let tot = 0;
      const cL = centers[(kk - 1) * 3], ca = centers[(kk - 1) * 3 + 1], cb = centers[(kk - 1) * 3 + 2];
      for (let i = 0; i < m; i++) {
        const dL = samp[i * 3] - cL, da = samp[i * 3 + 1] - ca, db = samp[i * 3 + 2] - cb;
        const v = dL * dL + da * da + db * db;
        if (v < d[i]) d[i] = v;
        tot += d[i];
      }
      if (tot <= 1e-9) break; // fewer distinct colors than k
      let r = rand() * tot, pick = m - 1;
      for (let i = 0; i < m; i++) { r -= d[i]; if (r <= 0) { pick = i; break; } }
      centers[kk * 3] = samp[pick * 3]; centers[kk * 3 + 1] = samp[pick * 3 + 1]; centers[kk * 3 + 2] = samp[pick * 3 + 2];
    }
    k = kk;
    const asg = new Int32Array(m), sum = new Float64Array(k * 3), cnt = new Float64Array(k);
    for (let it = 0; it < 24; it++) {
      let moved = 0;
      sum.fill(0); cnt.fill(0);
      for (let i = 0; i < m; i++) {
        const L = samp[i * 3], a = samp[i * 3 + 1], b = samp[i * 3 + 2];
        let best = 0, bd = Infinity;
        for (let c = 0; c < k; c++) {
          const dL = L - centers[c * 3], da = a - centers[c * 3 + 1], db = b - centers[c * 3 + 2];
          const v = dL * dL + da * da + db * db;
          if (v < bd) { bd = v; best = c; }
        }
        if (asg[i] !== best) moved++;
        asg[i] = best; cnt[best]++;
        sum[best * 3] += L; sum[best * 3 + 1] += a; sum[best * 3 + 2] += b;
      }
      for (let c = 0; c < k; c++) if (cnt[c] > 0) {
        centers[c * 3] = sum[c * 3] / cnt[c]; centers[c * 3 + 1] = sum[c * 3 + 1] / cnt[c]; centers[c * 3 + 2] = sum[c * 3 + 2] / cnt[c];
      }
      if (it > 0 && moved <= m * 0.001) break;
    }
    // Drop empty clusters.
    const keep = [];
    for (let c = 0; c < k; c++) if (cnt[c] > 0) keep.push(centers[c * 3], centers[c * 3 + 1], centers[c * 3 + 2]);
    return { centers: Float64Array.from(keep), k: keep.length / 3 };
  }

  function assignNearest(lab, n, centers, k) {
    const idx = new Uint8Array(n);
    for (let p = 0; p < n; p++) {
      const L = lab[p * 3], a = lab[p * 3 + 1], b = lab[p * 3 + 2];
      let best = 0, bd = Infinity;
      for (let c = 0; c < k; c++) {
        const dL = L - centers[c * 3], da = a - centers[c * 3 + 1], db = b - centers[c * 3 + 2];
        const v = dL * dL + da * da + db * db;
        if (v < bd) { bd = v; best = c; }
      }
      idx[p] = best;
    }
    return idx;
  }

  /* ---------------------------------------------------------------- marker distance (pool mode) */

  // Squared distance from an image color p (already fitted to the pool, see fitToPool) to a marker
  // color q. Lightness carries the picture's structure, so it counts fully; hue counts in
  // proportion to how colorful p is (a pale blue sky goes to the blue/teal marker, not pink),
  // raw chroma differences count little, and losing chroma (a vivid thing drawn dull) a bit extra.
  function markerDist2(L1, a1, b1, L2, a2, b2) {
    const C1 = Math.sqrt(a1 * a1 + b1 * b1), C2 = Math.sqrt(a2 * a2 + b2 * b2);
    const dL = L1 - L2, dC = C1 - C2, da = a1 - a2, db = b1 - b2;
    let dH2 = da * da + db * db - dC * dC; if (dH2 < 0) dH2 = 0;
    const loss = dC > 0 ? dC : 0;
    // The hue of a near-grey is noise: only trust it once the color has some chroma.
    const wH = 1.2 * clamp((C1 - 3) / 15, 0, 1);
    return dL * dL + 0.3 * dC * dC + wH * dH2 + 0.3 * loss * loss;
  }

  // A photo's tones rarely line up with a marker set (e.g. 8 mid-light, saturated markers and no
  // black or white). Before matching, stretch the image's lightness range onto the pool's and lift
  // its chroma toward the pool's, so light things go to the lightest markers, dark things to the
  // darkest, and a pale blue sky reads as blue. Returns f(L, a, b, out) writing into out[0..2].
  function fitToPool(samp, m, labs) {
    const Ls = [], Cs = [];
    for (let i = 0; i < m; i++) { Ls.push(samp[i * 3]); Cs.push(Math.hypot(samp[i * 3 + 1], samp[i * 3 + 2])); }
    Ls.sort((x, y) => x - y); Cs.sort((x, y) => x - y);
    const q = (arr, t) => arr[Math.min(arr.length - 1, Math.floor(t * arr.length))];
    const iL0 = q(Ls, 0.03), iL1 = q(Ls, 0.97), iC = Math.max(1, q(Cs, 0.9));
    const pL = labs.map(l => l[0]).sort((x, y) => x - y), pC = labs.map(l => Math.hypot(l[1], l[2])).sort((x, y) => x - y);
    const pL0 = pL[0], pL1 = pL[pL.length - 1], pCm = pC[Math.floor(pC.length / 2)];
    const span = iL1 - iL0 > 5 ? iL1 - iL0 : 0;
    const kC = clamp(0.8 * pCm / iC, 1, 2.2);
    return function (L, a, b, out) {
      const t = span ? clamp((L - iL0) / span, 0, 1) : 0.5;
      out[0] = L + 0.75 * (pL0 + t * (pL1 - pL0) - L);
      out[1] = a * kC; out[2] = b * kC;
      return out;
    };
  }

  /* ---------------------------------------------------------------- label cleanup */

  // Boundary smoothing: blur each class's one-hot mask and take the argmax. Thin bits narrower than
  // ~r vanish and boundaries become smooth curves. Ties keep the current label.
  function smoothLabels(idx, w, h, K, r, passes) {
    const n = w * h;
    if (r <= 0 || n < 4) return;
    const plane = new Float32Array(n), tmp = new Float32Array(n), bestV = new Float32Array(n);
    const out = new Uint8Array(n);
    const present = new Uint8Array(K);
    for (let pass = 0; pass < passes; pass++) {
      present.fill(0);
      for (let p = 0; p < n; p++) present[idx[p]] = 1;
      bestV.fill(-1);
      for (let c = 0; c < K; c++) {
        if (!present[c]) continue;
        for (let p = 0; p < n; p++) plane[p] = idx[p] === c ? 1 : 0;
        boxBlur(plane, w, h, r, tmp); boxBlur(plane, w, h, r, tmp);
        for (let p = 0; p < n; p++) {
          const v = idx[p] === c ? plane[p] + 1e-3 : plane[p];
          if (v > bestV[p]) { bestV[p] = v; out[p] = c; }
        }
      }
      idx.set(out);
    }
  }

  // 4-connected components of the index map. Fills `region`; returns {count, area, rIdx}.
  function components(idx, w, h, region) {
    const n = w * h;
    region.fill(-1);
    const stack = new Int32Array(n);
    const areaA = [], idxA = [];
    let count = 0;
    for (let s = 0; s < n; s++) {
      if (region[s] !== -1) continue;
      const c = idx[s];
      let sp = 0, area = 0;
      stack[sp++] = s; region[s] = count;
      while (sp > 0) {
        const p = stack[--sp]; area++;
        const x = p % w;
        if (x > 0 && region[p - 1] === -1 && idx[p - 1] === c) { region[p - 1] = count; stack[sp++] = p - 1; }
        if (x < w - 1 && region[p + 1] === -1 && idx[p + 1] === c) { region[p + 1] = count; stack[sp++] = p + 1; }
        if (p >= w && region[p - w] === -1 && idx[p - w] === c) { region[p - w] = count; stack[sp++] = p - w; }
        if (p + w < n && region[p + w] === -1 && idx[p + w] === c) { region[p + w] = count; stack[sp++] = p + w; }
      }
      areaA.push(area); idxA.push(c);
      count++;
    }
    return { count, area: Int32Array.from(areaA), rIdx: Int32Array.from(idxA) };
  }

  // Merge every region smaller than minArea into the neighbor it shares the longest boundary with
  // (tie: nearest color), smallest first, until none is left (or it has no neighbor). Regions up to
  // maxArea are merged too when their color is close to that neighbor's.
  function mergeSmall(idx, w, h, labs, minArea, maxArea, region) {
    const n = w * h;
    for (let pass = 0; pass < 60; pass++) {
      const cc = components(idx, w, h, region);
      const R = cc.count, area = cc.area, rIdx = cc.rIdx;
      if (R <= 1) return cc;
      const small = new Uint8Array(R);
      let ns = 0;
      for (let r = 0; r < R; r++) if (area[r] < maxArea) { small[r] = 1; ns++; }
      if (!ns) return cc;
      // Boundary lengths between each small region and its neighbors.
      const bmap = new Map();
      const add = (a, b) => { const key = a * R + b; bmap.set(key, (bmap.get(key) || 0) + 1); };
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const p = y * w + x, ra = region[p];
          if (x < w - 1) { const rb = region[p + 1]; if (rb !== ra) { if (small[ra]) add(ra, rb); if (small[rb]) add(rb, ra); } }
          if (y < h - 1) { const rb = region[p + w]; if (rb !== ra) { if (small[ra]) add(ra, rb); if (small[rb]) add(rb, ra); } }
        }
      }
      const nbStart = new Int32Array(R + 1);
      for (const key of bmap.keys()) nbStart[Math.floor(key / R) + 1]++;
      for (let r = 0; r < R; r++) nbStart[r + 1] += nbStart[r];
      const fill = nbStart.slice(0, R), nb = new Int32Array(bmap.size), nbLen = new Int32Array(bmap.size);
      for (const [key, len] of bmap) { const a = Math.floor(key / R); nb[fill[a]] = key - a * R; nbLen[fill[a]++] = len; }
      const order = [];
      for (let r = 0; r < R; r++) if (small[r]) order.push(r);
      order.sort((a, b) => area[a] - area[b] || a - b);
      const parent = new Int32Array(R);
      for (let r = 0; r < R; r++) parent[r] = r;
      const find = (r) => { while (parent[r] !== r) { parent[r] = parent[parent[r]]; r = parent[r]; } return r; };
      const rootArea = Int32Array.from(area);
      let merged = 0;
      const candR = [], candL = [];
      for (const s of order) {
        const rs = find(s);
        if (rootArea[rs] >= maxArea) continue;
        candR.length = 0; candL.length = 0;
        for (let e = nbStart[s]; e < nbStart[s + 1]; e++) {
          const rn = find(nb[e]);
          if (rn === rs) continue;
          const j = candR.indexOf(rn);
          if (j < 0) { candR.push(rn); candL.push(nbLen[e]); } else candL[j] += nbLen[e];
        }
        if (!candR.length) continue;
        const cs = labs[rIdx[rs]];
        let best = -1, bl = -1, bd = Infinity;
        for (let j = 0; j < candR.length; j++) {
          const rn = candR[j], cn = labs[rIdx[rn]];
          const dd = rIdx[rn] === rIdx[rs] ? -1 : DC.deltaE76(cs, cn);
          if (candL[j] > bl || (candL[j] === bl && (dd < bd || (dd === bd && rn < best)))) { best = rn; bl = candL[j]; bd = dd; }
        }
        // Low-contrast specks go up to maxArea; a region that stands out from its surroundings
        // (an eye in a face) survives down to minArea.
        if (rootArea[rs] >= minArea) {
          const t = clamp((45 - bd) / 35, 0, 1);
          if (rootArea[rs] >= minArea * (1 + (maxArea / minArea - 1) * t)) continue;
        }
        parent[rs] = best; rootArea[best] += rootArea[rs]; merged++;
      }
      if (!merged) return cc;
      for (let p = 0; p < n; p++) idx[p] = rIdx[find(region[p])];
    }
    return components(idx, w, h, region);
  }

  /* ---------------------------------------------------------------- pool selection */

  // Pick at most `maxInks` pool colors (plus paper, free) that best represent the samples.
  // cand: [{lab, paper}], samples Float64Array m*3. Returns array of candidate indices.
  function choosePool(cand, samp, m, maxInks, mode) {
    const P = cand.length;
    const D = new Float32Array(P * m);
    for (let c = 0; c < P; c++) {
      const [L2, a2, b2] = cand[c].lab;
      for (let i = 0; i < m; i++) D[c * m + i] = markerDist2(samp[i * 3], samp[i * 3 + 1], samp[i * 3 + 2], L2, a2, b2);
    }
    const all = [];
    for (let c = 0; c < P; c++) all.push(c);
    if (mode === 'all') return all;
    const minCover = Math.max(1, Math.round(m * 0.003));
    const cost = (sel) => {
      let tot = 0;
      for (let i = 0; i < m; i++) { let b = Infinity; for (const c of sel) { const v = D[c * m + i]; if (v < b) b = v; } tot += b; }
      return tot;
    };
    // Every selected color must be nearest for at least minCover samples.
    const covers = (sel) => {
      const cnt = new Int32Array(P);
      for (let i = 0; i < m; i++) {
        let b = Infinity, bc = -1;
        for (const c of sel) { const v = D[c * m + i]; if (v < b) { b = v; bc = c; } }
        cnt[bc]++;
      }
      for (const c of sel) if (!cand[c].paper && cnt[c] < minCover) return false;
      return true;
    };
    const sel = [];
    for (let c = 0; c < P; c++) if (cand[c].paper) sel.push(c);
    const inks = () => sel.filter(c => !cand[c].paper).length;
    const best = new Float64Array(m).fill(Infinity);
    const addTo = (c) => { for (let i = 0; i < m; i++) { const v = D[c * m + i]; if (v < best[i]) best[i] = v; } };
    const addCost = (c) => { let t = 0; for (let i = 0; i < m; i++) { const v = D[c * m + i]; t += v < best[i] ? v : best[i]; } return t; };
    for (const c of sel) addTo(c);
    let cur = sel.length ? cost(sel) : Infinity;
    // Greedy forward selection.
    while (inks() < maxInks) {
      let bestC = -1, bestCost = cur;
      for (let c = 0; c < P; c++) {
        if (sel.includes(c)) continue;
        const v = addCost(c);
        if (v < bestCost - 1e-9 && covers(sel.concat([c]))) { bestCost = v; bestC = c; }
      }
      if (bestC < 0) break;
      sel.push(bestC); addTo(bestC); cur = bestCost;
    }
    // Swap refinement, using best / second-best per sample so each trial swap is O(samples).
    const b1 = new Float64Array(m), b2 = new Float64Array(m), o1 = new Int32Array(m);
    for (let round = 0; round < 4; round++) {
      let improved = false;
      for (let si = 0; si < sel.length; si++) {
        if (cand[sel[si]].paper) continue;
        for (let i = 0; i < m; i++) {
          let v1 = Infinity, v2 = Infinity, w1 = -1;
          for (let k = 0; k < sel.length; k++) {
            const v = D[sel[k] * m + i];
            if (v < v1) { v2 = v1; v1 = v; w1 = k; } else if (v < v2) v2 = v;
          }
          b1[i] = v1; b2[i] = v2; o1[i] = w1;
        }
        for (let c = 0; c < P; c++) {
          if (sel.includes(c) || cand[c].paper) continue;
          let v = 0;
          for (let i = 0; i < m; i++) {
            const rest = o1[i] === si ? b2[i] : b1[i], d = D[c * m + i];
            v += d < rest ? d : rest;
          }
          if (v < cur - 1e-6) {
            const t = sel.slice(); t[si] = c;
            if (covers(t)) { sel[si] = c; cur = v; improved = true; break; }
          }
        }
      }
      if (!improved) break;
    }
    // Spares: fill up to maxInks with the next most useful colors even if they would cover little
    // on their own; the contrast-aware mapping may use them to keep neighbors apart.
    best.fill(Infinity);
    for (const c of sel) addTo(c);
    while (inks() < maxInks) {
      let bestC = -1, bestCost = Infinity;
      for (let c = 0; c < P; c++) {
        if (sel.includes(c) || cand[c].paper) continue;
        const v = addCost(c);
        if (v < bestCost) { bestCost = v; bestC = c; }
      }
      if (bestC < 0) break;
      sel.push(bestC); addTo(bestC);
    }
    if (!sel.length) sel.push(0);
    return sel.sort((a, b) => a - b);
  }

  // Map k clusters onto markers: each cluster prefers its nearest marker (markerDist2 on its fitted
  // center, weighted by area), but two clusters that touch in the picture and differ clearly in
  // the photo pay a penalty, proportional to their shared boundary, for getting the same marker.
  // So a white cup on an orange table does not become an orange cup on an orange table.
  // Solved by iterated conditional modes from the nearest-marker start. Returns cluster -> marker.
  function mapClusters(idx, w, h, centers, k, fitted, mlabs) {
    const M = mlabs.length, n = w * h;
    const cnt = new Float64Array(k), adj = new Float64Array(k * k);
    for (let p = 0; p < n; p++) {
      const c = idx[p]; cnt[c]++;
      if ((p % w) < w - 1) { const d = idx[p + 1]; if (d !== c) { adj[c * k + d]++; adj[d * k + c]++; } }
      if (p + w < n) { const d = idx[p + w]; if (d !== c) { adj[c * k + d]++; adj[d * k + c]++; } }
    }
    const U = new Float64Array(k * M);
    for (let c = 0; c < k; c++) for (let j = 0; j < M; j++) {
      const f = fitted[c], q = mlabs[j];
      U[c * M + j] = cnt[c] * markerDist2(f[0], f[1], f[2], q[0], q[1], q[2]);
    }
    const lenScale = Math.max(w, h) / 10;
    const Pn = new Float64Array(k * k);
    for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) {
      if (i === j || !adj[i * k + j]) continue;
      const dE = Math.hypot(centers[i * 3] - centers[j * 3], centers[i * 3 + 1] - centers[j * 3 + 1], centers[i * 3 + 2] - centers[j * 3 + 2]);
      const ex = dE - 18;
      if (ex > 0) Pn[i * k + j] = adj[i * k + j] * ex * ex * lenScale;
    }
    const map = new Uint8Array(k);
    for (let c = 0; c < k; c++) {
      let b = 0;
      for (let j = 1; j < M; j++) if (U[c * M + j] < U[c * M + b]) b = j;
      map[c] = b;
    }
    const order = [];
    for (let c = 0; c < k; c++) order.push(c);
    order.sort((a, b) => cnt[b] - cnt[a] || a - b);
    for (let round = 0; round < 12; round++) {
      let changed = false;
      for (const c of order) {
        let bj = map[c], bv = Infinity;
        for (let j = 0; j < M; j++) {
          let v = U[c * M + j];
          for (let o = 0; o < k; o++) if (map[o] === j && o !== c) v += Pn[c * k + o];
          if (v < bv - 1e-9) { bv = v; bj = j; }
        }
        if (bj !== map[c]) { map[c] = bj; changed = true; }
      }
      if (!changed) break;
    }
    return map;
  }

  /* ---------------------------------------------------------------- main */

  // Smallest region (in working-resolution pixels) that survives at this detail level: ~0.25% of
  // the image at detail 0 down to ~0.015% at detail 1. Only regions that contrast strongly with
  // their surroundings get this small; low-contrast ones must be up to 4x larger.
  function minRegionArea(w, h, detail) {
    return Math.max(1, Math.round(w * h * 0.0025 * Math.pow(0.06, clamp(detail, 0, 1))));
  }

  function simplify(img, opts) {
    opts = opts || {};
    const maxSide = Math.max(1, Math.round(opts.maxSide || 480));
    const colors = clamp(Math.round(opts.colors == null ? 8 : +opts.colors) || 8, 2, 16);
    const detail = clamp(opts.detail == null ? 0.5 : +opts.detail, 0, 1);
    const boost = clamp(opts.boost == null ? 0.35 : +opts.boost, 0, 1);
    const paper = opts.paper == null ? false : !!opts.paper;
    const pool = Array.isArray(opts.pool) && opts.pool.length ? opts.pool : null;
    const choose = opts.choose === 'all' ? 'all' : 'best';
    const seed = opts.seed == null ? 1 : opts.seed;
    const rand = DC.rng(seed);

    const ds = downscale(img, maxSide);
    const w = ds.w, h = ds.h, n = w * h;
    let lab = rgbToLabArray(ds.rgb, n);

    // 1. Caricature punch.
    boostLab(lab, w, h, boost);

    // 2. Edge-preserving flattening. Scale with the working size so detail means the same at any size.
    const side = Math.max(w, h);
    const sizeK = side / 480;
    const br = Math.max(1, Math.round(lerp(3.5, 2, detail) * sizeK));
    const iters = Math.round(lerp(5, 2, detail));
    const sigmaR = lerp(13, 8, detail);
    if (n > 4) {
      let tmp = new Float32Array(n * 3);
      for (let it = 0; it < iters; it++) { bilateral(lab, tmp, w, h, br, sigmaR); const t = lab; lab = tmp; tmp = t; }
    }

    // 3. Quantize.
    const weight = busyWeight(lab, w, h);
    const samples = sampleIndices(weight, n, 6000, rand);
    const m = samples.length;
    const samp = new Float64Array(m * 3);
    for (let i = 0; i < m; i++) { const o = samples[i] * 3; samp[i * 3] = lab[o]; samp[i * 3 + 1] = lab[o + 1]; samp[i * 3 + 2] = lab[o + 2]; }

    let idx, labs, isPaper, poolIds, poolHex = null;
    const isPaperLab = (L, a, b) => L > 88 && Math.hypot(a, b) < 12;
    if (!pool) {
      let km = kmeans(samp, m, colors + (paper ? 1 : 0), rand);
      let pap = [];
      if (paper) {
        for (let c = 0; c < km.k; c++) if (isPaperLab(km.centers[c * 3], km.centers[c * 3 + 1], km.centers[c * 3 + 2])) pap.push(c);
        if (!pap.length && km.k > colors) km = kmeans(samp, m, colors, rand);
      }
      idx = assignNearest(lab, n, km.centers, km.k);
      // Collapse paper clusters into one entry.
      const remap = new Uint8Array(km.k);
      labs = []; isPaper = []; poolIds = [];
      let paperSlot = -1;
      for (let c = 0; c < km.k; c++) {
        if (pap.includes(c)) {
          if (paperSlot < 0) { paperSlot = labs.length; labs.push(PAPER_LAB.slice()); isPaper.push(true); poolIds.push(null); }
          remap[c] = paperSlot;
        } else {
          remap[c] = labs.length;
          labs.push([km.centers[c * 3], km.centers[c * 3 + 1], km.centers[c * 3 + 2]]);
          isPaper.push(false); poolIds.push(null);
        }
      }
      for (let p = 0; p < n; p++) idx[p] = remap[idx[p]];
    } else {
      const cand = [];
      if (paper) cand.push({ lab: PAPER_LAB.slice(), paper: true, id: null, hex: PAPER_HEX });
      for (const pc of pool.slice(0, paper ? 255 : 256)) {
        const hex = DC.rgbToHex(DC.hexToRgb(pc.hex));
        cand.push({ lab: DC.hexToLab(hex), paper: false, id: pc.id == null ? null : pc.id, hex });
      }
      const fit = fitToPool(samp, m, cand.map(c => c.lab)), tl = [0, 0, 0];
      const fsamp = new Float64Array(m * 3);
      for (let i = 0; i < m; i++) {
        fit(samp[i * 3], samp[i * 3 + 1], samp[i * 3 + 2], tl);
        fsamp[i * 3] = tl[0]; fsamp[i * 3 + 1] = tl[1]; fsamp[i * 3 + 2] = tl[2];
      }
      const selIdx = choosePool(cand, fsamp, m, colors, choose);
      const sel = selIdx.map(i => cand[i]);
      // Cluster first (about 2x colors), then map cluster centers to the chosen markers.
      const km = kmeans(samp, m, clamp(colors * 2, 6, 24), rand);
      idx = assignNearest(lab, n, km.centers, km.k);
      const fc = [];
      for (let c = 0; c < km.k; c++) fc.push(fit(km.centers[c * 3], km.centers[c * 3 + 1], km.centers[c * 3 + 2], [0, 0, 0]));
      const remap = mapClusters(idx, w, h, km.centers, km.k, fc, sel.map(c => c.lab));
      for (let p = 0; p < n; p++) idx[p] = remap[idx[p]];
      labs = sel.map(c => c.lab); isPaper = sel.map(c => c.paper); poolIds = sel.map(c => c.id);
      poolHex = sel.map(c => c.hex);
    }
    const K = labs.length;

    // 4. Clean up: round boundaries, absorb small regions, round again, absorb again.
    const minArea = minRegionArea(w, h, detail), maxArea = minArea * 4;
    const sr = Math.max(1, Math.round(lerp(3, 1, detail) * sizeK));
    const region = new Int32Array(n);
    smoothLabels(idx, w, h, K, sr, 2);
    mergeSmall(idx, w, h, labs, minArea, maxArea, region);
    smoothLabels(idx, w, h, K, Math.max(1, Math.round(sr / 2)), 1);
    mergeSmall(idx, w, h, labs, minArea, maxArea, region);

    // 5. Palette: used colors only, by area, paper last. Free mode: mean Lab of each color's pixels.
    // Weighted by the sampling weight, like k-means saw it, so a face's tone is not diluted by the
    // stretch of background that ended up with the same color.
    const area = new Float64Array(K), sW = new Float64Array(K), sL = new Float64Array(K), sa = new Float64Array(K), sb = new Float64Array(K);
    for (let p = 0; p < n; p++) {
      const c = idx[p], wt = weight[p]; area[c]++; sW[c] += wt;
      sL[c] += wt * lab[p * 3]; sa[c] += wt * lab[p * 3 + 1]; sb[c] += wt * lab[p * 3 + 2];
    }
    const used = [];
    for (let c = 0; c < K; c++) if (area[c] > 0) used.push(c);
    used.sort((a, b) => (isPaper[a] - isPaper[b]) || (area[b] - area[a]) || (a - b));
    const newOf = new Uint8Array(K);
    const palette = used.map((c, i) => {
      newOf[c] = i;
      let hex;
      if (isPaper[c]) hex = PAPER_HEX;
      else if (pool) hex = poolHex[c];
      else hex = DC.labToHex([sL[c] / sW[c], sa[c] / sW[c], sb[c] / sW[c]]);
      const rgb = DC.hexToRgb(hex);
      return { hex, rgb, lab: DC.rgbToLab(rgb[0], rgb[1], rgb[2]), area: area[c], paper: !!isPaper[c], poolId: pool && !isPaper[c] ? poolIds[c] : null };
    });
    for (let p = 0; p < n; p++) idx[p] = newOf[idx[p]];
    // Two free-mode clusters can round to the same hex; that is fine (they stay distinct entries).
    const cc = components(idx, w, h, region);
    const regions = new Array(cc.count);
    for (let r = 0; r < cc.count; r++) regions[r] = { id: r, index: cc.rIdx[r], area: cc.area[r] };
    const preview = new Uint8ClampedArray(n * 4);
    for (let p = 0; p < n; p++) {
      const rgb = palette[idx[p]].rgb, o = p * 4;
      preview[o] = rgb[0]; preview[o + 1] = rgb[1]; preview[o + 2] = rgb[2]; preview[o + 3] = 255;
    }
    return { width: w, height: h, index: idx, region, regions, palette, preview };
  }

  Object.assign(S, { simplify, minRegionArea, markerDist2 });
})(typeof globalThis.DotSimplify === 'object' ? globalThis.DotSimplify : (globalThis.DotSimplify = {}));

if (typeof module === 'object' && module.exports) module.exports = globalThis.DotSimplify;
