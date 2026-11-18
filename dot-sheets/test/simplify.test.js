'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const DC = require('../js/color.js');
const DS = require('../js/simplify.js');

// ---- synthetic images ------------------------------------------------------------------------

function makeImg(w, h, fn) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b, a] = fn(x, y);
    const o = (y * w + x) * 4;
    data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = a == null ? 255 : a;
  }
  return { width: w, height: h, data };
}

// A little "portrait": sky gradient, green ground, skin-colored face with dark eyes, red mouth,
// plus seeded noise so there is texture to flatten.
function scene(w = 160, h = 120, seed = 7) {
  const rand = DC.rng(seed);
  return makeImg(w, h, (x, y) => {
    const u = x / w, v = y / h;
    let c;
    if (v > 0.75) c = [60, 140, 60];
    else c = [120 + 80 * v, 170 + 60 * v, 235];
    const dx = (u - 0.5) / 0.2, dy = (v - 0.45) / 0.28;
    if (dx * dx + dy * dy < 1) {
      c = [225, 175, 145];
      const ex = Math.min(Math.hypot(u - 0.44, v - 0.4), Math.hypot(u - 0.56, v - 0.4));
      if (ex < 0.025) c = [30, 25, 25];
      if (Math.abs(u - 0.5) < 0.05 && Math.abs(v - 0.58) < 0.015) c = [190, 30, 40];
    }
    if (u > 0.82 && u < 0.92 && v > 0.15 && v < 0.6) c = [250, 250, 248]; // white sign
    const nz = (rand() - 0.5) * 40;
    return [c[0] + nz, c[1] + nz, c[2] + nz];
  });
}

const POOL = ['#765fa8', '#5f422f', '#26b158', '#f5863e', '#f0739f', '#cb212e', '#43c0b2', '#2c86c8',
  '#fccdb2', '#95daf4', '#f9b0bc', '#080a09'].map((hex, i) => ({ id: 'm' + i, hex }));

// ---- invariant checker ----------------------------------------------------------------------

function checkSeg(seg, opts = {}) {
  const { width: w, height: h, index, region, regions, palette, preview } = seg;
  const n = w * h;
  assert.ok(index instanceof Uint8Array && index.length === n, 'index');
  assert.ok(region instanceof Int32Array && region.length === n, 'region');
  assert.ok(preview instanceof Uint8ClampedArray && preview.length === n * 4, 'preview');
  assert.ok(palette.length >= 1);
  // Palette shape, areas, ordering, paper at most once and last.
  let sum = 0;
  const counts = new Array(palette.length).fill(0);
  for (let p = 0; p < n; p++) { assert.ok(index[p] < palette.length); counts[index[p]]++; }
  palette.forEach((c, i) => {
    assert.match(c.hex, /^#[0-9a-f]{6}$/);
    assert.deepEqual(c.rgb, DC.hexToRgb(c.hex));
    assert.equal(c.lab.length, 3);
    assert.equal(c.area, counts[i], 'palette area matches pixel count');
    assert.ok(c.area > 0, 'only used colors');
    assert.equal(typeof c.paper, 'boolean');
    if (c.paper) { assert.equal(c.hex, '#ffffff'); assert.equal(i, palette.length - 1, 'paper last'); assert.equal(c.poolId, null); }
    sum += c.area;
  });
  assert.equal(sum, n);
  assert.ok(palette.filter(c => c.paper).length <= 1);
  const inks = palette.filter(c => !c.paper);
  for (let i = 1; i < inks.length; i++) assert.ok(inks[i - 1].area >= inks[i].area, 'ordered by area');
  // Regions: ids, one index each, areas, 4-connected, adjacent regions differ in index.
  regions.forEach((r, i) => { assert.equal(r.id, i); });
  const rArea = new Array(regions.length).fill(0);
  for (let p = 0; p < n; p++) {
    const r = region[p];
    assert.ok(r >= 0 && r < regions.length);
    assert.equal(regions[r].index, index[p], 'region pixels share one index');
    rArea[r]++;
    const x = p % w;
    if (x < w - 1 && region[p + 1] !== r) assert.notEqual(index[p + 1], index[p], 'adjacent regions must differ');
    if (p + w < n && region[p + w] !== r) assert.notEqual(index[p + w], index[p], 'adjacent regions must differ');
    if (x < w - 1 && index[p + 1] === index[p]) assert.equal(region[p + 1], r);
    if (p + w < n && index[p + w] === index[p]) assert.equal(region[p + w], r);
  }
  regions.forEach((r, i) => assert.equal(r.area, rArea[i]));
  // Connectivity: flood each region from its first pixel and compare areas.
  const seen = new Uint8Array(n), first = new Int32Array(regions.length).fill(-1);
  for (let p = 0; p < n; p++) if (first[region[p]] < 0) first[region[p]] = p;
  for (let r = 0; r < regions.length; r++) {
    const stack = [first[r]]; seen[first[r]] = 1; let cnt = 0;
    while (stack.length) {
      const p = stack.pop(); cnt++;
      const x = p % w;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) {
        if (q >= 0 && q < n && !seen[q] && region[q] === r) { seen[q] = 1; stack.push(q); }
      }
    }
    assert.equal(cnt, regions[r].area, 'region is 4-connected');
  }
  // Minimum area.
  if (opts.detail !== undefined && regions.length > 1) {
    const min = DS.minRegionArea(w, h, opts.detail);
    for (const r of regions) assert.ok(r.area >= min, `region of ${r.area} < min ${min}`);
  }
  // Preview shows the palette color.
  for (let p = 0; p < n; p += 97) {
    const c = palette[index[p]].rgb;
    assert.deepEqual([preview[p * 4], preview[p * 4 + 1], preview[p * 4 + 2], preview[p * 4 + 3]], [...c, 255]);
  }
}

