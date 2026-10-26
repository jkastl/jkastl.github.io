const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

/* Small fixture content, so the engine is tested on its own whatever the real decks hold. The
 * globals are set before the engine loads, the way the page does it. */
const card = (deck, n, extra) => Object.assign({
  id: `${deck}-${String(n).padStart(2, '0')}`, topic: n % 2 ? 'Joins' : 'Windows', level: (n % 3) + 1,
  q: `Question ${n}`, a: `Answer ${n}`, points: ['one', 'two', 'three'],
}, extra);
const deckA = { id: 'aa', title: 'Deck A', blurb: 'First.', order: 2, cards: [1, 2, 3, 4, 5, 6].map((n) => card('aa', n)), glossary: [{ term: 'zarr', def: 'Chunked arrays.' }] };
const deckB = { id: 'bb', title: 'Deck B', blurb: 'Second.', order: 1, cards: [1, 2, 3].map((n) => card('bb', n)), glossary: [{ term: 'Avro', def: 'A row format.' }] };
const scenario = () => ({
  id: 'sd-01', title: 'Ingest', level: 2, minutes: 35, prompt: 'Design it.',
  clarify: ['How many?'], assumptions: ['1,500 slides/day'],
  nodes: [{ id: 'scan', label: 'Scanners', col: 0 }, { id: 'land', label: 'Landing', col: 1, note: 'a bucket' }],
  edges: [['scan', 'land', 'upload']],
  components: [{ name: 'Bucket', why: 'Cheap.' }], deepDives: [{ q: 'Why?', a: 'Because.' }],
  tradeoffs: [{ choice: 'X vs Y', pro: 'p', con: 'c' }], rubric: ['Covers volume'], redFlags: ['No retries'],
});
const story = () => ({ id: 'st-01', theme: 'Priorities', prompt: 'Tell me about a time two asks collided.', variants: [], listenFor: ['a', 'b', 'c'], pitfalls: ['x', 'y'] });

globalThis.TT_DECKS = [deckA, deckB];
globalThis.TT_SCENARIOS = [scenario()];
globalThis.TT_STORIES = [story()];
require(path.join(__dirname, '..', 'js', 'engine.js'));
const TT = globalThis.TT;
const { DAY, MIN } = TT;
const clone = (x) => JSON.parse(JSON.stringify(x));

test('registry sorts decks by order and tags cards and glossary with their deck', () => {
  assert.deepEqual(TT.decks().map((d) => d.id), ['bb', 'aa']);
  const cards = TT.cards();
  assert.equal(cards.length, 9);
  assert.equal(cards[0].deck, 'bb');
  assert.ok(cards.every((c) => c.id.startsWith(c.deck + '-')));
  assert.equal(deckA.cards[0].deck, undefined, 'cards() must not mutate the content');
  assert.deepEqual(TT.glossary().map((g) => [g.term, g.deck]), [['Avro', 'bb'], ['zarr', 'aa']]);
  assert.equal(TT.scenarios().length, 1);
  assert.equal(TT.stories().length, 1);
});

test('validate passes clean fixtures', () => {
  assert.deepEqual(TT.validate(), []);
});

test('validate catches bad ids, levels, lang pairs and edges', () => {
  const d = clone(deckA);
  d.cards[0].id = 'bb-01';
  d.cards[1].id = d.cards[2].id;
  d.cards[3].level = 4;
  d.cards[4].setup = 'SELECT 1;';
  d.cards[5].codeLang = 'sql';
  const s = scenario();
  s.edges.push(['scan', 'nowhere']);
  const errs = TT.validate({ decks: [d], scenarios: [s], stories: [] });
  const has = (re) => assert.ok(errs.some((e) => re.test(e)), `expected an error matching ${re}\n${errs.join('\n')}`);
  has(/bb-01: id must look like aa-NN/);
  has(/duplicate id aa-03/);
  has(/aa-04: level/);
  has(/aa-05: setupLang is required/);
  has(/aa-06: codeLang is required/);
  has(/edge 1 references unknown node nowhere/);
});

