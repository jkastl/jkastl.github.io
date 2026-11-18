'use strict';
// node --test dot-sheets/test/
const test = require('node:test');
const assert = require('node:assert/strict');
const DC = require('../js/color.js');
const DL = require('../js/layout.js');

/* ---------------------------------------------------------------- synthetic segs */

// 4-connected regions of an index image.
function label(w, h, index) {
  const region = new Int32Array(w * h).fill(-1), regions = [], st = [];
  for (let p = 0; p < w * h; p++) {
    if (region[p] >= 0) continue;
    const id = regions.length, c = index[p];
    let area = 0; st.push(p); region[p] = id;
    while (st.length) {
      const q = st.pop(); area++;
      const x = q % w, y = (q / w) | 0;
      for (const n of [x > 0 ? q - 1 : -1, x < w - 1 ? q + 1 : -1, y > 0 ? q - w : -1, y < h - 1 ? q + w : -1]) {
        if (n >= 0 && region[n] < 0 && index[n] === c) { region[n] = id; st.push(n); }
      }
    }
    regions.push({ id, index: c, area });
  }
  return { region, regions };
}

const HEX = ['#ffffff', '#e8a33d', '#2b6cb0', '#c53030', '#2f855a', '#553c9a', '#ed64a6', '#1a202c'];
function makeSeg(w, h, fn, paperIdx = 0) {
  const index = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) index[y * w + x] = fn(x + 0.5, y + 0.5, x, y);
  const { region, regions } = label(w, h, index);
  const palette = HEX.map((hex, i) => ({ hex, rgb: DC.hexToRgb(hex), lab: DC.hexToLab(hex), area: 0, paper: i === paperIdx, poolId: null }));
  for (let p = 0; p < w * h; p++) palette[index[p]].area++;
  return { width: w, height: h, index, region, regions, palette };
}

// Rectangles, a circle, a ring with an island, stripes 1-3 px, a checkerboard, a single-pixel
// region and paper.
function mixed() {
  return makeSeg(160, 130, (x, y, xi, yi) => {
    if (xi === 150 && yi === 5) return 3;                      // single pixel
    const r = Math.hypot(x - 115, y - 85);
    if (r < 9) return 6;                                       // island
    if (r > 15 && r < 32) return 3;                            // ring
    if (Math.hypot(x - 40, y - 40) < 25) return 1;             // circle
    if (xi >= 75 && xi < 140 && yi >= 10 && yi < 45) return 2; // rectangle
    if (yi >= 75 && yi < 125) {                                // stripes 1, 2, 3 px
      if (xi === 10) return 7;
      if (xi >= 16 && xi < 18) return 7;
      if (xi >= 24 && xi < 27) return 7;
    }
    if (xi >= 35 && xi < 65 && yi >= 80 && yi < 110) return ((xi >> 2) + (yi >> 2)) & 1 ? 4 : 5; // checker 4 px
    if (yi >= 115) return 4;                                   // ink strip along the bottom
    return 0;                                                  // paper
  });
}

function blobs(w, h, n, seed) {
  const rand = DC.rng(seed), sites = [];
  for (let i = 0; i < n; i++) sites.push([rand() * w, rand() * h, Math.floor(rand() * 8)]);
  const cs = 30, gw = Math.ceil(w / cs), gh = Math.ceil(h / cs), grid = Array.from({ length: gw * gh }, () => []);
  sites.forEach((s, i) => grid[Math.floor(s[1] / cs) * gw + Math.floor(s[0] / cs)].push(i));
  return makeSeg(w, h, (x, y) => {
    const wx = x + 5 * Math.sin(y / 11), gx = Math.floor(x / cs), gy = Math.floor(y / cs);
    let best = 0, bd = Infinity;
    for (let rr = 1; rr < 8; rr++) {
      for (let yy = gy - rr; yy <= gy + rr; yy++) for (let xx = gx - rr; xx <= gx + rr; xx++) {
        if (xx < 0 || yy < 0 || xx >= gw || yy >= gh) continue;
        for (const i of grid[yy * gw + xx]) { const d = Math.hypot(wx - sites[i][0], y - sites[i][1]); if (d < bd) { bd = d; best = i; } }
      }
      if (bd < rr * cs * 0.7) break;
    }
    return sites[best][2];
  });
}

/* ---------------------------------------------------------------- checks */

