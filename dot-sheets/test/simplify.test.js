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
    const min = DS.minRegionArea(w, h, opts.detail, opts.featurePx);
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
  const img = scene(400, 300);
  const lo = DS.simplify(img, { detail: 0, lines: 0, featurePx: 2 }).regions.length;
  const hi = DS.simplify(img, { detail: 1, lines: 0, featurePx: 2 }).regions.length;
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

// City-block distance from each pixel to the nearest pixel of another region (image edge is not a
// boundary); returns the max per region.
function regionThickness(seg) {
  const { width: w, height: h, region } = seg, n = w * h;
  const d = new Int32Array(n).fill(1 << 30), q = [];
  for (let p = 0; p < n; p++) {
    const x = p % w, r = region[p];
    if ((x > 0 && region[p - 1] !== r) || (x < w - 1 && region[p + 1] !== r) || (p >= w && region[p - w] !== r) || (p + w < n && region[p + w] !== r)) { d[p] = 1; q.push(p); }
  }
  for (let i = 0; i < q.length; i++) {
    const p = q[i], x = p % w;
    for (const nb of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) {
      if (nb >= 0 && nb < n && region[nb] === region[p] && d[nb] > d[p] + 1) { d[nb] = d[p] + 1; q.push(nb); }
    }
  }
  const mx = new Array(seg.regions.length).fill(0);
  for (let p = 0; p < n; p++) if (d[p] < (1 << 30) && d[p] > mx[region[p]]) mx[region[p]] = d[p];
  return mx;
}

test('simplify: featurePx removes slivers too thin to hold a dot', () => {
  // Blue stripes 2, 3 and 4 px wide and a red one 16 px wide, 14 px apart, on a plain background.
  const img = makeImg(162, 120, (x) => {
    const u = x % 81;
    return u < 2 || (u >= 16 && u < 19) || (u >= 33 && u < 37) ? [20, 20, 120] : u >= 51 && u < 67 ? [200, 30, 30] : [240, 230, 200];
  });
  for (const featurePx of [6, 9]) {
    const seg = DS.simplify(img, { featurePx, lines: 0, detail: 1 });
    checkSeg(seg, { detail: 1, featurePx });
    const r = Math.floor((featurePx - 1) / 2);
    regionThickness(seg).forEach((t, i) => {
      if (t > 0) assert.ok(t >= r + 1, `region ${i} only ${t} px from its edge (featurePx ${featurePx})`);
    });
  }
  // The thin blue stripes are gone, the 16 px red ones survive.
  const seg = DS.simplify(img, { featurePx: 6, lines: 0, detail: 1 });
  assert.ok(seg.palette[seg.index[60 * 162 + 59]].lab[1] > 30, 'red stripe kept');
  for (const x of [1, 17, 35]) assert.ok(seg.palette[seg.index[60 * 162 + x]].lab[0] > 70, `thin stripe at ${x} removed`);
});

test('simplify: lines draw features in the darkest color (free mode)', () => {
  const img = scene(240, 180);
  const seg = DS.simplify(img, { lines: 1, detail: 0.35 });
  checkSeg(seg, { detail: 0.35 });
  const eye = seg.palette[seg.index[Math.round(0.4 * 180) * 240 + Math.round(0.44 * 240)]];
  const darkest = seg.palette.reduce((a, c) => (c.lab[0] < a.lab[0] ? c : a));
  assert.equal(eye, darkest);
  assert.ok(darkest.lab[0] < 30);
  assert.ok(seg.palette.filter(c => !c.paper).length <= 8, 'line color counts against colors');
  const off = DS.simplify(img, { lines: 0, colors: 3 });
  checkSeg(off);
  assert.ok(off.palette.filter(c => !c.paper).length <= 3);
});

test('simplify: lines use the darkest pool color in pool mode', () => {
  const img = scene(240, 180);
  const seg = DS.simplify(img, { pool: POOL, colors: 4, lines: 0.8 });
  checkSeg(seg);
  assert.ok(seg.palette.some(c => c.hex === '#080a09'), 'black marker used for outlines');
  assert.ok(seg.palette.filter(c => !c.paper).length <= 4);
});

