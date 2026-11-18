'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const DC = require('../js/color.js');
const DotSheet = require('../js/sheet.js');
const DotEdit = require('../js/edit.js');
const DotPalettes = require('../js/palettes.js');

test('color: hex and Lab round-trip', () => {
  for (const hex of ['#000000', '#ffffff', '#765fa8', '#f5863e', '#43c0b2', '#080a09']) {
    assert.equal(DC.labToHex(DC.hexToLab(hex)), hex);
  }
  assert.deepEqual(DC.hexToRgb('#abc'), [0xaa, 0xbb, 0xcc]);
  assert.throws(() => DC.hexToRgb('nope'));
});

test('color: CIEDE2000 matches published test pairs (Sharma et al.)', () => {
  const pairs = [
    [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
    [[50, 2.5, 0], [73, 25, -18], 27.1492],
    [[50, 2.5, 0], [50, 3.2592, 0.335], 1.0],
    [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
  ];
  for (const [p, q, want] of pairs) assert.ok(Math.abs(DC.deltaE2000(p, q) - want) < 1e-3, `${p} vs ${q}`);
});

test('color: inkOn picks readable text', () => {
  assert.equal(DC.inkOn('#ffffff'), '#111111');
  assert.equal(DC.inkOn('#080a09'), '#ffffff');
});

test('palettes: every kit has 8 valid, distinct colors and the kits have unique ids', () => {
  const ids = new Set();
  for (const set of DotPalettes.SETS) {
    assert.ok(!ids.has(set.id), set.id);
    ids.add(set.id);
    assert.equal(set.colors.length, set.line === 'Mini Express' ? 5 : 8, set.name);
    const letters = set.colors.map(c => c.letter).filter(Boolean);
    assert.equal(new Set(letters).size, letters.length, `${set.name}: letters are unique`);
    if (set.line === 'Mini Express') assert.equal(letters.length, 5, `${set.name}: every marker has its letter`);
    const labs = set.colors.map(c => DC.hexToLab(c.hex));
    for (let i = 0; i < labs.length; i++) {
      assert.ok(set.colors[i].name, `${set.name} color ${i} has a name`);
      for (let j = i + 1; j < labs.length; j++) {
        assert.ok(DC.deltaE2000(labs[i], labs[j]) > 5, `${set.name}: ${set.colors[i].name} vs ${set.colors[j].name}`);
      }
    }
  }
  assert.deepEqual(DotPalettes.LETTERS.flowart.slice(0, 8), ['B', 'D', 'F', 'G', 'H', 'V', 'X', 'Z']);
  assert.equal(new Set(DotPalettes.LETTERS.flowart).size, DotPalettes.LETTERS.flowart.length);
});

test('geometry: the picture fits inside the margins, below the key, above the footer', () => {
  for (const paper of ['letter', 'a4', 'legal']) {
    for (const aspect of [0.5, 0.77, 1, 1.4, 2.5]) {
      for (const keyCount of [2, 8, 16]) {
        const g = DotSheet.geometry({ paper, orientation: 'auto', margin: 12.7, aspect, keyCount, title: true, footer: true });
        const im = g.image;
        assert.ok(im.x >= g.margin - 1e-9 && im.x + im.w <= g.page.w - g.margin + 1e-9, 'inside left/right');
        assert.ok(im.y >= g.key.y + g.key.rows * 15 - 1e-9, 'below the key');
        assert.ok(im.y + im.h <= g.footer.y + 1e-9, 'above the footer');
        assert.ok(Math.abs(im.w / im.h - aspect) < 1e-6, 'aspect kept');
      }
    }
  }
  assert.equal(DotSheet.geometry({ paper: 'letter', aspect: 1.6 }).page.orientation, 'landscape');
  assert.equal(DotSheet.geometry({ paper: 'letter', aspect: 0.8 }).page.orientation, 'portrait');
  const l = DotSheet.geometry({ paper: 'letter', orientation: 'landscape', aspect: 1 });
  assert.equal(l.page.w, 279.4);
});

test('key grid: rows are balanced', () => {
  const g = DotSheet.keyGrid(10, 190);
  assert.equal(g.rows, 2);
  assert.equal(g.perRow, 5);
  assert.equal(DotSheet.keyGrid(8, 190).rows, 1);
});

function sample(mode, view) {
  const geometry = DotSheet.geometry({ paper: 'letter', aspect: 0.8, keyCount: 2, title: true, footer: true });
  return DotSheet.build({
    geometry, mode, view, printer: 'mono', letterInk: '#777',
    key: [{ letter: 'B', hex: '#ff0000', name: 'Red' }, null, { letter: 'D', hex: '#0000ff', name: 'Blue & <Co>' }],
    dots: [{ x: 10, y: 10, s: 0, c: 0 }, { x: 20, y: 10, s: 2, c: 2 }, { x: 30, y: 10, s: 1, c: 1 }],
    sizes: [1.2, 1.7, 2.2],
    labels: [{ x: 5, y: 5, size: 3, c: 0 }],
    outlines: 'M0 0L10 10', title: 'My <page>', credit: 'x',
  });
}

test('build: dots page has one letter per inked dot, skips paper, escapes text', () => {
  const svg = sample('dots', 'print');
  assert.match(svg, /^<svg[^>]+width="215.9mm" height="279.4mm"/);
  const letters = svg.match(/<text x="[\d.]+" y="[\d.]+" dy="0.36em">[BD]<\/text>/g);
  assert.equal(letters.length, 2); // the dot on palette index 1 (paper) is skipped
  assert.ok(svg.includes('My &lt;page&gt;'));
  assert.ok(svg.includes('Blue &amp; &lt;Co&gt;'));
  assert.ok(!svg.includes('<Co>'));
  assert.ok(svg.includes('50 mm'), 'scale ruler present');
});

test('build: finished view draws colored circles, fill mode draws outlines and labels', () => {
  const fin = sample('dots', 'finished');
  assert.equal((fin.match(/<circle cx="[\d.]+" cy="[\d.]+" r="[\d.]+"\/>/g) || []).length, 2);
  assert.ok(fin.includes('fill="#ff0000"'));
  const fill = sample('fill', 'print');
  assert.ok(fill.includes('d="M0 0L10 10"'));
  assert.equal((fill.match(/dy="0.36em"[^>]*>B<\/text>/g) || []).length, 2); // key + one label
});

test('build: a long title shrinks to fit and drops the hint rather than overlapping it', () => {
  const page = (title, compact) => {
    const geometry = compact
      ? DotSheet.geometry({ size: DotSheet.MINI, margins: DotSheet.miniMargins(0, false, 12.7), compact: true, aspect: 1, keyCount: 5, title: true })
      : DotSheet.geometry({ paper: 'letter', aspect: 0.8, keyCount: 2, title: true, footer: true });
    const svg = DotSheet.build({ geometry, mode: 'dots', view: 'print', printer: 'mono', key: [], dots: [], sizes: [1], title });
    const fs = +svg.match(/font-size="([\d.]+)" font-weight="700" fill="#222"/)[1];
    return { geometry, fs, hint: svg.includes('Cover each letter') };
  };
  const short = page('Rex');
  assert.equal(short.fs, 5.6);
  assert.ok(short.hint, 'a short title keeps the hint');
  const mid = page('Chelsea the cat on the rug by the window');
  assert.equal(mid.fs, 5.6);
  assert.ok(!mid.hint, 'no room for the hint next to a 40-character title');
  const long = 'W'.repeat(60);
  const full = page(long), mini = page(long, true);
  assert.ok(60 * 0.74 * full.fs <= full.geometry.title.w + 1e-6, 'full-page title inside the margins');
  assert.ok(60 * 0.74 * mini.fs <= mini.geometry.title.w + 1e-6, 'mini title inside its page');
  assert.ok(!mini.hint);
});

test('build: the same input gives the same page', () => {
  assert.equal(sample('dots', 'finished'), sample('dots', 'finished'));
});

function fakeSeg() {
  // 4x2: left half red, right half blue; top-right pixel green.
  const w = 4, h = 2;
  const index = Uint8Array.from([0, 0, 1, 2, 0, 0, 1, 1]);
  const pal = [
    { hex: '#ff0000', rgb: [255, 0, 0], lab: DC.hexToLab('#ff0000'), area: 4, paper: false, poolId: 'k:0' },
    { hex: '#0000ff', rgb: [0, 0, 255], lab: DC.hexToLab('#0000ff'), area: 3, paper: false, poolId: 'k:1' },
    { hex: '#00ff00', rgb: [0, 255, 0], lab: DC.hexToLab('#00ff00'), area: 1, paper: false, poolId: 'k:2' },
  ];
  const { region, regions } = DotEdit.relabel(w, h, index);
  return { width: w, height: h, index, region, regions, palette: pal, preview: new Uint8ClampedArray(w * h * 4) };
}
const keyOf = p => p.poolId || p.hex;

test('edit: relabel finds 4-connected components', () => {
  const { regions, region } = DotEdit.relabel(3, 3, Uint8Array.from([0, 1, 0, 1, 1, 1, 0, 1, 0]));
  assert.equal(regions.length, 5); // four corners + the plus sign
  assert.equal(new Set(region).size, 5);
});

test('edit: no edits leaves the maps alone', () => {
  const s = fakeSeg();
  const e = DotEdit.apply(s, {}, keyOf);
  assert.equal(e.index, s.index);
  assert.deepEqual(e.palette.map(p => p.key), ['k:0', 'k:1', 'k:2']);
});

test('edit: recolor changes the color only; merge folds a letter in and relabels', () => {
  const s = fakeSeg();
  const r = DotEdit.apply(s, { 'k:1': { hex: '#123456', name: 'Navy' } }, keyOf);
  assert.equal(r.palette[1].hex, '#123456');
  assert.equal(r.palette[1].name, 'Navy');
  assert.equal(r.palette.length, 3);

  const m = DotEdit.apply(s, { 'k:2': { mergeInto: 'k:1' } }, keyOf);
  assert.equal(m.palette.length, 2);
  assert.deepEqual(m.merged, ['k:2']);
  assert.deepEqual([...m.index], [0, 0, 1, 1, 0, 0, 1, 1]);
  assert.equal(m.regions.length, 2);
  assert.equal(m.palette[1].area, 4);
});

test('edit: two letters recolored to the same color become one', () => {
  const s = fakeSeg();
  const m = DotEdit.apply(s, { 'k:0': { hex: '#0000ff' } }, keyOf);
  assert.equal(m.palette.length, 2);
  assert.equal(m.regions.length, 2); // blue now spans columns 0-2, green alone
  assert.equal(m.palette[0].area, 7);
});

test('edit: colorName gives sensible names', () => {
  const n = hex => DotEdit.colorName(DC.hexToLab(hex));
  assert.equal(n('#ffffff'), 'White');
  assert.equal(n('#000000'), 'Black');
  assert.equal(n('#cb212e'), 'Red');
  assert.equal(n('#26b158'), 'Green');
  assert.equal(n('#2c86c8'), 'Blue');
  assert.equal(n('#5f422f'), 'Brown');
});

test('mini sheet: four cells tile a Letter page; outer edges keep the printer margin', () => {
  const cells = DotSheet.miniCells(12.7);
  assert.equal(cells.length, 4);
  assert.ok(Math.abs(DotSheet.MINI.w * 2 - 215.9) < 1e-9 && Math.abs(DotSheet.MINI.h * 2 - 279.4) < 1e-9);
  assert.deepEqual(cells[0].margins, { t: 12.7, b: 6, l: 12.7, r: 6 });
  assert.deepEqual(cells[3].margins, { t: 6, b: 12.7, l: 6, r: 12.7 });
  // Rotated pages: the page's top is the cell's right edge.
  assert.deepEqual(DotSheet.miniMargins(1, true, 12.7), { t: 12.7, r: 6, b: 6, l: 12.7 });
});

test('mini sheet: a landscape page is rotated into its cell, empty cells are skipped', () => {
  const M = DotSheet.MINI;
  const mk = (i, wide) => ({
    geometry: DotSheet.geometry({ size: wide ? { w: M.h, h: M.w } : M, margins: DotSheet.miniMargins(i, wide, 12.7), compact: true, aspect: wide ? 1.5 : 0.8, keyCount: 5 }),
    key: [{ letter: 'F', hex: '#f00', name: 'Red' }], mode: 'dots', view: 'print', printer: 'mono',
    dots: [{ x: 1, y: 1, s: 0, c: 0 }], sizes: [1],
  });
  const svg = DotSheet.sheet4([mk(0, false), null, mk(2, true), null], { margin: 12.7, ruler: true });
  assert.match(svg, /^<svg[^>]+width="215.9mm" height="279.4mm"/);
  assert.equal((svg.match(/rotate\(90\)/g) || []).length, 1);
  assert.equal((svg.match(/>F<\/text>/g) || []).length, 4); // a key letter + one dot on each page
  assert.ok(svg.includes('stroke-dasharray'), 'cut lines');
  for (const i of [0, 2]) {
    const g = mk(i, i === 2).geometry;
    assert.ok(g.image.x >= g.content.x - 1e-9 && g.image.x + g.image.w <= g.page.w - 6 + 1e-9);
  }
});
