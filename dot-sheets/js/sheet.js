/* The printable page, as an SVG string in millimetres.
 *
 * `geometry` decides where the header (title and key), the picture and the footer go on the paper.
 * `build` draws the page from what layout.js placed. It never measures text in a browser, so the
 * same function runs in Node tests and is the same at any zoom. The page is vector, so it prints
 * crisply on any printer and stays small for an old USB printer to swallow.
 *
 * Classic script: attaches to globalThis.DotSheet.
 */
(function (S) {
  'use strict';

  const PAGES = {
    letter: { w: 215.9, h: 279.4, label: 'US Letter' },
    a4: { w: 210, h: 297, label: 'A4' },
    legal: { w: 215.9, h: 355.6, label: 'US Legal' },
  };

  const FONT = "Arial, Helvetica, 'Liberation Sans', sans-serif";

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  const r2 = v => Math.round(v * 100) / 100;

  // Key layout: entries per row and rows, for n entries across width w.
  function keyGrid(n, w) {
    const minCell = 22; // mm: a test circle plus a short color name
    const perRow = Math.max(1, Math.min(n, Math.floor(w / minCell)));
    const rows = Math.ceil(n / perRow);
    // Balance rows: 10 entries on 2 rows go 5 + 5, not 8 + 2.
    const balanced = Math.ceil(n / rows);
    return { perRow: balanced, rows, cell: w / balanced };
  }

  const KEY_ROW = 15;   // mm per key row: circle + name
  const TITLE_H = 9;    // mm for the title line
  const FOOT_H = 6;     // mm for the footer (ruler + credit)
  const GAP = 4;        // mm between blocks

  /* Where everything goes.
   *   paper: 'letter' | 'a4' | 'legal'; orientation: 'portrait' | 'landscape' | 'auto'
   *   margin: mm (an older printer can't reach the last ~6 mm of the sheet, so keep it >= 8)
   *   aspect: picture width / height; keyCount: entries in the key; title: bool; footer: bool
   */
  function geometry(o) {
    const base = PAGES[o.paper] || PAGES.letter;
    let orient = o.orientation || 'auto';
    if (orient === 'auto') orient = (o.aspect || 1) > 1.15 ? 'landscape' : 'portrait';
    const pw = orient === 'landscape' ? base.h : base.w;
    const ph = orient === 'landscape' ? base.w : base.h;
    const m = o.margin == null ? 12.7 : o.margin;
    const cw = pw - 2 * m;
    const kg = keyGrid(Math.max(1, o.keyCount || 1), cw);
    let y = m;
    const titleY = y;
    if (o.title) y += TITLE_H;
    const keyY = y;
    y += kg.rows * KEY_ROW + GAP;
    const footH = o.footer === false ? 0 : FOOT_H;
    const availH = ph - m - footH - (footH ? GAP / 2 : 0) - y;
    const aspect = o.aspect || 1;
    let iw = cw, ih = cw / aspect;
    if (ih > availH) { ih = availH; iw = ih * aspect; }
    const ix = m + (cw - iw) / 2;
    const iy = y + (availH - ih) / 2;
    return {
      page: { w: pw, h: ph, orientation: orient, paper: o.paper || 'letter' },
      margin: m,
      content: { x: m, y: m, w: cw, h: ph - 2 * m },
      title: o.title ? { x: m, y: titleY, w: cw, h: TITLE_H } : null,
      key: { x: m, y: keyY, w: cw, rows: kg.rows, perRow: kg.perRow, cell: kg.cell },
      image: { x: ix, y: iy, w: iw, h: ih },
      footer: footH ? { x: m, y: ph - m - footH, w: cw, h: footH } : null,
    };
  }

  // Font size (mm) for a letter inside a dot of radius r (mm). Bold caps are ~0.72 em tall.
  function letterFont(r) { return r * 1.3; }

  function keySvg(g, key, o) {
    const out = [];
    const { x, y, cell, perRow } = g.key;
    // Like the kits: a circle you dot with the marker you pick, then the letter it stands for.
    // A color printer fills the circle in (the plan); black-and-white leaves it blank to test-dot.
    const circleR = 3;
    key.forEach((k, i) => {
      const row = Math.floor(i / perRow), col = i % perRow;
      const rowCount = Math.min(perRow, key.length - row * perRow);
      const x0 = x + (perRow - rowCount) * cell / 2; // center a short last row
      const cx = x0 + col * cell + cell / 2 - 3.2;
      const cy = y + row * KEY_ROW + circleR + 1;
      const filled = o.view === 'finished' || o.printer === 'color';
      out.push(filled
        ? `<circle cx="${r2(cx)}" cy="${r2(cy)}" r="${circleR}" fill="${k.hex}" stroke="#555" stroke-width="0.2"/>`
        : `<circle cx="${r2(cx)}" cy="${r2(cy)}" r="${circleR}" fill="none" stroke="#555" stroke-width="0.3"/>`);
      out.push(`<text x="${r2(cx + circleR + 1.3)}" y="${r2(cy)}" dy="0.36em" font-size="4.6" font-weight="700" fill="#333">${esc(k.letter)}</text>`);
      if (k.name) {
        const maxChars = Math.max(6, Math.floor(cell / 1.35));
        const name = k.name.length > maxChars ? k.name.slice(0, maxChars - 1) + '…' : k.name;
        out.push(`<text x="${r2(cx + 2)}" y="${r2(cy + circleR + 3.6)}" text-anchor="middle" font-size="2.4" fill="#444">${esc(name)}</text>`);
      }
    });
    return out.join('');
  }

  function footerSvg(g, o) {
    if (!g.footer) return '';
    const { x, y, w, h } = g.footer;
    const by = y + h - 1.2;
    const out = [];
    // A 50 mm ruler: if it doesn't measure 50 mm on paper, the print was scaled.
    out.push(`<g stroke="#777" stroke-width="0.25" fill="none"><path d="M${r2(x)} ${r2(by)}h50M${r2(x)} ${r2(by - 1.6)}v1.6M${r2(x + 50)} ${r2(by - 1.6)}v1.6`);
    for (let t = 10; t < 50; t += 10) out.push(`M${r2(x + t)} ${r2(by - 0.9)}v0.9`);
    out.push(`"/></g>`);
    out.push(`<text x="${r2(x + 52)}" y="${r2(by)}" font-size="2.3" fill="#777">50 mm: if this line is shorter or longer, print at 100% / actual size</text>`);
    if (o.credit) out.push(`<text x="${r2(x + w)}" y="${r2(by)}" text-anchor="end" font-size="2.3" fill="#999">${esc(o.credit)}</text>`);
    return out.join('');
  }

  /* Build the page.
   * o: {
   *   geometry,                 // from geometry()
   *   key: [{letter, hex, name, ink}] indexed by palette index (null for paper / unused)
   *   mode: 'dots' | 'fill', view: 'print' | 'finished', printer: 'color' | 'mono'
   *   dots: [{x, y, s, c}], sizes: [r mm...]     (mode 'dots')
   *   labels: [{x, y, size, c}]                   (mode 'fill', and 'dots' never)
   *   outlines: path d string in image mm         (mode 'fill', or dots with guides)
   *   guides: bool              // faint region outlines under the dots
   *   rings: bool               // a hairline ring showing each dot's size
   *   letterInk: '#hex'         // letter color; lighter saves toner and hides under the ink
   *   title, credit, seed
   *   fillPreview: Uint8ClampedArray-backed data URL for 'fill' finished view (optional)
   * }
   */
  function build(o) {
    const g = o.geometry;
    const { w: pw, h: ph } = g.page;
    const ink = o.letterInk || '#6f6f6f';
    const keyList = o.key.map((k, i) => k && Object.assign({ index: i }, k)).filter(Boolean);
    const parts = [];
    parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${pw}mm" height="${ph}mm" viewBox="0 0 ${pw} ${ph}" font-family="${FONT}">`);
    parts.push(`<rect width="${pw}" height="${ph}" fill="#fff"/>`);

    if (g.title && o.title) {
      parts.push(`<text x="${r2(g.title.x)}" y="${r2(g.title.y + 5.6)}" font-size="5.6" font-weight="700" fill="#222">${esc(o.title)}</text>`);
      const hint = o.mode === 'fill'
        ? 'Color each shape with the marker for its letter.'
        : 'Cover each letter with a dot: press firmly for big letters, tap lightly for small ones.';
      parts.push(`<text x="${r2(g.title.x + g.title.w)}" y="${r2(g.title.y + 5.6)}" text-anchor="end" font-size="2.6" fill="#555">${esc(hint)}</text>`);
    }
    parts.push(keySvg(g, keyList, { printer: o.printer, view: o.view, letterInk: ink }));

    const im = g.image;
    parts.push(`<g transform="translate(${r2(im.x)} ${r2(im.y)})">`);
    if (o.view === 'finished') parts.push(finishedSvg(o, im));
    else if (o.mode === 'fill') parts.push(fillSvg(o, ink));
    else parts.push(dotsSvg(o, ink));
    parts.push(`</g>`);

    parts.push(footerSvg(g, o));
    parts.push(`</svg>`);
    return parts.join('');
  }

  function dotsSvg(o, ink) {
    const out = [];
    if (o.guides && o.outlines) {
      out.push(`<path d="${o.outlines}" fill="none" stroke="#c9c9c9" stroke-width="0.18" stroke-linejoin="round" stroke-linecap="round"/>`);
    }
    // Group letters by size so each <text> carries only x, y and the letter.
    const bySize = new Map();
    for (const d of o.dots) {
      if (!o.key[d.c]) continue;
      if (!bySize.has(d.s)) bySize.set(d.s, []);
      bySize.get(d.s).push(d);
    }
    for (const [s, list] of [...bySize.entries()].sort((a, b) => a[0] - b[0])) {
      const r = o.sizes[s];
      if (o.rings) {
        out.push(`<g fill="none" stroke="#d6d6d6" stroke-width="0.12">`);
        for (const d of list) out.push(`<circle cx="${r2(d.x)}" cy="${r2(d.y)}" r="${r2(r)}"/>`);
        out.push(`</g>`);
      }
      out.push(`<g font-size="${r2(letterFont(r))}" font-weight="700" text-anchor="middle" fill="${ink}">`);
      for (const d of list) out.push(`<text x="${r2(d.x)}" y="${r2(d.y)}" dy="0.36em">${esc(o.key[d.c].letter)}</text>`);
      out.push(`</g>`);
    }
    return out.join('');
  }

  function fillSvg(o, ink) {
    const out = [];
    if (o.outlines) out.push(`<path d="${o.outlines}" fill="none" stroke="#3a3a3a" stroke-width="0.32" stroke-linejoin="round" stroke-linecap="round"/>`);
    const im = o.geometry.image;
    out.push(`<rect width="${r2(im.w)}" height="${r2(im.h)}" fill="none" stroke="#3a3a3a" stroke-width="0.4"/>`);
    const bySize = new Map();
    for (const l of o.labels || []) {
      if (!o.key[l.c]) continue;
      const k = r2(l.size);
      if (!bySize.has(k)) bySize.set(k, []);
      bySize.get(k).push(l);
    }
    for (const [size, list] of bySize) {
      out.push(`<g font-size="${size}" font-weight="700" text-anchor="middle" fill="${ink}">`);
      for (const l of list) out.push(`<text x="${r2(l.x)}" y="${r2(l.y)}" dy="0.36em">${esc(o.key[l.c].letter)}</text>`);
      out.push(`</g>`);
    }
    return out.join('');
  }

  // The finished picture as it would look once every letter is dotted (or every shape filled).
  function finishedSvg(o, im) {
    const out = [];
    if (o.mode === 'fill') {
      if (o.fillPreview) out.push(`<image href="${o.fillPreview}" width="${r2(im.w)}" height="${r2(im.h)}" preserveAspectRatio="none" style="image-rendering:auto"/>`);
      if (o.outlines) out.push(`<path d="${o.outlines}" fill="none" stroke="#3a3a3a" stroke-width="0.32" stroke-linejoin="round"/>`);
      return out.join('');
    }
    // Real marker dots are a touch smaller or larger than the letter and never perfectly round.
    let s = (o.seed || 1) >>> 0;
    const rnd = () => { s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6D2B79F5) >>> 0; return (s >>> 8) / 16777216; };
    const byColor = new Map();
    for (const d of o.dots) {
      if (!o.key[d.c]) continue;
      if (!byColor.has(d.c)) byColor.set(d.c, []);
      byColor.get(d.c).push(d);
    }
    for (const [c, list] of byColor) {
      out.push(`<g fill="${o.key[c].hex}" fill-opacity="0.93">`);
      for (const d of list) {
        const r = o.sizes[d.s] * (1.02 + (rnd() - 0.5) * 0.12);
        const jx = (rnd() - 0.5) * 0.25, jy = (rnd() - 0.5) * 0.25;
        out.push(`<circle cx="${r2(d.x + jx)}" cy="${r2(d.y + jy)}" r="${r2(r)}"/>`);
      }
      out.push(`</g>`);
    }
    return out.join('');
  }

  Object.assign(S, { PAGES, geometry, build, letterFont, keyGrid });
})(typeof globalThis.DotSheet === 'object' ? globalThis.DotSheet : (globalThis.DotSheet = {}));

if (typeof module === 'object' && module.exports) module.exports = globalThis.DotSheet;
