const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// The real content, loaded in the same order as the page, then checked against the format.
const DECKS = ['sql', 'pipelines', 'platform', 'pathology', 'analytics'];
for (const f of [...DECKS, 'design', 'stories']) require(path.join(__dirname, '..', 'js', 'content', `${f}.js`));
require(path.join(__dirname, '..', 'js', 'engine.js'));
const TT = globalThis.TT;

test('content passes validation', () => {
  const errs = TT.validate();
  assert.deepEqual(errs, [], `${errs.length} problems:\n${errs.join('\n')}`);
});

test('every deck is loaded, in order, with at least 20 cards', () => {
  assert.deepEqual(TT.decks().map((d) => d.id), DECKS);
  for (const d of TT.decks()) assert.ok(d.cards.length >= 20, `${d.id} has ${d.cards.length} cards`);
});

test('card ids are sequential within each deck', () => {
  for (const d of TT.decks()) {
    d.cards.forEach((c, i) => assert.equal(c.id, `${d.id}-${String(i + 1).padStart(2, '0')}`));
  }
});

test('there are at least 5 design scenarios and 10 stories', () => {
  assert.ok(TT.scenarios().length >= 5, `${TT.scenarios().length} scenarios`);
  assert.ok(TT.stories().length >= 10, `${TT.stories().length} stories`);
});

test('scenario diagrams fit the layout: 4-6 columns, 1-4 nodes per column', () => {
  for (const s of TT.scenarios()) {
    const cols = new Map();
    for (const n of s.nodes) cols.set(n.col, (cols.get(n.col) || 0) + 1);
    const max = Math.max(...cols.keys());
    assert.ok(max + 1 >= 4 && max + 1 <= 6, `${s.id} has ${max + 1} columns`);
    for (let c = 0; c <= max; c++) {
      const k = cols.get(c) || 0;
      assert.ok(k >= 1 && k <= 4, `${s.id} column ${c} has ${k} nodes`);
    }
  }
});

test('every prose field renders without leftover markup characters doubling up', () => {
  // Catches unbalanced bold (a stray ** shows up literally) in the fields shown as mini-markdown.
  for (const c of TT.cards()) {
    for (const k of ['q', 'a']) {
      const stray = TT.md(c[k]).replace(/<code>.*?<\/code>/g, '').includes('**');
      assert.ok(!stray, `${c.id}.${k} has an unbalanced **`);
    }
  }
});

test('every setup and reference code block highlights back to exactly its own text', () => {
  const text = (html) => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  for (const c of TT.cards()) {
    for (const [body, lang] of [['setup', 'setupLang'], ['code', 'codeLang']]) {
      if (c[body] != null) assert.equal(text(TT.highlight(c[body], c[lang])), c[body], `${c.id}.${body}`);
    }
  }
});
