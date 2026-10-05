# jkastl.github.io

An index of my apps and demos: a list of rows, one per app, opening on a few featured ones and
filtered by tags.

**[jkastl.github.io](https://jkastl.github.io/)**

One file, no build step, no dependencies. The whole site is [`index.html`](index.html),
served from `main`. Commit and push changes directly to `main`; there are no feature branches or
pull requests.

## Adding an app

Copy an existing `<li>` in `<ul id="apps">` and change its values (the app name appears three
times). Keep the tiles in alphabetical order by name.

```html
<li data-tags="sensing health phone">
  <h3 class="name">App Name</h3>
  <p class="desc">One-line description.</p>
  <div class="tags">
    <button type="button" class="tag" data-filter="sensing">Sensing &amp; Signals</button>
    <button type="button" class="tag" data-filter="health">Health</button>
    <button type="button" class="tag flag" data-filter="phone">On a phone</button>
  </div>
  <div class="actions">
    <a class="app" href="/repo-name/" aria-label="Open App Name">Open app →</a>
    <a class="repo" href="https://github.com/jkastl/repo-name" aria-label="Source for App Name">Source</a>
  </div>
</li>
```

Clicking anywhere on the tile, or its "Open app" button, opens the app. The "Source" link opens
the repo, and clicking a tag shows every app with that tag.

`data-tags` is what the filters read; the tag buttons are what visitors see. Keep the two in
sync, in the same order as the filter chips (the `flag` class is only for "On a phone"). A tile
can have no tags at all: leave out `data-tags` and the `<div class="tags">`, and it shows under
All.

A page that lives inside another app (for example the Tolerance exhibits at `/tolerance/vote/`)
gets its own tile too. Point "Open app" at the page, point "Source" at its folder
(`https://github.com/jkastl/tolerance/tree/main/vote`), and end the description with
"Part of Tolerance." Keep the parent app's own tile as well, since its front page ties the pages
together.

For a project that doesn't run on GitHub Pages (a CLI, a native app), drop the "Source" link and
point the main button at the repo instead, so the whole tile opens the source:

```html
<a class="app" href="https://github.com/jkastl/repo-name" aria-label="Source for App Name">View source →</a>
```

## Filters

There's one row of filter chips, and exactly one is selected at a time:

- **Featured** is what the page shows with no URL hash: the tiles with `data-featured="N"` on
  their `<li>`, ordered by `N` (1 comes first). A "Show all apps" button sits under them. To
  change what's featured, move or renumber the attributes.
- **All** shows every tile, alphabetically.
- Every other chip is a tag and shows the tiles whose `data-tags` include it:

| Tag | Chip |
|---|---|
| `data` | Data & ML |
| `error` | Error Correction |
| `sensing` | Sensing & Signals |
| `motion` | Motion & Navigation |
| `health` | Health |
| `privacy` | Privacy & Security |
| `games` | Games |
| `phone` | On a phone |

Featured and All are views, not tags: never put them in `data-tags`. The counts on the chips are
worked out by the page, and a chip with no apps hides itself.

To add a tag, add a chip to `<div class="filters">` (copy a neighbour and change `data-filter`
and the label), then add it to the table above. Keep the row short: a tag that fits one or two
apps, or most of them, doesn't help anyone filter.

The selected filter lives in the URL hash, so it can be linked: `#all`, `#games`, `#data`. Older
links still land somewhere sensible. The v2 section ids (`#learn`, `#systems`, `#sensors`,
`#privacy`, `#fitness`, `#games`, `#printing`) and the v3 combined filters (`#about=health&kind=game`,
`#show=all`) map onto the closest single chip. The mapping is `legacy` and `fromOld` in the script.

With JavaScript off there are no filters and every tile shows in alphabetical order.

## Versioning

The version and date in the footer are **updated by hand**. Nothing bumps them
automatically. Change both in the same commit as the change they describe, following
[semver](https://semver.org/):

- **Patch** (`1.2.0` → `1.2.1`): fixing a typo or tweaking the wording.
- **Minor** (`1.2.0` → `1.3.0`): adding, removing or renaming an app, retagging, adding a tag,
  changing what's featured, or a small visual change.
- **Major** (`1.2.0` → `2.0.0`): a redesign or restructure of the page.

The date is the day of the change, in `YYYY-MM-DD` format.
