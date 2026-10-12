/* Split Decision's engine: a synthetic cohort, four ways to split it, a nearest-neighbour model,
 * and the numbers each split reports. No DOM; the page and the Node tests load the same file.
 * Attaches to globalThis.SD. No other dependencies.
 */
(function (SD) {
  'use strict';

  // ---------- randomness ----------

  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function gauss(r) {
    const u = Math.max(1e-12, r()), v = r();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  // FNV-1a, the same role FARM_FINGERPRINT plays in the SQL on the page.
  SD.fingerprint = function (str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
  };
  SD.rng = rng;

  // ---------- the cohort ----------

  SD.D = 16; // embedding size: what a pretrained image encoder would hand you per patch
  const COLOR = [0, 1, 2, 3]; // dimensions that carry stain color
  const MORPH = [4, 5, 6, 7, 8, 9]; // dimensions where tumor shows up

  SD.SITES = [
    { id: 'A', name: 'Site A', note: 'referral center', patients: 70, prevalence: 0.8 },
    { id: 'B', name: 'Site B', note: 'community hospital', patients: 70, prevalence: 0.15 },
    { id: 'C', name: 'Site C', note: 'academic center', patients: 50, prevalence: 0.5 },
  ];
  SD.NEW_SITE = { id: 'D', name: 'Site D', note: 'next year\'s new partner', patients: 120, prevalence: 0.4 };

  SD.DEFAULTS = { seed: 7, patient: 1.4, site: 2.5, signal: 1.25, tumorShare: 0.6, patches: 16 };

  /* Patients have cases (accessions); cases have blocks; each block gives a slide; each slide
   * gives patches. A patch's embedding is the sum of:
   *   site tint      (color dimensions only; each site's stain and scanner)
   *   patient look   (every dimension; anatomy, age, prep, everything about one person)
   *   slide jitter   (small; that day's section and stain)
   *   tumor          (morphology dimensions; only on tumor patches, only on positive slides)
   *   noise
   * The label is per slide (does it show cancer?), so every patch inherits it, even the
   * ones with no tumor in them: weak labels, as in most real slide datasets. */
  SD.makeCohort = function (opts, sites, idPrefix) {
    const o = Object.assign({}, SD.DEFAULTS, opts);
    sites = sites || SD.SITES;
    const r = rng(SD.fingerprint(`${o.seed}:${idPrefix || ''}`));
    const D = SD.D;
    // The direction tumor moves a patch. It's biology, so it's the same at every site and in
    // every cohort drawn with this seed.
    const dr = rng(SD.fingerprint(`tumor:${o.seed}`));
    const dir = norm(MORPH.map(() => gauss(dr)));
    const tumorDir = new Float64Array(D);
    MORPH.forEach((d, k) => { tumorDir[d] = dir[k]; });
    const patients = [], cases = [], slides = [], patches = [];
    for (const site of sites) {
      const tint = new Float64Array(D);
      const sr = rng(SD.fingerprint(`site:${site.id}:${o.seed}`));
      for (const d of COLOR) tint[d] = gauss(sr) * o.site;
      for (let p = 0; p < site.patients; p++) {
        const pid = `${idPrefix || ''}P${site.id}${String(p).padStart(3, '0')}`;
        const look = Float64Array.from({ length: D }, () => gauss(r) * o.patient);
        const positive = r() < site.prevalence;
        const patient = { id: pid, site: site.id, positive, slides: 0 };
        patients.push(patient);
        const nCases = r() < 0.3 ? 2 : 1;
        for (let c = 0; c < nCases; c++) {
          const cid = `${pid}-S26-${String(Math.floor(r() * 9000) + 1000)}`;
          cases.push({ id: cid, patient: pid });
          const nBlocks = r() < 0.5 ? 2 : 1;
          for (let b = 0; b < nBlocks; b++) {
            const sid = `${cid}-A${b + 1}`;
            // A positive patient's blocks don't all contain tumor.
            const label = positive && (b === 0 || r() < 0.6);
            const slide = { id: sid, patient: pid, caseId: cid, site: site.id, label };
            slides.push(slide);
            patient.slides++;
            const jitter = Float64Array.from({ length: D }, (_, d) => (COLOR.includes(d) ? gauss(r) * 0.25 : 0));
            for (let k = 0; k < o.patches; k++) {
              const tumor = label && r() < o.tumorShare;
              const x = new Float64Array(D);
              for (let d = 0; d < D; d++) {
                x[d] = tint[d] + look[d] + jitter[d] + gauss(r) + (tumor ? tumorDir[d] * o.signal * 2.2 : 0);
              }
              patches.push({ id: `${sid}-${String(k).padStart(2, '0')}`, slide: sid, patient: pid, site: site.id, label: label ? 1 : 0, tumor, x });
            }
          }
        }
      }
    }
    return { opts: o, patients, cases, slides, patches };
  };

  function norm(v) { const m = Math.hypot(...v); return v.map((x) => x / m); }

  /* Stain normalization's effect on the embedding: remove each site's average color, in the
   * color dimensions only. Morphology is untouched, so no label signal is lost. */
  SD.normalizeSites = function (patches) {
    const by = {};
    for (const p of patches) {
      const s = (by[p.site] = by[p.site] || { n: 0, m: new Float64Array(SD.D) });
      s.n++;
      for (const d of COLOR) s.m[d] += p.x[d];
    }
    return patches.map((p) => {
      const s = by[p.site];
      const x = Float64Array.from(p.x);
      for (const d of COLOR) x[d] -= s.m[d] / s.n;
      return Object.assign({}, p, { x });
    });
  };

  // ---------- splits ----------

  SD.STRATEGIES = [
    { id: 'patch', name: 'Random patches', key: 'patch_id', short: 'Shuffle every patch, 80/20.' },
    { id: 'slide', name: 'Random slides', key: 'slide_id', short: 'Keep each slide whole, 80/20 by slide.' },
    { id: 'patient', name: 'By patient', key: 'patient_id', short: 'Hash the patient id; 80/20 by patient.' },
    { id: 'site', name: 'Hold out a site', key: 'site_id', short: 'Train on Sites A and B, test on all of Site C.' },
  ];

  // Which patches are test: deterministic in the key, like a hash split in SQL.
  SD.split = function (patches, strategy, seed) {
    const s = seed || 0;
    const h = (k) => SD.fingerprint(`${s}:${k}`) % 10 >= 8;
    const isTest = {
      patch: (p) => h(p.id),
      slide: (p) => h(p.slide),
      patient: (p) => h(p.patient),
      site: (p) => p.site === 'C',
    }[strategy];
    const train = [], test = [];
    for (const p of patches) (isTest(p) ? test : train).push(p);
    return { train, test };
  };

  // Patients on both sides of a split: what the leakage query on the page returns.
  SD.leakedPatients = function (train, test) {
    const a = new Set(train.map((p) => p.patient));
    return [...new Set(test.map((p) => p.patient))].filter((id) => a.has(id));
  };

  // ---------- the model ----------

  /* k nearest neighbours on standardized embeddings. A patch's score is the share of its k
   * closest training patches whose slide was positive. It's the easiest model to read: when
   * the closest training patch is the same patient's, you can see exactly what happened. */
  SD.knn = function (train, test, k) {
    k = k || 15;
    const D = SD.D, n = train.length;
    const mu = new Float64Array(D), sd = new Float64Array(D);
    for (const p of train) for (let d = 0; d < D; d++) mu[d] += p.x[d] / n;
    for (const p of train) for (let d = 0; d < D; d++) sd[d] += (p.x[d] - mu[d]) ** 2 / n;
    for (let d = 0; d < D; d++) sd[d] = Math.sqrt(sd[d]) || 1;
    const Z = new Float64Array(n * D);
    train.forEach((p, i) => { for (let d = 0; d < D; d++) Z[i * D + d] = (p.x[d] - mu[d]) / sd[d]; });
    const labels = Uint8Array.from(train.map((p) => p.label));
    const q = new Float64Array(D);
    const bestD = new Float64Array(k), bestI = new Int32Array(k);
    return test.map((p) => {
      for (let d = 0; d < D; d++) q[d] = (p.x[d] - mu[d]) / sd[d];
      bestD.fill(Infinity);
      bestI.fill(-1);
      for (let i = 0; i < n; i++) {
        let dist = 0;
        const o = i * D;
        for (let d = 0; d < D; d++) { const t = Z[o + d] - q[d]; dist += t * t; }
        if (dist >= bestD[k - 1]) continue;
        let j = k - 1;
        while (j > 0 && bestD[j - 1] > dist) { bestD[j] = bestD[j - 1]; bestI[j] = bestI[j - 1]; j--; }
        bestD[j] = dist;
        bestI[j] = i;
      }
      let pos = 0;
      for (let j = 0; j < k; j++) pos += labels[bestI[j]];
      return { score: pos / k, nearest: train[bestI[0]] };
    });
  };

  // ---------- metrics ----------

  // Area under the ROC curve via ranks (Mann-Whitney U), with ties averaged.
  SD.auc = function (scores, labels) {
    const idx = scores.map((s, i) => i).sort((a, b) => scores[a] - scores[b]);
    const rank = new Float64Array(scores.length);
    for (let i = 0; i < idx.length;) {
      let j = i;
      while (j + 1 < idx.length && scores[idx[j + 1]] === scores[idx[i]]) j++;
      const r = (i + j) / 2 + 1;
      for (let t = i; t <= j; t++) rank[idx[t]] = r;
      i = j + 1;
    }
    let nPos = 0, sumPos = 0;
    labels.forEach((l, i) => { if (l) { nPos++; sumPos += rank[i]; } });
    const nNeg = labels.length - nPos;
    if (!nPos || !nNeg) return NaN;
    return (sumPos - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
  };

  // Slide score: the mean of its patch scores (the simplest multiple-instance pooling).
  SD.slideScores = function (test, preds) {
    const by = new Map();
    test.forEach((p, i) => {
      const s = by.get(p.slide) || { slide: p.slide, label: p.label, sum: 0, n: 0 };
      s.sum += preds[i].score;
      s.n++;
      by.set(p.slide, s);
    });
    return [...by.values()].map((s) => ({ slide: s.slide, label: s.label, score: s.sum / s.n }));
  };

  // Everything one split reports.
  SD.evaluate = function (patches, strategy, opts) {
    const { train, test } = SD.split(patches, strategy, opts && opts.splitSeed);
    const preds = SD.knn(train, test, opts && opts.k);
    const slides = SD.slideScores(test, preds);
    const samePatient = preds.filter((pr, i) => pr.nearest.patient === test[i].patient).length / test.length;
    const sameSite = preds.filter((pr, i) => pr.nearest.site === test[i].site).length / test.length;
    return {
      strategy,
      train: train.length,
      test: test.length,
      leaked: SD.leakedPatients(train, test),
      patchAuc: SD.auc(preds.map((p) => p.score), test.map((p) => p.label)),
      slideAuc: SD.auc(slides.map((s) => s.score), slides.map((s) => s.label)),
      samePatient,
      sameSite,
      sample: test.map((p, i) => ({ p, nearest: preds[i].nearest, score: preds[i].score })),
    };
  };

  /* The truth the splits are trying to predict: train on the whole cohort, then score next
   * year's patients from a site the model has never seen. */
  SD.external = function (cohort, normalized) {
    const fresh = SD.makeCohort(cohort.opts, [SD.NEW_SITE], 'X');
    let train = cohort.patches, test = fresh.patches;
    if (normalized) {
      train = SD.normalizeSites(train);
      test = SD.normalizeSites(test);
    }
    const preds = SD.knn(train, test);
    const slides = SD.slideScores(test, preds);
    return {
      patchAuc: SD.auc(preds.map((p) => p.score), test.map((p) => p.label)),
      slideAuc: SD.auc(slides.map((s) => s.score), slides.map((s) => s.label)),
      slides: slides.length,
      patients: fresh.patients.length,
    };
  };

  SD.runAll = function (opts, normalized) {
    const cohort = SD.makeCohort(opts);
    const patches = normalized ? SD.normalizeSites(cohort.patches) : cohort.patches;
    const results = {};
    for (const s of SD.STRATEGIES) results[s.id] = SD.evaluate(patches, s.id);
    return { cohort, patches, results, external: SD.external(cohort, normalized) };
  };

  // ---------- a 2-D view ----------

  // Top two principal components by power iteration, for drawing the embeddings.
  SD.pca2 = function (xs) {
    const D = SD.D, n = xs.length;
    const mu = new Float64Array(D);
    for (const x of xs) for (let d = 0; d < D; d++) mu[d] += x[d] / n;
    const C = Array.from({ length: D }, () => new Float64Array(D));
    for (const x of xs) for (let a = 0; a < D; a++) { const da = x[a] - mu[a]; for (let b = a; b < D; b++) C[a][b] += da * (x[b] - mu[b]); }
    for (let a = 0; a < D; a++) for (let b = 0; b < a; b++) C[a][b] = C[b][a];
    const comps = [];
    for (let c = 0; c < 2; c++) {
      let v = Float64Array.from({ length: D }, (_, i) => Math.sin(i + 1 + c * 7));
      for (let it = 0; it < 100; it++) {
        const w = new Float64Array(D);
        for (let a = 0; a < D; a++) for (let b = 0; b < D; b++) w[a] += C[a][b] * v[b];
        for (const u of comps) { const dp = w.reduce((s, x, i) => s + x * u[i], 0); for (let i = 0; i < D; i++) w[i] -= dp * u[i]; }
        const m = Math.hypot(...w) || 1;
        v = w.map((x) => x / m);
      }
      comps.push(v);
    }
    return xs.map((x) => comps.map((u) => u.reduce((s, ui, d) => s + ui * (x[d] - mu[d]), 0)));
  };
})(globalThis.SD = globalThis.SD || {});