test('simplify: pool mode keeps a white muzzle apart from a pale teal background', () => {
  // Teal background, orange head, white lower face with a dark nose: like the fox sample.
  const LAND = ['#765fa8', '#5f422f', '#26b158', '#f5863e', '#f0739f', '#cb212e', '#43c0b2', '#2c86c8']
    .map((hex, i) => ({ id: 'l' + i, hex }));
  const rand = DC.rng(3);
  const img = makeImg(240, 240, (x, y) => {
    const dx = x - 120, dy = y - 120, nz = (rand() - 0.5) * 16;
    let c = [110, 190, 190];
    if (dx * dx + dy * dy < 85 * 85) c = y > 125 ? [250, 248, 244] : [225, 110, 40];
    if (Math.hypot(dx, dy - 50) < 9) c = [30, 20, 20];
    return [c[0] + nz, c[1] + nz, c[2] + nz];
  });
  for (const colors of [5, 8]) {
    const seg = DS.simplify(img, { pool: LAND, colors, featurePx: 7.5, seed: 7 });
    checkSeg(seg);
    const at = (x, y) => seg.palette[seg.index[y * 240 + x]];
    assert.notEqual(at(80, 150).hex, at(10, 10).hex, `muzzle and background share ${at(10, 10).hex}`);
    assert.notEqual(at(80, 150).hex, at(120, 80).hex, 'muzzle and head differ');
    assert.ok(at(120, 170).lab[0] < 40, 'nose stays dark');
    assert.ok(seg.palette.filter(c => !c.paper).length <= colors);
  }
});

// ---- background ---------------------------------------------------------------------------------

// A pale, furry "dog" that runs off the bottom of the frame, in front of a wooden fence with a pile
// of orange leaves on each side: a messy background that touches three edges.
function petScene(w = 240, h = 240, seed = 11) {
  const rand = DC.rng(seed);
  return makeImg(w, h, (x, y) => {
    const u = x / w, v = y / h, nz = (rand() - 0.5) * 30;
    let c = (x % 30) < 3 ? [70, 40, 25] : [150 + 20 * Math.sin(y / 7), 95, 60]; // planks and gaps
    if (v > 0.55 && rand() < 0.6) c = rand() < 0.5 ? [225, 130, 50] : [180, 80, 35]; // leaves
    const dx = (u - 0.5) / 0.36, dy = (v - 0.72) / 0.6;
    if (dx * dx + dy * dy < 1) {
      c = [238, 236, 232];
      if (Math.abs(u - 0.5) > 0.22 && v < 0.45) c = [95, 100, 110]; // dark ear patches
      if (Math.min(Math.hypot(u - 0.42, v - 0.4), Math.hypot(u - 0.58, v - 0.4)) < 0.025) c = [35, 30, 30];
      if (Math.hypot(u - 0.5, v - 0.52) < 0.035) c = [25, 20, 20]; // nose
    }
    return [c[0] + nz, c[1] + nz, c[2] + nz];
  });
}

test('subjectMask: finds a subject that runs off the bottom, in front of a busy background', () => {
  const img = petScene();
  const seg = DS.simplify(img, { background: 'remove', lines: 0, featurePx: 4 });
  const m = seg.subject, w = seg.width, h = seg.height;
  assert.ok(m instanceof Uint8Array && m.length === w * h);
  const at = (u, v) => m[Math.floor(v * h) * w + Math.floor(u * w)];
  // Inside the subject (including the bottom edge it runs off) vs. fence and leaves.
  for (const [u, v] of [[0.5, 0.3], [0.5, 0.7], [0.5, 0.98], [0.35, 0.6], [0.62, 0.45]]) assert.equal(at(u, v), 1, `subject at ${u},${v}`);
  for (const [u, v] of [[0.05, 0.05], [0.95, 0.1], [0.5, 0.04], [0.04, 0.8], [0.96, 0.85]]) assert.equal(at(u, v), 0, `background at ${u},${v}`);
});

test('simplify: background "remove" leaves the background as blank paper', () => {
  const img = petScene();
  for (const pool of [null, POOL]) {
    const seg = DS.simplify(img, { background: 'remove', pool, featurePx: 4 });
    checkSeg(seg);
    const paper = seg.palette.findIndex(c => c.paper);
    assert.ok(paper >= 0, 'has paper');
    const at = (u, v) => seg.index[Math.floor(v * seg.height) * seg.width + Math.floor(u * seg.width)];
    assert.equal(at(0.05, 0.05), paper);
    assert.equal(at(0.95, 0.9), paper);
    assert.notEqual(at(0.5, 0.7), paper, 'the subject still gets dots');
    assert.ok(seg.palette.filter(c => !c.paper).length <= 8, 'paper is free: the subject keeps every color');
  }
});

