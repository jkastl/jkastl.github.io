/* Off Color's engine: stain profiles, color deconvolution, Macenko stain estimation and
 * normalization, a focus check, and the streaming monitor. No DOM; the page and the Node tests
 * load the same file. Attaches to globalThis.OC; needs shared/tissue.js (globalThis.Tissue).
 */
(function (OC) {
  'use strict';
  const T = globalThis.Tissue;
  const norm3 = T.norm3;

  // ---------- stain profiles ----------

  const profile = (name, h, e, hScale, eScale, white) =>
    ({ name, h: norm3(h), e: norm3(e), hScale, eScale, white: white || [1, 1, 1] });

  /* Three scanners at three sites. Same tissue, same protocol on paper; different stain lots,
   * different staining times, different lamps. Scanner A matches the reference the model was
   * trained on. */
  OC.SCANNERS = [
    { id: 'A', site: 'Site A', profile: profile('Scanner A', T.STAIN_REF.h, T.STAIN_REF.e, 1, 1) },
    { id: 'B', site: 'Site B', profile: profile('Scanner B', [0.6, 0.71, 0.37], [0.19, 0.84, 0.5], 0.97, 0.85) },
    { id: 'C', site: 'Site C', profile: profile('Scanner C', [0.545, 0.725, 0.42], [0.18, 0.84, 0.52], 1.0, 1.2, [1, 0.99, 0.96]) },
  ];

  // Mix a profile from a base plus adjustments: hematoxylin/eosin strength, how blue the
  // hematoxylin runs (0 = as is, 1 = much bluer), and white balance warmth.
  OC.adjust = function (base, o) {
    const blue = o.hBlue || 0;
    const h = norm3([base.h[0] + 0.25 * blue, base.h[1] - 0.05 * blue, base.h[2] - 0.2 * blue].map((v) => Math.max(0.02, v)));
    const warm = o.warm || 0;
    return {
      name: o.name || base.name,
      h,
      e: base.e,
      hScale: base.hScale * (o.hStrength == null ? 1 : o.hStrength),
      eScale: base.eScale * (o.eStrength == null ? 1 : o.eStrength),
      white: [base.white[0] * (o.bright || 1), base.white[1] * (1 - 0.03 * warm) * (o.bright || 1), base.white[2] * (1 - 0.1 * warm) * (o.bright || 1)],
    };
  };

  // ---------- small linear algebra ----------

  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

  // Eigen-decomposition of a symmetric 3×3 matrix by Jacobi rotations. Returns eigenvalues
  // and column eigenvectors, sorted largest first.
  OC.eig3 = function (A) {
    const a = A.map((r) => r.slice());
    const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (let sweep = 0; sweep < 50; sweep++) {
      let off = 0;
      for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) off += a[p][q] * a[p][q];
      if (off < 1e-20) break;
      for (let p = 0; p < 3; p++) {
        for (let q = p + 1; q < 3; q++) {
          if (Math.abs(a[p][q]) < 1e-30) continue;
          const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
          const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
          const c = 1 / Math.sqrt(t * t + 1), s = t * c;
          for (let k = 0; k < 3; k++) {
            const akp = a[k][p], akq = a[k][q];
            a[k][p] = c * akp - s * akq;
            a[k][q] = s * akp + c * akq;
          }
          for (let k = 0; k < 3; k++) {
            const apk = a[p][k], aqk = a[q][k];
            a[p][k] = c * apk - s * aqk;
            a[q][k] = s * apk + c * aqk;
          }
          for (let k = 0; k < 3; k++) {
            const vkp = v[k][p], vkq = v[k][q];
            v[k][p] = c * vkp - s * vkq;
            v[k][q] = s * vkp + c * vkq;
          }
        }
      }
    }
    const idx = [0, 1, 2].sort((i, j) => a[j][j] - a[i][i]);
    return { values: idx.map((i) => a[i][i]), vectors: idx.map((i) => [v[0][i], v[1][i], v[2][i]]) };
  };

  function percentile(arr, p) {
    if (!arr.length) return 0;
    const s = Float64Array.from(arr).sort();
    const i = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
    return s[i];
  }
  OC.percentile = percentile;

  // Least-squares stain amounts for one OD triple, given two stain vectors.
  function unmix(od, h, e, out) {
    const hh = dot(h, h), ee = dot(e, e), he = dot(h, e);
    const det = hh * ee - he * he;
    const bh = dot(od, h), be = dot(od, e);
    out[0] = (ee * bh - he * be) / det;
    out[1] = (hh * be - he * bh) / det;
    return out;
  }
  OC.unmix = unmix;

  // ---------- Macenko ----------

  /* Estimate a patch's stain vectors from its pixels alone (Macenko et al., 2009):
   *  1. Take the white of the glass per channel, then convert to optical density,
   *     OD = −log10(I / I0).
   *  2. Drop near-transparent pixels (glass, lumen).
   *  3. The two stains span a plane in OD space: take the top two eigenvectors.
   *  4. Project onto the plane; the extreme angles (1st and 99th percentile) are the two
   *     purest stains. The one that absorbs more red is hematoxylin.
   *  5. Unmix every pixel and take the 99th percentile amount of each stain as its strength.
   */
  OC.macenko = function (rgba, n, opts) {
    const beta = (opts && opts.beta) || 0.15, alpha = (opts && opts.alpha) || 1;
    // The white of the glass: passed in when it was measured elsewhere on the slide, otherwise
    // the brightest pixels of the patch (which only works if the patch has some glass in it).
    let I0 = opts && opts.white;
    if (!I0) {
      I0 = [0, 0, 0];
      for (let c = 0; c < 3; c++) {
        const ch = new Float64Array(n);
        for (let i = 0; i < n; i++) ch[i] = rgba[i * 4 + c];
        I0[c] = Math.max(percentile(ch, 99.5), 1);
      }
    }
    const ods = [];
    for (let i = 0; i < n; i++) {
      const od = [0, 1, 2].map((c) => -Math.log10(Math.max(1, rgba[i * 4 + c]) / I0[c]));
      if (od[0] > beta && od[1] > beta && od[2] > beta * 0.5) ods.push(od);
    }
    if (ods.length < 30) return null;
    const m = [0, 0, 0];
    for (const o of ods) for (let c = 0; c < 3; c++) m[c] += o[c] / ods.length;
    const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const o of ods) for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) C[a][b] += (o[a] - m[a]) * (o[b] - m[b]);
    const { vectors } = OC.eig3(C);
    let [v1, v2] = vectors;
    if (v1[0] + v1[1] + v1[2] < 0) v1 = v1.map((x) => -x);
    if (v2[0] + v2[1] + v2[2] < 0) v2 = v2.map((x) => -x);
    const phi = ods.map((o) => Math.atan2(dot(o, v2), dot(o, v1)));
    const lo = percentile(phi, alpha), hi = percentile(phi, 100 - alpha);
    let a = norm3(v1.map((x, k) => x * Math.cos(lo) + v2[k] * Math.sin(lo)));
    let b = norm3(v1.map((x, k) => x * Math.cos(hi) + v2[k] * Math.sin(hi)));
    if (a[0] < 0) a = a.map((x) => -x);
    if (b[0] < 0) b = b.map((x) => -x);
    const [h, e] = a[0] > b[0] ? [a, b] : [b, a];
    const ch = [], ce = [], tmp = [0, 0];
    for (const o of ods) { unmix(o, h, e, tmp); ch.push(tmp[0]); ce.push(tmp[1]); }
    return { h, e, maxH: percentile(ch, 99), maxE: percentile(ce, 99), I0, n: ods.length };
  };

  /* Re-express a patch in the target's stains: unmix with the patch's own estimate, rescale
   * each stain's amount to the target's strength, and recombine with the target's vectors on
   * a pure-white background. */
  OC.normalize = function (rgba, n, est, target, out) {
    const res = out || new Uint8ClampedArray(n * 4);
    const kH = target.maxH / est.maxH, kE = target.maxE / est.maxE;
    const od = [0, 0, 0], c2 = [0, 0];
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 3; c++) od[c] = -Math.log10(Math.max(1, rgba[i * 4 + c]) / est.I0[c]);
      unmix(od, est.h, est.e, c2);
      const ch = Math.max(0, c2[0] * kH), ce = Math.max(0, c2[1] * kE);
      for (let c = 0; c < 3; c++) res[i * 4 + c] = 255 * Math.pow(10, -(ch * target.h[c] + ce * target.e[c]));
      res[i * 4 + 3] = 255;
    }
    return res;
  };

  // ---------- color difference ----------

  function toLab(r, g, b) {
    const lin = (u) => { u /= 255; return u <= 0.04045 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4); };
    const R = lin(r), G = lin(g), B = lin(b);
    const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
    const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
    const Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
    const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
  }
  OC.toLab = toLab;

  // Mean CIE76 ΔE between two images of the same tissue. About 2.3 is a just-noticeable difference.
  OC.deltaE = function (a, b, n) {
    let s = 0;
    for (let i = 0; i < n; i++) {
      const p = toLab(a[i * 4], a[i * 4 + 1], a[i * 4 + 2]), q = toLab(b[i * 4], b[i * 4 + 1], b[i * 4 + 2]);
      s += Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    }
    return s / n;
  };

  // ---------- focus ----------

  // Variance of the Laplacian of the grey image: sharp edges score high, blur scores low.
  OC.focus = function (rgba, w, h) {
    const g = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) g[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
    let s = 0, s2 = 0, n = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const l = g[i - 1] + g[i + 1] + g[i - w] + g[i + w] - 4 * g[i];
        s += l; s2 += l * l; n++;
      }
    }
    return s2 / n - (s / n) ** 2;
  };

  // Box blur, applied twice: a stand-in for a patch scanned out of focus.
  OC.blur = function (rgba, w, h, r) {
    let src = rgba;
    for (let pass = 0; pass < 2; pass++) {
      const dst = new Uint8ClampedArray(src.length);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const acc = [0, 0, 0];
          let n = 0;
          for (let dy = -r; dy <= r; dy++) {
            const yy = Math.min(h - 1, Math.max(0, y + dy));
            for (let dx = -r; dx <= r; dx++) {
              const xx = Math.min(w - 1, Math.max(0, x + dx));
              const o = (yy * w + xx) * 4;
              acc[0] += src[o]; acc[1] += src[o + 1]; acc[2] += src[o + 2]; n++;
            }
          }
          const o = (y * w + x) * 4;
          dst[o] = acc[0] / n; dst[o + 1] = acc[1] / n; dst[o + 2] = acc[2] / n; dst[o + 3] = 255;
        }
      }
      src = dst;
    }
    return src;
  };

  // ---------- the downstream model ----------

  /* The model the stream feeds: does this patch have atypical nuclei? Atypical nuclei stain
   * darker, so the model reads how dark the nuclei are. It's the kind of intensity feature that
   * breaks under a color shift: it unmixes with the FIXED reference stain vectors and white,
   * takes the median hematoxylin of the nuclear pixels, and compares it to a cut-off learned on
   * Scanner A. */
  OC.NUC_PIXEL = 0.3;
  OC.nucDark = function (rgba, n) {
    const od = [0, 0, 0], c2 = [0, 0];
    const hs = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 3; c++) od[c] = -Math.log10(Math.max(1, rgba[i * 4 + c]) / 255);
      unmix(od, T.STAIN_REF.h, T.STAIN_REF.e, c2);
      hs[i] = c2[0];
    }
    hs.sort();
    let k = n;
    while (k > 0 && hs[k - 1] > OC.NUC_PIXEL) k--;
    // Fewer than 20 nuclear pixels: use the darkest 20 anyway.
    const from = Math.min(k, n - 20);
    return hs[Math.floor((from + n - 1) / 2)];
  };

  // ---------- the stream ----------

  OC.CONFIG = {
    patch: 80, // px
    ps: 1, // µm per px (10×)
    perHour: 5, // slides per scanner per hour
    hours: 72,
    windowHours: 4,
    baselineWindows: 6, // the first day is the baseline
    blurRate: 0.04,
    focusMin: null, // set by calibrate()
    cusumK: 0.5,
    cusumH: 5,
  };

  /* What happens to the scanners over three days. The monitor never sees this; it only sees
   * pixels. */
  OC.INCIDENTS = [
    { scanner: 'B', at: 30, kind: 'step', label: 'New hematoxylin lot at Site B', apply: (p) => OC.adjust(p, { hStrength: 1.4, hBlue: 0.5 }) },
    { scanner: 'C', at: 44, kind: 'ramp', label: 'Scanner C lamp starts to dim', apply: (p, hrs) => OC.adjust(p, { bright: 1 - Math.min(0.3, 0.0115 * hrs), warm: Math.min(1.5, 0.05 * hrs) }) },
  ];

  OC.profileAt = function (scannerId, hour) {
    let p = OC.SCANNERS.find((s) => s.id === scannerId).profile;
    for (const inc of OC.INCIDENTS) {
      if (inc.scanner === scannerId && hour >= inc.at) p = inc.apply(p, hour - inc.at);
    }
    return p;
  };

  // Event i: which scanner, when, which slide, where on it. All from i, so it replays exactly.
  OC.eventMeta = function (i) {
    const nS = OC.SCANNERS.length;
    const sc = OC.SCANNERS[i % nS];
    const k = Math.floor(i / nS);
    const r = T.rng(T.hash(i, 77, 3));
    const hour = (k + r()) / OC.CONFIG.perHour;
    const slideSeed = T.hash(i, 5, 11) % 100000;
    const wantDense = r() < 0.5;
    return { i, scanner: sc.id, hour, slideSeed, wantDense, blurred: r() < OC.CONFIG.blurRate, r };
  };

  // Find a spot on the slide of the wanted kind (crowded or not), well inside the tissue.
  OC.pickSpot = function (slide, wantDense, r) {
    let best = null;
    for (let tries = 0; tries < 40; tries++) {
      const f = slide.fragments[Math.floor(r() * slide.fragments.length)];
      const a = r() * 2 * Math.PI, d = Math.sqrt(r()) * 0.6;
      const x = f.cx + Math.cos(a) * d * f.rx, y = f.cy + Math.sin(a) * d * f.ry;
      if (!T.tissueAt(slide, x, y)) continue;
      const tu = T.tumorAt(slide, x, y);
      best = { x, y, tumor: tu };
      if (wantDense ? tu > 0.8 : tu < 0.05) return best;
    }
    return best;
  };

  OC.renderEvent = function (meta, profile) {
    const c = OC.CONFIG;
    const slide = T.makeSlide(meta.slideSeed);
    const spot = OC.pickSpot(slide, meta.wantDense, meta.r);
    const half = (c.patch * c.ps) / 2;
    let px = T.render(slide, spot.x - half, spot.y - half, c.patch, c.patch, c.ps, profile);
    if (meta.blurred) px = OC.blur(px, c.patch, c.patch, 2);
    return { px, dense: spot.tumor > 0.5, slide, white: OC.glassWhite(slide, profile) };
  };

  /* The slide's white, measured where a pipeline would: on bare glass near the label end,
   * from the low-resolution level. Median of a small patch, per channel. */
  OC.glassWhite = function (slide, profile) {
    const g = T.render(slide, 300, 300, 8, 8, 16, profile);
    return [0, 1, 2].map((c) => {
      const ch = [];
      for (let i = 0; i < 64; i++) ch.push(g[i * 4 + c]);
      return percentile(ch, 50);
    });
  };

  // Reference target for normalization, and the model's cut-off and the focus floor, all
  // learned from Scanner A patches before the stream starts.
  OC.calibrate = function () {
    if (OC._cal) return OC._cal;
    const c = OC.CONFIG, n = c.patch * c.patch;
    const evs = [], focus = [], ests = [];
    for (let i = 0; i < 60; i++) {
      const meta = OC.eventMeta(i * 3 + 100000); // scanner A, outside the stream's range
      meta.blurred = false;
      const ev = OC.renderEvent(meta, OC.SCANNERS[0].profile);
      focus.push(OC.focus(ev.px, c.patch, c.patch));
      const e = OC.macenko(ev.px, n, { white: ev.white });
      if (!e) continue;
      evs.push({ ev, e });
      ests.push(e);
    }
    const med = (f) => percentile(ests.map(f), 50);
    // Repaint in the reference dye colors, at the strengths Scanner A's patches estimate to.
    const target = { h: T.STAIN_REF.h, e: T.STAIN_REF.e, maxH: med((e) => e.maxH), maxE: med((e) => e.maxE) };
    // Two versions of the model: one trained on raw pixels, one on normalized pixels. If you
    // normalize at ingest, you normalize the training data too.
    const raw = evs.map(({ ev }) => ({ s: OC.nucDark(ev.px, n), dense: ev.dense }));
    const run = new OC.StainState();
    const nrm = evs.map(({ ev, e }) => ({ s: OC.nucDark(OC.normalize(ev.px, n, run.update('A', e), target), n), dense: ev.dense }));
    const cr = OC.bestCut(raw), cn = OC.bestCut(nrm);
    OC._cal = { cutRaw: cr.cut, cutNorm: cn.cut, accRaw: cr.acc, accNorm: cn.acc, focusMin: percentile(focus, 5) * 0.25, target };
    return OC._cal;
  };

  /* Per-scanner running stain estimate: an exponentially weighted average of each patch's
   * Macenko estimate. Normalizing with one patch's own estimate would also erase real
   * differences between patches (darker nuclei would be scaled back down, which is the very
   * thing the model looks for). A scanner's stains change by lot and by day, not by patch, so
   * the estimate lives in keyed state, one per scanner, the way a streaming job keeps it. */
  OC.StainState = class {
    constructor(alpha) { this.alpha = alpha || 0.1; this.by = {}; }
    update(key, est) {
      const cur = this.by[key];
      if (!cur) {
        this.by[key] = { h: est.h.slice(), e: est.e.slice(), maxH: est.maxH, maxE: est.maxE, I0: est.I0.slice(), n: 1 };
        return this.by[key];
      }
      const a = this.alpha, mix = (x, y) => x + a * (y - x);
      cur.h = norm3(cur.h.map((v, k) => mix(v, est.h[k])));
      cur.e = norm3(cur.e.map((v, k) => mix(v, est.e[k])));
      cur.maxH = mix(cur.maxH, est.maxH);
      cur.maxE = mix(cur.maxE, est.maxE);
      cur.I0 = est.I0.slice(); // measured on this slide's glass, so no smoothing needed
      cur.n++;
      return cur;
    }
  };

  // The cut-off on the model's score that classifies a labelled set best.
  OC.bestCut = function (xs) {
    const cand = xs.map((x) => x.s).sort((a, b) => a - b);
    let cut = 0.5, best = -1;
    for (let k = 0; k < cand.length - 1; k++) {
      const t = (cand[k] + cand[k + 1]) / 2;
      const acc = xs.filter((x) => (x.s > t) === x.dense).length;
      if (acc > best) { best = acc; cut = t; }
    }
    return { cut, acc: best / xs.length };
  };

  // Everything the pipeline computes for one event, with and without normalization.
  OC.processEvent = function (i, stain) {
    const cal = OC.calibrate();
    const c = OC.CONFIG, n = c.patch * c.patch;
    const meta = OC.eventMeta(i);
    const prof = OC.profileAt(meta.scanner, meta.hour);
    const ev = OC.renderEvent(meta, prof);
    const focus = OC.focus(ev.px, c.patch, c.patch);
    const base = { i, scanner: meta.scanner, hour: meta.hour, slide: `${meta.scanner}${String(meta.slideSeed).padStart(5, '0')}`, dense: ev.dense, focus, px: ev.px };
    if (focus < cal.focusMin) return Object.assign(base, { quarantined: true });
    const est = OC.macenko(ev.px, n, { white: ev.white });
    if (!est) return Object.assign(base, { quarantined: true, reason: 'too little stain' });
    const rawShare = OC.nucDark(ev.px, n);
    const run = stain.update(meta.scanner, est);
    const normPx = OC.normalize(ev.px, n, run, cal.target);
    const normShare = OC.nucDark(normPx, n);
    base.normPx = normPx;
    return Object.assign(base, {
      quarantined: false,
      est,
      white: (est.I0[0] + est.I0[1] + est.I0[2]) / 3,
      hAngle: (Math.acos(Math.min(1, dot(est.h, cal.target.h))) * 180) / Math.PI,
      run: { h: run.h.slice(), maxH: run.maxH },
      predRaw: rawShare > cal.cutRaw,
      predNorm: normShare > cal.cutNorm,
    });
  };

  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

  /* The monitor: tumbling windows per scanner, a baseline from the first day, and a
   * two-sided CUSUM on each metric's window mean, standardized against the baseline. */
  OC.METRICS = [
    { key: 'maxH', label: 'Hematoxylin strength', get: (e) => e.est.maxH },
    { key: 'white', label: 'Background brightness', get: (e) => e.white },
    { key: 'hAngle', label: 'Hematoxylin hue shift', get: (e) => e.hAngle },
  ];

  OC.Monitor = class {
    constructor() {
      this.events = [];
      this.stain = new OC.StainState();
      this.quarantined = 0;
      this.windows = {}; // scanner -> [{start, end, n, medians, accRaw, accNorm, z, alerts}]
      this.state = {}; // scanner -> metric -> {base, sd, sHi, sLo, alerting}
      this.alerts = [];
      for (const s of OC.SCANNERS) { this.windows[s.id] = []; this.state[s.id] = {}; }
      this.open = {}; // scanner -> events in the current window
      this.windowIndex = {};
    }

    // Process event i and add it. Events must arrive in order: the stain state depends on it.
    process(i) {
      const ev = OC.processEvent(i, this.stain);
      this.add(ev);
      return ev;
    }

    add(ev) {
      this.events.push(ev);
      if (ev.quarantined) { this.quarantined++; return; }
      const wh = OC.CONFIG.windowHours;
      const w = Math.floor(ev.hour / wh);
      const cur = this.windowIndex[ev.scanner];
      if (cur != null && w !== cur) this.close(ev.scanner);
      this.windowIndex[ev.scanner] = w;
      (this.open[ev.scanner] = this.open[ev.scanner] || []).push(ev);
    }

    // Close every open window (end of stream, or before reading the latest state).
    flush() { for (const s of OC.SCANNERS) if (this.open[s.id] && this.open[s.id].length) this.close(s.id); }

    close(sid) {
      const evs = this.open[sid];
      this.open[sid] = [];
      if (!evs || !evs.length) return;
      const wh = OC.CONFIG.windowHours;
      const idx = this.windowIndex[sid];
      const list = this.windows[sid];
      const win = { index: idx, start: idx * wh, end: (idx + 1) * wh, n: evs.length, medians: {}, z: {}, alert: {} };
      win.accRaw = evs.filter((e) => e.predRaw === e.dense).length / evs.length;
      win.accNorm = evs.filter((e) => e.predNorm === e.dense).length / evs.length;
      for (const m of OC.METRICS) win.medians[m.key] = mean(evs.map(m.get));
      list.push(win);
      const nb = OC.CONFIG.baselineWindows;
      const st = this.state[sid];
      if (list.length === nb) {
        for (const m of OC.METRICS) {
          const xs = list.map((x) => x.medians[m.key]);
          const mu = xs.reduce((a, b) => a + b, 0) / xs.length;
          const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mu) ** 2, 0) / (xs.length - 1));
          // A floor on the spread so a very quiet baseline doesn't make every wobble an alarm.
          const floor = m.key === 'hAngle' ? 0.6 : Math.abs(mu) * 0.015;
          st[m.key] = { base: mu, sd: Math.max(sd, floor), sHi: 0, sLo: 0, alerting: false };
        }
      } else if (list.length > nb) {
        const { cusumK: k, cusumH: H } = OC.CONFIG;
        for (const m of OC.METRICS) {
          const s = st[m.key];
          const z = (win.medians[m.key] - s.base) / s.sd;
          win.z[m.key] = z;
          s.sHi = Math.max(0, s.sHi + z - k);
          s.sLo = Math.max(0, s.sLo - z - k);
          const over = s.sHi > H || s.sLo > H;
          if (over && !s.alerting) {
            s.alerting = true;
            win.alert[m.key] = true;
            this.alerts.push({ scanner: sid, metric: m.key, label: m.label, at: win.end, dir: s.sHi > H ? 'up' : 'down', z, base: s.base, value: win.medians[m.key] });
          }
        }
      }
    }
  };

  OC.totalEvents = () => OC.CONFIG.hours * OC.CONFIG.perHour * OC.SCANNERS.length;
})(globalThis.OC = globalThis.OC || {});
