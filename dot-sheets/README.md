# Dot Sheets

Turn any picture into a printable dot-by-letter page, the kind found in Lifelines FlowArt kits: rows
of small gray letters that you cover with marker dots, pressing firmly on big letters and tapping
lightly on small ones, until the picture shows up.

**[jkastl.github.io/dot-sheets](https://jkastl.github.io/dot-sheets/)**

[![Dot Sheets tests](https://github.com/jkastl/jkastl.github.io/actions/workflows/dot-sheets-tests.yml/badge.svg)](https://github.com/jkastl/jkastl.github.io/actions/workflows/dot-sheets-tests.yml)

Not made by or affiliated with Lifelines. Everything runs in the browser and the picture never
leaves the computer.

## What it does

Two formats:

- **Full page**: one picture on an 8½ × 11 in page, 8 colors and the letters B D F G H V X Z,
  like the full-size kits.
- **4 minis per sheet**: four 4¼ × 5½ in pages on one Letter sheet with cut marks, like FlowArt
  Mini pads: 5 colors, the letters F G H X Z, finer dots. Each mini can hold its own picture, or
  use one picture on all four. A wide picture's mini is turned sideways so it fills its quarter.

Then:

1. **Picture.** Upload, drop, or paste a picture (or try one of the three painted samples), and
   drag on the thumbnail to crop. The picture gets cut down to a few flat, bold shapes, like a
   cartoon of it. **Detail** runs from a poster of a few big shapes to a busier page. **Colors** caps
   the number of letters, **Cartoon punch** pushes saturation and contrast first, and **Outlines**
   draws eyes, noses and edges as a single row of dark dots, the way kit pages outline a pet.
2. **Colors.** Either
   - **My markers**: tick the kits you own: 17 full-size FlowArt Dot-by-Letter kits and 6 Mini
     Express pads (Snow Day, In Full Bloom, Paws and Purrs, Cozy Comforts, Nature Walk, Merry
     Moments) are built in. Mini Express pads print a fixed letter for each color, and a page
     made from their markers keeps those letters. Snow Day, In Full Bloom and Paws and Purrs are ticked by
     default. The page
     uses the best few of their colors for this picture, or all of them. Click a color dot to drop
     one marker (dried out, lost), or add any other marker by color and name.
   - **Match the picture**: the colors that suit the picture best, whatever you own. The key
     suggests your closest marker for each.

   Then the **key** can be edited: click a swatch for any color, swap in another marker, or merge
   two letters into one. Letters default to the kits' **B D F G H V X Z** (shapes that stay
   distinct printed tiny and pale), or plain A B C.
3. **Page.** **Dot by letter** is the kit style. **Color by letter** is an outlined
   paint-by-number page with one letter per shape, for regular markers or pencils. Paper size,
   orientation, dot size, margin, letter shade, a title, faint shape outlines and dot-size rings
   are all settings.

**Finished look** previews the page fully dotted. **Print…** always prints the printable page.
**SVG** and **PNG** (300 dpi) save whichever view is showing.

## Printing on an older printer

The page is built for a desktop and a basic USB printer:

- It's vector (SVG text and shapes), so it prints sharp at any resolution and stays a few hundred
  KB even with 4,000 letters. A raster page that size would be tens of MB for the driver to chew.
- Margins are drawn into the page, ½ inch by default, with ¾ inch for printers that can't reach
  near the edge. The print stylesheet sets `@page { margin: 0 }` with the exact paper size, so the
  browser adds nothing of its own.
- A 50 mm ruler in the footer shows whether the print came out scaled. Print at 100% / Actual size.
- **Black & white** (the default) prints only grays: the key circles are left blank to test-dot
  each marker, like the kits. **Color** fills them in as a reminder.
- **Letter shade** defaults to dark gray, which a black-and-white printer prints crisply. Lighter
  grays hide better under pale markers but get halftoned into ragged dots on older printers. Black
  is for a faint or worn cartridge.

## How it works

`simplify.js` turns the picture into a segmentation: a palette index and a region id per pixel.
It area-averages the picture down to at most 480 px, converts to CIELAB, boosts chroma and contrast,
and flattens texture with an edge-preserving filter. A saliency map (how far each pixel is from
the border colors, a center bias, edge density) marks the subject, so the subject gets most of the
colors and keeps smaller details while the background is simplified harder. Colors are clustered
with seeded k-means++. In marker mode the clusters are then mapped onto the owned markers. The
picture's lightness range is first stretched onto the markers', and neighboring shapes that clearly
differ are kept on different markers. Dark feature lines (a difference-of-Gaussians filter) are
burned in with the darkest ink. Finally every region thinner than one dot, or smaller than the
Detail threshold, is merged into a neighbor, which leaves only flat, bold shapes. The page tells it
how big one dot is in picture pixels, so it never keeps a shape too thin to dot.

`layout.js` places the letters in millimetres on the page. Each region gets an exact Euclidean
distance transform. Rows of dots follow iso-lines of that distance, so they run parallel to the
shape's outline the way kit pages do: a row of small dots traces every edge, and bigger dots fill
the middles in rings. A spatial hash keeps every pair of dots apart by at least the gap. It also
finds each region's pole of inaccessibility for color-by-letter labels, and traces shared region
boundaries once each into smoothed Bézier outlines.

`sheet.js` draws the page as an SVG string in millimetres: the key row at the top (circle, letter,
color name), the picture, and the footer ruler. `edit.js` applies key edits (recolor, merge) and
re-labels regions. `palettes.js` holds the kit colors. `ui.js` runs the pipeline. The two heavy
steps run in a Web Worker (`worker.js`) when the page is served over http, and on the page's own
thread when opened from `file://`.

### Where the kit colors come from

Mini Express pads (5 markers, 15 scenes, sold at Target and Walmart) aren't on lifelines.com.
Their colors were sampled from the dotted ink in Target's close-up product photos, and their letters
read off the key printed on their pages.

Lifelines doesn't publish ink colors or names. Each kit's eight hex values were sampled from the
colored dots on the marker caps in the product photos on lifelines.com (November 2026). A handful
the sampler missed were read by eye and are marked as estimates (dashed in the picker). The color
names are ours. Photo colors drift from real ink, and metallic inks have no single flat color, so
treat them as close, and edit any that look off next to the real marker. The kits themselves don't
fix a color per letter: you fill in the key on each page, which is what the key here is for.

## Running it

No build step, no dependencies. Serve the repo root and go to `/dot-sheets/`:

```sh
python3 -m http.server
```

Tests use Node's built-in runner (Node 20 or later):

```sh
node --test 'dot-sheets/test/*.test.js'
```

## Layout

```
index.html        page structure and the how-it-works text
style.css         settings column, preview, print stylesheet (base styles in ../shared/base.css)
js/color.js       sRGB / CIELAB, CIEDE2000, seeded RNG
js/palettes.js    the FlowArt kit colors and letter sets
js/simplify.js    picture -> flat, cartoon-like segmentation; no DOM
js/layout.js      dot rows, region labels, outlines, in mm; no DOM
js/edit.js        key edits (recolor, merge) and region relabelling
js/sheet.js       page geometry and the SVG page
js/samples.js     three painted sample pictures (browser only)
js/worker.js      runs simplify and layout off the page's thread
js/ui.js          the page
test/             node:test suites
```

## Versioning

The version and date in the footer of `index.html` are **updated by hand**, the same way as the
rest of the site.
