/* Runs the heavy steps off the page's thread so sliders stay responsive. The page falls back to
 * running the same functions directly when workers aren't available (e.g. opened from file://). */
importScripts('color.js', 'simplify.js', 'layout.js');

const OPS = {
  simplify: ({ img, opts }) => DotSimplify.simplify(img, opts),
  layout: ({ seg, opts }) => runLayout(seg, opts),
};

function runLayout(seg, o) {
  const out = {};
  if (o.mode === 'dots') out.dots = DotLayout.dots(seg, o.dots);
  else out.labels = DotLayout.labels(seg, o.labels);
  if (o.outlines) out.outlines = DotLayout.outlines(seg, o.outlinesOpts);
  return out;
}

self.onmessage = e => {
  const { id, op, args } = e.data;
  try {
    self.postMessage({ id, ok: true, result: OPS[op](args) });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.stack) || err) });
  }
};