test('simplify: background "color" fills it with the chosen color, and that color counts', () => {
  const img = petScene();
  for (const [pool, hex, id] of [[null, '#3fa7d6', null], [POOL, POOL[1].hex, POOL[1].id]]) {
    const seg = DS.simplify(img, { background: 'color', bgHex: hex, bgPoolId: id, pool, colors: 6, featurePx: 4 });
    checkSeg(seg);
    const c = seg.palette[seg.index[3 * seg.width + 3]];
    assert.equal(c.hex, hex);
    if (pool) assert.equal(c.poolId, id);
    assert.ok(seg.palette.filter(p => !p.paper).length <= 6, 'within the color budget');
  }
  // Auto: a pool marker near the background's own color.
  const auto = DS.simplify(img, { background: 'color', pool: POOL, featurePx: 4 });
  const bg = auto.palette[auto.index[3 * auto.width + 3]];
  assert.ok(bg.poolId, 'auto picks an owned marker');
});

test('simplify: background "simplify" flattens the background into a few big shapes', () => {
  const img = petScene();
  const count = (seg) => {
    const ids = new Set();
    for (let p = 0; p < seg.index.length; p++) if (!seg.subject || !seg.subject[p]) ids.add(seg.region[p]);
    return ids.size;
  };
  const keep = DS.simplify(img, { background: 'keep', featurePx: 4, detail: 0.6 });
  const simp = DS.simplify(img, { background: 'simplify', featurePx: 4, detail: 0.6 });
  checkSeg(simp);
  assert.equal(keep.subject, undefined, 'keep does no subject detection');
  assert.ok(count(simp) * 2 <= count(keep), `background regions ${count(simp)} vs ${count(keep)}`);
});

test('simplify: "keep" is the same as no background option', () => {
  const img = scene();
  const a = DS.simplify(img, { pool: POOL }), b = DS.simplify(img, { pool: POOL, background: 'keep' });
  assert.deepEqual(a.index, b.index);
  assert.deepEqual(a.palette, b.palette);
});

test('simplify: a click hint moves a part between subject and background', () => {
  const img = petScene();
  const base = DS.simplify(img, { background: 'remove', featurePx: 4 });
  const w = base.width, h = base.height, at = (s, u, v) => s.subject[Math.floor(v * h) * w + Math.floor(u * w)];
  assert.equal(at(base, 0.5, 0.06), 0);
  const fixFg = DS.simplify(img, { background: 'remove', featurePx: 4, bgHints: [{ x: 0.5, y: 0.06, fg: true }] });
  assert.equal(at(fixFg, 0.5, 0.06), 1, 'clicked background became subject');
  const fixBg = DS.simplify(img, { background: 'remove', featurePx: 4, bgHints: [{ x: 0.5, y: 0.7, fg: false }] });
  assert.equal(at(fixBg, 0.5, 0.7), 0, 'clicked subject became background');
  checkSeg(fixBg);
});

// ---- texture and zoom ---------------------------------------------------------------------------

// Sky over a lawn of thin, high-contrast "blades" of grass.
function lawn(w = 240, h = 180, seed = 5) {
  const rand = DC.rng(seed);
  const blade = new Float32Array(w * h);
  for (let k = 0; k < 900; k++) { // short slanted strokes
    let x = rand() * w, y = h * 0.35 + rand() * h * 0.65;
    const dx = (rand() - 0.5) * 0.6, len = 6 + rand() * 10, v = rand() < 0.5 ? 1 : -1;
    for (let t = 0; t < len; t++, x += dx, y -= 1) {
      const xi = Math.round(x), yi = Math.round(y);
      if (xi >= 0 && xi < w && yi >= 0 && yi < h) blade[yi * w + xi] = v;
    }
  }
  return makeImg(w, h, (x, y) => {
    if (y < h * 0.35) return [150, 190, 235];
    const b = blade[y * w + x];
    return b > 0 ? [120, 200, 70] : b < 0 ? [25, 80, 20] : [60, 140, 45];
  });
}

