/* Color math shared by every Dot Sheets module: sRGB <-> CIELAB (D65), hex strings and ΔE.
 *
 * Classic script: attaches to globalThis.DotColor, so the page, a Web Worker (importScripts) and
 * Node tests (require) all load the same file.
 */
(function (C) {
  'use strict';

  function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : Math.round(v); }

  function hexToRgb(hex) {
    let h = String(hex).trim().replace(/^#/, '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new Error('Bad hex color: ' + hex);
    const n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function rgbToHex(rgb) {
    return '#' + rgb.map(v => clamp255(v).toString(16).padStart(2, '0')).join('');
  }

  // sRGB 0..255 -> linear 0..1, via a 256-entry table (this runs per pixel).
  const LIN = new Float64Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  function toGamma(c) {
    const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    return v * 255;
  }

  const XN = 0.95047, YN = 1.0, ZN = 1.08883;
  const E = 216 / 24389, K = 24389 / 27;
  function f(t) { return t > E ? Math.cbrt(t) : (K * t + 16) / 116; }
  function finv(t) { const t3 = t * t * t; return t3 > E ? t3 : (116 * t - 16) / K; }

  // r, g, b are 0..255 integers (fractions are rounded). Returns [L, a, b].
  function rgbToLab(r, g, b) {
    const R = LIN[clamp255(r)], G = LIN[clamp255(g)], B = LIN[clamp255(b)];
    const x = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / XN;
    const y = (0.2126729 * R + 0.7151522 * G + 0.0721750 * B) / YN;
    const z = (0.0193339 * R + 0.1191920 * G + 0.9503041 * B) / ZN;
    const fx = f(x), fy = f(y), fz = f(z);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  }

  // Returns [r, g, b] as 0..255 integers, clipped to gamut.
  function labToRgb(L, a, b) {
    const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
    const x = finv(fx) * XN, y = (L > K * E ? fy * fy * fy : L / K) * YN, z = finv(fz) * ZN;
    const R = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
    const G = -0.9692660 * x + 1.8760108 * y + 0.0415560 * z;
    const B = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;
    return [clamp255(toGamma(R)), clamp255(toGamma(G)), clamp255(toGamma(B))];
  }

  function hexToLab(hex) { const [r, g, b] = hexToRgb(hex); return rgbToLab(r, g, b); }
  function labToHex(lab) { return rgbToHex(labToRgb(lab[0], lab[1], lab[2])); }

  // CIE76: plain Euclidean distance in Lab. ~2.3 is a just-noticeable difference.
  function deltaE76(p, q) {
    const dL = p[0] - q[0], da = p[1] - q[1], db = p[2] - q[2];
    return Math.sqrt(dL * dL + da * da + db * db);
  }

  // CIEDE2000, for picking the nearest marker to a color a person will compare by eye.
  function deltaE2000(p, q) {
    const [L1, a1, b1] = p, [L2, a2, b2] = q;
    const rad = Math.PI / 180;
    const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
    const Cb = (C1 + C2) / 2, Cb7 = Math.pow(Cb, 7);
    const G = 0.5 * (1 - Math.sqrt(Cb7 / (Cb7 + 6103515625)));
    const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
    const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
    const h = (bb, aa) => { if (bb === 0 && aa === 0) return 0; const v = Math.atan2(bb, aa) / rad; return v < 0 ? v + 360 : v; };
    const h1p = h(b1, a1p), h2p = h(b2, a2p);
    const dLp = L2 - L1, dCp = C2p - C1p;
    let dhp = 0;
    if (C1p * C2p !== 0) { dhp = h2p - h1p; if (dhp > 180) dhp -= 360; else if (dhp < -180) dhp += 360; }
    const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(dhp * rad / 2);
    const Lbp = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2;
    let hbp = h1p + h2p;
    if (C1p * C2p !== 0) {
      if (Math.abs(h1p - h2p) > 180) hbp = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
      else hbp = (h1p + h2p) / 2;
    }
    const T = 1 - 0.17 * Math.cos((hbp - 30) * rad) + 0.24 * Math.cos(2 * hbp * rad)
      + 0.32 * Math.cos((3 * hbp + 6) * rad) - 0.20 * Math.cos((4 * hbp - 63) * rad);
    const dTheta = 30 * Math.exp(-Math.pow((hbp - 275) / 25, 2));
    const Cbp7 = Math.pow(Cbp, 7);
    const Rc = 2 * Math.sqrt(Cbp7 / (Cbp7 + 6103515625));
    const Sl = 1 + 0.015 * Math.pow(Lbp - 50, 2) / Math.sqrt(20 + Math.pow(Lbp - 50, 2));
    const Sc = 1 + 0.045 * Cbp, Sh = 1 + 0.015 * Cbp * T;
    const Rt = -Math.sin(2 * dTheta * rad) * Rc;
    const tL = dLp / Sl, tC = dCp / Sc, tH = dHp / Sh;
    return Math.sqrt(tL * tL + tC * tC + tH * tH + Rt * tC * tH);
  }

  // Index of the color in `labs` nearest to `lab` by CIEDE2000.
  function nearest(lab, labs) {
    let best = -1, bd = Infinity;
    for (let i = 0; i < labs.length; i++) {
      const d = deltaE2000(lab, labs[i]);
      if (d < bd) { bd = d; best = i; }
    }
    return { index: best, dE: bd };
  }

  // Black or white text, whichever reads better on this background.
  function inkOn(hex) {
    const [r, g, b] = hexToRgb(hex);
    const Y = 0.2126 * LIN[r] + 0.7152 * LIN[g] + 0.0722 * LIN[b];
    return Y > 0.36 ? '#111111' : '#ffffff';
  }

  // Seeded PRNG (mulberry32) so a sheet comes out the same for the same image and settings.
  function rng(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  Object.assign(C, {
    hexToRgb, rgbToHex, rgbToLab, labToRgb, hexToLab, labToHex,
    deltaE76, deltaE2000, nearest, inkOn, rng,
  });
})(typeof globalThis.DotColor === 'object' ? globalThis.DotColor : (globalThis.DotColor = {}));

if (typeof module === 'object' && module.exports) module.exports = globalThis.DotColor;
