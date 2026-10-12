const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
require(path.join(__dirname, '..', '..', 'shared', 'tissue.js'));
require(path.join(__dirname, '..', 'js', 'engine.js'));
const T = globalThis.Tissue, OC = globalThis.OC;

const angle = (a, b) => (Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])) * 180) / Math.PI;

// A crowded patch with plenty of both dyes.
const slide = T.makeSlide(1187);
const spot = { x: 18161, y: 4915 };
const SZ = 128, N = SZ * SZ;
const patch = (prof) => T.render(slide, spot.x - 40, spot.y - 40, SZ, SZ, 0.625, prof);

test('eig3 recovers a known symmetric matrix', () => {
  const { values, vectors } = OC.eig3([[4, 1, 0], [1, 3, 0], [0, 0, 1]]);
  assert.ok(values[0] >= values[1] && values[1] >= values[2]);
  for (let k = 0; k < 3; k++) {
    const v = vectors[k];
    const Av = [4 * v[0] + v[1], v[0] + 3 * v[1], v[2]];
    for (let c = 0; c < 3; c++) assert.ok(Math.abs(Av[c] - values[k] * v[c]) < 1e-9);
  }
});

test('unmix inverts mixing exactly', () => {
  const h = T.STAIN_REF.h, e = T.STAIN_REF.e;
  const od = [0, 1, 2].map((c) => 0.7 * h[c] + 0.3 * e[c]);
  const r = OC.unmix(od, h, e, [0, 0]);
  assert.ok(Math.abs(r[0] - 0.7) < 1e-12 && Math.abs(r[1] - 0.3) < 1e-12);
});

// Eosin is the harder one: every pixel has a little hematoxylin in it, so no pixel is pure eosin.
test('Macenko finds the true dye colors at every scanner', () => {
  for (const s of OC.SCANNERS) {
    const p = s.profile;
    const est = OC.macenko(patch(p), N, { white: OC.glassWhite(slide, p) });
    assert.ok(est, s.id);
    assert.ok(angle(est.h, p.h) < 6, `${s.id} hematoxylin off by ${angle(est.h, p.h).toFixed(1)}°`);
    assert.ok(angle(est.e, p.e) < 15, `${s.id} eosin off by ${angle(est.e, p.e).toFixed(1)}°`);
  }
});

test('stronger hematoxylin reads as stronger', () => {
  const base = OC.SCANNERS[0].profile, strong = OC.adjust(base, { hStrength: 1.4 });
  const a = OC.macenko(patch(base), N, { white: OC.glassWhite(slide, base) });
  const b = OC.macenko(patch(strong), N, { white: OC.glassWhite(slide, strong) });
  assert.ok(Math.abs(b.maxH / a.maxH - 1.4) < 0.08, `ratio ${(b.maxH / a.maxH).toFixed(3)}`);
});

test('normalization brings every scanner close to Scanner A', () => {
  const cal = OC.calibrate();
  const norm = (p) => {
    const px = patch(p);
    return OC.normalize(px, N, OC.macenko(px, N, { white: OC.glassWhite(slide, p) }), cal.target);
  };
  const ref = norm(OC.SCANNERS[0].profile);
  const ugly = OC.adjust(T.STAIN_REF, { hStrength: 1.5, eStrength: 0.6, hBlue: 0.7, warm: 1, bright: 0.85 });
  for (const p of [OC.SCANNERS[1].profile, OC.SCANNERS[2].profile, ugly]) {
    const before = OC.deltaE(patch(p), patch(OC.SCANNERS[0].profile), N);
    const after = OC.deltaE(norm(p), ref, N);
    assert.ok(after < before * 0.6 && after < 3.5, `${p.name}: ΔE ${before.toFixed(1)} → ${after.toFixed(1)}`);
  }
});

test('ΔE is zero for identical images, and white is L 100', () => {
  const a = new Uint8ClampedArray([200, 100, 150, 255]);
  assert.equal(OC.deltaE(a, a, 1), 0);
  const w = OC.toLab(255, 255, 255);
  assert.ok(Math.abs(w[0] - 100) < 0.05 && Math.abs(w[1]) < 0.05 && Math.abs(w[2]) < 0.05);
});

test('blur lowers the focus score a lot', () => {
  const px = patch(T.STAIN_REF);
  const sharp = OC.focus(px, SZ, SZ), soft = OC.focus(OC.blur(px, SZ, SZ, 2), SZ, SZ);
  assert.ok(soft < sharp / 8, `${sharp.toFixed(0)} → ${soft.toFixed(0)}`);
});

test('events replay identically', () => {
  const a = OC.processEvent(17, new OC.StainState()), b = OC.processEvent(17, new OC.StainState());
  assert.deepEqual(a.px, b.px);
  assert.equal(a.predRaw, b.predRaw);
  assert.equal(OC.eventMeta(17).hour, OC.eventMeta(17).hour);
});

test('the monitor finds both incidents, at the right scanners, after they happen and not before', () => {
  const m = new OC.Monitor();
  const N = OC.totalEvents();
  for (let i = 0; i < N; i++) m.process(i);
  m.flush();
  const b = m.alerts.filter((a) => a.scanner === 'B');
  const c = m.alerts.filter((a) => a.scanner === 'C');
  assert.ok(b.some((a) => a.metric === 'maxH' && a.dir === 'up' && a.at > 30 && a.at <= 38), JSON.stringify(b));
  assert.ok(c.some((a) => a.metric === 'white' && a.dir === 'down' && a.at > 44 && a.at <= 60), JSON.stringify(c));
  assert.equal(m.alerts.filter((a) => a.scanner === 'A').length, 0, 'no false alarms on the scanner that never changed');
  for (const a of m.alerts) assert.ok(a.at > 24, 'nothing alerts during the baseline');

  // The raw model fails at B after the lot change; the normalized one doesn't.
  const acc = (sid, h0, h1, key) => {
    const evs = m.events.filter((e) => e.scanner === sid && !e.quarantined && e.hour >= h0 && e.hour < h1);
    return evs.filter((e) => e[key] === e.dense).length / evs.length;
  };
  assert.ok(acc('B', 0, 24, 'predRaw') > 0.9);
  assert.ok(acc('B', 36, 72, 'predRaw') < 0.7);
  assert.ok(acc('B', 36, 72, 'predNorm') > 0.9);
  // C's monitor alert comes before its raw accuracy slips.
  const cAlert = c.find((a) => a.metric === 'white');
  assert.ok(acc('C', 44, cAlert.at, 'predRaw') > 0.9);

  // Blurred scans go to rescan; almost no sharp ones do.
  const blurred = m.events.filter((e) => OC.eventMeta(e.i).blurred);
  assert.ok(blurred.every((e) => e.quarantined));
  const sharpQ = m.events.filter((e) => !OC.eventMeta(e.i).blurred && e.quarantined).length;
  assert.ok(sharpQ / N < 0.05, `${sharpQ} sharp scans sent to rescan`);
});