// ---- tests --------------------------------------------------------------------------------------

test('simplify: invariants on a textured scene across detail levels', () => {
  const img = scene();
  for (const detail of [0, 0.5, 1]) {
    const seg = DS.simplify(img, { detail });
    checkSeg(seg, { detail });
    assert.ok(seg.palette.filter(c => !c.paper).length <= 8);
  }
});

test('simplify: lower detail gives fewer regions', () => {
  const img = scene(200, 150);
  const lo = DS.simplify(img, { detail: 0 }).regions.length;
  const hi = DS.simplify(img, { detail: 1 }).regions.length;
  assert.ok(lo < hi, `${lo} < ${hi}`);
});

test('simplify: deterministic for the same input and options', () => {
  const img = scene();
  for (const opts of [{}, { pool: POOL, seed: 3 }, { paper: true, colors: 5, detail: 0.8 }]) {
    const a = DS.simplify(img, opts), b = DS.simplify(img, opts);
    assert.deepEqual(a.index, b.index);
    assert.deepEqual(a.region, b.region);
    assert.deepEqual(a.palette, b.palette);
    assert.deepEqual(a.regions, b.regions);
  }
});

test('simplify: downscales to maxSide by area averaging, never upscales', () => {
  const big = makeImg(300, 100, (x) => x < 150 ? [255, 0, 0] : [0, 0, 255]);
  const seg = DS.simplify(big, { maxSide: 60 });
  assert.equal(seg.width, 60); assert.equal(seg.height, 20);
  checkSeg(seg);
  const small = DS.simplify(makeImg(40, 30, () => [10, 200, 10]), { maxSide: 480 });
  assert.equal(small.width, 40); assert.equal(small.height, 30);
});

test('simplify: colors option caps ink count (free mode)', () => {
  const img = scene();
  for (const colors of [2, 3, 5, 12]) {
    const seg = DS.simplify(img, { colors, detail: 1 });
    checkSeg(seg, { detail: 1 });
    assert.ok(seg.palette.filter(c => !c.paper).length <= colors, `colors ${colors}`);
    assert.ok(seg.palette.every(c => c.poolId === null));
  }
});

test('simplify: pool mode uses only pool colors (plus paper)', () => {
  const img = scene();
  const allowed = new Set(POOL.map(p => p.hex).concat(['#ffffff']));
  const ids = new Map(POOL.map(p => [p.hex, p.id]));
  for (const paper of [false, true]) {
    const seg = DS.simplify(img, { pool: POOL, paper });
    checkSeg(seg, { detail: 0.5 });
    for (const c of seg.palette) {
      assert.ok(allowed.has(c.hex), c.hex);
      if (!c.paper) assert.equal(c.poolId, ids.get(c.hex));
    }
    if (!paper) assert.ok(seg.palette.every(c => !c.paper));
  }
});

test("simplify: choose 'best' respects colors; 'all' may use more", () => {
  const img = scene();
  for (const colors of [2, 3, 4]) {
    const seg = DS.simplify(img, { pool: POOL, choose: 'best', colors });
    checkSeg(seg);
    assert.ok(seg.palette.filter(c => !c.paper).length <= colors);
  }
  const all = DS.simplify(img, { pool: POOL, choose: 'all', colors: 2 });
  checkSeg(all);
  assert.ok(all.palette.filter(c => !c.paper).length >= 2);
});

