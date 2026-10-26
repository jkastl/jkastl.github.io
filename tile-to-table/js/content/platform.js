/* Platform & delivery deck: orchestration (Airflow, Cloud Composer), containers, Kubernetes, IaC, CI/CD, DataOps, agile delivery, Linux and Windows operations, secrets. Plain data, loaded by the page and the tests. */
(function () {
  'use strict';
  (globalThis.TT_DECKS = globalThis.TT_DECKS || []).push({
    id: 'platform',
    title: 'Platform & delivery',
    blurb: 'Airflow and Composer, Docker and Kubernetes, Terraform, CI/CD, DataOps, Linux and Windows operations, and least-privilege for clinical data.',
    order: 3,
    cards: [
      {
        id: 'platform-01',
        topic: 'Airflow scheduling',
        level: 1,
        q: "A DAG is scheduled `@daily`. The run that starts at 00:05 UTC on Jan 3 is labeled Jan 2. Explain logical date, data interval, and actual run time, and why the distinction matters for a daily load of scan metadata.",
        a: "In Airflow 2.x, a scheduled run covers a **data interval** (for example Jan 2 00:00 to Jan 3 00:00) and starts only after that interval has ended. The **logical date** of a scheduled run is the start of its interval (older docs call it `execution_date`; renamed in 2.2). The **run time** is when the scheduler actually created the run, usually just after the interval closes.\n\nThe template values follow the interval, not the clock: `{{ ds }}` is the logical date as YYYY-MM-DD, `data_interval_start` and `data_interval_end` bound the window. So the run labeled Jan 2 should load slides scanned on Jan 2, and it does so every time it is retried or backfilled, because the window comes from the interval and not from `now()`.\n\nVersion note: in Airflow 3, cron strings and presets such as `@daily` default to `CronTriggerTimetable` (`create_cron_data_intervals=False`). Those runs have a zero-length data interval and a logical date equal to the trigger time, so the midnight run on Jan 3 is labeled Jan 3. Set `create_cron_data_intervals=True` or use `CronDataIntervalTimetable` to keep the 2.x behavior. Manual runs in Airflow 3 can have no logical date at all.",
        points: [
          "A scheduled run covers an interval and fires after it ends.",
          "Logical date is the interval start for scheduled runs; run time is when it really started.",
          "Derive windows from `data_interval_start` and `data_interval_end` or `ds`, never `now()`.",
          "Manual runs behave differently (logical date is the trigger time in 2.x).",
          "Airflow 3 cron schedules default to trigger semantics, so state the version."
        ],
        followups: [
          "What are `ds` and the data interval for a manually triggered run?",
          "How would you build a DAG that runs hourly but loads a day at a time?"
        ],
        pitfalls: [
          "Using `datetime.now()` or `date.today()` inside a task, so a rerun loads a different day.",
          "Assuming `ds` is today's date."
        ]
      },
      {
        id: 'platform-02',
        topic: 'Catchup and backfills',
        level: 2,
        q: "You deploy a DAG with a `start_date` 90 days in the past. What happens with `catchup` on versus off, and how do you reprocess three weeks of scan manifests after fixing a parsing bug?",
        a: "With `catchup=True` the scheduler creates a run for every missed interval from `start_date` forward, so 90 runs appear at once. With `catchup=False` it creates only the most recent interval. In Airflow 2 the default is on (controlled by `catchup_by_default`); Airflow 3 flipped the default to off. Set it explicitly on every DAG so the behavior never depends on the version.\n\nTo reprocess a bounded window, you have two routes:\n\n- Clear the task instances for those runs (UI, or `airflow tasks clear` with a date range). The runs execute again with the current code.\n- Run a backfill. In 2.x that is the CLI command `airflow dags backfill -s 2026-09-01 -e 2026-09-21 <dag_id>`. In 3.x backfills are scheduler-managed and started from the UI, the API, or `airflow backfill create --dag-id <dag_id> --from-date ... --to-date ...`; the old `dags backfill` command was removed.\n\nEither route is only safe if every task is idempotent. Cap the blast radius with `max_active_runs`, run during off-peak hours, and watch downstream cost (a 21-day backfill triggers 21 warehouse loads).",
        points: [
          "Catchup creates one run per missed interval; off creates only the latest.",
          "Default differs by major version, so set `catchup` explicitly.",
          "Backfill or clear-and-rerun for a bounded window, using current code.",
          "Idempotent tasks make reruns safe.",
          "Throttle with `max_active_runs` and pools."
        ],
        followups: [
          "A backfill overwrites a table that a dashboard reads. How do you avoid showing half-loaded data?",
          "What does `depends_on_past` change for a backfill?"
        ],
        pitfalls: [
          "Leaving catchup on with an old start_date and flooding the warehouse on first deploy.",
          "Backfilling non-idempotent appends and duplicating rows."
        ]
      },
      {
        id: 'platform-03',
        topic: 'Idempotent tasks',
        level: 2,
        q: "Define an idempotent task and describe three ways to make a daily load of slide metadata safe to rerun. What is the catch with a MERGE?",
        a: "A task is idempotent if running it once or five times for the same inputs leaves the same final state: no duplicates, no missing rows, no side effects that accumulate. Retries, backfills and manual reruns all depend on it.\n\nThree patterns:\n\n1. **Overwrite the slice.** Load into the partition for the logical date with truncate semantics (`WRITE_TRUNCATE` on a partition decorator, `INSERT OVERWRITE`, or delete-then-insert in one transaction).\n2. **Upsert on a natural key.** `MERGE` on `slide_id` so a replay updates rather than inserts.\n3. **Stage then swap.** Write to a per-run staging location, validate, then atomically publish (rename, partition exchange, view repoint).\n\nSupporting rules: derive the window from the data interval, use deterministic output paths, and give external side effects (API calls, emails) an idempotency key.\n\nThe MERGE catch: if the source has two rows per key, many engines fail (BigQuery raises an error when multiple source rows match one target row) or silently pick one, so dedupe the staging data first.",
        code: "MERGE scans.slides AS t\nUSING (\n  SELECT * FROM scans.slides_stage\n  WHERE load_date = @load_date\n) AS s\nON t.slide_id = s.slide_id\nWHEN MATCHED THEN UPDATE SET\n  file_bytes = s.file_bytes, qc_status = s.qc_status, scanned_at = s.scanned_at\nWHEN NOT MATCHED THEN INSERT (slide_id, case_id, file_bytes, qc_status, scanned_at)\n  VALUES (s.slide_id, s.case_id, s.file_bytes, s.qc_status, s.scanned_at);",
        codeLang: 'sql',
        points: [
          "Same inputs, same end state, however many times it runs.",
          "Overwrite a partition, upsert on a key, or stage and swap.",
          "Window comes from the data interval, not the clock.",
          "Dedupe the source before a MERGE.",
          "External side effects need idempotency keys."
        ],
        followups: [
          "How do you handle a slide that is rescanned and arrives in a later day's file?",
          "Is a plain append ever acceptable?"
        ],
        pitfalls: [
          "Appending on every retry.",
          "Writing to a path that includes the run's wall-clock time."
        ]
      },
      {
        id: 'platform-04',
        topic: 'Sensors and deferral',
        level: 2,
        q: "The scanner exporter drops the day's manifest at an unpredictable time. Compare sensor poke mode, reschedule mode and deferrable operators. Which do you use on Cloud Composer, and what would you consider instead of waiting at all?",
        a: "**Poke mode** holds a worker slot for the entire wait, sleeping between checks. Fine for a few short waits, wasteful for many long ones.\n\n**Reschedule mode** releases the slot between checks, so the task is rescheduled each interval. It frees workers but adds scheduler churn.\n\n**Deferrable operators** hand the wait to the triggerer, an asyncio-based process that can watch thousands of conditions, and free the worker completely. This is the best default when the provider offers a deferrable mode (many Google provider operators take `deferrable=True`) and your environment runs a triggerer. Check that your Composer version and configuration include one.\n\nAlways set `timeout`; the default for sensors is seven days, which hides a missing export for a week.\n\nInstead of waiting, make it event-driven: a Cloud Storage notification can trigger the DAG through the Airflow REST API (for example from a Cloud Run function), or use Airflow Datasets (2.4+, renamed Assets in 3.x) so a producer DAG's update schedules the consumer. Waiting is simpler; events are cheaper and faster.",
        points: [
          "Poke holds a worker slot; reschedule frees it between checks; deferrable frees it entirely.",
          "Deferrable needs a triggerer and provider support.",
          "Always set a realistic timeout and alert on it.",
          "Event-driven triggers can replace waiting.",
          "Pick by number and length of concurrent waits."
        ],
        followups: [
          "What happens to a deferred task if the triggerer restarts?",
          "How would you alert when the manifest is late but not yet failed?"
        ],
        pitfalls: [
          "Hundreds of poke-mode sensors exhausting worker slots.",
          "Leaving the default seven-day timeout."
        ]
      },
      {
        id: 'platform-05',
        topic: 'Airflow DAG code',
        level: 2,
        q: "Write a daily Airflow 2.x DAG using the TaskFlow API that waits for that day's scan manifest in Cloud Storage, loads it into a day-partitioned BigQuery table idempotently, then checks that rows landed.",
        a: "The design choices matter more than the syntax:\n\n- The sensor is **deferrable** with a bounded timeout, so waiting does not hold a worker.\n- The load writes to the **partition for the logical date** with `WRITE_TRUNCATE`. A retry or backfill replaces that partition, so it cannot duplicate rows.\n- Every path and partition comes from `ds` templating, never `now()`.\n- `catchup=False` and `max_active_runs=1` keep a first deploy from flooding the warehouse.\n- The check is a small `@task`; it returns a count (tiny XCom) and fails loudly on zero rows.\n\nVersion notes: the `schedule` argument needs Airflow 2.4+ (older code used `schedule_interval`); in Airflow 3 import `dag` and `task` from `airflow.sdk`. `deferrable=True` on the Google provider operators depends on the provider version. `BigQueryHook` defaults to legacy SQL, so pass `use_legacy_sql=False`. The target table must be partitioned by `scan_date` before the first run.",
        code: "from __future__ import annotations\n\nimport pendulum\nfrom airflow.decorators import dag, task\nfrom airflow.providers.google.cloud.hooks.bigquery import BigQueryHook\nfrom airflow.providers.google.cloud.sensors.gcs import GCSObjectExistenceSensor\nfrom airflow.providers.google.cloud.transfers.gcs_to_bigquery import GCSToBigQueryOperator\n\nLANDING = \"example-scan-landing\"\nTABLE = \"example-project.scans.slide_manifest\"  # day-partitioned on scan_date\nMANIFEST = \"manifests/{{ ds }}/manifest.ndjson\"\n\n\n@dag(\n    dag_id=\"scan_manifest_daily\",\n    schedule=\"0 6 * * *\",\n    start_date=pendulum.datetime(2026, 1, 1, tz=\"UTC\"),\n    catchup=False,\n    max_active_runs=1,\n    default_args={\"retries\": 2, \"retry_delay\": pendulum.duration(minutes=5)},\n    tags=[\"scans\"],\n)\ndef scan_manifest_daily():\n    wait = GCSObjectExistenceSensor(\n        task_id=\"wait_for_manifest\",\n        bucket=LANDING,\n        object=MANIFEST,\n        deferrable=True,\n        poke_interval=300,\n        timeout=6 * 60 * 60,\n    )\n\n    load = GCSToBigQueryOperator(\n        task_id=\"load_manifest\",\n        bucket=LANDING,\n        source_objects=[MANIFEST],\n        # partition decorator: a rerun replaces exactly this day\n        destination_project_dataset_table=TABLE + \"${{ ds_nodash }}\",\n        source_format=\"NEWLINE_DELIMITED_JSON\",\n        write_disposition=\"WRITE_TRUNCATE\",\n        create_disposition=\"CREATE_NEVER\",\n    )\n\n    @task\n    def check_rows(day: str) -> int:\n        hook = BigQueryHook(use_legacy_sql=False)\n        sql = f\"SELECT COUNT(*) FROM `{TABLE}` WHERE scan_date = DATE '{day}'\"\n        n = int(hook.get_first(sql)[0])\n        if n == 0:\n            raise ValueError(f\"manifest for {day} loaded zero rows\")\n        return n\n\n    check = check_rows(\"{{ ds }}\")\n    wait >> load >> check\n\n\nscan_manifest_daily()",
        codeLang: 'python',
        points: [
          "Deferrable sensor with a bounded timeout.",
          "Load targets the logical-date partition with truncate semantics.",
          "All dates come from templates, none from the clock.",
          "`catchup=False` and `max_active_runs=1` set explicitly.",
          "Check task returns a small value and fails on zero rows.",
          "Names the version-specific bits (schedule arg, Airflow 3 imports, provider versions)."
        ],
        followups: [
          "How would you handle a manifest that arrives but is truncated?",
          "How does this change if the manifest is not newline-delimited JSON?"
        ],
        pitfalls: [
          "Using `datetime.now()` for the partition.",
          "Appending with `WRITE_APPEND`, so retries duplicate rows."
        ]
      },
      {
        id: 'platform-06',
        topic: 'TaskFlow and XCom',
        level: 1,
        q: "What is an XCom, what are its limits, and what should one task hand to the next in a pipeline that processes whole-slide images?",
        a: "An **XCom** is a small message stored as a row in the Airflow metadata database. With the TaskFlow API, a `@task` function's return value is pushed automatically and the next task's argument pulls it, which also draws the dependency.\n\nBecause the value lives in the metadata database, keep it tiny: IDs, paths, counts, status flags. The storage column and its size limit depend on the Airflow version and the database backend (the 2.x docs cite about 64 KB on MySQL). A big payload also bloats the database every scheduler and UI query touches.\n\nPass **references to data, not data**: a Cloud Storage URI, a partition name, a list of slide IDs (or batches of IDs). The next task reads the heavy content from storage.\n\nIf you truly need larger values, a custom XCom backend can store payloads in object storage and keep only a pointer in the database. XCom pickling was off by default in 2.x and is gone in Airflow 3; use JSON-serializable values.",
        points: [
          "XComs are rows in the metadata database.",
          "TaskFlow returns become XComs automatically.",
          "Pass IDs, URIs and counts, not DataFrames or images.",
          "Size limits depend on the database backend.",
          "A custom XCom backend can offload large values."
        ],
        followups: [
          "How do mapped tasks use XCom?",
          "How does old XCom data get cleaned up?"
        ],
        pitfalls: [
          "Returning a full DataFrame from a task.",
          "Enabling pickling to get around serialization errors."
        ]
      },
      {
        id: 'platform-07',
        topic: 'Retries and SLAs',
        level: 2,
        q: "A daily load sometimes fails because an upstream API returns a 503, and sometimes because the data itself is bad. Configure retries, timeouts and alerting so transient faults heal and real problems page someone. What about SLAs?",
        a: "Separate the two failure kinds.\n\n**Transient faults**: `retries=3`, a `retry_delay`, and `retry_exponential_backoff=True` with `max_retry_delay`. Retries are only safe if the task is idempotent.\n\n**Data faults**: raise `AirflowFailException` so the task fails immediately with no retries, because re-reading the same bad file will not fix it. Use `AirflowSkipException` when skipping is the correct outcome.\n\n**Timeouts**: `execution_timeout` per task stops hangs; `dagrun_timeout` bounds a whole run.\n\n**Alerting**: use `on_failure_callback` (fires after retries are exhausted) to page; use `on_retry_callback` only for low-noise logging. Route by owner, not to a shared inbox.\n\n**SLAs**: the classic `sla` argument and `sla_miss_callback` were awkward (evaluated relative to the run's schedule, patchy for manual runs) and were removed in Airflow 3.0. Airflow 3.1 added Deadline Alerts as the replacement (marked experimental at first). A durable alternative is a freshness check on the output table, alerting when data is older than the agreed limit.",
        points: [
          "Retry transient errors with backoff, only on idempotent tasks.",
          "Fail fast on data errors with `AirflowFailException`.",
          "Set `execution_timeout` so nothing hangs silently.",
          "Page on final failure, not every retry.",
          "SLA support differs between Airflow 2 and 3; freshness checks are portable."
        ],
        followups: [
          "How do you avoid alert fatigue across 200 DAGs?",
          "Where do you alert if the scheduler itself is down?"
        ],
        pitfalls: [
          "Retrying a deterministic data error five times.",
          "Alerting on every retry attempt."
        ]
      },
      {
        id: 'platform-08',
        topic: 'Dynamic mapping',
        level: 3,
        q: "Each day brings between 400 and 4,000 slides that each need a QC check against a rate-limited internal service. Design this with dynamic task mapping and explain the concurrency controls that protect the service.",
        a: "Use `expand()` to create one task instance per input at runtime, with `partial()` for the arguments that stay constant. A mapped task takes its input from an upstream XCom, so the list must be small.\n\nTwo practical limits shape the design:\n\n- `max_map_length` (core setting, default 1024) caps how many instances one mapped task may create, so 4,000 slides will fail. **Batch**: map over about 40 batches of 100 IDs instead. This also cuts scheduler overhead, since thousands of tiny task instances are slower than a few hundred meaty ones.\n- An empty list makes the mapped task skip, so decide what a zero-slide day means.\n\nConcurrency, from narrow to wide: a **pool** with N slots shared by every task that calls the QC service (a global cap across DAGs); `max_active_tis_per_dagrun` (2.6+) per task per run; `max_active_tasks` per DAG; `max_active_runs`; and environment-wide `parallelism` plus worker concurrency.\n\nDownstream, a normal task receives all mapped results as one list for aggregation.",
        code: "from airflow.decorators import task\n\n\n@task\ndef list_batches(day: str) -> list[list[str]]:\n    ids = fetch_slide_ids(day)  # your query helper\n    return [ids[i:i + 100] for i in range(0, len(ids), 100)]\n\n\n@task(pool=\"qc_service\", max_active_tis_per_dagrun=4)\ndef run_qc(batch: list[str]) -> dict:\n    ...  # call the QC service for each slide in the batch\n    return {\"n\": len(batch), \"failed\": 0}\n\n\n@task\ndef summarize(results: list[dict]) -> None:\n    ...  # results arrives as the list of all mapped outputs\n\n\nsummarize(run_qc.expand(batch=list_batches(\"{{ ds }}\")))",
        codeLang: 'python',
        points: [
          "`expand()` maps over a runtime list; `partial()` fixes constants.",
          "`max_map_length` defaults to 1024, so batch the work.",
          "A pool caps load on the shared service across DAGs.",
          "Per-run, per-DAG and global limits stack.",
          "Plan for the empty-list case."
        ],
        followups: [
          "How would you retry only the failed batches?",
          "What changes if the QC service is a GPU model rather than an API?"
        ],
        pitfalls: [
          "One mapped instance per slide with no pool.",
          "Returning the full slide records through XCom."
        ]
      },
      {
        id: 'platform-09',
        topic: 'Testing DAGs',
        level: 2,
        q: "How do you test Airflow DAGs, and the SQL they run, before anything reaches Composer? Show the one test every DAG repo should have.",
        a: "Build a pyramid, cheapest first:\n\n1. **Import and integrity test**: load every DAG with `DagBag` and assert there are no import errors, plus house rules (owner, tags, retries set, no cycles). This runs in seconds and catches most deploy breakages.\n2. **Unit tests of logic**: keep task bodies thin and put transformation code in a plain Python package that pytest covers without Airflow.\n3. **SQL tests**: run models and queries against a real engine with tiny fixture tables (DuckDB locally, or a per-PR dataset in the warehouse), asserting row counts and edge cases.\n4. **Single-process runs**: `dag.test()` (2.5+) executes a whole DAG without a scheduler; `airflow tasks test <dag> <task> <date>` runs one task without recording state.\n5. **A dev environment** for end-to-end runs with real connections.\n\nWatch parse time: expensive top-level code (queries, API calls, heavy imports) runs every parse cycle on the scheduler, so keep it out of DAG files.",
        code: "from airflow.models import DagBag\n\n\ndef _bag():\n    return DagBag(dag_folder=\"dags\", include_examples=False)\n\n\ndef test_no_import_errors():\n    assert _bag().import_errors == {}\n\n\ndef test_every_dag_sets_retries_and_tags():\n    for dag_id, dag in _bag().dags.items():\n        assert dag.default_args.get(\"retries\", 0) >= 1, dag_id\n        assert dag.tags, dag_id",
        codeLang: 'python',
        points: [
          "DagBag import test in CI for every pull request.",
          "Thin tasks, logic in a testable package.",
          "SQL tested against a real engine with small fixtures.",
          "`dag.test()` and `airflow tasks test` for local runs.",
          "Keep slow work out of top-level DAG code."
        ],
        followups: [
          "How do you test a sensor without waiting for a real file?",
          "How do you stop a DAG from importing a secret at parse time?"
        ],
        pitfalls: [
          "Only testing in the shared dev environment.",
          "Mocking so heavily that the test proves nothing."
        ]
      },
      {
        id: 'platform-10',
        topic: 'Cloud Composer',
        level: 3,
        q: "You inherit a Cloud Composer environment where tasks start late and the scheduler looks busy. Where do DAGs, plugins and dependencies live, and how do you reason about sizing?",
        a: "Composer creates a Cloud Storage bucket for the environment with folders `dags/`, `plugins/`, `data/` and `logs/`. Deploying DAGs means copying files into `dags/` (CI runs `gcloud storage rsync`); they sync to the scheduler and workers within about a minute with no restart. Python dependencies are set through the environment configuration (PyPI packages), which triggers an environment update; conflicts with Airflow's pinned constraints are a common failure. Airflow config overrides and environment variables are also set at the environment level. The metadata database is managed for you.\n\nSizing and diagnosis, in order:\n\n- **Parse time**: too many DAGs or heavy top-level code starves the scheduler. Check DAG processing metrics before adding CPU.\n- **Scheduler resources**: CPU, memory and count of schedulers, and in Composer 3 the separate DAG processor, which does the parsing.\n- **Workers**: queued versus running tasks, autoscaling minimum and maximum, worker memory (OOM kills look like random task failures).\n- **Offload heavy compute** to BigQuery, a pod or a managed service; workers should orchestrate.\n- **Database growth**: clean old runs and XComs.\n\nThe knobs (size presets, autoscaling settings, triggerer support) differ between Composer 2 and 3, so confirm against the current docs for your version.",
        points: [
          "DAGs, plugins and data live in the environment's bucket folders.",
          "Dependencies change through environment configuration, not the bucket.",
          "Diagnose parse time before scaling anything.",
          "Look at queued versus running tasks and worker memory.",
          "Offload heavy compute from workers.",
          "Details differ by Composer version."
        ],
        followups: [
          "Why can a rsync with delete into `dags/` break the environment?",
          "How do you keep dev cheap but similar to prod?"
        ],
        pitfalls: [
          "Scaling workers when the bottleneck is DAG parsing.",
          "Syncing with delete and removing files Composer placed there."
        ]
      },
      {
        id: 'platform-11',
        topic: 'Docker basics',
        level: 1,
        q: "Explain the difference between a Docker image and a container, and why the order of Dockerfile instructions changes build time.",
        a: "An **image** is an immutable, layered filesystem plus metadata (entrypoint, environment), built from a Dockerfile. A **container** is a running instance of an image: the same layers plus a thin writable layer, isolated by Linux namespaces and limited by cgroups. Many containers can start from one image, and the writable layer disappears with the container, so persistent data goes in volumes or external storage.\n\nEach `RUN`, `COPY` and `ADD` creates a layer. The build cache reuses a layer if the instruction and its inputs are unchanged, and once one layer changes, every layer after it rebuilds. So put slow, stable steps first and fast-changing ones last: base image, system packages, copy the dependency manifest and install, then copy your source.\n\nRelated habits: a `.dockerignore` keeps the build context small (exclude `.git` and sample slide files); remove package lists in the same `RUN` that created them, because deleting in a later layer does not shrink earlier ones; pin base image versions.",
        points: [
          "Image is the immutable template; container is the running instance.",
          "Writable layer is ephemeral; use volumes for state.",
          "Each instruction is a layer; a change invalidates all later layers.",
          "Install dependencies before copying source.",
          "`.dockerignore` and same-layer cleanup keep images small."
        ],
        followups: [
          "Why does `apt-get update` belong in the same `RUN` as the install?"
        ],
        pitfalls: [
          "`COPY . .` before installing dependencies.",
          "Believing a deleted file in a later layer shrinks the image."
        ]
      },
      {
        id: 'platform-12',
        topic: 'Dockerfile for Python',
        level: 2,
        q: "Write a multi-stage Dockerfile for a Python batch job that reads slides with OpenSlide. Keep it small, run as non-root, and keep secrets out of the image.",
        a: "The build stage installs dependencies into a virtual environment; the runtime stage starts from a fresh slim base and copies only that environment, so compilers and caches never ship.\n\nChoices to explain:\n\n- **`python:3.12-slim-bookworm` over Alpine**: Alpine uses musl, fewer scientific packages publish musl wheels, and pip falls back to compiling from source, which is slow and large. Naming the Debian release keeps the system packages predictable.\n- **Dependency layer first**, so it is reused until `requirements.txt` changes.\n- **Non-root with a numeric UID**, because Kubernetes `runAsNonRoot` can only verify numeric users.\n- **Exec-form `ENTRYPOINT`** so SIGTERM reaches Python and the job can shut down cleanly.\n- **No secrets in layers**: anything in `ARG`, `ENV` or `COPY` is visible in `docker history`. If a private package index needs a token at build time, use a BuildKit secret mount. Runtime secrets arrive from the orchestrator as env vars or mounted files.\n\nOpenSlide needs a native library: the Debian package (`libopenslide0` on bookworm; trixie ships OpenSlide 4 as `libopenslide1`), or the `openslide-bin` wheel, which `openslide-python` 1.4 and later can load instead.",
        code: String.raw`# syntax=docker/dockerfile:1
FROM python:3.12-slim-bookworm AS build
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
WORKDIR /src
# Dependencies first: this layer is reused until requirements.txt changes.
COPY requirements.txt .
RUN pip install -r requirements.txt
# Private index token at build time, if needed (never ARG or ENV):
#   RUN --mount=type=secret,id=pip_netrc,target=/root/.netrc pip install -r requirements.txt
COPY pyproject.toml ./
COPY src/ src/
RUN pip install --no-deps .

FROM python:3.12-slim-bookworm AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends libopenslide0 \
 && rm -rf /var/lib/apt/lists/*
RUN useradd --system --uid 10001 --no-create-home app
COPY --from=build /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH" PYTHONUNBUFFERED=1
WORKDIR /app
USER 10001
ENTRYPOINT ["python", "-m", "scan_loader"]`,
        codeLang: 'text',
        points: [
          "Multi-stage: build tools stay out of the runtime image.",
          "Slim Debian base rather than Alpine for scientific wheels.",
          "Dependencies layered before source for cache reuse.",
          "Numeric non-root user and exec-form entrypoint.",
          "Secrets never in ARG, ENV or COPY; BuildKit secret mounts at build time."
        ],
        followups: [
          "How would you scan and pin this image in CI?",
          "What changes if the workload needs a GPU?"
        ],
        pitfalls: [
          "Passing a token with `ARG` and thinking it vanishes after the build.",
          "Running as root because it was the default."
        ]
      },
      {
        id: 'platform-13',
        topic: 'Kubernetes resources',
        level: 1,
        q: "Explain Pod, Deployment, Job, CronJob, ConfigMap and Secret, and match each to a workload in a slide-imaging platform.",
        a: "- **Pod**: the smallest unit, one or more containers sharing network and storage. You rarely create bare Pods.\n- **Deployment**: keeps N replicas of a Pod running and does rolling updates. Fits long-running services such as an inference API or a viewer backend.\n- **Job**: runs Pods to completion, with `completions`, `backoffLimit` and `ttlSecondsAfterFinished` for cleanup. Fits a one-time reprocess of a slide batch.\n- **CronJob**: creates a Job on a schedule, with `concurrencyPolicy` to avoid overlap. Fits a nightly cleanup. It cannot express dependencies, which is why pipelines use an orchestrator instead.\n- **ConfigMap**: non-secret configuration (queue names, thresholds), injected as env vars or files.\n- **Secret**: credentials and tokens, injected the same way.\n\nSecret values are only base64-encoded, and etcd stores them unencrypted unless encryption at rest is configured, so anyone who can read Secrets through the API sees them. Restrict access with RBAC and consider encryption at rest or an external secret manager. Env vars are read at container start, so changing a ConfigMap does not update running Pods; mounted files do refresh eventually (not with `subPath`).",
        points: [
          "Deployment for long-running services, Job for run-to-completion.",
          "CronJob schedules a Job and needs `concurrencyPolicy` thought.",
          "ConfigMap for config, Secret for credentials.",
          "Secrets are base64, not encryption.",
          "Env var changes need a Pod restart."
        ],
        followups: [
          "What does `backoffLimit` do on a failing Job?"
        ],
        pitfalls: [
          "Putting credentials in a ConfigMap.",
          "Creating bare Pods that nothing restarts."
        ]
      },
      {
        id: 'platform-14',
        topic: 'Requests, limits, OOM',
        level: 2,
        q: "A Pod running a tile-extraction job shows `OOMKilled`. Explain requests versus limits, and walk through how you debug and fix it.",
        a: "**Requests** are what the scheduler reserves when placing the Pod. **Limits** are the runtime cap. Exceeding a CPU limit means throttling; exceeding a memory limit means the kernel kills the process, reported as `OOMKilled` with exit code 137.\n\nQoS class follows from these: **Guaranteed** (requests equal limits for every container), **Burstable**, **BestEffort**. Under node memory pressure, BestEffort and over-request Pods are evicted first. An eviction (reason `Evicted`) is different from a container OOM kill.\n\nDebug:\n\n1. `kubectl describe pod` and read Last State: reason and exit code.\n2. `kubectl top pod --containers` to compare actual use to the limit.\n3. Find out why memory grows. In slide work, a single `read_region` at a high-resolution level allocates width x height x 4 bytes, so a 40,000 x 30,000 px region is about 4.8 GB. Read by tile, cap worker threads, and avoid holding every tile in a list.\n\nFix by reducing peak memory first, then set the limit from measured peak plus headroom. A common pattern is memory request equal to memory limit, and often no CPU limit to avoid throttling.",
        code: "kubectl describe pod tile-worker-0 | grep -A6 'Last State'\nkubectl get pod tile-worker-0 -o jsonpath='{.status.containerStatuses[0].lastState.terminated.reason}'\nkubectl top pod tile-worker-0 --containers\nkubectl get events --field-selector involvedObject.name=tile-worker-0",
        codeLang: 'bash',
        points: [
          "Requests drive scheduling; limits are enforced at runtime.",
          "Memory over limit is killed (137); CPU over limit is throttled.",
          "Distinguish container OOM from node-pressure eviction.",
          "Measure peak use, then fix the code before raising the limit.",
          "QoS classes decide eviction order."
        ],
        followups: [
          "Would you set a CPU limit on this workload?",
          "How would you size memory for slides of widely varying dimensions?"
        ],
        pitfalls: [
          "Doubling the limit without understanding the growth.",
          "Confusing an eviction with an OOM kill."
        ]
      },
      {
        id: 'platform-15',
        topic: 'GPU node pools',
        level: 3,
        q: "Design the Kubernetes side of a slide-inference service on GPUs: how Pods get GPUs, how you keep other workloads off expensive nodes, and how you handle scale and cost.",
        a: "**Getting a GPU**: a dedicated node pool with GPU nodes, the vendor device plugin and drivers (managed clusters can install them for you), and Pods that ask for `nvidia.com/gpu: 1` under `limits`. Extended resources are whole units unless you configure time-slicing or MIG partitioning.\n\n**Isolation**: taint the GPU pool and add a matching toleration plus a node selector on inference Pods, so CPU-only workloads never land there. Some managed platforms add the toleration automatically; others do not.\n\n**Scale**: let the cluster autoscaler take the pool to zero when idle, and scale Pods on queue depth (for example with KEDA) rather than CPU. A cold GPU node takes minutes: node boot, image pull, model load. Keep images lean and cache model weights near the node.\n\n**Cost**: spot GPUs suit batch scoring if work is idempotent and resumable by tile or slide.\n\n**Throughput**: slide decoding is CPU-bound and often starves the GPU. Request enough CPU and memory per GPU, prefetch tiles in worker processes, and batch tiles per forward pass. Watch GPU utilization, not Pod count.",
        points: [
          "Dedicated GPU pool with taint, toleration and node selector.",
          "GPU requested under `limits`, whole units unless sliced.",
          "Scale on queue depth; allow scale to zero and plan for cold starts.",
          "Idempotent batch work can use spot GPUs.",
          "Data loading and CPU sizing decide real throughput."
        ],
        followups: [
          "How do you keep a cold start from missing a turnaround target?",
          "When would MIG or time-slicing be worth it?"
        ],
        pitfalls: [
          "Putting the GPU only in `requests`.",
          "Sizing one tiny CPU request per GPU and wondering why utilization is low."
        ]
      },
      {
        id: 'platform-16',
        topic: 'KubernetesPodOperator',
        level: 2,
        q: "When would you run an Airflow task with KubernetesPodOperator instead of a PythonOperator on the workers, and what does it look like with resources, config and a secret?",
        a: "Use it when the task needs **isolation**: its own dependencies (OpenSlide, a different Python), its own CPU, memory or GPU sizing, or a non-Python tool. Airflow only creates the Pod, streams its logs and tracks its exit status, so heavy work stops competing with the scheduler's workers.\n\nPoints to cover:\n\n- Resources go in `container_resources`; this keeps one greedy task from OOM-killing a shared worker.\n- Config comes from a ConfigMap via `env_from`; credentials come from a Kubernetes Secret via the `Secret` helper or `secretKeyRef`, never from literals in DAG code.\n- Cleanup is `on_finish_action=\"delete_pod\"` in recent providers (older ones used `is_delete_operator_pod`). Provider versions matter, so check yours.\n- Retries create a new Pod, so the container must be idempotent.\n- Return values go through an XCom sidecar and must stay small.\n- Which cluster and namespace the Pod lands in depends on your Composer version: in Composer 3, Pods in the environment's own cluster run in the `composer-user-workloads` namespace, and another GKE cluster needs `GKEStartPodOperator` or its own connection.\n\nThe image must be pullable by the cluster, and a pinned tag keeps runs reproducible.",
        code: "from airflow.providers.cncf.kubernetes.operators.pod import KubernetesPodOperator\nfrom airflow.providers.cncf.kubernetes.secret import Secret\nfrom kubernetes.client import models as k8s\n\nscore = KubernetesPodOperator(\n    task_id=\"score_slides\",\n    name=\"score-slides\",\n    namespace=\"pathology\",\n    image=\"registry.example.com/slide-scorer:1.4.2\",\n    cmds=[\"python\", \"-m\", \"scorer\"],\n    arguments=[\"--day\", \"{{ ds }}\"],\n    container_resources=k8s.V1ResourceRequirements(\n        requests={\"cpu\": \"2\", \"memory\": \"8Gi\"},\n        limits={\"memory\": \"8Gi\"},\n    ),\n    env_from=[k8s.V1EnvFromSource(config_map_ref=k8s.V1ConfigMapEnvSource(name=\"scorer-config\"))],\n    secrets=[Secret(\"env\", \"DB_PASSWORD\", \"scorer-db\", \"password\")],\n    get_logs=True,\n    on_finish_action=\"delete_pod\",\n)",
        codeLang: 'python',
        points: [
          "Use for dependency or resource isolation.",
          "Resources, ConfigMap and Secret are declared on the operator.",
          "Credentials come from a Kubernetes Secret, not DAG code.",
          "Retries make a new Pod, so the container must be idempotent.",
          "Cleanup argument names changed across provider versions."
        ],
        followups: [
          "How do you see the logs if the Pod is deleted?",
          "What happens to the Pod if the Airflow task is killed?"
        ],
        pitfalls: [
          "Using `latest` as the image tag.",
          "Returning large results through XCom."
        ]
      },
      {
        id: 'platform-17',
        topic: 'Debug a manifest',
        level: 3,
        q: "This inference Deployment is rejected by the API server. After you fix that, the Pods restart repeatedly with exit code 137, and the model needs about 6 GB and roughly 90 seconds to load. Find every defect.",
        setup: "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: slide-scorer\nspec:\n  replicas: 2\n  selector:\n    matchLabels:\n      app: slide-scorer\n  template:\n    metadata:\n      labels:\n        app: slide-scorer\n    spec:\n      containers:\n        - name: scorer\n          image: registry.example.com/slide-scorer:latest\n          env:\n            - name: DB_PASSWORD\n              value: \"synthetic-password-1\"\n          resources:\n            requests:\n              cpu: \"2\"\n              memory: 2Gi\n              nvidia.com/gpu: 1\n            limits:\n              memory: 2Gi\n          livenessProbe:\n            httpGet:\n              path: /healthz\n              port: 8080\n            initialDelaySeconds: 5\n            periodSeconds: 5\n            failureThreshold: 2",
        setupLang: 'yaml',
        a: "Five defects:\n\n1. **GPU only in requests.** Extended resources like `nvidia.com/gpu` must be set under `limits` (and if `requests` is also set it must match). This is the validation rejection.\n2. **Memory limit 2Gi for a 6 GB model.** The kernel kills the process: `OOMKilled`, exit 137. Size from measured peak plus headroom.\n3. **Liveness probe too aggressive.** It starts after 5 seconds and fails after 10, so the Pod is killed while the model is still loading, forever. Add a `startupProbe` that allows about three minutes (36 x 5 s), and keep liveness for later hangs. Probe kills usually show 143 or 137 depending on how fast the process exits.\n4. **Plain-text password.** Use `secretKeyRef` (or an external secret manager). Literals end up in Git and in `kubectl get`.\n5. **`:latest` tag.** Not reproducible and `imagePullPolicy` surprises; pin a version or digest.\n\nAlso check scheduling (a node selector and toleration for the GPU pool; names are cluster-specific) and add a `readinessProbe` so a Service sends no traffic to a Pod that is still loading.",
        code: "      containers:\n        - name: scorer\n          image: registry.example.com/slide-scorer:1.4.2\n          env:\n            - name: DB_PASSWORD\n              valueFrom:\n                secretKeyRef:\n                  name: scorer-db\n                  key: password\n          resources:\n            requests:\n              cpu: \"2\"\n              memory: 8Gi\n            limits:\n              memory: 8Gi\n              nvidia.com/gpu: 1\n          startupProbe:\n            httpGet:\n              path: /healthz\n              port: 8080\n            periodSeconds: 5\n            failureThreshold: 36\n          livenessProbe:\n            httpGet:\n              path: /healthz\n              port: 8080\n            periodSeconds: 10\n            failureThreshold: 3",
        codeLang: 'yaml',
        points: [
          "GPU belongs under `limits`.",
          "Memory limit is below the model's working set (OOMKilled, 137).",
          "Startup probe protects slow model loads from liveness kills.",
          "Secret via `secretKeyRef`, not a literal.",
          "Pin the image tag; add GPU pool scheduling constraints."
        ],
        followups: [
          "How would you confirm which defect caused each restart?",
          "How would you roll this out without dropping in-flight requests?"
        ],
        pitfalls: [
          "Raising the memory limit and ignoring the probe.",
          "Fixing the YAML but leaving the secret in Git history."
        ]
      },
      {
        id: 'platform-18',
        topic: 'Terraform in CI',
        level: 3,
        q: "Explain Terraform state, how you run plan and apply safely in CI for the platform that hosts the imaging pipeline, and how you detect and handle drift.",
        a: "**State** maps your configuration to real resources and records their attributes. Keep it in a remote backend with locking (for example a versioned Cloud Storage bucket, which supports locking natively). State can contain secrets in plain text, so restrict access to it as you would a credential store. Split state per environment and per blast radius; never commit it.\n\n**CI flow**:\n\n1. On a pull request: `fmt -check`, `validate`, then `plan -out=tfplan`; post the plan as a comment. Use a read-mostly identity.\n2. On merge, with approval for production: `apply tfplan` using the saved plan (carried from the plan step as a protected artifact, since it can hold secrets), from a separate, more privileged identity obtained through OIDC, not a stored key.\n3. Pin provider versions and commit the lock file so every run resolves the same providers.\n\n**Drift** is a gap between state and reality, usually a manual console change. Detect it with a scheduled `plan -detailed-exitcode` (exit code 2 means changes) or `plan -refresh-only`. Resolve by reverting the change or updating the code; adopt unmanaged resources with `import` (the `import` block needs Terraform 1.5+).",
        code: "terraform fmt -check -recursive\nterraform init -input=false\nterraform validate\nterraform plan -input=false -lock-timeout=5m -out=tfplan\n# after approval, apply exactly the saved plan\nterraform apply -input=false tfplan\n\n# scheduled drift check: exit 0 = no changes, 1 = error, 2 = changes pending\nterraform plan -input=false -detailed-exitcode",
        codeLang: 'bash',
        points: [
          "Remote state with locking; treat state as sensitive.",
          "Plan on pull request, apply the saved plan after approval.",
          "Separate identities for plan and apply; OIDC instead of keys.",
          "Pin providers with the lock file.",
          "Scheduled plan detects drift; fix by revert or import."
        ],
        followups: [
          "Two pull requests change the same resource. What protects you?",
          "How would you restructure a state file that has become too big?"
        ],
        pitfalls: [
          "Applying from a laptop.",
          "Passing secrets as variables without realizing they land in state."
        ]
      },
      {
        id: 'platform-19',
        topic: 'GitHub Actions',
        level: 2,
        q: "Write a GitHub Actions workflow for a data repository (Airflow DAGs, SQL and a container image): lint, unit tests, SQL checks, then build and deploy on main with no stored cloud keys.",
        a: "Structure it as a fast gate and a guarded deploy:\n\n- **Test job** runs on every pull request: lint (`ruff`), SQL lint (`sqlfluff`, with the right dialect), then pytest, which includes the DAG import test.\n- **Deploy job** runs only on `main`, needs the test job, and is tied to a GitHub **environment** so you can add required reviewers for production.\n- **Credentials via OIDC**: the job asks for `id-token: write` and exchanges GitHub's short-lived token for cloud access through workload identity federation. The cloud side trusts only this repository and branch or environment (an attribute condition on the token's claims). No JSON key in repository secrets.\n- **Least privilege**: top-level `permissions: contents: read`, widened only on the deploy job.\n- `concurrency` stops overlapping runs; cancel in-progress runs only for pull requests, so a deploy is never killed halfway. `timeout-minutes` bounds hangs.\n\nTwo cautions. Pin third-party actions to a full commit SHA in sensitive repositories, and confirm current major versions of each action. And do not `rsync --delete` into a Composer `dags/` folder blindly: Composer keeps a monitoring DAG there, and deleting it breaks monitoring.",
        code: "name: data-ci\non:\n  pull_request:\n  push:\n    branches: [main]\n\npermissions:\n  contents: read\n\nconcurrency:\n  group: data-ci-\${{ github.ref }}\n  cancel-in-progress: ${{ github.event_name == 'pull_request' }}\n\njobs:\n  test:\n    runs-on: ubuntu-latest\n    timeout-minutes: 20\n    steps:\n      - uses: actions/checkout@v5\n      - uses: actions/setup-python@v6\n        with:\n          python-version: \"3.12\"\n          cache: pip\n      - run: pip install -r requirements-dev.txt\n      - run: ruff check . && ruff format --check .\n      - run: sqlfluff lint sql/ --dialect bigquery\n      - run: pytest -q tests/\n\n  deploy-dev:\n    needs: test\n    if: github.ref == 'refs/heads/main'\n    runs-on: ubuntu-latest\n    timeout-minutes: 20\n    environment: dev\n    permissions:\n      contents: read\n      id-token: write\n    steps:\n      - uses: actions/checkout@v5\n      - uses: google-github-actions/auth@v2\n        with:\n          workload_identity_provider: \${{ vars.WIF_PROVIDER }}\n          service_account: \${{ vars.DEPLOY_SA }}\n      - uses: google-github-actions/setup-gcloud@v2\n      - name: Build and push image\n        run: |\n          gcloud auth configure-docker \"\${{ vars.REGISTRY_HOST }}\" --quiet\n          docker build -t \"\${{ vars.IMAGE }}:\${{ github.sha }}\" .\n          docker push \"\${{ vars.IMAGE }}:\${{ github.sha }}\"\n      - name: Sync DAGs to the Composer bucket\n        run: gcloud storage rsync --recursive dags/ \"gs://\${{ vars.COMPOSER_BUCKET }}/dags\"",
        codeLang: 'yaml',
        points: [
          "Pull request gate: lint, SQL lint, unit tests including DAG import.",
          "Deploy only from main, via a protected environment.",
          "OIDC federation replaces long-lived cloud keys.",
          "Minimal `permissions`, widened per job.",
          "Image tagged by commit SHA; no blind rsync delete into Composer."
        ],
        followups: [
          "How do pull requests from forks interact with secrets?",
          "How do you promote the same image to test and prod?"
        ],
        pitfalls: [
          "Storing a service account key as a repository secret.",
          "Using floating action tags such as `@main`."
        ]
      },
      {
        id: 'platform-20',
        topic: 'Jenkins vs Actions',
        level: 3,
        q: "Compare a Jenkinsfile pipeline with a GitHub Actions workflow for the same data project, and explain how each reaches cloud resources without long-lived keys. When would you still pick Jenkins?",
        a: "Both express the same flow: lint, test, build, deploy. In Jenkins a declarative `Jenkinsfile` has `stages` and `steps` running on agents you label; in Actions a workflow has `jobs` and `steps` on hosted or self-hosted runners.\n\n**Jenkins strengths**: sits inside your network, so it can reach an on-premises scanner share or internal database; shared libraries for reuse; very flexible. **Costs**: you patch the controller and plugins, scale agents, and own the security posture.\n\n**Actions strengths**: no controller to run, workflows live beside the code, native OIDC. **Costs**: third-party actions are a supply-chain risk (pin to SHAs); private network access needs self-hosted runners.\n\n**Credentials, either way**: prefer short-lived identity. In Actions, OIDC federation with conditions on repository, branch and environment. In Jenkins, run agents on cloud machines with an attached service identity, or use an OIDC plugin. If you must store a secret, scope it to one folder or environment, rotate it, and rely on log masking only as a backstop; derived values can still leak.\n\nChoose Jenkins when builds must run on-premises with access to internal systems and you already operate it well.",
        code: "pipeline {\n  agent { label 'docker' }\n  options { timeout(time: 30, unit: 'MINUTES') }\n  environment { COMPOSER_BUCKET = 'example-composer-bucket' }\n  stages {\n    stage('Lint') {\n      steps { sh 'ruff check . && sqlfluff lint sql/ --dialect bigquery' }\n    }\n    stage('Test') {\n      steps { sh 'pytest -q tests/' }\n    }\n    stage('Deploy DAGs') {\n      when { branch 'main' }   // branch conditions need a multibranch pipeline\n      // credentials come from the agent's attached service identity, not a stored key\n      steps { sh 'gcloud storage rsync --recursive dags/ \"gs://$COMPOSER_BUCKET/dags\"' }\n    }\n  }\n}",
        codeLang: 'text',
        points: [
          "Same stages, different syntax: Groovy Jenkinsfile versus YAML workflow.",
          "Jenkins: network reach and flexibility, at the cost of operating it.",
          "Actions: low operations, native OIDC, supply-chain care needed.",
          "Prefer short-lived identity over stored keys in both.",
          "Scope any stored credential narrowly and rotate it."
        ],
        followups: [
          "How do you share pipeline logic across 30 repositories in each tool?",
          "How do you audit who can deploy to production?"
        ],
        pitfalls: [
          "Treating log masking as a security control.",
          "Letting an ancient plugin set become the weak link."
        ]
      },
      {
        id: 'platform-21',
        topic: 'Environment promotion',
        level: 3,
        q: "Design promotion of data pipeline changes from dev to test to prod. What is the same in every environment, what differs, and what gates each step?",
        a: "**Build once, promote the artifact.** The image (by commit SHA or digest) and the DAG bundle are identical in every environment; only configuration differs, injected through variables, connections and Terraform `tfvars`. Rebuilding per environment means you never tested what you shipped.\n\n**What differs**: separate cloud projects or accounts, separate orchestrator environments (smaller in dev), separate identities, and separate data. Production patient-linked data does not flow downward. Dev and test use synthetic or de-identified fixtures, plus a few golden datasets with known expected outputs.\n\n**Gates**:\n\n1. Dev: pull request tests, then automatic deploy and smoke run.\n2. Test: contract and data tests on realistic volume, plus reconciliation of counts against a known source.\n3. Prod: human approval, a deploy window away from peak clinical hours, a post-deploy check (DAGs import, one dry run).\n\n**Rollback** is redeploying the previous SHA, which only works if schema changes follow expand-then-contract (add, migrate, remove later).\n\nOrchestrator detail: new DAGs are created paused by default in many setups (`dags_are_paused_at_creation`), so decide who unpauses and when.",
        points: [
          "Build once; promote the identical artifact.",
          "Configuration, not code, differs by environment.",
          "Separate projects, identities and data per environment.",
          "Gates escalate: automated, data tests, approval.",
          "Rollback relies on backward-compatible schema changes."
        ],
        followups: [
          "How do you test a change that depends on production-scale volume?",
          "What do you do when a hotfix must skip test?"
        ],
        pitfalls: [
          "Copying production data into dev for convenience.",
          "Environment-specific `if` branches in code."
        ]
      },
      {
        id: 'platform-22',
        topic: 'Data contracts and tests',
        level: 2,
        q: "What belongs in a data contract between the team exporting scan metadata and the team loading it, and how do dbt tests compare with Great Expectations for enforcing it?",
        a: "A **data contract** is an explicit, versioned agreement at a boundary:\n\n- schema: names, types, nullability\n- semantics and units (is `mpp` microns per pixel? what timezone are timestamps in?)\n- keys and uniqueness, allowed values\n- freshness and volume expectations\n- change process: notice period and versioning for breaking changes, plus a named owner on each side\n\nEnforce it where data crosses the boundary, and decide the failure action: block publication, quarantine bad rows, or warn.\n\n**dbt tests** are SQL assertions declared in YAML beside the models (`unique`, `not_null`, `accepted_values`, `relationships`, custom tests), run by `dbt test` or `dbt build` in the warehouse. dbt **model contracts** (1.5+) additionally enforce column names and types at build time. They are cheap, but they only see data already landed.\n\n**Great Expectations** validates data (DataFrames or SQL sources) in a pipeline step, can gate before load, and produces readable validation reports. It needs more setup, and its API changed substantially between 0.x and 1.x.\n\nSyntax differs by dbt version: `data_tests:` (1.8+; earlier `tests:`), and newer releases prefer test arguments nested under `arguments:`. Check yours.",
        code: "models:\n  - name: slides\n    # with an enforced contract, every column the model returns must be listed\n    config:\n      contract:\n        enforced: true\n    columns:\n      - name: slide_id\n        data_type: bigint\n        constraints:\n          - type: not_null\n        data_tests:\n          - unique\n      - name: qc_status\n        data_type: string\n        data_tests:\n          - accepted_values:\n              values: ['pass', 'fail', 'pending']",
        codeLang: 'yaml',
        points: [
          "Contract covers schema, semantics, keys, freshness, volume and change process.",
          "Enforce at the boundary with a defined failure action.",
          "dbt tests run in-warehouse after landing; contracts check types at build.",
          "Great Expectations can gate before load, with more setup.",
          "Name version-specific syntax rather than guessing."
        ],
        followups: [
          "A producer adds a column. Is that breaking?",
          "How do you handle a test that fails on 0.01% of rows?"
        ],
        pitfalls: [
          "Contracts nobody owns or versions.",
          "Testing only uniqueness and not-null."
        ]
      },
      {
        id: 'platform-23',
        topic: 'Data observability',
        level: 3,
        q: "A model-scoring table looks fine in pipeline logs but a pathologist-facing dashboard is wrong. What observability would have caught it? Cover the four classic checks, lineage and an incident runbook.",
        a: "A green pipeline only proves the code ran, not that the data is right. Monitor the data itself:\n\n- **Freshness**: age of `max(loaded_at)` against the expected cadence.\n- **Volume**: row counts against a seasonal baseline (same weekday), such as slides per day.\n- **Schema**: added, dropped or retyped columns.\n- **Distribution**: null rates, share of `qc_status = 'fail'`, score histogram shifts, a sudden change in median `mpp`.\n\nUse baselines and bounds rather than fixed constants, and route each alert to a named owner so alerts are acted on.\n\n**Lineage** (table and column level; the OpenLineage integration for Airflow is one source) answers two questions fast: what upstream change broke this, and what downstream dashboards and models are affected, so you know who to warn.\n\n**Runbook** per critical dataset:\n\n1. Symptoms and the dashboard or query that shows them.\n2. Upstream checks, in order.\n3. The safe rerun or backfill command (idempotent).\n4. Rollback or fallback.\n5. Escalation contacts and a stakeholder message template.\n6. After resolution: a blameless review that ends in a new check.",
        points: [
          "Success logs are not data quality.",
          "Freshness, volume, schema and distribution checks.",
          "Seasonal baselines and named owners avoid noise.",
          "Lineage shows upstream cause and downstream impact.",
          "Runbooks include a safe rerun and end with a new test."
        ],
        followups: [
          "How do you tune a volume alert so weekends do not page anyone?",
          "Which checks run inside the pipeline versus on a schedule outside it?"
        ],
        pitfalls: [
          "Alerting on every anomaly with no owner.",
          "Runbooks that say 'investigate' without commands."
        ]
      },
      {
        id: 'platform-24',
        topic: 'Sizing and done',
        level: 2,
        q: "How do you size data engineering work, and what is your definition of done for a new pipeline?",
        a: "Size by **uncertainty**, not only effort. The costly unknowns in data work are the source (schema quality, volume, access approvals, vendor behavior) and the hidden tail: backfill, reconciliation, edge cases, monitoring, docs. Tactics:\n\n- Timebox a **spike** for unknowns, then estimate.\n- Slice **vertically**: one stain, one scanner, one day end to end before breadth.\n- Use reference classes: how long did the last comparable pipeline take, including the tail?\n- Estimate in relative points and track cycle time; give ranges, not single dates.\n\n**Definition of done for a pipeline**:\n\n- merged through review and deployed by CI\n- unit, SQL and data tests (including contract checks) passing\n- proven idempotent: run twice, same result\n- backfill complete and counts reconciled to the source\n- freshness and volume monitoring with a named owner and an alert route\n- runbook, data dictionary and lineage entry\n- access reviewed for least privilege\n- stakeholder sign-off on sample output",
        points: [
          "Size by uncertainty; spike the unknowns.",
          "Vertical slices before horizontal breadth.",
          "Account for backfill, reconciliation and monitoring.",
          "Done includes idempotency, monitoring, runbook and reconciliation.",
          "Give ranges."
        ],
        followups: [
          "A stakeholder wants a date for something with an unknown source. What do you say?"
        ],
        pitfalls: [
          "Counting only the happy-path transform.",
          "Calling it done when it runs once."
        ]
      },
      {
        id: 'platform-25',
        topic: 'Unplanned work, demos',
        level: 1,
        q: "Mid-sprint, a pipeline fails and someone asks for a one-off extract. How do you handle unplanned work, and how do you demo data work to people who do not read SQL?",
        a: "**Unplanned work**:\n\n- Reserve capacity up front (a buffer of roughly 10 to 20 percent, or a rotating owner for interrupts) so surprises do not wreck commitments.\n- Triage by impact and urgency: anything touching clinical turnaround outranks a convenience request.\n- Make it visible: every interrupt gets a ticket, which also shows later how much capacity it consumed.\n- Swap, do not stack: if new work enters the sprint, say what leaves.\n- Fix causes: repeated failures become backlog items; a one-off extract requested twice becomes a self-serve view.\n\n**Demos for non-technical stakeholders**:\n\n- Start with their question, not the schema.\n- Show the answer in the tool they use, such as a dashboard or a case worklist.\n- Show before and after (turnaround from days to hours).\n- Walk one synthetic case end to end.\n- Be honest about caveats and what is not done yet.\n- End with a decision or feedback request, not a data dump.",
        points: [
          "Reserve capacity and triage by impact.",
          "Track interrupts; swap rather than stack.",
          "Turn repeated requests into self-serve products.",
          "Demo the stakeholder's question in their tool.",
          "State caveats and ask for a decision."
        ],
        followups: [
          "How do you say no to an urgent request that is not urgent?"
        ],
        pitfalls: [
          "Absorbing interrupts silently until the sprint collapses.",
          "Demoing SQL and table structure."
        ]
      },
      {
        id: 'platform-26',
        topic: 'Linux triage',
        level: 1,
        q: "A Linux host that stages slide files reports 'No space left on device'. Show the commands you run, in order, to find what is full and what is big, and explain why deleting a file might not free space. Include log reading with grep, awk and sed.",
        a: "Work from the filesystem down to the file:\n\n1. `df -h` shows which filesystem is full; `df -i` checks inodes, since millions of tiny tile files can exhaust inodes while bytes remain.\n2. `du -xh --max-depth=1 | sort -rh` walks down level by level (`-x` stays on one filesystem).\n3. `find -xdev -type f -size +2G` lists the biggest individual files.\n4. If you deleted a large file and space did not return, a process still holds it open. `lsof +L1` lists deleted-but-open files; restart or signal that process.\n\nFor logs, `tail -F` follows through rotation; `grep -c` counts matches; `awk '{print $1}' | sort | uniq -c | sort -rn` counts by a column; `sed -n '/start/,/end/p'` extracts a time window.\n\nPermissions: `ls -l` and `id` show owner, group and mode; the directory needs execute permission to traverse and write permission to create files. `ps aux --sort=-%mem` finds heavy processes.",
        code: "df -h /data                       # which filesystem is full\ndf -i /data                       # or out of inodes\ndu -xh --max-depth=1 /data 2>/dev/null | sort -rh | head -15\nfind /data -xdev -type f -size +2G -printf '%s\\t%p\\n' | sort -rn | head -10\nsudo lsof +L1 /data | head        # deleted but still held open\nls -ld /data/incoming; id         # owner, group, mode versus who you are\ntail -F /var/log/scan-agent.log\ngrep -c ERROR /var/log/scan-agent.log\ngrep ERROR /var/log/scan-agent.log | awk '{print $1}' | sort | uniq -c | sort -rn | head\nsed -n '/2026-10-26 02:/,/2026-10-26 03:/p' /var/log/scan-agent.log\nps aux --sort=-%mem | head -5",
        codeLang: 'bash',
        points: [
          "df then du then find: narrow from filesystem to file.",
          "Check inodes as well as bytes.",
          "Deleted-but-open files hold space until the process closes them.",
          "`tail -F`, `grep -c`, awk with `sort | uniq -c`, `sed -n` ranges.",
          "Permissions: owner, group, mode, and directory execute bit."
        ],
        followups: [
          "How would you stop this from recurring?",
          "What does `-xdev` protect you from?"
        ],
        pitfalls: [
          "Running `du` from `/` across mounts.",
          "Deleting log files that a running process still writes to."
        ]
      },
      {
        id: 'platform-27',
        topic: 'cron, systemd, ssh',
        level: 1,
        q: "Explain how you would run a nightly sync of finished scan files to an archive host on Linux: the transport, the scheduler, and the pitfalls of cron.",
        a: "**Transport**: `rsync -a --partial` over ssh copies only what changed, can resume after a drop, and preserves metadata. `scp` is fine for one file but has no delta or resume. Use key-based auth with a dedicated key for the service account, not a password; `--dry-run` before the first real run; be careful with `--delete`; `--bwlimit` protects shared links. A trailing slash on the source means copy the contents, not the directory.\n\n**cron**: simple, but runs with a minimal environment and no terminal. Use absolute paths, redirect output to a log (otherwise it is mailed or lost), wrap in `flock -n` so a slow run does not overlap the next, and remember it does not retry or catch up after downtime. Time zones and daylight-saving changes can skip or repeat a run.\n\n**systemd timers** are the modern alternative: `OnCalendar=` schedules, `Persistent=true` runs a missed schedule after boot, logs go to the journal (`journalctl -u`), and dependencies and restart policies are built in.",
        code: "# crontab -e : nightly at 02:00, never overlapping, with a log\n0 2 * * * flock -n /var/lock/scan-sync.lock rsync -a --partial -e \"ssh -i /home/svc/.ssh/id_archive\" /data/finished/ svc@archive01:/archive/scans/ >> /var/log/scan-sync.log 2>&1\n\n# systemd equivalents for checking a timer-based version\nsystemctl list-timers --all\nsystemctl status scan-sync.service\njournalctl -u scan-sync.service --since today",
        codeLang: 'bash',
        points: [
          "rsync over ssh: delta, resume, key-based auth.",
          "cron has a minimal environment; use absolute paths and log output.",
          "`flock` prevents overlapping runs.",
          "systemd timers add catch-up (`Persistent=true`) and journal logging.",
          "Dry-run first; be careful with `--delete`."
        ],
        followups: [
          "How do you verify the copy is complete and not truncated?"
        ],
        pitfalls: [
          "Relying on a PATH that exists only in your interactive shell.",
          "Syncing files that the scanner is still writing."
        ]
      },
      {
        id: 'platform-28',
        topic: 'PowerShell basics',
        level: 1,
        q: "Give PowerShell equivalents for: find the 10 largest files, tail a log, grep for errors, list services that should be running but are not, check a scheduled task, and test a share path.",
        a: "PowerShell pipes **objects**, not text, so you filter and sort on properties instead of parsing columns.\n\nMapping from Linux habits:\n\n- `find` or `ls` becomes `Get-ChildItem -Recurse -File`, then `Sort-Object Length`.\n- `tail -f` becomes `Get-Content -Tail 50 -Wait`.\n- `grep` becomes `Select-String`.\n- `ps` becomes `Get-Process`; services are `Get-Service`.\n- Scheduled tasks (the Windows counterpart of cron) are `Get-ScheduledTask`, and `Get-ScheduledTaskInfo` shows the last run time and result code.\n- `Test-Path` works on UNC paths.\n\nVersion notes: Windows ships Windows PowerShell 5.1, while PowerShell 7 is a separate cross-platform install. Default text encodings differ: in 5.1, `Out-File` and `>` write UTF-16LE and `Get-Content` reads BOM-less files as ANSI, while 7 defaults to UTF-8 without BOM. Set `-Encoding` explicitly in scripts that exchange files with Linux tools.",
        code: String.raw`# 10 largest files
Get-ChildItem D:\scans -Recurse -File |
  Sort-Object Length -Descending |
  Select-Object -First 10 FullName, @{n='GB'; e={[math]::Round($_.Length / 1GB, 2)}}

# tail -f
Get-Content D:\logs\scan-agent.log -Tail 50 -Wait

# grep
Select-String -Path D:\logs\*.log -Pattern 'ERROR' | Select-Object -Last 20

# automatic services that are not running
Get-Service | Where-Object { $_.StartType -eq 'Automatic' -and $_.Status -ne 'Running' }

# top memory users
Get-Process | Sort-Object WS -Descending |
  Select-Object -First 5 Name, Id, @{n='MB'; e={[int]($_.WS / 1MB)}}

# scheduled task: last run time and result
Get-ScheduledTask -TaskName 'ExportManifest' | Get-ScheduledTaskInfo

# share reachable? free space on local drives
Test-Path \\scanfs01\drop\incoming
Get-PSDrive -PSProvider FileSystem`,
        codeLang: 'text',
        points: [
          "Objects in the pipeline: filter and sort by property.",
          "`Get-Content -Wait` is tail -f; `Select-String` is grep.",
          "`Get-Service` and `Get-ScheduledTask` replace systemctl and crontab checks.",
          "`Test-Path` accepts UNC paths.",
          "5.1 versus 7 differ in default encoding."
        ],
        followups: [
          "How would you run one of these across 20 machines?"
        ],
        pitfalls: [
          "Parsing PowerShell output as text.",
          "Writing files with the default encoding and breaking a Linux consumer."
        ]
      },
      {
        id: 'platform-29',
        topic: 'Windows shares, SMB',
        level: 2,
        q: "A scanner workstation writes finished slides to a Windows file share and your pipeline picks them up. What goes wrong with SMB shares, UNC paths and file arrival, and how do you design the pickup? What about line endings in manifests?",
        a: "Typical failure modes:\n\n- **Partial files**: a slide is visible while still being written. Pick up only after a completion signal: the scanner writes under a temporary name and renames, or writes a manifest or sidecar last, or you require the file size to be stable across two polls.\n- **Locked files** (sharing violations) if you read too early.\n- **Mapped drives** such as `Z:` exist per logon session, so a service or scheduled task cannot see them. Use the UNC path `\\\\server\\share\\dir`.\n- **Identity**: the task runs as a different account than you. Use a dedicated service or managed service account with read-only (or read and delete) access on that one share.\n- **Path limits** of 260 characters unless long paths are enabled, and case-insensitive names.\n\nFrom Linux, mount with CIFS using a credentials file (mode 600) and an explicit SMB version, or copy with `robocopy` on Windows (`/R:3 /W:5 /MT`).\n\n**Line endings and encoding**: Windows tools write CRLF and sometimes a UTF-8 BOM. A BOM can corrupt the first column name when parsed as plain UTF-8 (read with `utf-8-sig`). A shell script with CRLF fails with a `bad interpreter` error. Enforce LF in the repository with `.gitattributes`.",
        points: [
          "Detect completion with a rename, sidecar or stable size.",
          "Mapped drive letters are not visible to services; use UNC paths.",
          "Dedicated least-privilege service account for the share.",
          "Know the 260-character path limit.",
          "Handle CRLF and BOM; normalize with `.gitattributes`."
        ],
        followups: [
          "How do you avoid reprocessing the same file after a restart?",
          "What changes if the scanner can only push over a slow WAN link?"
        ],
        pitfalls: [
          "Polling for files and ingesting them half-written.",
          "Running the pickup as a personal account that later expires."
        ]
      },
      {
        id: 'platform-30',
        topic: 'Secrets, least privilege',
        level: 3,
        q: "Outline how you would handle secrets and least privilege for a clinical data platform: the pipelines, the humans, and the image data itself.",
        a: "**Secrets**: none in repositories, images, DAG code or env files. Store them in a secret manager and read them at run time (Composer, for example, can use Secret Manager as the backend for Airflow connections and variables). Prefer **workload identity** and short-lived credentials over keys; rotate whatever must remain; add secret scanning to CI and pre-commit.\n\n**Pipelines**: one dedicated service account per pipeline, with grants at the narrowest resource (read on one landing bucket, write on one dataset) and never a broad project-level editor role. Separate the deploy identity from the runtime identity.\n\n**Humans**: SSO and groups, no shared accounts, time-bound elevation with an approval trail, and a monitored break-glass path.\n\n**Data**: separate identifiable from de-identified tiers. Slide label images and filenames can carry names or accession numbers, so strip or blur them before analytics use. Give analysts views with column and row restrictions. Encrypt at rest and in transit, keep traffic on private endpoints, and enable data-access audit logs with alerts on unusual reads.\n\n**Hygiene**: do not log identifiers or signed URLs. Align specifics with your compliance team.",
        points: [
          "Secret manager plus workload identity; no keys in code or images.",
          "One narrowly scoped service account per pipeline.",
          "Humans use SSO, groups and time-bound elevation.",
          "Separate identifiable and de-identified data; scrub label images.",
          "Audit logs, private networking, and no identifiers in logs."
        ],
        followups: [
          "How do you give a researcher access to 500 slides for one week?",
          "How would you detect a service account being used from an unexpected place?"
        ],
        pitfalls: [
          "One shared super-privileged pipeline account.",
          "Forgetting that slide labels and file names are identifiers."
        ]
      }
    ],
    glossary: [
      { term: 'Logical date', def: "In Airflow, the timestamp that labels a run; for scheduled runs it is the start of the data interval. Called `execution_date` before Airflow 2.2." },
      { term: 'Idempotent task', def: "A task whose repeated runs with the same inputs leave the same end state, so retries and backfills are safe." },
      { term: 'Deferrable operator', def: "An Airflow operator that hands its wait to the triggerer process, freeing the worker slot until the condition is met." },
      { term: 'OOMKilled', def: "A container status meaning the kernel killed it for exceeding its memory limit; exit code 137." },
      { term: 'Configuration drift', def: "A gap between what infrastructure code says and what actually exists, usually caused by manual changes." },
      { term: 'Data contract', def: "A versioned agreement between a data producer and consumer covering schema, semantics, freshness and change process." },
      { term: 'Workload identity', def: "Letting a pipeline or pod act as a cloud identity via short-lived tokens, so no long-lived key is stored." }
    ]
  });
})();
