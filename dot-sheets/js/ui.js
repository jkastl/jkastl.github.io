/* Dot Sheets page: picture in, printable page out.
 *
 * Two formats: one full Letter page, or a Letter sheet holding four mini pages to cut apart (like
 * a FlowArt Mini pad). Each mini page is a "slot" with its own picture, crop and key edits; the
 * full page uses slot 1. For each slot the pipeline is
 *   simplify (picture + detail/colors/markers)  ->  key edits  ->  layout (page + dot size)
 * and the sheet is rendered from all slots. Each step is redone only when its inputs change. The
 * two heavy steps run in a Web Worker when the page is served over http(s).
 */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const DC = DotColor, PAL = DotPalettes;

  // ---------- settings, remembered between visits ----------
  const STORE = 'dot-sheets.v1';
  // Settings that differ between a full page and a mini page.
  const PER_FORMAT = ['colors', 'dotSize', 'letters'];
  const DEFAULTS = {
    format: 'full',
    full: { colors: 8, dotSize: 'medium', letters: 'flowart' },
    mini: { colors: 5, dotSize: 'fine', letters: 'mini' },
    detail: 35, boost: 45, lines: 50, paper: false,
    source: 'markers', choose: 'best',
    mode: 'dots', paperSize: 'letter', orientation: 'auto',
    printer: 'mono', ink: '#3c3c3c', margin: '12.7', title: '', guides: false, rings: false, footer: true,
    view: 'print',
    // The kits this site's owner has: three Mini Express pads.
    owned: ['snow-day', 'in-full-bloom', 'paws-and-purrs'], off: {}, custom: [],
    kitsVersion: 2,
  };
  const S = JSON.parse(JSON.stringify(DEFAULTS));
  let returning = false;
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) || '{}');
    returning = Object.keys(saved).length > 0;
    for (const k of Object.keys(saved)) {
      if (k === 'full' || k === 'mini') Object.assign(S[k], saved[k]);
      else if (k in S) S[k] = saved[k];
      else if (PER_FORMAT.includes(k) && !saved.full) S.full[k] = saved[k]; // saved before the mini format
    }
    // Version 1 defaulted to Landscapes. A list still exactly that was never really chosen, so it
    // moves to the new default.
    if (!saved.kitsVersion && JSON.stringify(saved.owned) === '["landscapes"]') S.owned = DEFAULTS.owned.slice();
    S.kitsVersion = DEFAULTS.kitsVersion;
  } catch (e) { /* private mode or bad JSON: defaults */ }
  S.view = 'print';
  const save = () => { try { localStorage.setItem(STORE, JSON.stringify(S)); } catch (e) { /* ignore */ } };
  const get = k => (PER_FORMAT.includes(k) ? S[S.format][k] : S[k]);
  const set = (k, v) => { if (PER_FORMAT.includes(k)) S[S.format][k] = v; else S[k] = v; };
  const mini = () => S.format === 'mini';

  // Dot radii (mm) per size level. "Medium" matches the full-size kits: about 2.5 to 4.5 mm dots.
  const DOT_SIZES = {
    fine: [0.95, 1.3, 1.7],
    medium: [1.25, 1.7, 2.2],
    large: [1.6, 2.2, 2.9],
    jumbo: [3.0, 4.2, 5.5],
  };
  const MAX_SIDE = 480;

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

  // ---------- slots ----------
  const LEVEL = { render: 1, layout: 2, edits: 3, simplify: 4 };
  const newSlot = () => ({ src: null, crop: null, name: '', edits: {}, seg: null, segE: null, lay: null, geo: null, dirty: 0 });
  const slots = [newSlot(), newSlot(), newSlot(), newSlot()];
  let active = 0;
  const cur = () => slots[active];
  const usedSlots = () => (mini() ? [0, 1, 2, 3] : [0]).filter(i => slots[i].src);

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
        out.push({ id: set.id + ':' + i, hex: c.hex, name: c.name, set: set.name, est: !!c.est, letter: c.letter || null });
      });
    }
    S.custom.forEach(c => {
      if (c.off) return;
      out.push({ id: 'custom:' + c.id, hex: c.hex, name: c.name || 'Custom', set: 'Other markers' });
    });
    return out;
  }
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
      if (set.line) { const t = document.createElement('span'); t.className = 'tag'; t.textContent = set.line.toLowerCase(); name.append(t); }
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
          const now = new Set(S.off[set.id] || []);
          now.has(i) ? now.delete(i) : now.add(i);
          S.off[set.id] = [...now];
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
      sw.className = 'chip-dot';
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
  function toSrcCanvas(cv) {
    const s = Math.min(1, MAX_SRC / Math.max(cv.width, cv.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(cv.width * s));
    c.height = Math.max(1, Math.round(cv.height * s));
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cv, 0, 0, c.width, c.height);
    return c;
  }
  function loadCanvas(cv, name) {
    const sl = cur();
    Object.assign(sl, newSlot(), { src: toSrcCanvas(cv), name: name || '' });
    showSlot();
    $('empty').hidden = true;
    changed('simplify', 0, [active]);
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

  $('file').addEventListener('change', e => { loadFile(e.target.files[0]); e.target.value = ''; });
  const drop = $('drop');
  ['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => { e.stopPropagation(); loadFile(e.dataTransfer.files[0]); });
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', e => { e.preventDefault(); if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]); });
  document.addEventListener('paste', e => {
    const item = [...((e.clipboardData || {}).items || [])].find(i => i.type.startsWith('image/'));
    if (item) loadFile(item.getAsFile());
  });
  document.querySelectorAll('[data-sample]').forEach(b => b.addEventListener('click', () => {
    loadCanvas(DotSamples.make(b.dataset.sample), b.textContent);
  }));

  // Thumbnail of the original, with drag-to-crop.
  const srcCv = $('src-canvas');
  function showSlot() {
    const sl = cur();
    $('thumbs').hidden = !sl.src;
    $('key-edit').hidden = !sl.segE;
    if (sl.src) {
      const s = Math.min(1, 360 / Math.max(sl.src.width, sl.src.height));
      srcCv.width = Math.round(sl.src.width * s); srcCv.height = Math.round(sl.src.height * s);
      srcCv.getContext('2d').drawImage(sl.src, 0, 0, srcCv.width, srcCv.height);
      showCrop();
    }
    if (sl.segE) { drawFlat(sl); renderKeyEditor(); }
    else { const f = $('flat-canvas'); f.width = 1; f.height = 1; }
    renderSlotBar();
  }
  function showCrop() {
    const sl = cur(), box = $('crop-box');
    $('crop-reset').hidden = !sl.crop;
    $('crop-hint').hidden = !!sl.crop;
    if (!sl.crop) { box.hidden = true; return; }
    box.hidden = false;
    box.style.left = (sl.crop.x / sl.src.width * 100) + '%';
    box.style.top = (sl.crop.y / sl.src.height * 100) + '%';
    box.style.width = (sl.crop.w / sl.src.width * 100) + '%';
    box.style.height = (sl.crop.h / sl.src.height * 100) + '%';
  }
  let drag = null;
  const wrap = $('crop-wrap');
  const toSrc = e => {
    const r = srcCv.getBoundingClientRect(), s = cur().src;
    return [Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * s.width,
      Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) * s.height];
  };
  let cropBefore = null;
  wrap.addEventListener('pointerdown', e => {
    if (!cur().src) return;
    drag = toSrc(e);
    cropBefore = JSON.stringify(cur().crop);
    wrap.setPointerCapture(e.pointerId);
  });
  wrap.addEventListener('pointermove', e => {
    if (!drag) return;
    const [x, y] = toSrc(e);
    cur().crop = { x: Math.min(x, drag[0]), y: Math.min(y, drag[1]), w: Math.abs(x - drag[0]), h: Math.abs(y - drag[1]) };
    showCrop();
  });
  wrap.addEventListener('pointerup', () => {
    if (!drag) return;
    drag = null;
    const sl = cur();
    if (sl.crop && (sl.crop.w < sl.src.width * 0.05 || sl.crop.h < sl.src.height * 0.05)) sl.crop = null;
    showCrop();
    if (JSON.stringify(sl.crop) !== cropBefore) changed('simplify', 0, [active]); // a plain click changes nothing
  });
  $('crop-reset').addEventListener('click', () => { cur().crop = null; showCrop(); changed('simplify', 0, [active]); });

  function srcPixels(sl) {
    const c = sl.crop || { x: 0, y: 0, w: sl.src.width, h: sl.src.height };
    const w = Math.max(1, Math.round(c.w)), h = Math.max(1, Math.round(c.h));
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    ctx.drawImage(sl.src, c.x, c.y, c.w, c.h, 0, 0, w, h);
    return { width: w, height: h, data: ctx.getImageData(0, 0, w, h).data };
  }

  // ---------- the four mini-page slots ----------
  function renderSlotBar() {
    const bar = $('slots');
    bar.hidden = !mini();
    if (!mini()) return;
    const btns = $('slot-btns');
    btns.textContent = '';
    slots.forEach((sl, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'slot' + (i === active ? ' on' : '') + (sl.src ? '' : ' empty');
      b.setAttribute('aria-pressed', String(i === active));
      b.setAttribute('aria-label', `Mini page ${i + 1}${sl.src ? ': ' + (sl.name || 'picture') : ', empty'}`);
      if (sl.src) {
        const c = document.createElement('canvas');
        const s = 64 / Math.max(sl.src.width, sl.src.height);
        c.width = Math.round(sl.src.width * s); c.height = Math.round(sl.src.height * s);
        c.getContext('2d').drawImage(sl.src, 0, 0, c.width, c.height);
        b.append(c);
      } else b.append(document.createTextNode('+'));
      const n = document.createElement('span'); n.className = 'slot-n'; n.textContent = i + 1;
      b.append(n);
      b.addEventListener('click', () => { active = i; showSlot(); });
      btns.append(b);
    });
    $('slot-fill').disabled = !cur().src;
    $('slot-clear').disabled = !cur().src;
  }
  $('slot-fill').addEventListener('click', () => {
    const from = cur();
    if (!from.src) return;
    const targets = [];
    slots.forEach((sl, i) => {
      if (sl === from) return;
      Object.assign(sl, newSlot(), { src: from.src, crop: from.crop && Object.assign({}, from.crop), name: from.name, edits: JSON.parse(JSON.stringify(from.edits)) });
      targets.push(i);
    });
    renderSlotBar();
    changed('simplify', 0, targets);
  });
  $('slot-clear').addEventListener('click', () => {
    Object.assign(cur(), newSlot());
    showSlot();
    changed('render');
  });

  // ---------- controls ----------
  const fmtRange = {
    detail: v => (v < 25 ? 'Poster' : v < 50 ? 'Bold' : v < 75 ? 'Balanced' : 'Detailed'),
    colors: v => v,
    boost: v => (v < 15 ? 'True to photo' : v < 50 ? 'Some' : v < 80 ? 'Lots' : 'Wild'),
    lines: v => (v === 0 ? 'None' : v < 35 ? 'Few' : v < 70 ? 'Bold' : 'Lots'),
  };
  const controls = []; // [{el, key, kind}] so a format switch can refresh them
  function bindRange(key, stage) {
    const el = $(key), out = $(key + '-out');
    const show = () => { out.textContent = fmtRange[key](+el.value); };
    el.addEventListener('input', () => { set(key, +el.value); show(); changed(stage, 250); });
    controls.push({ sync: () => { el.value = get(key); show(); } });
  }
  bindRange('detail', 'simplify');
  bindRange('colors', 'simplify');
  bindRange('boost', 'simplify');
  bindRange('lines', 'simplify');

  function bindCheck(id, key, stage) {
    const el = $(id);
    el.addEventListener('change', () => { set(key, el.checked); changed(stage); });
    controls.push({ sync: () => { el.checked = !!get(key); } });
  }
  bindCheck('blank-white', 'paper', 'simplify');
  bindCheck('guides', 'guides', 'layout');
  bindCheck('rings', 'rings', 'render');
  bindCheck('footer', 'footer', 'layout');

  function bindSelect(id, key, stage) {
    const el = $(id);
    el.addEventListener('change', () => { set(key, el.value); changed(stage); });
    controls.push({ sync: () => {
      el.value = get(key);
      if (el.value !== String(get(key))) { el.selectedIndex = 0; set(key, el.value); }
    } });
  }
  bindSelect('paper-size', 'paperSize', 'layout');
  bindSelect('orientation', 'orientation', 'layout');
  bindSelect('dot-size', 'dotSize', 'simplify');
  bindSelect('printer', 'printer', 'render');
  bindSelect('ink', 'ink', 'render');
  bindSelect('margin', 'margin', 'layout');
  bindSelect('letters', 'letters', 'render');

  const title = $('title');
  title.addEventListener('input', () => {
    const had = !!S.title.trim();
    S.title = title.value;
    changed(had === !!S.title.trim() ? 'render' : 'layout', 300);
  });
  controls.push({ sync: () => { title.value = S.title; } });

  function bindSeg(id, key, stage, after) {
    const box = $(id);
    const sync = () => box.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === get(key))));
    box.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b || get(key) === b.dataset.v) return;
      set(key, b.dataset.v);
      sync();
      if (after) after();
      changed(stage);
    });
    controls.push({ sync });
  }
  bindSeg('format', 'format', 'simplify', onFormat);
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
  function syncFormat() {
    document.querySelectorAll('[data-for="full"]').forEach(el => { el.hidden = mini(); });
    $('format-note').textContent = mini()
      ? 'Four 4¼ × 5½ in pages on one Letter sheet, with cut marks. Use one picture four times or up to four pictures.'
      : 'One picture on a full 8½ × 11 in page, like the full-size kits.';
  }
  function onFormat() {
    if (!mini()) {
      // The full page shows page 1. If page 1 is empty, bring the picture being looked at there.
      if (!slots[0].src) {
        const from = slots[active].src ? active : slots.findIndex(sl => sl.src);
        if (from > 0) [slots[0], slots[from]] = [slots[from], slots[0]];
      }
      active = 0;
    }
    controls.forEach(c => c.sync());
    syncFormat();
    showSlot();
  }
  controls.forEach(c => c.sync());
  syncSource();
  syncMode();
  syncFormat();

  // ---------- the pipeline ----------
  let timer = null, gen = 0;
  /* Mark slots as needing work from `stage` on. Picture-wide settings affect every slot; a crop or
   * key edit names its slot. */
  function changed(stage, wait, which) {
    save();
    gen++; // a run in flight is now stale; its slots stay dirty for the next one
    for (const i of which || [0, 1, 2, 3]) slots[i].dirty = Math.max(slots[i].dirty, LEVEL[stage]);
    clearTimeout(timer);
    timer = setTimeout(run, wait || 30);
  }

  function status(text, busy) {
    const el = $('status');
    el.textContent = text;
    el.classList.toggle('busy', !!busy);
  }

  async function run() {
    const used = usedSlots();
    if (!used.length) { renderEmpty(); return; }
    const my = ++gen;
    // The slot on screen goes first so its thumbnail and key update quickly.
    const order = used.includes(active) ? [active, ...used.filter(i => i !== active)] : used;
    try {
      for (const i of order) {
        const sl = slots[i];
        if (!sl.seg && sl.dirty < LEVEL.simplify) sl.dirty = LEVEL.simplify;
        if (sl.dirty <= LEVEL.render) continue;
        // The slot stays dirty until its work lands, so a newer run redoes work this one drops.
        const ok = await process(sl, i, sl.dirty, my);
        if (!ok) return;
        sl.dirty = LEVEL.render;
        if (i === active) showSlot();
      }
      if (my !== gen) return;
      for (const i of used) slots[i].dirty = 0;
      render();
    } catch (err) {
      console.error(err);
      if (my === gen) status('Something went wrong: ' + (err.message || err).toString().split('\n')[0]);
    }
  }

  const label = i => (mini() ? ` (page ${i + 1})` : '');

  async function process(sl, i, level, my) {
    if (level >= LEVEL.simplify) {
      const p = S.source === 'markers' ? pool() : null;
      if (p && !p.length) {
        renderEmpty();
        status('Tick at least one kit, or add a marker, or switch to “Match the picture”.');
        return false;
      }
      status('Simplifying the picture' + label(i) + '…', true);
      const res = await call('simplify', {
        img: srcPixels(sl),
        opts: {
          maxSide: MAX_SIDE, colors: get('colors'), detail: S.detail / 100, boost: S.boost / 100,
          lines: S.lines / 100, featurePx: featurePx(sl, i),
          paper: S.paper, pool: p ? p.map(({ id, hex }) => ({ id, hex })) : null,
          choose: S.choose, seed: 7,
        },
      });
      if (my !== gen) return false;
      sl.seg = res;
      // Keep key edits only for colors still on the page.
      const keys = new Set(sl.seg.palette.map(keyOf));
      for (const k of Object.keys(sl.edits)) {
        const e = sl.edits[k];
        if (!keys.has(k) || (e.mergeInto && !keys.has(e.mergeInto))) delete sl.edits[k];
      }
    }
    if (level >= LEVEL.edits) sl.segE = DotEdit.apply(sl.seg, sl.edits, keyOf);
    if (level >= LEVEL.layout) {
      sl.geo = geometryFor(i, sl.segE.width / sl.segE.height, inkCount(sl));
      const mmPerPx = sl.geo.image.w / sl.segE.width;
      status((S.mode === 'dots' ? 'Laying out the dots' : 'Tracing the shapes') + label(i) + '…', true);
      const res = await call('layout', {
        seg: segForLayout(sl.segE),
        opts: {
          mode: S.mode,
          dots: { mmPerPx, sizes: DOT_SIZES[get('dotSize')], seed: 3 },
          labels: { mmPerPx },
          outlines: S.mode === 'fill' || S.guides,
          outlinesOpts: { mmPerPx },
        },
      });
      if (my !== gen) return false;
      sl.lay = res;
    }
    return true;
  }

  function geometryFor(i, aspect, keyCount) {
    const title = !!S.title.trim();
    if (mini()) {
      // A wide picture gets a sideways mini page rather than a thin strip across a tall one.
      const wide = aspect > 1.15;
      const M = DotSheet.MINI;
      return DotSheet.geometry({
        size: wide ? { w: M.h, h: M.w } : M, margins: DotSheet.miniMargins(i, wide, +S.margin), compact: true,
        aspect, keyCount, title, footer: false,
      });
    }
    return DotSheet.geometry({
      paper: S.paperSize, orientation: S.orientation, margin: +S.margin,
      aspect, keyCount, title, footer: S.footer,
    });
  }

  // How many picture pixels the smallest dot (plus its gap) covers on paper. Shapes thinner than
  // this can't be drawn in dots, so simplify.js uses it as the finest feature to keep.
  function featurePx(sl, i) {
    const c = sl.crop || { w: sl.src.width, h: sl.src.height };
    const aspect = c.w / c.h;
    const segW = Math.min(Math.round(c.w), aspect >= 1 ? MAX_SIDE : Math.round(MAX_SIDE * aspect));
    const g = geometryFor(i, aspect, get('colors'));
    const mmPerPx = g.image.w / Math.max(1, segW);
    const sizes = S.mode === 'dots' ? DOT_SIZES[get('dotSize')] : [1.6];
    return Math.max(2, (2 * sizes[0] + 0.35) / mmPerPx);
  }

  // The layout only needs the maps and palette, not the preview pixels.
  function segForLayout(s) {
    return { width: s.width, height: s.height, index: s.index, region: s.region, regions: s.regions, palette: s.palette.map(p => ({ hex: p.hex, rgb: p.rgb, lab: p.lab, area: p.area, paper: !!p.paper, poolId: p.poolId || null })) };
  }
  const inkCount = sl => sl.segE.palette.filter(p => !p.paper).length;

  function drawFlat(sl) {
    const cv = $('flat-canvas');
    cv.width = sl.segE.width; cv.height = sl.segE.height;
    cv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(sl.segE.preview), sl.segE.width, sl.segE.height), 0, 0);
  }
  function flatDataUrl(sl) {
    const cv = document.createElement('canvas');
    cv.width = sl.segE.width; cv.height = sl.segE.height;
    cv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(sl.segE.preview), sl.segE.width, sl.segE.height), 0, 0);
    return cv.toDataURL('image/png');
  }

  // ---------- the key ----------
  // One entry per palette index: letter, color, a name to print, and a line for the editor.
  function keyEntries(sl) {
    const letters = PAL.LETTERS[get('letters')] || PAL.LETTERS.flowart;
    const markers = pool();
    const byId = new Map(markers.map(m => [m.id, m]));
    const suggest = S.source === 'markers' ? null : markers;
    const sLabs = suggest ? suggest.map(m => DC.hexToLab(m.hex)) : null;
    // A Mini Express marker keeps the letter its pad prints for it (unless plain A B C is chosen);
    // every other color takes the next unused letter in the set.
    const kitLetter = c => {
      if (get('letters') === 'alpha' || !c.poolId) return null;
      const mk = byId.get(c.poolId);
      return mk && mk.letter;
    };
    const taken = new Set();
    const fixed = sl.segE.palette.map(c => {
      const L = !c.paper && kitLetter(c);
      if (!L || taken.has(L)) return null;
      taken.add(L);
      return L;
    });
    let n = 0;
    const nextLetter = () => {
      while (n < letters.length && taken.has(letters[n])) n++;
      const L = letters[n] || String(n + 1);
      taken.add(L);
      n++;
      return L;
    };
    const entries = sl.segE.palette.map((c, i) => {
      if (c.paper) return null;
      const letter = fixed[i] || nextLetter();
      const m = c.poolId ? byId.get(c.poolId) : null;
      let name, sub;
      if (m) { name = c.name || m.name; sub = m.set; }
      else {
        name = c.name || DotEdit.colorName(c.lab);
        sub = c.hex;
        if (sLabs && sLabs.length) {
          const near = DC.nearest(c.lab, sLabs);
          const mk = suggest[near.index];
          sub = `closest: ${mk.name} (${mk.set})${near.dE > 12 ? ', not close' : ''}`;
        }
      }
      return { letter, hex: c.hex, name, sub, ink: DC.inkOn(c.hex), key: c.key, L: c.lab[0] };
    });
    return distinctNames(entries);
  }

  /* On a black-and-white print the names are all that tell two letters apart, so no two may
   * match: two oranges become "Light orange" and "Dark orange", three or more get numbers too. */
  function distinctNames(entries) {
    const groups = new Map();
    entries.forEach(e => { if (e) { const k = e.name.toLowerCase(); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(e); } });
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      list.sort((a, b) => b.L - a.L);
      const base = list[0].name.replace(/^(Pale|Light|Dark) /i, '');
      const low = base.charAt(0).toLowerCase() + base.slice(1);
      if (list.length === 2) {
        list[0].name = 'Light ' + low;
        list[1].name = 'Dark ' + low;
      } else {
        list.forEach((e, i) => { e.name = `${base} ${i + 1}${i === 0 ? ' (lightest)' : i === list.length - 1 ? ' (darkest)' : ''}`; });
      }
    }
    return entries;
  }

  function renderKeyEditor() {
    const sl = cur();
    const entries = keyEntries(sl);
    const ol = $('key-rows');
    ol.textContent = '';
    const markers = pool();
    const edit = () => changed('edits', 0, [active]);
    entries.forEach(k => {
      if (!k) return;
      const li = document.createElement('li');
      li.className = 'key-row';
      const L = document.createElement('span'); L.className = 'key-letter'; L.textContent = k.letter;
      const sw = document.createElement('input');
      sw.type = 'color'; sw.value = k.hex; sw.className = 'key-sw'; sw.title = 'Pick any color for ' + k.letter;
      sw.addEventListener('change', () => { sl.edits[k.key] = { hex: sw.value, name: DotEdit.colorName(DC.hexToLab(sw.value)) }; edit(); });
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
      if (sl.edits[k.key]) { const o = document.createElement('option'); o.value = 'reset'; o.textContent = 'Undo change'; sel.append(o); }
      sel.addEventListener('change', () => {
        const v = sel.value;
        if (v.startsWith('m:')) {
          const m = markers.find(x => x.id === v.slice(2));
          sl.edits[k.key] = { hex: m.hex, name: m.name, poolId: m.id };
        } else if (v.startsWith('g:')) sl.edits[k.key] = { mergeInto: v.slice(2) };
        else if (v === 'reset') delete sl.edits[k.key];
        else return;
        edit();
      });
      li.append(L, sw, nm, sel);
      ol.append(li);
    });
    $('key-edit').hidden = false;
    $('key-title').textContent = mini() ? `Key, page ${active + 1}` : 'Key';
    const ed = Object.keys(sl.edits).length;
    const note = $('key-note');
    note.textContent = ed
      ? `${ed} change${ed === 1 ? '' : 's'} made. `
      : 'Click a swatch for any color, or use Change… to swap in another marker or merge two letters.';
    if (ed) {
      const undo = document.createElement('button');
      undo.type = 'button'; undo.className = 'linkish'; undo.textContent = 'Undo all';
      undo.addEventListener('click', () => { sl.edits = {}; edit(); });
      note.append(undo);
    }
  }

  // ---------- render ----------
  let svgPrint = '', svgShown = '', pageSize = null;

  function pageOpts(sl, view) {
    return {
      geometry: sl.geo, key: keyEntries(sl), mode: S.mode, view, printer: S.printer, letterInk: S.ink,
      dots: sl.lay.dots || [], sizes: DOT_SIZES[get('dotSize')], labels: sl.lay.labels ? sl.lay.labels.labels || [] : [],
      outlines: sl.lay.outlines ? sl.lay.outlines.d : '', guides: S.guides, rings: S.rings,
      title: S.title.trim(), credit: 'jkastl.github.io/dot-sheets', seed: 5,
      fillPreview: view === 'finished' && S.mode === 'fill' ? flatDataUrl(sl) : null,
    };
  }

  function sheetFor(view) {
    if (!mini()) return DotSheet.build(pageOpts(slots[0], view));
    const pages = slots.map(sl => (sl.src && sl.lay ? pageOpts(sl, view) : null));
    return DotSheet.sheet4(pages, { margin: +S.margin, ruler: S.footer });
  }

  function render() {
    const used = usedSlots().filter(i => slots[i].lay);
    if (!used.length) { renderEmpty(); return; }
    pageSize = mini() ? DotSheet.PAGES.letter : slots[0].geo.page;
    svgPrint = sheetFor('print');
    svgShown = S.view === 'print' ? svgPrint : sheetFor('finished');
    const paper = $('paper');
    paper.innerHTML = svgShown;
    paper.hidden = false;
    $('empty').hidden = true;
    fitPaper();
    $('print-root').innerHTML = svgPrint;
    $('page-size').textContent = `@page { size: ${pageSize.w}mm ${pageSize.h}mm; margin: 0; }`;
    ['print', 'dl-svg', 'dl-png'].forEach(id => { $(id).disabled = false; });
    $('print-tip').hidden = false;
    if (cur().segE) renderKeyEditor(); // the letter set may have changed
    let n = 0, colors = 0;
    for (const i of used) {
      const sl = slots[i];
      n += S.mode === 'dots' ? (sl.lay.dots || []).length : (sl.lay.labels ? sl.lay.labels.labels.length : 0);
      colors = Math.max(colors, inkCount(sl));
    }
    const what = S.mode === 'dots' ? 'dots' : 'shapes';
    status(mini()
      ? `${used.length} of 4 minis · ${n.toLocaleString()} ${what} · ≤${colors} colors`
      : `${n.toLocaleString()} ${what} · ${colors} colors · ${DotSheet.PAGES[slots[0].geo.page.paper].label} ${slots[0].geo.page.orientation}`);
  }

  function renderEmpty() {
    $('paper').hidden = true;
    $('empty').hidden = false;
    $('print-root').innerHTML = '';
    ['print', 'dl-svg', 'dl-png'].forEach(id => { $(id).disabled = true; });
    $('print-tip').hidden = true;
    status('');
  }

  // Fit the page in the preview box; a click zooms in for a closer look.
  let zoom = false;
  function fitPaper() {
    if (!pageSize) return;
    const wrapEl = $('paper-wrap'), paper = $('paper');
    const W = wrapEl.clientWidth - 40, H = wrapEl.clientHeight - 40;
    const s = Math.min(W / pageSize.w, H / pageSize.h) * (zoom ? 2.6 : 1);
    paper.style.width = Math.round(pageSize.w * s) + 'px';
    paper.style.height = Math.round(pageSize.h * s) + 'px';
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
  const fileBase = () => {
    const base = S.title.trim() || slots[0].name || cur().name || 'dot-sheet';
    return (base.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'dot-sheet') + (mini() ? '-minis' : '');
  };
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  const suffix = () => (S.view === 'print' ? '' : '-finished');
  $('print').addEventListener('click', () => window.print());
  $('dl-svg').addEventListener('click', () => {
    download(new Blob([svgShown], { type: 'image/svg+xml' }), fileBase() + suffix() + '.svg');
  });
  $('dl-png').addEventListener('click', () => {
    const dpi = 300, w = Math.round(pageSize.w / 25.4 * dpi), h = Math.round(pageSize.h / 25.4 * dpi);
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svgShown], { type: 'image/svg+xml' }));
    const before = $('status').textContent;
    status('Making a 300 dpi PNG…', true);
    img.onload = () => {
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      cv.toBlob(b => { download(b, fileBase() + suffix() + '.png'); status(before); }, 'image/png');
    };
    img.onerror = () => { URL.revokeObjectURL(url); status('Couldn’t make the PNG in this browser. Try SVG or Print.'); };
    img.src = url;
  });

  renderSets();
  // Returning visitors have already picked their kits: keep the long list folded away.
  if (returning && S.owned.length) $('sets-details').open = false;
  renderSlotBar();
})();
