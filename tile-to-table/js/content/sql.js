/* SQL deck: advanced SQL against the shared synthetic slide-imaging schema (windows, islands, SCD2, incremental loads, indexing, partitioning, semi-structured data, isolation). Plain data, loaded by the page and the tests. */
(function () {
  'use strict';

  // Paragraph helper: joins mini-markdown paragraphs with a blank line.
  const P = (...parts) => parts.join('\n\n');

  (globalThis.TT_DECKS = globalThis.TT_DECKS || []).push({
    id: 'sql',
    title: 'SQL',
    blurb: 'Windows, gaps and islands, SCD2 and incremental loads, indexing, partitioning, and warehouse dialects, all on a slide-scanner schema.',
    order: 1,
    cards: [
      {
        id: 'sql-01',
        topic: 'Window functions',
        level: 1,
        q: 'Rank slides by `file_bytes` within each scanner. Show the three ranking functions side by side and say what each one does with ties. Predict the output for the sample rows.',
        setup: `-- slides excerpt for scanner 3 (file_mb shown for readability; the column is file_bytes)
-- slide_id | scanner_id | file_mb
--       11 |          3 |     900
--       12 |          3 |     850
--       13 |          3 |     850
--       14 |          3 |     700`,
        setupLang: 'sql',
        a: P(
          'All three number rows within a partition by the ORDER BY. They differ only on ties. ROW_NUMBER never ties: it yields 1..n and breaks ties arbitrarily unless you add a tie-breaker column. RANK gives tied rows the same number and then skips (1, 2, 2, 4). DENSE_RANK gives tied rows the same number and does not skip (1, 2, 2, 3).',
          'For the sample, slide 11 gets (1, 1, 1), slide 12 gets (2, 2, 2), slide 13 gets (3, 2, 2), and slide 14 gets (4, 4, 3) as (row_number, rank, dense_rank). ROW_NUMBER put 12 before 13 only because of the slide_id tie-breaker.',
          'Choose by the question. "Exactly one row per group" is ROW_NUMBER with a deterministic tie-breaker. "Everything in the top 3 places, ties included" is RANK or DENSE_RANK. Without a tie-breaker, ROW_NUMBER can return different rows on two runs of the same query.'
        ),
        code: `SELECT slide_id, scanner_id, file_bytes,
       ROW_NUMBER() OVER (PARTITION BY scanner_id ORDER BY file_bytes DESC, slide_id) AS rn,
       RANK()       OVER (PARTITION BY scanner_id ORDER BY file_bytes DESC)           AS rnk,
       DENSE_RANK() OVER (PARTITION BY scanner_id ORDER BY file_bytes DESC)           AS drnk
FROM slides;`,
        codeLang: 'sql',
        points: [
          'ROW_NUMBER is unique per partition; RANK and DENSE_RANK repeat on ties.',
          'RANK leaves gaps after ties; DENSE_RANK does not.',
          'ROW_NUMBER needs a tie-breaker to be deterministic.',
          'PARTITION BY restarts the numbering; omit it and the whole table is one partition.',
          'Window functions run after WHERE and GROUP BY, so you cannot filter on them in the same SELECT.'
        ],
        followups: [
          'How would you keep only rank 1 in one statement on Snowflake or BigQuery?',
          'What does NTILE(4) do when the row count is not divisible by 4?'
        ],
        pitfalls: [
          'Using ROW_NUMBER for "top 3 including ties" silently drops tied rows.',
          'Writing WHERE rn <= 3 in the same SELECT that defines rn.'
        ]
      },

      {
        id: 'sql-02',
        topic: 'Top-N per group',
        level: 1,
        q: 'Return the two largest slides (by `file_bytes`) for every case. Then say how the query changes if you want ties for second place included, and what can go wrong if `file_bytes` has NULLs.',
        a: P(
          'Rank inside each case with a window function, then filter in an outer query. The inner query must be a subquery or CTE because the window result does not exist yet at WHERE time.',
          'For "exactly two rows per case", use ROW_NUMBER with a tie-breaker (slide_id). For "two places, ties included", swap in RANK or DENSE_RANK and keep the filter at 2; a case may then return more than two rows.',
          'NULL ordering is dialect dependent. Postgres and Snowflake treat NULL as larger than any value by default, so ORDER BY file_bytes DESC puts NULL first and a failed scan with no size would be "the largest slide". BigQuery and SQL Server treat NULL as smallest. Either filter NULLs out first or say NULLS LAST where supported (not in T-SQL; use a CASE sort key there).',
          'For huge groups with a good index, a LATERAL or CROSS APPLY with a small ORDER BY ... LIMIT per group can beat ranking every row.'
        ),
        code: `SELECT case_id, slide_id, file_bytes
FROM (
  SELECT s.case_id, s.slide_id, s.file_bytes,
         ROW_NUMBER() OVER (
           PARTITION BY s.case_id
           ORDER BY s.file_bytes DESC NULLS LAST, s.slide_id
         ) AS rn
  FROM slides s
) x
WHERE rn <= 2;
-- ties for second place included: replace ROW_NUMBER() with RANK()`,
        codeLang: 'sql',
        points: [
          'Rank in a subquery or CTE, filter in the outer query.',
          'ROW_NUMBER gives exactly N; RANK gives N places with ties.',
          'Add a deterministic tie-breaker.',
          'NULL sort position differs by dialect; handle it explicitly.',
          'LATERAL/APPLY is an alternative when an index supports a per-group seek.'
        ],
        followups: ['How would you do this with QUALIFY?'],
        pitfalls: ['Forgetting that DESC flips where NULLs land in some dialects.']
      },

      {
        id: 'sql-03',
        topic: 'Deduplication',
        level: 1,
        q: 'A retry storm produced several rows per slide, model name, and model version in `inference_runs`. Keep only the latest attempt for each. What do you do about the tied timestamps in the sample, and what is the decision hiding in the word "latest"?',
        setup: `-- run_id | slide_id | model_name | model_version | started_at          | status
--   9001 |      501 | tumor-seg  | 2.3.1         | 2026-10-20 10:00:00 | error
--   9002 |      501 | tumor-seg  | 2.3.1         | 2026-10-20 10:07:00 | ok
--   9003 |      501 | tumor-seg  | 2.3.1         | 2026-10-20 10:07:00 | ok
--   9010 |      502 | tumor-seg  | 2.3.1         | 2026-10-20 10:02:00 | ok`,
        setupLang: 'sql',
        a: P(
          'Number the rows in each key with ROW_NUMBER, ordered newest first, and keep rn = 1. For slide 501 that keeps 9003: 9002 and 9003 tie on started_at, so a second sort key (run_id DESC) makes the choice deterministic. Without it, two runs of the query could keep different rows.',
          'The hidden decision: "latest attempt" and "latest successful run" are different. If the last retry errored, the first definition keeps an error row. For the second, filter to status = \'ok\' before ranking, not after, or you return nothing for that slide.',
          'Dedupe into a new table (CTAS, or SELECT INTO in T-SQL) and swap, rather than deleting in place, when the table is large. On Snowflake or BigQuery, QUALIFY removes the subquery.'
        ),
        code: `CREATE TABLE inference_latest AS
SELECT run_id, slide_id, model_name, model_version, started_at, finished_at, status, score
FROM (
  SELECT r.*,
         ROW_NUMBER() OVER (
           PARTITION BY r.slide_id, r.model_name, r.model_version
           ORDER BY r.started_at DESC, r.run_id DESC
         ) AS rn
  FROM inference_runs r
) x
WHERE rn = 1;`,
        codeLang: 'sql',
        points: [
          'PARTITION BY the natural key, ORDER BY the recency column descending.',
          'Add a unique tie-breaker so the result is deterministic.',
          'Decide what "latest" means (any attempt vs successful) and filter before ranking if needed.',
          'Prefer building a clean table over in-place deletes at scale.'
        ],
        followups: ['How would you detect the duplicates first, as a data quality check?'],
        pitfalls: ['Using SELECT DISTINCT, which only removes rows identical in every column.', 'Using MAX(started_at) in a self-join, which returns both tied rows.']
      },

      {
        id: 'sql-04',
        topic: 'NULL semantics',
        level: 1,
        q: 'Predict the result of each query on the six sample rows, then write the version of query 1 that returns every slide that has not passed QC.',
        setup: `-- slides.qc_status for 6 rows: 'pass', 'pass', 'fail', 'pending', NULL, NULL
-- (NULL = rows loaded before QC existed)

-- Q1: SELECT COUNT(*) FROM slides WHERE qc_status <> 'pass';
-- Q2: SELECT COUNT(*) FROM slides WHERE qc_status = NULL;
-- Q3: SELECT COUNT(qc_status), COUNT(*) FROM slides;
-- Q4: SELECT COUNT(DISTINCT qc_status) FROM slides;
-- Q5: SELECT qc_status, COUNT(*) FROM slides GROUP BY qc_status;`,
        setupLang: 'sql',
        a: P(
          'Comparisons with NULL yield UNKNOWN, and WHERE keeps only TRUE rows. Q1 returns 2 (fail and pending), not 4: the NULL rows are dropped. Q2 returns 0 because `= NULL` is never TRUE; use IS NULL. Q3 returns 4 and 6, since COUNT(col) skips NULLs and COUNT(*) does not. Q4 returns 3: DISTINCT ignores NULL in the count. Q5 returns four groups, because GROUP BY puts all NULLs into one group.',
          'To get "not passed", including NULL, use IS DISTINCT FROM (null-safe inequality; ANSI, Postgres, Snowflake, BigQuery, and SQL Server 2022 and later), or the spelled-out OR IS NULL form everywhere else.',
          'Related traps: NOT IN with a NULL in the list, AVG ignoring NULLs (so the denominator is not the row count), and NULL + 1 being NULL.'
        ),
        code: `-- 4 rows: fail, pending, NULL, NULL
SELECT COUNT(*) FROM slides WHERE qc_status IS DISTINCT FROM 'pass';

-- portable spelling
SELECT COUNT(*) FROM slides WHERE qc_status <> 'pass' OR qc_status IS NULL;`,
        codeLang: 'sql',
        points: [
          'Any comparison with NULL is UNKNOWN; WHERE drops UNKNOWN rows.',
          'Use IS NULL, never = NULL.',
          'COUNT(col) skips NULLs; COUNT(*) counts rows.',
          'GROUP BY and DISTINCT treat NULLs as one group even though NULL = NULL is not TRUE.',
          'IS DISTINCT FROM is the null-safe comparison.'
        ],
        followups: ['What does COALESCE(qc_status, \'unknown\') <> \'pass\' do to index usage?'],
        pitfalls: ['Assuming <> \'pass\' means "everything except pass".']
      },

      {
        id: 'sql-05',
        topic: 'Anti-joins',
        level: 1,
        q: 'Find cases that have no slides. Compare NOT EXISTS, NOT IN, and LEFT JOIN ... IS NULL, and say which one breaks on the sample data and why.',
        setup: `-- cases.case_id:   1, 2, 3
-- slides.case_id:  1, 1, 2, NULL   (one slide was loaded without its case link)`,
        setupLang: 'sql',
        a: P(
          'Case 3 is the only correct answer. NOT IN returns zero rows here: `3 NOT IN (1, 1, 2, NULL)` expands to `3 <> 1 AND 3 <> 1 AND 3 <> 2 AND 3 <> NULL`, and the last term is UNKNOWN, so the whole predicate can never be TRUE. A single NULL in the subquery silently empties the result.',
          'NOT EXISTS is correlated and NULL-safe: it asks whether any matching row exists and ignores NULL keys. LEFT JOIN ... IS NULL is equally safe if you test a non-nullable column of the right side (the primary key, not a column that can be NULL for real matches). Modern optimizers usually plan NOT EXISTS and the LEFT JOIN as the same anti-join; NOT IN can fall back to a much slower plan in some engines.',
          'Default to NOT EXISTS. Use NOT IN only when the subquery column is declared NOT NULL, and remember warehouses often do not enforce that.'
        ),
        code: `SELECT c.case_id
FROM cases c
WHERE NOT EXISTS (
  SELECT 1 FROM slides s WHERE s.case_id = c.case_id
);

-- equivalent
SELECT c.case_id
FROM cases c
LEFT JOIN slides s ON s.case_id = c.case_id
WHERE s.slide_id IS NULL;`,
        codeLang: 'sql',
        points: [
          'NOT IN plus any NULL in the list returns no rows.',
          'NOT EXISTS ignores NULL keys and is the safe default.',
          'LEFT JOIN anti-join must test a non-null right-side column.',
          'Optimizers usually treat NOT EXISTS and LEFT JOIN anti-joins the same.'
        ],
        followups: ['How would you also exclude NULLs inside the NOT IN subquery to rescue it?'],
        pitfalls: ['Testing a nullable right-side column in the IS NULL check.', 'Using EXCEPT and forgetting it also deduplicates.']
      },

      {
        id: 'sql-06',
        topic: 'Conditional aggregation',
        level: 1,
        q: 'For October, produce one row per scanner site and model with columns for passed, failed, and pending slide counts, plus a fail percentage among slides that completed QC. Make it safe against divide-by-zero.',
        a: P(
          'This is the pivot pattern: group by the dimension and put a CASE inside each aggregate. COUNT(CASE WHEN cond THEN 1 END) counts only matching rows because the missing ELSE yields NULL and COUNT skips NULL. If you write ELSE 0 inside a COUNT, every row counts and the column equals the row count.',
          'The fail rate denominator is slides with a final QC result (pass or fail), not all slides, since pending ones have no verdict yet. Wrap it in NULLIF(..., 0) so a site with only pending slides returns NULL rather than an error. Use 100.0 (not 100) to avoid integer division in dialects that truncate.',
          'Where available, COUNT_IF (Snowflake), COUNTIF (BigQuery), or COUNT(*) FILTER (WHERE ...) (Postgres) read better, but the CASE form works everywhere. Every non-aggregated column in SELECT must appear in GROUP BY.'
        ),
        code: `SELECT sc.site, sc.model,
       COUNT(CASE WHEN s.qc_status = 'pass'    THEN 1 END) AS n_pass,
       COUNT(CASE WHEN s.qc_status = 'fail'    THEN 1 END) AS n_fail,
       COUNT(CASE WHEN s.qc_status = 'pending' THEN 1 END) AS n_pending,
       ROUND(100.0 * COUNT(CASE WHEN s.qc_status = 'fail' THEN 1 END)
             / NULLIF(COUNT(CASE WHEN s.qc_status IN ('pass', 'fail') THEN 1 END), 0), 1) AS fail_pct
FROM slides s
JOIN scanners sc ON sc.scanner_id = s.scanner_id
WHERE s.scanned_at >= '2026-10-01' AND s.scanned_at < '2026-11-01'
GROUP BY sc.site, sc.model
ORDER BY fail_pct DESC;`,
        codeLang: 'sql',
        points: [
          'CASE inside an aggregate pivots rows to columns.',
          'COUNT(CASE ... THEN 1 END) works because COUNT skips NULL.',
          'Choose the denominator deliberately (completed QC only).',
          'NULLIF guards divide-by-zero; 100.0 avoids integer division.',
          'Half-open date range keeps the filter index-friendly.'
        ],
        followups: ['How does this change if you need the stain types as columns but the list changes monthly?'],
        pitfalls: ['COUNT(CASE WHEN ... THEN 1 ELSE 0 END), which counts everything.', 'SUM(CASE WHEN ... THEN 1 END) with no ELSE 0, which returns NULL instead of 0 when no row matches.']
      },

      {
        id: 'sql-07',
        topic: 'Set operations',
        level: 1,
        q: 'Write queries for: (a) cases that have both an H&E slide and an IHC-Ki67 slide, (b) cases with H&E but no Ki67. Then explain UNION vs UNION ALL, how set operations treat NULLs, and one dialect difference.',
        a: P(
          'INTERSECT returns rows present in both inputs and EXCEPT returns rows in the first but not the second. Both deduplicate, so there is no need for DISTINCT. They compare entire rows and treat NULLs as equal, which makes EXCEPT a NULL-safe anti-join (unlike NOT IN).',
          'UNION removes duplicates, which costs a sort or hash; UNION ALL just concatenates and is the right default for appending feeds when duplicates are impossible or acceptable. Column count and compatible types must match, and columns pair by position, not name. In standard SQL INTERSECT binds tighter than UNION and EXCEPT, so use parentheses when mixing them.',
          'Dialect notes: Oracle calls EXCEPT MINUS. BigQuery does not accept a bare set operator: write UNION ALL or UNION DISTINCT, and INTERSECT DISTINCT or EXCEPT DISTINCT. Case (a) can also be written as a GROUP BY with HAVING over two conditional counts, which scans slides once.'
        ),
        code: `-- (a) both stains
SELECT case_id FROM slides WHERE stain = 'H&E'
INTERSECT
SELECT case_id FROM slides WHERE stain = 'IHC-Ki67';

-- (b) H&E but no Ki67
SELECT case_id FROM slides WHERE stain = 'H&E'
EXCEPT
SELECT case_id FROM slides WHERE stain = 'IHC-Ki67';

-- single-scan alternative for (a)
SELECT case_id
FROM slides
WHERE stain IN ('H&E', 'IHC-Ki67')
GROUP BY case_id
HAVING COUNT(DISTINCT stain) = 2;`,
        codeLang: 'sql',
        points: [
          'INTERSECT and EXCEPT deduplicate and compare whole rows.',
          'Set operations treat NULLs as equal.',
          'UNION ALL avoids the dedupe cost; UNION dedupes.',
          'Columns match by position and type.',
          'BigQuery requires an explicit ALL or DISTINCT; Oracle uses MINUS.'
        ],
        followups: ['Which of these is fastest on a billion-row slides table, and why?'],
        pitfalls: ['Reaching for UNION when UNION ALL is correct, paying for a sort.']
      },

      {
        id: 'sql-08',
        topic: 'Debug this query',
        level: 1,
        q: 'The goal is one row for every case with its count of H&E slides, showing 0 for cases that have none. The output is missing cases. Find the bug and fix it.',
        setup: `SELECT c.case_id, COUNT(s.slide_id) AS he_slides
FROM cases c
LEFT JOIN slides s ON s.case_id = c.case_id
WHERE s.stain = 'H&E'
GROUP BY c.case_id;`,
        setupLang: 'sql',
        a: P(
          'The WHERE clause filters after the join. For a case with no H&E slide, the LEFT JOIN produces one row with s.stain = NULL, and `NULL = \'H&E\'` is not TRUE, so the row is dropped. The LEFT JOIN has been turned into an inner join, which is why zero-count cases vanish.',
          'Move the right-table predicate into the ON clause so it limits which slides match, not which cases survive. Now unmatched cases keep their single NULL-padded row, and COUNT(s.slide_id) counts zero for them. Count a right-side column, not COUNT(*), or the NULL-padded row counts as 1.',
          'Rule of thumb: for an outer join, filters on the preserved side go in WHERE; filters on the optional side go in ON (or you accept inner join semantics on purpose).'
        ),
        code: `SELECT c.case_id, COUNT(s.slide_id) AS he_slides
FROM cases c
LEFT JOIN slides s
       ON s.case_id = c.case_id
      AND s.stain = 'H&E'
GROUP BY c.case_id;`,
        codeLang: 'sql',
        points: [
          'A WHERE predicate on the optional table nullifies the outer join.',
          'Put optional-side filters in ON.',
          'COUNT(right_col) gives 0 for unmatched rows; COUNT(*) gives 1.',
          'Preserved-side filters belong in WHERE.'
        ],
        followups: ['Is there a case where the WHERE version is what you actually want?'],
        pitfalls: ['Switching to COUNT(*) and getting 1 for cases with no slides.']
      },

      {
        id: 'sql-09',
        topic: 'Window functions',
        level: 2,
        q: 'For each slide, show how long each event took relative to the previous event (queue wait, scan time, upload time). Which window functions do you use, and how do you guard against events with the same timestamp?',
        setup: `-- scan_events for slide 501
-- event_id | event_type | event_ts
--      1   | queued     | 2026-10-20 08:00:00
--      2   | scan_start | 2026-10-20 08:12:30
--      3   | scan_end   | 2026-10-20 08:31:10
--      4   | uploaded   | 2026-10-20 08:34:00`,
        setupLang: 'sql',
        a: P(
          'LAG looks at the previous row in the window order and LEAD at the next. Partition by slide_id and order by event_ts. For slide 501 the step durations come out as: scan_start 750 s after queued, scan_end 1120 s after scan_start, uploaded 170 s after scan_end.',
          'Order by event_ts, event_id: if two events share a timestamp, event_id makes the order deterministic, otherwise LAG may pick either one and the durations change between runs. The first row per slide has no previous row, so LAG returns NULL (or the default you pass as the third argument).',
          'Timestamp subtraction is dialect specific: Snowflake DATEDIFF(\'second\', a, b), BigQuery TIMESTAMP_DIFF(b, a, SECOND), SQL Server DATEDIFF(second, a, b), Postgres EXTRACT(EPOCH FROM b - a). If a slide has rescans, event types repeat, so the previous-type column tells you which step you are measuring.',
          'For one row per slide with named step durations, pivot instead: MIN(CASE WHEN event_type = \'scan_start\' THEN event_ts END) and so on.'
        ),
        code: `-- Snowflake
SELECT slide_id, event_type, event_ts,
       LAG(event_type) OVER (PARTITION BY slide_id ORDER BY event_ts, event_id) AS prev_type,
       DATEDIFF('second',
                LAG(event_ts) OVER (PARTITION BY slide_id ORDER BY event_ts, event_id),
                event_ts) AS sec_since_prev
FROM scan_events
WHERE slide_id = 501
ORDER BY event_ts, event_id;`,
        codeLang: 'sql',
        points: [
          'LAG/LEAD read neighbor rows by window order without a self-join.',
          'Partition by the entity, order by time plus a unique tie-breaker.',
          'First row has NULL (or the default argument).',
          'Include the previous event type so steps are labeled, especially with rescans.',
          'Timestamp difference syntax differs per dialect.'
        ],
        followups: ['How would you find slides whose queue wait exceeded 30 minutes?'],
        pitfalls: ['Ordering by event_ts only, then getting unstable results on ties.', 'Using a self-join on event_id + 1, which breaks with gaps.']
      },

      {
        id: 'sql-10',
        topic: 'Window functions',
        level: 2,
        q: 'Compute a running total of scanned bytes in scan order on one scanner. Two slides share a timestamp. Show how the default frame and an explicit ROWS frame differ on the sample, and explain RANGE vs ROWS.',
        setup: `-- scanner 3, in order (file_gb shown; column is file_bytes)
-- slide_id | scanned_at          | file_gb
--        1 | 2026-10-01 09:00:00 |     1.0
--        2 | 2026-10-01 09:05:00 |     2.0
--        3 | 2026-10-01 09:05:00 |     3.0
--        4 | 2026-10-01 09:10:00 |     1.0`,
        setupLang: 'sql',
        a: P(
          'With an ORDER BY and no frame clause, the default frame is RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW. RANGE includes every peer of the current row, meaning all rows with the same ORDER BY value. So slides 2 and 3 both show 6.0 (1+2+3), giving 1, 6, 6, 7. ROWS counts physical rows, giving 1, 3, 6, 7 when the order is made unique with slide_id.',
          'Use ROWS for running totals and moving windows: it is predictable and usually cheaper. Use RANGE when you really want value-based windows (all rows within N units of the current value). Support varies: RANGE with an interval offset works in Postgres 11+, BigQuery needs a numeric ORDER BY expression, and other engines may only allow UNBOUNDED/CURRENT ROW, so check your dialect.',
          'Without ORDER BY, the frame is the entire partition (a grand total per partition). A related trap: LAST_VALUE with the default frame returns the current row (or its last tie), not the last in the partition, because the frame ends at CURRENT ROW and its peers.'
        ),
        code: `SELECT slide_id, scanned_at, file_bytes,
       SUM(file_bytes) OVER (PARTITION BY scanner_id ORDER BY scanned_at) AS running_default,
       SUM(file_bytes) OVER (
         PARTITION BY scanner_id
         ORDER BY scanned_at, slide_id
         ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
       ) AS running_rows
FROM slides
WHERE scanner_id = 3
  AND scanned_at >= '2026-10-01' AND scanned_at < '2026-10-02';`,
        codeLang: 'sql',
        points: [
          'Default frame with ORDER BY is RANGE UNBOUNDED PRECEDING to CURRENT ROW.',
          'RANGE includes peers with equal ORDER BY values; ROWS counts physical rows.',
          'Make the order unique when you want a true running total.',
          'No ORDER BY means the frame is the whole partition.',
          'RANGE with offsets is dialect dependent.'
        ],
        followups: ['How would you compute a trailing 7-day average when some days have no scans?'],
        pitfalls: ['Trusting the default frame and publishing duplicated running values on ties.', 'LAST_VALUE returning the current row because of the default frame.']
      },

      {
        id: 'sql-11',
        topic: 'Gaps and islands',
        level: 2,
        q: 'For each scanner, find streaks of consecutive days with at least one completed scan (`scan_end` event), then list the gaps between streaks as downtime. Use the row-number-difference trick.',
        a: P(
          'Reduce to one row per scanner per active day (DISTINCT is required, otherwise duplicate days break the arithmetic). Then subtract ROW_NUMBER() days from each date. Within an unbroken run of consecutive days, the date and the row number both advance by one, so the difference is constant. Any missing day makes the difference jump, so each constant value identifies one island.',
          'Group by scanner and that group key to get first_day, last_day, and length. Downtime is the space between islands: LEAD(first_day) over the islands gives the next streak start, and the gap is next_first - last_day - 1 whole days.',
          'This works on integers or dates. For timestamps with a tolerance (gap larger than 30 minutes), use the LAG-and-flag sessionization pattern instead, because there is no dense integer sequence to subtract. Syntax below is Snowflake; in Postgres write d - ROW_NUMBER() OVER (...)::int.'
        ),
        code: `WITH days AS (
  SELECT DISTINCT scanner_id, CAST(event_ts AS DATE) AS d
  FROM scan_events
  WHERE event_type = 'scan_end'
),
numbered AS (
  SELECT scanner_id, d,
         DATEADD('day', -ROW_NUMBER() OVER (PARTITION BY scanner_id ORDER BY d), d) AS grp
  FROM days
),
islands AS (
  SELECT scanner_id, MIN(d) AS first_day, MAX(d) AS last_day, COUNT(*) AS days_active
  FROM numbered
  GROUP BY scanner_id, grp
)
SELECT scanner_id,
       DATEADD('day', 1, last_day)         AS down_from,
       DATEADD('day', -1, next_first)      AS down_to,
       DATEDIFF('day', last_day, next_first) - 1 AS down_days
FROM (
  SELECT i.*, LEAD(first_day) OVER (PARTITION BY scanner_id ORDER BY first_day) AS next_first
  FROM islands i
) x
WHERE next_first IS NOT NULL
ORDER BY scanner_id, down_from;`,
        codeLang: 'sql',
        points: [
          'De-duplicate to one row per entity per day first.',
          'date minus ROW_NUMBER is constant within a consecutive run.',
          'GROUP BY entity plus that constant to collapse each island.',
          'Gaps come from LEAD(next island start) minus this island end.',
          'Only works for dense, integer-like sequences; use LAG and flags for tolerance-based gaps.'
        ],
        followups: ['How do you include the open streak that ends today?'],
        pitfalls: ['Skipping the DISTINCT and getting wrong islands when a day has multiple events.']
      },

      {
        id: 'sql-12',
        topic: 'Gaps and islands',
        level: 3,
        q: 'Sessionize scanner activity: a new busy session starts when a `scan_start` arrives more than 30 minutes after the previous `scan_end` on the same scanner. Write the query, and explain why measuring the gap between any two consecutive events would be wrong.',
        a: P(
          'Classic three-step sessionization: LAG to see the previous event, a flag that is 1 where a new session begins, then a running SUM of the flag to turn flags into session numbers. Group by scanner and session number for start, end, and event count.',
          'Gap between any two consecutive events is wrong here. Events only exist at scan_start and scan_end, so a single scan lasting 45 minutes would look like 45 idle minutes inside one slide and split the session. The idle gap that matters is previous scan_end to next scan_start, so the flag checks both event types and the distance.',
          'Compare in seconds (> 1800). DATEDIFF with minutes counts minute boundaries crossed, so two events 30 min 59 s apart can report 31 or 30 depending on where they fall. Order by event_ts and event_id throughout so ties are stable, and use an explicit ROWS frame for the running sum.',
          'Downtime is then LEAD(session_start) minus session_end per scanner. If a scanner can legitimately hold several slides in flight, you need interval merging rather than event pairs.'
        ),
        code: `-- Snowflake
WITH ev AS (
  SELECT event_id, scanner_id, event_type, event_ts,
         LAG(event_type) OVER (PARTITION BY scanner_id ORDER BY event_ts, event_id) AS prev_type,
         LAG(event_ts)   OVER (PARTITION BY scanner_id ORDER BY event_ts, event_id) AS prev_ts
  FROM scan_events
  WHERE event_type IN ('scan_start', 'scan_end')
),
flagged AS (
  SELECT event_id, scanner_id, event_ts,
         CASE WHEN prev_type IS NULL THEN 1
              WHEN event_type = 'scan_start' AND prev_type = 'scan_end'
                   AND DATEDIFF('second', prev_ts, event_ts) > 1800 THEN 1
              ELSE 0 END AS new_session
  FROM ev
),
numbered AS (
  SELECT scanner_id, event_ts,
         SUM(new_session) OVER (
           PARTITION BY scanner_id ORDER BY event_ts, event_id
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
         ) AS session_no
  FROM flagged
)
SELECT scanner_id, session_no,
       MIN(event_ts) AS session_start,
       MAX(event_ts) AS session_end,
       COUNT(*)      AS events
FROM numbered
GROUP BY scanner_id, session_no;`,
        codeLang: 'sql',
        points: [
          'LAG, then a new-session flag, then a running SUM of the flag.',
          'Flag only on scan_end to scan_start gaps, not any consecutive events.',
          'Compare in seconds to avoid boundary-counting surprises in DATEDIFF.',
          'Stable ordering needs a unique tie-breaker.',
          'Downtime is the distance between consecutive sessions.'
        ],
        followups: ['How would you handle a scanner that has a scan_start with no scan_end?', 'How would you compute total busy time per day from these sessions?'],
        pitfalls: ['Treating the long gap inside one slow scan as downtime.', 'Using the default RANGE frame for the running sum.']
      },

      {
        id: 'sql-13',
        topic: 'Percentiles',
        level: 2,
        q: 'Report median and 95th percentile inference duration in seconds by model, for successful runs only. Show exact and approximate options and the differences between Snowflake, BigQuery, SQL Server, and Postgres. Why not just use AVG?',
        a: P(
          'Latency distributions are right-skewed (a few huge slides or retries), so the mean is dragged up and hides the typical case; report p50 and p95 or p99 instead. PERCENTILE_CONT interpolates between values; PERCENTILE_DISC returns an actual value from the data.',
          'Syntax differs. Snowflake and Postgres: PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY x) as a regular aggregate. SQL Server: the same WITHIN GROUP form but only as a window function, so it needs OVER (PARTITION BY ...) and then DISTINCT. BigQuery: PERCENTILE_CONT is also analytic only (with OVER); for aggregates use APPROX_QUANTILES(x, 100)[OFFSET(95)].',
          'Exact percentiles need a sort of the group, which is expensive at billions of rows. Approximate versions (Snowflake APPROX_PERCENTILE, BigQuery APPROX_QUANTILES, SQL Server 2022 APPROX_PERCENTILE_CONT as a true aggregate, Postgres via extensions) use sketches such as t-digest or quantile summaries and are mergeable across partitions. Say the error bound is engine and parameter dependent.',
          'Filter status = \'ok\' first: failed or timed-out runs have different semantics and often NULL finished_at.'
        ),
        code: `-- Snowflake
SELECT model_name,
       COUNT(*) AS runs,
       PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY dur_s) AS p50_s,
       PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY dur_s) AS p95_s,
       APPROX_PERCENTILE(dur_s, 0.95)                      AS p95_approx_s
FROM (
  SELECT model_name,
         DATEDIFF('millisecond', started_at, finished_at) / 1000.0 AS dur_s
  FROM inference_runs
  WHERE status = 'ok' AND finished_at IS NOT NULL
) r
GROUP BY model_name;

-- BigQuery approximate: APPROX_QUANTILES(dur_s, 100)[OFFSET(95)]`,
        codeLang: 'sql',
        points: [
          'Mean hides skew; report p50 and tail percentiles.',
          'PERCENTILE_CONT interpolates; PERCENTILE_DISC returns an existing value.',
          'Aggregate vs window-only syntax differs by engine.',
          'Approximate percentiles use sketches and scale; exact needs a sort.',
          'Filter to the right population (ok runs) before computing.'
        ],
        followups: ['Can you average the p95 of each day to get a monthly p95?'],
        pitfalls: ['Averaging percentiles across groups.', 'Mixing failed or timed-out runs into latency stats.']
      },

      {
        id: 'sql-14',
        topic: 'Turnaround SLAs',
        level: 2,
        q: 'Compute turnaround time from `cases.received_at` to the first sign-out, by priority, with the percent of cases meeting an SLA (stat 24 h, rush 48 h, routine 72 h; synthetic targets). What traps are in the data, and what changes if the SLA is in business hours?',
        a: P(
          'Collapse signouts to one row per case first (MIN(signed_out_at) for first sign-out). Amended reports create multiple rows per case, and joining the raw table would duplicate cases and skew every average. Then join to cases and compute elapsed minutes divided by 60.0.',
          'Elapsed time in minutes, not DATEDIFF(\'hour\', ...): Snowflake and SQL Server count hour boundaries crossed, so 10:59 to 11:01 is one "hour". Computing percent within SLA with a CASE comparing minutes to target hours times 60 keeps the error under a minute (use seconds if that matters).',
          'Traps: an inner join drops unsigned cases, so the cohort is survivorship biased; open cases already past their target are breaches and must be counted. Time zones and DST matter if timestamps are local. Business hours need a calendar dimension (business day flag, holiday table, working windows) and a rule for clock stops; you cannot do it with simple subtraction. Either sum overlapping calendar intervals or count business days between dates and say which approximation you used.'
        ),
        code: `-- Snowflake; completed cohort for September
WITH first_so AS (
  SELECT case_id, MIN(signed_out_at) AS signed_out_at
  FROM signouts
  GROUP BY case_id
)
SELECT c.priority,
       COUNT(*) AS signed_cases,
       ROUND(AVG(DATEDIFF('minute', c.received_at, f.signed_out_at) / 60.0), 1) AS mean_h,
       ROUND(100.0 * SUM(CASE
                WHEN DATEDIFF('minute', c.received_at, f.signed_out_at)
                     <= 60 * CASE c.priority WHEN 'stat' THEN 24 WHEN 'rush' THEN 48 ELSE 72 END
                THEN 1 ELSE 0 END) / COUNT(*), 1) AS pct_within_sla
FROM cases c
JOIN first_so f ON f.case_id = c.case_id
WHERE c.received_at >= '2026-09-01' AND c.received_at < '2026-10-01'
GROUP BY c.priority;`,
        codeLang: 'sql',
        points: [
          'Pre-aggregate signouts to one row per case to avoid duplication.',
          'Measure minutes and divide; DATEDIFF hour counts boundaries.',
          'Inner join creates survivorship bias; account for open and breached cases.',
          'Business-hours SLAs need a calendar dimension and explicit rules.',
          'State the time zone and clock-stop assumptions.'
        ],
        followups: ['How would you report the median and p90 TAT too?', 'How would you handle cases with an amended sign-out?'],
        pitfalls: ['Joining raw signouts and double-counting amended cases.', 'Computing SLA percent only over completed cases and presenting it as overall.']
      },

      {
        id: 'sql-15',
        topic: 'Funnels',
        level: 2,
        q: 'Build a weekly cohort funnel for cases received: accessioned, has at least one slide, all slides scanned and passing QC, signed out. Each stage should be nested inside the previous one. Mind the grain.',
        a: P(
          'Aggregate each child table to the case grain first (slides to counts per case, signouts to a distinct case list), LEFT JOIN them to cases, derive 0/1 stage flags per case, and only then group by week. This avoids the fan-out that happens when you join cases to slides to signouts directly and count rows.',
          'Nesting is enforced by repeating the earlier conditions in each later flag, so a signed-out case with failed slides does not count as signed out in the funnel (or you would see a stage larger than the one before it). All-scanned-and-passing means n_scanned and n_pass both equal n_slides, with n_slides > 0.',
          'It is a cohort funnel (cases grouped by receive week), so recent weeks look worse simply because they are not finished yet; flag them as immature. Week start differs by dialect: Snowflake follows the WEEK_START parameter, Postgres truncates to Monday, BigQuery TIMESTAMP_TRUNC(x, WEEK) starts on Sunday.'
        ),
        code: `-- Snowflake
WITH slide_agg AS (
  SELECT case_id,
         COUNT(*)           AS n_slides,
         COUNT(scanned_at)  AS n_scanned,
         SUM(CASE WHEN qc_status = 'pass' THEN 1 ELSE 0 END) AS n_pass
  FROM slides
  GROUP BY case_id
),
so AS (SELECT DISTINCT case_id FROM signouts),
flags AS (
  SELECT DATE_TRUNC('week', c.received_at) AS wk,
         CASE WHEN sa.n_slides > 0 THEN 1 ELSE 0 END AS s_slide,
         CASE WHEN sa.n_slides > 0 AND sa.n_scanned = sa.n_slides
                   AND sa.n_pass = sa.n_slides THEN 1 ELSE 0 END AS s_clean,
         CASE WHEN sa.n_slides > 0 AND sa.n_scanned = sa.n_slides
                   AND sa.n_pass = sa.n_slides AND so.case_id IS NOT NULL THEN 1 ELSE 0 END AS s_signed
  FROM cases c
  LEFT JOIN slide_agg sa ON sa.case_id = c.case_id
  LEFT JOIN so ON so.case_id = c.case_id
  WHERE c.received_at >= '2026-09-01' AND c.received_at < '2026-11-01'
)
SELECT wk,
       COUNT(*)      AS accessioned,
       SUM(s_slide)  AS has_slides,
       SUM(s_clean)  AS scanned_and_passed,
       SUM(s_signed) AS signed_out,
       ROUND(100.0 * SUM(s_signed) / COUNT(*), 1) AS pct_signed_out
FROM flags
GROUP BY wk
ORDER BY wk;`,
        codeLang: 'sql',
        points: [
          'Aggregate child tables to the case grain before joining.',
          'Derive 0/1 stage flags, then SUM per cohort.',
          'Nest stages by repeating prior conditions.',
          'Recent cohorts are immature; mark or exclude them.',
          'Week truncation start day varies by engine.'
        ],
        followups: ['How would you add median time spent in each stage?'],
        pitfalls: ['Joining cases to slides to signouts and counting rows.', 'Comparing a period funnel to a cohort funnel as if they were the same.']
      },

      {
        id: 'sql-16',
        topic: 'Debug this query',
        level: 2,
        q: 'A report shows case 7 with 6.0 GB of slides and 6 annotations, but the case has two 1.0 GB slides (4 and 2 annotations). Find the bug, explain how you would have detected it, and fix it.',
        setup: `SELECT c.case_id,
       SUM(s.file_bytes)          AS total_bytes,
       COUNT(a.annotation_id)     AS n_annotations
FROM cases c
JOIN slides s ON s.case_id = c.case_id
LEFT JOIN annotations a ON a.slide_id = s.slide_id
GROUP BY c.case_id;`,
        setupLang: 'sql',
        a: P(
          'Fan-out. Joining slides to annotations repeats each slide row once per annotation: slide A appears 4 times and slide B twice, so SUM(file_bytes) adds 1.0 GB six times. COUNT(a.annotation_id) happens to come out right because there is exactly one annotation row per output row, which hides the problem.',
          'Fix by bringing each branch to the grain of the join before joining: aggregate annotations to one row per slide, then join. SUM(DISTINCT file_bytes) is not a fix: two different slides with the same size collapse into one.',
          'Detect it by asserting grain: compare COUNT(*) with COUNT(DISTINCT s.slide_id) after the join, check that the join key is unique on the side you expect to be one, and reconcile totals against the base table (SUM over slides alone). Cases with zero slides are absent in both versions because of the inner join; make it a LEFT JOIN from cases if they must appear.'
        ),
        code: `WITH ann AS (
  SELECT slide_id, COUNT(*) AS n_annotations
  FROM annotations
  GROUP BY slide_id
)
SELECT s.case_id,
       SUM(s.file_bytes)                 AS total_bytes,
       COALESCE(SUM(ann.n_annotations), 0) AS n_annotations
FROM slides s
LEFT JOIN ann ON ann.slide_id = s.slide_id
GROUP BY s.case_id;`,
        codeLang: 'sql',
        points: [
          'Joining a one-to-many side repeats parent rows and inflates additive measures.',
          'Pre-aggregate each branch to the join grain.',
          'SUM(DISTINCT) is wrong when values can legitimately repeat.',
          'Detect with row-count and distinct-key checks and base-table reconciliation.'
        ],
        followups: ['What if you also needed inference scores per slide in the same report?'],
        pitfalls: ['Using SUM(DISTINCT file_bytes).', 'Trusting that COUNT looks right so the SUM must be right.']
      },

      {
        id: 'sql-17',
        topic: 'Recursive CTEs',
        level: 2,
        q: 'Use a recursive CTE to list the pyramid levels of slide 101 (100000 x 80000 px at level 0): each level halves width and height (round up) until it fits in one 256 px tile. Return the level, its size, and its tile count. How many levels do you expect, and how do you make sure the recursion stops?',
        a: P(
          'A recursive CTE has an anchor (level 0 from the slides row) and a recursive member that refers to the CTE itself, joined with UNION ALL. The recursive member runs against the rows added in the previous step until it adds none. Termination comes from its WHERE clause: continue only while width or height still exceeds 256. Without such a guard you get an infinite loop or hit the engine limit.',
          'Halving 100000 x 80000 gives 50000x40000, 25000x20000, 12500x10000, 6250x5000, 3125x2500, 1563x1250, 782x625, 391x313, 196x157. Level 9 fits in a tile, so there are 10 levels (0 to 9). Level 0 needs CEIL(100000/256) x CEIL(80000/256) = 391 x 313 = 122,383 tiles.',
          'Type care: anchor and recursive columns must have the same type in most engines, and "/" can be decimal division (Snowflake, BigQuery), so use CEIL(w / 2.0) with a CAST to INT instead of relying on integer division. T-SQL omits the RECURSIVE keyword and caps depth at 100 unless you add OPTION (MAXRECURSION n).'
        ),
        code: `WITH RECURSIVE lvl (level, w, h) AS (
  SELECT 0, width_px, height_px
  FROM slides
  WHERE slide_id = 101
  UNION ALL
  SELECT level + 1,
         CAST(CEIL(w / 2.0) AS INT),
         CAST(CEIL(h / 2.0) AS INT)
  FROM lvl
  WHERE w > 256 OR h > 256
)
SELECT level, w, h,
       CAST(CEIL(w / 256.0) * CEIL(h / 256.0) AS BIGINT) AS tiles
FROM lvl
ORDER BY level;`,
        codeLang: 'sql',
        points: [
          'Anchor plus recursive member joined by UNION ALL.',
          'The recursive member must carry a stopping condition.',
          'Column types must match between anchor and recursion; avoid integer-vs-decimal division surprises.',
          'T-SQL: no RECURSIVE keyword, default 100-level limit, use OPTION (MAXRECURSION).',
          'Results: 10 levels, 122,383 tiles at level 0.'
        ],
        followups: ['What is the total tile count across all levels, roughly, as a fraction of level 0?'],
        pitfalls: ['A recursive term with no stop condition, or one that cannot reach it.', 'Using UNION instead of UNION ALL and paying for dedupe on each step.']
      },

      {
        id: 'sql-18',
        topic: 'Recursive CTEs',
        level: 2,
        q: 'Management wants daily completed-scan counts for October with zeros on days nothing was scanned. Write it in T-SQL using a recursive date spine, and explain the pitfalls and the alternatives in other dialects.',
        a: P(
          'A GROUP BY over events can only return days that have events. To show zero days you need a spine of all dates and a LEFT JOIN to the facts. The spine can be a recursive CTE, a calendar table, or a built-in generator.',
          'The two classic bugs: putting the event filter (event_type = \'scan_end\') in WHERE, which turns the LEFT JOIN back into an inner join and loses the zero days (keep it in ON), and counting with COUNT(*) instead of COUNT(se.event_id), which reports 1 for empty days.',
          'T-SQL limits recursion to 100 levels by default, so a 31-day spine works but a year does not; add OPTION (MAXRECURSION 0) or a number of your choosing, which sits on the final statement. Join as a half-open range (>= day, < day + 1) rather than casting event_ts, so an index on event_ts stays usable.',
          'Alternatives: Postgres generate_series, SQL Server 2022 GENERATE_SERIES, BigQuery UNNEST(GENERATE_DATE_ARRAY(...)), Snowflake TABLE(GENERATOR(ROWCOUNT => n)) with ROW_NUMBER. A permanent dim_date table is better still because it also carries business-day flags.'
        ),
        code: `-- T-SQL
WITH spine AS (
  SELECT CAST('2026-10-01' AS date) AS dt
  UNION ALL
  SELECT DATEADD(day, 1, dt) FROM spine WHERE dt < '2026-10-31'
)
SELECT sp.dt, COUNT(se.event_id) AS scans_completed
FROM spine sp
LEFT JOIN scan_events se
       ON se.event_type = 'scan_end'
      AND se.event_ts >= sp.dt
      AND se.event_ts <  DATEADD(day, 1, sp.dt)
GROUP BY sp.dt
ORDER BY sp.dt
OPTION (MAXRECURSION 0);`,
        codeLang: 'sql',
        points: [
          'Zero-fill needs a spine LEFT JOINed to the facts.',
          'Put fact-side filters in ON, not WHERE.',
          'COUNT(fact_column), not COUNT(*).',
          'T-SQL recursion defaults to 100 levels; use OPTION (MAXRECURSION).',
          'A dim_date table or generator function is usually better than recursion.'
        ],
        followups: ['How do you also zero-fill per scanner?'],
        pitfalls: ['Filtering the facts in WHERE and losing the empty days.']
      },

      {
        id: 'sql-19',
        topic: 'Slowly changing dimensions',
        level: 3,
        q: 'Scanner attributes (site, model) change over time and reports must show the value that applied when each slide was scanned. Design a type 2 `dim_scanner` and write the MERGE that loads it from a staging snapshot. How do facts join to it?',
        setup: `-- dim_scanner (type 2)
--   scanner_key  BIGINT identity/sequence  -- surrogate key
--   scanner_id   INT                        -- natural key
--   site         VARCHAR
--   model        VARCHAR
--   valid_from   TIMESTAMP
--   valid_to     TIMESTAMP                  -- '9999-12-31' for the current row
--   is_current   BOOLEAN
-- stg_scanners(scanner_id, site, model)     -- latest full snapshot, one row per scanner`,
        setupLang: 'sql',
        a: P(
          'Type 2 keeps history: when a tracked attribute changes, close the current row (set valid_to, is_current = false) and insert a new row with a new surrogate key. Facts store the surrogate key as of the event, or join by natural key plus a time range.',
          'A single MERGE cannot both update and insert a new version for the same key, so the source is unioned: one copy keyed on scanner_id (to match and close the current row) and, for changed keys only, a second copy with a NULL merge key (which never matches, so it inserts). Unchanged rows match but fail the WHEN MATCHED condition, so nothing happens; new scanners do not match and insert.',
          'Use null-safe comparison (IS DISTINCT FROM; before SQL Server 2022 use an EXCEPT or ISNULL pattern) or a hash of the tracked columns. Deduplicate the source: MERGE errors or acts nondeterministically if two source rows hit one target row. Use one load timestamp for all clauses. T-SQL needs the statement terminated with a semicolon, and many teams avoid MERGE there because of historical bugs and instead use UPDATE plus INSERT in one transaction.'
        ),
        code: `MERGE INTO dim_scanner d
USING (
  SELECT s.scanner_id AS merge_key, s.scanner_id, s.site, s.model
  FROM stg_scanners s
  UNION ALL
  SELECT NULL, s.scanner_id, s.site, s.model            -- new version of changed rows
  FROM stg_scanners s
  JOIN dim_scanner c ON c.scanner_id = s.scanner_id AND c.is_current
  WHERE s.site IS DISTINCT FROM c.site OR s.model IS DISTINCT FROM c.model
) src
ON d.scanner_id = src.merge_key AND d.is_current
WHEN MATCHED AND (d.site IS DISTINCT FROM src.site OR d.model IS DISTINCT FROM src.model) THEN
  UPDATE SET valid_to = CURRENT_TIMESTAMP, is_current = FALSE
WHEN NOT MATCHED THEN
  INSERT (scanner_id, site, model, valid_from, valid_to, is_current)
  VALUES (src.scanner_id, src.site, src.model, CURRENT_TIMESTAMP, '9999-12-31', TRUE);

-- point-in-time join from facts
SELECT f.slide_id, d.site
FROM slides f
JOIN dim_scanner d
  ON d.scanner_id = f.scanner_id
 AND f.scanned_at >= d.valid_from AND f.scanned_at < d.valid_to;`,
        codeLang: 'sql',
        points: [
          'Close the old row and insert a new version with a new surrogate key.',
          'Union the source twice: one copy to match and close, one NULL-keyed copy to insert.',
          'Compare null-safely or compare a hash of tracked columns.',
          'Deduplicate the source and use one load timestamp.',
          'Facts join by surrogate key or by natural key plus a half-open validity range.'
        ],
        followups: ['What about attributes that should be overwritten (type 1) rather than versioned?', 'How do late-arriving changes with an effective date in the past change this?'],
        pitfalls: ['Using a plain = comparison and treating NULL changes as no change.', 'Closed-interval validity ranges that match two rows at the boundary.']
      },

      {
        id: 'sql-20',
        topic: 'Incremental loads',
        level: 3,
        q: 'This nightly incremental load runs on `scan_events`. Operations report missing events and, after a failed run, duplicates. List what is wrong and write the version that is idempotent and tolerant of late-arriving data.',
        setup: `-- raw_scan_events has the same columns as scan_events plus loaded_at (ingestion time)
-- etl_watermark(table_name VARCHAR, high_watermark TIMESTAMP)

INSERT INTO scan_events
SELECT event_id, slide_id, scanner_id, event_type, event_ts
FROM raw_scan_events
WHERE event_ts > (SELECT MAX(event_ts) FROM scan_events);`,
        setupLang: 'sql',
        a: P(
          'Problems: (1) The watermark is on event time. A scanner that was offline uploads yesterday\'s events tonight; their event_ts is below the current maximum, so they are skipped permanently. (2) Strict > drops other rows sharing the maximum timestamp. (3) The load is not idempotent: if it is switched to >= to fix (2), or the run partly succeeds and is rerun, the same event_id is inserted twice. (4) Deriving the watermark from MAX of the target means one event with a bad clock in the future freezes the loader.',
          'Fix: watermark on ingestion time (loaded_at), stored in its own table and advanced only after success; re-read a small overlap window because concurrent writers can commit slightly out of order; dedupe within the batch; and MERGE on the business key so reruns converge. Capture the upper bound once per run (:hi) and use the same value for the read and the watermark update, so rows arriving mid-run are not lost.',
          'Late-arriving data is now picked up automatically because it still has a new loaded_at. If a downstream aggregate by event day exists, you must also recompute the affected days.'
        ),
        code: `-- :lo = high_watermark, :hi = MAX(loaded_at) captured once at run start (Snowflake)
MERGE INTO scan_events t
USING (
  SELECT event_id, slide_id, scanner_id, event_type, event_ts
  FROM raw_scan_events
  WHERE loaded_at >  DATEADD('hour', -1, :lo)
    AND loaded_at <= :hi
  QUALIFY ROW_NUMBER() OVER (PARTITION BY event_id ORDER BY loaded_at DESC) = 1
) s
ON t.event_id = s.event_id
WHEN MATCHED AND (t.event_ts IS DISTINCT FROM s.event_ts OR t.event_type IS DISTINCT FROM s.event_type
                  OR t.slide_id IS DISTINCT FROM s.slide_id OR t.scanner_id IS DISTINCT FROM s.scanner_id) THEN
  UPDATE SET slide_id = s.slide_id, scanner_id = s.scanner_id,
             event_type = s.event_type, event_ts = s.event_ts
WHEN NOT MATCHED THEN
  INSERT (event_id, slide_id, scanner_id, event_type, event_ts)
  VALUES (s.event_id, s.slide_id, s.scanner_id, s.event_type, s.event_ts);

UPDATE etl_watermark SET high_watermark = :hi WHERE table_name = 'scan_events';`,
        codeLang: 'sql',
        points: [
          'Use an ingestion-time watermark so late events are still picked up.',
          'Re-read a small overlap and dedupe so ordering races are harmless.',
          'MERGE on the business key makes the load idempotent.',
          'Capture the upper bound once and advance the watermark only after success.',
          'Recompute downstream aggregates for days touched by late data.'
        ],
        followups: ['How would you backfill a week without disturbing the watermark?', 'What if the source has deletes?'],
        pitfalls: ['Watermark on a business timestamp.', 'Computing MAX(loaded_at) again after the merge, which skips rows that arrived mid-run.']
      },

      {
        id: 'sql-21',
        topic: 'Star schema',
        level: 3,
        q: 'Reporting needs three views: turnaround by service and priority, scanner volume and bytes by day, and model scores per slide by model version. Choose fact tables and grains, say where annotations and inference runs go, and name the conformed dimensions.',
        a: P(
          'Pick the grain first, one per business process, and never mix grains in one fact table.',
          'fact_slide (one row per slide) holds slide-level measures: file_bytes, width_px, height_px, scan duration, and keys for case, scanner, stain, scan date, and QC. fact_case_lifecycle is an accumulating snapshot (one row per case) with milestone date keys (received, first scan, all scanned, signed out) and lag measures such as total TAT; updated in place as the case progresses, which is the natural home for SLA reporting. fact_inference_run (one row per run) carries model name and version keys, duration, status, and score. fact_annotation (one row per annotation) if area analysis is needed.',
          'Conformed dimensions shared across facts: dim_date, dim_scanner (type 2), dim_case or a degenerate accession number, dim_stain, dim_model (name and version), dim_pathologist. Case TAT does not belong on slide rows: it would repeat per slide and double-count when summed.',
          'Additivity: bytes are additive; mpp, scores, and ratios are not (store them as attributes or average them with care). Use a dedicated unknown row for missing milestone dates rather than NULL keys.'
        ),
        code: `CREATE TABLE fact_slide (
  slide_key        BIGINT,
  case_key         BIGINT,
  scanner_key      BIGINT,   -- type 2 dim key as of scan time
  stain_key        INT,
  scan_date_key    INT,
  qc_status        VARCHAR,
  file_bytes       BIGINT,   -- additive
  width_px         INT,
  height_px        INT,
  scan_seconds     INT       -- additive over slides, non-additive as a rate
);

CREATE TABLE fact_case_lifecycle (   -- accumulating snapshot, one row per case
  case_key              BIGINT,
  service_key           INT,
  priority              VARCHAR,
  received_date_key     INT,
  first_scan_date_key   INT,   -- unknown-date row until it happens
  all_scanned_date_key  INT,
  signed_out_date_key   INT,
  n_slides              INT,
  tat_minutes           INT
);`,
        codeLang: 'sql',
        points: [
          'State the grain of each fact table before choosing columns.',
          'Case lifecycle metrics are an accumulating snapshot at case grain.',
          'Slides, inference runs, and annotations are separate facts at their own grain.',
          'Shared conformed dimensions let facts be drilled across.',
          'Do not put case-level measures on slide rows.'
        ],
        followups: ['Where do tile-level model outputs go?', 'How do you model a slide that was rescanned?'],
        pitfalls: ['One wide table at annotation grain with everything repeated.', 'Using NULL foreign keys for pending milestones.']
      },

      {
        id: 'sql-22',
        topic: 'Indexing and plans',
        level: 2,
        q: 'Design the index for this query and justify the column order. Why does it matter, and what would you change if the filter on `qc_status` were removed?',
        setup: `SELECT slide_id, file_bytes
FROM slides
WHERE scanner_id = 3
  AND qc_status = 'fail'
  AND scanned_at >= '2026-10-01' AND scanned_at < '2026-10-08'
ORDER BY scanned_at;`,
        setupLang: 'sql',
        a: P(
          'A B-tree index is sorted by its columns in order, so a seek can narrow using a leading prefix of equality predicates followed by at most one range column; anything after the range column cannot narrow the scan. Put equality columns first, then the range or sort column. Here: (scanner_id, qc_status, scanned_at). The seek lands on scanner 3 and fail, then reads a contiguous slice of scanned_at that is already sorted, so no sort step is needed.',
          'Selectivity is not the rule for ordering equality columns, since all equalities narrow the same way; order them by reuse across other queries. If qc_status is dropped, (scanner_id, scanned_at) serves it. A (scanned_at, scanner_id) index would scan the entire week for all scanners and filter.',
          'Left-prefix rule: an index on (a, b, c) helps predicates on a, a and b, or a, b, and c, but a predicate only on b or c usually cannot seek (some engines offer skip scans; do not rely on them). Verify in the plan that you see an index range scan, not a full scan plus filter or a sort.'
        ),
        code: `-- Postgres / SQL Server style
CREATE INDEX ix_slides_scanner_qc_scanned
  ON slides (scanner_id, qc_status, scanned_at);

-- if qc_status is not in the filter
CREATE INDEX ix_slides_scanner_scanned
  ON slides (scanner_id, scanned_at);`,
        codeLang: 'sql',
        points: [
          'B-tree order: equality columns first, then range or sort column.',
          'Columns after a range column cannot narrow the seek.',
          'Matching the ORDER BY avoids a sort.',
          'Left-prefix rule decides which queries an index serves.',
          'Confirm with the plan rather than assuming.'
        ],
        followups: ['What does the extra index cost on a table that ingests millions of rows a day?'],
        pitfalls: ['Putting the most selective column first by habit.', 'Putting the range column before the equality columns.']
      },

      {
        id: 'sql-23',
        topic: 'Indexing and plans',
        level: 2,
        q: 'Explain sargability and rewrite each predicate so an index (or partition pruning) can be used.',
        setup: `-- on slides unless noted
-- 1. WHERE CAST(scanned_at AS DATE) = '2026-10-01'
-- 2. WHERE EXTRACT(YEAR FROM scanned_at) = 2026 AND EXTRACT(MONTH FROM scanned_at) = 10
-- 3. WHERE LOWER(stain) = 'h&e'
-- 4. WHERE file_bytes / 1024 > 500000
-- 5. (cases) WHERE accession_no LIKE '%7731'`,
        setupLang: 'sql',
        a: P(
          'A predicate is sargable when the engine can turn it into an index seek or range, which generally means the indexed column stands alone on one side of the comparison. Wrapping the column in a function, arithmetic, or a cast forces evaluation per row, so the engine scans. (Some optimizers special-case a few patterns such as date casts; do not count on it.)',
          'Rewrites: (1) a half-open range, scanned_at >= \'2026-10-01\' AND scanned_at < \'2026-10-02\'. (2) The same with the month range, < \'2026-11-01\'. (3) Normalize the data on load so a plain equality works, or create an expression index on LOWER(stain) where supported; SQL Server\'s default collation is already case-insensitive. (4) Move the arithmetic to the constant: file_bytes > 500000 * 1024 (if "/" is integer division in your dialect, the exact equivalent is file_bytes >= 500001 * 1024). (5) A leading wildcard cannot seek; use a trigram or full-text index, store a reversed accession column and match a prefix, or a dedicated search structure.',
          'Also watch implicit conversions, such as comparing a numeric column to a quoted string or a VARCHAR column to an NVARCHAR parameter in SQL Server. The same rule applies to partition pruning in warehouses: a function on the partition column can disable pruning.'
        ),
        code: `-- 1
WHERE scanned_at >= '2026-10-01' AND scanned_at < '2026-10-02'
-- 2
WHERE scanned_at >= '2026-10-01' AND scanned_at < '2026-11-01'
-- 3 (Postgres expression index) or clean the data at load
CREATE INDEX ix_slides_stain_lower ON slides (LOWER(stain));
-- 4
WHERE file_bytes > 500000 * 1024
-- 5: no seek possible with a leading wildcard`,
        codeLang: 'sql',
        points: [
          'Keep the indexed column bare on one side of the comparison.',
          'Use half-open ranges for dates.',
          'Move arithmetic to the constant side.',
          'Expression indexes or normalized data handle case-insensitive search.',
          'Leading wildcards cannot use B-tree seeks; implicit conversions and partition pruning follow the same rules.'
        ],
        followups: ['How can you spot a non-sargable predicate in an execution plan?'],
        pitfalls: ['Wrapping the column in YEAR() or CAST() for convenience.', 'Assuming a function never matters because it is cheap.']
      },

      {
        id: 'sql-24',
        topic: 'Indexing and plans',
        level: 3,
        q: 'A dashboard runs this aggregate hundreds of times a minute and the plan still reads the table after the index scan. Design a covering index, say how to confirm it is used, and name the costs.',
        setup: `SELECT scanner_id, COUNT(*) AS slides, SUM(file_bytes) AS bytes
FROM slides
WHERE scanned_at >= '2026-10-01' AND scanned_at < '2026-10-08'
GROUP BY scanner_id;`,
        setupLang: 'sql',
        a: P(
          'A covering index contains every column the query needs, so the engine answers from the index alone and never touches the table (no key lookups or heap fetches). Key it on the range column and carry the rest as included columns: (scanned_at) INCLUDE (scanner_id, file_bytes). Included columns are stored in the leaf but not sorted or usable for seeks.',
          'Confirm it with the plan. In Postgres, EXPLAIN (ANALYZE, BUFFERS) should show an Index Only Scan with Heap Fetches near zero; that needs the visibility map to be current, which VACUUM maintains, so a freshly loaded table can still fetch from the heap. In SQL Server, look for an index seek with no key lookup. Engines without INCLUDE can append the columns to the key: (scanned_at, scanner_id, file_bytes).',
          'Costs: more storage, slower writes on a heavy ingest table, and fragility, since adding a column to the query (or SELECT *) breaks coverage. Cover only the hottest, stable queries. If this is purely analytical, a pre-aggregated daily rollup or a columnar warehouse removes the need.'
        ),
        code: `-- Postgres 11+ and SQL Server
CREATE INDEX ix_slides_scanned_cover
  ON slides (scanned_at) INCLUDE (scanner_id, file_bytes);

-- Postgres: check for "Index Only Scan" and low "Heap Fetches"
EXPLAIN (ANALYZE, BUFFERS)
SELECT scanner_id, COUNT(*), SUM(file_bytes)
FROM slides
WHERE scanned_at >= '2026-10-01' AND scanned_at < '2026-10-08'
GROUP BY scanner_id;`,
        codeLang: 'sql',
        points: [
          'Covering means all referenced columns are in the index.',
          'Key columns for seeking and sorting; INCLUDE columns for payload.',
          'Verify via the plan: index-only scan, no key lookups, low heap fetches.',
          'Index-only scans in Postgres depend on vacuum and the visibility map.',
          'Costs are write amplification, space, and brittleness to query changes.'
        ],
        followups: ['When would you replace the index with a rollup table?'],
        pitfalls: ['SELECT * defeating the covering index.', 'Adding many wide covering indexes to a write-heavy table.']
      },

      {
        id: 'sql-25',
        topic: 'Partitioning and clustering',
        level: 3,
        q: 'On Snowflake, a multi-billion-row slide fact table is slow for queries that filter on one day and one scanner. Explain micro-partitions and pruning, when you would add a clustering key, what key you would choose, and how you would measure the effect.',
        a: P(
          'Snowflake stores tables as immutable, columnar micro-partitions (roughly tens to hundreds of MB each) and keeps min/max metadata per column per partition. A query prunes partitions whose ranges cannot match the filter. Pruning is only effective if similar values are physically close together; data loaded in time order is naturally clustered by date but scattered by scanner.',
          'Add a clustering key only on large tables (think multi-terabyte) that are queried often with selective filters on the same columns and do not churn constantly, because automatic reclustering consumes credits and rewrites partitions. A reasonable key here is (TO_DATE(scanned_at), scanner_id): truncating the timestamp keeps cardinality low enough to be useful, and lower-cardinality columns generally lead.',
          'Measure instead of guessing: the query profile shows partitions scanned versus total, and SYSTEM$CLUSTERING_INFORMATION reports average depth and overlap. Compare before and after on representative queries. Out-of-order or late-arriving loads degrade clustering over time. For needle-in-haystack lookups (one accession number), the search optimization service (Enterprise edition or higher) is a different tool than clustering.'
        ),
        code: `ALTER TABLE fact_slide CLUSTER BY (TO_DATE(scanned_at), scanner_id);

SELECT SYSTEM$CLUSTERING_INFORMATION('fact_slide', '(TO_DATE(scanned_at), scanner_id)');

-- the query it should speed up
SELECT COUNT(*), SUM(file_bytes)
FROM fact_slide
WHERE scanned_at >= '2026-10-01' AND scanned_at < '2026-10-02'
  AND scanner_id = 3;`,
        codeLang: 'sql',
        points: [
          'Micro-partitions are columnar with per-column min/max metadata used for pruning.',
          'Pruning works only if values are co-located.',
          'Clustering keys cost credits; use them on big, frequently filtered, stable tables.',
          'Truncate high-cardinality timestamps in the key.',
          'Measure with partitions scanned and clustering information.'
        ],
        followups: ['How is this different from a B-tree index?', 'What happens to clustering when you backfill old dates?'],
        pitfalls: ['Clustering on a near-unique column such as slide_id.', 'Clustering a small table and paying for maintenance with no benefit.']
      },

      {
        id: 'sql-26',
        topic: 'Partitioning and clustering',
        level: 2,
        q: 'Create a BigQuery table for the slide fact with partitioning and clustering, and explain how that changes bytes scanned and cost. What does LIMIT do for cost, and how do you check before running?',
        a: P(
          'On-demand BigQuery bills by bytes processed (capacity pricing bills slots instead, but bytes still drive slot time), and it is columnar, so cost depends on which columns you select and how much of the table is scanned. Partitioning by date lets a filter on the partition column skip whole partitions; clustering sorts data within each partition by up to four columns so filters on those columns skip blocks. Partition for coarse, predictable pruning, cluster for the next most-filtered columns (here scanner_id, then stain).',
          'Set require_partition_filter so nobody accidentally scans all history. Filter directly on the partition column (a constant range, not a function of it, where possible) or pruning may not happen.',
          'LIMIT does not reduce bytes billed on a non-clustered table: the selected columns are still read in full (clustered tables can sometimes stop early). SELECT * reads every column; name the ones you need. A dry run (bq query --dry_run, or the console estimate) reports bytes before you pay; for clustered tables the estimate is an upper bound, and actual bytes are often lower. A table can hold at most 10,000 partitions. Too many tiny partitions hurts, so daily is typical here unless volume is small, in which case monthly may be better.'
        ),
        code: `CREATE TABLE ds.fact_slide (
  slide_id    INT64,
  case_id     INT64,
  scanner_id  INT64,
  stain       STRING,
  scanned_at  TIMESTAMP,
  file_bytes  INT64
)
PARTITION BY DATE(scanned_at)
CLUSTER BY scanner_id, stain
OPTIONS (require_partition_filter = TRUE);

SELECT scanner_id, SUM(file_bytes) AS bytes
FROM ds.fact_slide
WHERE scanned_at >= TIMESTAMP '2026-10-01' AND scanned_at < TIMESTAMP '2026-10-08'
  AND scanner_id = 3
GROUP BY scanner_id;`,
        codeLang: 'sql',
        points: [
          'Cost follows bytes read: columns selected times partitions and blocks scanned.',
          'Partition on the date filter; cluster on the next filtered columns.',
          'require_partition_filter prevents accidental full scans.',
          'LIMIT does not cut bytes scanned; SELECT * is expensive.',
          'Use a dry run to estimate before running.'
        ],
        followups: ['When is partitioning by ingestion time better than by event time?'],
        pitfalls: ['Wrapping the partition column in a function so pruning is lost.', 'Over-partitioning small data into thousands of tiny partitions.']
      },

      {
        id: 'sql-27',
        topic: 'QUALIFY',
        level: 2,
        q: 'Return the highest-scoring successful inference run per slide. Write it with QUALIFY, with a portable subquery, and in T-SQL, and explain where QUALIFY sits in the order of evaluation.',
        a: P(
          'QUALIFY filters on window function results, the way HAVING filters on aggregates. Logical order: FROM, WHERE, GROUP BY, HAVING, window functions, QUALIFY, DISTINCT, ORDER BY, LIMIT. That is why WHERE status = \'ok\' removes failed runs before the ranking happens, and why you cannot reference window functions in WHERE.',
          'Snowflake, BigQuery, Databricks, DuckDB, and Teradata support QUALIFY. Postgres, MySQL, and SQL Server do not, so use a subquery or CTE that computes the rank and an outer WHERE rn = 1, which is the portable form. In T-SQL, TOP (1) WITH TIES ordered by ROW_NUMBER() OVER (...) is a compact trick: it returns the rows whose row number ties for first, which is one per partition.',
          'BigQuery has historically required a WHERE, GROUP BY, or HAVING alongside QUALIFY (WHERE TRUE satisfies it); check current docs. Add a tie-breaker (run_id) and decide how to treat NULL scores, since DESC may sort them first.'
        ),
        code: `-- Snowflake / BigQuery
SELECT slide_id, run_id, model_name, score
FROM inference_runs
WHERE status = 'ok' AND score IS NOT NULL
QUALIFY ROW_NUMBER() OVER (PARTITION BY slide_id ORDER BY score DESC, run_id) = 1;

-- portable
SELECT slide_id, run_id, model_name, score
FROM (
  SELECT r.slide_id, r.run_id, r.model_name, r.score,
         ROW_NUMBER() OVER (PARTITION BY r.slide_id ORDER BY r.score DESC, r.run_id) AS rn
  FROM inference_runs r
  WHERE r.status = 'ok' AND r.score IS NOT NULL
) t
WHERE rn = 1;

-- T-SQL
SELECT TOP (1) WITH TIES slide_id, run_id, model_name, score
FROM inference_runs
WHERE status = 'ok' AND score IS NOT NULL
ORDER BY ROW_NUMBER() OVER (PARTITION BY slide_id ORDER BY score DESC, run_id);`,
        codeLang: 'sql',
        points: [
          'QUALIFY is to window functions what HAVING is to aggregates.',
          'It runs after window functions and before DISTINCT and ORDER BY.',
          'Not available in Postgres, MySQL, or SQL Server; use a subquery.',
          'T-SQL TOP 1 WITH TIES with ROW_NUMBER gives the same result.',
          'Filter in WHERE first, add a tie-breaker, and handle NULLs.'
        ],
        followups: ['Does the subquery form cost more than QUALIFY?'],
        pitfalls: ['Expecting QUALIFY to work on Postgres.', 'Filtering for status after ranking and losing slides whose best run was an error.']
      },

      {
        id: 'sql-28',
        topic: 'Semi-structured data',
        level: 3,
        q: 'Model outputs are stored as one JSON document per run. Write the query that returns one row per tile with probability >= 0.9, joined to the slide, in Snowflake and in BigQuery. What do you watch for with scale and empty arrays?',
        setup: `-- inference_outputs(run_id BIGINT, payload VARIANT)   -- Snowflake
-- inference_outputs(run_id INT64,  payload JSON)      -- BigQuery
-- payload example:
-- {"model": {"name": "tumor-seg", "version": "2.3.1"},
--  "tiles": [ {"x": 0, "y": 0, "label": "tumor",  "p": 0.97},
--             {"x": 1, "y": 0, "label": "stroma", "p": 0.55} ],
--  "summary": {"tumor_fraction": 0.41}}`,
        setupLang: 'sql',
        a: P(
          'Both engines flatten the array into rows. Snowflake: LATERAL FLATTEN(input => payload:tiles) produces one row per element with the element in the VALUE column; navigate with colon-path syntax and cast with ::, since semi-structured values are untyped until you cast. BigQuery: UNNEST over JSON_QUERY_ARRAY(payload, \'$.tiles\') gives JSON elements, and JSON_VALUE extracts scalars as strings that you SAFE_CAST.',
          'Join to inference_runs at run grain (as a subquery) and flatten afterward, so the join handles one row per run rather than one per tile. FLATTEN drops rows with an empty or missing array unless you pass OUTER => TRUE; in BigQuery use a LEFT JOIN to the UNNEST. Decide which behavior you want, since runs with zero tiles are often the interesting ones.',
          'Scale: a slide at 256 px tiles can have tens or hundreds of thousands of tiles, so one JSON document per run becomes huge, hits value size limits (Snowflake VARIANT has a cap; check your version), and every query re-parses it. Store tile-level results as typed rows in a columnar table (or Parquet) and keep only the small summary as JSON. Extract frequently filtered JSON fields into typed columns at load time.'
        ),
        code: `-- Snowflake
SELECT x.slide_id, x.run_id,
       t.value:x::INT       AS tile_x,
       t.value:y::INT       AS tile_y,
       t.value:label::STRING AS label,
       t.value:p::FLOAT     AS p
FROM (
  SELECT o.run_id, r.slide_id, o.payload
  FROM inference_outputs o
  JOIN inference_runs r ON r.run_id = o.run_id
) x,
LATERAL FLATTEN(input => x.payload:tiles) t
WHERE t.value:p::FLOAT >= 0.9;

-- BigQuery
SELECT r.slide_id, o.run_id,
       SAFE_CAST(JSON_VALUE(t, '$.x') AS INT64)   AS tile_x,
       SAFE_CAST(JSON_VALUE(t, '$.y') AS INT64)   AS tile_y,
       JSON_VALUE(t, '$.label')                   AS label,
       SAFE_CAST(JSON_VALUE(t, '$.p') AS FLOAT64) AS p
FROM inference_outputs o
JOIN inference_runs r ON r.run_id = o.run_id
CROSS JOIN UNNEST(JSON_QUERY_ARRAY(o.payload, '$.tiles')) AS t
WHERE SAFE_CAST(JSON_VALUE(t, '$.p') AS FLOAT64) >= 0.9;`,
        codeLang: 'sql',
        points: [
          'FLATTEN (Snowflake) and UNNEST (BigQuery) turn arrays into rows.',
          'Extract with path syntax and cast explicitly.',
          'Empty arrays drop rows unless you use OUTER or a LEFT JOIN.',
          'Per-tile JSON inside one document does not scale; store tiles as typed rows.',
          'Promote hot fields to real columns at load time.'
        ],
        followups: ['How would you handle a schema change between model versions?'],
        pitfalls: ['Forgetting casts and comparing strings to numbers.', 'Flattening before joining and multiplying work.']
      },

      {
        id: 'sql-29',
        topic: 'Data quality',
        level: 2,
        q: 'Write a single SQL check that returns one row per failed assertion for the slide tables: referential integrity, duplicate keys, an impossible event sequence, and freshness. Why do you need these in a warehouse that declares primary and foreign keys?',
        a: P(
          'Because Snowflake and BigQuery treat primary, unique, and foreign key constraints as informational (Snowflake standard tables enforce only NOT NULL): they are not enforced, so duplicates and orphans load without complaint. The only guarantee is the checks you run. Put them in the pipeline after load and fail the run (or quarantine rows) when a count is nonzero.',
          'Useful families: referential integrity (orphan slides with no case), uniqueness (event_id duplicates), sequence validity (a scan_end with no earlier scan_start for the slide; with rescans, test existence of an earlier start, not just first versus last), volume (row count against yesterday within a tolerance, or against the source), and freshness (max event time within a window, noting time zones and that quiet weekends can legitimately look stale).',
          'Design checks to return the bad rows or a count, so an alert can say what broke. Test the full load, not only the sample, and keep thresholds explicit. dbt tests, Great Expectations, or a small SQL runner implement the same idea.'
        ),
        code: `-- Snowflake; each row is a check, bad_rows > 0 means failure
SELECT 'orphan_slides' AS check_name, COUNT(*) AS bad_rows
FROM slides s
WHERE NOT EXISTS (SELECT 1 FROM cases c WHERE c.case_id = s.case_id)
UNION ALL
SELECT 'duplicate_event_ids', COUNT(*)
FROM (SELECT event_id FROM scan_events GROUP BY event_id HAVING COUNT(*) > 1) d
UNION ALL
SELECT 'scan_end_without_start', COUNT(*)
FROM scan_events e
WHERE e.event_type = 'scan_end'
  AND NOT EXISTS (
    SELECT 1 FROM scan_events b
    WHERE b.slide_id = e.slide_id AND b.event_type = 'scan_start' AND b.event_ts <= e.event_ts)
UNION ALL
SELECT 'signed_out_without_signout_row', COUNT(*)
FROM cases c
WHERE c.status = 'signed_out'
  AND NOT EXISTS (SELECT 1 FROM signouts so WHERE so.case_id = c.case_id)
UNION ALL
SELECT 'scan_events_stale_6h',
       CASE WHEN MAX(event_ts) IS NULL                                   -- empty table is stale too
              OR MAX(event_ts) < DATEADD('hour', -6, CURRENT_TIMESTAMP()) THEN 1 ELSE 0 END
FROM scan_events;`,
        codeLang: 'sql',
        points: [
          'Warehouse key constraints are informational; enforce with checks.',
          'Cover integrity, uniqueness, sequence validity, volume, and freshness.',
          'Return counts or bad rows so alerts are actionable.',
          'Account for rescans and time zones in sequence and freshness checks.',
          'Fail or quarantine in the pipeline, not in a dashboard later.'
        ],
        followups: ['How would you tune freshness thresholds for weekends?'],
        pitfalls: ['Checks that run on a sample and miss the full load.', 'Treating a passing count check as proof the data is correct.']
      },

      {
        id: 'sql-30',
        topic: 'T-SQL differences',
        level: 3,
        q: 'Port this T-SQL (a package-style query from an SSIS-era pipeline) to Snowflake. List what changes syntactically, and more importantly what changes semantically and could silently alter results.',
        setup: `-- T-SQL
SELECT TOP 10
       c.accession_no + '-' + s.block_label          AS slide_ref,
       ISNULL(s.stain, 'unknown')                    AS stain,
       DATEDIFF(hour, c.received_at, so.signed_out_at) AS tat_hours,
       s.file_bytes / 1048576                        AS file_mb
FROM cases c
JOIN slides s    ON s.case_id = c.case_id
JOIN signouts so ON so.case_id = c.case_id
WHERE s.stain = 'h&e'
  AND so.signed_out_at >= DATEADD(day, -7, GETDATE());`,
        setupLang: 'sql',
        a: P(
          'Syntax: TOP n becomes LIMIT n; ISNULL becomes COALESCE; + string concatenation becomes ||; DATEDIFF(hour, ...) becomes DATEDIFF(\'hour\', ...); DATEADD and GETDATE become DATEADD(\'day\', ...) and CURRENT_TIMESTAMP().',
          'Semantic risks: (1) T-SQL\'s default collation is case-insensitive, so \'h&e\' matches \'H&E\'; Snowflake comparisons are case-sensitive by default, so the port returns nothing unless you normalize (UPPER) or set a collation. (2) int / int is integer division in T-SQL; in Snowflake the result is decimal, so file_mb is fractional unless you FLOOR it. (3) ISNULL takes the type of its first argument and can truncate the replacement to the column length; COALESCE does not. (4) TOP with no ORDER BY is arbitrary; add one. (5) GETDATE() is the server\'s local time; Snowflake\'s CURRENT_TIMESTAMP uses the session time zone and returns a zoned type, so compare against NTZ columns deliberately (or use SYSDATE() for UTC). (6) Both DATEDIFF versions count datepart boundaries crossed, not elapsed hours.',
          'Operationally, SSIS data-flow transformations (lookups, derived columns, row-by-row scripts) are usually better expressed as set-based SQL in the warehouse (ELT), with the orchestrator only sequencing steps.'
        ),
        code: `-- Snowflake
SELECT c.accession_no || '-' || s.block_label                    AS slide_ref,
       COALESCE(s.stain, 'unknown')                              AS stain,
       DATEDIFF('hour', c.received_at, so.signed_out_at)         AS tat_hours,
       FLOOR(s.file_bytes / 1048576)                             AS file_mb
FROM cases c
JOIN slides s    ON s.case_id = c.case_id
JOIN signouts so ON so.case_id = c.case_id
WHERE UPPER(s.stain) = 'H&E'
  AND so.signed_out_at >= DATEADD('day', -7, SYSDATE())
ORDER BY so.signed_out_at DESC
LIMIT 10;`,
        codeLang: 'sql',
        points: [
          'Syntax: TOP, ISNULL, +, DATEDIFF, GETDATE have direct equivalents.',
          'Default collation differs: case-insensitive vs case-sensitive.',
          'Integer vs decimal division changes values.',
          'ISNULL truncation and TOP without ORDER BY are silent traps.',
          'Time zone and type handling of now() differ.'
        ],
        followups: ['How would you prove the port is equivalent on a large table?'],
        pitfalls: ['Treating the port as find-and-replace and shipping a query that quietly returns zero rows.']
      },

      {
        id: 'sql-31',
        topic: 'Transactions and locking',
        level: 3,
        q: 'A loader updates case statuses inside an open transaction while a dashboard runs the aggregate below. Describe what the dashboard sees in SQL Server under default locking READ COMMITTED, with READ_COMMITTED_SNAPSHOT, and with NOLOCK, and compare to Postgres, Snowflake, and BigQuery. Which anomalies matter for a report that runs two queries?',
        setup: `-- Session A (loader)
BEGIN TRAN;
UPDATE cases SET status = 'signed_out' WHERE case_id = 4001;
-- ... still open, not committed

-- Session B (dashboard)
SELECT status, COUNT(*) FROM cases GROUP BY status;`,
        setupLang: 'sql',
        a: P(
          'SQL Server default READ COMMITTED uses shared locks: B blocks on the row A holds an exclusive lock on until A commits or rolls back. With READ_COMMITTED_SNAPSHOT (row versioning), B does not block and sees the last committed version, so case 4001 still counts under its old status. With NOLOCK (READ UNCOMMITTED), B does not block but may read uncommitted data that later rolls back, and can double-read or skip rows during page splits, so totals can be simply wrong. Azure SQL Database has READ_COMMITTED_SNAPSHOT on by default; on-premises SQL Server has it off.',
          'Postgres uses MVCC with READ COMMITTED by default: readers never block writers and see only committed rows. Snowflake supports READ COMMITTED for tables, and each statement sees a consistent snapshot as of its start. BigQuery multi-statement transactions use snapshot isolation, and a single query always reads one consistent snapshot.',
          'Anomalies: under READ COMMITTED a report running two queries can see different committed states between them (non-repeatable reads, phantoms), so totals do not reconcile. Fix by running them in one statement, or using SNAPSHOT isolation (SQL Server) or REPEATABLE READ (Postgres, where it is snapshot-based) for the whole report, or reading from a published, immutable snapshot table. For the loader, make swaps atomic (one transaction, or load to a staging table and swap) and keep transactions short; deadlocks are handled by consistent access order and retry.'
        ),
        code: `-- SQL Server: readers do not block on writers
ALTER DATABASE labdw SET READ_COMMITTED_SNAPSHOT ON;

-- consistent multi-query report
ALTER DATABASE labdw SET ALLOW_SNAPSHOT_ISOLATION ON;
SET TRANSACTION ISOLATION LEVEL SNAPSHOT;
BEGIN TRAN;
  SELECT status, COUNT(*) FROM cases GROUP BY status;
  SELECT COUNT(*) FROM signouts;
COMMIT;`,
        codeLang: 'sql',
        points: [
          'Locking READ COMMITTED blocks readers behind uncommitted writers.',
          'Row versioning gives readers the last committed version without blocking.',
          'NOLOCK reads uncommitted data and can miss or double-count rows.',
          'Multi-query reports need snapshot-style consistency or a single statement.',
          'Warehouses differ in supported isolation levels; know yours.'
        ],
        followups: ['What causes a deadlock between two loaders, and how do you avoid it?'],
        pitfalls: ['Adding NOLOCK everywhere to stop blocking.', 'Assuming two sequential SELECTs in a report see the same data.']
      },

      {
        id: 'sql-32',
        topic: 'Indexing and plans',
        level: 3,
        q: 'Read this Postgres-style plan excerpt for a query joining stat cases from October to their slides. It takes about 2.8 seconds. What is the signal that something is wrong, what are the likely causes, and what do you try in order?',
        setup: `Nested Loop  (cost=0.85..412.10 rows=60 width=24) (actual time=0.05..2841.77 rows=52310 loops=1)
  ->  Index Scan using ix_cases_priority_received on cases c
        (cost=0.43..120.50 rows=12 width=16) (actual time=0.03..12.40 rows=9100 loops=1)
        Index Cond: ((priority = 'stat') AND (received_at >= '2026-10-01'))
  ->  Index Scan using ix_slides_case on slides s
        (cost=0.42..24.30 rows=5 width=16) (actual time=0.02..0.30 rows=6 loops=9100)
        Index Cond: (case_id = c.case_id)
Execution Time: 2842.30 ms`,
        setupLang: 'text',
        a: P(
          'The signal is estimated versus actual rows: the planner expected 12 cases and got 9,100 (about 760 times more), and expected 60 output rows against 52,310. A nested loop is cheap for a dozen outer rows, but with 9,100 outer rows the inner index scan runs 9,100 times (loops=9100) at ~0.3 ms each, which accounts for the 2.8 seconds. A hash join with a sequential or bitmap scan of slides would likely be faster.',
          'Likely causes: stale statistics (autovacuum or ANALYZE has not run since a big load), or correlated predicates the planner multiplies as if independent (priority and received_at are correlated), or a skewed value not captured in the statistics.',
          'Try in order: run ANALYZE on both tables and re-explain; raise the statistics target for the skewed columns; create extended statistics (CREATE STATISTICS with dependencies or mcv) for correlated columns; check the query for a non-sargable predicate; and only as a last resort force a different join with settings or hints. Read plans bottom-up on actual rows times loops, not only cost, and use EXPLAIN (ANALYZE, BUFFERS) to see where I/O goes. Output format and knobs vary by engine and version.'
        ),
        code: `ANALYZE cases;
ANALYZE slides;

CREATE STATISTICS st_cases_priority_received (dependencies, mcv)
  ON priority, received_at FROM cases;
ANALYZE cases;

EXPLAIN (ANALYZE, BUFFERS)
SELECT c.case_id, s.slide_id
FROM cases c
JOIN slides s ON s.case_id = c.case_id
WHERE c.priority = 'stat' AND c.received_at >= '2026-10-01';`,
        codeLang: 'sql',
        points: [
          'Compare estimated rows with actual rows at each node.',
          'Multiply per-loop cost by loops to find the real cost.',
          'Causes: stale stats, correlated predicates, skew.',
          'Fix statistics first, then query shape, and force a plan last.',
          'Use ANALYZE and BUFFERS to see time and I/O.'
        ],
        followups: ['When would a nested loop with 9,100 index lookups actually be the right plan?'],
        pitfalls: ['Adding indexes before checking whether the estimate is the problem.', 'Looking only at estimated cost numbers.']
      }
    ],
    glossary: [
      { term: 'Sargable', def: 'A predicate shaped so the engine can use an index seek or range scan: the indexed column stands alone on one side of the comparison, with no function or arithmetic wrapped around it.' },
      { term: 'Fan-out', def: 'A join that repeats rows on the "one" side because the other side has several matches, inflating sums and counts. Fix by aggregating to the join grain first.' },
      { term: 'Anti-join', def: 'A query returning rows with no match in another table, written as NOT EXISTS or LEFT JOIN ... IS NULL. NOT IN is unsafe if the subquery can return NULL.' },
      { term: 'Slowly changing dimension', def: 'A dimension whose attributes change over time. Type 1 overwrites; type 2 keeps history with validity dates and a new surrogate key per version.' },
      { term: 'Watermark', def: 'A stored high-water mark (often ingestion time) that tells an incremental load where it last stopped, so the next run reads only newer rows.' },
      { term: 'Accumulating snapshot', def: 'A fact table with one row per process instance (such as a case) that is updated as milestones are reached, used for lifecycle and turnaround metrics.' }
    ]
  });
})();
