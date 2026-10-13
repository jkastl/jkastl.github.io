# Stain Drift

Same tissue, three labs, three shades of pink. Color deconvolution, stain normalization, and a
streaming monitor that catches a dye lot change before the model does.

**[jkastl.github.io/stain-drift](https://jkastl.github.io/stain-drift/)**

[![Slide demos tests](https://github.com/jkastl/jkastl.github.io/actions/workflows/slide-demos-tests.yml/badge.svg)](https://github.com/jkastl/jkastl.github.io/actions/workflows/slide-demos-tests.yml)

Everything is synthetic. The tissue comes from [`shared/tissue.js`](../shared/tissue.js), which
computes dye amounts and turns them into color with the Beer-Lambert law, so each scanner's true dye
colors and strengths are known exactly. The estimation, normalization and monitoring code only sees
pixels.

## What's on the page

- **Pull the colors apart, then put them back.** One spot of tissue as four scanners see it (three
  fixed sites and one you set with sliders), before and after Macenko normalization, with the mean
  CIE76 ΔE from Scanner A. An optical-density scatter shows each scanner's pixels and estimated dye
  directions, and a one-dye-at-a-time view shows the deconvolved hematoxylin and eosin channels.
- **Watch three days of scans stream in.** 1,080 scan events from three scanners over 72 simulated
  hours. Each event gets a focus check (variance of the Laplacian; blurred scans go to a rescan
  topic), a Macenko stain estimate with white measured on bare glass, normalization using a
  per-scanner running estimate kept in keyed state, and a model trained at Site A that flags atypical
  nuclei by how darkly they stain. A monitor aggregates 4-hour tumbling windows per scanner, learns a
  baseline on day one, and runs a two-sided CUSUM on hematoxylin strength, hue and glass brightness.

Two things happen that the monitor isn't told about:

| When | What | What the page shows |
|---|---|---|
| Hour 30 | Site B switches to a new hematoxylin lot (stronger, bluer) | Alert within about 2 hours; raw-pixel model accuracy at B drops from 100% to about half |
| Hour 44 on | Scanner C's lamp dims slowly | Alert on glass brightness on day 3, well before the raw-pixel model starts to slip near the end |

With **Normalize at ingest** on, the same scans keep the model at or near 100% everywhere, and the
alerts still fire.

Why a running estimate instead of each patch's own: normalizing a patch with its own stain strength
scales darker nuclei back down, which erases exactly what the model looks for. A scanner's stains
change by lot and by day, not by patch, so the estimate lives per scanner.

## Running it

No build step and no dependencies. Serve the repo root and go to `/stain-drift/`:

```sh
python3 -m http.server
```

Tests use Node's built-in runner (Node 20 or later):

```sh
node --test 'stain-drift/test/*.test.js'
```

They cover the eigen-decomposition and unmixing, that Macenko recovers each scanner's true dye
colors, that it reads stronger hematoxylin as stronger, that normalization brings every scanner close
to Scanner A, focus scoring, event replay, and the full three-day stream: both incidents alert at
the right scanner after they happen, nothing alerts on the scanner that never changed, the raw model
fails at Site B while the normalized one doesn't, Scanner C's alert comes before its accuracy slips,
and blurred scans go to rescan.

## Layout

```
index.html        page text and structure
style.css         scanner panels, charts, feed (base styles in ../shared/base.css)
js/engine.js      stain profiles, Macenko, normalization, ΔE, focus, the model, the stream and monitor; no DOM
js/ui.js          scanner panels, OD scatter, one-dye view, stream playback and charts
test/             node:test suite
```

## Versioning

The version and date in the footer of `index.html` are **updated by hand**, the same way as the
rest of the site.