test('simplify: texture flattens blades of grass into a few big shapes', () => {
  const img = lawn();
  const grassRegions = (seg) => {
    const ids = new Set();
    for (let y = Math.ceil(seg.height * 0.45); y < seg.height; y++) for (let x = 0; x < seg.width; x++) ids.add(seg.region[y * seg.width + x]);
    return ids.size;
  };
  const off = DS.simplify(img, { texture: 0, featurePx: 3, detail: 0.7 });
  const on = DS.simplify(img, { texture: 0.7, featurePx: 3, detail: 0.7 });
  checkSeg(on);
  assert.ok(grassRegions(on) * 2 <= grassRegions(off), `grass regions ${grassRegions(on)} vs ${grassRegions(off)}`);
  // The sky/grass edge is kept: the sky is still its own color.
  const at = (s, u, v) => s.palette[s.index[Math.floor(v * s.height) * s.width + Math.floor(u * s.width)]];
  assert.ok(DC.deltaE76(at(on, 0.5, 0.1).lab, at(on, 0.5, 0.8).lab) > 20, 'sky and grass stay apart');
});

test('simplify: texture spares a face (eyes and mouth stay)', () => {
  const img = scene(320, 240);
  const seg = DS.simplify(img, { texture: 1, lines: 0.5, featurePx: 3 });
  checkSeg(seg);
  const at = (u, v) => seg.palette[seg.index[Math.floor(v * seg.height) * seg.width + Math.floor(u * seg.width)]];
  assert.ok(at(0.44, 0.4).lab[0] < 40, 'left eye still dark');
  assert.ok(at(0.56, 0.4).lab[0] < 40, 'right eye still dark');
});

test('simplify: remove + zoom crops to the subject and fills the page with it', () => {
  // A small pet in the middle of a big, busy background.
  const small = petScene(240, 240);
  const W = 480, H = 400;
  const img = makeImg(W, H, (x, y) => {
    const sx = x - 120, sy = y - 130;
    if (sx >= 0 && sx < 240 && sy >= 0 && sy < 240 && sy > 40) { // the pet part of the scene, minus its top
      const o = (sy * 240 + sx) * 4;
      const d = small.data;
      const u = sx / 240, v = sy / 240, dx = (u - 0.5) / 0.36, dy = (v - 0.72) / 0.6;
      if (dx * dx + dy * dy < 1) return [d[o], d[o + 1], d[o + 2]];
    }
    return (x % 30) < 3 ? [70, 40, 25] : [150 + 20 * Math.sin(y / 7), 95, 60];
  });
  const opts = { background: 'remove', featurePx: 4, lines: 0 };
  const flat = DS.simplify(img, opts);
  const zoomed = DS.simplify(img, Object.assign({ zoom: true, featurePxByAspect: [[0.5, 3], [1, 4], [2, 5]] }, opts));
  checkSeg(zoomed);
  assert.equal(flat.zoom, undefined);
  const z = zoomed.zoom;
  assert.ok(z && z.w < 0.8 && z.h < 0.9, 'cropped');
  assert.ok(z.x >= 0 && z.y >= 0 && z.x + z.w <= 1.0001 && z.y + z.h <= 1.0001, 'inside the picture');
  const share = (s) => { let f = 0; for (const v of s.subject) f += v; return f / s.subject.length; };
  assert.ok(share(zoomed) > share(flat) * 1.5, `subject share ${share(zoomed)} vs ${share(flat)}`);
  assert.equal(zoomed.subject.length, zoomed.width * zoomed.height);
  // Without remove, zoom does nothing.
  assert.equal(DS.simplify(img, { background: 'simplify', zoom: true, featurePx: 4 }).zoom, undefined);
});

test('subjectMask: a lawn under the subject is background, not part of it', () => {
  const grass = lawn(240, 180);
  const img = makeImg(240, 180, (x, y) => {
    const dx = (x - 120) / 55, dy = (y - 150) / 75;
    if (dx * dx + dy * dy < 1) {
      if (Math.hypot(x - 105, y - 110) < 5 || Math.hypot(x - 135, y - 110) < 5) return [30, 25, 25];
      return [235, 232, 228];
    }
    const o = (y * 240 + x) * 4;
    return [grass.data[o], grass.data[o + 1], grass.data[o + 2]];
  });
  const seg = DS.simplify(img, { background: 'remove', featurePx: 3, texture: 0.5 });
  const at = (u, v) => seg.subject[Math.floor(v * seg.height) * seg.width + Math.floor(u * seg.width)];
  for (const [u, v] of [[0.08, 0.6], [0.92, 0.6], [0.1, 0.95], [0.9, 0.95], [0.5, 0.42]]) assert.equal(at(u, v), 0, `lawn at ${u},${v}`);
  for (const [u, v] of [[0.5, 0.75], [0.5, 0.95], [0.42, 0.62]]) assert.equal(at(u, v), 1, `pet at ${u},${v}`);
});
