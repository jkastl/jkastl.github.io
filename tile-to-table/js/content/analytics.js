/* Analytics, ML & BI deck: statistics, ML lifecycle, warehouses, virtualization, BI and custom visual apps. Plain data, loaded by the page and the tests. */
(function () {
  'use strict';
  (globalThis.TT_DECKS = globalThis.TT_DECKS || []).push({
    id: 'analytics',
    title: 'Analytics, ML & BI',
    blurb: 'Statistics, the ML lifecycle, Snowflake and BigQuery, Denodo, BI tools and custom visual apps, explained from the data engineer\'s seat.',
    order: 5,
    cards: [
      {
        id: 'analytics-01',
        topic: 'Turnaround time stats',
        level: 1,
        q: `Routine-case turnaround time (accession to sign-out) shows mean 3.4 days, median 2.1 days, p95 9 days. Why do the numbers differ so much, and which do you put on the dashboard?`,
        a: `Turnaround time is right-skewed: most cases finish quickly, a minority take much longer (recuts, deeper levels, add-on IHC, consults, weekends). The long tail drags the mean up, so the mean describes almost no real case.\n\nReport **percentiles and a service-level share**, not the mean alone:\n\n- p50 is the typical case; p90/p95 show the tail that people actually complain about.\n- "% signed out within target" is the easiest number for an operations lead to act on.\n- Break it out by priority, specimen type and service, because a blended number hides which group is slow.\n\nTwo engineering traps: percentiles are not additive, so you cannot average per-site p95s (recompute from case rows, or merge sketches such as t-digest if you must pre-aggregate). And define the clock: calendar vs business hours, and what happens to cases on hold.`,
        code: `-- Postgres-style syntax; date math and percentile syntax vary by dialect
-- (BigQuery uses PERCENTILE_CONT(...) OVER (...)).
WITH first_signout AS (
  SELECT case_id, MIN(signed_out_at) AS signed_out_at   -- addenda create extra rows
  FROM signouts
  GROUP BY case_id
), tat AS (
  SELECT c.priority,
         EXTRACT(EPOCH FROM (f.signed_out_at - c.received_at)) / 3600.0 AS tat_hours
  FROM cases c
  JOIN first_signout f USING (case_id)
)
SELECT priority,
       COUNT(*)                                              AS n,
       AVG(tat_hours)                                        AS mean_h,
       PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY tat_hours) AS p50_h,
       PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY tat_hours) AS p95_h
FROM tat
GROUP BY priority;`,
        codeLang: 'sql',
        points: [
          'Right-skewed data: mean > median, and the tail drives the mean.',
          'Report p50, p90, p95 and the share within target, stratified by priority/service.',
          'Percentiles cannot be averaged across groups; recompute or use mergeable sketches.',
          'State the clock definition (calendar vs business hours, holds).',
        ],
        followups: [
          'Would you ever report the mean? When is it the right statistic?',
          'How would you compute p95 incrementally for a dashboard over a billion rows?',
        ],
        pitfalls: [
          'Averaging daily p95 values to get a monthly p95.',
          'Joining signouts without collapsing addenda, which duplicates cases and skews the percentiles.',
        ],
      },
      {
        id: 'analytics-02',
        topic: 'Confidence intervals',
        level: 2,
        q: `A scanner failed QC on 12 of 400 slides (3%). Give an approximate 95% confidence interval, say what it does and does not mean, and say how many slides you would need to halve its width.`,
        a: `A Wilson interval gives roughly **1.7% to 5.2%**. The simple normal (Wald) version, p plus or minus 1.96 * sqrt(p(1-p)/n), gives about 1.3% to 4.7% and is less reliable for small rates, which is why Wilson is the safer default.\n\nMeaning: if you repeated the whole sampling procedure many times, about 95% of intervals built this way would contain the true rate. It is not "95% probability the rate is in this range" in the frequentist reading, and it says nothing about slides outside the sampled population (another site, another stain batch).\n\nSample size: the width shrinks with 1/sqrt(n), so halving it takes **4x the slides (about 1,600)**. This is why per-scanner, per-day rates are noisy: 20 slides cannot support a rate comparison.\n\nFor medians and percentiles of turnaround time, use a bootstrap, and resample by **case or patient**, not by slide, because slides within a case are correlated.`,
        points: [
          'Wilson (or exact) intervals beat Wald for small proportions.',
          'Interpretation is about the procedure, not a probability statement about this one interval.',
          'Width scales with 1/sqrt(n): halving needs 4x the data.',
          'Bootstrap for medians and percentiles; resample at the independent unit (case or patient).',
        ],
        followups: [
          'How would you show uncertainty on a dashboard with 50 scanners and little data per scanner?',
          'What changes if slides from the same patient are not independent?',
        ],
        pitfalls: [
          'Treating non-overlapping intervals as the only way to see a difference, or overlapping ones as proof of none.',
          'Resampling slides when the real independent unit is the patient.',
        ],
      },
      {
        id: 'analytics-03',
        topic: 'Hypothesis testing',
        level: 2,
        q: `Someone ran pairwise tests on median turnaround time across 8 scanners and 6 stains and found 3 "significant" differences at p < 0.05. What do you say, and when would you not run a test at all?`,
        a: `That is 28 scanner pairs x 6 stains = **168 tests**. At alpha 0.05 you expect about 8 false positives even if nothing differs, so 3 hits is consistent with noise.\n\nFix the multiplicity: **Holm** (uniformly better than Bonferroni) to control the chance of any false positive, or **Benjamini-Hochberg** to control the false discovery rate when the work is exploratory. Better still, pre-register the few comparisons that matter.\n\nTest choice matters too. Turnaround time is skewed, so use a permutation test or a bootstrap on the median difference (Mann-Whitney tests whether one distribution tends to run longer, which is not quite a median test), not a t-test on means. Slides in the same case or batch are not independent, which inflates significance.\n\nWhen not to test: with millions of rows everything is "significant", so report the **effect size and its interval** instead. For operational monitoring, a control chart or a threshold on practical impact is usually more useful than a p-value.`,
        points: [
          'Count the comparisons; expected false positives = tests x alpha.',
          'Holm for family-wise error, Benjamini-Hochberg for exploratory FDR control.',
          'Pick tests that match skewed, non-independent data.',
          'Large n makes trivial differences significant; report effect size and intervals.',
        ],
        followups: [
          'What does a p-value of 0.03 actually tell you?',
          'How would you design a monitor that flags a scanner that got slower without testing 168 things?',
        ],
        pitfalls: [
          'Slicing the data until something is significant, then reporting only that slice.',
          'Reading "not significant" as "no difference" when the sample was tiny.',
        ],
      },
      {
        id: 'analytics-04',
        topic: 'Simpson\'s paradox',
        level: 2,
        q: `Rescan rate by site, synthetic numbers. Site A: biopsies 1/20, resections 36/180. Site B: biopsies 27/180, resections 6/20. Site A is better in both specimen types, yet worse overall. Explain, and say which comparison you would publish.`,
        a: `Site A: 1/20 = 5% (biopsy), 36/180 = 20% (resection), **37/200 = 18.5%** overall. Site B: 27/180 = 15%, 6/20 = 30%, **33/200 = 16.5%** overall.\n\nThe reversal happens because the **mix differs**: Site A scans mostly resections (the harder specimens, high rescan rate everywhere) and Site B mostly biopsies. The overall rate is a weighted average, and the weights are different.\n\nWhich to publish depends on the question. To judge scanner or process quality, compare **within strata** or use direct standardization (apply one common specimen mix to both sites). To plan capacity at each site, the crude overall rate is the right one because it reflects the workload they really have.\n\nAs a data engineer, make the stratifying columns available (specimen type, stain, scanner model) so analysts can check, and never ship a single site league table with no adjustment note.`,
        points: [
          'The paradox comes from different group mixes behind an aggregate.',
          'Compare within strata or standardize to a common mix.',
          'Which view is right depends on the causal question being asked.',
          'Expose confounders (specimen type, stain, scanner model) as dimensions.',
        ],
        followups: [
          'How would you do direct standardization in SQL?',
          'When is stratifying the wrong move?',
        ],
        pitfalls: [
          'Ranking sites on a crude rate and presenting it as quality.',
          'Stratifying on a variable that is itself an effect of the treatment or process (a collider or mediator).',
        ],
      },
      {
        id: 'analytics-05',
        topic: 'Inter-rater agreement',
        level: 2,
        q: `Two pathologists independently label 100 slides tumor / no tumor. Both say tumor on 40, both say no tumor on 40, and they split 10 and 10 on the rest. Compute Cohen's kappa and explain why raw percent agreement is not enough.`,
        a: `Observed agreement Po = 80/100 = 0.80. Each rater says tumor 50% of the time, so chance agreement Pe = 0.5*0.5 + 0.5*0.5 = 0.50. Kappa = (Po - Pe) / (1 - Pe) = **0.60**.\n\nPercent agreement counts agreement you would get by guessing. Kappa subtracts it. Landis-Koch bands put 0.60 at the top of "moderate" (0.41 to 0.60), just below "substantial" (0.61 to 0.80); such bands are rules of thumb, not standards.\n\nKnow the limits:\n\n- With a rare finding, kappa can be low even when percent agreement is 95% (the prevalence paradox), so always show the confusion table.\n- Ordinal labels (grade groups, HER2 scores 0, 1+, 2+, 3+) need **weighted kappa**; more than two raters need Fleiss' kappa or Krippendorff's alpha; continuous measures such as Ki67 percent need an ICC.\n\nFor ML, inter-rater agreement is the ceiling to compare a model against: a model that matches a single reader at kappa 0.6 is doing as well as readers do with each other.`,
        points: [
          'Kappa = (Po - Pe) / (1 - Pe); here 0.60.',
          'Raw agreement includes chance agreement.',
          'Kappa is prevalence sensitive; publish the table with it.',
          'Weighted kappa for ordinal, Fleiss/Krippendorff for many raters, ICC for continuous.',
        ],
        followups: [
          'How would you store labels so agreement can be computed per slide and per rater?',
          'How would you use rater disagreement when building training labels?',
        ],
        pitfalls: [
          'Reporting percent agreement on a rare finding.',
          'Using unweighted kappa for ordinal grades, which treats a one-step miss like a three-step miss.',
        ],
      },
      {
        id: 'analytics-06',
        topic: 'Sensitivity and PPV',
        level: 2,
        q: `A slide-level classifier was evaluated on this synthetic table (1 = positive). Compute sensitivity, specificity, PPV and NPV, then explain why PPV is low even though sensitivity and specificity look strong, and what PPV would be at other prevalences.`,
        setup: `import pandas as pd\n\n# one row per slide; truth from consensus review, pred from the model at threshold 0.5\ndf = pd.DataFrame({\n    "truth": [1] * 200 + [0] * 9800,\n    "pred":  [1] * 190 + [0] * 10 + [1] * 980 + [0] * 8820,\n})`,
        setupLang: 'python',
        a: `Counts: TP 190, FN 10, FP 980, TN 8,820. Sensitivity = 190/200 = **0.95**, specificity = 8,820/9,800 = **0.90**, PPV = 190/1,170 = **0.162**, NPV = 8,820/8,830 = **0.9989**.\n\nSensitivity and specificity are properties of the test given the truth. PPV and NPV depend on **prevalence**. At 2% prevalence the 9,800 negatives produce 980 false positives, which swamp 190 true positives. By Bayes, PPV = sens*prev / (sens*prev + (1-spec)*(1-prev)): about 0.51 at 10% prevalence and 0.91 at 50%.\n\nSo a number that is fine for a triage tool in a high-prevalence referral lab can be unusable as a screen in a low-prevalence one. Always report prevalence next to PPV, and recompute PPV per site.`,
        code: `ct = pd.crosstab(df["truth"], df["pred"]).reindex(index=[0, 1], columns=[0, 1], fill_value=0)\ntn, fp = int(ct.loc[0, 0]), int(ct.loc[0, 1])\nfn, tp = int(ct.loc[1, 0]), int(ct.loc[1, 1])\n\nsens = tp / (tp + fn)\nspec = tn / (tn + fp)\nppv = tp / (tp + fp)\nnpv = tn / (tn + fn)\nprint(round(sens, 3), round(spec, 3), round(ppv, 3), round(npv, 4))\n# 0.95 0.9 0.162 0.9989\n\ndef ppv_at(prev, sens, spec):\n    return sens * prev / (sens * prev + (1 - spec) * (1 - prev))\n\nfor prev in (0.02, 0.10, 0.50):\n    print(prev, round(ppv_at(prev, sens, spec), 3))  # 0.162, 0.514, 0.905`,
        codeLang: 'python',
        points: [
          'TP 190, FN 10, FP 980, TN 8820 gives sens 0.95, spec 0.90, PPV 0.16, NPV 0.999.',
          'Sensitivity and specificity do not move with prevalence; PPV and NPV do.',
          'Low prevalence means many negatives, so a small false positive rate yields many false positives.',
          'Report prevalence with predictive values and compute them per site.',
        ],
        followups: [
          'How would you pick the threshold if a missed positive costs 20x a false alarm?',
          'How would you put confidence intervals on these four numbers?',
        ],
        pitfalls: [
          'Building the crosstab without reindexing, so a missing cell shifts the indices.',
          'Quoting PPV measured on an enriched validation set as if it applied to production.',
        ],
      },
      {
        id: 'analytics-07',
        topic: 'ROC vs PR curves',
        level: 3,
        q: `A tumor detector scores ROC-AUC 0.97 on a validation set where 2% of slides are positive, yet pathologists complain about false alarms. Explain the gap, when you prefer PR-AUC, and what you would report instead.`,
        a: `ROC plots sensitivity against the false positive rate, FP / (all negatives). With 98% negatives, the denominator is huge, so thousands of false positives still produce a small FPR and the curve looks excellent. Precision, TP / (TP + FP), has no such cushion, so the **precision-recall curve exposes the false alarm burden** that ROC hides.\n\nUse PR-AUC (average precision) when the positive class is rare and the cost is in reviewing flagged cases. Remember the PR baseline is the prevalence (0.02 here), so a PR-AUC of 0.30 is already a 15x lift over random, and PR values are **not comparable across sites with different prevalence**. ROC-AUC is prevalence independent, which makes it better for comparing models across sites, though it can overstate usefulness.\n\nBest practice is to report both plus an **operating-point view**: precision and recall at the chosen threshold, and flagged slides per day, which is the workload number a lab can act on. Compute them with confidence intervals bootstrapped by patient.`,
        points: [
          'FPR divides by the large negative class, so ROC looks good under imbalance.',
          'PR curves show precision, which reflects review burden.',
          'PR baseline equals prevalence; do not compare PR-AUC across prevalences.',
          'Report precision/recall at the operating point and flagged slides per day.',
        ],
        followups: [
          'Is PR-AUC affected if you downsample negatives for training?',
          'How do you choose the operating threshold, and who signs off on it?',
        ],
        pitfalls: [
          'Quoting AUC with no prevalence and no operating point.',
          'Interpolating PR curves linearly, which is optimistic; average precision is safer.',
        ],
      },
      {
        id: 'analytics-08',
        topic: 'Calibration',
        level: 3,
        q: `A model's scores rank slides well (high AUC), but when it says 0.8 only about 55% of those slides are truly positive at one site. What is wrong, how do you detect it, how do you fix it, and what does a data engineer store?`,
        a: `The model **discriminates well but is poorly calibrated**. Discrimination (AUC) is about ranking; calibration is about whether a score of 0.8 means 80% in practice. They are independent properties.\n\nDetect it with a reliability diagram (bin scores, plot predicted vs observed rate), the Brier score, and expected calibration error (ECE; it depends on the binning, so say which). Check **per site and per scanner**, since calibration usually breaks first on new data.\n\nCommon causes: training on a re-balanced set (prevalence shift moves the intercept), domain shift, or an aggregated slide score that was never a probability (attention-pooled scores often are not).\n\nFix with Platt scaling (a logistic fit), temperature scaling, or isotonic regression (more flexible, needs more data), fitted on held-out labeled data, not the training set.\n\nData engineering angle: persist the raw score, the model version **and** the calibration version with each inference run. Treat the calibrator as a versioned artifact so you can recalibrate without retraining, and re-evaluate it when labels from a new site arrive.`,
        points: [
          'Calibration (does 0.8 mean 80%) is separate from discrimination (ranking).',
          'Reliability diagram, Brier score and ECE; check by site and scanner.',
          'Prevalence shift and domain shift break calibration.',
          'Platt, temperature or isotonic, fitted on held-out data.',
          'Store raw score, model version and calibration version.',
        ],
        followups: [
          'Does calibration matter if you only ever use a fixed threshold?',
          'How would you monitor calibration when labels arrive days later?',
        ],
        pitfalls: [
          'Fitting the calibrator on the training set.',
          'Assuming a model calibrated at one site is calibrated at all of them.',
        ],
      },
      {
        id: 'analytics-09',
        topic: 'ML lifecycle',
        level: 1,
        q: `Sketch the machine learning lifecycle for a slide-level model as a data engineer would own it, and name the parts that most often go wrong.`,
        a: `A practical pipeline:\n\n1. **Cohort and QC**: choose slides from \`slides\` and \`cases\`, drop \`qc_status = 'fail'\`, and log every exclusion with a reason.\n2. **Labels**: derive from sign-out diagnoses or annotations, with versioned rules.\n3. **Features or tiles**: extract tiles, compute embeddings, store them by slide and model version.\n4. **Split**: assign train, validation and test by patient or site, once, and persist it.\n5. **Train and evaluate**: log code commit, container digest, data snapshot id, metrics.\n6. **Register and deploy**: batch or online scoring, with a rollback path.\n7. **Monitor**: input drift, score drift, and delayed performance.\n\nWhat goes wrong: labels joined **as of the wrong time** (a preliminary diagnosis later amended by an addendum), features that use information from after the prediction moment, tiles regenerated with a different library version, and splits recomputed each run so the test set quietly changes. The fix is the same everywhere: immutable inputs, idempotent runs, and lineage from every prediction back to data and code.`,
        points: [
          'Stages: cohort/QC, labels, features, split, train/evaluate, register/deploy, monitor.',
          'Labels need point-in-time correctness and versioned derivation rules.',
          'Persist the split; do not recompute it per run.',
          'Log code, environment and data snapshot with every model.',
        ],
        followups: [
          'Where would you draw the line between a feature store and plain tables?',
          'How do you handle amended diagnoses after a training set was frozen?',
        ],
        pitfalls: [
          'Treating the notebook as the pipeline, with no reproducible entry point.',
          'Silently dropping failed slides, which biases the training set toward easy scans.',
        ],
      },
      {
        id: 'analytics-10',
        topic: 'Leakage and splits',
        level: 2,
        q: `This split is reported as 0.98 AUC on test, then 0.84 on a new site. Find the leakage and fix it so the split is stable as new slides arrive.`,
        setup: `from sklearn.model_selection import train_test_split\n\nslides = load_slides()  # one row per slide: slide_id, case_id, patient_id, site, label\ntrain, test = train_test_split(slides, test_size=0.2, random_state=0)`,
        setupLang: 'python',
        a: `The split is per **slide**. One patient can have many slides, blocks and cases, and the model learns patient-specific appearance (stain, tissue architecture, even pen marks), so test slides have near-duplicates in train. That inflates test performance. A new site breaks the shortcut and exposes the real number.\n\nSplit by the **independent unit**: \`patient_id\` (not \`case_id\`, since a patient has multiple cases). For generalization claims, also hold out whole **sites or scanners**.\n\nA deterministic hash gives a stable assignment: new patients land in a split without moving existing ones, unlike a seeded random split that reshuffles when the table grows. Persist the assignment table.\n\nOther leakage to check: normalization or stain-reference statistics fitted on all data, duplicate slides rescanned and counted twice, labels derived from model output, and repeatedly tuning on the test set. If you need stratification, \`StratifiedGroupKFold\` in scikit-learn (1.0 or later) groups and stratifies together.`,
        code: `import hashlib\n\ndef bucket(patient_id: int, salt: str = "split-v1") -> float:\n    h = hashlib.sha256(f"{salt}:{patient_id}".encode()).hexdigest()\n    return int(h[:8], 16) / 0x100000000   # uniform in [0, 1)\n\ndef assign(patient_id: int) -> str:\n    b = bucket(patient_id)\n    return "train" if b < 0.70 else "val" if b < 0.85 else "test"\n\nslides["split"] = slides["patient_id"].map(assign)\n\n# guard: no patient may straddle splits\nassert slides.groupby("patient_id")["split"].nunique().max() == 1\n\n# hold out a whole site for an external check\nexternal = slides[slides["site"] == "site_c"]`,
        codeLang: 'python',
        points: [
          'Slide-level random split leaks patient-specific signal into test.',
          'Split by patient (and hold out sites or scanners) to measure generalization.',
          'Hash-based assignment is stable as data grows; persist it.',
          'Fit normalization only on training data; assert no patient crosses splits.',
        ],
        followups: [
          'How would you detect leakage after the fact?',
          'What if the same patient appears under two patient_ids after a record merge?',
        ],
        pitfalls: [
          'Splitting by case_id and leaking across a patient\'s cases.',
          'Changing the salt or fractions later, which moves patients between train and test.',
        ],
      },
      {
        id: 'analytics-11',
        topic: 'Versioning and registry',
        level: 3,
        q: `A regulator-minded reviewer asks you to reproduce the exact model that scored a given slide eight months ago. What do you need to have kept, and how do data versioning and a model registry provide it?`,
        a: `You need a chain from the prediction back to every input:\n\n- \`inference_runs\` row: \`slide_id\`, \`model_name\`, \`model_version\`, calibration version, timestamps.\n- **Registry entry** for that version: artifact URI and hash, training code commit, container image digest, hyperparameters, metrics, approver, and the **training dataset id**.\n- **Dataset snapshot**: an immutable manifest (slide ids with file hashes, label rule version, split table). Tools such as DVC or lakeFS, or table formats with snapshots (Delta, Iceberg), give this.\n\nCaveat on warehouse time travel: it is bounded by the retention setting (Snowflake: 1 day by default, up to 90 on Enterprise edition or higher), so for long-lived reproducibility **materialize or clone a named snapshot** instead of relying on a timestamp.\n\nRegistries such as the MLflow Model Registry track versions and promotion; since MLflow 2.9 the fixed stages (Staging, Production) are deprecated in favor of aliases such as \`@champion\` and tags. Keep artifacts immutable, promote by pointer, and make rollback a pointer change.`,
        points: [
          'Each inference row records model and calibration versions.',
          'Registry stores artifact hash, code commit, image digest, metrics, dataset id, approver.',
          'Dataset snapshots are immutable manifests with file hashes.',
          'Time travel has a retention limit; pin named snapshots for long-term reproducibility.',
        ],
        followups: [
          'What happens to old slide images if scanner files are re-exported?',
          'How do you reproduce training when the base container image tag was moved?',
        ],
        pitfalls: [
          'Tagging a model by a mutable name such as "latest" in the inference table.',
          'Versioning code and models but not the labels and split table.',
        ],
      },
      {
        id: 'analytics-12',
        topic: 'Inference serving modes',
        level: 1,
        q: `When does slide inference belong in batch, when in near-real-time event-driven scoring, and when behind an online API?`,
        a: `Match the mode to the **latency need and the cost of idle GPUs**.\n\n- **Batch**: backfills, re-scoring the archive when a new model version ships, nightly cohort runs. Highest GPU utilization, simplest retries.\n- **Event-driven (near-real-time)**: a slide finishes upload, an event triggers scoring, and results land minutes later for the pathologist worklist. A whole slide has tens or hundreds of thousands of tiles, so scoring takes minutes, not milliseconds. Use a queue, autoscaled workers, and idempotent runs keyed by slide and model version.\n- **Online API**: small, interactive requests, such as a tile or region-of-interest overlay in a viewer, or a thumbnail-level QC check. Needs low latency, warm models, and capacity for bursts.\n\nIn all modes, record model version and status per run, make writes idempotent, and decide up front what happens on timeout (in the shared schema, \`inference_runs.status\` has \`ok\`, \`error\`, \`timeout\`). Precomputing heatmaps usually beats computing them on demand.`,
        points: [
          'Batch for backfills and re-scoring; best GPU utilization.',
          'Event-driven for new slides; scoring takes minutes, so it is async.',
          'Online only for small interactive requests.',
          'Idempotent runs keyed by slide and model version, with explicit timeout handling.',
        ],
        followups: [
          'How do you re-score 2 million archived slides without starving live traffic?',
          'Where does a cache of tile embeddings fit?',
        ],
        pitfalls: [
          'Calling a synchronous API per slide and holding an HTTP connection for minutes.',
          'Running always-on GPU endpoints for a workload that arrives in bursts.',
        ],
      },
      {
        id: 'analytics-13',
        topic: 'Drift and label delay',
        level: 3,
        q: `Design monitoring for a deployed slide classifier when ground truth (final sign-out) arrives days after scanning. Include how you would measure drift with PSI and KS.`,
        a: `Monitor in two tiers, because labels lag.\n\n**Leading indicators (available now)**: input drift on features such as mean color, blur score, tissue fraction, mpp and scanner model; score drift on the model's output; QC fail rate; run errors and timeouts. A new scanner or a changed stain batch shows up here first.\n\n- **PSI**: bin the reference distribution (deciles), compute the share in each bin for reference (e) and current (a), then sum (a - e) * ln(a / e). Common rule of thumb is under 0.1 stable, 0.1 to 0.25 watch, over 0.25 investigate; these are heuristics, not standards. Smooth empty bins.\n- **KS**: the maximum gap between two empirical CDFs. With large n the p-value is always tiny, so alert on the statistic's magnitude, not significance.\n\n**Lagging performance**: evaluate by **scan-date cohort once labels mature**, using an as-of rule (for example, cases signed out within 14 days). Never treat unlabeled slides as negatives. Keep predictions and labels in separate tables joined at evaluation time, and slice by scanner and site.\n\nDrift is a symptom, not proof of harm: a shift might be benign. Tie alerts to a runbook.`,
        points: [
          'Two tiers: immediate input/score drift and delayed labeled performance.',
          'PSI formula and rule-of-thumb thresholds; KS on magnitude, not p-value.',
          'Evaluate by scan-date cohort after labels mature; define the maturity window.',
          'Slice by scanner, site and stain; never count unlabeled as negative.',
        ],
        followups: [
          'How do you separate covariate drift from concept drift?',
          'What action does an alert trigger: retrain, recalibrate, or pause?',
        ],
        pitfalls: [
          'Computing PSI bins from the current data instead of a fixed reference.',
          'Reporting performance on the labeled subset only, which may be biased toward easy or completed cases.',
        ],
      },
      {
        id: 'analytics-14',
        topic: 'Snowflake architecture',
        level: 1,
        q: `Explain Snowflake's virtual warehouses and micro-partitions, and when clustering keys are worth having.`,
        a: `Snowflake separates **storage** (columnar data in cloud object storage) from **compute** (virtual warehouses). A warehouse is a compute cluster that you size (XS = 1 credit per hour for a standard warehouse, doubling per size step), suspend and resume, billed per second with a 60-second minimum each time it resumes. Several warehouses can read the same tables with no contention, so ETL, BI and data science get separate ones. Multi-cluster warehouses (Enterprise edition or higher) add clusters under concurrency.\n\nTables are stored as immutable **micro-partitions**, contiguous columnar chunks of roughly 50 to 500 MB uncompressed. Snowflake keeps min/max and other metadata per column per partition, and queries **prune** partitions whose ranges cannot match the filter.\n\nPruning works best when the data is naturally ordered by the filter column (for example, loaded in \`scanned_at\` order). When it is not, and the table is large (multi-terabyte as a rule of thumb) and queries filter on a few columns, define a **clustering key**. Automatic clustering consumes serverless credits every time it reclusters changed data, so verify the benefit with \`SYSTEM$CLUSTERING_INFORMATION\` before and after.`,
        points: [
          'Storage and compute are separate; warehouses are independently sized and billed per second.',
          'Separate warehouses per workload avoid contention.',
          'Micro-partitions carry min/max metadata that enable pruning.',
          'Clustering keys help large, poorly ordered tables but cost credits to maintain.',
        ],
        followups: [
          'What is the trade-off in making a warehouse bigger vs adding clusters?',
          'Which cache layers does Snowflake have, and how does auto-suspend affect them?',
        ],
        pitfalls: [
          'Clustering small tables, where pruning has little to gain.',
          'Choosing a high-cardinality key like a timestamp to the second without truncating it.',
        ],
      },
      {
        id: 'analytics-15',
        topic: 'Snowflake time travel',
        level: 2,
        q: `What do Time Travel, Fail-safe and zero-copy cloning each give you in Snowflake, what are the limits, and how would you use them around a risky change to the \`slides\` table?`,
        a: `**Time Travel** lets you query, clone or undrop data as of a past time within the retention window. Default retention is 1 day; Standard edition tops out at 1 day, Enterprise edition and higher allow up to 90. Transient and temporary tables get at most 1 day. Retained history costs storage for the changed micro-partitions.\n\n**Fail-safe** is a further 7 days for permanent tables, held by Snowflake for disaster recovery. You cannot query it; recovery goes through Snowflake support, so do not count it as your backup plan.\n\n**Zero-copy clone** copies metadata only. The clone shares micro-partitions with the source and pays storage only for what diverges afterward. It is ideal for dev and test copies, pre-change backups, and named dataset snapshots.\n\nBefore a risky migration: clone the table (or schema), run the change on the clone, validate counts and checksums, then swap. If you need a snapshot that outlives the retention window, keep the clone.`,
        code: `-- state of the table an hour ago\nSELECT COUNT(*) FROM slides AT (OFFSET => -3600);\n\n-- freeze a named snapshot (metadata-only; must be inside the retention window)\nCREATE TABLE slides_train_2026_10 CLONE slides\n  AT (TIMESTAMP => '2026-10-20 06:00:00'::TIMESTAMP_LTZ);\n\n-- longer retention (Enterprise edition or higher)\nALTER TABLE slides SET DATA_RETENTION_TIME_IN_DAYS = 14;\n\n-- recover from an accidental drop\nUNDROP TABLE slides;`,
        codeLang: 'sql',
        points: [
          'Time Travel: query, clone, undrop within retention; default 1 day, up to 90 on higher editions.',
          'Fail-safe is 7 days, support-only, not a user feature.',
          'Clones are metadata-only and share storage until data diverges.',
          'Keep a clone to preserve a snapshot beyond the retention window.',
        ],
        followups: [
          'What happens to storage cost if you clone a table and then rewrite most of it?',
          'How would you let analysts experiment without touching production data?',
        ],
        pitfalls: [
          'Planning to restore from Fail-safe as routine recovery.',
          'Setting long retention on huge, churning tables without checking storage cost.',
        ],
      },
      {
        id: 'analytics-16',
        topic: 'Snowflake ingestion pipeline',
        level: 3,
        q: `Scan events land as files in cloud storage every few seconds. Describe an ingestion path in Snowflake using Snowpipe, streams and tasks, and its failure modes.`,
        a: `Pattern: **Snowpipe** loads new files into a raw table; a **stream** tracks changes on it; a **task** merges the changes into the curated table.\n\n- **Snowpipe** uses serverless compute and, with auto-ingest, cloud event notifications (for example S3 to SQS) to load files shortly after they arrive. Per-file overhead makes tiny files inefficient (billing has included a per-file charge, and Snowflake has been moving Snowpipe to per-GB pricing, so check current terms); aim for roughly 100 to 250 MB compressed where you can, or batch small files upstream. For row-level, sub-minute latency, Snowpipe Streaming (directly or through the Kafka connector) is the alternative.\n- A **stream** records change metadata (\`METADATA$ACTION\`, \`METADATA$ISUPDATE\`); its offset advances only when a DML statement consumes it in a committed transaction. If it is not consumed within the retention window it goes **stale**.\n- A **task** runs on a schedule or after another task; \`WHEN SYSTEM$STREAM_HAS_DATA(...)\` skips empty runs so the warehouse can stay suspended.\n\nFailure modes: duplicate events from at-least-once delivery (dedupe in the MERGE; Snowpipe load history is bounded, so do not rely on it forever), stale streams after a task stays suspended, and schema drift in the files. Dynamic tables are a declarative alternative: you write the SELECT and a target lag, and Snowflake schedules the incremental refresh.`,
        code: `CREATE STREAM scan_events_raw_stream ON TABLE scan_events_raw APPEND_ONLY = TRUE;\n\nCREATE TASK merge_scan_events\n  WAREHOUSE = etl_wh\n  SCHEDULE = '5 MINUTE'\n  WHEN SYSTEM$STREAM_HAS_DATA('scan_events_raw_stream')\nAS\n  MERGE INTO scan_events t\n  USING (\n    SELECT event_id, slide_id, scanner_id, event_type, event_ts\n    FROM scan_events_raw_stream\n    QUALIFY ROW_NUMBER() OVER (PARTITION BY event_id ORDER BY event_ts DESC) = 1\n  ) s\n  ON t.event_id = s.event_id\n  WHEN NOT MATCHED THEN INSERT (event_id, slide_id, scanner_id, event_type, event_ts)\n    VALUES (s.event_id, s.slide_id, s.scanner_id, s.event_type, s.event_ts);\n\n-- tasks are created suspended\nALTER TASK merge_scan_events RESUME;`,
        codeLang: 'sql',
        points: [
          'Snowpipe (auto-ingest) loads files; avoid tiny files.',
          'Streams expose change records and advance on consumption; they can go stale.',
          'Tasks on a schedule with STREAM_HAS_DATA avoid paying for empty runs.',
          'Make the MERGE idempotent and dedupe by event_id.',
          'Dynamic tables are a declarative alternative driven by a target lag.',
        ],
        followups: [
          'What changes if events can arrive hours late?',
          'How would you backfill a month of missed files?',
        ],
        pitfalls: [
          'Skipping dedup because "Snowpipe does not reload files".',
          'Forgetting ALTER TASK ... RESUME after creating it, or leaving it suspended until the stream goes stale.',
        ],
      },
      {
        id: 'analytics-17',
        topic: 'Snowflake cost control',
        level: 2,
        q: `The BI warehouse's credit usage doubled this month. Which controls do you set, and how do you find what changed?`,
        a: `First find the cause, then add guardrails.\n\n**Attribution**: query \`SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY\` (it lags by up to a few hours) for credits by warehouse and day, then \`QUERY_HISTORY\` for the expensive, queued or spilling queries. Set \`QUERY_TAG\` per tool or dashboard so spend is attributable.\n\n**Guardrails**:\n\n- Short \`AUTO_SUSPEND\` (for example 60 seconds) with \`AUTO_RESUME\` left on; very short suspends lose the warm cache, so test.\n- Right-size by measuring: one size up costs about 2x per hour but can halve runtime, so it is not always more expensive.\n- A **resource monitor** with notify and suspend triggers (by default only the ACCOUNTADMIN role can create one). \`SUSPEND\` lets running queries finish; \`SUSPEND_IMMEDIATE\` cancels them. Credits can still overshoot slightly.\n- \`STATEMENT_TIMEOUT_IN_SECONDS\` to stop runaway queries; separate warehouses per workload; a low max cluster count on multi-cluster warehouses.\n\nAlso fix the queries: dashboards that scan \`scan_events\` unfiltered, or refresh every minute for nobody.`,
        code: `CREATE WAREHOUSE IF NOT EXISTS bi_wh\n  WAREHOUSE_SIZE = 'SMALL'\n  AUTO_SUSPEND = 60\n  AUTO_RESUME = TRUE\n  INITIALLY_SUSPENDED = TRUE\n  STATEMENT_TIMEOUT_IN_SECONDS = 1800;\n\nCREATE RESOURCE MONITOR rm_bi WITH CREDIT_QUOTA = 100 FREQUENCY = MONTHLY START_TIMESTAMP = IMMEDIATELY\n  TRIGGERS ON 80 PERCENT DO NOTIFY\n           ON 100 PERCENT DO SUSPEND\n           ON 110 PERCENT DO SUSPEND_IMMEDIATE;\nALTER WAREHOUSE bi_wh SET RESOURCE_MONITOR = rm_bi;\n\n-- who spent what in the last 7 days\nSELECT warehouse_name, DATE_TRUNC('day', start_time) AS day, SUM(credits_used) AS credits\nFROM snowflake.account_usage.warehouse_metering_history\nWHERE start_time >= DATEADD('day', -7, CURRENT_TIMESTAMP())\nGROUP BY 1, 2\nORDER BY credits DESC;`,
        codeLang: 'sql',
        points: [
          'Attribute spend first: metering history by warehouse, query history by tag.',
          'AUTO_SUSPEND with AUTO_RESUME on; balance against cache warmth.',
          'Resource monitors notify or suspend; SUSPEND_IMMEDIATE cancels running queries.',
          'Statement timeouts, workload-specific warehouses, capped cluster counts.',
          'Fix the expensive queries and refresh schedules, not just the limits.',
        ],
        followups: [
          'When is a larger warehouse cheaper overall?',
          'How do serverless features (Snowpipe, automatic clustering) show up in cost?',
        ],
        pitfalls: [
          'Relying on a resource monitor alone; it limits damage but does not explain it.',
          'Setting auto-suspend to a few seconds on a BI warehouse and paying the cold-start cost repeatedly.',
        ],
      },
      {
        id: 'analytics-18',
        topic: 'BigQuery cost model',
        level: 2,
        q: `An 8 TB \`scan_events\` table in BigQuery is queried by dashboards for one week at a time and the bill is high. Explain on-demand vs slot pricing, what drives bytes scanned, and what you would change.`,
        a: `Two pricing models: **on-demand** bills by bytes processed per query (per TiB, with a monthly free tier and a 10 MB minimum per table referenced; check current prices), and **capacity** pricing buys slots (editions: Standard, Enterprise, Enterprise Plus, with autoscaling and optional commitments; they replaced flat-rate pricing in 2023). On-demand suits spiky, small usage; slots suit steady heavy usage and predictable cost, but queries then queue when slots run out.\n\nBigQuery is columnar, so **bytes scanned depend on which columns you read**, not on \`LIMIT\`. \`SELECT *\` on a wide table is the classic waste.\n\nChanges:\n\n- Find the offenders first: \`INFORMATION_SCHEMA.JOBS_BY_PROJECT\` lists every query job with \`total_bytes_billed\`, user and query text.\n- **Partition** by \`DATE(event_ts)\` so a week-long filter reads 7 partitions (a table can hold at most 10,000 partitions).\n- **Cluster** by \`scanner_id, event_type\` (up to four columns) so blocks within a partition prune on common filters.\n- Set \`require_partition_filter\` so nobody can scan everything by accident.\n- Use \`bq query --dry_run\` to see estimated bytes and \`--maximum_bytes_billed\` as a hard cap.\n- Route repeat dashboard queries to a summary table or materialized view.`,
        code: `CREATE TABLE ops.scan_events_p\nPARTITION BY DATE(event_ts)\nCLUSTER BY scanner_id, event_type\nOPTIONS (require_partition_filter = TRUE)\nAS SELECT * FROM ops.scan_events;\n\n-- reads 7 partitions and 3 columns, not 8 TB\nSELECT scanner_id,\n       COUNTIF(event_type = 'qc_fail') AS qc_fails,\n       COUNT(*) AS events\nFROM ops.scan_events_p\nWHERE DATE(event_ts) BETWEEN '2026-10-01' AND '2026-10-07'\nGROUP BY scanner_id;`,
        codeLang: 'sql',
        points: [
          'On-demand bills bytes processed; capacity bills slots (editions); choose by usage shape.',
          'Columnar: select only needed columns; LIMIT does not reduce scanned bytes.',
          'Partition by date, cluster by common filter columns, require partition filters.',
          'Dry run and maximum bytes billed as guardrails.',
        ],
        followups: [
          'How would you decide between on-demand and an edition with autoscaling?',
          'Does clustering change the dry-run estimate?',
        ],
        pitfalls: [
          'Filtering on a function of the partition column in a way that prevents pruning.',
          'Over-partitioning (by hour or by scanner) and producing many tiny partitions.',
        ],
      },
      {
        id: 'analytics-19',
        topic: 'BigQuery acceleration',
        level: 3,
        q: `A Looker Studio dashboard runs the same daily-aggregate query over \`scan_events\` hundreds of times a day. Compare a materialized view, a scheduled summary table and BI Engine, and say when each fits.`,
        a: `All three trade freshness and flexibility for speed and cost.\n\n- **Materialized view**: BigQuery stores precomputed results and refreshes them incrementally, scanning only the changed data. It can be used automatically when a query against the base table matches (smart tuning). Supported SQL is restricted (limited aggregates and joins, no non-deterministic functions; the list has grown over releases). Refresh runs in the background, but queries still return fresh results by default because BigQuery combines the view with base-table changes since the last refresh; the \`max_staleness\` option trades that freshness for lower cost.\n- **Scheduled summary table**: any SQL, full control over grain and retention, you own refresh logic and dependencies. Best for complex logic or when you need a stable contract for several tools.\n- **BI Engine**: an in-memory acceleration layer for which you reserve capacity (GB) per project and location. It speeds up eligible queries from BI tools, with sub-second responses on cached columns. Ineligible operators run normally (partial acceleration), and you pay for the reservation.\n\nFor this dashboard: aggregate once into \`daily_scanner_metrics\` (materialized view if the SQL qualifies, else a scheduled table), and add BI Engine if interactivity still lags. Measure bytes billed and p95 latency before and after.`,
        points: [
          'Materialized views: incremental refresh, restricted SQL, fresh by default unless max_staleness is set.',
          'Scheduled tables: unrestricted SQL, you manage refresh and contracts.',
          'BI Engine: reserved in-memory capacity, eligibility rules, partial acceleration.',
          'Pre-aggregate to the dashboard grain first; add acceleration second.',
        ],
        followups: [
          'How would you handle late-arriving scan events in a daily summary?',
          'How do you prove the acceleration paid for itself?',
        ],
        pitfalls: [
          'Assuming any query shape can become a materialized view.',
          'Buying BI Engine capacity for a query that scans huge unpartitioned data.',
        ],
      },
      {
        id: 'analytics-20',
        topic: 'SSIS',
        level: 2,
        q: `Explain control flow vs data flow in SSIS, how packages are deployed, and when you would plan to move a pipeline off SSIS and when you would leave it alone.`,
        a: `**Control flow** is the orchestration layer: tasks (Execute SQL, File System, Script) joined by precedence constraints (success, failure, completion, expression), plus containers (Foreach Loop, For Loop, Sequence), transactions and checkpoints. **Data flow** is a single task that streams rows through **in-memory buffers**: source, transformations, destination. Row-by-row-style transforms (Derived Column, Lookup) are cheap and synchronous; blocking or asynchronous ones (Sort, Aggregate, Merge Join) copy or hold data and cost memory.\n\nDeployment: the **project deployment model** builds an \`.ispac\` that is deployed to the **SSISDB catalog** on SQL Server, which gives parameters, environments, execution logging and versioning; scheduling is typically a SQL Server Agent job. The older **package deployment model** stores packages in the file system or msdb. Azure Data Factory can run existing packages on an Azure-SSIS integration runtime.\n\nMove off when: the target is a cloud warehouse where ELT pushdown is cheaper, you need Git-based CI/CD and code review, scale is outgrowing a single server, or script components hide logic. Leave it when it is stable and cheap. Migrate incrementally: land data raw, rebuild transforms as SQL, retire packages one at a time.`,
        points: [
          'Control flow orchestrates tasks; data flow streams rows in memory.',
          'Blocking transformations (Sort, Aggregate) cost memory.',
          'Project deployment to SSISDB vs legacy package deployment.',
          'Migration triggers: cloud ELT, CI/CD needs, scale, opaque script logic.',
        ],
        followups: [
          'How would you do incremental loads in SSIS, and how does that map to a cloud warehouse?',
          'What do you lose when you replace SSIS with SQL-only transforms?',
        ],
        pitfalls: [
          'A big-bang rewrite with no parity testing against the old output.',
          'Moving the same row-by-row logic to the cloud instead of rethinking it as set-based SQL.',
        ],
      },
      {
        id: 'analytics-21',
        topic: 'Denodo virtualization',
        level: 1,
        q: `What is Denodo, and when does data virtualization beat replicating data into a warehouse, and when does it not?`,
        a: `Denodo is a **data virtualization** platform. You publish *virtual views* over many sources (databases, files, APIs, SaaS), model derived views and joins in a logical layer, and consumers query that layer with SQL. Denodo parses the query, optimizes it, pushes work down to the sources, combines results and returns them. No data is copied unless you choose to cache it.\n\nVirtualization wins when:\n\n- You need **fresh** data across several systems with moderate volumes.\n- You want one governed access and security point instead of many copies of sensitive data.\n- You are prototyping or in a migration, and cannot wait for a full pipeline.\n\nReplication wins when:\n\n- Queries join or aggregate **large** datasets across systems, since the network and the slowest source dominate.\n- Sources cannot absorb analytic load (a laboratory system of record).\n- You need history, snapshots or reproducible training sets.\n- You need heavy transformations or very high availability that does not depend on every source being up.\n\nMost real designs are hybrid: virtualize the long tail, and replicate or cache hot, large or historical data.`,
        points: [
          'Virtual views over heterogeneous sources; queries optimized and pushed down.',
          'Good for freshness, governance and fast integration of many modest sources.',
          'Poor for large cross-source joins, fragile sources, history and heavy transforms.',
          'Hybrid: virtualize some data, cache or replicate the rest.',
        ],
        followups: [
          'How would you decide per dataset between virtual, cached and replicated?',
          'What happens to dashboards when one source is down?',
        ],
        pitfalls: [
          'Treating virtualization as a free replacement for ETL.',
          'Exposing an operational system directly to unlimited analytical queries.',
        ],
      },
      {
        id: 'analytics-22',
        topic: 'Denodo performance',
        level: 3,
        q: `A Denodo view joining slide metadata in the lab system with inference scores in a cloud warehouse is slow. Walk through caching modes, query pushdown, and the usual federated join pitfalls.`,
        a: `Start from the query plan: what was pushed down, what was pulled into Denodo, and which join strategy was used.\n\n**Pushdown**: the optimizer sends filters, projections, aggregations and same-source joins to each source, so only needed rows cross the network. It is cost-based, so it needs **statistics** on the views; without them it can pick a poor plan. Pushdown breaks when an expression cannot be translated (custom functions, type or collation mismatches), and then rows are fetched and processed in Denodo.\n\n**Join pitfalls**: joining two large tables from different sources forces rows to move. Denodo can use hash, merge or nested-parameterized joins, or move one side into the other source; the right choice depends on cardinalities. Filter first, join keys with matching types, and avoid \`SELECT *\`.\n\n**Caching**: off by default. Full cache stores the whole view and is refreshed by a preload; partial cache stores results of queries as they are requested and falls back to the source on a miss. The cache lives in a database you configure, and it is another copy of the data to secure and refresh. Denodo 8 and later also offer summaries (pre-computed aggregates the optimizer can rewrite queries to use) and an embedded MPP engine for large analytic joins; availability depends on edition.\n\nIf the join remains inherently large, replicate one side.`,
        points: [
          'Read the query plan: what is pushed down and which join strategy runs.',
          'Gather statistics so the cost-based optimizer chooses well.',
          'Non-translatable expressions and type mismatches defeat pushdown.',
          'Full vs partial cache; cache is another copy with its own refresh and security.',
          'Replicate when a cross-source join is inherently large.',
        ],
        followups: [
          'How would you decide the cache refresh schedule for scores that update hourly?',
          'What would you monitor to catch a regression in pushdown after a view change?',
        ],
        pitfalls: [
          'Joining on a function of a key (for example, a cast), which blocks pushdown and index use.',
          'Caching a view without a plan for invalidation, then serving stale results.',
        ],
      },
      {
        id: 'analytics-23',
        topic: 'Denodo security and PHI',
        level: 2,
        q: `Analysts should see \`cases\` with \`patient_id\` masked and birth year banded; pathologists in a given service should see unmasked data for their own service only. How do you enforce that in a virtualization layer, and what can go wrong?`,
        a: `Enforce it **once, in the virtual layer**, so every downstream tool (Tableau, notebooks, APIs) inherits it.\n\n- **Authentication**: integrate with the corporate directory or SSO (LDAP, Kerberos, OAuth/SAML, depending on version) so queries carry the real user.\n- **Authorization**: Denodo access control is role-based; grant privileges on views to roles mapped from directory groups. It supports column privileges and row restrictions: a row restriction is a predicate tied to a role or user attribute (for example, \`service\` equals the user's service), and masking replaces a sensitive column for some roles. Denodo 8 and later can apply these as global security policies by tag.\n- **Derived views for analysts**: replace \`patient_id\` with a keyed hash and \`birth_year\` with an age band, and expose only that view.\n- **Auditing**: log user, view and filters; ship logs to a central store.\n\nWhat goes wrong: connecting to sources with one shared service account means the source's own row security sees only that account, so Denodo becomes the only control and must be right; caches and exports are extra copies of PHI; restrictions that cannot be pushed down hurt performance; and small groups after aggregation can re-identify patients.`,
        points: [
          'Enforce row and column rules in the virtual layer for all consumers.',
          'Pass the real user identity through SSO; grant privileges to roles mapped from groups.',
          'Mask or band identifiers in a derived view for analysts.',
          'Audit access; treat caches and extracts as PHI stores.',
        ],
        followups: [
          'How would you test that a user cannot see a row they should not?',
          'What is the risk of a shared service account to a source?',
        ],
        pitfalls: [
          'Hiding a column in the BI tool while the underlying view still exposes it.',
          'Forgetting that a hashed ID with no salt can be reversed by brute force on a small key space.',
        ],
      },
      {
        id: 'analytics-24',
        topic: 'Tableau and Power BI',
        level: 2,
        q: `Compare Tableau extracts vs live connections and Power BI Import vs DirectQuery. How should the underlying tables be shaped, and how do you choose?`,
        a: `**Tableau**: a *live* connection sends queries to the source on every interaction, so data is fresh but speed and warehouse cost depend on the source. An *extract* (\`.hyper\`) is a columnar snapshot refreshed on a schedule (full or incremental); it is fast, isolates the warehouse, and works offline, but it is stale between refreshes and is another copy of the data.\n\n**Power BI**: **Import** loads data into the in-memory VertiPaq engine; it is the fastest and supports full DAX and Power Query, with refresh schedules and semantic model size limits that depend on license (1 GB per model on Pro, larger on Premium or Fabric capacity). **DirectQuery** keeps data at the source and queries per visual: fresher, no size cap, but slower, with restrictions on transformations and a default cap of 1 million rows returned per source query. Composite models mix both; Fabric adds Direct Lake, which reads Delta tables in OneLake without a scheduled import.\n\nShape for it: a **star schema**: narrow fact tables (\`slides\`, \`scan_events\`) and conformed dimensions (date, scanner, case) with one-to-many relationships and single-direction filters. Avoid one giant wide table, bidirectional many-to-many joins, and DirectQuery on unindexed or unclustered facts.\n\nDefault to import or extract; go live or DirectQuery only for freshness needs or data too large to copy, and then optimize the source.`,
        points: [
          'Live and DirectQuery push work to the source; extracts and Import cache it.',
          'Extracts and Import are fast but stale between refreshes.',
          'Star schema with one-to-many, single-direction relationships.',
          'Import and DirectQuery limits are license- and version-specific.',
        ],
        followups: [
          'How would you give near-real-time scanner status without DirectQuery on the whole model?',
          'How would incremental refresh help with a large \`scan_events\` fact?',
        ],
        pitfalls: [
          'Using DirectQuery on a slow transactional source and blaming the BI tool.',
          'Building the model on top of raw normalized tables with ambiguous join paths.',
        ],
      },
      {
        id: 'analytics-25',
        topic: 'ThoughtSpot modeling',
        level: 2,
        q: `What is ThoughtSpot's search-driven approach to analytics, and what data modeling does it need to work well on top of Snowflake or BigQuery?`,
        a: `ThoughtSpot lets users **type questions** ("average tat by service last 30 days"); it interprets the tokens against a semantic model, generates SQL, and returns a chart (an Answer) that can be pinned to a Liveboard (a dashboard). With cloud warehouse connections (Snowflake, BigQuery and others) it runs **live queries** against the warehouse rather than importing data; older on-premises releases also loaded data into ThoughtSpot's own in-memory engine.\n\nIt only works as well as the model: a **Model** in current releases, which replaced the older **Worksheet**. The model needs:\n\n- A curated, star-like schema with clear join paths. Raw normalized tables risk fan-out and double counting (slides to cases to signouts).\n- Columns typed correctly as **attributes or measures** with the right default aggregation (sum vs average vs count distinct).\n- Business names and **synonyms** ("TAT", "turnaround"), hidden technical columns, and well-defined formulas for metrics such as rescan rate.\n- Row-level security rules by user group.\n\nCost angle: every search hits the warehouse, so size and cache it accordingly, and limit very wide models.`,
        points: [
          'Natural-language-style search becomes generated SQL; results are Answers and Liveboards.',
          'Cloud warehouse connections run live queries, so warehouse speed and cost matter.',
          'The Model (formerly Worksheet) defines joins, types, aggregations and synonyms.',
          'Curated schema avoids fan-out; row-level security and warehouse cost need planning.',
        ],
        followups: [
          'How would you stop users from getting an average of averages?',
          'Who owns the model, the data team or the business?',
        ],
        pitfalls: [
          'Exposing raw tables and expecting search to choose correct joins.',
          'Letting synonyms drift so two columns answer the same question differently.',
        ],
      },
      {
        id: 'analytics-26',
        topic: 'SAS interop',
        level: 1,
        q: `Where does SAS show up in clinical and research settings, and how do you move its data to and from Python and SQL without losing meaning?`,
        a: `SAS is entrenched in **statistical programming** for clinical research: validated procedures (PROC LOGISTIC, PHREG for survival, MIXED, FREQ), established review processes, and regulatory submission datasets in CDISC formats (SDTM, ADaM), often delivered as SAS transport (\`.xpt\`) files. Version 5 transport has short names (8 characters) and a 200-byte limit on character values.\n\nInterop options:\n\n- **Python**: \`pandas.read_sas\` reads \`.sas7bdat\` and XPORT; \`pyreadstat\` also keeps variable labels and value formats; \`saspy\` drives a licensed SAS session from Python.\n- **SQL**: SAS/ACCESS and \`LIBNAME\` engines read and write databases (Oracle, ODBC, Snowflake and others, by license), and PROC SQL is SAS's own dialect with pass-through to the database.\n- **Neutral formats**: export to Parquet or CSV with a data dictionary.\n\nGotchas: SAS dates are **days since 1960-01-01**, so a naive load lands decades off; value labels live in formats, not the data; missing values have special codes; character columns are padded and encoding may be latin1 rather than UTF-8; all numerics are 8-byte floats. Always carry labels and formats into your dictionary.`,
        points: [
          'SAS is common for validated stats and CDISC submission datasets.',
          'Python readers: pandas.read_sas, pyreadstat (labels), saspy (needs SAS).',
          'SQL access via LIBNAME/SAS/ACCESS and PROC SQL pass-through.',
          'Watch epochs, formats, missing codes, encoding and padded strings.',
        ],
        followups: [
          'How would you validate a Python port of a SAS analysis?',
          'Where would you keep the format catalog so labels are not lost?',
        ],
        pitfalls: [
          'Reading dates as integers and treating them as Unix timestamps.',
          'Exporting to CSV and discarding variable labels and value formats.',
        ],
      },
      {
        id: 'analytics-27',
        topic: 'Semantic layer and RLS',
        level: 3,
        q: `Three BI tools show three different "rescan rate" and "turnaround p90" values. Design a semantic layer to fix that, and explain how row-level security fits in without being bypassed.`,
        a: `The disagreement comes from definitions living inside each tool. A **semantic layer** defines them once: entities and grain, joins, dimensions, and metrics with exact formulas, filters, time zone and business-hour rules, which every tool then reads.\n\nImplementations: BI-native (Power BI semantic models, Tableau published data sources, ThoughtSpot Models, LookML), or a warehouse-side layer (the dbt Semantic Layer built on MetricFlow, Cube, or governed views). The warehouse side serves SQL clients, notebooks and several BI tools alike, at the cost of another system.\n\nMake **non-additive metrics** explicit: store numerators and denominators (\`rescans\`, \`slides\`) and compute the ratio at query time; percentiles and distinct counts need an engine that recomputes at the requested grain. Never store a pre-averaged rate.\n\n**Row-level security** should sit as close to the data as possible: Snowflake row access and masking policies (Enterprise edition or higher), BigQuery row-level access policies and policy tags, driven by an **entitlement table** (user or role to site or service, checked with \`CURRENT_USER()\` or \`IS_ROLE_IN_SESSION()\` in Snowflake, \`SESSION_USER()\` in BigQuery). Tool-level RLS (Power BI filters, Tableau user filters) is fine only if users cannot reach the data another way. Pass the real user identity through; a shared service account or an extract holding all rows bypasses it. Test with impersonation, and watch small-cell aggregates.`,
        points: [
          'Define metrics once with grain, filters, time zone and formula.',
          'BI-native layer vs warehouse-side layer: reach vs another system.',
          'Ratios and percentiles are non-additive; compute them at query time.',
          'Enforce RLS near the data, via an entitlement table and real user identity.',
          'Extracts and service accounts can bypass tool-level RLS.',
        ],
        followups: [
          'How do you version a metric change so old reports can be reconciled?',
          'How would you test RLS in CI?',
        ],
        pitfalls: [
          'Copying a metric definition into each tool and calling that a semantic layer.',
          'Applying RLS in the dashboard while the same table is open to direct SQL.',
        ],
      },
      {
        id: 'analytics-28',
        topic: 'Plotly Dash',
        level: 2,
        q: `Write a small Plotly Dash app that lets a user pick scanners and see p90 scan time per day. Explain how callbacks work, where state should live, and what breaks under multiple workers.`,
        a: `Dash is a Python web app where the layout is a component tree and **callbacks** link component properties. A callback declares \`Output\`s, \`Input\`s (changes trigger it) and optionally \`State\`s (read at trigger time but do not trigger). When a user changes the dropdown, the browser sends the inputs to the server, your function runs, and the returned figure replaces the graph's \`figure\`.\n\nState rules:\n\n- Keep per-user state in the **browser** (\`dcc.Store\`, component values, the URL) or in an external store.\n- **Never mutate module-level globals** in a callback. With several workers or processes each has its own copy, and users share the same globals.\n- Load or precompute data once at start (here a daily aggregate), cache expensive queries (for example with \`flask_caching\` or an in-memory memoize), and aggregate in the warehouse, not in the callback.\n\nRaise \`PreventUpdate\` or return \`no_update\` to skip no-op triggers. For long queries use background callbacks or push heavy work out of the request path. API note: start the server with \`app.run\`; \`app.run_server\` was deprecated in Dash 2 and removed in Dash 3.`,
        code: `from dash import Dash, dcc, html, Input, Output\nimport pandas as pd\nimport plotly.express as px\n\n# precomputed in the warehouse: date, scanner_id, slides, p90_scan_min\ndf = pd.read_parquet("daily_scanner_metrics.parquet")\ndf["scanner"] = df["scanner_id"].astype(str)\n\napp = Dash(__name__)\napp.layout = html.Div([\n    dcc.Dropdown(id="scanner", options=sorted(df["scanner"].unique()),\n                 value=[], multi=True, placeholder="All scanners"),\n    dcc.Graph(id="trend"),\n])\n\n@app.callback(Output("trend", "figure"), Input("scanner", "value"))\ndef update(selected):\n    d = df[df["scanner"].isin(selected)] if selected else df\n    return px.line(d, x="date", y="p90_scan_min", color="scanner",\n                   labels={"p90_scan_min": "p90 scan time (min)"})\n\nif __name__ == "__main__":\n    app.run(debug=True)  # run_server on older Dash versions`,
        codeLang: 'python',
        points: [
          'Callbacks: Output, Input (triggers), State (read only).',
          'Per-user state in the browser or an external store, never module globals.',
          'Load or precompute data once; cache expensive queries; aggregate upstream.',
          'Dash version differences (app.run vs run_server) matter.',
        ],
        followups: [
          'How would you add a date range and avoid reloading the whole dataset?',
          'How do you put authentication in front of this app?',
        ],
        pitfalls: [
          'Querying the warehouse from inside the callback on every dropdown change.',
          'Using a global list that callbacks append to, then seeing users\' data mix.',
        ],
      },
      {
        id: 'analytics-29',
        topic: 'Custom visual apps',
        level: 3,
        q: `When is a custom visual app (d3 or React) worth building instead of using a BI tool, and how do d3 and React divide the work? Show the d3 data join and scales for a bar chart of slides per scanner.`,
        a: `Build custom when the BI tool cannot do what you need or the visual itself is the product:\n\n- **Domain-specific visuals**: a slide viewer with tile overlays, annotation geometry, or heatmaps in image coordinates. BI tools cannot render a whole-slide image coordinate system.\n- Embedding in a clinical or lab workflow with bespoke interactions, or tight control over data access.\n- Unusual chart types or very large point counts (canvas or WebGL).\n\nPrefer a BI tool for standard charts, self-service, governance and speed. Custom costs you authentication, hosting, tests, accessibility and permanent maintenance.\n\nIn code: d3's **data join** binds an array to DOM elements; with a key function, \`.join()\` handles enter, update and exit. **Scales** map data domain to pixel range (\`scaleBand\` for categories, \`scaleLinear\` for values). In a React app, let **React own the DOM**: render SVG elements from props and use d3 only for math (scales, shapes, layouts). If d3 also mutates the same DOM, the two fight, so confine d3 to a ref'd element if you must.`,
        code: `// d3 v7. Assumes <svg id="chart" width="480" height="240"> exists.\nconst data = [\n  { scanner: 'S1', slides: 420 },\n  { scanner: 'S2', slides: 355 },\n  { scanner: 'S3', slides: 190 },\n];\n\nconst x = d3.scaleBand()\n  .domain(data.map(d => d.scanner))\n  .range([40, 460])\n  .padding(0.2);\n\nconst y = d3.scaleLinear()\n  .domain([0, d3.max(data, d => d.slides)]).nice()\n  .range([220, 10]);\n\nd3.select('#chart')\n  .selectAll('rect')\n  .data(data, d => d.scanner)      // key function: stable identity across updates\n  .join('rect')                    // enter + update + exit in one call\n    .attr('x', d => x(d.scanner))\n    .attr('y', d => y(d.slides))\n    .attr('width', x.bandwidth())\n    .attr('height', d => y(0) - y(d.slides));`,
        codeLang: 'text',
        points: [
          'Custom wins for domain-specific visuals, workflow embedding and unusual interaction.',
          'BI wins for standard charts, self-service, governance and speed.',
          'd3 join with a key function; scales map domain to range.',
          'In React, React renders the DOM and d3 supplies scales and shapes.',
          'Count the long-run cost: auth, hosting, tests, accessibility.',
        ],
        followups: [
          'How would you render 5 million points smoothly?',
          'How would you make the chart keyboard and screen-reader accessible?',
        ],
        pitfalls: [
          'Rebuilding a standard dashboard by hand because it looks fun.',
          'Letting d3 and React both manage the same DOM nodes.',
        ],
      },
      {
        id: 'analytics-30',
        topic: 'Dashboard design',
        level: 1,
        q: `Design an operations dashboard for scanner throughput and turnaround time. Which chart types do you use for each metric, and what do you leave out?`,
        a: `Start with the questions: Is the lab keeping up right now? Is anything slipping? Where is the bottleneck?\n\n- **Top row**: a few KPI tiles with a target and a trend marker: slides scanned today, queue depth, % of cases within turnaround target, rescan rate. Define each with its denominator.\n- **Throughput**: slides per hour as a bar or line over time, with scanner downtime and maintenance annotated; an **hour-of-day by weekday heatmap** for load patterns.\n- **Turnaround time**: p50, p90 and p95 as lines over time (not the mean alone), plus a histogram or ECDF for the current period to show the tail.\n- **Scanner comparison**: sorted horizontal bars or small multiples with the same axes, not a rainbow of lines.\n- **Bottleneck**: scan, QC, upload and queue wait as a stacked bar or waterfall of where time goes.\n- **Drill-down** to the slide or case list that explains a spike.\n\nLeave out: pie charts, dual axes, truncated bar baselines, and decorative gauges. Use one time zone, label units, and show data freshness. Page on-call for incidents through alerts, not by someone staring at a dashboard.`,
        points: [
          'Lead with a few KPIs with targets; define denominators.',
          'Show percentiles, not just the mean, for turnaround.',
          'Use small multiples or sorted bars for scanner comparison.',
          'Annotate downtime; show data freshness and time zone.',
          'Avoid pies, dual axes and truncated bars; use alerts for incidents.',
        ],
        followups: [
          'How would you separate an operations view from a monthly management view?',
          'What would the drill-down from a red KPI tile show?',
        ],
        pitfalls: [
          'A wall of 30 charts with no question behind them.',
          'Plotting the mean turnaround with no target line, so nobody knows if it is good.',
        ],
      },
    ],
    glossary: [
      { term: 'PSI (population stability index)', def: 'A drift score: sum of (actual share - expected share) * ln(actual / expected) over bins of a reference distribution. Common rule-of-thumb thresholds are 0.1 and 0.25, which are heuristics.' },
      { term: 'Cohen\'s kappa', def: 'Agreement between two raters corrected for chance: (observed - chance) / (1 - chance). Sensitive to prevalence; weighted kappa handles ordinal labels.' },
      { term: 'PPV', def: 'Positive predictive value: the share of positive calls that are truly positive. It depends on prevalence, unlike sensitivity and specificity.' },
      { term: 'Calibration', def: 'Whether predicted probabilities match observed frequencies, for example whether slides scored 0.8 are positive about 80% of the time. Independent of ranking quality (AUC).' },
      { term: 'Micro-partition', def: 'Snowflake\'s unit of table storage: an immutable columnar chunk of roughly 50 to 500 MB uncompressed, with per-column metadata used to prune scans.' },
      { term: 'Zero-copy clone', def: 'A metadata-only copy of a Snowflake table, schema or database that shares storage with the source until either side changes.' },
      { term: 'Data virtualization', def: 'A logical layer that exposes data from several sources as virtual views and queries them in place, without copying it first. Denodo is one such platform.' },
      { term: 'Semantic layer', def: 'A governed definition of entities, joins and metrics that several BI tools and notebooks share, so one metric name means one calculation.' },
      { term: 'Star schema', def: 'A model with a central fact table joined to dimension tables by one-to-many relationships; the shape BI engines such as Power BI work best with.' },
    ],
  });
})();
