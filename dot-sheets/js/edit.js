/* Key edits on top of a segmentation: recolor a letter, or merge one letter into another.
 *
 * Edits are applied after simplify.js, so changing a color doesn't redo the picture. A merge (or
 * two letters ending up the same color) changes which pixels belong together, so regions are
 * re-labelled afterwards.
 *
 * Classic script: attaches to globalThis.DotEdit.
 */
(function (E) {
  'use strict';
  const DC = globalThis.DotColor || (typeof require === 'function' ? require('./color.js') : null);

  // 4-connected components of an index map. Returns { region, regions }.
  function relabel(width, height, index) {
    const n = width * height;
    const region = new Int32Array(n).fill(-1);
    const regions = [];
    const stack = new Int32Array(n);
    for (let start = 0; start < n; start++) {
      if (region[start] !== -1) continue;
      const id = regions.length, c = index[start];
      let sp = 0, area = 0;
      stack[sp++] = start; region[start] = id;
      while (sp) {
        const p = stack[--sp]; area++;
        const x = p % width;
        if (x > 0 && region[p - 1] === -1 && index[p - 1] === c) { region[p - 1] = id; stack[sp++] = p - 1; }
        if (x < width - 1 && region[p + 1] === -1 && index[p + 1] === c) { region[p + 1] = id; stack[sp++] = p + 1; }
        if (p >= width && region[p - width] === -1 && index[p - width] === c) { region[p - width] = id; stack[sp++] = p - width; }
        if (p < n - width && region[p + width] === -1 && index[p + width] === c) { region[p + width] = id; stack[sp++] = p + width; }
      }
      regions.push({ id, index: c, area });
    }
    return { region, regions };
  }

  /* seg: from DotSimplify.simplify. keyOf(entry) gives the key edits are stored under.
   * edits: { [key]: { hex?, name?, poolId?, mergeInto?: key } }
   * Returns a new seg (palette entries gain `key`, `edited`, `name`), plus `merged`: the keys that
   * were folded into another letter.
   */
  function apply(seg, edits, keyOf) {
    const pal = seg.palette.map(p => Object.assign({}, p, { key: keyOf(p) }));
    const byKey = new Map(pal.map((p, i) => [p.key, i]));
    // 1. Recolors.
    for (const p of pal) {
      const e = edits[p.key];
      if (e && e.hex && !p.paper) {
        p.hex = e.hex.toLowerCase();
        p.rgb = DC.hexToRgb(p.hex);
        p.lab = DC.hexToLab(p.hex);
        p.poolId = e.poolId == null ? null : e.poolId;
        p.edited = true;
        if (e.name) p.name = e.name;
      }
    }
    // 2. Merges: explicit ones, then any two entries that now share a color.
    const target = pal.map((_, i) => i);
    const find = i => { while (target[i] !== i) i = target[i] = target[target[i]]; return i; };
    pal.forEach((p, i) => {
      const e = edits[p.key];
      if (e && e.mergeInto != null && byKey.has(e.mergeInto)) {
        const j = find(byKey.get(e.mergeInto)), r = find(i);
        if (j !== r && !pal[j].paper && !p.paper) target[r] = j;
      }
    });
    const seen = new Map();
    pal.forEach((p, i) => {
      const r = find(i);
      const k = p.paper ? 'paper' : p.hex;
      if (seen.has(k) && find(seen.get(k)) !== r) target[r] = find(seen.get(k));
      else if (!seen.has(k)) seen.set(k, i);
    });
    const merged = [];
    pal.forEach((p, i) => { if (find(i) !== i) merged.push(p.key); });
    if (!merged.length && !pal.some(p => p.edited)) {
      return Object.assign({}, seg, { palette: pal, merged });
    }
    // 3. Rebuild: keep surviving entries in order, remap indices, recount areas, relabel.
    const keep = [], newIdx = new Int32Array(pal.length).fill(-1);
    pal.forEach((p, i) => { if (find(i) === i) { newIdx[i] = keep.length; keep.push(Object.assign({}, p, { area: 0 })); } });
    const map = pal.map((_, i) => newIdx[find(i)]);
    const index = new Uint8Array(seg.index.length);
    for (let k = 0; k < index.length; k++) { const v = map[seg.index[k]]; index[k] = v; keep[v].area++; }
    const { region, regions } = merged.length
      ? relabel(seg.width, seg.height, index)
      : { region: seg.region, regions: seg.regions.map(r => ({ id: r.id, index: map[r.index], area: r.area })) };
    const preview = new Uint8ClampedArray(index.length * 4);
    for (let k = 0; k < index.length; k++) {
      const c = keep[index[k]].rgb;
      preview[k * 4] = c[0]; preview[k * 4 + 1] = c[1]; preview[k * 4 + 2] = c[2]; preview[k * 4 + 3] = 255;
    }
    return { width: seg.width, height: seg.height, index, region, regions, palette: keep, preview, merged };
  }

  // A plain-English name for a color, for keys made in "match the picture" mode.
  function colorName(lab) {
    const [L, a, b] = lab;
    const C = Math.hypot(a, b);
    if (C < 8) {
      if (L > 90) return 'White';
      if (L > 70) return 'Light gray';
      if (L > 40) return 'Gray';
      if (L > 20) return 'Dark gray';
      return 'Black';
    }
    const h = (Math.atan2(b, a) * 180 / Math.PI + 360) % 360;
    // Hue angles in CIELAB: red ~25-40, orange ~55, yellow ~90, green ~145, teal ~185,
    // blue ~265, purple ~305, pink ~355.
    let base;
    if (h >= 330 || h < 15) base = L > 58 ? 'Pink' : h < 345 && h >= 330 ? 'Magenta' : 'Red';
    else if (h < 45) base = L > 75 ? 'Peach' : L < 42 && C < 50 ? 'Brown' : C > 50 ? 'Red' : 'Orange';
    else if (h < 75) base = L < 45 ? 'Brown' : L > 78 ? (h < 62 && C > 18 ? 'Peach' : 'Tan') : 'Orange';
    else if (h < 100) base = L < 55 ? 'Olive' : 'Yellow';
    else if (h < 135) base = L < 50 ? 'Olive' : 'Lime';
    else if (h < 175) base = 'Green';
    else if (h < 225) base = 'Teal';
    else if (h < 280) base = L > 70 ? 'Sky blue' : 'Blue';
    else if (h < 295) base = L > 65 ? 'Periwinkle' : 'Blue';
    else base = L > 65 ? 'Lavender' : 'Purple';
    if (L > 84 && !/Pink|Peach|Tan|Lavender|Periwinkle|Yellow/.test(base)) return 'Pale ' + base.toLowerCase();
    if (L < 30 && !/Brown|Olive/.test(base)) return 'Dark ' + base.toLowerCase();
    return base;
  }

  Object.assign(E, { relabel, apply, colorName });
})(typeof globalThis.DotEdit === 'object' ? globalThis.DotEdit : (globalThis.DotEdit = {}));

if (typeof module === 'object' && module.exports) module.exports = globalThis.DotEdit;