test('validate catches missing fields and bad story ids', () => {
  const d = clone(deckB);
  delete d.cards[0].a;
  d.cards[1].points = [];
  const st = story();
  st.id = 'story-1';
  const errs = TT.validate({ decks: [d], scenarios: [], stories: [st] });
  assert.ok(errs.some((e) => /bb-01: missing a/.test(e)));
  assert.ok(errs.some((e) => /bb-02: points/.test(e)));
  assert.ok(errs.some((e) => /story-1: id must look like st-NN/.test(e)));
});

test('md escapes HTML before adding any markup', () => {
  const html = TT.md('<script>alert("x")</script> & <b>bold</b>');
  assert.ok(!/<script|<b>/.test(html));
  assert.equal(html, '<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &lt;b&gt;bold&lt;/b&gt;</p>');
  assert.equal(TT.md('`<img src=x onerror=alert(1)>`'), '<p><code>&lt;img src=x onerror=alert(1)&gt;</code></p>');
});

test('md handles paragraphs, lists, inline code and bold', () => {
  assert.equal(TT.md('One\nline.\n\nTwo.'), '<p>One line.</p><p>Two.</p>');
  assert.equal(TT.md('Do this:\n- a **b**\n- `c**d**`'), '<p>Do this:</p><ul><li>a <strong>b</strong></li><li><code>c**d**</code></li></ul>');
  assert.equal(TT.md('1. first\n2. second\n\nAfter.'), '<ol><li>first</li><li>second</li></ol><p>After.</p>');
  assert.equal(TT.md('- **`a=b`** on'), '<ul><li><strong><code>a=b</code></strong> on</li></ul>');
  assert.equal(TT.md('# not a heading, [not](a link)'), '<p># not a heading, [not](a link)</p>');
  assert.equal(TT.md(''), '');
  assert.equal(TT.plain('Use `COUNT(*)` **once**'), 'Use COUNT(*) once');
});

test('md ignores NUL characters instead of treating them as code-span markers', () => {
  assert.equal(TT.md('a \u00000\u0000 b `c`'), '<p>a 0 b <code>c</code></p>');
});

