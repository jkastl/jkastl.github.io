# Tile to Table

From glass slide to warehouse table, out loud. A self-study deck for data engineering where the
source data is whole-slide images: SQL over cases and scans, batch and streaming, orchestration and
delivery, analytics and ML, and the lab and imaging plumbing around a slide scanner.

**[jkastl.github.io/tile-to-table](https://jkastl.github.io/tile-to-table/)**

[![Tile to Table tests](https://github.com/jkastl/jkastl.github.io/actions/workflows/tile-to-table-tests.yml/badge.svg)](https://github.com/jkastl/jkastl.github.io/actions/workflows/tile-to-table-tests.yml)

Everything is synthetic. The SQL cards share one made-up schema (patients, cases, slides, scanners,
scan events, annotations, model runs, sign-outs), and every number in an example is invented. There's
no backend: progress lives in your browser's `localStorage` under `tt.v1`, and the page works without
it. The page is unlisted (`noindex`).

## What's on the page

- **Overview.** Totals, and a tile per deck with a stacked bar of solid, learning and unseen cards
  (labelled in text as well as color), what's due, and a button to drill just that deck. Export your
  progress as JSON, import it on another device, or reset.
- **Drill.** Filter by deck, level and topic. Each card shows the prompt and any setup code, with a
  scratch box for your answer that is never saved. Reveal (Space) shows the model answer, reference
  code, key points to tick off, pitfalls and follow-ups. Grade it Again, Hard, Good or Easy (1-4);
  each button shows when you'll see the card next. On a phone the reveal and grade bar sticks to the
  bottom of the screen.
- **Round.** 5, 10 or 15 cards drawn evenly across decks, 2, 3 or 5 minutes each. The answer shows
  when time runs out. The end screen lists each card's grade, the points you ticked and your time.
  Grades count toward the same progress as the drill.
- **Design.** Open-ended system design problems with a clock. Reveal the reference one section at a
  time: clarifying questions, assumptions, a reference flow diagram, components, deep dives,
  trade-offs, a rubric (your score is saved per scenario) and red flags. The diagram is laid out from
  the scenario's nodes and edges by column; on a small screen it scrolls sideways in its own box, and
  the same flow is listed as text under it. Below the list, a **back-of-envelope** calculator works out
  daily volume, storage over retention, upload bandwidth, pyramid levels and tiles per slide, and
  GPU-hours to run a model over every full-resolution tile.
- **Stories.** Prompts about past work. Each has Situation / Task / Action / Result boxes that save as
  you type, a two-minute timer, what to listen for and where these go wrong. Export all your notes as
  one Markdown file.
- **Glossary.** Every deck's terms, searchable.

## How the scheduling works

A Leitner system with six boxes. A new card starts in box 0. The review intervals by box are 0, 1, 3,
7, 16 and 35 days.

| Grade | Box | Next review |
|---|---|---|
| Again | back to 1 | in 10 minutes |
| Hard | stays (at least 1) | half the box's interval, at least 10 minutes |
| Good | up one | that box's interval |
| Easy | up two (5 at most) | that box's interval |

The drill shows due cards first, most overdue first, then new cards shuffled and interleaved across
decks. When nothing is due it offers cards that aren't due yet. Box 3 and up counts as solid.

## Running it

No build step and no dependencies. Serve the repo root and go to `/tile-to-table/`:

```sh
python3 -m http.server
```

Tests use Node's built-in runner (Node 20 or later):

```sh
node --test 'tile-to-table/test/*.test.js'
```

`engine.test.js` runs on small fixture decks of its own: the registry, validation (bad ids, levels,
code/language pairs, diagram edges that point nowhere, missing fields), that the mini-markdown escapes
HTML before adding any markup, that the code highlighter wraps each keyword once and leaves the text
unchanged, the seeded shuffle, every grade's interval, queue order and filters,
coverage counts, stratified rounds, the pyramid and estimator math (100,000 × 80,000 px in 256 px
tiles is 10 levels and 163,539 tiles), saving and loading (including garbage, unknown cards and
`__proto__` keys), and the notes export. `content.test.js` loads the real content the way the page does and checks that it
validates, that every deck has at least 20 cards with sequential ids, that there are at least 5
scenarios and 10 stories, that each diagram has 4-6 columns of 1-4 boxes, that no answer has
unbalanced bold markers, and that every code block highlights back to exactly its own text.

## Adding content

Content files only push plain objects onto globals (`TT_DECKS`, `TT_SCENARIOS`, `TT_STORIES`); they
don't depend on the engine. Prose fields use a small markdown subset rendered by `TT.md()`: paragraphs,
`- ` and `1. ` lists, `` `code` `` and `**bold**`. Everything else, including any HTML, shows as text.
Multi-line code goes in a card's `setup` or `code` field with `setupLang` or `codeLang` (`sql`,
`python`, `bash`, `yaml`, `json` or `text`). Run the tests after any change; `TT.validate()` reports
the problems, and the page logs them to the console too.

## Layout

```
index.html            page shell and the static text of each view
style.css             cards, grade buttons, deck tiles, diagram, timers (base styles in ../shared/base.css)
js/content/*.js       the decks, design scenarios and stories; plain data
js/engine.js          registry, validation, mini-markdown, code highlighting, seeded RNG, scheduling,
                      queues, coverage, rounds, the estimator, save and load; no DOM
js/ui.js              hash routing (#overview, #drill, #round, #design/sd-01, #stories/st-01, #glossary),
                      every view, the diagram layout, keyboard shortcuts, storage
test/                 node:test suite
```

## Versioning

The version and date in the footer of `index.html` are **updated by hand**, the same way as the
rest of the site.
