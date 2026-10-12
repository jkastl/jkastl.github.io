# Pyramid Scheme

A six-gigapixel microscope slide you can pan and zoom in the browser, how an image pyramid makes
that possible, and the pipeline that cuts the slide into a training set.

**[jkastl.github.io/pyramid-scheme](https://jkastl.github.io/pyramid-scheme/)**

[![Slide demos tests](https://github.com/jkastl/jkastl.github.io/actions/workflows/slide-demos-tests.yml/badge.svg)](https://github.com/jkastl/jkastl.github.io/actions/workflows/slide-demos-tests.yml)

The slide is synthetic: 24 × 16 mm of glass at 0.25 µm per pixel (96,000 × 64,000 pixels), computed
on demand from a seed by [`shared/tissue.js`](../shared/tissue.js). Nothing is stored, so every tile
"read" is really a render, which takes about as long as a fast network fetch. Nothing is fetched or
sent anywhere.

## What's on the page

- **The viewer.** Ten levels, each half the size of the one below, cut into 256 px tiles. The viewer
  picks the coarsest level that's still sharp, requests the visible tiles centre-first, draws a coarser
  level while they arrive, and cancels requests for tiles you've scrolled away from. Tiles live in an
  LRU cache. Stats show bytes read against the estimated file size (about 870 MB), cache hits,
  cancellations and memory, and a table shows each level's share of the file.
- **From one slide to a training set.** Tissue detection on a 32 µm/px thumbnail: score each pixel
  by saturation or darkness, threshold with Otsu's method (or by hand), and optionally drop marker ink
  with a color rule. Then lay a patch grid over it and keep patches above a minimum tissue fraction.
  Because the slide is generated, every patch is checked against the truth, so the page can count
  kept patches that are really glass or ink, and dropped patches that were solid tissue. The output is
  a manifest of coordinates (downloadable as CSV), not image files.
- **At scale.** Storage, ingest bandwidth and patch counts for a whole lab, from slides per day,
  tissue area, overscan, resolution, scanner hours and retention.

## Running it

No build step and no dependencies. Serve the repo root and go to `/pyramid-scheme/` (the page loads
`../shared/tissue.js`):

```sh
python3 -m http.server
```

Tests use Node's built-in runner (Node 20 or later):

```sh
node --test 'pyramid-scheme/test/*.test.js'
```

They cover tile determinism, that zoomed-out renders match averaged full-resolution pixels, the
pyramid arithmetic, level choice, visible-tile selection, the LRU cache, the file size estimate, Otsu,
the ink rule, that the pen circle gets into the training set until ink is dropped, the manifest
format, and the scale estimates.

## Layout

```
index.html        page text and structure
style.css         viewer, training-set and scale styles (base styles in ../shared/base.css)
js/engine.js      pyramid math, tile cache, tissue mask, patches, manifest, scale; no DOM
js/ui.js          viewer, overview, stats, training-set panel, calculator
test/             node:test suite
```

## Versioning

The version and date in the footer of `index.html` are **updated by hand**, the same way as the
rest of the site: patch for wording or fixes, minor for a new feature or a small visual change, major
for a redesign.
