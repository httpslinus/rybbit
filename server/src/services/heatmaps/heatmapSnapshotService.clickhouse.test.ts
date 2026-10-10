import { createClient } from "@clickhouse/client";
import { writeFile } from "node:fs/promises";
import SqlString from "sqlstring";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("../../db/clickhouse/clickhouse.js", () => ({ clickhouse: {} }));
vi.mock("../../db/redis/redis.js", () => ({ redis: {} }));
vi.mock("../storage/r2StorageService.js", () => ({ r2Storage: {} }));
import { HEATMAP_SNAPSHOT_TABLE_SQL } from "../../db/clickhouse/schema/heatmaps.js";
import { buildHeatmapSnapshotQuery, buildLegacyHeatmapSnapshotQuery } from "./heatmapSnapshotService.js";
import { resolveBoundedHeatmapTime } from "./heatmapFilterScope.js";

const now = Date.now();
const time = now - 10 * 60_000;
const fields =
  "site_id UInt32, session_id String, timestamp DateTime64(3, 'UTC'), event_type String, event_data String, event_data_key Nullable(String), batch_index Nullable(UInt16), sequence_number UInt32, viewport_width Nullable(UInt16)";
const rows: unknown[][] = [];
const literal = (value: unknown): string =>
  value === null ? "NULL" : typeof value === "string" ? SqlString.escape(value) : String(value);
function replay(
  session: string,
  timestamp: number,
  type: string,
  sequence: number,
  data: unknown,
  site = 42,
  key: string | null = null
) {
  rows.push([
    site,
    session,
    new Date(timestamp).toISOString().replace("T", " ").replace("Z", ""),
    type,
    JSON.stringify(data),
    key,
    key === null ? null : sequence,
    sequence,
    375,
  ]);
}
function pair(session: string, base = time, href = "https://example.com/page", width = 375, site = 42) {
  replay(session, base, "4", 0, { href, width, height: 800 }, site);
  replay(session, base + 1, "2", 1, { node: { type: 0, id: 1, childNodes: [] } }, site);
}
pair("good");
pair("wrong-page", time, "https://example.com/other");
pair("wrong-width", time, "https://example.com/page", 1440);
pair("wrong-site", time, "https://example.com/page", 375, 43);
pair("expired", now - 31 * 24 * 60 * 60_000);
pair("future", now + 60_000);
replay("unpaired", time, "2", 7, { node: { type: 0, id: 1, childNodes: [] } });
pair("ambiguous");
replay("ambiguous", time - 1, "4", 0, { href: "https://example.com/other", width: 375, height: 800 });
replay("r2-wrong-batch", time, "4", 0, {}, 42, "42/r2-wrong-batch/meta.json.zst");
replay("r2-wrong-batch", time + 1, "2", 1, {}, 42, "42/r2-wrong-batch/full.json.zst");
const fixture = `WITH session_replay_events AS (SELECT * FROM values(${literal(fields)}, ${rows.map(row => `(${row.map(literal).join(",")})`).join(",")}))`;
const spec = buildLegacyHeatmapSnapshotQuery(
  42,
  { hostname: "example.com", pathname: "/page" },
  resolveBoundedHeatmapTime({ past_minutes_start: 5, past_minutes_end: 0 }, now),
  375
);
const query = `${fixture}\n${spec.query}`;

// Set HEATMAP_SNAPSHOT_SQL_FILE to exercise this exact query through a local
// docker exec clickhouse-client when no HTTP test port is exposed.
it.skipIf(!process.env.HEATMAP_SNAPSHOT_SQL_FILE)("exports the read-only legacy query fixture", async () => {
  await writeFile(process.env.HEATMAP_SNAPSHOT_SQL_FILE!, query);
});
describe.skipIf(!process.env.CLICKHOUSE_TEST_URL)("Legacy heatmap snapshots: ClickHouse", () => {
  let client: ReturnType<typeof createClient>;
  beforeAll(() => {
    client = createClient({
      url: process.env.CLICKHOUSE_TEST_URL,
      username: process.env.CLICKHOUSE_TEST_USER || "default",
      password: process.env.CLICKHOUSE_TEST_PASSWORD || "",
    });
  });
  afterAll(async () => {
    await client?.close();
  });
  it("selects only the unique source pair for the requested site/page/width/day", async () => {
    const result = await client.query({ query, query_params: spec.params, format: "JSONEachRow" });
    expect((await result.json<{ session_id: string }>()).map(row => row.session_id)).toEqual(["good"]);
  });
});

it.skipIf(!process.env.HEATMAP_SNAPSHOT_INDEX_SQL_FILE)(
  "exports an isolated index table/selection fixture",
  async () => {
    const snapshotQuery = buildHeatmapSnapshotQuery(
      42,
      { hostname: "example.com", pathname: "/page" },
      375,
      resolveBoundedHeatmapTime({ past_minutes_start: 5, past_minutes_end: 0 }, now)
    );
    await writeFile(
      process.env.HEATMAP_SNAPSHOT_INDEX_SQL_FILE!,
      `CREATE DATABASE heatmap_snapshot_qa_a922e1;
USE heatmap_snapshot_qa_a922e1;
${HEATMAP_SNAPSHOT_TABLE_SQL};
INSERT INTO heatmap_snapshots (site_id,snapshot_key,timestamp,hostname,pathname,viewport_bucket,source,session_id,snapshot_data) VALUES
(42,'daily',now64(3)-INTERVAL 10 MINUTE,'example.com','/page',375,'replay','session',''),
(42,'daily',now64(3)-INTERVAL 10 MINUTE,'example.com','/page',375,'standalone','session','{"type":0,"id":1,"childNodes":[]}');
${snapshotQuery.query};
DROP DATABASE heatmap_snapshot_qa_a922e1;
`
    );
  }
);
