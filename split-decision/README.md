# Split Decision

A model that scores 0.98 until you split the data by patient. Four ways to split a cohort of slide
patches, each compared with how the same model does at a hospital it has never seen.

**[jkastl.github.io/split-decision](https://jkastl.github.io/split-decision/)**

[![Slide demos tests](https://github.com/jkastl/jkastl.github.io/actions/workflows/slide-demos-tests.yml/badge.svg)](https://github.com/jkastl/jkastl.github.io/actions/workflows/slide-demos-tests.yml)

All synthetic. 190 patients at three sites, with cases, blocks, slides and 16 patches per slide.
Each patch is a 16-number embedding: site color (four "color" dimensions) + the patient's look +
small per-slide jitter + tumor (six "morphology" dimensions, only on tumor patches) + noise. Labels are
per slide, inherited by every patch. Site A is a referral center (80% positive), Site B a community
hospital (15%), Site C in between.

The model is *k*-nearest neighbours (*k* = 15), because when it memorizes, you can see whom it
copied.

## The four splits

| Split | Default cohort, patch AUC | What goes wrong |
|---|---|---|
| Random patches | about 0.98 | Every patient is on both sides; most test patches' nearest neighbour is the same person |
| Random slides | about 0.87 | Patients with several slides land on both sides |
| By patient | about 0.79 | No leak, but the model learned site color, and site predicts diagnosis |
| Hold out a site | about 0.54 | Closest to reality |
| *Site D, next year* | *about 0.58* | *The truth: a model trained on everything, scored on 120 patients from a new site* |

**Normalize stain color per site** removes each site's average in the color dimensions and shrinks
the gap between the patient split and the new site. The page also shows the patient → case → block
and slide → patch hierarchy with the split key highlighted, the split as a BigQuery query (a
`FARM_FINGERPRINT` hash of the key), and a leakage check that should return zero rows.

## Running it

No build step and no dependencies. Open `index.html`, or serve the repo root and go to
`/split-decision/`.

Tests use Node's built-in runner (Node 20 or later):

```sh
node --test 'split-decision/test/*.test.js'
```

They cover AUC (including ties), the cohort hierarchy and its determinism, site prevalence, that
patient and site splits never leak while patch and slide splits do, split determinism,
normalization, kNN, and, averaged over three cohorts, that the splits come out in the expected order,
that holding out a site is closer to a new site than the patient split is, and that normalization
shrinks that gap.

## Layout

```
index.html        page text and structure
style.css         bars, scatter, hierarchy (base styles in ../shared/base.css)
js/engine.js      cohort, splits, kNN, AUC, external validation, PCA; no DOM
js/ui.js          controls, bars, details, scatter, keys and SQL
test/             node:test suite
```

## Versioning

The version and date in the footer of `index.html` are **updated by hand**, the same way as the
rest of the site.
