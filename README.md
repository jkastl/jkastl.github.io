# jkastl.github.io

An index of my apps and demos, grouped into collapsible sections of tiles.

**[jkastl.github.io](https://jkastl.github.io/)**

One file, no build step, no dependencies. The whole site is [`index.html`](index.html),
served from `main`. Commit and push changes directly to `main`; there are no feature branches or
pull requests.

## Adding an app

Tiles live in collapsible sections (`<details class="group">`), which are closed by default. Pick the
section that fits and copy an existing `<li>` inside its `<ul>`, then change its values (the app name
appears three times):

```html
<li>
  <h3 class="name">App Name</h3>
  <p class="desc">One-line description.</p>
  <div class="actions">
    <a class="app" href="/repo-name/" aria-label="Open App Name">Open app →</a>
    <a class="repo" href="https://github.com/jkastl/repo-name" aria-label="Source for App Name">Source</a>
  </div>
</li>
```

Clicking anywhere on the tile, or its "Open app" button, opens the app. The "Source" link opens
the repo. Keep the tiles in alphabetical order by name within each section, and update the
section's app count in its `<summary>`.

## Adding a section

Copy a whole `<details class="group">` block, give it a new `id`, title, count and one-sentence
description, and put the tiles in its `<ul>`. Leave out the `open` attribute so it starts closed.
Sections can be linked directly by their `id`, for example `#learn`; the link opens that section
and scrolls to it.

For a project that doesn't run on GitHub Pages (a CLI, a native app), drop the
"Source" link and point the main button at the repo instead, so the whole tile
opens the source:

```html
<li>
  <h3 class="name">App Name</h3>
  <p class="desc">One-line description, including where it runs.</p>
  <div class="actions">
    <a class="app" href="https://github.com/jkastl/repo-name" aria-label="Source for App Name">View source →</a>
  </div>
</li>
```

## Versioning

The version and date in the footer are **updated by hand**. Nothing bumps them
automatically. Change both in the same commit as the change they describe, following
[semver](https://semver.org/):

- **Patch** (`1.2.0` → `1.2.1`): fixing a typo or tweaking the wording.
- **Minor** (`1.2.0` → `1.3.0`): adding, removing, renaming or moving an app, adding a section,
  or a small visual change.
- **Major** (`1.2.0` → `2.0.0`): a redesign or restructure of the page.

The date is the day of the change, in `YYYY-MM-DD` format.