test('simplify: pool mode keeps a blue sky blue and a red mouth red', () => {
  const img = makeImg(120, 90, (x, y) => y < 45 ? [150, 200, 240] : [200, 40, 40]);
  const seg = DS.simplify(img, { pool: POOL });
  const top = seg.palette[seg.index[10 * 120 + 60]].hex, bottom = seg.palette[seg.index[80 * 120 + 60]].hex;
  assert.ok(['#95daf4', '#2c86c8', '#43c0b2'].includes(top), 'sky -> ' + top);
  assert.ok(['#cb212e', '#f0739f'].includes(bottom), 'red -> ' + bottom);
});

test('simplify: paper option', () => {
  // White background with a dark blue disc.
  const img = makeImg(100, 100, (x, y) => Math.hypot(x - 50, y - 50) < 30 ? [20, 40, 140] : [255, 255, 255]);
  const withPaper = DS.simplify(img, { paper: true, colors: 3 });
  checkSeg(withPaper);
  const pap = withPaper.palette.find(c => c.paper);
  assert.ok(pap, 'white background becomes paper');
  assert.equal(withPaper.palette[withPaper.index[0]].paper, true);
  assert.equal(withPaper.palette[withPaper.index[50 * 100 + 50]].paper, false);
  const noPaper = DS.simplify(img, { colors: 3 }); // default paper: false
  checkSeg(noPaper);
  assert.ok(noPaper.palette.every(c => !c.paper));
  // Transparent pixels count as white.
  const clear = makeImg(40, 40, (x) => x < 20 ? [0, 0, 0, 0] : [200, 20, 20, 255]);
  const segC = DS.simplify(clear, { paper: true });
  assert.equal(segC.palette[segC.index[0]].paper, true);
});

test('simplify: solid color image is one region', () => {
  for (const opts of [{}, { pool: POOL }, { paper: true }]) {
    const seg = DS.simplify(makeImg(64, 48, () => [40, 120, 200]), opts);
    checkSeg(seg);
    assert.equal(seg.regions.length, 1);
    assert.equal(seg.palette.length, 1);
    assert.equal(seg.regions[0].area, 64 * 48);
  }
  // Free mode keeps a flat color: exactly with boost 0, and the same lightness/hue with boost.
  for (const rgb of [[200, 200, 200], [40, 120, 200], [230, 180, 60]]) {
    const lab = DC.rgbToLab(...rgb);
    const plain = DS.simplify(makeImg(32, 32, () => rgb), { boost: 0 });
    assert.ok(DC.deltaE76(plain.palette[0].lab, lab) < 2, `${rgb} -> ${plain.palette[0].hex}`);
    const boosted = DS.simplify(makeImg(32, 32, () => rgb)).palette[0].lab;
    assert.ok(Math.abs(boosted[0] - lab[0]) < 6, 'lightness kept');
    assert.ok(Math.hypot(boosted[1], boosted[2]) >= Math.hypot(lab[1], lab[2]) - 1, 'chroma not reduced');
  }
});

test('simplify: tiny images', () => {
  const rand = DC.rng(5);
  for (const [w, h] of [[1, 1], [3, 3], [1, 50], [50, 1], [2, 7]]) {
    const img = makeImg(w, h, () => [rand() * 255, rand() * 255, rand() * 255]);
    for (const opts of [{}, { pool: POOL }, { paper: true, detail: 1 }]) {
      const seg = DS.simplify(img, opts);
      assert.equal(seg.width, w); assert.equal(seg.height, h);
      checkSeg(seg, { detail: opts.detail == null ? 0.5 : opts.detail });
    }
  }
});

test('simplify: small but contrasting features (eyes) survive at high detail', () => {
  const img = scene(240, 180);
  const seg = DS.simplify(img, { detail: 1 });
  const eye = seg.index[Math.round(0.4 * 180) * 240 + Math.round(0.44 * 240)];
  const cheek = seg.index[Math.round(0.5 * 180) * 240 + Math.round(0.4 * 240)];
  assert.notEqual(eye, cheek);
  assert.ok(seg.palette[eye].lab[0] < seg.palette[cheek].lab[0] - 20, 'eye darker than face');
});

test('simplify: works without options and accepts plain arrays', () => {
  const img = scene(30, 20);
  const seg = DS.simplify({ width: 30, height: 20, data: Array.from(img.data) });
  checkSeg(seg);
});
