/* A procedural tissue section: a whole microscope slide that exists only as a function.
 *
 * Nothing is stored. Any point on the slide, at any resolution, is computed on demand from a
 * seed, so a 6-gigapixel scan costs no memory and any tile at any zoom level comes out the same
 * every time. The look is H&E-ish: hematoxylin (purple, nuclei) and eosin (pink, everything
 * else) are computed as stain amounts, then turned into color with the Beer-Lambert law, the
 * same physics a brightfield scanner sees. That's what lets Stain Drift change the stains and
 * then try to undo the change.
 *
 * Coordinates are micrometres (µm) from the slide's top-left corner. `ps` is the pixel size in
 * µm: 0.25 is a 40× scan, 64 is a thumbnail. Classic script: attaches to globalThis.Tissue so
 * the pages work from file:// and Node can require() the same file for tests.
 */
(function (T) {
  'use strict';

  // ---------- hashing and noise ----------

  function hash(x, y, s) {
    let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 1442695041)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return h >>> 0;
  }
  const U = 1 / 4294967296;
  const rnd = (x, y, s) => hash(x, y, s) * U;

  // Value noise with smoothstep fade, in [0, 1].
  function vnoise(x, y, s) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = rnd(xi, yi, s), b = rnd(xi + 1, yi, s), c = rnd(xi, yi + 1, s), d = rnd(xi + 1, yi + 1, s);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }

  function fbm(x, y, s, octaves) {
    let sum = 0, amp = 0.5, norm = 0, f = 1;
    for (let i = 0; i < octaves; i++) {
      sum += amp * vnoise(x * f, y * f, s + i * 101);
      norm += amp;
      amp *= 0.5;
      f *= 2.03;
    }
    return sum / norm;
  }

  // Mulberry32, for laying out the slide from its seed.
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const smooth = (a, b, v) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };

  // ---------- stains ----------

  const norm3 = (v) => { const m = Math.hypot(v[0], v[1], v[2]); return [v[0] / m, v[1] / m, v[2] / m]; };

  // Optical density per unit of stain, per RGB channel. These are the reference vectors
  // commonly used as the Macenko normalization target.
  T.STAIN_REF = Object.freeze({
    name: 'Reference',
    h: norm3([0.5626, 0.7201, 0.4062]),
    e: norm3([0.2159, 0.8012, 0.5581]),
    hScale: 1,
    eScale: 1,
    white: [1, 1, 1], // scanner white balance gain per channel
  });
  // Blue-green marker ink absorbs mostly red.
  const INK = norm3([0.86, 0.42, 0.29]);
  T.INK = INK;
  T.norm3 = norm3;

  // ---------- the slide ----------

  T.MPP0 = 0.25; // µm per pixel at full resolution (a "40×" scan)

  T.makeSlide = function (seed) {
    const r = rng(seed);
    const W = 24000, H = 16000; // 24 × 16 mm of glass that gets scanned
    // Two or three pieces of tissue, each a wobbly ellipse.
    const n = 2 + (r() < 0.5 ? 1 : 0);
    const fragments = [];
    for (let i = 0; i < n; i++) {
      fragments.push({
        cx: W * (0.2 + 0.6 * (i + 0.5) / n) + (r() - 0.5) * 1500,
        cy: H * (0.5 + (r() - 0.5) * 0.25),
        rx: 2600 + r() * 1700,
        ry: 2000 + r() * 1800,
        rot: (r() - 0.5) * 1.2,
      });
    }
    // A pathologist's pen circle around part of the first fragment.
    const f0 = fragments[0];
    const pen = {
      cx: f0.cx + (r() - 0.5) * 1200,
      cy: f0.cy + (r() - 0.5) * 900,
      R: Math.min(f0.rx, f0.ry) * 1.15,
      a0: -0.4 + r() * 0.6,
      span: 3.6 + r() * 1.0, // radians of arc drawn
      width: 110,
    };
    return { seed: seed >>> 0, widthUm: W, heightUm: H, fragments, pen };
  };

  // The tissue mask: > 0 inside tissue. Ellipse distance plus low-frequency wobble.
  function tissueField(sl, x, y) {
    let best = -9;
    for (const f of sl.fragments) {
      const dx = x - f.cx, dy = y - f.cy;
      const c = Math.cos(f.rot), s = Math.sin(f.rot);
      const u = (dx * c + dy * s) / f.rx, v = (-dx * s + dy * c) / f.ry;
      const d = 1 - Math.sqrt(u * u + v * v);
      if (d > best) best = d;
    }
    if (best < -0.6) return best;
    return best + 0.55 * (fbm(x / 1400, y / 1400, sl.seed + 11, 4) - 0.5);
  }

  function inkField(sl, x, y) {
    const p = sl.pen;
    const dx = x - p.cx, dy = y - p.cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const off = Math.abs(dist - p.R);
    if (off > p.width * 2) return 0;
    let a = Math.atan2(dy, dx) - p.a0;
    a = ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    if (a > p.span) return 0;
    const taper = smooth(0, 0.25, a) * smooth(0, 0.25, p.span - a);
    const wob = p.width * (0.75 + 0.5 * vnoise(a * 9, 0.5, sl.seed + 23));
    return taper * (1 - smooth(wob * 0.7, wob, off));
  }

  // Where the tumor-like, crowded areas are: in [0, 1].
  function tumorField(sl, x, y) {
    return smooth(0.56, 0.68, fbm(x / 2300, y / 2300, sl.seed + 7, 3));
  }

  const GLAND = 800; // µm grid for glands
  const NUC = 9; // µm grid for nuclei

  // Where a point sits relative to its gland: under 0.6 is lumen, 0.6 to 1.05 is the epithelial
  // ring, Infinity means no gland here. One gland per 800 µm grid cell, at most.
  function glandRR(sl, x, y, tumor) {
    const seed = sl.seed;
    const gx = Math.floor(x / GLAND), gy = Math.floor(y / GLAND);
    if (rnd(gx, gy, seed + 51) >= 0.8 - 0.45 * tumor) return Infinity;
    const R = (120 + 140 * rnd(gx, gy, seed + 53)) * (1 - 0.4 * tumor);
    const cx = (gx + 0.35 + 0.3 * rnd(gx, gy, seed + 57)) * GLAND;
    const cy = (gy + 0.35 + 0.3 * rnd(gx, gy, seed + 59)) * GLAND;
    const ga = 0.85 + 0.33 * rnd(gx, gy, seed + 61);
    const dx = (x - cx) * ga, dy = (y - cy) / ga;
    return Math.sqrt(dx * dx + dy * dy) / R + 0.12 * (vnoise(x / 30, y / 30, seed + 63) - 0.5);
  }

  /* One nucleus per 9 µm grid cell, or none. Whether it exists and how big it is are decided at
   * its own centre, so a region boundary never slices a nucleus in half. Cached, since every
   * pixel near a cell asks about it. */
  const nucCache = new Map();
  let nucSeed = -1;
  function nucCell(sl, i, j) {
    if (sl.seed !== nucSeed || nucCache.size > 50000) { nucCache.clear(); nucSeed = sl.seed; }
    const key = i * 8192 + j;
    let n = nucCache.get(key);
    if (n !== undefined) return n;
    const seed = sl.seed;
    const x = (i + 0.5 + 0.6 * (rnd(i, j, seed + 73) - 0.5)) * NUC;
    const y = (j + 0.5 + 0.6 * (rnd(i, j, seed + 79) - 0.5)) * NUC;
    const tumor = tumorField(sl, x, y);
    let p = 0.07 + 0.5 * tumor, r = 2.3 + 1.2 * tumor;
    const rr = glandRR(sl, x, y, tumor);
    if (rr < 0.6) p *= smooth(0.5, 0.6, rr);
    else if (rr < 1.05) { p = 0.12 + 0.78 * smooth(0.74, 0.86, rr); r = 2.6 + 0.8 * tumor; }
    n = rnd(i, j, seed + 71) < p
      ? { x, y, rad: r * (0.75 + 0.5 * rnd(i, j, seed + 83)), el: 0.75 + 0.5 * rnd(i, j, seed + 89), dark: 0.62 + 0.22 * tumor }
      : null;
    nucCache.set(key, n);
    return n;
  }

  // Scratch object reused for every sample so rendering doesn't allocate per pixel.
  const out = { h: 0, e: 0, k: 0, tissue: 0, tumor: 0 };

  /* Stain amounts at one point, as seen by a pixel of size ps µm. Below about 1 µm per pixel
   * individual nuclei are drawn; above about 2 µm they're replaced by their expected
   * coverage, so zooming out averages the detail instead of aliasing it. */
  function sample(sl, x, y, ps) {
    return sampleWith(sl, x, y, ps, tissueField(sl, x, y), tumorField(sl, x, y), vnoise(x / 2600, y / 2600, sl.seed + 31));
  }

  // The same, with the three slow fields passed in. render() interpolates those from a coarse
  // grid instead of evaluating them per pixel, which is most of the cost.
  function sampleWith(sl, x, y, ps, tf, tumor, thN) {
    const seed = sl.seed;
    const edge = Math.max(0.004, ps / 2500);
    const tissue = smooth(-edge, edge, tf);
    const ink = inkField(sl, x, y);
    out.k = ink * 1.1;
    out.tissue = tissue;
    if (tissue <= 0) {
      out.h = 0; out.e = 0; out.tumor = 0;
      return out;
    }
    out.tumor = tumor;

    // Stroma: eosin with a fibrous grain whose direction drifts slowly.
    const th = 6.3 * thN;
    const c = Math.cos(th), s = Math.sin(th);
    const u = x * c + y * s, v = -x * s + y * c;
    const fiber = vnoise(u / 38 + 2 * vnoise(x / 60, y / 60, seed + 43), v / 5, seed + 37);
    let e = 0.2 + 0.13 * fiber + 0.1 * vnoise(x / 220, y / 220, seed + 41) + 0.06 * tumor;
    let h = 0.04 + 0.03 * tumor;
    let nucP = 0.07 + 0.5 * tumor; // chance a 9 µm cell holds a nucleus
    let nucR = 2.3 + 1.2 * tumor;

    // Glands: a pale lumen ringed by epithelium. Fewer and smaller where it's crowded.
    const rr = glandRR(sl, x, y, tumor);
    if (rr < 0.6) {
      const lum = 1 - smooth(0.5, 0.6, rr);
      e *= 1 - 0.9 * lum;
      h *= 1 - 0.8 * lum;
      nucP *= 1 - lum;
    } else if (rr < 1.05) {
      e = 0.36 + 0.06 * fiber; // cytoplasm reads pinker than stroma
      nucP = 0.12 + 0.78 * smooth(0.74, 0.86, rr); // nuclei line up along the outer edge
      nucR = 2.6 + 0.8 * tumor;
    }

    // Nuclei: blend between drawn nuclei and their expected coverage.
    const w = clamp01((ps - 0.9) / 1.3);
    let hn = 0;
    if (w < 1) {
      // A nucleus can spill at most half a cell into a neighbour, so only the cell holding the
      // point and the three nearest to it can cover it.
      const fx = x / NUC, fy = y / NUC;
      const nx = Math.floor(fx), ny = Math.floor(fy);
      const ox = fx - nx < 0.5 ? -1 : 1, oy = fy - ny < 0.5 ? -1 : 1;
      for (let jj = 0; jj < 2; jj++) {
        const j = ny + jj * oy;
        for (let ii = 0; ii < 2; ii++) {
          const i = nx + ii * ox;
          const n = nucCell(sl, i, j);
          if (!n) continue;
          const ddx = (x - n.x) * n.el, ddy = (y - n.y) / n.el;
          const d = Math.sqrt(ddx * ddx + ddy * ddy) / n.rad;
          if (d < 1.15) {
            const chrom = 0.75 + 0.5 * vnoise(x / 0.9, y / 0.9, seed + 97);
            const core = 1 - smooth(0.85, 1.15, d);
            const v = core * n.dark * chrom;
            if (v > hn) hn = v;
          }
        }
      }
    }
    const cover = nucP * Math.PI * nucR * nucR / (NUC * NUC);
    const hExp = Math.min(1, cover) * (0.62 + 0.22 * tumor) * 0.9;
    h += (1 - w) * hn + w * hExp;
    e *= 1 - 0.5 * ((1 - w) * Math.min(1, hn / 0.6) + w * Math.min(1, cover));

    out.h = h * tissue;
    out.e = e * tissue;
    return out;
  }
  T.sample = sample;
  T.tissueAt = (sl, x, y) => clamp01(tissueField(sl, x, y) > 0 ? 1 : 0);
  T.inkAt = inkField;
  T.tumorAt = (sl, x, y) => (tissueField(sl, x, y) > 0 ? tumorField(sl, x, y) : 0);

  // Stain amounts to 8-bit RGB through Beer-Lambert: I = I0 · 10^(−OD).
  function toRgb(h, e, k, stain, px) {
    const hs = h * stain.hScale, es = e * stain.eScale;
    for (let c = 0; c < 3; c++) {
      const od = 0.025 + hs * stain.h[c] + es * stain.e[c] + k * INK[c];
      px[c] = Math.min(255, 255 * stain.white[c] * Math.exp(-od * Math.LN10));
    }
    return px;
  }
  T.toRgb = toRgb;

  /* Render a w×h image whose top-left pixel is centred at (x0 + ps/2, y0 + ps/2) µm. Returns
   * RGBA bytes ready for ImageData. `stain` defaults to the reference. A tiny per-pixel grain
   * stands in for sensor noise, seeded by position so it's identical on every render. */
  T.render = function (sl, x0, y0, w, h, ps, stain, buf) {
    stain = stain || T.STAIN_REF;
    const data = buf || new Uint8ClampedArray(w * h * 4);
    const px = [0, 0, 0];
    // Slow fields on a grid no coarser than 8 µm, bilinearly interpolated per pixel.
    const G = Math.max(1, Math.min(16, Math.floor(8 / ps)));
    const gw = Math.ceil(w / G) + 1, gh = Math.ceil(h / G) + 1;
    const gTf = new Float32Array(gw * gh), gTu = new Float32Array(gw * gh), gTh = new Float32Array(gw * gh);
    for (let b = 0; b < gh; b++) {
      for (let a = 0; a < gw; a++) {
        const x = x0 + (a * G + 0.5) * ps, y = y0 + (b * G + 0.5) * ps;
        const k = b * gw + a;
        gTf[k] = tissueField(sl, x, y);
        gTu[k] = gTf[k] > -0.05 ? tumorField(sl, x, y) : 0;
        gTh[k] = vnoise(x / 2600, y / 2600, sl.seed + 31);
      }
    }
    const lerp = (g, a, b, fa, fb) => {
      const k = b * gw + a;
      const top = g[k] + (g[k + 1] - g[k]) * fa;
      const bot = g[k + gw] + (g[k + gw + 1] - g[k + gw]) * fa;
      return top + (bot - top) * fb;
    };
    for (let j = 0; j < h; j++) {
      const y = y0 + (j + 0.5) * ps;
      const b = Math.floor(j / G), fb = (j - b * G) / G;
      for (let i = 0; i < w; i++) {
        const x = x0 + (i + 0.5) * ps;
        const a = Math.floor(i / G), fa = (i - a * G) / G;
        const s = G === 1
          ? sample(sl, x, y, ps)
          : sampleWith(sl, x, y, ps, lerp(gTf, a, b, fa, fb), lerp(gTu, a, b, fa, fb), lerp(gTh, a, b, fa, fb));
        toRgb(s.h, s.e, s.k, stain, px);
        const g = (rnd(Math.floor(x / ps), Math.floor(y / ps), 991) - 0.5) * 4;
        const o = (j * w + i) * 4;
        data[o] = px[0] + g;
        data[o + 1] = px[1] + g;
        data[o + 2] = px[2] + g;
        data[o + 3] = 255;
      }
    }
    return data;
  };

  T.rng = rng;
  T.hash = hash;
  T.fbm = fbm;
  T.smooth = smooth;
})(globalThis.Tissue = globalThis.Tissue || {});
