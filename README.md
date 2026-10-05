# jkastl.github.io

An index of my apps and demos: one grid of tiles, filtered by tags.

**[jkastl.github.io](https://jkastl.github.io/)**

One file, no build step, no dependencies. The whole site is [`index.html`](index.html),
served from `main`. Commit and push changes directly to `main`; there are no feature branches or
pull requests.

## Adding an app

Copy an existing `<li>` in `<ul id="apps">` and change its values (the app name appears three
times). Keep the tiles in alphabetical order by name.

```html
<li data-about="reliability health" data-kind="explainer" data-where="phone">
  <h3 class="name">App Name</h3>
  <p class="desc">One-line description.</p>
  <div class="tags">
    <button type="button" class="tag" data-group="about" data-tag="reliability">Reliability</button>
    <button type="button" class="tag" data-group="about" data-tag="health">Health</button>
    <button type="button" class="tag" data-group="kind" data-tag="explainer">Explainer</button>
    <button type="button" class="tag flag" data-group="where" data-tag="phone">Best on a phone</button>
  </div>
  <div class="actions">
    <a class="app" href="/repo-name/" aria-label="Open App Name">Open app →</a>
    <a class="repo" href="https://github.com/jkastl/repo-name" aria-label="Source for App Name">Source</a>
  </div>
</li>
```

Clicking anywhere on the tile, or its "Open app" button, opens the app. The "Source" link opens
the repo, and clicking a tag filters the grid by it.

The `data-*` attributes are what the filters read. The tag buttons are what visitors see. Keep the
two in sync: every tag in an attribute gets a button, in the order About, Kind, Where (add class
`flag` to Where buttons).

A page that lives inside another app (for example the Tolerance exhibits at `/tolerance/vote/`)
gets its own tile too. Point "Open app" at the page, point "Source" at its folder
(`https://github.com/jkastl/tolerance/tree/main/vote`), and end the description with
"Part of Tolerance." Keep the parent app's own tile as well, since its front page ties the pages
together.

For a project that doesn't run on GitHub Pages (a CLI, a native app), drop the
"Source" link, point the main button at the repo instead so the whole tile
opens the source, and tag it `data-where="local"`:

```html
<a class="app" href="https://github.com/jkastl/repo-name" aria-label="Source for App Name">View source →</a>
```

## Tags

Tags come from a fixed vocabulary in three groups. The filter chips at the top of the page are
written out in the HTML, in this order.

| Group | Attribute | Tags |
|---|---|---|
| About (the topic) | `data-about` | `data` Data & ML, `error` Error Correction, `sensing` Sensing & Signals, `complexity` Complexity, `motion` Motion & Navigation, `health` Health, `privacy` Privacy & Security, `family` Kids & Family, `making` Making |
| Kind (what you do with it) | `data-kind` | `explainer` Explainer, `game` Game, `tool` Tool, `instrument` Instrument |
| Where (optional) | `data-where` | `phone` Best on a phone, `local` Runs on your machine |

Every tile needs at least one About tag and exactly one Kind tag. Where is only for tiles it applies to.
The counts on the chips are worked out by the page, and a chip with no apps hides itself.

To add a new tag, add a chip to its group in `<div class="filters">` (copy a neighbour and change
`data-tag` and the label), then add it to the table above. Prefer reusing an existing tag.

Filters live in the URL hash, so they can be linked: `#about=health`, `#kind=game&where=phone`.
The old section links (`#learn`, `#systems`, `#sensors`, `#privacy`, `#fitness`, `#games`,
`#printing`) still work and redirect to the matching filter; the map is `legacy` in the script.
When a tag is retired or renamed, add it to `renamed` in the script so old links still land
somewhere (`#about=reliability` now opens Error Correction).

## Versioning

The version and date in the footer are **updated by hand**. Nothing bumps them
automatically. Change both in the same commit as the change they describe, following
[semver](https://semver.org/):

- **Patch** (`1.2.0` → `1.2.1`): fixing a typo or tweaking the wording.
- **Minor** (`1.2.0` → `1.3.0`): adding, removing or renaming an app, retagging, adding a tag,
  or a small visual change.
- **Major** (`1.2.0` → `2.0.0`): a redesign or restructure of the page.

The date is the day of the change, in `YYYY-MM-DD` format.
