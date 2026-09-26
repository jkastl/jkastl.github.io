# jkastl.github.io

An index of my GitHub Pages apps, shown as a grid of tiles.

**[jkastl.github.io](https://jkastl.github.io/)**

One file, no build step, no dependencies. The whole site is [`index.html`](index.html),
served from `main`. Commit and push changes directly to `main`; there are no feature branches or
pull requests.

## Adding an app

Copy an existing `<li>` in `index.html` and change its values (the app name appears three times):

```html
<li>
  <h2 class="name">App Name</h2>
  <p class="desc">One-line description.</p>
  <div class="actions">
    <a class="app" href="/repo-name/" aria-label="Open App Name">Open app →</a>
    <a class="repo" href="https://github.com/jkastl/repo-name" aria-label="Source for App Name">Source</a>
  </div>
</li>
```

Clicking anywhere on the tile, or its "Open app" button, opens the app. The "Source" link opens
the repo. Keep the tiles in alphabetical order by name.

For a project that doesn't run on GitHub Pages (a CLI, a native app), drop the
"Source" link and point the main button at the repo instead, so the whole tile
opens the source:

```html
<li>
  <h2 class="name">App Name</h2>
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
- **Minor** (`1.2.0` → `1.3.0`): adding, removing, or renaming an app, or a small
  visual change.
- **Major** (`1.2.0` → `2.0.0`): a redesign or restructure of the page.

The date is the day of the change, in `YYYY-MM-DD` format.
