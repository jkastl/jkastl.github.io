/* Dot Sheets page: picture in, printable page out.
 *
 * Three stages, each redone only when its inputs change:
 *   simplify (picture + detail/colors/markers)  ->  key edits  ->  layout (page + dot size)  ->  render
 * The first two heavy stages run in a Web Worker when the page is served over http(s).
 */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const DC = DotColor, PAL = DotPalettes;

  // ---------- settings, remembered between visits ----------
  const STORE = 'dot-sheets.v1';
  const DEFAULTS = {
    detail: 35, colors: 8, boost: 45, lines: 50, paper: false,
    source: 'markers', choose: 'best', letters: 'flowart',
    mode: 'dots', paperSize: 'letter', orientation: 'auto', dotSize: 'medium',
    printer: 'mono', ink: '#6f6f6f', margin: '12.7', title: '', guides: false, rings: false, footer: true,
    view: 'print',
    owned: ['landscapes'], off: {}, custom: [],
  };
  let S = Object.assign({}, DEFAULTS);
  try { Object.assign(S, JSON.parse(localStorage.getItem(STORE) || '{}')); } catch (e) { /* private mode */ }
  S.view = 'print';
  const save = () => { try { localStorage.setItem(STORE, JSON.stringify(S)); } catch (e) { /* ignore */ } };

  // Dot radii (mm) per size level. "Medium" matches the kits: about 2.5 to 4.5 mm dots.
  const DOT_SIZES = {
    fine: [0.95, 1.3, 1.7],
    medium: [1.25, 1.7, 2.2],
    large: [1.6, 2.2, 2.9],
    jumbo: [3.0, 4.2, 5.5],
  };

  // ---------- worker, with a same-thread fallback ----------
  let worker = null, seq = 0;
  const pending = new Map();
  try {
    if (location.protocol !== 'file:') {
      worker = new Worker('js/worker.js');
      worker.onmessage = e => {
        const p = pending.get(e.data.id);
        if (!p) return;
        pending.delete(e.data.id);
        e.data.ok ? p.resolve(e.data.result) : p.reject(new Error(e.data.error));
      };
      worker.onerror = () => { worker = null; for (const p of pending.values()) p.reject(new Error('worker failed')); pending.clear(); };
    }
  } catch (e) { worker = null; }

  function runLayout(seg, o) {
    const out = {};
    if (o.mode === 'dots') out.dots = DotLayout.dots(seg, o.dots);
    else out.labels = DotLayout.labels(seg, o.labels);
    if (o.outlines) out.outlines = DotLayout.outlines(seg, o.outlinesOpts);
    return out;
  }
  function call(op, args) {
    if (worker) {
      return new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, op, args });
      }).catch(err => {
        if (worker) throw err;
        return call(op, args); // the worker died: retry here
      });
    }
    return new Promise(r => setTimeout(r, 16)).then(() =>
      op === 'simplify' ? DotSimplify.simplify(args.img, args.opts) : runLayout(args.seg, args.opts));
  }

  // ---------- state ----------
  let src = null;            // canvas holding the loaded picture (long side <= 1600)
  let crop = null;           // {x, y, w, h} in src pixels
  let srcName = '';
  let seg = null;            // straight from simplify
  let segE = null;           // after key edits
  let lay = null;            // { dots | labels, outlines }
  let geo = null;
  let edits = {};            // key edits, by palette key (marker id or hex)
  let svgText = '';
  let gen = 0;

  // ---------- markers ----------
  function pool() {
    const out = [], seen = [];
    for (const set of PAL.SETS) {
      if (!S.owned.includes(set.id)) continue;
      const off = S.off[set.id] || [];
      set.colors.forEach((c, i) => {
        if (off.includes(i)) return;
        const lab = DC.hexToLab(c.hex);
        // Two kits often share a marker; list it once.
        if (seen.some(l => DC.deltaE2000(l, lab) < 2)) return;
        seen.push(lab);
        out.push({ id: set.id + ':' + i, hex: c.hex, name: c.name, set: set.name, est: !!c.est });
      });
    }
    S.custom.forEach((c, i) => {
      if (c.off) return;
      out.push({ id: 'custom:' + c.id, hex: c.hex, name: c.name || 'Custom', set: 'Other markers' });
    });
    return out;
  }
  const poolById = () => new Map(pool().map(p => [p.id, p]));
  const keyOf = p => (p.paper ? 'paper' : p.poolId || p.hex);

  function renderSets() {
    const list = $('set-list');
    list.textContent = '';
    for (const set of PAL.SETS) {
      const row = document.createElement('label');
      row.className = 'set-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = S.owned.includes(set.id);
      cb.addEventListener('change', () => {
        S.owned = cb.checked ? [...S.owned, set.id] : S.owned.filter(x => x !== set.id);
        changed('simplify');
        renderSets();
      });
      const name = document.createElement('span');
      name.className = 'set-name';
      name.textContent = set.name;
      if (set.metallic) { const t = document.createElement('span'); t.className = 'tag'; t.textContent = 'metallic'; name.append(t); }
      const chips = document.createElement('span');
      chips.className = 'chips';
      const off = S.off[set.id] || [];
      set.colors.forEach((c, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'chip-dot' + (off.includes(i) ? ' off' : '') + (c.est ? ' est' : '');
        b.style.background = c.hex;
        b.title = `${c.name} ${c.hex}${c.est ? ' (estimated)' : ''}. Click to ${off.includes(i) ? 'use' : 'skip'} this marker.`;
        b.setAttribute('aria-pressed', String(!off.includes(i)));
        b.addEventListener('click', e => {
          e.preventDefault();
          const cur = new Set(S.off[set.id] || []);
          cur.has(i) ? cur.delete(i) : cur.add(i);
          S.off[set.id] = [...cur];
          if (!S.owned.includes(set.id)) S.owned = [...S.owned, set.id];
          changed('simplify');
          renderSets();
        });
        chips.append(b);
      });
      row.append(cb, name, chips);
      list.append(row);
    }
    const n = pool().length;
    $('sets-count').textContent = `· ${S.owned.length} kit${S.owned.length === 1 ? '' : 's'}, ${n} color${n === 1 ? '' : 's'}`;
    renderCustom();
  }

  function renderCustom() {
    const box = $('custom-list');
    box.textContent = '';
    S.custom.forEach(c => {
      const row = document.createElement('div');
      row.className = 'custom-row';
      const sw = document.createElement('span');
      sw.className = 'chip-dot' + (c.off ? ' off' : '');
      sw.style.background = c.hex;
      const nm = document.createElement('span');
      nm.textContent = c.name || c.hex;
      const x = document.createElement('button');
      x.type = 'button'; x.className = 'btn mini ghost x'; x.textContent = 'Remove';
      x.addEventListener('click', () => { S.custom = S.custom.filter(o => o !== c); renderSets(); changed('simplify'); });
      row.append(sw, nm, x);
      box.append(row);
    });
  }

  $('custom-add').addEventListener('click', () => {
    const hex = $('custom-color').value;
    const name = $('custom-name').value.trim() || DotEdit.colorName(DC.hexToLab(hex));
    S.custom.push({ id: Date.now().toString(36), hex, name });
    $('custom-name').value = '';
    renderSets();
    changed('simplify');
  });

  // ---------- picture input ----------
  const MAX_SRC = 1600;
  function loadCanvas(cv, name) {
    const s = Math.min(1, MAX_SRC / Math.max(cv.width, cv.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(cv.width * s));
    c.height = Math.max(1, Math.round(cv.height * s));
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cv, 0, 0, c.width, c.height);
    src = c; crop = null; srcName = name || '';
    edits = {};
    drawSrcThumb();
    $('thumbs').hidden = false;
    $('empty').hidden = true;
    changed('simplify');
  }

  function loadFile(file) {
    if (!file || !/^image\//.test(file.type)) { status('That file isn’t a picture.'); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      loadCanvas(c, file.name.replace(/\.[^.]+$/, ''));
    };
    img.onerror = () => { URL.revokeObjectURL(url); status('Couldn’t read that picture. Try a JPEG or PNG.'); };
    img.src = url;
  }

  $('file').addEventListener('change', e => loadFile(e.target.files[0]));
  const drop = $('drop');
  ['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => loadFile(e.dataTransfer.files[0]));
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', e => { e.preventDefault(); if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]); });
  document.addEventListener('paste', e => {
    const item = [...(e.clipboardData || {}).items || []].find(i => i.type.startsWith('image/'));
    if (item) loadFile(item.getAsFile());
  });
  document.querySelectorAll('[data-sample]').forEach(b => b.addEventListener('click', () => {
    loadCanvas(DotSamples.make(b.dataset.sample), b.textContent);
  }));

  // Thumbnail of the original, with drag-to-crop.
  const srcCv = $('src-canvas');
  function drawSrcThumb() {
    const s = Math.min(1, 360 / Math.max(src.width, src.height));
    srcCv.width = Math.round(src.width * s); srcCv.height = Math.round(src.height * s);
    srcCv.getContext('2d').drawImage(src, 0, 0, srcCv.width, srcCv.height);
    showCrop();
  }
  function showCrop() {
    const box = $('crop-box');
    $('crop-reset').hidden = !crop;
    $('crop-hint').hidden = !!crop;
    if (!crop) { box.hidden = true; return; }
    box.hidden = false;
    box.style.left = (crop.x / src.width * 100) + '%';
    box.style.top = (crop.y / src.height * 100) + '%';
    box.style.width = (crop.w / src.width * 100) + '%';
    box.style.height = (crop.h / src.height * 100) + '%';
  }
  let drag = null;
  const wrap = $('crop-wrap');
  const toSrc = e => {
    const r = srcCv.getBoundingClientRect();
    return [Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * src.width,
      Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) * src.height];
  };
  wrap.addEventListener('pointerdown', e => { if (!src) return; drag = toSrc(e); wrap.setPointerCapture(e.pointerId); });
  wrap.addEventListener('pointermove', e => {
    if (!drag) return;
    const [x, y] = toSrc(e);
    crop = { x: Math.min(x, drag[0]), y: Math.min(y, drag[1]), w: Math.abs(x - drag[0]), h: Math.abs(y - drag[1]) };
    showCrop();
  });
  wrap.addEventListener('pointerup', () => {
    if (!drag) return;
    drag = null;
    if (crop && (crop.w < src.width * 0.05 || crop.h < src.height * 0.05)) crop = null;
    showCrop();
    changed('simplify');
  });
  $('crop-reset').addEventListener('click', () => { crop = null; showCrop(); changed('simplify'); });

  function srcPixels() {
    const c = crop || { x: 0, y: 0, w: src.width, h: src.height };
    const w = Math.max(1, Math.round(c.w)), h = Math.max(1, Math.round(c.h));
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    ctx.drawImage(src, c.x, c.y, c.w, c.h, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h);
    return { width: w, height: h, data: d.data };
  }

  // ---------- controls ----------
  function bindRange(id, key, fmt, stage) {
    const el = $(id), out = $(id + '-out');
    el.value = S[key];
    const show = () => { out.textContent = fmt(+el.value); };
    show();
    el.addEventListener('input', () => { S[key] = +el.value; show(); changed(stage, 250); });
  }
  bindRange('detail', 'detail', v => v < 25 ? 'Poster' : v < 50 ? 'Bold' : v < 75 ? 'Balanced' : 'Detailed', 'simplify');
  bindRange('colors', 'colors', v => v, 'simplify');
  bindRange('boost', 'boost', v => v < 15 ? 'True to photo' : v < 50 ? 'Some' : v < 80 ? 'Lots' : 'Wild', 'simplify');
  bindRange('lines', 'lines', v => v === 0 ? 'None' : v < 35 ? 'Few' : v < 70 ? 'Bold' : 'Lots', 'simplify');

  function bindCheck(id, key, stage) {
    const el = $(id);
    el.checked = !!S[key];
    el.addEventListener('change', () => { S[key] = el.checked; changed(stage); });
  }
  bindCheck('blank-white', 'paper', 'simplify');
  bindCheck('guides', 'guides', 'layout');
  bindCheck('rings', 'rings', 'render');
  bindCheck('footer', 'footer', 'layout');

  function bindSelect(id, key, stage) {
    const el = $(id);
    el.value = S[key];
    if (el.value !== String(S[key])) S[key] = el.value = DEFAULTS[key];
    el.addEventListener('change', () => { S[key] = el.value; changed(stage); });
  }
  bindSelect('paper-size', 'paperSize', 'layout');
  bindSelect('orientation', 'orientation', 'layout');
  bindSelect('dot-size', 'dotSize', 'simplify');
  bindSelect('printer', 'printer', 'render');
  bindSelect('ink', 'ink', 'render');
  bindSelect('margin', 'margin', 'layout');
  bindSelect('letters', 'letters', 'render');

  const title = $('title');
  title.value = S.title;
  title.addEventListener('input', () => {
    const had = !!S.title.trim();
    S.title = title.value;
    changed(had === !!S.title.trim() ? 'render' : 'layout', 300);
  });

  function bindSeg(id, key, stage, after) {
    const box = $(id);
    const sync = () => box.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === S[key])));
    sync();
    box.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b || S[key] === b.dataset.v) return;
      S[key] = b.dataset.v;
      sync();
      if (after) after();
      changed(stage);
    });
  }
  bindSeg('source', 'source', 'simplify', syncSource);
  bindSeg('choose', 'choose', 'simplify');
  bindSeg('mode', 'mode', 'layout', syncMode);
  bindSeg('view', 'view', 'render');

  function syncSource() {
    const m = S.source === 'markers';
    $('markers-ui').hidden = !m;
    $('source-note').textContent = m
      ? 'Tick the kits you have. The page uses the best of their colors for this picture.'
      : 'Uses whatever colors suit the picture. The key suggests your closest marker for each.';
  }
  function syncMode() {
    const d = S.mode === 'dots';
    document.querySelectorAll('[data-for="dots"]').forEach(el => { el.hidden = !d; });
    $('mode-note').textContent = d
      ? 'Rows of letters that follow each shape, like the kits. Cover each letter with a dot.'
      : 'Outlined shapes with a letter in each, to color in with any markers or pencils.';
  }
  syncSource();
  syncMode();

  // ---------- the pipeline ----------
  let timer = null, dirty = 0;
  // Each stage redoes itself and everything after it. Key edits come before layout, since a merge
  // changes the shapes.
  const LEVEL = { render: 1, layout: 2, edits: 3, simplify: 4 };
  function changed(stage, wait) {
    save();
    dirty = Math.max(dirty, LEVEL[stage]);
    clearTimeout(timer);
    timer = setTimeout(run, wait || 30);
  }

  function status(text, busy) {
    const el = $('status');
    el.textContent = text;
    el.classList.toggle('busy', !!busy);
  }

  async function run() {
    if (!src) { dirty = 0; return; }
    const my = ++gen;
    const level = dirty;
    dirty = 0;
    try {
      if (level >= LEVEL.simplify || !seg) {
        const p = S.source === 'markers' ? pool() : null;
        if (p && !p.length) { status('Tick at least one kit, or add a marker, or switch to “Match the picture”.'); return; }
        status('Simplifying the picture…', true);
        const res = await call('simplify', {
          img: srcPixels(),
          opts: {
            maxSide: MAX_SIDE, colors: S.colors, detail: S.detail / 100, boost: S.boost / 100,
            lines: S.lines / 100, featurePx: featurePx(),
            paper: S.paper, pool: p ? p.map(({ id, hex }) => ({ id, hex })) : null,
            choose: S.choose, seed: 7,
          },
        });
        if (my !== gen) return;
        seg = res;
        // Keep key edits only for colors still on the page.
        const keys = new Set(seg.palette.map(keyOf));
        for (const k of Object.keys(edits)) {
          if (!keys.has(k) || (edits[k].mergeInto && !keys.has(edits[k].mergeInto))) delete edits[k];
        }
      }
      if (level >= LEVEL.edits || !segE) {
        segE = DotEdit.apply(seg, edits, keyOf);
        drawFlat();
        renderKeyEditor();
      }
      if (level >= LEVEL.layout || !lay) {
        geo = DotSheet.geometry({
          paper: S.paperSize, orientation: S.orientation, margin: +S.margin,
          aspect: segE.width / segE.height, keyCount: inkCount(), title: !!S.title.trim(), footer: S.footer,
        });
        const mmPerPx = geo.image.w / segE.width;
        const needOutlines = S.mode === 'fill' || S.guides;
        status(S.mode === 'dots' ? 'Laying out the dots…' : 'Tracing the shapes…', true);
        const res = await call('layout', {
          seg: segForLayout(segE),
          opts: {
            mode: S.mode,
            dots: { mmPerPx, sizes: DOT_SIZES[S.dotSize], seed: 3 },
            labels: { mmPerPx },
            outlines: needOutlines,
            outlinesOpts: { mmPerPx },
          },
        });
        if (my !== gen) return;
        lay = res;
      }
      render();
    } catch (err) {
      console.error(err);
      if (my === gen) status('Something went wrong: ' + (err.message || err).toString().split('\n')[0]);
    }
  }

  // How many picture pixels the smallest dot (plus its gap) covers on paper. Shapes thinner than
  // this can't be drawn in dots, so simplify.js uses it as the finest feature to keep.
  const MAX_SIDE = 480;
  function featurePx() {
    const c = crop || { w: src.width, h: src.height };
    const aspect = c.w / c.h;
    const segW = Math.min(Math.round(c.w), aspect >= 1 ? MAX_SIDE : Math.round(MAX_SIDE * aspect));
    const g = DotSheet.geometry({
      paper: S.paperSize, orientation: S.orientation, margin: +S.margin, aspect,
      keyCount: S.colors, title: !!S.title.trim(), footer: S.footer,
    });
    const mmPerPx = g.image.w / Math.max(1, segW);
    const sizes = S.mode === 'dots' ? DOT_SIZES[S.dotSize] : [1.6];
    return Math.max(2, (2 * sizes[0] + 0.35) / mmPerPx);
  }

  // The layout only needs the maps and palette, not the preview pixels.
  function segForLayout(s) {
    return { width: s.width, height: s.height, index: s.index, region: s.region, regions: s.regions, palette: s.palette.map(p => ({ hex: p.hex, rgb: p.rgb, lab: p.lab, area: p.area, paper: !!p.paper, poolId: p.poolId || null })) };
  }
  const inkCount = () => segE.palette.filter(p => !p.paper).length;

  function drawFlat() {
    const cv = $('flat-canvas');
    cv.width = segE.width; cv.height = segE.height;
    cv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(segE.preview), segE.width, segE.height), 0, 0);
  }

  // ---------- the key ----------
  // One entry per palette index: letter, color, a name to print, and a line for the editor.
  function keyEntries() {
    const letters = PAL.LETTERS[S.letters] || PAL.LETTERS.flowart;
    const byId = poolById();
    const p = S.source === 'markers' ? null : pool();
    const pLabs = p ? p.map(m => DC.hexToLab(m.hex)) : null;
    let n = 0;
    return segE.palette.map(c => {
      if (c.paper) return null;
      const letter = letters[n] || String(n + 1);
      n++;
      const m = c.poolId ? byId.get(c.poolId) : null;
      let name, sub;
      if (m) { name = c.name || m.name; sub = m.set; }
      else {
        name = c.name || DotEdit.colorName(c.lab);
        sub = c.hex;
        if (pLabs && pLabs.length) {
          const near = DC.nearest(c.lab, pLabs);
          const mk = p[near.index];
          sub = `closest: ${mk.name} (${mk.set})${near.dE > 12 ? ', not close' : ''}`;
        }
      }
      return { letter, hex: c.hex, name, sub, ink: DC.inkOn(c.hex), key: c.key };
    });
  }

  function renderKeyEditor() {
    const entries = keyEntries();
    const ol = $('key-rows');
    ol.textContent = '';
    const markers = pool();
    entries.forEach(k => {
      if (!k) return;
      const li = document.createElement('li');
      li.className = 'key-row';
      const L = document.createElement('span'); L.className = 'key-letter'; L.textContent = k.letter;
      const sw = document.createElement('input');
      sw.type = 'color'; sw.value = k.hex; sw.className = 'key-sw'; sw.title = 'Pick any color for ' + k.letter;
      sw.addEventListener('change', () => { edits[k.key] = { hex: sw.value, name: DotEdit.colorName(DC.hexToLab(sw.value)) }; changed('edits'); });
      const nm = document.createElement('span'); nm.className = 'key-name';
      nm.textContent = k.name;
      const small = document.createElement('small'); small.textContent = k.sub; nm.append(small);
      const sel = document.createElement('select');
      sel.setAttribute('aria-label', 'Change letter ' + k.letter);
      sel.innerHTML = '<option value="">Change…</option>';
      if (markers.length) {
        const g = document.createElement('optgroup'); g.label = 'Use marker';
        markers.forEach(m => { const o = document.createElement('option'); o.value = 'm:' + m.id; o.textContent = `${m.name} · ${m.set}`; g.append(o); });
        sel.append(g);
      }
      const others = entries.filter(o => o && o.key !== k.key);
      if (others.length) {
        const g = document.createElement('optgroup'); g.label = 'Merge into';
        others.forEach(o => { const op = document.createElement('option'); op.value = 'g:' + o.key; op.textContent = `${o.letter} (${o.name})`; g.append(op); });
        sel.append(g);
      }
      if (edits[k.key]) { const o = document.createElement('option'); o.value = 'reset'; o.textContent = 'Undo change'; sel.append(o); }
      sel.addEventListener('change', () => {
        const v = sel.value;
        if (v.startsWith('m:')) {
          const m = markers.find(x => x.id === v.slice(2));
          edits[k.key] = { hex: m.hex, name: m.name, poolId: m.id };
        } else if (v.startsWith('g:')) edits[k.key] = { mergeInto: v.slice(2) };
        else if (v === 'reset') delete edits[k.key];
        else return;
        changed('edits');
      });
      li.append(L, sw, nm, sel);
      ol.append(li);
    });
    $('key-edit').hidden = false;
    const ed = Object.keys(edits).length;
    const note = $('key-note');
    note.textContent = ed
      ? `${ed} change${ed === 1 ? '' : 's'} made. `
      : 'Click a swatch for any color, or use Change… to swap in another marker or merge two letters.';
    if (ed) {
      const undo = document.createElement('button');
      undo.type = 'button'; undo.className = 'linkish'; undo.textContent = 'Undo all';
      undo.addEventListener('click', () => { edits = {}; changed('edits'); });
      note.append(undo);
    }
  }

  // ---------- render ----------
  function render() {
    if (!segE || !lay) return;
    const key = keyEntries();
    const common = {
      geometry: geo, key, mode: S.mode, printer: S.printer, letterInk: S.ink,
      dots: lay.dots || [], sizes: DOT_SIZES[S.dotSize], labels: lay.labels ? lay.labels.labels || lay.labels : [],
      outlines: lay.outlines ? lay.outlines.d : '', guides: S.guides, rings: S.rings,
      title: S.title.trim(), credit: 'jkastl.github.io/dot-sheets', seed: 5,
    };
    svgText = DotSheet.build(Object.assign({}, common, { view: 'print' }));
    const shown = S.view === 'print' ? svgText
      : DotSheet.build(Object.assign({}, common, { view: 'finished', fillPreview: S.mode === 'fill' ? flatDataUrl() : null }));
    const paper = $('paper');
    paper.innerHTML = shown;
    paper.hidden = false;
    fitPaper();
    $('print-root').innerHTML = svgText;
    $('page-size').textContent = `@page { size: ${geo.page.w}mm ${geo.page.h}mm; margin: 0; }`;
    ['print', 'dl-svg', 'dl-png'].forEach(id => { $(id).disabled = false; });
    $('print-tip').hidden = false;
    const n = S.mode === 'dots' ? (lay.dots || []).length : common.labels.length;
    const what = S.mode === 'dots' ? 'dots' : 'shapes';
    status(`${n.toLocaleString()} ${what} · ${inkCount()} colors · ${DotSheet.PAGES[geo.page.paper].label} ${geo.page.orientation}`);
  }

  function flatDataUrl() {
    const cv = $('flat-canvas');
    return cv.toDataURL('image/png');
  }

  // Fit the page in the preview box; a click zooms in for a closer look.
  let zoom = false;
  function fitPaper() {
    if (!geo) return;
    const wrapEl = $('paper-wrap'), paper = $('paper');
    const W = wrapEl.clientWidth - 40, H = wrapEl.clientHeight - 40;
    const s = Math.min(W / geo.page.w, H / geo.page.h) * (zoom ? 2.6 : 1);
    paper.style.width = Math.round(geo.page.w * s) + 'px';
    paper.style.height = Math.round(geo.page.h * s) + 'px';
    paper.classList.toggle('zoom', zoom);
    wrapEl.style.placeItems = zoom ? 'start' : 'center';
  }
  $('paper').addEventListener('click', e => {
    const wrapEl = $('paper-wrap'), paper = $('paper');
    const r = paper.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
    zoom = !zoom;
    fitPaper();
    if (zoom) {
      wrapEl.scrollLeft = fx * paper.offsetWidth - wrapEl.clientWidth / 2;
      wrapEl.scrollTop = fy * paper.offsetHeight - wrapEl.clientHeight / 2;
    }
  });
  addEventListener('resize', fitPaper);

  // ---------- output ----------
  const fileBase = () => (S.title.trim() || srcName || 'dot-sheet').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'dot-sheet';
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  $('print').addEventListener('click', () => window.print());
  $('dl-svg').addEventListener('click', () => {
    const text = S.view === 'print' ? svgText : $('paper').innerHTML;
    download(new Blob([text], { type: 'image/svg+xml' }), fileBase() + (S.view === 'print' ? '' : '-finished') + '.svg');
  });
  $('dl-png').addEventListener('click', () => {
    const text = S.view === 'print' ? svgText : $('paper').innerHTML;
    const dpi = 300, w = Math.round(geo.page.w / 25.4 * dpi), h = Math.round(geo.page.h / 25.4 * dpi);
    const img = new Image();
    const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
    status('Making a 300 dpi PNG…', true);
    img.onload = () => {
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      cv.toBlob(b => { download(b, fileBase() + (S.view === 'print' ? '' : '-finished') + '.png'); render(); }, 'image/png');
    };
    img.onerror = () => { URL.revokeObjectURL(url); status('Couldn’t make the PNG in this browser. Try SVG or Print.'); };
    img.src = url;
  });

  renderSets();
})();