const MIXED = mixed();
const MM = 0.4, SIZES = [1.6, 2.4, 3.4], GAP = 0.35, INSET = 0.15;

function pix(seg, xmm, ymm, mm) {
  const x = Math.floor(xmm / mm), y = Math.floor(ymm / mm);
  if (x < 0 || y < 0 || x >= seg.width || y >= seg.height) return -1;
  return y * seg.width + x;
}

function assertNoOverlap(dots, sizes, gap) {
  const cs = 2 * Math.max(...sizes) + gap, grid = new Map();
  dots.forEach((d, i) => {
    const k = Math.floor(d.x / cs) + ',' + Math.floor(d.y / cs);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  });
  dots.forEach((d, i) => {
    const gx = Math.floor(d.x / cs), gy = Math.floor(d.y / cs);
    for (let yy = gy - 1; yy <= gy + 1; yy++) for (let xx = gx - 1; xx <= gx + 1; xx++) {
      for (const j of grid.get(xx + ',' + yy) || []) {
        if (j <= i) continue;
        const e = dots[j], need = sizes[d.s] + sizes[e.s] + gap;
        // Output is rounded to 0.001 mm.
        assert.ok(Math.hypot(d.x - e.x, d.y - e.y) >= need - 0.002,
          `dots ${i} and ${j} overlap: ${JSON.stringify(d)} ${JSON.stringify(e)}`);
      }
    }
  });
}

// Share of the disc around (x, y) mm lying on pixels of region `reg`.
function discCover(seg, x, y, r, reg, mm) {
  let n = 0, tot = 0;
  const st = mm / 8; // sample cell centres, so no sample sits on a pixel edge
  for (let a = -r + st / 2; a < r; a += st) for (let b = -r + st / 2; b < r; b += st) {
    if (a * a + b * b > r * r) continue;
    tot++;
    const p = pix(seg, x + a, y + b, mm);
    if (p >= 0 && seg.region[p] === reg) n++;
  }
  return n / tot;
}

// Every dot: centre on its colour; disc (plus most of the inset) inside its region, except
// "forced" smallest dots of tiny/thin parts, which must cover >= 30% of their disc.
function assertDotsInRegions(seg, dots, sizes, mm, inset) {
  const forced = [];
  for (const d of dots) {
    const p = pix(seg, d.x, d.y, mm);
    assert.ok(p >= 0, 'dot off the image');
    assert.equal(seg.index[p], d.c, 'dot centre not on its colour');
    assert.ok(!seg.palette[d.c].paper, 'dot on paper');
    const reg = seg.region[p], r = sizes[d.s] + inset * 0.5;
    let inside = true;
    for (let k = 0; k < 48 && inside; k++) {
      const a = k * Math.PI / 24, q = pix(seg, d.x + r * Math.cos(a), d.y + r * Math.sin(a), mm);
      if (q < 0 || seg.region[q] !== reg) inside = false;
    }
    if (!inside) {
      forced.push(d);
      assert.equal(d.s, sizes.indexOf(Math.min(...sizes)), 'only smallest dots may stick out');
      assert.ok(discCover(seg, d.x, d.y, sizes[d.s], reg, mm) >= 0.25, 'forced dot barely on its region ' + JSON.stringify(d));
    }
  }
  return forced;
}

// Brute-force depth (px) of each region: max over its pixels of the distance from the pixel
// centre to the nearest crack with another region or the border.
const depthCache = new WeakMap();
function regionDepths(seg) {
  if (!depthCache.has(seg)) depthCache.set(seg, regionDepthsRaw(seg));
  return depthCache.get(seg);
}
function regionDepthsRaw(seg) {
  const { width: w, height: h, region: R } = seg;
  const cracks = []; // crack midpoints
  for (let y = 0; y < h; y++) for (let x = 0; x <= w; x++) if (x === 0 || x === w || R[y * w + x - 1] !== R[y * w + x]) cracks.push([x, y + 0.5]);
  for (let y = 0; y <= h; y++) for (let x = 0; x < w; x++) if (y === 0 || y === h || R[(y - 1) * w + x] !== R[y * w + x]) cracks.push([x + 0.5, y]);
  const depth = new Float64Array(seg.regions.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let d = Infinity;
    for (const c of cracks) { const e = Math.hypot(c[0] - x - 0.5, c[1] - y - 0.5); if (e < d) d = e; }
    const r = R[y * w + x];
    if (d > depth[r]) depth[r] = d;
  }
  return depth;
}

