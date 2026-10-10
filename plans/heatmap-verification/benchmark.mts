import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import { performance } from "node:perf_hooks";
import type { QuerySpec } from "../../server/src/api/analytics/utils/analyticsQuery.js";

const requireServer = createRequire(new URL("../../server/package.json", import.meta.url));
const { createClient } = requireServer("@clickhouse/client");
const directory = new URL("./", import.meta.url);
const mode = process.argv[2];
const ROWS = 1_000_000;
const SITES = 100;
const BATCH_ROWS = 20_000;
const RUNS = 30;

const percentile = (values: number[], proportion: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * proportion) - 1)];
};
function distribution(samples: number[]) {
  return {
    samples: samples.length,
    minMs: Math.min(...samples),
    p50Ms: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    maxMs: Math.max(...samples),
    samplesMs: samples,
  };
}
const uuid = (input: string) => {
  const hash = createHash("sha256").update(input).digest("hex").slice(0, 32);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`;
};
const numeric = (row: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : value,
    ])
  );

if (mode === "compare") {
  const lz4 = JSON.parse(await readFile(new URL("benchmark-lz4.json", directory), "utf8"));
  const zstd = JSON.parse(await readFile(new URL("benchmark-zstd.json", directory), "utf8"));
  const evidence = {
    recordedAt: new Date().toISOString(),
    fixture: lz4.fixture,
    hardware: lz4.hardware,
    codecs: { lz4, zstd },
    comparison: {
      zstdCompressedBytesReductionPercent:
        (1 - zstd.storage.afterMerge.dataCompressedBytes / lz4.storage.afterMerge.dataCompressedBytes) * 100,
      zstdDiskBytesReductionPercent:
        (1 - zstd.storage.afterMerge.bytesOnDisk / lz4.storage.afterMerge.bytesOnDisk) * 100,
      zstdInsertP95Ratio: zstd.insert.p95Ms / lz4.insert.p95Ms,
      zstdSelectedReadP95Ratio: zstd.reads.selectedPoints.p95Ms / lz4.reads.selectedPoints.p95Ms,
    },
    acceptance: {
      lz4SelectedPageUnder1Second: lz4.reads.selectedReport.p95Ms < 1000,
      lz4OverviewUnder2Seconds: lz4.reads.overview.p95Ms < 2000,
      zstdSelectedPageUnder1Second: zstd.reads.selectedReport.p95Ms < 1000,
      zstdOverviewUnder2Seconds: zstd.reads.overview.p95Ms < 2000,
    },
    limitations: [
      "Synthetic interaction fixture; renderer alignment uses separately recorded browser interactions.",
      "Warm, sequential queries after an explicit merge; cold cache, concurrent visitors and production VPS behavior are not measured.",
      "Insert batches combine 20,000 rows across sites; browser upload latency and a single producer's 100-event upload are not measured.",
      "No replay bytes/session comparison: the local instance has no same-sampling retained replay workload.",
    ],
  };
  await writeFile(new URL("benchmark-evidence.json", directory), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ acceptance: evidence.acceptance, comparison: evidence.comparison }));
  process.exit(0);
}

if (mode !== "lz4" && mode !== "zstd") throw new Error("Expected lz4, zstd or compare");
const database = `rybbit_heatmap_benchmark_${Date.now()}_${mode}`;
if (!/^rybbit_heatmap_benchmark_\d+_(lz4|zstd)$/.test(database)) throw new Error("Unsafe benchmark database");
process.env.CLICKHOUSE_DB = database;
process.env.CLICKHOUSE_HOST ||= "http://clickhouse:8123";
const admin = createClient({
  url: process.env.CLICKHOUSE_HOST,
  database: "default",
  password: process.env.CLICKHOUSE_PASSWORD,
  request_timeout: 300_000,
});
const client = createClient({
  url: process.env.CLICKHOUSE_HOST,
  database,
  password: process.env.CLICKHOUSE_PASSWORD,
  request_timeout: 300_000,
  clickhouse_settings: { date_time_input_format: "best_effort", max_execution_time: 60 },
});
let created = false;
let applicationClient: { close(): Promise<void> } | undefined;
let applicationQueryClient: { close(): Promise<void> } | undefined;

try {
  await admin.command({ query: `CREATE DATABASE ${database}` });
  created = true;
  const { HEATMAP_TABLE_SQL } = await import("../../server/dist/db/clickhouse/schema/heatmaps.js");
  const queryModule = await import("../../server/dist/services/heatmaps/heatmapQueryService.js");
  const appClients = await import("../../server/dist/db/clickhouse/client.js");
  applicationClient = appClients.clickhouse;
  applicationQueryClient = appClients.clickhouseQuery;
  const {
    HeatmapQueryService,
    buildHeatmapPointsQuery,
    buildHeatmapPagesQuery,
    buildHeatmapScrollQuery,
    buildHeatmapSummaryQuery,
  } = queryModule;
  const createHeatmaps = HEATMAP_TABLE_SQL.replace(/ CODEC\([^\n]*?\)(?=,?$)/gm, "")
    .split("\n")
    .map((line: string) => {
      if (!/^\s{4}[a-z_]\w*\s/.test(line)) return line;
      const codec = mode === "lz4" ? "LZ4" : "ZSTD(1)";
      return line.endsWith(",") ? `${line.slice(0, -1)} CODEC(${codec}),` : `${line} CODEC(${codec})`;
    })
    .join("\n");
  await client.command({ query: createHeatmaps });
  await client.command({
    query: `CREATE TABLE events (
    site_id UInt32, timestamp DateTime('UTC'), timestamp_ms DateTime64(3, 'UTC'), session_id String,
    user_id String, identified_user_id String, pathname LowCardinality(String), hostname LowCardinality(String),
    type LowCardinality(String), country LowCardinality(String), tag LowCardinality(String),
    event_name String, page_title String, querystring String, channel LowCardinality(String), referrer String,
    url_parameters Map(String,String)
  ) ENGINE=MergeTree ORDER BY (site_id,timestamp,session_id)`,
  });

  async function query(spec: QuerySpec) {
    const result = await client.query({ query: spec.query, query_params: spec.params, format: "JSONEachRow" });
    return (await result.json()).map(numeric);
  }
  const [clock] = await query({
    query:
      "SELECT toString(toDate(now(), 'UTC')) AS today, toUnixTimestamp(toStartOfDay(now(), 'UTC') - INTERVAL 14 DAY) AS start",
  });
  const start = Number(clock.start) * 1000;
  const startDate = new Date(start).toISOString().slice(0, 10);
  const endDate = String(clock.today);
  const startTime = performance.now();
  const insertSamples: number[] = [];
  let jsonPayloadBytes = 0;
  let sampledSessions = 0;
  let analyticsRows = 0;
  let longSessionPayloadBytes = 0;
  let ordinarySessionPayloadBytes = 0;
  const sessionMetadata = new Map<string, { user: string; visit: string; batch: string }>();
  for (let offset = 0; offset < ROWS; offset += BATCH_ROWS) {
    const rows: Record<string, unknown>[] = [];
    const events: Record<string, unknown>[] = [];
    for (let n = offset; n < Math.min(ROWS, offset + BATCH_ROWS); n++) {
      const site = (n % SITES) + 1;
      const index = Math.floor(n / SITES);
      const long = index >= 9000;
      const sessionIndex = long ? 450 : Math.floor(index / 20);
      const interaction = long ? index - 9000 : index % 20;
      const session = uuid(`session:${site}:${sessionIndex}`);
      if (!sessionMetadata.has(session)) {
        sampledSessions++;
        sessionMetadata.set(session, {
          user: createHash("sha256").update(`visitor:${site}:${sessionIndex}`).digest("hex"),
          visit: uuid(`visit:${site}:${sessionIndex}`),
          batch: uuid(`batch:${site}:${sessionIndex}`),
        });
      }
      const metadata = sessionMetadata.get(session)!;
      const batch = long ? uuid(`longbatch:${site}:${Math.floor(interaction / 100)}`) : metadata.batch;
      const bucket = long ? 1440 : sessionIndex % 10 < 8 ? 375 : sessionIndex % 2 === 0 ? 768 : 1440;
      const viewportWidth = bucket + (sessionIndex % 7);
      const viewportHeight = bucket === 375 ? 812 : 900;
      const documentHeight = long ? 120_000 : 2000 + (sessionIndex % 5) * 1000;
      const pageX = Number((((interaction * 31 + sessionIndex * 17) % viewportWidth) + sessionIndex / 1000).toFixed(3));
      const pageY = Number(
        (((interaction * 113 + sessionIndex * 53) % (documentHeight - 1)) + sessionIndex / 1000).toFixed(3)
      );
      const scroll = long ? interaction % 10 === 9 : interaction >= 18;
      const pathname = long ? "/long" : sessionIndex % 10 === 0 ? `/docs/${sessionIndex % 7}` : "/landing";
      const timestamp = new Date(
        start + ((sessionIndex * 2417 + interaction * 17) % (14 * 86400)) * 1000
      ).toISOString();
      const row = {
        site_id: site,
        session_id: session,
        user_id: metadata.user,
        identified_user_id: "",
        timestamp,
        page_visit_id: metadata.visit,
        batch_id: batch,
        event_index: long ? interaction % 100 : interaction,
        type: scroll ? "scroll" : "click",
        hostname: `site${site}.benchmark.test`,
        pathname,
        viewport_bucket: bucket,
        viewport_width: viewportWidth,
        viewport_height: viewportHeight,
        document_width: viewportWidth,
        document_height: documentHeight,
        client_x: scroll ? null : pageX,
        client_y: scroll ? null : pageY % viewportHeight,
        page_x: scroll ? null : pageX,
        page_y: scroll ? null : pageY,
        max_depth: scroll ? Math.min(100, long ? (interaction + 1) / 10 : ((sessionIndex % 10) + 1) * 10) : null,
      };
      const bytes = Buffer.byteLength(JSON.stringify(row)) + 1;
      jsonPayloadBytes += bytes;
      if (site === 37 && long) longSessionPayloadBytes += bytes;
      if (site === 37 && sessionIndex === 1) ordinarySessionPayloadBytes += bytes;
      rows.push(row);
      if (interaction < 2)
        events.push({
          site_id: site,
          timestamp,
          timestamp_ms: timestamp,
          session_id: session,
          user_id: metadata.user,
          identified_user_id: "",
          pathname,
          hostname: row.hostname,
          type: interaction === 0 ? "pageview" : "custom_event",
          country: ["GB", "DE", "US", "FR"][sessionIndex % 4],
          tag: "benchmark",
          event_name: interaction === 0 ? "" : "checkout",
          page_title: "Benchmark landing",
          querystring: "",
          channel: "Organic Search",
          referrer: "https://search.test/",
          url_parameters: { utm_source: "benchmark" },
        });
    }
    const before = performance.now();
    await client.insert({
      table: "heatmap_events",
      values: rows,
      format: "JSONEachRow",
      clickhouse_settings: { async_insert: 1, wait_for_async_insert: 1 },
    });
    insertSamples.push(performance.now() - before);
    await client.insert({ table: "events", values: events, format: "JSONEachRow" });
    analyticsRows += events.length;
    if ((offset / BATCH_ROWS + 1) % 10 === 0)
      console.log(JSON.stringify({ codec: mode, inserted: offset + rows.length, total: ROWS }));
  }
  const insertElapsedMs = performance.now() - startTime;
  async function storage(table = "heatmap_events") {
    const [row] = await query({
      query: `SELECT sum(rows) AS rows, count() AS activeParts,
      sum(bytes_on_disk) AS bytesOnDisk, sum(data_compressed_bytes) AS dataCompressedBytes,
      sum(data_uncompressed_bytes) AS dataUncompressedBytes, sum(primary_key_bytes_in_memory) AS primaryKeyBytesInMemory
      FROM system.parts WHERE active AND database = {database:String} AND table = {table:String}`,
      params: { database, table },
    });
    return row;
  }
  const beforeMerge = await storage();
  await client.command({
    query: "OPTIMIZE TABLE heatmap_events FINAL",
    clickhouse_settings: { max_execution_time: 120 },
  });
  await client.command({ query: "OPTIMIZE TABLE events FINAL", clickhouse_settings: { max_execution_time: 120 } });
  const afterMerge = await storage();
  if (afterMerge.rows !== ROWS) throw new Error(`Expected ${ROWS} rows, saw ${afterMerge.rows}`);
  const [shape] = await query({
    query: `SELECT uniqExact(site_id) AS sites, uniqExact(session_id) AS sampledSessions,
    countIf(type='click') AS clicks, countIf(type='scroll') AS scrollUpdates FROM heatmap_events`,
  });
  if (shape.sites !== SITES || shape.sampledSessions !== sampledSessions)
    throw new Error("Unexpected fixture cardinality");
  const selected = {
    mode: "click" as const,
    hostname: "site37.benchmark.test",
    pathname: "/landing",
    bucket: 375 as const,
    start_date: startDate,
    end_date: endDate,
    time_zone: "UTC",
  };
  const overview = { mode: "click" as const, start_date: startDate, end_date: endDate, time_zone: "UTC" };
  const filtered = { ...selected, filters: JSON.stringify([{ parameter: "country", type: "equals", value: ["DE"] }]) };
  const service = new HeatmapQueryService();
  const checks = {
    selectedPoints: () => query(buildHeatmapPointsQuery(selected, 37)),
    overview: () => query(buildHeatmapPagesQuery(overview, 37)),
    filteredSelected: () => query(buildHeatmapPointsQuery(filtered, 37)),
    scroll: () => query(buildHeatmapScrollQuery(selected, 37)),
    selectedReport: () => service.getHeatmaps(37, selected, "benchmark.test"),
  };
  const [summary] = await query(buildHeatmapSummaryQuery(selected, 37));
  const firstReport = await checks.selectedReport();
  if (firstReport.points.length !== 5000 || !firstReport.truncated.points || summary.count !== 5670) {
    throw new Error(
      `Expected >5000 unique hot-page points/count5670, saw ${firstReport.points.length}/${summary.count}`
    );
  }
  for (let warm = 0; warm < 5; warm++) for (const fn of Object.values(checks)) await fn();
  const readSamples: Record<string, number[]> = Object.fromEntries(Object.keys(checks).map(name => [name, []]));
  for (let run = 0; run < RUNS; run++)
    for (const [name, fn] of Object.entries(checks)) {
      const before = performance.now();
      await fn();
      readSamples[name].push(performance.now() - before);
    }
  const longRows = await query({
    query: `SELECT count() AS interactions, countIf(type='click') AS clicks,
    countIf(type='scroll') AS scrollUpdates, max(document_height) AS documentHeight,
    max(viewport_width) AS viewportWidth FROM heatmap_events
    WHERE site_id = 37 AND session_id = {session:String}`,
    params: { session: uuid("session:37:450") },
  });
  await client.command({ query: "CREATE TABLE heatmap_long_case AS heatmap_events" });
  await client.command({
    query: `INSERT INTO heatmap_long_case SELECT * FROM heatmap_events
    WHERE site_id = 37 AND session_id = {session:String}`,
    query_params: { session: uuid("session:37:450") },
  });
  const longSessionStorage = await storage("heatmap_long_case");
  const columnCodecs = await query({
    query:
      "SELECT name, type, compression_codec FROM system.columns WHERE database={database:String} AND table='heatmap_events'",
    params: { database },
  });
  const [runtime] = await query({
    query:
      "SELECT version() AS clickhouseVersion, getSetting('max_threads') AS maxThreads, getSetting('max_memory_usage') AS maxMemoryUsageBytes",
  });
  const maybeRead = async (url: URL | string) => {
    try {
      return (await readFile(url, "utf8")).trim();
    } catch {
      return null;
    }
  };
  const evidence = {
    recordedAt: new Date().toISOString(),
    codec: mode === "lz4" ? "LZ4 (ClickHouse baseline default)" : "ZSTD(1) on every heatmap column",
    database,
    cleanup: "created database dropped in finally",
    fixture: {
      rows: ROWS,
      sites: SITES,
      sampledSessions,
      sampledVisitors: sampledSessions,
      normalSessions: 45_000,
      normalInteractionsPerSession: 20,
      longSessions: 100,
      longInteractionsPerSession: 1000,
      startDate,
      endDate,
      analyticsRows,
      shape,
      selectedPage: {
        siteId: 37,
        hostname: selected.hostname,
        pathname: selected.pathname,
        bucket: selected.bucket,
        count: summary.count,
        sessions: summary.sessions,
        returnedPoints: firstReport.points.length,
        truncated: firstReport.truncated.points,
      },
      generatedJSONPayloadBytes: jsonPayloadBytes,
      generatedJSONBytesPerRow: jsonPayloadBytes / ROWS,
      interactionsPerSampledSession: ROWS / sampledSessions,
      generatedJSONBytesPerSampledSession: jsonPayloadBytes / sampledSessions,
    },
    hardware: {
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
      cpuModel: os.cpus()[0]?.model,
      visibleCpus: os.cpus().length,
      availableParallelism: os.availableParallelism(),
      totalMemoryBytes: os.totalmem(),
      cgroupMemoryMax: await maybeRead("/sys/fs/cgroup/memory.max"),
      cgroupCpuMax: await maybeRead("/sys/fs/cgroup/cpu.max"),
      nativeHost: await maybeRead(new URL("benchmark-native-host.txt", directory)),
      dockerVM: JSON.parse((await maybeRead(new URL("benchmark-docker-host.json", directory))) || "null"),
      clickhouseContainer: JSON.parse(
        (await maybeRead(new URL("benchmark-clickhouse-container.json", directory))) || "null"
      ),
      runtime,
    },
    insert: {
      ...distribution(insertSamples),
      batchRows: BATCH_ROWS,
      asyncInsert: true,
      waitForAsyncInsert: true,
      seedElapsedMs: insertElapsedMs,
      note: "Each sample includes JSON serialization, transport, codec compression and acknowledged async flush; metadata event insert is excluded.",
    },
    storage: {
      beforeMerge,
      afterMerge,
      columnCodecs,
      compressedBytesPerRow: Number(afterMerge.dataCompressedBytes) / ROWS,
      diskBytesPerRow: Number(afterMerge.bytesOnDisk) / ROWS,
      compressedBytesPerSampledSession: Number(afterMerge.dataCompressedBytes) / sampledSessions,
      diskBytesPerSampledSession: Number(afterMerge.bytesOnDisk) / sampledSessions,
    },
    representativeSession: {
      normal: { interactions: 20, generatedJSONPayloadBytes: ordinarySessionPayloadBytes },
      long: {
        ...longRows[0],
        generatedJSONPayloadBytes: longSessionPayloadBytes,
        measuredIsolatedPartStorage: longSessionStorage,
        note: "Single-session table includes small part/dictionary overhead; use full-table averages for retained workload sizing.",
      },
    },
    reads: Object.fromEntries(Object.entries(readSamples).map(([name, samples]) => [name, distribution(samples)])),
    readMethod: {
      warmups: 5,
      measuredRuns: RUNS,
      concurrency: 1,
      fullService:
        "production HeatmapQueryService.getHeatmaps using isolated database env override; response serialization and HTTP are excluded",
    },
  };
  await writeFile(new URL(`benchmark-${mode}.json`, directory), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(
    JSON.stringify({
      codec: mode,
      insertP95Ms: evidence.insert.p95Ms,
      storage: evidence.storage.afterMerge,
      readP95Ms: Object.fromEntries(Object.entries(evidence.reads).map(([name, read]) => [name, read.p95Ms])),
    })
  );
} finally {
  await applicationClient?.close();
  await applicationQueryClient?.close();
  await client.close();
  if (created) await admin.command({ query: `DROP DATABASE ${database}` });
  await admin.close();
}
