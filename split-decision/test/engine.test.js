const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
require(path.join(__dirname, '..', 'js', 'engine.js'));
const SD = globalThis.SD;

test('AUC: perfect, reversed, ties and chance', () => {
  assert.equal(SD.auc([0.1, 0.2, 0.8, 0.9], [0, 0, 1, 1]), 1);
  assert.equal(SD.auc([0.9, 0.8, 0.2, 0.1], [0, 0, 1, 1]), 0);
  assert.equal(SD.auc([0.5, 0.5, 0.5, 0.5], [0, 1, 0, 1]), 0.5);
  assert.equal(SD.auc([0.1, 0.4, 0.35, 0.8], [0, 0, 1, 1]), 0.75);
  assert.ok(Number.isNaN(SD.auc([0.1, 0.2], [1, 1])));
});

test('the cohort is a proper hierarchy and replays from its seed', () => {
  const a = SD.makeCohort({ seed: 3 }), b = SD.makeCohort({ seed: 3 });
  assert.deepEqual(a.patches.map((p) => p.id), b.patches.map((p) => p.id));
  assert.deepEqual(Array.from(a.patches[10].x), Array.from(b.patches[10].x));
  const slides = new Map(a.slides.map((s) => [s.id, s]));
  const cases = new Map(a.cases.map((c) => [c.id, c]));
  for (const p of a.patches) {
    const s = slides.get(p.slide);
    assert.equal(s.patient, p.patient);
    assert.equal(cases.get(s.caseId).patient, p.patient);
    assert.equal(p.label, s.label ? 1 : 0);
    if (p.tumor) assert.equal(p.label, 1, 'tumor only on positive slides');
  }
  assert.equal(a.patients.length, SD.SITES.reduce((n, s) => n + s.patients, 0));
  assert.ok(a.patients.some((p) => p.slides > 1), 'some patients have several slides');
});

test('site prevalence comes out roughly as configured', () => {
  const c = SD.makeCohort({ seed: 11 });
  for (const s of SD.SITES) {
    const ps = c.patients.filter((p) => p.site === s.id);
    const rate = ps.filter((p) => p.positive).length / ps.length;
    assert.ok(Math.abs(rate - s.prevalence) < 0.15, `${s.id}: ${rate.toFixed(2)}`);
  }
});

test('splits: patient and site splits never leak, patch and slide splits do', () => {
  const c = SD.makeCohort({});
  for (const s of SD.STRATEGIES) {
    const { train, test } = SD.split(c.patches, s.id);
    assert.equal(train.length + test.length, c.patches.length);
    const leaked = SD.leakedPatients(train, test).length;
    if (s.id === 'patient' || s.id === 'site') assert.equal(leaked, 0, s.id);
    else assert.ok(leaked > 10, `${s.id}: ${leaked}`);
    if (s.id !== 'site') assert.ok(Math.abs(test.length / c.patches.length - 0.2) < 0.06, `${s.id} test share`);
  }
  const { test } = SD.split(c.patches, 'site');
  assert.ok(test.every((p) => p.site === 'C'));
});

test('a split is deterministic: same key, same side, every time', () => {
  const c = SD.makeCohort({});
  const a = SD.split(c.patches, 'patient'), b = SD.split(c.patches, 'patient');
  assert.deepEqual(a.test.map((p) => p.id), b.test.map((p) => p.id));
});

test('normalizing removes each site\'s color and nothing else', () => {
  const c = SD.makeCohort({});
  const n = SD.normalizeSites(c.patches);
  for (const s of SD.SITES) {
    const ps = n.filter((p) => p.site === s.id);
    for (const d of [0, 1, 2, 3]) {
      const m = ps.reduce((a, p) => a + p.x[d], 0) / ps.length;
      assert.ok(Math.abs(m) < 1e-9, `site ${s.id} dim ${d}`);
    }
  }
  for (let d = 4; d < SD.D; d++) assert.equal(n[0].x[d], c.patches[0].x[d]);
  assert.notEqual(n[0].x, c.patches[0].x, 'the original cohort is not modified');
});

test('kNN with k = 1 finds an exact duplicate', () => {
  const c = SD.makeCohort({});
  const train = c.patches.slice(0, 200), q = [train[57]];
  const [r] = SD.knn(train, q, 1);
  assert.equal(r.nearest.id, train[57].id);
  assert.equal(r.score, train[57].label);
});

test('the leaky splits flatter the model and the site split comes closest to a new site', () => {
  // Averaged over a few cohorts so the test is about the pattern, not one draw.
  const seeds = [7, 8, 9];
  const sum = { patch: 0, slide: 0, patient: 0, site: 0, ext: 0, same: 0 };
  for (const seed of seeds) {
    const r = SD.runAll({ seed }, false);
    for (const k of ['patch', 'slide', 'patient', 'site']) sum[k] += r.results[k].patchAuc / seeds.length;
    sum.ext += r.external.patchAuc / seeds.length;
    sum.same += r.results.patch.samePatient / seeds.length;
    assert.equal(r.results.patient.samePatient, 0);
  }
  assert.ok(sum.patch > 0.95, `random patches ${sum.patch.toFixed(3)}`);
  assert.ok(sum.patch > sum.slide && sum.slide > sum.patient && sum.patient > sum.site, JSON.stringify(sum));
  assert.ok(sum.patch - sum.ext > 0.25, 'random patches overstate a new site by a lot');
  assert.ok(sum.patient - sum.ext > 0.08, 'the site shortcut inflates even a clean patient split');
  assert.ok(Math.abs(sum.site - sum.ext) < Math.abs(sum.patient - sum.ext), 'holding out a site is the honest one');
  assert.ok(sum.same > 0.6, `same-patient neighbours ${sum.same.toFixed(2)}`);
});

test('normalizing stain shrinks the gap between a patient split and a new site', () => {
  const gap = (norm) => {
    let g = 0;
    for (const seed of [7, 8, 9]) {
      const r = SD.runAll({ seed }, norm);
      g += (r.results.patient.patchAuc - r.external.patchAuc) / 3;
    }
    return g;
  };
  const raw = gap(false), nrm = gap(true);
  assert.ok(nrm < raw - 0.015, `gap raw ${raw.toFixed(3)} vs normalized ${nrm.toFixed(3)}`);
});

test('with no patient effect and no site effect, patient and patch splits agree', () => {
  const r = SD.runAll({ seed: 7, patient: 0, site: 0 }, false);
  assert.ok(Math.abs(r.results.patch.patchAuc - r.results.patient.patchAuc) < 0.04,
    `${r.results.patch.patchAuc.toFixed(3)} vs ${r.results.patient.patchAuc.toFixed(3)}`);
});