/* ---------------------------------------------------------------- dots */

test('dots: mmPerPx is required', () => {
  assert.throws(() => DL.dots(mixed(), {}), /mmPerPx/);
  assert.throws(() => DL.labels(mixed(), {}), /mmPerPx/);
  assert.throws(() => DL.outlines(mixed(), {}), /mmPerPx/);
});

for (const style of ['flow', 'stipple']) {
  test(`dots (${style}): no overlaps, on colour, inside regions, no paper, sorted`, () => {
    const seg = mixed();
    const dots = DL.dots(seg, { mmPerPx: MM, style });
    assert.ok(dots.length > 50);
    assertNoOverlap(dots, SIZES, GAP);
    const forced = assertDotsInRegions(seg, dots, SIZES, MM, INSET);
    // Forced dots only come from the stripes and the 4 px checkerboard here.
    const thin = new Set([7, 4, 5]);
    assert.ok(forced.length > 0 && forced.every(d => thin.has(d.c)), 'forced dots only on thin/tiny parts');
    for (let i = 1; i < dots.length; i++) {
      const a = dots[i - 1], b = dots[i];
      assert.ok(a.y < b.y || (a.y === b.y && a.x <= b.x), 'sorted by y then x');
    }
    for (const d of dots) assert.ok(Number.isInteger(d.s) && d.s >= 0 && d.s < SIZES.length);
  });

  test(`dots (${style}): every region that can hold the smallest dot gets one`, () => {
    const seg = MIXED;
    const dots = DL.dots(seg, { mmPerPx: MM, style });
    const depth = regionDepths(seg);
    const has = new Set(dots.map(d => seg.region[pix(seg, d.x, d.y, MM)]));
    for (const r of seg.regions) {
      if (seg.palette[r.index].paper) continue;
      if (depth[r.id] * MM >= SIZES[0] + INSET + 0.05) assert.ok(has.has(r.id), `region ${r.id} (depth ${depth[r.id]}) has no dot`);
    }
  });
}

test('dots: thin stripes become a line of small dots, hairlines and specks are skipped', () => {
  const seg = mixed();
  const dots = DL.dots(seg, { mmPerPx: MM });
  // The 3 px stripe (x 24..26, y 75..124) is 1.2 mm wide: a line of smallest dots along it.
  const onStripe = dots.filter(d => d.x > 24 * MM && d.x < 27 * MM && d.c === 7);
  assert.ok(onStripe.length >= 4, 'stripe has a line of dots, got ' + onStripe.length);
  assert.ok(onStripe.every(d => d.s === 0 && Math.abs(d.x - 25.5 * MM) < 1e-6));
  // The 1 px hairline covers < 30% of any dot: none. Same for the single-pixel region.
  assert.ok(!dots.some(d => d.x > 10 * MM && d.x < 11 * MM && d.c === 7));
  const single = seg.region[5 * 160 + 150];
  assert.ok(!dots.some(d => seg.region[pix(seg, d.x, d.y, MM)] === single));
});

test('dots (flow): big areas get big dots in the core, small dots trace the edge', () => {
  // 80 x 64 mm ink rectangle on paper.
  const seg = makeSeg(220, 180, (x, y, xi, yi) => (xi >= 10 && xi < 210 && yi >= 10 && yi < 170 ? 2 : 0));
  const dots = DL.dots(seg, { mmPerPx: MM });
  const st = DL.stats(dots, SIZES);
  // Large dots carry most of the colour (marker ink area), with a medium transition row.
  assert.ok(st.bySize[2] * SIZES[2] ** 2 > st.bySize[1] * SIZES[1] ** 2 && st.bySize[2] > 30, JSON.stringify(st.bySize));
  const depth = d => Math.min(d.x - 4, 84 - d.x, d.y - 4, 68 - d.y);
  // Outer row: smallest dots hugging the edge.
  const edge = dots.filter(d => depth(d) < 2.2);
  assert.ok(edge.length > 50 && edge.every(d => d.s === 0));
  // Core: only the largest size and the one below it.
  const core = dots.filter(d => depth(d) > 12);
  assert.ok(core.length > 20 && core.every(d => d.s >= 1));
  assert.ok(core.filter(d => d.s === 2).length > 0.7 * core.length);
});

