/* System design scenarios. Plain data, loaded by the page and the tests. */
(function () {
  'use strict';
  var list = (globalThis.TT_SCENARIOS = globalThis.TT_SCENARIOS || []);

  /* ------------------------------------------------------------------ sd-01 */
  list.push({
    id: 'sd-01',
    title: 'Scanner-to-cloud ingestion',
    level: 2,
    minutes: 45,
    prompt: "Three lab sites each run several whole-slide scanners. Scanners write slide files to local lab file shares. Design the path that gets every slide into cloud object storage reliably, with metadata, checksums and quality checks, and publishes one event per slide that other systems can react to.\n\nThe lab cannot lose a slide, cannot rescan because the pipeline dropped a file, and cannot tolerate the pipeline slowing down the scanners or saturating the site network.",
    clarify: [
      "Which scanners and file formats (`.svs`, `.ndpi`, `.mrxs`, DICOM WSI)? Is any format a folder of files rather than one file?",
      "Does the scanner give a completion signal, or do we only see files appearing on a share?",
      "How do we get from a file to a case: barcode on the slide, accession number in the filename, or a lookup against the lab system?",
      "What is the uplink per site, and is it shared with clinical traffic?",
      "Who consumes the slide after landing (viewer, inference, researchers) and what latency do they expect?",
      "What must happen to a slide that fails QC: block it, flag it, or request a rescan?",
      "Retention and residency rules for the raw files (region, encryption, who may read)?",
      "Do we need to keep the original file byte-for-byte, or may we convert to DICOM on the way in?"
    ],
    assumptions: [
      "Illustrative numbers: 3 sites, 12 scanners, about 2,000 slides/day total, average 1.5 GB per slide compressed at 40x (range 0.5-3 GB).",
      "That is about 3 TB/day, or roughly 35 MB/s averaged over 24 hours, but scans cluster: assume peaks of about 4x the average (roughly 140 MB/s across all sites, 40-50 MB/s per site) for an hour or two after the morning batch.",
      "Each site has a 1 Gbps uplink (about 110 MB/s usable) shared with other lab traffic; we cap ingest at about 60% of it.",
      "Formats are mostly `.svs` and `.ndpi` (single TIFF-like files) plus some `.mrxs` (an index file plus a data folder).",
      "Slide barcode matches an accession and block in the lab system; about 1-2% of slides arrive with a missing or unreadable barcode.",
      "Object storage is a single cloud provider with versioning, encryption at rest and object-created notifications."
    ],
    nodes: [
      { id: 'scan', label: 'Scanners (3 sites)', col: 0, note: 'Write slide files to the local share.' },
      { id: 'share', label: 'Lab file shares', col: 0, note: 'SMB/NFS; the buffer if the uplink is down.' },
      { id: 'agent', label: 'Site ingest agent', col: 1, note: 'Container per site: detect stable files, hash, upload.' },
      { id: 'land', label: 'Landing bucket', col: 2, note: 'Immutable raw copy, versioned, content-addressed keys.' },
      { id: 'quar', label: 'Quarantine bucket', col: 4, note: 'Failed or unmatched files wait here for a human.' },
      { id: 'qc', label: 'Validate + QC', col: 3, note: 'Autoscaled workers: parse header, verify checksum, cheap QC.' },
      { id: 'meta', label: 'Metadata + LIS join', col: 3, note: 'Extract dimensions, mpp, scanner; match barcode to case.' },
      { id: 'cur', label: 'Curated bucket', col: 4, note: 'Accepted slides, stable path, lifecycle rules attach here.' },
      { id: 'cat', label: 'Slide catalog (SQL)', col: 4, note: 'One row per slide version; state machine.' },
      { id: 'bus', label: 'Kafka slide.ready', col: 4, note: 'One event per accepted slide, via outbox.' },
      { id: 'view', label: 'Slide viewer', col: 5, note: 'Opens the slide from curated storage once ready.' },
      { id: 'inf', label: 'Inference trigger', col: 5, note: 'Starts model runs on new H&E slides.' },
      { id: 'wh', label: 'Warehouse load', col: 5, note: 'Catalog and events feed analytics.' }
    ],
    edges: [
      ['scan', 'share', 'SMB write'],
      ['share', 'agent', 'stable-file scan'],
      ['agent', 'land', 'multipart + SHA-256'],
      ['land', 'qc', 'object-created event'],
      ['qc', 'quar', 'fail'],
      ['qc', 'cur', 'pass: promote'],
      ['qc', 'meta', 'pass: read header'],
      ['meta', 'cat', 'upsert row'],
      ['cat', 'bus', 'outbox'],
      ['bus', 'view'],
      ['bus', 'inf'],
      ['bus', 'wh'],
      ['cur', 'view', 'read tiles']
    ],
    components: [
      { name: 'Site ingest agent', why: "A small container at each site that watches the share, decides a file is finished, hashes it while streaming the upload, and writes a manifest. Keeping it dumb and local means a cloud outage never touches the scanners." },
      { name: 'Landing and curated buckets', why: "Raw files land once and are never modified. Promotion to curated happens only after validation, so downstream readers never see half-checked data." },
      { name: 'Validation workers (Kubernetes)', why: "Docker images scaled on queue depth. They read the header, verify the checksum, run cheap QC and emit a pass or fail. Heavy image-quality scoring runs later so it cannot block ingestion." },
      { name: 'Slide catalog', why: "A relational table with one row per slide version and an explicit state (`landed`, `validated`, `unmatched`, `rejected`, `ready`). It is the system of record for 'where is this slide'." },
      { name: 'Event bus (Kafka)', why: "A `slide.ready` topic published from the catalog with an outbox pattern, so the database write and the event cannot disagree. Consumers decouple from ingestion." },
      { name: 'Quarantine and review queue', why: "Unreadable files, checksum mismatches and unmatched barcodes go here with a ticket for lab operations. Nothing is silently dropped." },
      { name: 'Airflow reconciliation DAG', why: "A daily run that compares share listings, bucket inventory and the catalog and reports slides that exist in one place but not another." },
      { name: 'CI/CD (GitHub Actions)', why: "Builds the agent and worker images, runs tests against a small synthetic slide set, and rolls out one site at a time with a fast rollback." },
      { name: 'Monitoring and alerts', why: "Backlog age on each share, upload throughput, quarantine count and time from scan end to `ready`. The share backlog is the earliest warning." }
    ],
    deepDives: [
      {
        q: "How do you know a slide file is finished writing before you upload it?",
        a: "Never trust that a filename appearing means the file is done. Scanners write in place and sometimes in stages.\n\n- Use a stability rule: size and modified time unchanged for a few minutes, with the wait longer than the poll interval.\n- Confirm the file opens and the header parses (TIFF-based formats can be read by OpenSlide or a TIFF library).\n- For `.mrxs`, treat the index file plus its data folder as one unit and wait for the whole set.\n- If the scanner software offers a completion marker or a database row, prefer that over guessing. Availability depends on the vendor and model.\n\nRecord the observed size and modified time in the manifest. If the file changes after upload, treat it as a new version rather than overwriting the old one."
      },
      {
        q: "A retry or a rescan means the same slide arrives twice. How do you keep the pipeline idempotent?",
        a: "Give every slide a stable identity: the slide ID from the lab system plus a content hash. Object keys include the hash, so uploading the same bytes twice is a no-op. The catalog has a unique key on slide ID and hash and uses upsert, so a retried validation task updates the same row.\n\nA rescan produces different bytes, so it is a new version of the same slide. The catalog records the version and marks the previous one superseded; the viewer shows the latest accepted version.\n\nEvents carry an `event_id` derived from slide ID, hash and version. Consumers dedupe on it, which makes at-least-once delivery safe. The rule to state out loud: every step must be safe to run twice."
      },
      {
        q: "How do you prove a file in the cloud is byte-identical to the file on the share?",
        a: "Compute SHA-256 on the agent while streaming the file (one read, no second pass) and write it to the manifest. Where the object store supports a client-supplied checksum on upload, send it so the store rejects corrupted parts.\n\nBe careful with ETags: for multipart uploads the ETag is generally not a plain MD5 of the whole object, and checksum support differs by provider, so check the provider's documentation rather than assuming.\n\nThe validator compares the stored checksum with the manifest. Reading every object back costs time and read charges, so verify everything cheaply via the store-verified checksum, and do a sampled full read-back plus periodic fixity audits on older data. Keep the manifest next to the object."
      },
      {
        q: "Peak scanning is several times the average and the uplink is shared with clinical traffic. How do you avoid hurting the site network?",
        a: "At about 2,000 slides/day the average is modest, but one site scanning 150 slides in an hour produces about 225 GB, roughly 60 MB/s. That is more than half of a 1 Gbps link before any clinical traffic.\n\n- Cap the agent at a fixed share of the uplink, with a lower cap during busy daytime hours if needed.\n- Use parallel multipart uploads with resumable parts so a dropped connection loses only a part.\n- Treat the lab share as the buffer. Size it to hold two to three days of scans so an outage is an inconvenience, not data loss.\n- Export backlog age and bytes pending per site, and alert when the oldest unuploaded slide passes a threshold.\n\nThe scanners never wait on the cloud; only the freshness of `ready` degrades."
      },
      {
        q: "What QC runs at ingestion and what runs later?",
        a: "Split by cost. Inline checks are cheap and structural: the file parses, expected pyramid levels exist, width, height and microns-per-pixel are present and plausible, compressed size sits in the expected band for that scanner, label and thumbnail images are present, checksum matches.\n\nImage-quality checks (focus, tissue coverage, stitching artifacts, pen marks) need pixels and models, so run them asynchronously and publish a quality score later. They flag slides for a possible rescan but do not block `ready`.\n\nA failing structural check sends the slide to quarantine and emits a `slide.rejected` event so the lab can rescan quickly. An unmatched barcode becomes an `unmatched` state routed to lab operations. Healthy slides never wait behind a slow or failing one."
      },
      {
        q: "How would you find out that a slide silently never made it?",
        a: "Do not rely on the happy path emitting an alarm; a missing file produces no event. Run a reconciliation DAG in Airflow each day that compares three listings: files on each share, objects in the buckets, and rows in the catalog.\n\nAlso compare against the lab system's expectations: slides ordered for a case versus slides scanned. Anything older than a threshold that exists in one list but not the next becomes an alert with the site, scanner and filename.\n\nThe reconciliation task writes its results to a table, so the count of unresolved items becomes a dashboard metric. A rising count is a pipeline bug; a stable small count is normal lab noise such as test scans."
      }
    ],
    tradeoffs: [
      { choice: 'Agent push vs cloud-side pull', pro: "Push from a site agent controls bandwidth, hashes at the source and needs no inbound firewall rule.", con: "You operate software at every site. Pull from the cloud is simpler to run but needs inbound access and cannot throttle locally." },
      { choice: 'Keep the raw file vs convert to DICOM on ingest', pro: "Keeping the original is lossless and simple, and keeps vendor-specific metadata.", con: "Converting up front gives one format for every consumer but costs compute, can lose proprietary metadata and must be validated." },
      { choice: 'Block on full QC vs mark ready fast', pro: "Marking ready after structural checks gets pathologists their slides sooner.", con: "Blocking on full QC prevents a bad slide reaching the viewer, at the price of slower turnaround and a larger blast radius when QC is slow." },
      { choice: 'Event-driven validation vs scheduled batch', pro: "Object-created events give near-immediate processing and natural scaling.", con: "A periodic sweep is easier to reason about and catches missed events; most systems need the sweep anyway." }
    ],
    rubric: [
      "Asked about file formats, completion signal and the barcode-to-case match before drawing.",
      "Stated sizes and rates with units, and said they are assumptions.",
      "Explained how a file is declared complete, including multi-file formats.",
      "Used content hashes for idempotency and described how a rescan differs from a retry.",
      "Covered checksum verification end to end, not just 'we check integrity'.",
      "Had a quarantine path with an owner; nothing is dropped silently.",
      "Handled bandwidth: caps, resumable upload, local buffer and backlog alerts.",
      "Used an outbox or equivalent so the catalog and events cannot diverge.",
      "Included reconciliation against the lab system and an independent listing.",
      "Mentioned how the agent and workers are tested, released and rolled back."
    ],
    redFlags: [
      "Uploading any file that appears in the folder with no stability check.",
      "No idempotency story: a retry creates duplicate slides or events.",
      "Relying on the object store's ETag as a universal checksum without checking.",
      "QC that blocks all ingestion when one check is slow.",
      "No way to detect a slide that never arrived."
    ]
  });

  /* ------------------------------------------------------------------ sd-02 */
  list.push({
    id: 'sd-02',
    title: 'Streaming ops dashboard plus nightly warehouse',
    level: 3,
    minutes: 45,
    prompt: "Operations wants a live dashboard of scan throughput and turnaround time per site, per scanner and per priority, fed by scanner events and by lab system messages (HL7 v2). Finance and quality teams want the same numbers in a warehouse, reconciled and trustworthy, rebuilt every night.\n\nDesign the hybrid: what runs in streaming, what runs in batch, and how you keep the two from telling different stories.",
    clarify: [
      "How fresh must the live dashboard be: seconds, a minute, five minutes? Who acts on it, and what do they do?",
      "Which lab messages matter (orders, patient/encounter updates, results) and which interface engine produces them?",
      "What is the exact definition of turnaround: received to scanned, scanned to signed out, calendar or business hours, rescans included?",
      "Can events arrive late or out of order? By how much, in the worst case?",
      "Which numbers must reconcile exactly with the lab system of record, and which may be approximate?",
      "Who owns metric definitions, and what is the process when a definition changes?",
      "Is any of this PHI-bearing on the dashboard, or can it be aggregated to counts and timings only?"
    ],
    assumptions: [
      "Illustrative: about 2,000 slides/day, roughly 8 scanner events per slide (queued, scan start, scan end, QC, upload, plus rescans, retries and status updates) = about 16,000 events/day.",
      "About 40,000 HL7 messages/day (orders, updates, results), peaking near 10 messages/second in the morning.",
      "Events average about 1 KB as JSON; Kafka retention 7 days, with every message also archived to object storage.",
      "Dashboard freshness target: p95 under 60 seconds end to end; nightly warehouse build finished by 05:30 local.",
      "Late arrivals are usually under 10 minutes, but a site outage can deliver hours of events at once.",
      "Warehouse is Snowflake or BigQuery; transformation in dbt; orchestration in Airflow (or Cloud Composer)."
    ],
    nodes: [
      { id: 'scn', label: 'Scanner events', col: 0, note: 'Start, end, QC and upload events per slide.' },
      { id: 'lis', label: 'Lab system (HL7 v2)', col: 0, note: 'Orders, patient updates and results.' },
      { id: 'gw', label: 'HL7 interface engine', col: 1, note: 'Receive, ACK, translate to canonical JSON.' },
      { id: 'kfk', label: 'Kafka topics', col: 1, note: 'Partitioned by accession; schema registry on every topic.' },
      { id: 'ss', label: 'Structured Streaming', col: 2, note: 'Watermark, dedupe on event_id, windowed aggregates.' },
      { id: 'raw', label: 'Raw event archive', col: 2, note: 'Immutable copy in object storage; the replay source.' },
      { id: 'hot', label: 'Hot aggregates store', col: 3, note: 'Low-latency store behind the live tiles.' },
      { id: 'stg', label: 'Staged tables', col: 3, note: 'Append-only parsed events for batch to read.' },
      { id: 'af', label: 'Airflow nightly DAG', col: 4, note: 'Load, build, test, reconcile, publish.' },
      { id: 'dbt', label: 'dbt models + tests', col: 4, note: 'Canonical turnaround definition lives here.' },
      { id: 'wh', label: 'Warehouse', col: 5, note: 'Reconciled facts and dimensions.' },
      { id: 'bi', label: 'BI dashboards', col: 5, note: 'Live tiles plus reconciled history.' },
      { id: 'rec', label: 'Reconciliation report', col: 5, note: 'Daily diff of live vs batch per site.' }
    ],
    edges: [
      ['scn', 'kfk', 'produce'],
      ['lis', 'gw', 'HL7 v2'],
      ['gw', 'kfk', 'canonical JSON'],
      ['kfk', 'ss', 'consume'],
      ['kfk', 'raw', 'sink connector'],
      ['ss', 'hot', 'upsert'],
      ['ss', 'stg', 'append'],
      ['raw', 'af', 'backfill source'],
      ['stg', 'af'],
      ['af', 'dbt', 'run + test'],
      ['dbt', 'wh'],
      ['hot', 'bi', 'live tiles'],
      ['wh', 'bi', 'reconciled'],
      ['wh', 'rec', 'batch side'],
      ['hot', 'rec', 'live side']
    ],
    components: [
      { name: 'HL7 interface engine', why: "Receives v2 messages, returns ACKs promptly so the lab system never stalls, and converts to a canonical JSON shape while keeping the raw message." },
      { name: 'Kafka with schema registry', why: "Durable, replayable log that decouples producers from both the streaming and batch paths. Compatibility rules on the registry catch breaking changes before they reach consumers." },
      { name: 'Spark Structured Streaming application', why: "Parses, dedupes, joins events to order data and maintains windowed aggregates. Runs as a long-lived container with a checkpoint; restarts pick up where they stopped." },
      { name: 'Raw archive in object storage', why: "Every message, unmodified. It is the source for backfills and the proof when two numbers disagree." },
      { name: 'Hot aggregates store', why: "Holds only what the live tiles need (counts and percentiles by window) so dashboard queries are fast and cheap, independent of warehouse load." },
      { name: 'Airflow nightly DAG', why: "Sequences load, dbt run, dbt tests and the reconciliation step, with retries and a clear failure owner." },
      { name: 'dbt models and tests', why: "One governed definition of turnaround and throughput, with tests for uniqueness, not-null, accepted values and relationships." },
      { name: 'Warehouse', why: "Reconciled, history-preserving tables for finance and quality. The source of truth for reported numbers." },
      { name: 'Reconciliation report', why: "A table of per-day, per-site differences between streaming and batch, so drift is measured instead of argued about." },
      { name: 'CI/CD', why: "Pull requests run dbt tests on a small fixture, unit tests for parsers, and a replay of recorded HL7 samples through the streaming code before merge." }
    ],
    deepDives: [
      {
        q: "Events arrive late and out of order. How does the streaming path stay correct?",
        a: "Work in event time, not arrival time. In Structured Streaming set a watermark (say 10 minutes) so windows close and state is bounded. For dedupe, `dropDuplicates` must include the event-time column alongside `event_id` for the watermark to purge its state (or use `dropDuplicatesWithinWatermark` in Spark 3.5+); `dropDuplicates` on `event_id` alone keeps state forever.\n\nEvents later than the watermark are not lost: they are still appended to the staged table and the raw archive. The live tiles may be slightly off for that window, and the nightly batch recomputes it correctly.\n\nBe explicit with users: the live dashboard is 'right now, approximately' and carries an as-of timestamp; the warehouse is 'what happened, reconciled'. A site outage that delivers hours of old events is exactly why batch is the arbiter."
      },
      {
        q: "What makes HL7 v2 awkward, and how do you handle it?",
        a: "HL7 v2 is pipe-delimited text with optional fields, repeating segments and site-specific extensions (Z segments). Two sites can send 'the same' message type with different conventions.\n\n- Preserve the raw message and parse to a canonical JSON; never drop unknown fields.\n- Use the message control ID (MSH-10) for dedupe, and ACK quickly so the sender does not retry.\n- Ordering across messages is not guaranteed, so key Kafka by accession and treat updates as upserts with a version or timestamp.\n- Put a quarantine topic behind the parser for messages that fail to parse, and alert on its rate.\n\nIf the organization is moving to FHIR, map v2 to FHIR resources at the interface engine; keep the raw message either way."
      },
      {
        q: "Can this pipeline be exactly-once?",
        a: "Be precise. Kafka and a checkpointed Structured Streaming query give you replay after a failure, which means a batch of events can be processed more than once. End-to-end exactly-once only holds if the sink is idempotent or transactional.\n\nDesign for at-least-once plus idempotent writes: the hot store upserts by a natural key (accession, slide, window), and staged tables dedupe on `event_id` in the batch model. A table format with ACID commits, or a `MERGE` keyed on `event_id`, makes re-processing harmless.\n\nWhat exactly-once guarantees apply to a specific connector or sink depend on its version and configuration, so check them rather than asserting them. State the principle: replays must not change the result."
      },
      {
        q: "Two teams report different turnaround numbers. How do you prevent that?",
        a: "Turnaround is a definition, not a calculation. Write it down: start timestamp (lab received or scan queued), end timestamp (scan end or sign-out), calendar versus business hours, whether rescans extend or restart the clock, how rush and stat are handled.\n\nPut the canonical version in one dbt model with tests and documentation. The streaming application implements the same logic for the live tiles, and a shared test fixture asserts both produce the same result on sample data.\n\nChanges to a definition go through review with the metric owner, are versioned, and are announced. The reconciliation report then measures any remaining gap, so the question becomes 'is the gap inside tolerance' instead of 'whose number is right'."
      },
      {
        q: "How does the nightly reconciliation work, and what happens when it fails?",
        a: "After dbt builds the day's facts, a reconciliation task compares them to the streaming aggregates for the same day, per site and per hour: slide counts, median and p95 turnaround, event counts by type.\n\nSet tolerances (for example 0.5% on counts, looser on percentiles), and classify differences: late events, duplicates, dropped messages, definition mismatch. Write the results to a table and fail the DAG with an alert if a tolerance is exceeded.\n\nBatch wins. If the live path was wrong, backfill it by replaying the raw archive through the same streaming code against a scratch target, compare, then correct. Record every incident, because repeated causes point to the real engineering fix."
      },
      {
        q: "A message format changes upstream without warning. What breaks, and how do you contain it?",
        a: "Without controls, a renamed field turns into nulls that quietly skew the dashboard. Controls, in layers:\n\n- A schema registry with compatibility rules on canonical topics, so incompatible producers are rejected at publish time.\n- Parsing at the edge into the canonical schema, with strict validation and a dead-letter topic for failures.\n- Contract tests in CI that replay recorded real messages through the parser.\n- Volume and null-rate monitors per field, so a sudden shift pages someone.\n\nWhen the schema evolves, version it, support both versions in the streaming application for a transition window, and upcast old messages on replay. The raw archive means a parser fix can be applied retroactively."
      }
    ],
    tradeoffs: [
      { choice: 'Streaming for everything vs hybrid', pro: "One code path and fresh numbers everywhere.", con: "Streaming everything makes corrections and definition changes painful and costly. Hybrid keeps batch as the arbiter while streaming serves operations." },
      { choice: 'Structured Streaming vs a lighter consumer service', pro: "Spark gives windows, watermarks, joins and scale with one API, and shares skills with the batch code.", con: "At about 10 messages/second a small consumer service is cheaper and simpler to run; Spark pays off as joins and volume grow." },
      { choice: 'Separate hot store vs query the warehouse directly', pro: "A hot store gives sub-minute tiles that do not compete with analyst queries.", con: "It is another system to run and another place for numbers to differ; a warehouse with streaming ingestion may be enough at this volume." },
      { choice: 'Replay from Kafka vs from the raw archive', pro: "Kafka replay is fast and simple within retention.", con: "The archive goes back indefinitely and survives topic changes, at the cost of slower reads and extra plumbing." }
    ],
    rubric: [
      "Separated what needs seconds from what needs correctness, and said why both exist.",
      "Pinned down the turnaround definition before building anything.",
      "Described event time, watermarks and what happens to late data.",
      "Dealt with HL7 specifics: ACKs, control IDs, ordering, site quirks, raw preservation.",
      "Was precise about delivery guarantees: at-least-once plus idempotent sinks.",
      "Designed reconciliation as a measured, automated step with tolerances.",
      "Kept an immutable raw archive and used it for backfill and replay.",
      "Covered schema evolution with a registry, quarantine and contract tests.",
      "Placed tests in dbt and CI, and named the failure owner for the nightly run.",
      "Sized the system with numbers and noted it is modest enough for simple tools."
    ],
    redFlags: [
      "Claiming exactly-once without describing the sink.",
      "Two separately written definitions of the same metric.",
      "No plan for late or replayed data, so the dashboard is silently wrong after an outage.",
      "Dropping unparseable messages instead of quarantining them.",
      "No measurement of how far live and batch numbers differ."
    ]
  });

  /* ------------------------------------------------------------------ sd-03 */
  list.push({
    id: 'sd-03',
    title: 'AI inference platform for new slides',
    level: 3,
    minutes: 45,
    prompt: "Several image-analysis models (tissue detection, tumor-region segmentation, cell counting and others) must run on every new H&E slide within N minutes of it becoming ready. Results must appear as overlays in the slide viewer and as structured values available to the report.\n\nDesign the platform: how work is scheduled onto GPUs, how model versions are managed, and how every result can be traced back to exactly what produced it.",
    clarify: [
      "What is N, and is it a target for the median or a hard limit for the slowest slide? What happens when we miss it?",
      "Which models run on every slide, which only on certain stains, specimen types or on request?",
      "Are these models used in clinical decisions (regulated, locked versions) or research (faster iteration)? That changes the promotion process.",
      "How are results consumed: viewer overlays, a structured report field, a worklist flag, downstream analytics?",
      "What are the model input requirements: magnification, tile size, color normalization, tissue mask?",
      "Who owns each model, and how often do they release new versions?",
      "Should old slides be reprocessed when a model improves? At what scale and priority?",
      "What failure is acceptable: a missing overlay, or a wrong one?"
    ],
    assumptions: [
      "Illustrative: about 1,500 H&E slides/day, 5 models per slide, target: results within 30 minutes of `slide.ready` (p95).",
      "A slide is about 100,000 x 80,000 px at 40x. At 20x with 256 px tiles that is about 30,000 tiles; after tissue detection keep about 40%, so roughly 12,000 tiles per model run.",
      "Per slide: 12,000 tiles x 5 models = 60,000 tile inferences. At an assumed 400 tiles/second per GPU per model, that is about 150 GPU-seconds per slide.",
      "Daily load: 1,500 x 150 s is about 62 GPU-hours. A morning burst of about 300 slides/hour needs about 12-13 busy GPUs, so provision about 16 at peak with autoscaling.",
      "Models are packaged as container images with pinned weights; there are 2-3 versions in play at once (production, shadow, proposed).",
      "Reading tiles from object storage is often the real bottleneck, not GPU math."
    ],
    nodes: [
      { id: 'ready', label: 'Kafka slide.ready', col: 0, note: 'New slide events from ingestion.' },
      { id: 'reg', label: 'Model registry', col: 0, note: 'Versions, image digests, metadata and status.' },
      { id: 'router', label: 'Inference router', col: 1, note: 'Pick models per slide, build run plan, dedupe.' },
      { id: 'queue', label: 'Priority queues', col: 1, note: 'Stat and rush ahead of routine and reprocessing.' },
      { id: 'cache', label: 'Tile cache (NVMe)', col: 3, note: 'Local copy of tissue tiles shared across models.' },
      { id: 'cpu', label: 'CPU prep + post', col: 2, note: 'Tissue mask, tiling, stitching, vectorizing results.' },
      { id: 'gpu', label: 'GPU worker pool', col: 3, note: 'Kubernetes node pool; one image per model version.' },
      { id: 'out', label: 'Results store', col: 4, note: 'Overlays and scalar results, keyed by run.' },
      { id: 'prov', label: 'Provenance log', col: 4, note: 'Slide hash, model digest, params, timings.' },
      { id: 'viewer', label: 'Viewer overlays', col: 5, note: 'Served beside the slide, toggled by the user.' },
      { id: 'report', label: 'Report + worklist', col: 5, note: 'Structured values written back to lab systems.' },
      { id: 'mon', label: 'Monitoring', col: 5, note: 'Latency, GPU use, failure rate, output drift.' }
    ],
    edges: [
      ['ready', 'router', 'consume'],
      ['reg', 'router', 'which versions'],
      ['router', 'queue', 'run plan'],
      ['queue', 'cpu', 'task'],
      ['cpu', 'cache', 'tiles'],
      ['cache', 'gpu', 'batches'],
      ['queue', 'gpu', 'GPU task'],
      ['gpu', 'out', 'predictions'],
      ['cpu', 'out', 'post-processed'],
      ['gpu', 'prov'],
      ['out', 'viewer', 'overlays'],
      ['out', 'report', 'values'],
      ['out', 'mon'],
      ['prov', 'mon']
    ],
    components: [
      { name: 'Inference router', why: "Decides which models apply to this slide (stain, specimen, request), creates a run plan, and refuses to schedule a run that already exists for the same slide hash and model version." },
      { name: 'Model registry', why: "The only way a model reaches production: immutable image digest, weights hash, input spec, owner, evaluation summary and a status such as proposed, shadow or production." },
      { name: 'Priority queues', why: "Separate lanes so stat and rush slides are never stuck behind a bulk reprocessing campaign; reprocessing runs on spare capacity." },
      { name: 'GPU worker pool on Kubernetes', why: "Containerized workers with a device plugin and a dedicated node pool; autoscaled by queue depth. Workers are stateless so a lost node means a retried task." },
      { name: 'CPU prep and post-processing', why: "Tissue masking, tiling and stitching are CPU work. Keeping them off GPU nodes stops expensive devices idling on I/O." },
      { name: 'Tile cache', why: "Several models read the same tiles; reading once from object storage and caching on local NVMe removes the dominant cost and delay." },
      { name: 'Results store', why: "Raster masks, vector annotations and scalar values, keyed by run ID, in formats the viewer already reads." },
      { name: 'Provenance log', why: "An append-only record per run: slide checksum, model digest, container image, preprocessing parameters, code commit, start and end times, outcome." },
      { name: 'Monitoring and drift checks', why: "Queue wait and time-to-result by priority, GPU utilization, error rate, and distributions of model outputs per scanner and day." },
      { name: 'CI/CD', why: "Model and worker images built and scanned in the pipeline; promotion requires a passing regression set run against a fixed slide panel." }
    ],
    deepDives: [
      {
        q: "How do you schedule work on GPUs so the 30-minute target holds at peak?",
        a: "Think in GPU-seconds. About 150 per slide and a burst of about 300 slides/hour means roughly 12-13 GPUs fully busy, so you need headroom and autoscaling.\n\n- Split each slide into tasks (per model, sometimes per tile range) so a big slide parallelizes and failures retry cheaply.\n- Batch tiles per GPU call; throughput depends heavily on batch size.\n- Keep GPU nodes in a dedicated Kubernetes pool with the vendor device plugin and scale on queue wait, not CPU.\n- Priority classes: stat first, then rush, then routine, then reprocessing, with preemption for the lowest lane only if tasks checkpoint.\n\nCapacity is the whole answer only if I/O keeps up, which is why prep and cache sit in front of the GPUs."
      },
      {
        q: "How do you roll out a new model version safely?",
        a: "The registry holds each version as an immutable image digest plus weights hash. The lifecycle: proposed, shadow, production, retired.\n\n- Shadow: run the new version on live slides, store results, show nothing; compare against production on agreement metrics and failure rate.\n- Evaluate on a fixed, reviewed slide panel in CI before any promotion; keep the panel versioned and never train on it.\n- Promote by changing the router's configuration, not by redeploying; roll back the same way.\n- Pin the version per run so a slide's result never silently changes.\n\nFor models used in clinical decisions, promotion needs documented validation and sign-off by the owner; the registry should record who approved what and when."
      },
      {
        q: "What does 'provenance' mean here and why store it?",
        a: "Provenance answers: exactly what produced this overlay? For each run, store the slide's content hash and version, model image digest and weights hash, preprocessing parameters (magnification, tile size, normalization), code commit, start and end time, hardware class, and outcome.\n\nIt matters in three situations: a pathologist questions a result, a bug is found in version 2.3 and you must list every affected slide, or a regulator or auditor asks how a number was produced. With provenance, 'find every result from the bad version' is a query rather than a project.\n\nStore it append-only, separate from results so results can be regenerated, and expose the run ID in the viewer so a user can report it."
      },
      {
        q: "Tasks time out, GPUs fail, and the same slide may be requested twice. How do you make this robust?",
        a: "Use an idempotency key of slide hash plus model version (plus parameters). The router checks the results store before scheduling; a duplicate returns the existing run.\n\nTasks are small and stateless, so retries are cheap: bounded retries with backoff, then a dead-letter lane and an alert, never an infinite loop on a poison slide.\n\nHandle partial results explicitly: a run is `complete` only when all tiles have written outputs; the viewer shows only complete runs and says 'still running' otherwise. Use timeouts per task and per slide; on timeout publish a `timeout` result rather than nothing, so downstream knows to stop waiting.\n\nDrain GPU nodes gracefully on upgrades so in-flight tasks finish or requeue."
      },
      {
        q: "How do results get back to the viewer and the report, and what format?",
        a: "Keep the viewer and report paths separate from the compute path, reading from the results store.\n\n- Overlays: raster masks as tiled images or vector annotations (polygons) at slide coordinates, served by the same service as the slide. DICOM-based setups can store results as DICOM objects through DICOMweb (STOW-RS); the exact object types supported depend on the viewer and archive.\n- Structured values (counts, scores, percentages): a small table keyed by slide and run, written to the lab system or report as a result, for example via an HL7 or FHIR message, as the lab's integration supports.\n\nEvery displayed result shows model name, version and time. If a newer run supersedes an older one, show the newer and keep the older retrievable."
      },
      {
        q: "A model improves. How do you reprocess a year of slides without hurting live work?",
        a: "A year at 1,500 slides/day is about 550,000 slides. Rerunning one improved model costs about 30 GPU-seconds per slide (its share of the 150), so about 4,600 GPU-hours; rerunning all five models is about 23,000 GPU-hours, before CPU tiling and restores from cold storage. Treat it as a campaign, not a burst.\n\n- Submit to the lowest-priority queue with a rate cap, so live work always wins.\n- Use spot or preemptible GPUs where tasks are short and retriable.\n- Pre-stage data: slides in cold storage need rehydration, so schedule by cohort and batch the restores.\n- Write results as a new version, then flip the 'current' pointer per slide after validation.\n- Track progress and cost per campaign; set a budget and stop condition.\n\nCheck whether the improvement justifies the cost before starting; sometimes only the slides that matter (open cases, a research cohort) need new results."
      }
    ],
    tradeoffs: [
      { choice: 'Run every model on every slide vs on demand', pro: "Results are ready when the pathologist opens the case; no waiting.", con: "On-demand saves most of the compute but adds latency at the moment of use. A hybrid runs the common models eagerly and the rest on request." },
      { choice: 'One shared GPU pool vs per-model pools', pro: "Shared pools use hardware better and simplify capacity planning.", con: "Per-model pools isolate noisy or unstable models and simplify different hardware needs, but fragment capacity." },
      { choice: 'Tile-level tasks vs one task per slide', pro: "Small tasks retry cheaply and parallelize one large slide across GPUs.", con: "One task per slide is simpler and keeps all tiles on one node, but a failure at 90% repeats all the work." },
      { choice: 'Cloud GPUs on demand vs owned hardware', pro: "On-demand scales to the burst and to reprocessing campaigns.", con: "Owned GPUs are cheaper at steady load and avoid egress; the peak-to-average ratio decides." }
    ],
    rubric: [
      "Asked what N means and what the consequence of missing it is.",
      "Did a capacity estimate in tiles, GPU-seconds and GPUs, with stated assumptions.",
      "Recognized I/O and tiling as likely bottlenecks and designed a cache and CPU stage.",
      "Described GPU scheduling on Kubernetes: node pools, autoscaling, priority lanes.",
      "Treated model versions as immutable artifacts with a promotion path including shadow runs.",
      "Defined provenance concretely and tied it to questions it must answer.",
      "Made runs idempotent and handled timeouts, retries and partial results.",
      "Explained how overlays and structured values reach the viewer and the report.",
      "Raised reprocessing as a separate, rate-limited workload.",
      "Distinguished research use from clinical use in validation and sign-off."
    ],
    redFlags: [
      "Sizing GPUs from average load only, ignoring the morning burst.",
      "Models referred to by 'latest' tag, so results cannot be traced.",
      "No idempotency; a duplicate event reruns everything.",
      "Overlays shown without saying which model version produced them.",
      "Reprocessing competing with live slides in the same queue."
    ]
  });

  /* ------------------------------------------------------------------ sd-04 */
  list.push({
    id: 'sd-04',
    title: 'De-identified research data mart',
    level: 3,
    minutes: 45,
    prompt: "Researchers want a governed dataset of whole-slide images joined with clinical data (diagnoses, stage, treatment, outcomes) that is de-identified, so they can build cohorts and train models without touching protected health information.\n\nDesign the pipeline and the access model. Cover linkage across sources, scrubbing of the images themselves, audit, and how you control the risk of someone re-identifying a patient.",
    clarify: [
      "What is the governing basis for each use: approved protocol, data use agreement, or a broader research repository? Who approves a cohort?",
      "Which de-identification standard applies: the 18 identifiers rule (Safe Harbor) or a statistician's determination of very small risk?",
      "Do researchers ever need to re-contact or re-link to a patient (a coded dataset with an honest broker) or is it irreversible?",
      "Which dates must be preserved, as offsets or intervals, for survival and time-to-event analysis?",
      "What clinical sources feed this: lab system, EHR extracts, cancer registry, genomics? Do they share a patient key?",
      "Where do slide labels, barcodes and handwriting appear in the image files and their metadata?",
      "How do patient opt-outs and withdrawals of consent propagate into existing releases?",
      "Where may researchers work: only inside a controlled workspace, or may data leave the environment?"
    ],
    assumptions: [
      "Illustrative: the mart covers about 20,000 patients and 50,000 slides at about 1.5 GB each, which is roughly 75 TB of images; clinical data is under 1 GB.",
      "Refreshed weekly; new cohorts are requested a few times a month and each cohort is typically 500-5,000 patients.",
      "De-identification follows an agreed standard chosen by the privacy office, and the design supports either. Under expert determination dates are shifted per patient by a consistent random offset; under Safe Harbor only years remain.",
      "Patient tokens are generated with a keyed hash (HMAC) whose secret lives in a key management service and is available only to the linkage service.",
      "A minimum cell size (for example 10) is enforced for any aggregate released from the workspace; the exact threshold is a policy decision.",
      "Warehouse is Snowflake or BigQuery with column-level policies; images remain in object storage and are read in place."
    ],
    nodes: [
      { id: 'src', label: 'Clinical sources', col: 0, note: 'LIS, EHR extracts and registry data with PHI.' },
      { id: 'arch', label: 'Slide archive', col: 0, note: 'Original files with labels and vendor metadata.' },
      { id: 'zone', label: 'Restricted PHI zone', col: 1, note: 'Locked-down staging; very few people have access.' },
      { id: 'link', label: 'Linkage service', col: 2, note: 'Keyed-hash tokens, per-patient date offsets.' },
      { id: 'deid', label: 'De-id pipeline', col: 3, note: 'Spark on Kubernetes; scrub fields, dates, free text.' },
      { id: 'scrub', label: 'Image label scrubber', col: 3, note: 'Strip label and macro images and identifying tags.' },
      { id: 'mart', label: 'Governed data mart', col: 4, note: 'De-identified tables with column policies.' },
      { id: 'imgs', label: 'De-id image store', col: 4, note: 'Scrubbed copies under new keys.' },
      { id: 'audit', label: 'Audit log', col: 5, note: 'Who read what and when; tamper-evident.' },
      { id: 'broker', label: 'Cohort request portal', col: 5, note: 'Approval, risk review, time-limited grants.' },
      { id: 'work', label: 'Researcher workspace', col: 5, note: 'Notebooks next to the data; no raw export by default.' }
    ],
    edges: [
      ['src', 'zone', 'secured transfer'],
      ['arch', 'zone', 'copy + hash'],
      ['zone', 'link'],
      ['link', 'deid', 'tokens + offsets'],
      ['zone', 'scrub'],
      ['deid', 'mart', 'de-id rows'],
      ['scrub', 'imgs', 'clean copies'],
      ['link', 'mart', 'tokens only'],
      ['link', 'scrub', 'new slide keys'],
      ['mart', 'broker', 'cohort query'],
      ['imgs', 'work', 'read in place'],
      ['mart', 'work', 'masked views'],
      ['broker', 'audit', 'approvals'],
      ['mart', 'audit', 'access logs'],
      ['imgs', 'audit', 'access logs']
    ],
    components: [
      { name: 'Restricted PHI zone', why: "The only place identified data exists in this system. Separate account or project, private networking, no researcher access, and a small named group of operators." },
      { name: 'Linkage service', why: "Produces stable pseudonymous patient tokens (keyed hash, secret in a key service) and per-patient date offsets, so the same patient links across sources without exposing identifiers." },
      { name: 'De-identification pipeline', why: "Spark jobs on Kubernetes that drop or generalize identifiers, shift dates, bucket ages (collapsing ages over 89 into one 90-or-older group), and handle free text. Pipeline code is reviewed and tested like any production system." },
      { name: 'Image label scrubber', why: "Whole-slide files carry label and macro images, barcodes and vendor metadata that can contain names or accession numbers. This step removes them and writes new files under non-identifying keys." },
      { name: 'Governed data mart', why: "Warehouse tables with only de-identified columns, column-level policies and tags for sensitivity, and no tables joining back to the token map." },
      { name: 'Cohort request portal', why: "Researchers request a cohort; the privacy office or data steward approves, risk is reviewed, and access is granted for a time window." },
      { name: 'Researcher workspace', why: "Notebooks run next to the data. Results leave only through reviewed, aggregated outputs; this is the strongest control against re-identification." },
      { name: 'Audit log', why: "Append-only records of queries, image reads, approvals and exports, with retention and alerting for unusual patterns." },
      { name: 'Orchestration and tests', why: "Airflow runs the weekly refresh. dbt or SQL tests assert that no identifier columns exist and that small-cell rules hold; CI blocks releases that fail." }
    ],
    deepDives: [
      {
        q: "Safe Harbor versus expert determination: how does the choice change the design?",
        a: "Under US HIPAA there are two routes. Safe Harbor removes the 18 listed identifier types (including names, geographic units smaller than a state except a three-digit ZIP covering more than 20,000 people, all date elements except year, ages over 89, device and record identifiers, and full-face photographs) and requires no actual knowledge that remaining data could identify someone. Expert determination relies on a qualified expert, usually a statistician, documenting that the risk is very small.\n\nSafe Harbor is simple but strips dates to the year, and shifted dates are generally not treated as acceptable under it, which hurts time-to-event work. Expert determination allows shifted dates or richer geography but needs documented analysis and has conditions attached. The privacy office decides which applies; the pipeline should make the choice a configuration, not a rewrite. Check current guidance and your own policy."
      },
      {
        q: "How do you link a patient across the lab system, EHR extracts and the slide archive without exposing identifiers?",
        a: "Do linkage inside the restricted zone with an honest-broker pattern. The linkage service matches records on source identifiers (and fuzzy matching with human review for ambiguous pairs), then emits a token: an HMAC of a master patient identifier with a secret held in a key service. The same patient yields the same token everywhere; nobody downstream can reverse it.\n\nStore the token-to-identity map only in the restricted zone. Generate a separate per-patient random date offset and apply it to every date, so intervals are preserved.\n\nIf re-contact must be possible, that is a controlled, logged operation by the honest broker; researchers never hold the map. Rotate the secret by policy; rotation breaks continuity, so plan it deliberately."
      },
      {
        q: "How do you de-identify the slide files themselves?",
        a: "Slide files contain more than tissue. Check these places:\n\n- The label image (a photo of the slide label, often with printed name or barcode) and the macro image.\n- File metadata: TIFF and vendor tags, DICOM attributes (patient name, ID, dates, accession, institution, device serial), and embedded annotations.\n- Handwriting or pen marks on the slide, visible in the tissue image itself.\n\nProcess: remove or blank label and macro images, rewrite metadata to a whitelist of allowed fields, re-key the file with a random ID, then verify with automated checks (OCR on the remaining thumbnails, a scan for known identifier patterns) plus human sampling. Never rely on filename conventions. Keep the original untouched in the restricted zone."
      },
      {
        q: "Everything is 'de-identified'. How can a patient still be re-identified, and what do you do about it?",
        a: "Quasi-identifiers combine: rare diagnosis, small site, narrow age, treatment date, unusual specimen. A cohort of three patients with a rare tumor at one site is identifiable even with no names.\n\nControls:\n- Generalize at build time: age bands, region instead of site for small sites, coarsen rare codes.\n- Enforce minimum cell sizes for any output that leaves the workspace and for cohort counts shown in the portal.\n- Review cohorts that are narrow or that combine many sensitive attributes before granting access.\n- Contractual controls: no linkage attempts, no re-contact, no sharing.\n- Keep data inside the workspace so export is the only exit, and review exports.\n\nMeasure risk (k-anonymity checks on the release tables) instead of asserting it, and re-run on every refresh."
      },
      {
        q: "What do you log for audit, and how do you handle a patient who withdraws?",
        a: "Log who (user and role), what (tables, columns, cohort, image IDs), when, from where, and the outcome, plus approvals and exports. Ship logs to a store the data team cannot alter, with alerts for odd patterns: bulk image reads, off-hours access, an unusually wide cohort, repeated denied queries.\n\nWithdrawals: the linkage service keeps a suppression list keyed by token. The weekly refresh removes those patients from the mart and images. Past releases are harder: derived datasets and trained models cannot always be recalled, so the data use agreement should state what is required (stop future use, delete copies) and the audit log tells you which cohorts included the patient."
      }
    ],
    tradeoffs: [
      { choice: 'Reversible tokens vs irreversible de-identification', pro: "A token map held by an honest broker allows corrections, new data and, if consented, re-contact.", con: "Irreversible removal is safer if the map leaks and simpler to defend, but you cannot add follow-up data or fix linkage errors." },
      { choice: 'Shifted dates vs removing dates', pro: "Offsets preserve intervals (time to recurrence, survival) essential for outcomes research.", con: "Removing dates is the simplest and strongest option but limits the science; shifting needs a documented rationale." },
      { choice: 'In-environment workspace vs data export', pro: "A workspace keeps the data under audit and makes aggregated release the only exit.", con: "Export is convenient for researchers' own compute, but you lose control the moment data leaves." },
      { choice: 'One mart for all vs per-project extracts', pro: "A single governed mart is cheaper to maintain and audit, with consistent definitions.", con: "Per-project extracts apply minimum necessary data and expire cleanly, at the cost of more pipelines and drift between extracts." }
    ],
    rubric: [
      "Asked about governing approvals and the de-identification standard before designing.",
      "Isolated identified data in a restricted zone with few operators.",
      "Described pseudonymous linkage with keyed hashes, key custody and per-patient date offsets.",
      "Addressed the images: label and macro, vendor and DICOM metadata, handwriting, and verification.",
      "Handled free text and ages over 89 explicitly.",
      "Discussed re-identification risk beyond removing names: quasi-identifiers and small cells.",
      "Put controls in the access layer: workspace, review of exports, time-limited grants.",
      "Included audit logs and alerting, and an approach to withdrawals.",
      "Had automated tests that fail the build if identifiers appear.",
      "Treated legal or policy specifics as questions for the privacy office rather than asserting them."
    ],
    redFlags: [
      "Treating de-identification as 'drop the name column'.",
      "Using the patient's real MRN or a plain unsalted hash as a pseudonym.",
      "Ignoring the label image and metadata inside slide files.",
      "Researchers pulling raw extracts to their laptops by default.",
      "No audit trail, or an audit log the same team can edit."
    ]
  });

  /* ------------------------------------------------------------------ sd-05 */
  list.push({
    id: 'sd-05',
    title: 'Virtualization vs warehouse for analysts',
    level: 2,
    minutes: 35,
    prompt: "Analysts need one place to ask questions that span the lab system, EHR extracts, scanner logs and model outputs. The organization already runs a warehouse (Snowflake or BigQuery) and is evaluating a data virtualization layer (Denodo). Some sources are small and change constantly; others are large and append-only.\n\nDecide what to virtualize and what to land in the warehouse, how to give analysts a consistent semantic layer, and how to protect PHI throughout.",
    clarify: [
      "How fresh must each source be for the questions analysts actually ask: minutes, hours, next day?",
      "How large is each source, and how fast does it grow? Which need history preserved, not just the current state?",
      "How much load can each source system tolerate? Can an analyst's query hit the lab system directly, or only a replica?",
      "Which questions join across sources, and how big are the joins (a few lookups, or millions of rows each side)?",
      "Who are the consumers: BI tools, SQL users, notebooks, extracts to other systems?",
      "What PHI is present, who may see it, and does policy require the same person to see different data by purpose or site?",
      "What does the team already operate and have skills for, and what are the licensing and compute budgets?"
    ],
    assumptions: [
      "Illustrative: lab system holds about 5 million cases with about 100,000 changes/day; EHR extracts arrive nightly (about 2 GB/day).",
      "Scanner logs: about 16,000 events/day; model outputs: about 7,500 runs/day (1,500 slides x 5 models) with scalar results plus overlay metadata; both are append-only and small compared with images.",
      "About 150 analysts and 40 dashboards; peak concurrency about 30 queries; most questions need data no older than a few hours.",
      "The lab system's database can tolerate only light read load during working hours; a read replica exists but lags by minutes.",
      "Warehouse is Snowflake or BigQuery (the principles are the same); dbt builds models; BI is Tableau or Power BI.",
      "Patient identifiers appear in lab and EHR data; scanner logs and model outputs carry accession or slide IDs that join back to patients."
    ],
    nodes: [
      { id: 'lis', label: 'Lab system (LIS)', col: 0, note: 'Cases, orders, sign-out; changes all day.' },
      { id: 'ehr', label: 'EHR extracts', col: 0, note: 'Nightly files with clinical context.' },
      { id: 'sl', label: 'Scanner logs', col: 0, note: 'Append-only event stream.' },
      { id: 'ml', label: 'Model outputs', col: 0, note: 'Run results and scores per slide.' },
      { id: 'ing', label: 'Ingest (CDC + files)', col: 1, note: 'Land raw data with history on a schedule.' },
      { id: 'dbase', label: 'Denodo base views', col: 1, note: 'Connectors to sources that stay put.' },
      { id: 'wh', label: 'Warehouse core', col: 2, note: 'dbt-built, tested, history preserved.' },
      { id: 'dder', label: 'Denodo derived views', col: 2, note: 'Cross-source joins; caching where needed.' },
      { id: 'sem', label: 'Semantic layer', col: 3, note: 'Shared metric and dimension definitions.' },
      { id: 'pol', label: 'Masking + row policy', col: 3, note: 'PHI protected once, enforced everywhere.' },
      { id: 'bi', label: 'BI tools', col: 4, note: 'Dashboards and self-service.' },
      { id: 'sql', label: 'Analyst SQL', col: 4, note: 'Ad hoc queries on governed objects.' },
      { id: 'nb', label: 'Notebooks', col: 4, note: 'Exploration and model features.' }
    ],
    edges: [
      ['lis', 'ing', 'CDC from replica'],
      ['ehr', 'ing', 'nightly files'],
      ['sl', 'ing', 'stream to table'],
      ['ml', 'ing', 'append'],
      ['lis', 'dbase', 'replica lookups'],
      ['ing', 'wh', 'dbt models'],
      ['dbase', 'dder'],
      ['wh', 'dder', 'published as views'],
      ['wh', 'sem'],
      ['dder', 'sem'],
      ['sem', 'pol'],
      ['pol', 'bi'],
      ['pol', 'sql'],
      ['pol', 'nb']
    ],
    components: [
      { name: 'Warehouse core', why: "Where history, heavy joins and aggregate workloads live. Compute is elastic, cost is predictable, and dbt models give tested, versioned transformations." },
      { name: 'Ingestion layer', why: "Change data capture from a replica for the lab system, file loads for EHR extracts, and stream-to-table for scanner events. Raw data lands first, models come after." },
      { name: 'Denodo virtualization layer', why: "Base views connect to sources that should not be copied (or not yet), and derived views join across them. Caching can protect the source for repeated queries; capabilities and defaults depend on version and configuration." },
      { name: 'Semantic layer', why: "One definition of metrics (turnaround, scan volume, rescan rate) and dimensions (site, scanner, stain) so dashboards agree, whether built in the BI tool or in dbt." },
      { name: 'Central security policy', why: "Column masking for identifiers, row-level rules by site or purpose, and tokenization where needed, defined once and enforced in the layer all consumers pass through." },
      { name: 'Data catalog and lineage', why: "Analysts find certified datasets and see where each column comes from, including whether a view is virtual or materialized." },
      { name: 'Orchestration (Airflow)', why: "Schedules loads, runs dbt, refreshes caches and extracts, and alerts on failure." },
      { name: 'CI/CD', why: "Model and view definitions live in version control; GitHub Actions or Jenkins deploy them to environments with tests, so a change to a shared view cannot ship unreviewed." },
      { name: 'Usage and cost monitoring', why: "Tracks slow virtual views, source load, warehouse credits or bytes scanned, so the virtualize-versus-land decision is revisited with evidence." }
    ],
    deepDives: [
      {
        q: "What rule do you use to decide: virtualize a source or land it in the warehouse?",
        a: "Ask five questions per source and per query pattern:\n\n1. Volume: large scans and big joins belong in the warehouse, where compute scales and data is columnar.\n2. History: if analysts need point-in-time or trends, you must snapshot; a virtual view only shows now.\n3. Freshness: seconds-to-minutes on a small slice favors virtual access; hours is fine for loads.\n4. Source load and availability: if the source cannot take analytic queries, copy it.\n5. Join shape: a few lookups against a small virtual table push down well; a large cross-system join forces data to move at query time.\n\nDefault to landing and modeling anything central and large. Virtualize small, fast-changing reference data, sources you cannot copy for policy reasons, and prototypes before you commit to a pipeline."
      },
      {
        q: "How does a virtualization layer behave under a cross-source join, and what can go wrong?",
        a: "The engine plans the query, pushes filters, projections and sometimes aggregations down to each source, then joins the partial results itself. When pushdown works, it is fast. When it does not (unsupported function, mismatched types, join on a computed key), the engine pulls large row sets over the network and joins them in the middle.\n\nSymptoms: a dashboard that is fast with a filter and unusable without one; heavy load on the source; timeouts.\n\nMitigations: examine query plans in review; use caching or materialize hot derived views into the warehouse; set limits and workload management; test with production-sized data. Which optimizations apply depends on the product, version and source. Treat 'it works on the demo dataset' as untested."
      },
      {
        q: "How do you secure PHI consistently across both the warehouse and the virtual layer?",
        a: "Pick one place to define policy and make sure every path goes through it. Options: policies in the warehouse (masking and row access policies, column tags) with the virtual layer querying as a governed service identity; or policies in the virtualization layer with the warehouse reachable only through it. Mixed models are where holes appear.\n\n- Classify columns once (identifier, quasi-identifier, clinical, operational) and attach tags.\n- Mask or tokenize identifiers by default; unmask by purpose and role, logged.\n- Pass the real user identity to the query engine where possible, so audit shows who asked; shared service accounts hide that.\n- Least privilege: analysts see certified views, not raw tables.\n\nTest policies in CI with sample users and expected results."
      },
      {
        q: "How do you keep a metric like turnaround consistent across a virtual view, a warehouse model and three dashboards?",
        a: "Define it once, in code. The canonical logic is a dbt model (or a semantic-layer metric definition) with tests, and every consumer reads that object: the virtual layer exposes the same view; BI tools query it instead of re-deriving the calculation in a workbook.\n\nCertify datasets: a short list marked as the approved source, with an owner and a description of the definition. Everything else is labeled exploratory.\n\nWhen definitions change, version the object, announce it, and list the dashboards that depend on it through lineage. Periodically compare numbers from the semantic layer with an independent calculation on raw data. Duplicated logic is where disagreements come from."
      },
      {
        q: "How would you compare the cost of the two approaches?",
        a: "The costs fall in different places.\n\n- Warehouse: storage (cheap), ingestion engineering, and compute, billed by credits or by bytes scanned or slots depending on the platform. Costs grow with query volume and bad queries; clustering, partitioning and result caching help.\n- Virtualization: license or infrastructure for the layer, load on source systems, network transfer, and engineering time spent tuning pushdown. No pipeline to build, but every query pays at run time.\n\nBack-of-envelope: queries per day times average work. A heavily used virtual join that moves a million rows per query will cost more than materializing it nightly. Measure actual usage for a month, then move the top expensive virtual views into the warehouse. Prices change; use current numbers."
      }
    ],
    tradeoffs: [
      { choice: 'Virtualize vs land (per source)', pro: "Virtualization gives fresh data, no copy to secure or reconcile, and fast time to first answer.", con: "Landing gives history, scalable compute and isolation of source systems, but needs pipelines and lag." },
      { choice: 'Policy in the warehouse vs in the virtual layer', pro: "Warehouse-native policies apply to any tool that touches the data and stay close to it.", con: "A virtual-layer policy gives one control point across sources that never reach the warehouse, but only protects paths that go through it." },
      { choice: 'Cache virtual views vs materialize in the warehouse', pro: "Caching is quick to add and keeps one definition.", con: "Materializing gives history, versioning and warehouse-scale performance, at the cost of a pipeline and another copy." },
      { choice: 'Semantic layer in the BI tool vs in code', pro: "BI-native definitions are quick for analysts and fit the tool.", con: "Definitions in code are testable, reviewable and shared across tools, but require engineering involvement." }
    ],
    rubric: [
      "Compared sources on volume, history, freshness, source load and join shape.",
      "Landed the central, large, historical data and virtualized only where justified.",
      "Explained pushdown and its failure modes with the honest caveat that it depends on product and source.",
      "Protected the source systems: replica, caching, workload limits.",
      "Placed PHI policy in one authoritative place and considered user identity pass-through.",
      "Defined one semantic layer and certified datasets.",
      "Offered a cost comparison with real drivers on each side.",
      "Included testing and deployment of view and policy changes through CI/CD.",
      "Planned to revisit decisions from usage data."
    ],
    redFlags: [
      "Virtualizing everything and calling the warehouse unnecessary, or the reverse, with no per-source reasoning.",
      "Analysts pointed straight at the production lab database.",
      "PHI masking implemented separately in each BI tool.",
      "No answer for history: 'what did this look like last quarter?'",
      "Claiming a product feature as fact without noting it depends on version or configuration."
    ]
  });

  /* ------------------------------------------------------------------ sd-06 */
  list.push({
    id: 'sd-06',
    title: 'Petabyte slide storage lifecycle',
    level: 2,
    minutes: 35,
    prompt: "The slide archive grows by roughly a petabyte a year and the storage bill is now a line item people notice. Design hot, warm and cold tiers, retention and deletion rules, the process for bringing old slides back for reprocessing or review, and a cost model that tells leadership what each choice costs.\n\nNothing may be lost or deleted early, and a pathologist who reopens an old case must not wait hours.",
    clarify: [
      "What are the retention rules for diagnostic slides, research slides and test scans, and who owns them? Do they differ by jurisdiction or specimen type?",
      "How often are old slides reopened, and by whom (clinicians for comparisons, researchers, model retraining)? What delay is acceptable for each?",
      "Are there legal holds, audits or active studies that block deletion?",
      "What is the durability and availability requirement: single region, multi-region, offline copy?",
      "Can we recompress or convert formats, and who must validate that no clinical information is lost?",
      "Do access patterns follow cases (open cases are hot) or time (everything older than X is cold)?",
      "What is the budget envelope, and is egress or retrieval cost a concern?"
    ],
    assumptions: [
      "Illustrative: about 2,000 slides/day at 1.5 GB is about 3 TB/day, or about 1.1 PB/year; archive today about 3 PB.",
      "Retention for diagnostic slides assumed 10 years (policy-driven; yours may differ); two copies in separate failure domains.",
      "After 10 years that is about 11 PB per copy, 22 PB in total, so tiering decisions dominate cost.",
      "Rough price points for planning only (check current rates): hot about $23/TB-month, infrequent-access about $10-13/TB-month, archive about $1-4/TB-month. Retrieval fees and delays apply to colder tiers.",
      "Access pattern: about 90% of reads hit slides under 90 days old; about 2% of slides older than a year are reopened per year; research campaigns occasionally reread tens of thousands of old slides.",
      "Thumbnails, label images and metadata are small and always kept hot."
    ],
    nodes: [
      { id: 'ing', label: 'Ingest', col: 0, note: 'New slides land in the hot tier.' },
      { id: 'cat', label: 'Slide catalog', col: 0, note: 'Tier, size, last access, case status, holds.' },
      { id: 'hot', label: 'Hot tier', col: 1, note: 'Standard storage; viewer and inference read here.' },
      { id: 'pol', label: 'Lifecycle rules', col: 2, note: 'Age, access and case status decide moves.' },
      { id: 'warm', label: 'Warm tier', col: 2, note: 'Infrequent access; still millisecond reads.' },
      { id: 'cold', label: 'Cold archive', col: 3, note: 'Cheapest tier; retrieval takes time and fees.' },
      { id: 'hold', label: 'Retention + holds', col: 1, note: 'Registry that vetoes any delete or move.' },
      { id: 'rehy', label: 'Rehydration service', col: 4, note: 'Restore on demand or in planned batches.' },
      { id: 'fix', label: 'Fixity audits', col: 4, note: 'Sampled checksum verification of old data.' },
      { id: 'cost', label: 'Cost + usage reports', col: 4, note: 'Spend by tier, site and project.' }
    ],
    edges: [
      ['ing', 'hot', 'write'],
      ['ing', 'cat', 'register'],
      ['cat', 'pol', 'access + status'],
      ['hot', 'warm', 'after 90 days'],
      ['pol', 'warm', 'transition'],
      ['warm', 'cold', 'after 1 year'],
      ['hold', 'pol', 'veto'],
      ['cold', 'rehy', 'restore request'],
      ['rehy', 'hot', 'temporary copy'],
      ['cold', 'fix', 'sample'],
      ['hot', 'cost'],
      ['cold', 'cost']
    ],
    components: [
      { name: 'Hot tier', why: "Standard object storage for slides in active use and everything recent. Low latency, no retrieval fees, highest storage price." },
      { name: 'Warm tier', why: "Infrequent-access class: same millisecond reads, cheaper storage, but per-read fees and minimum storage periods. Good home for slides from three months to a year." },
      { name: 'Cold archive', why: "Archive class for the long tail. Cheapest per terabyte, but restores take minutes to hours (up to about two days on the deepest tiers) depending on provider and tier, and early deletion fees may apply." },
      { name: 'Slide catalog', why: "The authoritative record of each slide's tier, size, last access, case status and holds. Lifecycle decisions read it; they should not depend on listing a bucket." },
      { name: 'Lifecycle policy engine', why: "Provider lifecycle rules for simple age-based moves, plus a small service that applies catalog-aware rules (open case, recent access) and logs every transition." },
      { name: 'Retention and hold registry', why: "States what may be deleted and when; any hold blocks both deletion and transitions that would make restoration slow." },
      { name: 'Rehydration service', why: "Accepts requests (single case or batch campaign), restores to a temporary hot copy with an expiry, and tells the requester when it is ready. Includes a prefetch hook for scheduled conferences." },
      { name: 'Fixity audit', why: "Periodically samples old objects, recomputes checksums against the manifest, and repairs from the second copy if a mismatch appears." },
      { name: 'Cost reporting', why: "Dashboards from billing exports by tier, site and project, with forecasts, so changes to policy can be priced before they happen." }
    ],
    deepDives: [
      {
        q: "What should decide when a slide moves to a colder tier: age, last access, or case status?",
        a: "Age alone is simple and predictable; access-based tiering is smarter but can surprise you. For slides the best signal is the case.\n\n- Default rule: move to warm at 90 days after sign-out and to cold at 1 year, based on catalog dates rather than file creation time.\n- Exceptions keep slides hot: open or amended cases, cases linked to an active study, slides flagged for conference or teaching.\n- A slide read from a colder tier can be returned to warm and reset its clock, using access logs from the viewer rather than provider-level access tracking.\n\nAlways keep thumbnails, labels and the manifest hot so a pathologist can see that the slide exists and request a restore. Test rules on a small cohort first, since moves incur fees."
      },
      {
        q: "A pathologist reopens a case from four years ago. How does rehydration work without a long wait?",
        a: "Make the common case invisible and the rare case honest.\n\nMost reopens come from known events: a recurrence, a conference, a consult. Hook the case system so that a new accession for an existing patient triggers a prefetch of prior slides, and conference schedules trigger a batch restore the day before.\n\nFor unplanned requests, the viewer shows the thumbnail and a 'restoring, ready in about X' message; the rehydration service requests the restore, copies slides to a temporary hot location with an expiry (say 30 days), and notifies the user. Expedited retrieval options exist on some archive tiers at higher cost; availability and timings depend on provider.\n\nTrack restore requests and wait times. If too many hit the cold tier, move the boundary."
      },
      {
        q: "How do you guarantee nothing is deleted early and that old data is still intact?",
        a: "Separate the two controls.\n\nPrevention: enable versioning and object-lock style retention where the store supports it for the retention period, block deletes through a single service that consults the hold registry, and have the catalog track every deletion request and the approver. Lifecycle rules that expire objects are written and reviewed like code, with dry runs.\n\nDetection: fixity audits. Store a checksum for every slide at ingest; each month recompute the checksum on a random sample (and fully on a multi-year cycle) and compare. A mismatch triggers repair from the second copy and an incident. Keep the second copy in a different failure domain, such as another region or account, with separate credentials so one mistake cannot remove both."
      },
      {
        q: "Walk me through a cost model leadership can use.",
        a: "Build it from the same growth numbers as the design. Monthly cost is the sum over tiers of (terabytes in tier x price) plus retrieval, requests, and transfer.\n\nExample with the assumed rates: 1 PB in hot is about $23k/month; the same in archive is roughly $1-4k. Take 5.5 PB per copy, about five years of growth at this rate. If 20% is hot or warm (blended about $18/TB-month) and 80% archive (about $2.5), storage per copy is about 1,100 TB x $18 + 4,400 TB x $2.5, roughly $20k + $11k = $31k per month, versus about $127k if it were all hot.\n\nThen add the costs that surprise people: second copy, restore fees for a research campaign (tens of thousands of slides), early-deletion charges, and inter-region transfer. Present three scenarios (all hot, tiered, aggressive) with sensitivity to the reopen rate. Update with real billing data quarterly."
      },
      {
        q: "Could you shrink the data instead of just moving it?",
        a: "Possibly, but treat it as a clinical question first. Lossless recompression gives modest gains. Lossy changes (stronger JPEG or JPEG 2000 quality, dropping the highest magnification level, converting vendor formats to DICOM) can save much more but can affect image analysis models and viewing; changes need validation by pathology and the model owners.\n\nSafer wins: delete duplicates and test scans according to policy, remove redundant intermediate files (tiles caches, derived overlays regenerated on demand), keep only the best version after a rescan where rules permit, and avoid millions of tiny objects (per-tile storage), which costs more in request fees and lifecycle management than a single file per slide.\n\nNever recompress originals in place; write new objects and verify before any retirement."
      }
    ],
    tradeoffs: [
      { choice: 'Age-based rules vs access-based tiering', pro: "Age-based rules are predictable and easy to explain and budget.", con: "Access-based tiering adapts to real use but is harder to forecast and can add per-object monitoring fees." },
      { choice: 'Archive tier vs warm tier for years 2-10', pro: "Archive is several times cheaper per terabyte.", con: "Restores are slow and carry fees and minimum retention periods; warm costs more but reopens are instant." },
      { choice: 'Two copies in cold vs one hot plus one cold', pro: "Both copies in archive minimizes cost.", con: "A hot or warm second copy speeds recovery and reads but roughly doubles the expensive bytes." },
      { choice: 'Single file per slide vs tiled objects', pro: "One object per slide keeps request counts and lifecycle management simple and cheap.", con: "Tiled objects (such as DICOM frames stored separately) allow efficient partial reads but multiply object counts." }
    ],
    rubric: [
      "Asked about retention rules, legal holds and who owns deletion.",
      "Projected growth and total size over the retention period with stated numbers.",
      "Defined tiers with their real trade-offs: latency, retrieval fees, minimum periods.",
      "Used the catalog and case status for decisions, not only object age.",
      "Designed rehydration with prefetch, temporary copies and user-visible status.",
      "Separated prevention (locks, holds) from detection (fixity audits).",
      "Included a second copy in a separate failure domain.",
      "Presented a cost model with scenarios and the surprise costs.",
      "Treated compression or conversion as something requiring validation."
    ],
    redFlags: [
      "Everything stays in hot storage because 'storage is cheap'.",
      "Lifecycle deletion rules with no hold check and no dry run.",
      "Cold tier chosen without considering retrieval delay and fees.",
      "No integrity checking of old data.",
      "Lossy recompression proposed without clinical validation."
    ]
  });

  /* ------------------------------------------------------------------ sd-07 */
  list.push({
    id: 'sd-07',
    title: 'Data quality and observability for the slide pipeline',
    level: 3,
    minutes: 45,
    prompt: "The slide pipeline now spans scanners, file shares, object storage, Kafka, Spark, an Airflow-orchestrated warehouse and several dashboards. Things fail quietly: a slide goes missing, an HL7 message changes shape, a scanner's colors drift, a dashboard stops updating and nobody notices for a day.\n\nDesign the data quality and observability layer: what you measure, where checks run, how you alert, and how on-call works so problems are found by the team and not by the users.",
    clarify: [
      "Which failures have already hurt users, and how were they found? Start with the real incidents.",
      "What are the data products and who depends on each: pathologist worklists, operations dashboard, research cohorts, model inputs?",
      "What is a reasonable freshness and completeness target for each, and what is the cost of being late versus wrong?",
      "Who owns each pipeline stage, and who answers a page at 03:00?",
      "What tooling exists already for logs, metrics, tracing and paging?",
      "How do we define a missing slide: scanned but never uploaded, or ordered but never scanned?",
      "How much can scanners and upstream systems change without telling us, and is there any contract?"
    ],
    assumptions: [
      "Illustrative: about 2,000 slides/day across 12 scanners; about 16,000 scanner events and 40,000 HL7 messages per day.",
      "Pipeline is split into about 15 Airflow DAGs, 6 Kafka topics, 2 Structured Streaming applications and about 80 dbt models.",
      "Freshness targets: slide ready within 30 minutes of scan end (p95); operations dashboard within 2 minutes; warehouse by 05:30.",
      "Completeness target: 99.9% of scanned slides traceable from scan event to catalog to warehouse within a day; unexplained gaps investigated.",
      "Team of about 6 engineers, with a weekly on-call rotation (business hours plus a light after-hours page for critical paths).",
      "Existing stack: metrics and logs in a monitoring platform, GitHub Actions or Jenkins for CI, a chat tool and a paging service."
    ],
    nodes: [
      { id: 'scan', label: 'Scan events', col: 0, note: 'Per-slide events from each scanner.' },
      { id: 'msg', label: 'HL7 and FHIR messages', col: 0, note: 'Lab orders and results.' },
      { id: 'pipe', label: 'Pipelines', col: 0, note: 'Spark, Airflow, dbt running the work.' },
      { id: 'cont', label: 'Contracts + schema', col: 1, note: 'Registry and parsers reject bad shapes at the edge.' },
      { id: 'emit', label: 'Metrics + logs', col: 1, note: 'Every stage reports counts, lag, durations.' },
      { id: 'dq', label: 'Quality results store', col: 2, note: 'Check results as rows: pass, fail, value, run.' },
      { id: 'lin', label: 'Lineage + catalog', col: 2, note: 'Which dashboards depend on what.' },
      { id: 'det', label: 'Drift detectors', col: 3, note: 'Volume, null rate, stain and scanner statistics.' },
      { id: 'sla', label: 'Freshness + SLA', col: 3, note: 'Last-event age and completeness per stage.' },
      { id: 'route', label: 'Alert router', col: 4, note: 'Dedupe, severity, owner, runbook link.' },
      { id: 'dash', label: 'Quality dashboard', col: 4, note: 'One page of pipeline health for all users.' },
      { id: 'oncall', label: 'On-call + runbooks', col: 5, note: 'Rotation, escalation, postmortems.' }
    ],
    edges: [
      ['msg', 'cont', 'validate'],
      ['scan', 'cont', 'validate'],
      ['pipe', 'emit', 'telemetry'],
      ['cont', 'dq', 'accepted / rejected'],
      ['emit', 'dq'],
      ['dq', 'det'],
      ['dq', 'sla'],
      ['lin', 'route', 'who is affected'],
      ['det', 'route'],
      ['sla', 'route'],
      ['dq', 'dash'],
      ['route', 'oncall', 'page'],
      ['route', 'dash', 'open incidents']
    ],
    components: [
      { name: 'Edge contracts', why: "Schemas for events and messages enforced where data enters: a registry for Kafka topics and strict parsers for HL7. Violations go to a dead-letter topic with counts, never silently coerced." },
      { name: 'Pipeline telemetry', why: "Each stage emits rows in, rows out, rows rejected, lag and duration. Without these numbers, 'is it working' is a guess." },
      { name: 'dbt and SQL tests', why: "Uniqueness, not-null, accepted values, relationships and freshness on sources, plus custom tests for domain rules (a slide has a scanner, a scan end follows a scan start)." },
      { name: 'Reconciliation checks', why: "Count expected versus actual along the chain: ordered, scanned, landed, validated, warehouse. The gaps tell you which stage drops data." },
      { name: 'Drift detectors', why: "Statistical monitors on volumes, null rates and value distributions, and on image statistics per scanner (tissue color, focus score, file size) to catch hardware and stain changes." },
      { name: 'Freshness and SLA monitor', why: "Tracks the age of the newest event per stage and the time from scan end to ready, so a stalled consumer or stale dashboard is noticed within minutes." },
      { name: 'Quality results store', why: "Check outcomes written as data, so quality is queryable, trendable and shown on a dashboard." },
      { name: 'Alert router and on-call', why: "Rules by severity and owner, deduplication, links to runbooks, and a rotation with escalation. Pages are reserved for user-visible impact." },
      { name: 'Lineage and catalog', why: "Maps tables to dashboards and owners, so an alert says who and what is affected." },
      { name: 'CI/CD gates', why: "GitHub Actions or Jenkins run tests and contract checks on every pull request and block merges that break them." }
    ],
    deepDives: [
      {
        q: "How do you detect that slides are missing when a missing slide produces no error?",
        a: "Compare counts along the chain and against an independent expectation. For each day, site and scanner, compute: slides ordered or expected by the lab system, scan-end events, files landed, slides validated, rows in the warehouse. A healthy chain is monotonic with small explained losses (test scans, cancellations).\n\nThe expectation matters: a slide never scanned also needs a signal, so compare against the lab system's block and slide counts per case. Alert on cases with signed-out status but missing slides, and on slides stuck in any state longer than its SLA.\n\nSurface the result as a table of unexplained gaps with the stage where the count drops, and a ticket per gap. This is more reliable than trying to instrument every failure path."
      },
      {
        q: "An HL7 sender changes a field format overnight. How do you find out before users do?",
        a: "Catch it at the door and measure it afterward.\n\n- Parse strictly against a canonical schema; unknown or invalid messages go to a quarantine topic. Alert on the quarantine rate per sender and message type, not just the total.\n- Track per-field null rate, value cardinality and length distributions per sender. A field that goes 2% null to 90% null is the classic signature.\n- Replay a library of recorded real messages through the parser in CI, and add new samples whenever a surprise occurs.\n- Ask the sending team for change notices, but do not depend on them.\n\nFor JSON topics, use compatibility rules in the registry. In dbt, accepted-values tests catch new codes. The principle: a changed input should become a visible reject, never a silent null."
      },
      {
        q: "How do you detect stain or scanner drift in the image data itself?",
        a: "Compute cheap summary statistics for every slide at ingestion or in a nightly batch: mean and standard deviation of color in a standard color space over tissue pixels, estimated stain vector components, focus or sharpness score, tissue coverage, compressed file size per unit area, and microns-per-pixel.\n\nTrack them per scanner and per stain, as time series. A drift detector compares a rolling window against a baseline using simple tests (a population stability index, a KS test, or control-chart limits) and alerts on sustained shifts, not single slides.\n\nUse calibration or control slides on a schedule when the lab runs them, since they separate hardware drift from case-mix change. A flagged scanner goes to the lab for service; models trained on old colors may need review. This is monitoring, not correction."
      },
      {
        q: "A dashboard looks fine but has been stale for a day. How is that prevented?",
        a: "A stale dashboard shows plausible old numbers, so only a freshness signal can catch it. Check at three levels:\n\n1. Source freshness: `max(event_ts)` per source and stage, compared with an expected lag. dbt has built-in source freshness checks.\n2. Pipeline freshness: each Airflow DAG has an SLA or deadline alert, and a final task writes a 'last successful publish' row.\n3. Consumer freshness: the BI layer shows a visible 'data as of' time, and a synthetic check opens the dashboard's query and verifies the timestamp.\n\nAlso alert on absence: a heartbeat topic or a watchdog that expects data every N minutes and fires when nothing arrives. Silence is a failure signal, and it is the one most often unmonitored."
      },
      {
        q: "How do you keep alerting useful and on-call sustainable?",
        a: "Alert on symptoms users feel and on leading indicators with clear action, not on every error.\n\n- Define SLOs per data product (freshness, completeness). Page when the error budget burns fast; send everything else to a ticket or chat.\n- Each alert has an owner, a severity, a runbook link and the affected dashboards from lineage.\n- Deduplicate and group: one stalled topic should create one page, not forty.\n- Review every alert monthly: delete the noisy ones, tune thresholds, automate the fixes you keep repeating.\n- Run blameless postmortems for pages and track repeat causes.\n\nOn-call is a weekly rotation with a secondary, a handoff note, and a rule that after-hours pages are only for user-visible breakage. Sustainable on-call is a quality metric of the pipeline itself."
      }
    ],
    tradeoffs: [
      { choice: 'Strict rejection vs lenient parsing at the edge', pro: "Strict rejection makes bad data visible immediately and protects downstream tables.", con: "Lenient parsing keeps data flowing during sender quirks but hides damage; a quarantine with replay captures both benefits." },
      { choice: 'Tests in the pipeline vs a separate monitoring system', pro: "In-pipeline tests (dbt, assertions) fail the run before bad data is published.", con: "External monitors catch things the pipeline did not expect and watch silence, so you need both." },
      { choice: 'Statistical drift alerts vs fixed thresholds', pro: "Statistical monitors adapt to normal variation and catch gradual change.", con: "Fixed thresholds are simpler and easier to explain, but need manual tuning and miss slow drift." },
      { choice: 'Page on every failure vs page on SLO burn', pro: "Paging on every failure is simple and catches everything.", con: "SLO-based paging cuts noise and protects the team, but requires agreeing on targets and measuring them well." }
    ],
    rubric: [
      "Began with real incidents and the users harmed, not tools.",
      "Defined freshness, completeness and correctness targets per data product.",
      "Enforced contracts at the edge with a quarantine path.",
      "Used reconciliation across the whole chain, including an independent expectation from the lab system.",
      "Treated absence of data as an alert condition.",
      "Described drift monitoring for message fields and for image statistics per scanner.",
      "Stored check results as data and linked alerts to owners via lineage.",
      "Described alert severity, deduplication, runbooks and a sustainable on-call rotation.",
      "Put checks in CI/CD as well as in production.",
      "Explained how the system itself is tested and who watches the watchers."
    ],
    redFlags: [
      "Only logging errors, with no check that expected data arrived.",
      "Alerting on everything so the team ignores pages.",
      "Silent null-filling when a source changes shape.",
      "No owner or runbook attached to an alert.",
      "Drift handled by inspecting a few images by eye with no ongoing measurement."
    ]
  });
})();
