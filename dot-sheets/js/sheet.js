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

  // Header sizes (mm). A mini (quarter-sheet) page uses the compact set.
  const HEAD = {
    full: { keyRow: 15, title: 9, minCell: 22, circle: 3, letter: 4.6, name: 2.4, titleFont: 5.6, hint: 2.6 },
    compact: { keyRow: 10.5, title: 6.5, minCell: 15, circle: 2.3, letter: 3.6, name: 1.9, titleFont: 4, hint: 2 },
  };
  const FOOT_H = 6;     // mm for the footer (ruler + credit)
  const GAP = 4;        // mm between blocks
  // Rough width of a line of bold Arial, in em, without a browser to measure it.
  const textEm = s => [...String(s)].reduce((t, ch) => t + (ch === ' ' ? 0.28
    : /[A-Z0-9MWmw@&%]/.test(ch) ? 0.74 : /[fijlrt.,:;'!|()\-]/.test(ch) ? 0.36 : 0.62), 0);

  // Key layout: entries per row and rows, for n entries across width w.
  function keyGrid(n, w, minCell) {
    const perRow = Math.max(1, Math.min(n, Math.floor(w / (minCell || HEAD.full.minCell))));
    const rows = Math.ceil(n / perRow);
    // Balance rows: 10 entries on 2 rows go 5 + 5, not 8 + 2.
    const balanced = Math.ceil(n / rows);
    return { perRow: balanced, rows, cell: w / balanced };
  }

  // A US Letter sheet cut in four: each mini page is 4.25 x 5.5 in, like a FlowArt Mini pad.
  const MINI = { w: PAGES.letter.w / 2, h: PAGES.letter.h / 2 };

  /* Where everything goes.
   *   paper: 'letter' | 'a4' | 'legal'; orientation: 'portrait' | 'landscape' | 'auto'
   *   margin: mm (an older printer can't reach the last ~6 mm of the sheet, so keep it >= 8)
   *   aspect: picture width / height; keyCount: entries in the key; title: bool; footer: bool
   *   For a mini page instead: size: {w, h} and margins: {t, r, b, l}, plus compact: true.
   */
  function geometry(o) {
    let pw, ph, orient;
    if (o.size) {
      pw = o.size.w; ph = o.size.h; orient = pw > ph ? 'landscape' : 'portrait';
    } else {
      const base = PAGES[o.paper] || PAGES.letter;
      orient = o.orientation || 'auto';
      if (orient === 'auto') orient = (o.aspect || 1) > 1.15 ? 'landscape' : 'portrait';
      pw = orient === 'landscape' ? base.h : base.w;
      ph = orient === 'landscape' ? base.w : base.h;
    }
    const m = o.margin == null ? 12.7 : o.margin;
    const mg = o.margins || { t: m, r: m, b: m, l: m };
    const H = o.compact ? HEAD.compact : HEAD.full;
    const cw = pw - mg.l - mg.r;
    const kg = keyGrid(Math.max(1, o.keyCount || 1), cw, H.minCell);
    let y = mg.t;
    const titleY = y;
    if (o.title) y += H.title;
    const keyY = y;
    y += kg.rows * H.keyRow + (o.compact ? GAP / 2 : GAP);
    const footH = o.footer ? FOOT_H : 0;
    const availH = ph - mg.b - footH - (footH ? GAP / 2 : 0) - y;
    const aspect = o.aspect || 1;
    let iw = cw, ih = cw / aspect;
    if (ih > availH) { ih = availH; iw = ih * aspect; }
    const ix = mg.l + (cw - iw) / 2;
    const iy = y + (availH - ih) / 2;
    return {
      page: { w: pw, h: ph, orientation: orient, paper: o.size ? 'mini' : (o.paper || 'letter') },
      margin: Math.min(mg.t, mg.r, mg.b, mg.l),
      head: H,
      content: { x: mg.l, y: mg.t, w: cw, h: ph - mg.t - mg.b },
      title: o.title ? { x: mg.l, y: titleY, w: cw, h: H.title } : null,
      key: { x: mg.l, y: keyY, w: cw, rows: kg.rows, perRow: kg.perRow, cell: kg.cell },
      image: { x: ix, y: iy, w: iw, h: ih },
      footer: footH ? { x: mg.l, y: ph - mg.b - footH, w: cw, h: footH } : null,
    };
  }

  /* The four cells of a 4-up Letter sheet. The outer edges keep the printer margin; the edges at
   * the cut lines only need a little white space. */
  /* Margins for a mini page in cell i. Landscape pages are drawn turned a quarter turn clockwise,
   * so their top margin is the cell's right edge, their left margin the cell's top, and so on. */
  function miniMargins(i, landscape, margin) {
    const m = miniCells(margin)[i].margins;
    return landscape ? { t: m.r, r: m.b, b: m.l, l: m.t } : m;
  }

  function miniCells(margin) {
    const m = margin == null ? 12.7 : margin, inner = 6;
    const cells = [];
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 2; c++) {
        cells.push({
          x: c * MINI.w, y: r * MINI.h,
          margins: { t: r ? inner : m, b: r ? m : inner, l: c ? inner : m, r: c ? m : inner },
        });
      }
    }
    return cells;
  }

  // Font size (mm) for a letter inside a dot of radius r (mm). Bold caps are ~0.72 em tall.
  function letterFont(r) { return r * 1.3; }

  function keySvg(g, key, o) {
    const out = [];
    const { x, y, cell, perRow } = g.key;
    const H = g.head || HEAD.full;
    // Like the kits: a circle you dot with the marker you pick, then the letter it stands for.
    // A color printer fills the circle in (the plan); black-and-white leaves it blank to test-dot.
    const circleR = H.circle;
    key.forEach((k, i) => {
      const row = Math.floor(i / perRow), col = i % perRow;
      const rowCount = Math.min(perRow, key.length - row * perRow);
      const x0 = x + (perRow - rowCount) * cell / 2; // center a short last row
      const cx = x0 + col * cell + cell / 2 - circleR;
      const cy = y + row * H.keyRow + circleR + 1;
      const filled = o.view === 'finished' || o.printer === 'color';
      out.push(filled
        ? `<circle cx="${r2(cx)}" cy="${r2(cy)}" r="${circleR}" fill="${k.hex}" stroke="#555" stroke-width="0.2"/>`
        : `<circle cx="${r2(cx)}" cy="${r2(cy)}" r="${circleR}" fill="none" stroke="#555" stroke-width="0.3"/>`);
      out.push(`<text x="${r2(cx + circleR * 1.4)}" y="${r2(cy)}" dy="0.36em" font-size="${H.letter}" font-weight="700" fill="#333">${esc(k.letter)}</text>`);
      if (k.name) {
        const maxChars = Math.max(6, Math.floor(cell / (H.name * 0.56)));
        const name = k.name.length > maxChars ? k.name.slice(0, maxChars - 1) + '…' : k.name;
        out.push(`<text x="${r2(cx + circleR * 0.7)}" y="${r2(cy + circleR + H.name * 1.5)}" text-anchor="middle" font-size="${H.name}" fill="#444">${esc(name)}</text>`);
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
    const { w: pw, h: ph } = o.geometry.page;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${r2(pw)}mm" height="${r2(ph)}mm" viewBox="0 0 ${r2(pw)} ${r2(ph)}" font-family="${FONT}">`
      + `<rect width="${r2(pw)}" height="${r2(ph)}" fill="#fff"/>` + inner(o) + `</svg>`;
  }

  // The page's contents without the <svg> wrapper, so mini pages can be placed on a sheet.
  function inner(o) {
    const g = o.geometry;
    const H = g.head || HEAD.full;
    const ink = o.letterInk || '#6f6f6f';
    const keyList = o.key.map((k, i) => k && Object.assign({ index: i }, k)).filter(Boolean);
    const parts = [];
    if (g.title && o.title) {
      const ty = r2(g.title.y + H.titleFont);
      // No text measuring here, so estimate widths: a long title shrinks to stay inside the
      // margins, and the hint is left out when it would run into the title.
      const titleW = textEm(o.title) * H.titleFont;
      const fs = titleW > g.title.w ? r2(H.titleFont * g.title.w / titleW) : H.titleFont;
      parts.push(`<text x="${r2(g.title.x)}" y="${ty}" font-size="${fs}" font-weight="700" fill="#222">${esc(o.title)}</text>`);
      if (!o.compact && !g.page.paper.startsWith('mini')) {
        const hint = o.mode === 'fill'
          ? 'Color each shape with the marker for its letter.'
          : 'Cover each letter with a dot: press firmly for big letters, tap lightly for small ones.';
        if (Math.min(titleW, g.title.w) + 4 + textEm(hint) * H.hint * 0.9 <= g.title.w) { // regular weight: ~10% narrower
          parts.push(`<text x="${r2(g.title.x + g.title.w)}" y="${ty}" text-anchor="end" font-size="${H.hint}" fill="#555">${esc(hint)}</text>`);
        }
      }
    }
    parts.push(keySvg(g, keyList, { printer: o.printer, view: o.view, letterInk: ink }));

    const im = g.image;
    parts.push(`<g transform="translate(${r2(im.x)} ${r2(im.y)})">`);
    if (o.view === 'finished') parts.push(finishedSvg(o, im));
    else if (o.mode === 'fill') parts.push(fillSvg(o, ink));
    else parts.push(dotsSvg(o, ink));
    parts.push(`</g>`);

    parts.push(footerSvg(g, o));
    return parts.join('');
  }

  /* A Letter sheet with four mini pages and cut marks.
   * pages: up to 4 build options (or null for an empty cell), each with a mini geometry.
   * ruler: draw the 50 mm scale check in the middle gutter.
   */
  function sheet4(pages, opts) {
    const o = opts || {};
    const W = PAGES.letter.w, H = PAGES.letter.h;
    const cells = miniCells(o.margin);
    const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}" font-family="${FONT}">`,
      `<rect width="${W}" height="${H}" fill="#fff"/>`];
    pages.forEach((p, i) => {
      if (!p) return;
      const c = cells[i];
      // A landscape mini page is turned a quarter turn clockwise to fit its portrait cell.
      const t = p.geometry.page.w > p.geometry.page.h
        ? `translate(${r2(c.x + MINI.w)} ${r2(c.y)}) rotate(90)`
        : `translate(${r2(c.x)} ${r2(c.y)})`;
      parts.push(`<g transform="${t}">${inner(p)}</g>`);
    });
    // Cut lines: dashed through the middle, stopping at the margin (an old printer can't reach
    // closer to the edge). Extend them with a ruler before cutting.
    const m = o.margin == null ? 12.7 : o.margin;
    parts.push(`<g stroke="#9a9a9a" stroke-width="0.2" fill="none" stroke-dasharray="1.2 1.6">`
      + `<path d="M${r2(W / 2)} ${r2(m)}V${r2(H - m)}M${r2(m)} ${r2(H / 2)}H${r2(W - m)}"/></g>`);
    if (o.ruler) {
      const x = W / 2 + 4, y = H / 2 - 1.5;
      parts.push(`<g stroke="#999" stroke-width="0.2" fill="none"><path d="M${r2(x)} ${r2(y)}h50M${r2(x)} ${r2(y - 1.2)}v1.2M${r2(x + 50)} ${r2(y - 1.2)}v1.2"/></g>`);
      parts.push(`<text x="${r2(x + 52)}" y="${r2(y)}" font-size="1.8" fill="#999">50 mm at 100%</text>`);
    }
    parts.push('</svg>');
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

  Object.assign(S, { PAGES, MINI, geometry, miniCells, miniMargins, build, inner, sheet4, letterFont, keyGrid });
})(typeof globalThis.DotSheet === 'object' ? globalThis.DotSheet : (globalThis.DotSheet = {}));

if (typeof module === 'object' && module.exports) module.exports = globalThis.DotSheet;