test('highlight wraps each keyword once, escapes everything, and keeps the text intact', () => {
  const text = (html) => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  const sql = "SELECT COUNT(*) FROM slides s\nWHERE s.stain = 'H&E' AND s.mpp < 0.5 -- <b>full res</b>\nGROUP BY 1;";
  const py = "def tiles(w, h, t=256):\n    return [(x, y) for x in range(0, w, t) if x < w]  # <script>\nimport os";
  for (const [code, lang] of [[sql, 'sql'], [py, 'python'], ['a < b && c', 'bash'], ['<x>', 'text'], ['plain', 'nope']]) {
    const html = TT.highlight(code, lang);
    assert.equal(text(html), code, lang);
    assert.ok(!/<(?!\/?span\b)/.test(html), `only span tags in ${lang}: ${html}`);
  }
  const h = TT.highlight(sql, 'sql');
  assert.ok(h.startsWith('<span class="kw">SELECT</span> COUNT(*) <span class="kw">FROM</span> slides'), h);
  assert.equal((h.match(/<span class="kw">/g) || []).length, 6); // SELECT, FROM, WHERE, AND, GROUP, BY
  assert.match(h, /<span class="cm">-- &lt;b&gt;full res&lt;\/b&gt;<\/span>/);
  assert.match(TT.highlight(py, 'python'), /^<span class="kw">def<\/span> tiles/);
  assert.match(TT.highlight(py, 'python'), /<span class="cm"># &lt;script&gt;<\/span>/);
});

test('rng is deterministic and shuffle is a permutation that leaves its input alone', () => {
  const a = TT.rng(42), b = TT.rng(42);
  const xs = Array.from({ length: 5 }, () => a());
  assert.deepEqual(xs, Array.from({ length: 5 }, () => b()));
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  assert.notDeepEqual(xs, Array.from({ length: 5 }, TT.rng(43)));
  assert.equal(TT.rng('2026-10-26')(), TT.rng('2026-10-26')());
  const arr = [1, 2, 3, 4, 5, 6, 7, 8];
  const s = TT.shuffle(arr, TT.rng(7));
  assert.deepEqual(arr, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual([...s].sort((x, y) => x - y), arr);
  assert.deepEqual(s, TT.shuffle(arr, TT.rng(7)));
});

test('grade follows the Leitner intervals', () => {
  const now = 1_000_000;
  const g0 = TT.grade(undefined, 'good', now);
  assert.deepEqual(g0, { box: 1, due: now + DAY, seen: 1, last: 'good', at: now });
  assert.equal(TT.grade(undefined, 'easy', now).box, 2);
  assert.equal(TT.grade(undefined, 'easy', now).due, now + 3 * DAY);
  const p3 = { box: 3, due: now, seen: 4, last: 'good', at: 0 };
  assert.deepEqual(TT.grade(p3, 'again', now), { box: 1, due: now + 10 * MIN, seen: 5, last: 'again', at: now });
  assert.deepEqual(TT.grade(p3, 'hard', now), { box: 3, due: now + 3.5 * DAY, seen: 5, last: 'hard', at: now });
  assert.equal(TT.grade(p3, 'good', now).due, now + 16 * DAY);
  assert.equal(TT.grade(p3, 'easy', now).box, 5);
  assert.equal(TT.grade({ box: 5, due: 0, seen: 9 }, 'easy', now).due, now + 35 * DAY);
  // Hard on a new card goes to box 1 and waits half a day; never less than ten minutes.
  assert.equal(TT.grade(undefined, 'hard', now).box, 1);
  assert.equal(TT.grade(undefined, 'hard', now).due, now + DAY / 2);
  assert.ok(TT.grade({ box: 0, seen: 1, due: 0 }, 'hard', now).due - now >= 10 * MIN);
  assert.deepEqual(p3, { box: 3, due: now, seen: 4, last: 'good', at: 0 }, 'grade is pure');
  assert.throws(() => TT.grade(p3, 'meh', now));
  assert.deepEqual(TT.preview(p3, now), { again: 10 * MIN, hard: 3.5 * DAY, good: 16 * DAY, easy: 35 * DAY });
  assert.deepEqual(['again', 'hard', 'good', 'easy'].map((g) => TT.fmtWait(TT.preview(undefined, now)[g])), ['10 min', '12 hr', '1 day', '3 days']);
});

test('queue: most overdue first, then unseen interleaved across decks, then the rest only on request', () => {
  const now = 100 * DAY;
  const cards = TT.cards();
  const progress = {
    'aa-01': { box: 2, due: now - 2 * DAY, seen: 2 },
    'aa-02': { box: 1, due: now - 5 * DAY, seen: 1 },
    'bb-01': { box: 1, due: now - DAY, seen: 1 },
    'aa-03': { box: 3, due: now + 3 * DAY, seen: 3 },
    'bb-02': { box: 3, due: now + DAY, seen: 3 },
  };
  const q = TT.queue(cards, progress, { now, seed: 5 });
  assert.deepEqual(q.slice(0, 3).map((c) => c.id), ['aa-02', 'aa-01', 'bb-01']);
  const fresh = q.slice(3);
  assert.deepEqual(fresh.map((c) => c.id).sort(), ['aa-04', 'aa-05', 'aa-06', 'bb-03']);
  // Interleaved: the one unseen bb card is in the first two unseen slots, not left to the end.
  assert.ok(fresh.findIndex((c) => c.deck === 'bb') <= 1);
  assert.deepEqual(q.map((c) => c.id), TT.queue(cards, progress, { now, seed: 5 }).map((c) => c.id), 'same seed, same order');
  // Not-due cards only with includeNotDue, soonest first.
  const all = TT.queue(cards, progress, { now, seed: 5, includeNotDue: true });
  assert.deepEqual(all.slice(-2).map((c) => c.id), ['bb-02', 'aa-03']);
  assert.equal(TT.queue(cards, progress, { now, limit: 2 }).length, 2);
  // Filters.
  assert.ok(TT.queue(cards, progress, { now, decks: ['bb'] }).every((c) => c.deck === 'bb'));
  assert.ok(TT.queue(cards, {}, { now, levels: [3] }).every((c) => c.level === 3));
  assert.ok(TT.queue(cards, {}, { now, topics: ['Joins'] }).every((c) => c.topic === 'Joins'));
});

test('coverage counts seen, solid, learning and due per deck and in total', () => {
  const now = 10 * DAY;
  const cards = TT.cards();
  const progress = {
    'aa-01': { box: 3, due: now + DAY, seen: 3 },
    'aa-02': { box: 1, due: now - 1, seen: 1 },
    'bb-01': { box: 5, due: now, seen: 6 },
  };
  const cov = TT.coverage(cards, progress, now);
  assert.deepEqual(cov.decks.aa, { total: 6, seen: 2, solid: 1, learning: 1, unseen: 4, due: 1 });
  assert.deepEqual(cov.decks.bb, { total: 3, seen: 1, solid: 1, learning: 0, unseen: 2, due: 1 });
  assert.deepEqual(cov.total, { total: 9, seen: 3, solid: 2, learning: 1, unseen: 6, due: 2 });
});

test('round stratifies across decks and is reproducible', () => {
  const cards = TT.cards();
  const r = TT.round(cards, 4, 9);
  assert.equal(r.length, 4);
  assert.equal(new Set(r.map((c) => c.id)).size, 4);
  assert.equal(r.filter((c) => c.deck === 'aa').length, 2);
  assert.equal(r.filter((c) => c.deck === 'bb').length, 2);
  assert.deepEqual(r.map((c) => c.id), TT.round(cards, 4, 9).map((c) => c.id));
  // Once a deck runs out, the rest come from the others.
  const big = TT.round(cards, 8, 3);
  assert.equal(big.filter((c) => c.deck === 'bb').length, 3);
  assert.equal(TT.round(cards, 50, 1).length, 9);
});

test('estimate: pyramid for 100000 × 80000 px in 256 px tiles', () => {
  const lv = TT.pyramid(100000, 80000, 256);
  assert.equal(lv.length, 10);
  assert.deepEqual([lv[0].cols, lv[0].rows, lv[0].tiles], [391, 313, 122383]);
  assert.deepEqual([lv[1].width, lv[1].height, lv[1].tiles], [50000, 40000, 196 * 157]);
  assert.deepEqual([lv[9].width, lv[9].height, lv[9].tiles], [196, 157, 1]);
  const total = lv.reduce((s, l) => s + l.tiles, 0);
  assert.equal(total, 163539);
  // Each level holds about a quarter of the one below, so the pyramid adds about a third.
  assert.ok(total / lv[0].tiles > 1.3 && total / lv[0].tiles < 1.36);
  assert.equal(TT.pyramid(200, 100, 256).length, 1);
  assert.equal(TT.pyramid(512, 512, 256).length, 2);
});

test('estimate: storage, bandwidth and GPU time', () => {
  const e = TT.estimate({ slidesPerDay: 1500, gbPerSlide: 1.5, scanHours: 16, years: 10, copies: 2, width: 100000, height: 80000, tile: 256, tilesPerSec: 400 });
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9 * Math.max(1, Math.abs(b)), `${a} vs ${b}`);
  near(e.tbPerDay, 2.25);
  near(e.pbRetained, (2.25 * 365 * 10 * 2) / 1000); // 16.425 PB
  near(e.mbPerSec, (1500 * 1.5 * 1000) / (16 * 3600)); // about 39 MB/s
  assert.equal(e.levelCount, 10);
  assert.equal(e.fullResTiles, 122383);
  assert.equal(e.tilesPerSlide, 163539);
  near(e.gpuHoursPerDay, (1500 * 122383) / 400 / 3600); // about 127 GPU-hours
  assert.equal(e.gpusAllDay, 6);
  // Defaults fill gaps, and nonsense never produces NaN or Infinity.
  assert.deepEqual(TT.estimate({}), TT.estimate(TT.ESTIMATE_DEFAULTS));
  const bad = TT.estimate({ slidesPerDay: 'x', scanHours: 0, tile: 0, tilesPerSec: -1 });
  for (const k of ['tbPerDay', 'pbRetained', 'mbPerSec', 'gpuHoursPerDay', 'tilesPerSlide']) assert.ok(Number.isFinite(bad[k]), k);
});

test('dump and load round-trip, drop unknown cards, and survive garbage', () => {
  const st = TT.fresh();
  st.progress['aa-01'] = TT.grade(undefined, 'good', 5);
  st.progress['zz-99'] = TT.grade(undefined, 'good', 5);
  st.rubric['sd-01'] = { checked: [0, 2], at: 7 };
  st.stories['st-01'] = { s: 'S', t: 'T', a: 'A', r: '' };
  st.prefs = { round: { n: 10 } };
  const json = TT.dump(st);
  assert.equal(JSON.parse(json).v, 1);
  const back = TT.load(json);
  assert.deepEqual(back.progress, { 'aa-01': st.progress['aa-01'] });
  assert.deepEqual(back.rubric, st.rubric);
  assert.deepEqual(back.stories, st.stories);
  assert.deepEqual(back.prefs, st.prefs);
  // Explicit card ids win over the loaded content.
  assert.deepEqual(Object.keys(TT.load(json, ['zz-99']).progress), ['zz-99']);
  for (const junk of ['', 'null', '[]', '{', '{"v":2,"progress":{}}', '"hi"', '{"v":1,"progress":7}']) {
    assert.deepEqual(TT.load(junk), TT.fresh(), junk);
  }
  // Hostile or sloppy keys and values never reach the state's prototype or inflate a score.
  const evil = TT.load('{"v":1,"progress":{"__proto__":{"box":1,"due":1}},"rubric":{"__proto__":{"checked":[0]},"sd-01":{"checked":[1,1,1,"2",-1,0.5,3]}},' +
    '"stories":{"__proto__":{"s":"x"},"st-01":{"s":7,"t":"T"}},"prefs":{"__proto__":{"a":1},"drill":{"level":2},"bote":[1],"x":"y"}}');
  assert.equal(Object.getPrototypeOf(evil.rubric), Object.prototype);
  assert.equal(Object.getPrototypeOf(evil.stories), Object.prototype);
  assert.equal(Object.getPrototypeOf(evil.prefs), Object.prototype);
  assert.deepEqual(evil.progress, {});
  assert.deepEqual(evil.rubric, { 'sd-01': { checked: [1, 3], at: 0 } });
  assert.deepEqual(evil.stories, { 'st-01': { s: '', t: 'T', a: '', r: '' } });
  assert.deepEqual(evil.prefs, { drill: { level: 2 } });
  assert.equal({}.checked, undefined);
  const mixed = TT.load(JSON.stringify({ v: 1, progress: { 'aa-01': { box: 9, due: 1 }, 'aa-02': { box: 2, due: 'soon' }, 'aa-03': { box: 2, due: 5, seen: 2, last: 'good', at: 1 } } }));
  assert.deepEqual(Object.keys(mixed.progress), ['aa-03']);
});

test('storiesMd exports every story with the notes it has', () => {
  const md = TT.storiesMd(TT.stories(), { 'st-01': { s: 'Two asks.', t: '', a: 'Ranked them.', r: '' } }, '2026-10-26');
  assert.match(md, /^# Tile to Table: story notes/);
  assert.match(md, /## st-01 · Priorities/);
  assert.match(md, /\*\*Situation\.\*\* Two asks\./);
  assert.match(md, /\*\*Action\.\*\* Ranked them\./);
  assert.ok(!/\*\*Task\.\*\*/.test(md));
  assert.match(TT.storiesMd(TT.stories(), {}), /_No notes yet\._/);
});