test('dots: tiny region gets one forced smallest dot at its middle', () => {
  // A 5x5 px square (2 mm) can't hold a 1.6 mm dot but covers > 30% of it.
  const seg = makeSeg(40, 40, (x, y, xi, yi) => (xi >= 18 && xi < 23 && yi >= 18 && yi < 23 ? 3 : 0));
  const dots = DL.dots(seg, { mmPerPx: MM });
  assert.equal(dots.length, 1);
  assert.equal(dots[0].s, 0);
  assert.equal(dots[0].c, 3);
  assert.ok(Math.abs(dots[0].x - 20.5 * MM) < 1e-9 && Math.abs(dots[0].y - 20.5 * MM) < 1e-9);
});

test('dots: checkerboard and stripes respect regions and gaps with custom sizes', () => {
  const seg = makeSeg(120, 90, (x, y, xi, yi) => (yi < 45 ? (((xi >> 3) + (yi >> 3)) & 1 ? 2 : 3) : 1 + ((xi >> 1) % 3)));
  const sizes = [0.95, 1.3, 1.7];
  const dots = DL.dots(seg, { mmPerPx: MM, sizes });
  assertNoOverlap(dots, sizes, GAP);
  assertDotsInRegions(seg, dots, sizes, MM, INSET);
});

test('dots: sizes in any order and 1-4 levels', () => {
  const seg = mixed();
  for (const sizes of [[2], [3.4, 1.6], [1.2, 1.8, 2.4, 3.0], [2.4, 1.6, 3.4]]) {
    const dots = DL.dots(seg, { mmPerPx: MM, sizes });
    assert.ok(dots.length > 0);
    assertNoOverlap(dots, sizes, GAP);
    assertDotsInRegions(seg, dots, sizes, MM, INSET);
  }
});

