/* Batch & streaming deck: Spark, Structured Streaming, Kafka, Hive, Pig, architectures, file and table formats, Python pipelines, REST integration. Plain data, loaded by the page and the tests. */
(function () {
  'use strict';
  (globalThis.TT_DECKS = globalThis.TT_DECKS || []).push({
    id: 'pipelines',
    title: 'Batch & streaming',
    blurb: 'Spark, Kafka, Hive, Pig, table formats, Python and REST integration, with scan events and slide data as the running example.',
    order: 2,
    cards: [
      {
        id: 'pipelines-01',
        topic: 'Spark basics',
        level: 1,
        q: 'What does it mean that Spark evaluates lazily, and what practical consequences does that have when you build a pipeline over `scan_events`?',
        a: "Transformations (`filter`, `select`, `join`, `groupBy`) only extend a logical plan. Nothing runs until an action (`count`, `collect`, `show`, `toPandas`, a `write`) asks for a result. Then Catalyst optimizes the whole plan, Spark splits it into stages and tasks, and executes it.\n\nConsequences:\n- Errors can surface late. A misspelled column fails at analysis, but a corrupt file or a bad cast only fails when an action touches the data.\n- Each action recomputes the plan from the source unless you `cache()` or persist an intermediate result. A `count()` followed by a `write` reads the input twice.\n- The optimizer sees the whole chain, so it can prune columns and push filters into the Parquet reader. A filter on a partition column reads only those directories.\n- `explain()` prints the plan without running anything. Use it to confirm pruning and the join strategy.\n\nExample: `spark.read.parquet(events).filter(...)` returns instantly and reads no data. The cost shows up at the `write`.",
        points: [
          'Transformations build a plan; actions trigger execution',
          'Catalyst optimizes the whole chain (column pruning, predicate pushdown)',
          'Each action recomputes unless the result is cached or written',
          'Some errors appear only when an action runs',
          '`explain()` inspects the plan for free'
        ],
        followups: [
          'How would you tell from the Spark UI that a DataFrame was computed twice?',
          'Is `df.show()` an action? What about `df.limit(10)` alone?'
        ],
        pitfalls: [
          'Timing a transformation and concluding the query is fast',
          'Calling `count()` for logging in the middle of a pipeline, which doubles the reads'
        ]
      },
      {
        id: 'pipelines-02',
        topic: 'Spark basics',
        level: 1,
        q: 'Explain narrow vs wide transformations, and why the difference matters for cost. Use examples on slide and scan data.',
        a: "A narrow transformation produces each output partition from one input partition: `filter`, `select`, `withColumn`, `union`, `map`. Spark pipelines them in memory inside a single stage with no data movement. Filtering `slides` to `qc_status = 'pass'` is narrow.\n\nA wide transformation needs rows with the same key together, so data is repartitioned across the network: `groupBy`, `join` (unless broadcast), `distinct`, `orderBy`, `repartition`. This is a shuffle. Map-side tasks write shuffle files to local disk, reduce-side tasks fetch them over the network, and the plan gets a stage boundary. Counting scans per scanner per day is wide.\n\nShuffles are where time goes: disk, network, serialization, and the risk of skew or spill. So filter and project early, let Spark do partial aggregation before the shuffle, and avoid needless `repartition`.\n\nPartition count after a shuffle is `spark.sql.shuffle.partitions`, default 200. Since Spark 3.2 adaptive query execution (AQE) is on by default and can coalesce small shuffle partitions at runtime.",
        points: [
          'Narrow: one input partition feeds one output partition, pipelined in a stage',
          'Wide: shuffle with disk and network, and a new stage',
          'Name concrete examples of each',
          'Reduce rows and columns before a shuffle',
          '`spark.sql.shuffle.partitions` defaults to 200; AQE coalescing is on by default since 3.2'
        ],
        followups: [
          'Is `coalesce` narrow or wide? How does it differ from `repartition`?',
          'Why is `reduceByKey` preferred over `groupByKey` on RDDs?'
        ],
        pitfalls: [
          'Treating `repartition(n)` as free',
          'Assuming 200 shuffle partitions is right for every data size'
        ]
      },
      {
        id: 'pipelines-03',
        topic: 'Kafka ordering',
        level: 1,
        q: 'Scan events for one slide (`queued`, `scan_start`, `scan_end`, `uploaded`) arrive on a Kafka topic. What do you use as the message key, and what ordering do you actually get?',
        a: "Key by `slide_id`. Kafka guarantees order only within a partition, and a record's partition is chosen by hashing its key, so all events for one slide land in one partition and are consumed in the order they were appended. There is no ordering across partitions, so events for different slides interleave freely.\n\nKeying by `scanner_id` would order per scanner, but one busy scanner then makes a hot partition, and the per-slide lifecycle is what downstream logic usually cares about.\n\nDetails worth knowing:\n- A null key means no ordering guarantee and spread across partitions.\n- Adding partitions to a topic changes the key-to-partition mapping for new records, so per-key order breaks across that boundary. Pick the count with headroom.\n- Different clients hash differently. The Java client uses murmur2. librdkafka (used by confluent-kafka) defaults to a CRC32-based partitioner, so set `partitioner=murmur2_random` if producers in different languages must agree.\n- To keep order across producer retries, use an idempotent producer (`enable.idempotence=true`; the default in the Java client since Kafka 3.0, but not in librdkafka).",
        points: [
          'Order is per partition only',
          'Same key means same partition',
          'Key by the entity whose order matters (slide_id)',
          'Changing partition count remaps keys',
          'Producer retries need idempotence to preserve order'
        ],
        followups: [
          'What do you do if one key is far hotter than the others?',
          'How would a consumer handle an `uploaded` event arriving without a preceding `scan_end`?'
        ],
        pitfalls: [
          'Assuming a topic is globally ordered',
          'Using a high-cardinality random key and then expecting ordering'
        ]
      },
      {
        id: 'pipelines-04',
        topic: 'Hive',
        level: 1,
        q: 'What is the Hive metastore, and what is the difference between external and managed tables? Show a partitioned external table over scan data.',
        a: "The Hive metastore is a catalog service backed by a relational database. It stores table definitions: schema, storage format, data location, partition list. It stores no data. Hive, Spark, Trino and others share it, which is why it outlived Hive itself as the common catalog.\n\nManaged table: the engine owns the data. `DROP TABLE` deletes metadata and files. External table: you point at a location you control. `DROP TABLE` removes only the metadata. Raw landing zones for scanner output should be external so a dropped table cannot delete the only copy.\n\nPartitioned tables map partition values to directories (`scan_date=2026-10-25/`). A filter on the partition column prunes directories. Pick low-cardinality columns such as date. Partitioning by `slide_id` would create millions of tiny directories and overwhelm the metastore.\n\nIf files land in partition directories outside Hive, register them with `MSCK REPAIR TABLE` or `ALTER TABLE ... ADD PARTITION`. In Hive 3 deployments managed tables are usually created as transactional (ACID) ORC tables; whether that is the default depends on the distribution and its settings.",
        code: `CREATE EXTERNAL TABLE slides_raw (
  slide_id   BIGINT,
  case_id    BIGINT,
  stain      STRING,
  scanner_id INT,
  scanned_at TIMESTAMP,
  file_bytes BIGINT,
  qc_status  STRING
)
PARTITIONED BY (scan_date DATE)
STORED AS PARQUET
LOCATION 's3a://lake/raw/slides/';

-- register partition directories written by the upload step
MSCK REPAIR TABLE slides_raw;

-- prunes to a single directory
SELECT scanner_id, COUNT(*) AS slides
FROM slides_raw
WHERE scan_date = DATE '2026-10-25'
GROUP BY scanner_id;`,
        codeLang: 'sql',
        points: [
          'Metastore holds schema, format, location and partitions, not data',
          'External: DROP removes metadata only; managed: DROP deletes data',
          'Partition by low-cardinality columns such as date',
          'Register externally written partitions (MSCK REPAIR or ADD PARTITION)',
          'Shared by Hive, Spark and Trino'
        ],
        followups: [
          'What happens to query planning with 500,000 partitions?',
          'How do you migrate a managed table to external without copying?'
        ],
        pitfalls: [
          'Partitioning on a high-cardinality key',
          'Forgetting to register new partitions and wondering why queries return nothing'
        ]
      },
      {
        id: 'pipelines-05',
        topic: 'Event time',
        level: 1,
        q: 'Explain event time vs processing time. Which one do you window on for "slides scanned per hour", and why?',
        a: "Event time is when the thing happened, as recorded by the source (the scanner stamps `scan_end`). Processing time is when your pipeline sees it. They differ by network delay, retries, buffering, outages, and batch schedules.\n\nWindow on event time for business questions. If a scanner loses its uplink for two hours and then flushes its buffer, those scans still belong to the hours in which they happened. Windowing on processing time would pile them into the hour of the flush and make the report depend on how healthy the network was.\n\nProcessing time is the right clock for operational questions: ingest latency, consumer lag, time since the last message from a scanner.\n\nPractical rules:\n- Carry both timestamps (`event_ts`, `ingested_at`) on every record.\n- Expect late and out-of-order events and decide how long to wait (a watermark in streaming, a reprocessing window in batch).\n- Device clocks drift. Check skew against `ingested_at` and keep scanners on NTP.\n- Be explicit about time zone; store UTC.",
        points: [
          'Event time is source-stamped; processing time is arrival',
          'Business windows use event time',
          'Latency and lag use processing time',
          'Keep both columns on every record',
          'Plan for lateness and clock skew'
        ],
        followups: [
          'How would you detect a scanner whose clock is 10 minutes ahead?',
          'What does a daily batch report do about events that arrive a day late?'
        ],
        pitfalls: [
          'Using ingestion timestamps for daily throughput and getting a spike after every outage',
          'Mixing local time zones in event stamps'
        ]
      },
      {
        id: 'pipelines-06',
        topic: 'File formats',
        level: 1,
        q: 'Compare Parquet, ORC and Avro. Which would you pick for (a) a Kafka topic of scan events, (b) an analytics table of slide metadata, and why?',
        a: "Parquet and ORC are columnar. Data is stored by column in row groups or stripes, compressed well, with min/max statistics per chunk. Queries read only the columns they need and can skip chunks via predicate pushdown. They are built for scans and aggregations over large tables. Avro is row-oriented, with the schema stored alongside the data and strong support for schema evolution. It is built for writing and reading whole records.\n\n(a) Kafka topic: Avro (or Protobuf) with a schema registry. Messages are whole records, written one at a time, and consumers need explicit compatibility rules.\n\n(b) Analytics table: Parquet or ORC. Parquet is Spark's default and the most widely supported format for Trino, Snowflake and BigQuery loads. ORC is the native choice in Hive and has good ACID support there. Both work; choose by what your engines read best.\n\nNone of these stores pixels well. Keep image data in its image format (SVS, DICOM, pyramidal TIFF) in object storage and put the metadata, paths and derived features in Parquet.",
        points: [
          'Columnar vs row-oriented storage',
          'Column pruning and predicate pushdown for Parquet/ORC',
          'Avro for streaming records with schema evolution',
          'Parquet is the broadest default; ORC is Hive-centric',
          'Images stay as image files; tables hold metadata'
        ],
        followups: [
          'Why is Parquet a poor fit for one-row-at-a-time inserts?',
          'What do row group size and compression codec change?'
        ],
        pitfalls: [
          'Claiming one format is always faster',
          'Putting multi-gigabyte image blobs inside a Parquet column'
        ]
      },
      {
        id: 'pipelines-07',
        topic: 'Python pipelines',
        level: 1,
        q: 'You get a 20 GB newline-delimited JSON export of scan events. How do you process it in Python without loading it into memory, and how do you test the code?',
        a: "Stream it with a generator. Open the file, yield one parsed record at a time, and chain generators for filtering and batching, so memory stays flat no matter how large the file is. Add type hints (`Iterator[dict]`) so the contract is visible and a type checker can help. Raise errors that include the file and line number.\n\nTesting with pytest: keep the pure logic (parsing, filtering, batching) separate from I/O, write small inputs to `tmp_path`, and use `pytest.mark.parametrize` for edge cases (blank lines, malformed JSON, empty file). Assert on behavior, not on internals.\n\nPackaging: put the code in a package with a `pyproject.toml`, pin dependencies, install with `pip install -e .` in development, and run the same tests in CI. For Spark or containers, build a wheel so the environment is reproducible.\n\n`itertools.batched` exists from Python 3.12; on older versions write the small helper below.",
        code: `import json
from collections.abc import Iterable, Iterator
from itertools import islice
from pathlib import Path


def read_events(path: Path) -> Iterator[dict]:
    """Yield one parsed event per non-empty line, lazily."""
    with path.open("r", encoding="utf-8") as f:
        for line_no, line in enumerate(f, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"{path}:{line_no}: invalid JSON") from exc


def batches(items: Iterable[dict], size: int) -> Iterator[list[dict]]:
    it = iter(items)
    while chunk := list(islice(it, size)):
        yield chunk


# test_events.py
import pytest


def test_read_events_skips_blank_lines(tmp_path):
    p = tmp_path / "events.ndjson"
    p.write_text('{"slide_id": 1}\\n\\n{"slide_id": 2}\\n')
    assert [e["slide_id"] for e in read_events(p)] == [1, 2]


def test_read_events_reports_line_number(tmp_path):
    p = tmp_path / "bad.ndjson"
    p.write_text('{"slide_id": 1}\\nnot json\\n')
    with pytest.raises(ValueError, match=":2:"):
        list(read_events(p))`,
        codeLang: 'python',
        points: [
          'Generators give constant memory',
          'Type hints document the Iterator contract',
          'Errors carry file and line context',
          'pytest with tmp_path and parametrize for edge cases',
          'Package with pyproject.toml and run the same tests in CI'
        ],
        followups: [
          'Where does a generator pipeline break if you call `list()` on it?',
          'How would you parallelize this across many files?'
        ],
        pitfalls: [
          '`json.load` on the whole file',
          'Catching every exception and silently skipping bad lines'
        ]
      },
      {
        id: 'pipelines-08',
        topic: 'Spark joins',
        level: 2,
        q: 'When and how do you use a broadcast join in Spark? Join billions of `scan_events` to the dozens of rows in `scanners`.',
        a: "A broadcast hash join ships the small table to every executor once, and each task joins its partition of the big table locally. The big side is never shuffled, which usually makes it far faster than a sort-merge join.\n\nSpark broadcasts automatically when the estimated size of a side is below `spark.sql.autoBroadcastJoinThreshold` (10 MB by default). The estimate comes from statistics, which are often missing for plain files, so you may need an explicit hint, `broadcast(df)`. With AQE (default on since Spark 3.2) Spark can also switch to a broadcast join at runtime using actual shuffle sizes.\n\nLimits:\n- The broadcast side must fit comfortably in driver and executor memory. Oversized broadcasts cause OOM or `spark.sql.broadcastTimeout` failures.\n- You cannot broadcast the preserved side of an outer join (the left side of a left join).\n- Check `explain()` for `BroadcastHashJoin`; do not assume.\n\nFor `scanners`, broadcasting is obviously right. For two large tables it is not, and you need a sort-merge join with sensible partitioning.",
        code: `from pyspark.sql import functions as F

events = spark.read.parquet("s3a://lake/silver/scan_events/")
scanners = spark.read.parquet("s3a://lake/dim/scanners/")

enriched = events.join(F.broadcast(scanners), "scanner_id", "left")
enriched.explain()   # look for BroadcastHashJoin in the physical plan`,
        codeLang: 'python',
        points: [
          'Small side is copied to executors; the big side avoids a shuffle',
          'Automatic threshold defaults to 10 MB and depends on statistics',
          '`broadcast()` hint forces it',
          'Memory limits on driver and executors',
          'Verify with `explain()`'
        ],
        followups: [
          'What happens if you hint a broadcast on a 5 GB table?',
          'How does AQE change the join strategy at runtime?'
        ],
        pitfalls: [
          'Broadcasting the wrong side of an outer join',
          'Relying on the automatic threshold when no statistics exist'
        ]
      },
      {
        id: 'pipelines-09',
        topic: 'Spark basics',
        level: 2,
        q: 'When is `cache()` or `persist()` worth it in Spark, and when does it hurt? How does it differ from checkpointing or writing an intermediate table?',
        a: "Cache a DataFrame when it is expensive to compute and reused by several actions in the same application, for example a cleaned `scan_events` set that feeds three reports. `cache()` is lazy: it materializes on the first action. For DataFrames the default storage level is memory with spill to disk (details vary a little by version). Call `unpersist()` when done.\n\nIt hurts when:\n- The data is used once. You pay memory and serialization for nothing.\n- It is huge compared to executor memory. Cached blocks get evicted or spill, and you recompute anyway while crowding out execution memory.\n- You cache early in the plan, before a filter that would have shrunk the data.\n\nA cache is not durable. If an executor dies, lost blocks are recomputed from lineage. It also does not live beyond the application.\n\nCheckpointing writes to reliable storage and truncates lineage, which helps with very long plans or iterative algorithms. Writing an intermediate Parquet or table is the most robust option: it survives restarts, can be inspected, and is shared across applications. In a scheduled pipeline, prefer writing intermediates at natural stage boundaries.",
        points: [
          'Cache only when reused by multiple actions',
          'Lazy: materializes on first action; unpersist when done',
          'Not durable; recomputed from lineage on loss',
          'Checkpoint truncates lineage; a written table also survives restarts',
          'Cache after filtering and projecting, not before'
        ],
        followups: [
          'How do you confirm in the UI that a cache is being hit?',
          'Why might cached data make a stage slower?'
        ],
        pitfalls: [
          'Caching everything by habit',
          'Forgetting that the first action pays the full cost'
        ]
      },
      {
        id: 'pipelines-10',
        topic: 'Small files',
        level: 2,
        q: 'What is the small-files problem, why do slide-imaging pipelines hit it, and how do you fix it, including reading per-slide metadata sidecars at scale?',
        a: "Too many tiny files make a distributed engine slow. Each file costs a listing entry, an open, and scheduling overhead. Object stores have high per-request latency, HDFS keeps per-file metadata in NameNode memory, and Spark driver memory grows with the file list.\n\nImaging pipelines create them naturally: one JSON or XML sidecar per slide, one file per tile, and streaming writes that emit a file per micro-batch per partition.\n\nFixes:\n- Compact into larger files, with a target around 128 MB to 1 GB of Parquet. Rewrite with `repartition(n)` or `coalesce(n)` before writing, and cap with `maxRecordsPerFile`.\n- Do not over-partition output (date plus scanner plus hour makes thousands of small directories).\n- Use table-format compaction (`OPTIMIZE` in Delta, `rewrite_data_files` in Iceberg) on a schedule.\n- On read, Spark packs small files into tasks up to `spark.sql.files.maxPartitionBytes` (128 MB default), which softens but does not remove the cost.\n\nFor sidecars: ingest them once into a `slide_manifest` Parquet table (slide id, path, dimensions, scanner, tags) and query that, instead of listing the bucket each run.",
        points: [
          'Per-file overhead: listing, open, scheduling, metadata memory',
          'Common causes: sidecars, tiles, streaming micro-batches',
          'Compact to roughly 128 MB to 1 GB files',
          'Avoid over-partitioning',
          'Build a manifest table instead of repeatedly listing storage'
        ],
        followups: [
          'How do you compact a table that is being written to continuously?',
          'How would you decide the number of output files?'
        ],
        pitfalls: [
          'Calling `coalesce(1)` on large output',
          'Partitioning by a column with thousands of distinct values'
        ]
      },
      {
        id: 'pipelines-11',
        topic: 'PySpark code',
        level: 2,
        q: 'Write a PySpark 3.x batch job that computes per-scanner daily throughput from `scan_events`: slides scanned and average scan duration. Rescans mean one slide can have several start/end pairs. The sample rows are below.',
        setup: `event_id | slide_id | scanner_id | event_type | event_ts
1        | 501      | 7          | scan_start | 2026-10-25 08:01:10
2        | 501      | 7          | scan_end   | 2026-10-25 08:09:40
3        | 502      | 7          | scan_start | 2026-10-25 08:10:05
4        | 502      | 7          | qc_fail    | 2026-10-25 08:12:00
5        | 502      | 7          | rescan     | 2026-10-25 08:30:00
6        | 502      | 7          | scan_start | 2026-10-25 08:31:00
7        | 502      | 7          | scan_end   | 2026-10-25 08:40:30`,
        setupLang: 'text',
        a: "Pair each `scan_end` with the event immediately before it for the same slide and scanner, using a window with `lag`. Keep only pairs where the previous event is a `scan_start`. That handles rescans correctly: slide 502 yields one pair, 08:31:00 to 08:40:30, and the failed first attempt is ignored. Then group by scanner and event date.\n\nDesign choices:\n- Use event time (`scan_end`) for the date, in UTC (set the session time zone so `to_date` does not use the cluster's local zone).\n- Count distinct slides and also total completed scans, so rescans are visible.\n- Write partitioned by `scan_date` with dynamic partition overwrite, so rerunning a day replaces only that day. That makes the run idempotent.\n- The window partitions by slide and scanner, so there is no global sort. Filter to the date range of interest first and read only needed columns.\n\nTies on identical timestamps can make `lag` ambiguous, so in production add a tiebreaker such as `event_id` to the ordering.",
        code: `from pyspark.sql import SparkSession, Window, functions as F

spark = (SparkSession.builder.appName("scanner_daily_throughput").getOrCreate())
spark.conf.set("spark.sql.sources.partitionOverwriteMode", "dynamic")
spark.conf.set("spark.sql.session.timeZone", "UTC")

events = (
    spark.read.parquet("s3a://lake/silver/scan_events/")
    .filter(F.col("event_type").isin("scan_start", "scan_end"))
    .select("event_id", "slide_id", "scanner_id", "event_type", "event_ts")
)

w = Window.partitionBy("slide_id", "scanner_id").orderBy("event_ts", "event_id")

completed = (
    events
    .withColumn("prev_type", F.lag("event_type").over(w))
    .withColumn("prev_ts", F.lag("event_ts").over(w))
    .filter((F.col("event_type") == "scan_end") & (F.col("prev_type") == "scan_start"))
    .withColumn(
        "scan_seconds",
        F.col("event_ts").cast("long") - F.col("prev_ts").cast("long"),
    )
    .withColumn("scan_date", F.to_date("event_ts"))
)

daily = completed.groupBy("scanner_id", "scan_date").agg(
    F.countDistinct("slide_id").alias("slides_scanned"),
    F.count("*").alias("completed_scans"),
    F.round(F.avg("scan_seconds"), 1).alias("avg_scan_seconds"),
)

(daily.write.mode("overwrite")
    .partitionBy("scan_date")
    .parquet("s3a://lake/gold/scanner_daily_throughput/"))`,
        codeLang: 'python',
        points: [
          'Pair scan_end with the preceding scan_start using lag over a window',
          'Rescans produce extra pairs; failed attempts without scan_end are ignored',
          'Distinct slides vs completed scans',
          'Dynamic partition overwrite makes reruns idempotent',
          'Add a tiebreaker for equal timestamps'
        ],
        followups: [
          'What changes if scan_end events can arrive a day late?',
          'How would you compute the 95th percentile duration instead of the mean?'
        ],
        pitfalls: [
          'Grouping by slide and taking min(start) and max(end), which spans the rescan gap',
          'Writing with plain overwrite and wiping every other day'
        ]
      },
      {
        id: 'pipelines-12',
        topic: 'Structured Streaming',
        level: 2,
        q: 'Explain how Spark Structured Streaming executes (micro-batches, triggers) and what the three output modes mean. When does each apply?',
        a: "Structured Streaming treats a stream as an unbounded table. By default the engine runs micro-batches: it decides the offsets to read for the next batch, plans and runs the same DataFrame logic as batch on that slice, writes the result, then records completion. A trigger controls cadence: the default starts the next batch as soon as the previous one finishes, `processingTime='30 seconds'` fixes the interval, and `availableNow=True` (Spark 3.3 and later) processes everything available and stops, which gives batch-style scheduling with streaming semantics. A continuous mode exists but is experimental.\n\nOutput modes:\n- **append**: only new final rows. The usual mode for non-aggregating queries; for aggregations it requires a watermark, and a window is emitted once the watermark passes its end.\n- **update**: rows changed since the last trigger. Good for dashboards over running aggregates, when the sink supports updates.\n- **complete**: the entire result table every time. Allowed only for aggregations, and sensible only for small ones.\n\nMicro-batch latency is typically hundreds of milliseconds to seconds. If you need milliseconds, consider a record-at-a-time engine (recent Spark releases add a low-latency real-time mode; check what your version supports).",
        code: `from pyspark.sql import functions as F

raw = (
    spark.readStream.format("kafka")
    .option("kafka.bootstrap.servers", "broker1:9092")
    .option("subscribe", "scan-events")
    .option("startingOffsets", "earliest")
    .load()
)

events = (
    raw.select(F.from_json(F.col("value").cast("string"),
        "event_id string, slide_id long, scanner_id int, event_type string, event_ts timestamp"
    ).alias("e"))
    .select("e.*")
)

query = (
    events.writeStream
    .format("parquet")
    .option("path", "s3a://lake/bronze/scan_events/")
    .option("checkpointLocation", "s3a://lake/_checkpoints/scan_events_bronze/")
    .outputMode("append")
    .trigger(processingTime="30 seconds")
    .start()
)`,
        codeLang: 'python',
        points: [
          'Micro-batch loop: choose offsets, run, write, commit',
          'Triggers: default, processingTime, availableNow (3.3+)',
          'append, update, complete semantics',
          'Aggregations in append mode need a watermark',
          'Latency is seconds, not milliseconds'
        ],
        followups: [
          'When is `availableNow` better than a long-running stream?',
          'Why does this query need a checkpoint location?'
        ],
        pitfalls: [
          'Using complete mode on a large aggregate',
          'Expecting the Kafka source to use consumer-group offset commits (it tracks offsets in its own checkpoint)'
        ]
      },
      {
        id: 'pipelines-13',
        topic: 'Kafka consumers',
        level: 2,
        q: 'Explain Kafka consumer groups and rebalancing. What triggers a rebalance, why does it hurt, and how do you reduce it?',
        a: "A consumer group shares a topic's partitions: each partition is assigned to exactly one consumer in the group at a time, so parallelism is capped by the partition count. Extra consumers sit idle.\n\nA rebalance reassigns partitions. Triggers: a consumer joins or leaves, a consumer misses heartbeats past `session.timeout.ms`, a consumer fails to call `poll()` within `max.poll.interval.ms` (default 5 minutes), or the subscription or partition count changes. The `max.poll.interval.ms` case is the classic trap for slow work inside the poll loop, such as running a heavy image-analysis step per message.\n\nWith the classic eager protocol every consumer stops, gives up all partitions, and gets a new assignment, so the whole group pauses.\n\nReduce the pain:\n- Use the cooperative sticky assignor, which moves only the partitions that need to move.\n- Static membership (`group.instance.id`) with a longer session timeout, so rolling restarts do not trigger rebalances.\n- Keep poll-loop work short, or hand off to workers and pause partitions.\n- Commit offsets in the revoke callback.\n\nKafka 4.0 made the KIP-848 consumer protocol generally available: the broker computes assignments incrementally and there is no group-wide stop. Clients opt in with `group.protocol=consumer`; check your client's support.",
        points: [
          'One partition belongs to one consumer in a group; parallelism is capped by partitions',
          'Triggers: membership change, missed heartbeat, `max.poll.interval.ms` exceeded, partition or subscription change',
          'Eager rebalancing stops the world; cooperative sticky moves less',
          'Static membership avoids restarts causing rebalances',
          'Commit in the revoke callback'
        ],
        followups: [
          'You have 12 partitions and 20 consumers. What happens?',
          'How do you diagnose frequent rebalances from the logs?'
        ],
        pitfalls: [
          'Doing minutes of work between polls and then blaming the broker',
          'Adding consumers beyond the partition count to scale'
        ]
      },
      {
        id: 'pipelines-14',
        topic: 'Kafka consumers',
        level: 2,
        q: 'Write a Kafka consumer loop (confluent-kafka for Python) that batches scan events, writes them to a store, and commits offsets only after the write succeeds. What delivery guarantee does it give?',
        a: "This uses `confluent-kafka` (the librdkafka-based client). Auto-commit is disabled. The loop accumulates messages into a batch, writes the batch, and only then commits synchronously. A commit with no arguments records the current position (last delivered offset plus one) for the assigned partitions.\n\nGuarantee: at-least-once. If the process crashes after the write but before the commit, the batch is read again on restart. So `write_rows` must be idempotent, for example an upsert keyed on `event_id`. If you commit before the write you get at-most-once, and a crash loses data.\n\nDetails that matter:\n- The revoke callback flushes and commits before partitions are taken away, which limits duplicates on rebalance.\n- Committing offset N means \"next to read is N\", not \"processed N\".\n- A malformed message must not crash the loop forever: log it and send it to a dead-letter topic.\n- Only commit when there is something to commit; committing with an empty position raises an error in this client.\n- If `write_rows` raises, the loop exits without committing, and the batch is replayed after restart, which is acceptable under at-least-once.",
        code: `import json
import logging
import time

from confluent_kafka import Consumer, KafkaError, KafkaException

log = logging.getLogger("scan_events_loader")


def write_rows(rows: list[dict]) -> None:
    """Idempotent write (for example MERGE on event_id). Raises on failure."""
    ...


def run(topic: str = "scan-events", max_batch: int = 500, max_wait_s: float = 5.0) -> None:
    consumer = Consumer({
        "bootstrap.servers": "broker1:9092",
        "group.id": "scan-events-loader",
        "enable.auto.commit": False,
        "auto.offset.reset": "earliest",
        "partition.assignment.strategy": "cooperative-sticky",
    })
    batch: list[dict] = []

    def flush() -> None:
        if batch:
            write_rows(batch)                  # at-least-once: replayed if we die before the commit
            consumer.commit(asynchronous=False)  # commits current position of assigned partitions
            batch.clear()

    consumer.subscribe([topic], on_revoke=lambda c, partitions: flush())
    deadline = 0.0
    try:
        while True:
            msg = consumer.poll(1.0)
            if msg is not None:
                if msg.error():
                    if msg.error().code() != KafkaError._PARTITION_EOF:
                        raise KafkaException(msg.error())
                else:
                    try:
                        if not batch:
                            deadline = time.monotonic() + max_wait_s
                        batch.append(json.loads(msg.value()))
                    except (TypeError, ValueError):  # bad JSON, or a null value
                        # production: produce msg.value() to a dead-letter topic with error headers
                        log.warning("bad payload at %s[%d]@%d", msg.topic(), msg.partition(), msg.offset())
            if batch and (len(batch) >= max_batch or time.monotonic() >= deadline):
                flush()
    finally:
        consumer.close()`,
        codeLang: 'python',
        points: [
          'Auto-commit off; commit after the write succeeds',
          'Result is at-least-once, so the sink must be idempotent',
          'Committed offset is the next offset to read',
          'Flush and commit in the revoke callback',
          'Handle poison messages without blocking the partition'
        ],
        followups: [
          'How would you get effectively-once results into a SQL table?',
          'What changes if processing one batch takes longer than `max.poll.interval.ms`?'
        ],
        pitfalls: [
          'Leaving `enable.auto.commit` on and committing before work finishes',
          'Committing `msg.offset()` instead of `msg.offset() + 1` when committing explicit offsets'
        ]
      },
      {
        id: 'pipelines-15',
        topic: 'Kafka storage',
        level: 2,
        q: 'Compare Kafka retention (delete) and log compaction. Which topics in a slide-imaging platform get which, and what are the gotchas?',
        a: "Retention (`cleanup.policy=delete`) removes whole log segments older than `retention.ms` (default 7 days broker-wide) or beyond `retention.bytes`. It is for event streams: `scan_events`, inference results, telemetry. The topic holds a window of history that consumers can replay.\n\nCompaction (`cleanup.policy=compact`) keeps at least the latest record per key and removes older ones. It is for changelogs and current-state topics: for example `slide_status` keyed by `slide_id`, or a CDC stream of a reference table. A new consumer that reads from the beginning rebuilds the latest state. A record with a null value is a tombstone that eventually removes the key.\n\nGotchas:\n- Compaction is eventual and skips the active segment, so consumers can still see older values for a key.\n- Compacted topics require non-null keys.\n- It does not give you history. Use `compact,delete` if you want both a state view and bounded size.\n- Retention interacts with consumers: if a group is down longer than retention, its committed offset falls out of range and `auto.offset.reset` decides whether it jumps to earliest or latest.\n- Kappa-style replay needs retention long enough to cover your reprocessing window.",
        points: [
          'Delete retention: time or size based, segment granularity',
          'Compaction: keeps latest value per key; null value is a tombstone',
          'Events get retention; current-state tables get compaction',
          'Compaction is eventual and needs non-null keys',
          'Offsets past retention trigger auto.offset.reset behavior'
        ],
        followups: [
          'How do you delete a slide record for good from a compacted topic?',
          'How long should `scan_events` be retained, and what drives that choice?'
        ],
        pitfalls: [
          'Using a compacted topic as an audit trail',
          'Assuming compaction runs immediately'
        ]
      },
      {
        id: 'pipelines-16',
        topic: 'Schema registry',
        level: 2,
        q: 'Why put a schema registry in front of Kafka, and how do compatibility modes (BACKWARD, FORWARD, FULL) decide which schema changes are allowed? Which would you choose for `scan_events`?',
        a: "A schema registry stores versioned schemas (Avro, Protobuf, JSON Schema) per subject. Producers register or look up a schema and embed only a schema ID in each message (in Confluent's wire format, a magic byte plus a 4-byte ID). Consumers fetch the schema by ID to deserialize. This makes payloads compact and, more importantly, lets the registry reject breaking changes before they reach production.\n\nModes, in Confluent Schema Registry terms:\n- **BACKWARD** (the default): consumers using the new schema can read data written with the previous one. Allowed: add a field with a default, delete a field. Upgrade consumers first.\n- **FORWARD**: consumers on the old schema can read data written with the new one. Allowed: add a field, delete a field that had a default. Upgrade producers first.\n- **FULL**: both.\n- Each has a `_TRANSITIVE` variant that checks against all prior versions, not just the latest.\n\nFor `scan_events`, where many consumers upgrade on their own schedule and replay old data, use FULL_TRANSITIVE or at least BACKWARD_TRANSITIVE. Always give new fields defaults, never reuse or retype a field, and in Protobuf never reuse a field number.",
        points: [
          'Registry stores versioned schemas; messages carry a schema ID',
          'BACKWARD: new reader, old data (default); FORWARD: old reader, new data',
          'Transitive variants check all versions',
          'New fields need defaults',
          'Pick the mode by who upgrades first and whether old data is replayed'
        ],
        followups: [
          'How do you rename a field safely in Avro?',
          'What happens to consumers if a producer bypasses the registry?'
        ],
        pitfalls: [
          'Setting compatibility to NONE to get a deploy through',
          'Changing a field type in place'
        ]
      },
      {
        id: 'pipelines-17',
        topic: 'Kafka reliability',
        level: 2,
        q: 'Design dead-letter handling for a consumer of scan events. Which failures go to a dead-letter topic, which are retried, and what does the dead-letter record contain?',
        a: "Separate failure types:\n- **Poison messages** (cannot deserialize, fails schema or validation): retrying never helps. Send to a dead-letter topic and move on so one bad record does not block a partition.\n- **Transient failures** (database down, timeout, 503): retry with backoff, and stop consuming (pause partitions) if the sink stays down. Do not dead-letter these; you would flood the topic and lose ordering for nothing.\n- **Business-rule rejections** (unknown scanner, slide ID that does not exist yet): often dead-letter or park in a retry topic with a delay, since the reference data may arrive later.\n\nThe dead-letter record keeps the original key and value bytes untouched plus headers: error class and message, source topic, partition, offset, consumer group, timestamp, and application version. That lets you replay after a fix.\n\nOperate it: alert on dead-letter rate, give it its own retention, and build a small tool that re-publishes selected records to the original topic. Note that dead-lettering breaks per-key ordering for those records, which is acceptable only if downstream logic tolerates it.",
        points: [
          'Poison messages go to a dead-letter topic; transient errors are retried',
          'Keep original bytes, key, and error metadata in headers',
          'Alert on dead-letter volume',
          'Provide a replay path',
          'Dead-lettering sacrifices ordering for those records'
        ],
        followups: [
          'How do you avoid a retry storm when the sink is down?',
          'Where would a delayed retry topic fit?'
        ],
        pitfalls: [
          'Dead-lettering everything on any exception',
          'Dropping bad messages without keeping the bytes'
        ]
      },
      {
        id: 'pipelines-18',
        topic: 'Pig',
        level: 2,
        q: 'What is Apache Pig, how does Pig Latin compare with HiveQL and Spark, why is it considered legacy, and how would you migrate this script?',
        setup: `scans   = LOAD '/data/scan_events' USING PigStorage(',')
          AS (event_id:long, slide_id:long, scanner_id:int, event_type:chararray, event_ts:chararray);
ends    = FILTER scans BY event_type == 'scan_end';
by_scn  = GROUP ends BY scanner_id;
counts  = FOREACH by_scn GENERATE group AS scanner_id, COUNT(ends) AS n_scans;
ordered = ORDER counts BY n_scans DESC;
STORE ordered INTO '/out/scans_per_scanner' USING PigStorage(',');`,
        setupLang: 'text',
        a: "Pig is a Hadoop-era dataflow tool. Pig Latin is procedural: you name each intermediate relation step by step (`LOAD`, `FILTER`, `GROUP`, `FOREACH`, `STORE`), and the runtime compiles it to MapReduce, and later Tez or Spark. HiveQL is declarative SQL over tables in a metastore. Spark offers DataFrames and SQL, in-memory execution, and a much larger ecosystem.\n\nWhy legacy: Pig depends on Hadoop-era execution engines, it has little new development (check the project status), and talent and tooling have moved to SQL and Spark. Its schema-optional style and Java/Jython UDFs are hard to test and maintain.\n\nMigration approach:\n1. Read the script as a plan, then restate it as SQL or DataFrame steps. Most operators map one to one.\n2. Replace UDFs with built-in functions where possible, otherwise pandas UDFs.\n3. Define the input schema explicitly and write Parquet, not delimited text.\n4. Run old and new in parallel and compare row counts, aggregates, and checksums.\n\nWatch semantics: Pig `COUNT(ends)` skips records where the first field is null (`COUNT_STAR` counts all), and `ORDER` with ties is not guaranteed stable.",
        code: `from pyspark.sql import functions as F

scans = (
    spark.read.schema("event_id long, slide_id long, scanner_id int, event_type string, event_ts string")
    .csv("/data/scan_events")
)

counts = (
    scans.filter(F.col("event_type") == "scan_end")
    .groupBy("scanner_id")
    .agg(F.count("*").alias("n_scans"))      # matches Pig COUNT_STAR; F.count("event_id") would match COUNT
    .orderBy(F.col("n_scans").desc())
)

counts.write.mode("overwrite").parquet("/out/scans_per_scanner")`,
        codeLang: 'python',
        points: [
          'Pig Latin is a procedural dataflow language over Hadoop engines',
          'HiveQL is declarative SQL on the metastore; Spark adds in-memory execution',
          'Legacy: Hadoop-era engines, low activity, shrinking skills',
          'Migrate by mapping operators, replacing UDFs, defining schemas, and parallel-running',
          'Check null and ordering semantics'
        ],
        followups: [
          'How would you validate that the migrated output matches?',
          'What do you do with a Java UDF you cannot port?'
        ],
        pitfalls: [
          'Line-by-line translation that keeps Pig idioms and ignores Spark optimization',
          'Skipping the parallel-run comparison'
        ]
      },
      {
        id: 'pipelines-19',
        topic: 'Change data capture',
        level: 2,
        q: 'You need the lab information system database mirrored into the warehouse. Compare change data capture approaches and describe how you would apply the changes.',
        a: "Three options:\n- **Query-based** (poll `WHERE updated_at > :last`): simple, but it misses hard deletes, can miss rows that change mid-poll, and loads the source with queries.\n- **Trigger-based**: captures deletes but adds write overhead and maintenance in the source schema.\n- **Log-based** (read the database's transaction log, for example Debezium on the MySQL binlog or PostgreSQL WAL): low overhead, captures every insert, update and delete in commit order, and does not touch application tables. This is usually the right answer.\n\nA log-based pipeline starts with a consistent snapshot, then streams changes. Each event carries the operation (create, update, delete, snapshot read), before and after images, and a log position. Publish to Kafka keyed by primary key so changes to one row stay ordered.\n\nApply with a MERGE keyed on the primary key, using the log position to ignore stale or duplicate events, and treat deletes as soft or hard deletes by policy. Handle schema changes explicitly (a registry with compatibility rules). Monitor lag and watch for long snapshots and log retention on the source, since a replication slot that falls behind can fill its disk.",
        points: [
          'Query-based CDC misses hard deletes',
          'Log-based CDC is low impact and complete',
          'Snapshot first, then stream; events carry operation, before/after, and position',
          'Key by primary key to keep per-row order',
          'Apply with MERGE and use position for idempotence'
        ],
        followups: [
          'What happens to the source if the CDC consumer is down for a week?',
          'How do you handle a column type change upstream?'
        ],
        pitfalls: [
          'Using `updated_at` polling and trusting that deletes do not matter',
          'Applying events in arrival order across partitions instead of by key and position'
        ]
      },
      {
        id: 'pipelines-20',
        topic: 'REST integration',
        level: 2,
        q: 'You must pull case and worklist data from a vendor REST API on a schedule. Cover pagination, rate limits, and OAuth2 client-credentials authentication.',
        a: "**Pagination.** Prefer cursor (keyset) pagination: the server returns a `next` token or link. Offset/limit pagination drifts when rows are inserted or deleted mid-run, and deep offsets get slow. Follow the cursor until exhausted, and set a sane page size. For incremental loads, filter by `updated_since` using a stored high-water mark, subtract a small overlap, and deduplicate by ID downstream.\n\n**Rate limits.** Expect HTTP 429 and sometimes `Retry-After`. Honor it, cap concurrency, and use a client-side token bucket to stay under the documented rate instead of bouncing off the limit.\n\n**OAuth2 client credentials.** For machine-to-machine access you POST `grant_type=client_credentials` with the client ID and secret (HTTP Basic or form body, as the provider requires) and a scope to the token endpoint. You get a short-lived access token. There is no user and normally no refresh token: you just request a new one. Cache the token and refresh shortly before `expires_in` elapses (for example 60 seconds early), re-fetch once on a 401, and never log it. Keep the secret in a secret manager, not in code or the DAG file.",
        points: [
          'Cursor pagination over offset pagination',
          'Incremental pull via updated_since with overlap and dedupe',
          'Honor 429 and Retry-After; throttle client-side',
          'Client credentials: token endpoint, short-lived token, cache and refresh early',
          'Secrets in a secret manager'
        ],
        followups: [
          'What if the API only supports offset pagination?',
          'How do you make the whole pull safely re-runnable?'
        ],
        pitfalls: [
          'Requesting a new token on every call',
          'Pulling everything every day instead of incrementally'
        ]
      },
      {
        id: 'pipelines-21',
        topic: 'REST integration',
        level: 2,
        q: 'This helper calls a REST API in a pipeline. List what is wrong with it, then write a better client with exponential backoff and jitter that is safe for writes.',
        setup: `import time
import requests

def get_json(url):
    for _ in range(5):
        r = requests.get(url)
        if r.status_code != 200:
            time.sleep(1)
            continue
        return r.json()`,
        setupLang: 'python',
        a: "Problems: no timeout, so a hung connection blocks forever; a fixed 1 second sleep makes many workers retry in lockstep; it retries permanent errors like 401 and 404 as if they were transient; it ignores `Retry-After`; and after five failures it silently returns `None`, which poisons the pipeline later. It also gives no way to retry a POST safely.\n\nBetter: retry only 429 and 5xx (and network errors), with exponential backoff and full jitter (`uniform(0, min(cap, base * 2**attempt))`) so clients spread out. Honor `Retry-After` when present. Set connect and read timeouts. Fail loudly after a bounded number of attempts.\n\nFor writes, retry only when it is safe: methods that are idempotent by definition (GET, PUT, DELETE), or a POST that carries an `Idempotency-Key` header, so the server can recognize a repeat and return the original result instead of creating a duplicate. Generate the key once per logical operation and reuse it across attempts.",
        code: `import random
import time

import requests

IDEMPOTENT_METHODS = {"GET", "HEAD", "PUT", "DELETE", "OPTIONS"}
RETRYABLE_5XX = {500, 502, 503, 504}


def backoff_delay(attempt: int, base: float = 0.5, cap: float = 30.0) -> float:
    """Full jitter: uniform(0, min(cap, base * 2**attempt))."""
    return random.uniform(0, min(cap, base * 2 ** attempt))


def retry_after_seconds(resp: requests.Response) -> float | None:
    value = resp.headers.get("Retry-After")
    try:
        return float(value) if value is not None else None
    except ValueError:        # an HTTP-date; fall back to backoff
        return None


def call_api(session: requests.Session, method: str, url: str, *,
             idempotency_key: str | None = None, max_attempts: int = 6, **kwargs) -> requests.Response:
    safe_to_retry = method.upper() in IDEMPOTENT_METHODS or idempotency_key is not None
    headers = dict(kwargs.pop("headers", {}))
    if idempotency_key:
        headers["Idempotency-Key"] = idempotency_key
    kwargs.setdefault("timeout", (3.05, 30))      # (connect, read) seconds

    for attempt in range(max_attempts):
        last = attempt == max_attempts - 1
        try:
            resp = session.request(method, url, headers=headers, **kwargs)
        except (requests.ConnectionError, requests.Timeout):
            if last or not safe_to_retry:
                raise
            time.sleep(backoff_delay(attempt))
            continue

        retryable = resp.status_code == 429 or (resp.status_code in RETRYABLE_5XX and safe_to_retry)
        if not retryable or last:
            resp.raise_for_status()    # 4xx other than 429 fail immediately
            return resp
        time.sleep(retry_after_seconds(resp) or backoff_delay(attempt))

    raise RuntimeError("unreachable")`,
        codeLang: 'python',
        points: [
          'Always set timeouts',
          'Retry only transient errors: 429, 5xx, network failures',
          'Exponential backoff with jitter, capped; honor Retry-After',
          'Idempotency keys make POST retries safe',
          'Fail loudly after bounded attempts'
        ],
        followups: [
          'Why jitter, and what does "full jitter" mean compared with equal jitter?',
          'How would you add a circuit breaker?'
        ],
        pitfalls: [
          'Retrying non-idempotent POSTs without a key and creating duplicates',
          'Unbounded retries that hide an outage'
        ]
      },
      {
        id: 'pipelines-22',
        topic: 'Spark skew',
        level: 3,
        q: 'A Spark aggregation over scan events has 199 tasks that finish in seconds and one that runs for an hour and spills. Diagnose it and walk through the fixes: partition count, AQE, and salting.',
        a: "That pattern is data skew: one key holds a disproportionate share of rows, so one shuffle partition is huge. Confirm in the Spark UI: the stage's max task duration and shuffle read size far exceed the median. Then find the key (`groupBy(key).count().orderBy(desc)`). Typical causes are sentinel or default values (`slide_id = -1`, null scanner IDs from a misconfigured device) and genuinely hot entities. Spark already pre-aggregates built-in `count`, `sum`, `min` and `max` on the map side, so a hot key rarely hurts those much; an hour-long task usually means an aggregate that keeps every value per key (`collect_list`, exact percentiles, a grouped pandas UDF), a window partitioned by the hot key, or a join in the same stage.\n\nFixes, in order:\n1. **Fix the data.** Filter or route sentinel and null keys before the shuffle. Often that is the whole problem.\n2. **Right-size partitions.** `spark.sql.shuffle.partitions` defaults to 200. Too few means giant tasks, too many means tiny ones. AQE (on by default since 3.2) coalesces small partitions at runtime.\n3. **AQE skew join.** With `spark.sql.adaptive.skewJoin.enabled`, Spark splits oversized partitions of a sort-merge join at runtime. It does not help a plain `groupBy`, and thresholds and defaults vary by version.\n4. **Salting.** Add a random salt to the key, aggregate by `(key, salt)`, then aggregate again by key. This works when the aggregate can be combined in two stages; the code shows the shape. For joins, salt the large side and replicate the other side across all salt values.",
        code: `from pyspark.sql import functions as F

N_SALT = 16

partial = (
    events
    .withColumn("salt", (F.rand() * N_SALT).cast("int"))
    .groupBy("scanner_id", "salt")
    .agg(F.count("*").alias("n"), F.max("event_ts").alias("last_ts"))
)

final = (
    partial.groupBy("scanner_id")
    .agg(F.sum("n").alias("n"), F.max("last_ts").alias("last_ts"))
)`,
        codeLang: 'python',
        points: [
          'Recognize skew from the UI: max vs median task time and shuffle read',
          'Identify the hot key before choosing a fix',
          'Filter sentinel and null keys first',
          'AQE coalescing and skew-join splitting help joins, not every aggregate',
          'Salting with two-stage aggregation for decomposable functions'
        ],
        followups: [
          'How do you salt a join where both sides are large?',
          'Why does salting not work directly for a distinct count?'
        ],
        pitfalls: [
          'Raising shuffle partitions blindly; one hot key still lands in one partition',
          'Using salting for non-decomposable aggregates like median'
        ]
      },
      {
        id: 'pipelines-23',
        topic: 'Imaging at scale',
        level: 3,
        q: 'Why should you not load whole-slide images into a Spark DataFrame as binary rows and process them row by row? What do you do instead to compute tissue statistics for every tile of a million slides?',
        a: "A whole-slide image is far too big to be a row. Take 100,000 x 80,000 pixels: 8 billion pixels, about 24 GB as raw RGB, and still around a gigabyte or more compressed. Spark cells and JVM arrays top out near 2 GB, executors would need the whole file in memory, a single huge task defeats parallelism, and the pyramidal formats (SVS, NDPI, DICOM WSI) exist precisely so you can read small regions without decoding everything.\n\nInstead, make the DataFrame carry pointers and work units, not pixels:\n- A table of slides with `uri`, dimensions and `mpp`.\n- Expand it into a tile grid (`slide_id`, `x`, `y`, `w`, `h`) with `sequence` and `explode`.\n- Process on executors with `mapInPandas` (or `mapPartitions`). Open each slide once per partition, read regions at the pyramid level you need, compute small outputs (tissue fraction, feature vectors, scores), and return only those.\n- Repartition by `slide_id` so one handle serves many tiles and reads stay local, balancing against skew from huge slides.\n- Make sure the native library (OpenSlide) and the files are available to executors; OpenSlide needs a local or mounted path, and its handles are not serializable.\n\nGPU inference is usually better run as a batch service or dedicated workers fed by this tile table.",
        code: `import pandas as pd
from pyspark.sql import functions as F

TILE = 2048
OUT_SCHEMA = "slide_id long, x int, y int, tissue_fraction double"

tiles = (
    slides.select("slide_id", "uri", "width_px", "height_px")
    .withColumn("x", F.explode(F.sequence(F.lit(0), F.col("width_px") - 1, F.lit(TILE))))
    .withColumn("y", F.explode(F.sequence(F.lit(0), F.col("height_px") - 1, F.lit(TILE))))
    .withColumn("w", F.least(F.lit(TILE), F.col("width_px") - F.col("x")))
    .withColumn("h", F.least(F.lit(TILE), F.col("height_px") - F.col("y")))
    .repartition(400, "slide_id")
)


def tissue_stats(batches):
    import numpy as np
    import openslide

    handles = {}
    try:
        for pdf in batches:
            rows = []
            for r in pdf.itertuples(index=False):
                slide = handles.get(r.uri)
                if slide is None:
                    slide = handles[r.uri] = openslide.OpenSlide(r.uri)
                tile = slide.read_region((int(r.x), int(r.y)), 0, (int(r.w), int(r.h))).convert("RGB")
                gray = np.asarray(tile).mean(axis=2)
                rows.append((r.slide_id, r.x, r.y, float((gray < 220).mean())))  # crude tissue threshold
            yield pd.DataFrame(rows, columns=["slide_id", "x", "y", "tissue_fraction"])
    finally:
        for s in handles.values():
            s.close()


stats = tiles.mapInPandas(tissue_stats, schema=OUT_SCHEMA)
stats.write.mode("overwrite").parquet("s3a://lake/derived/tissue_stats/")`,
        codeLang: 'python',
        points: [
          'A gigapixel image is too large for a cell; sizes reach tens of GB uncompressed',
          'DataFrame rows hold paths and tile coordinates, not pixels',
          'Read regions on executors (mapInPandas or mapPartitions), one handle per slide per partition',
          'Return small derived results, never pixels',
          'Executors need the native library and file access; handles are not serializable',
          'Repartition by slide for locality, watching skew'
        ],
        followups: [
          'How do you pick tile size and pyramid level?',
          'Where would GPU inference fit in this design?'
        ],
        pitfalls: [
          'Using the `binaryFile` source on multi-gigabyte slides',
          'Opening the slide inside the per-tile loop'
        ]
      },
      {
        id: 'pipelines-24',
        topic: 'Late data',
        level: 3,
        q: 'Explain watermarks in Structured Streaming and how late and duplicate scan events are handled. Show an hourly per-scanner count that tolerates 30 minutes of lateness.',
        a: "A watermark tells the engine how late data may be. Spark tracks the maximum event time seen so far and sets the watermark to that minus the threshold (here 30 minutes). It is computed at the end of a batch and applied from the next one. Consequences:\n- A window stays open and updatable until the watermark passes its end, then its state is dropped, which bounds memory.\n- In append mode a window is emitted only when it closes, so results are delayed by about the threshold.\n- The guarantee is one-sided: events within the threshold are processed. Events later than that may be dropped, though the engine does not promise to drop all of them.\n- A watermark does not make late data appear later; for true corrections, run a periodic batch recompute (a reconciliation pass) over the affected days.\n\nDuplicates come from at-least-once delivery and retries. Deduplicate on a stable ID: `dropDuplicates([\"event_id\", \"event_ts\"])` after `withWatermark` lets Spark drop old dedup state. Spark 3.5 adds `dropDuplicatesWithinWatermark`, which handles duplicates whose event times differ slightly.\n\nStream-stream joins also need watermarks and a time-range condition for state cleanup.",
        code: `from pyspark.sql import functions as F

hourly = (
    events                                           # parsed stream with event_id, scanner_id, event_ts
    .filter(F.col("event_type") == "scan_end")
    .withWatermark("event_ts", "30 minutes")
    .dropDuplicates(["event_id", "event_ts"])
    .groupBy(F.window("event_ts", "1 hour"), "scanner_id")
    .agg(F.count("*").alias("scans"))
)

query = (
    hourly.writeStream
    .outputMode("append")                            # window emitted once the watermark passes its end
    .format("parquet")
    .option("path", "s3a://lake/silver/scanner_hourly/")
    .option("checkpointLocation", "s3a://lake/_checkpoints/scanner_hourly/")
    .start()
)`,
        codeLang: 'python',
        points: [
          'Watermark equals max event time minus threshold',
          'Windows close and state is dropped when the watermark passes them',
          'Append mode emits a window only after it closes',
          'Data inside the threshold is guaranteed; later data may be dropped',
          'Deduplicate on a stable ID with the event-time column; 3.5 adds dropDuplicatesWithinWatermark',
          'Corrections for very late data need a batch reconciliation'
        ],
        followups: [
          'A scanner comes back after a day offline and flushes its buffer. What happens to those events, and how do you recover them?',
          'How would you pick the lateness threshold?'
        ],
        pitfalls: [
          'Applying `withWatermark` on a column other than the one used in the window',
          'Setting a huge threshold and exhausting state memory'
        ]
      },
      {
        id: 'pipelines-25',
        topic: 'Exactly-once',
        level: 3,
        q: 'What does the Structured Streaming checkpoint contain, and how do you get exactly-once results into a table when the sink is written from `foreachBatch`?',
        a: "The checkpoint directory holds the query's progress: an offsets log (the offset range of each planned batch, written before the batch runs), a commits log (batches that completed), and state store data for stateful operators. It lives on durable storage, one per query, and cannot be shared.\n\nOn restart, Spark compares the logs. If a batch was planned but not committed, it re-runs that same batch with the same offsets. So the engine gives exactly-once processing only if the source is replayable (Kafka offsets, files) and the sink is idempotent. The built-in file sink achieves this with a metadata log. A Kafka sink is at-least-once. A `foreachBatch` write is at-least-once by default, because a crash after your write but before the commit replays the batch.\n\nMake it effectively exactly-once by making the write idempotent: an insert-only `MERGE` keyed on `event_id` (Delta Lake or Iceberg), or tag writes with `batch_id` and replace that batch's output. Delta also offers idempotent-write options (`txnAppId`, `txnVersion`) for this.\n\nAlso: query changes that alter state or the checkpointed plan can make the checkpoint incompatible, so version your queries deliberately. Deleting the checkpoint means losing position and state.",
        code: `def upsert_batch(batch_df, batch_id: int) -> None:
    # Replays of the same batch are harmless: matched rows are skipped.
    batch_df.dropDuplicates(["event_id"]).createOrReplaceTempView("updates")
    # the temp view lives in the micro-batch's session, not the outer spark session
    batch_df.sparkSession.sql("""
        MERGE INTO silver.scan_events AS t
        USING updates AS s
        ON t.event_id = s.event_id
        WHEN NOT MATCHED THEN INSERT *
    """)


query = (
    events.writeStream
    .foreachBatch(upsert_batch)
    .option("checkpointLocation", "s3a://lake/_checkpoints/scan_events_silver/")
    .start()
)`,
        codeLang: 'python',
        points: [
          'Checkpoint holds offsets log, commits log, and state',
          'A planned-but-uncommitted batch is re-run with the same offsets',
          'Exactly-once needs a replayable source and an idempotent sink',
          'foreachBatch is at-least-once unless the write is idempotent',
          'MERGE on a key or batch-id-tagged writes give idempotence',
          'Checkpoint compatibility limits query changes'
        ],
        followups: [
          'What changes if the sink is a REST API rather than a table?',
          'How would you migrate a query to new logic without losing state?'
        ],
        pitfalls: [
          'Claiming the engine alone guarantees exactly-once to any sink',
          'Reusing one checkpoint directory for two queries'
        ]
      },
      {
        id: 'pipelines-26',
        topic: 'Exactly-once',
        level: 3,
        q: 'Explain Kafka exactly-once semantics: the idempotent producer, transactions, and `read_committed`. Where does the guarantee stop?',
        a: "Three layers:\n- **Idempotent producer** (`enable.idempotence=true`, the default for the Java client since Kafka 3.0): the broker dedups retries using a producer ID and per-partition sequence numbers, so retries cannot create duplicates or reorder within a partition. Scope: one producer session and one partition.\n- **Transactions** (`transactional.id`): a producer atomically writes to several partitions and topics, and can include consumer offsets in the same transaction (`send_offsets_to_transaction`). A consume-transform-produce loop then commits its output and its input position together, or neither. The epoch of the `transactional.id` fences zombie instances.\n- **`isolation.level=read_committed`** on consumers: they see only committed transactional messages and skip aborted ones.\n\nWhere it stops: the guarantee holds for data that begins and ends in Kafka (and in Kafka Streams with `processing.guarantee=exactly_once_v2`). A write to a database, an API or a file is outside the transaction. There you need an idempotent sink or a transactional outbox, which is why most pipelines use at-least-once delivery plus idempotent writes. Transactions also add latency and operational complexity, and read_committed consumers can be delayed by a long-open transaction.",
        points: [
          'Idempotent producer dedups retries per partition via sequence numbers',
          'Transactions are atomic across partitions and include offsets',
          'transactional.id plus epoch fences zombies',
          'Consumers must use read_committed',
          'Guarantee ends at Kafka\'s boundary; external sinks need idempotence',
          'Costs: latency, complexity, stalled read_committed consumers'
        ],
        followups: [
          'What happens to a read_committed consumer when a producer hangs mid-transaction?',
          'Why is at-least-once plus an idempotent sink often preferred?'
        ],
        pitfalls: [
          'Saying exactly-once means each message is delivered over the network once',
          'Forgetting to set read_committed on the downstream consumer'
        ]
      },
      {
        id: 'pipelines-27',
        topic: 'Kafka capacity',
        level: 3,
        q: 'How do you size partitions for a `scan-events` topic? Estimate: 60 scanners at 1 message per second, about 2 KB each, and you want to be able to rebuild a downstream table by replaying 7 days of data in one hour. Include what happens when consumers fall behind.',
        a: "Sustained rate: 60 msg/s x 2 KB = 120 KB/s, trivially small for one partition. Throughput of the live stream does not decide the count. Replay and parallelism do.\n\nReplay volume: 120 KB/s x 604,800 s is about 72 GB. To read that in one hour needs about 20 MB/s. If one consumer handling one partition (parse, enrich, write) sustains about 3 MB/s (measure this, do not assume), you need at least 7 partitions. Round up with headroom for key skew and for divisibility across consumer counts: 12 is reasonable.\n\nGeneral formula: partitions >= max(target throughput / per-partition producer throughput, target throughput / per-partition consumer throughput), then add headroom. Constraints: you can add partitions later but never remove them, and adding remaps keys, which breaks per-key order across the change. More partitions mean more open files, more replication work, slower leader election, and more memory on the broker and client.\n\nBackpressure: Kafka consumers pull, so a slow consumer simply lags. Watch consumer lag and time-lag, alert on growth, scale consumers up to the partition count, pause partitions if a sink is down, and in Spark cap batch size with `maxOffsetsPerTrigger`. Lag only turns into data loss if it exceeds retention.",
        points: [
          'Live throughput is tiny; replay and consumer parallelism drive the count',
          '120 KB/s x 7 days is about 72 GB; one hour needs about 20 MB/s',
          'Divide by measured per-partition consumer throughput; round up with headroom',
          'Partitions can be added, not removed, and adding remaps keys',
          'Backpressure shows up as lag; control with pause, scaling, and rate caps',
          'Lag beyond retention means data loss'
        ],
        followups: [
          'What would change if messages were 200 KB instead of 2 KB?',
          'How do you alert on lag in a way that does not page for normal bursts?'
        ],
        pitfalls: [
          'Sizing only from the steady-state rate',
          'Creating thousands of partitions per topic just in case'
        ]
      },
      {
        id: 'pipelines-28',
        topic: 'Architecture',
        level: 3,
        q: 'Compare lambda and kappa architectures for slide-inference results that must be available within seconds but also recomputed when a model version changes. What would you build today?',
        a: "**Lambda**: a batch layer recomputes accurate views from all history, a speed layer provides low-latency approximations from the stream, and a serving layer merges them. The benefit is robustness and a clean place for big reprocessing. The cost is two code paths that must agree: logic written twice (for example in SQL and in a streaming job), two sets of bugs, and reconciliation of mismatched results.\n\n**Kappa**: everything is a stream. The log (Kafka with long retention, or the lake) is the source of truth. To change logic or recompute, you deploy new code and replay from the start into a new output, then switch over. One code path, but replay needs a retained, replayable log and enough throughput, and some computations over huge history are awkward as streams.\n\nWhat I would build today is a hybrid that removes the duplicated logic: the same engine and transformations run in streaming mode for freshness and in batch mode (`availableNow`, or a backfill with a date range) for reprocessing, writing to an ACID table format (Delta, Iceberg, Hudi) that supports upserts and snapshot reads. When the model version changes, backfill into a new version column or table and compare before switching. Keep raw events immutable so any derived layer can be rebuilt.",
        points: [
          'Lambda: batch, speed, serving layers; duplicated logic is the main cost',
          'Kappa: one stream path; reprocess by replaying a retained log',
          'Replay needs retention, throughput, and a cutover plan',
          'Modern hybrid: one codebase for streaming and backfill on an ACID table format',
          'Keep raw events immutable'
        ],
        followups: [
          'How do you cut over from the old output to the replayed one safely?',
          'What breaks when the stream and the backfill disagree?'
        ],
        pitfalls: [
          'Treating kappa as free of reprocessing cost',
          'Letting the batch and streaming versions of a metric drift apart'
        ]
      },
      {
        id: 'pipelines-29',
        topic: 'Table formats',
        level: 3,
        q: 'What do Delta Lake, Apache Iceberg and Apache Hudi add on top of Parquet files in object storage? Explain ACID, time travel and schema evolution, and where they differ.',
        a: "Plain Parquet in a directory has no transactions: a failed write leaves partial files, readers can see half-finished output, and there is no safe update or delete. Table formats add a metadata layer that tracks exactly which files make up each version of the table.\n\n- **ACID**: Delta keeps a transaction log (`_delta_log`, JSON commits plus periodic Parquet checkpoints). Iceberg uses a tree of metadata files, manifest lists and manifests, with an atomic pointer swap in the catalog. Hudi keeps a timeline of instants. Writers commit atomically using optimistic concurrency, readers see a consistent snapshot, and `MERGE`, `UPDATE` and `DELETE` work.\n- **Time travel**: older snapshots can be queried by version or timestamp, useful for audits and for reproducing the exact input of a past model run. Cleaning up (`VACUUM`, `expire_snapshots`) removes that history.\n- **Schema evolution**: add, drop and (depending on format and version) widen columns without rewriting data. Iceberg tracks columns by ID, so renames are safe; Delta needs column mapping for renames and drops.\n\nDifferences: Iceberg has hidden partitioning and partition evolution and is widely engine-neutral. Delta is tightest with Spark and Databricks. Hudi is upsert-first with copy-on-write and merge-on-read table types and incremental pulls. Engine and catalog support varies, so check your stack. All need regular compaction.",
        points: [
          'Metadata layer tracks the file set per table version',
          'Atomic commits and snapshot reads; MERGE, UPDATE, DELETE',
          'Time travel by version or timestamp; vacuuming removes it',
          'Schema evolution without rewrites; Iceberg uses column IDs',
          'Differences: Iceberg partition evolution, Delta Spark depth, Hudi upsert and merge-on-read',
          'Compaction is still needed'
        ],
        followups: [
          'What happens when two writers commit to the same table at once?',
          'How would you use time travel to reproduce a model run from last month?'
        ],
        pitfalls: [
          'Calling them file formats; they are table formats over Parquet or ORC',
          'Vacuuming aggressively and then promising 90 days of time travel'
        ]
      },
      {
        id: 'pipelines-30',
        topic: 'REST integration',
        level: 3,
        q: 'A vendor system offers both webhooks and a polling API for case status changes. Compare them and design a receiver you would trust for slides that must not be missed.',
        a: "**Polling**: you control the rate, state, and retries, and it only needs outbound connectivity, which is often the only option across restricted lab networks. Cost: latency equals the poll interval, wasted calls, and rate limit pressure.\n\n**Webhooks**: low latency and little wasted work. But delivery is at-least-once at best, events can arrive out of order or be dropped when your endpoint is down, and you must expose a public endpoint and defend it.\n\nA trustworthy design uses both:\n- Receiver does the minimum: verify the HMAC signature (constant-time comparison, and a timestamp check to limit replays), validate, write the raw payload to a durable queue or topic, and return 2xx quickly. Processing happens asynchronously.\n- Deduplicate on the event ID, and expect out-of-order delivery. Prefer treating the webhook as a hint, then fetch the current state from the API, or compare event versions or timestamps.\n- Run a reconciliation poll on a schedule (for example every 15 minutes with an `updated_since` overlap) to catch anything that was missed.\n- Alert on webhook silence, signature failures, and queue lag.\n\nWebhooks for speed, polling for correctness.",
        points: [
          'Polling is simple and controllable but has latency and cost',
          'Webhooks are fast but at-least-once, unordered, and can be missed',
          'Verify signatures and timestamps; enqueue first, process later',
          'Deduplicate by event ID and handle reordering',
          'Reconciliation polling closes the gaps',
          'Monitor for silence and failures'
        ],
        followups: [
          'What do you return to the sender while your downstream is down?',
          'How do you rotate the webhook signing secret without dropping events?'
        ],
        pitfalls: [
          'Doing the full processing inside the HTTP handler',
          'Trusting webhook order and payload without verifying the signature'
        ]
      }
    ],
    glossary: [
      { term: 'Shuffle', def: 'Redistribution of data across partitions and machines so that rows with the same key meet. It involves disk and network, and it is the main cost in Spark.' },
      { term: 'AQE', def: 'Adaptive query execution. Spark re-optimizes the plan at runtime using actual shuffle statistics: coalescing partitions, switching join strategies, splitting skewed partitions. On by default since Spark 3.2.' },
      { term: 'Watermark', def: 'In streaming, the point in event time before which the engine assumes no more data will arrive. It is the maximum event time seen minus an allowed lateness, and it controls when state is dropped.' },
      { term: 'Consumer lag', def: 'How far a consumer group is behind the end of a Kafka partition, in messages or time. Rising lag means the consumers are not keeping up.' },
      { term: 'Tombstone', def: 'A Kafka record with a key and a null value, used in compacted topics to mark that key for deletion.' },
      { term: 'Idempotent sink', def: 'A write that produces the same result when applied more than once, for example an upsert keyed on a unique ID. It turns at-least-once delivery into effectively exactly-once results.' },
      { term: 'Dead-letter topic', def: 'A separate topic that receives messages a consumer cannot process, kept with error context so they can be inspected and replayed.' },
      { term: 'Change data capture', def: 'Capturing inserts, updates and deletes from a source database, ideally from its transaction log, and streaming them downstream.' },
      { term: 'Metastore', def: 'A catalog service that records table schemas, formats, locations and partitions. Hive introduced it; Spark and Trino reuse it.' },
      { term: 'Idempotency key', def: 'A client-generated identifier sent with a write request so the server can recognize a retry and return the original result instead of repeating the action.' }
    ]
  });
})();
