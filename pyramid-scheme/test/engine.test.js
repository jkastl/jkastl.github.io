const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
require(path.join(__dirname, '..', '..', 'shared', 'tissue.js'));
require(path.join(__dirname, '..', 'js', 'engine.js'));
const T = globalThis.Tissue, PS = globalThis.PS;

const slide = T.makeSlide(PS.CONFIG.seed);

test('the same tile renders byte for byte the same every time', () => {
  const a = T.render(slide, 9000, 7000, 64, 64, 0.5);
  const b = T.render(T.makeSlide(PS.CONFIG.seed), 9000, 7000, 64, 64, 0.5);
  assert.deepEqual(a, b);
  const c = T.render(T.makeSlide(PS.CONFIG.seed + 1), 9000, 7000, 64, 64, 0.5);
  assert.notDeepEqual(a, c);
});

test('zoomed out looks like the zoomed-in pixels averaged', () => {
  // Average a full-resolution patch down and compare it with the same area rendered coarse.
  const f = slide.fragments[0];
  const fine = T.render(slide, f.cx, f.cy, 256, 256, 0.25);
  const coarse = T.render(slide, f.cx, f.cy, 4, 4, 16);
  const mean = (d) => { let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2]; return s / (d.length / 4) / 3; };
  assert.ok(Math.abs(mean(fine) - mean(coarse)) < 18, `fine ${mean(fine)} vs coarse ${mean(coarse)}`);
});

test('levels halve until the slide fits in one tile', () => {
  const lv = PS.levels(slide);
  assert.equal(lv[0].width, 96000);
  assert.equal(lv[0].height, 64000);
  assert.equal(lv[0].tiles, 375 * 250);
  for (let i = 1; i < lv.length; i++) assert.equal(lv[i].width, Math.ceil(lv[i - 1].width / 2));
  const top = lv[lv.length - 1];
  assert.equal(top.tiles, 1);
  assert.equal(lv.length, 10);
  // Everything above level 0 adds about a third, never more.
  const above = lv.slice(1).reduce((a, l) => a + l.tiles, 0);
  assert.ok(above / lv[0].tiles < 1 / 3 + 0.01);
});

test('chooseLevel picks the coarsest level that is still sharp', () => {
  const lv = PS.levels(slide);
  assert.equal(PS.chooseLevel(lv, 0.1), 0);
  assert.equal(PS.chooseLevel(lv, 0.25), 0);
  assert.equal(PS.chooseLevel(lv, 0.49), 0);
  assert.equal(PS.chooseLevel(lv, 0.5), 1);
  assert.equal(PS.chooseLevel(lv, 3), 3);
  assert.equal(PS.chooseLevel(lv, 1e6), lv.length - 1);
});

test('tilesInView covers the view, stays on the slide and starts in the middle', () => {
  const lv = PS.levels(slide)[2]; // 1 µm/px, 256 µm tiles
  const t = PS.tilesInView(lv, 1000, 1000, 2000, 1500);
  const cols = new Set(t.map((x) => x.col)), rows = new Set(t.map((x) => x.row));
  assert.deepEqual([...cols].sort((a, b) => a - b), [3, 4, 5, 6, 7]);
  assert.deepEqual([...rows].sort((a, b) => a - b), [3, 4, 5]);
  assert.equal(t[0].col, 5);
  assert.equal(t[0].row, 4);
  const edge = PS.tilesInView(lv, -500, -500, 100, 100);
  assert.ok(edge.every((x) => x.col >= 0 && x.row >= 0));
});

test('the LRU cache evicts the least recently used tile', () => {
  const c = new PS.LRU(2);
  c.set('a', 1);
  c.set('b', 2);
  c.get('a');
  c.set('c', 3);
  assert.equal(c.has('b'), false);
  assert.equal(c.has('a'), true);
  assert.equal(c.evictions, 1);
  assert.equal(c.get('zzz'), undefined);
  assert.equal(c.misses, 1);
});

test('the file size estimate is in the range real scans land in', () => {
  const s = PS.fileSize(slide);
  assert.ok(s.total > 400e6 && s.total < 2e9, PS.fmtBytes(s.total));
  assert.ok(s.perLevel[0] / s.total > 0.7);
});

test('Otsu splits a two-humped histogram between the humps', () => {
  const h = new Array(256).fill(0);
  for (let i = 20; i < 40; i++) h[i] = 100;
  for (let i = 150; i < 170; i++) h[i] = 30;
  const t = PS.otsu(h);
  assert.ok(t >= 39 && t < 150, `threshold ${t}`);
});

test('ink is ink and stain is not', () => {
  const px = [0, 0, 0];
  assert.equal(PS.isInk(...T.toRgb(0, 0, 1.1, T.STAIN_REF, px)), true);
  assert.equal(PS.isInk(...T.toRgb(0.9, 0.2, 0, T.STAIN_REF, px)), false); // a dark nucleus
  assert.equal(PS.isInk(...T.toRgb(0.05, 0.35, 0, T.STAIN_REF, px)), false); // stroma
  assert.equal(PS.isInk(...T.toRgb(0, 0, 0, T.STAIN_REF, px)), false); // glass
});

test('patching: the pen circle gets in until ink is dropped', () => {
  const ps = 64;
  const w = Math.round(slide.widthUm / ps), h = Math.round(slide.heightUm / ps);
  const img = T.render(slide, 0, 0, w, h, ps);
  for (const method of ['saturation', 'brightness']) {
    const raw = PS.patchStats(PS.patches(slide, PS.tissueMask(img, w, h, { method }).mask, w, h, ps, 256, 0.5));
    const clean = PS.patchStats(PS.patches(slide, PS.tissueMask(img, w, h, { method, removeInk: true }).mask, w, h, ps, 256, 0.5));
    assert.ok(raw.inkJunk > 10, `${method}: ${raw.inkJunk} ink patches without the filter`);
    assert.ok(clean.inkJunk < raw.inkJunk / 5, `${method}: ${clean.inkJunk} ink patches with the filter`);
    assert.ok(clean.kept > 500);
    // Most of the grid is glass.
    const grid = Math.floor(slide.widthUm / 256) * Math.floor(slide.heightUm / 256);
    assert.ok(clean.kept / grid < 0.5);
  }
});

test('manifest rows point into level-0 coordinates', () => {
  const rows = PS.manifest('S1', [{ x: 128, y: 256, frac: 0.75, kept: true }, { x: 0, y: 0, frac: 0.1, kept: false }], 128, 1);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { slide_id: 'S1', patch_id: 'S1-00000', level: 1, x: 512, y: 1024, size_px: 256, tissue_frac: 0.75 });
  assert.equal(PS.toCsv(rows), 'slide_id,patch_id,level,x,y,size_px,tissue_frac\nS1,S1-00000,1,512,1024,256,0.75\n');
});

test('scale: 20× is a quarter of 40×, and the numbers move the right way', () => {
  const base = { slidesPerDay: 1000, tissueMm2: 150, overscan: 2, mpp: 0.25, shiftHours: 16, years: 10 };
  const a = PS.scale(base), b = PS.scale({ ...base, mpp: 0.5 });
  assert.ok(Math.abs(a.bytesPerSlide / b.bytesPerSlide - 4) < 1e-9);
  assert.ok(a.bytesPerSlide > 0.5e9 && a.bytesPerSlide < 3e9);
  const c = PS.scale({ ...base, slidesPerDay: 2000 });
  assert.ok(Math.abs(c.bytesPerDay / a.bytesPerDay - 2) < 1e-9);
  assert.ok(a.manifestBytesPerDay < a.patchPngBytesPerDay / 1000);
});