test('dots: deterministic, seed changes the layout', () => {
  const seg = mixed();
  const a = JSON.stringify(DL.dots(seg, { mmPerPx: MM, seed: 5 }));
  const b = JSON.stringify(DL.dots(mixed(), { mmPerPx: MM, seed: 5 }));
  const c = JSON.stringify(DL.dots(seg, { mmPerPx: MM, seed: 6 }));
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('dots: all paper gives nothing; skipPaper false dots the paper too', () => {
  const seg = makeSeg(50, 40, () => 0);
  assert.deepEqual(DL.dots(seg, { mmPerPx: MM }), []);
  const all = DL.dots(seg, { mmPerPx: MM, skipPaper: false });
  assert.ok(all.length > 0 && all.every(d => d.c === 0));
});

test('dots: density thins the layout', () => {
  const seg = mixed();
  const n1 = DL.dots(seg, { mmPerPx: MM, density: 1 }).length;
  const n5 = DL.dots(seg, { mmPerPx: MM, density: 0.5 }).length;
  assert.ok(n5 < n1, `${n5} < ${n1}`);
});

test('stats counts per colour and size', () => {
  const st = DL.stats([{ x: 0, y: 0, s: 0, c: 2 }, { x: 1, y: 0, s: 2, c: 2 }, { x: 2, y: 0, s: 2, c: 5 }], SIZES);
  assert.equal(st.total, 3);
  assert.deepEqual(st.bySize, [1, 0, 2]);
  assert.deepEqual(st.byColor, { 2: 2, 5: 1 });
  assert.deepEqual(st.byColorSize[2], [1, 0, 1]);
});

test('dots: performance on a 480x600 seg with ~200 regions', () => {
  const seg = blobs(480, 600, 200, 3);
  const t0 = Date.now();
  const dots = DL.dots(seg, { mmPerPx: MM });
  const ms = Date.now() - t0;
  const t1 = Date.now();
  DL.dots(seg, { mmPerPx: MM, sizes: [1.25, 1.7, 2.2] }); // distance field cached
  const ms2 = Date.now() - t1;
  console.log(`# dots: ${seg.regions.length} regions, ${dots.length} dots in ${ms} ms (cached field, medium sizes: ${ms2} ms)`);
  assert.ok(dots.length > 1000 && dots.length < 8000);
  assert.ok(ms < 3000, `took ${ms} ms`);
  assertNoOverlap(dots, SIZES, GAP);
});

/* ---------------------------------------------------------------- labels */

test('labels: one per region that fits, inside it, sized to fit; small ones listed', () => {
  const seg = MIXED;
  const { labels, tooSmall } = DL.labels(seg, { mmPerPx: MM });
  const depth = regionDepths(seg);
  const labelled = new Set(labels.map(l => l.region));
  for (const l of labels) {
    const p = pix(seg, l.x, l.y, MM);
    assert.equal(seg.region[p], l.region, 'label inside its region');
    assert.equal(seg.index[p], l.c);
    assert.ok(l.size >= 1.8 && l.size <= 6);
    assert.ok(l.size <= depth[l.region] * MM * 2.1, 'letter fits the inscribed circle');
  }
  for (const r of seg.regions) {
    if (seg.palette[r.index].paper) { assert.ok(!labelled.has(r.id) && !tooSmall.includes(r.id)); continue; }
    assert.ok(labelled.has(r.id) !== tooSmall.includes(r.id), `region ${r.id} labelled xor tooSmall`);
  }
  assert.ok(tooSmall.includes(seg.region[5 * 160 + 150]), 'single pixel is too small');
  // Circle of radius 25 px = 10 mm: label at its centre, max font.
  const circ = labels.find(l => l.region === seg.region[40 * 160 + 40]);
  assert.ok(Math.hypot(circ.x - 16, circ.y - 16) < 1);
  assert.equal(circ.size, 6);
});

test('labels: long shapes get extra labels at least minSep apart', () => {
  const seg = makeSeg(400, 60, (x, y, xi, yi) => (yi >= 20 && yi < 40 && xi >= 10 && xi < 390 ? 2 : 0));
  const { labels } = DL.labels(seg, { mmPerPx: MM });
  assert.ok(labels.length >= 2 && labels.length <= 3);
  for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
    assert.ok(Math.hypot(labels[i].x - labels[j].x, labels[i].y - labels[j].y) >= 40 - 1e-6);
  }
  assert.equal(DL.labels(seg, { mmPerPx: MM, maxPerRegion: 1 }).labels.length, 1);
});

/* ---------------------------------------------------------------- outlines */

test('outlines: shared edge drawn once, image border not drawn', () => {
  const seg = makeSeg(100, 60, (x) => (x < 40 ? 1 : 2));
  for (const smooth of [true, false]) {
    const o = DL.outlines(seg, { mmPerPx: MM, smooth });
    assert.ok(Math.abs(o.length - 60 * MM) < 0.05, `length ${o.length}`);
    assert.equal((o.d.match(/M/g) || []).length, 1);
  }
});

test('outlines: T junction chains meet and every edge appears once', () => {
  const seg = makeSeg(80, 80, (x, y) => (x < 40 ? 1 : y < 40 ? 2 : 3));
  const o = DL.outlines(seg, { mmPerPx: MM });
  assert.ok(Math.abs(o.length - 120 * MM) < 0.1, `length ${o.length}`);
  // Three chains, all ending at the junction (16, 16).
  const subs = o.d.split('M').filter(Boolean);
  assert.equal(subs.length, 3);
  for (const s of subs) {
    const nums = s.match(/-?[\d.]+/g).map(Number);
    const ends = [[nums[0], nums[1]], [nums[nums.length - 2], nums[nums.length - 1]]];
    assert.ok(ends.some(e => Math.hypot(e[0] - 16, e[1] - 16) < 1e-9), 'chain ends at the junction: ' + s);
  }
});

test('outlines: island is a closed subpath, smooth and round', () => {
  const seg = makeSeg(100, 100, (x, y) => (Math.hypot(x - 50, y - 50) < 30 ? 3 : 1));
  const o = DL.outlines(seg, { mmPerPx: MM });
  assert.equal((o.d.match(/M/g) || []).length, 1);
  assert.equal((o.d.match(/Z/g) || []).length, 1);
  assert.ok(o.d.includes('C'), 'smoothed with Beziers');
  const circ = 2 * Math.PI * 30 * MM;
  assert.ok(Math.abs(o.length - circ) / circ < 0.03, `length ${o.length} vs ${circ}`);
  // Two decimals at most.
  assert.ok(!/\d\.\d{3}/.test(o.d));
});

test('outlines: ink/paper boundaries included; one region gives nothing', () => {
  assert.deepEqual(DL.outlines(makeSeg(30, 30, () => 0), { mmPerPx: MM }), { d: '', length: 0 });
  const o = DL.outlines(mixed(), { mmPerPx: MM });
  assert.ok(o.length > 100 && o.d.length > 100);
  assert.ok(!/NaN|Infinity/.test(o.d));
});
