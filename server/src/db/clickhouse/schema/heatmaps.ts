import { ensureUtcTimeColumns, execClickhouseInitStep } from "../initUtils.js";
import { UTC_TIME_COLUMNS } from "../timeColumns.js";

export const HEATMAP_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS heatmap_events (
    site_id UInt32 CODEC(ZSTD(1)),
    session_id String CODEC(ZSTD(1)),
    user_id String CODEC(ZSTD(1)),
    identified_user_id String CODEC(ZSTD(1)),
    timestamp DateTime64(3, 'UTC') CODEC(ZSTD(1)),
    page_visit_id String CODEC(ZSTD(1)),
    batch_id String CODEC(ZSTD(1)),
    event_index UInt16 CODEC(ZSTD(1)),
    type LowCardinality(String) CODEC(ZSTD(1)),
    hostname LowCardinality(String) CODEC(ZSTD(1)),
    pathname LowCardinality(String) CODEC(ZSTD(1)),
    viewport_bucket UInt16 CODEC(ZSTD(1)),
    viewport_width UInt32 CODEC(ZSTD(1)),
    viewport_height UInt32 CODEC(ZSTD(1)),
    document_width UInt32 CODEC(ZSTD(1)),
    document_height UInt32 CODEC(ZSTD(1)),
    client_x Nullable(Float64) CODEC(ZSTD(1)),
    client_y Nullable(Float64) CODEC(ZSTD(1)),
    page_x Nullable(Float64) CODEC(ZSTD(1)),
    page_y Nullable(Float64) CODEC(ZSTD(1)),
    max_depth Nullable(Float64) CODEC(ZSTD(1))
  ) ENGINE = MergeTree()
  PARTITION BY toYYYYMM(timestamp)
  ORDER BY (site_id, hostname, pathname, viewport_bucket, timestamp, session_id)
  TTL timestamp + INTERVAL 30 DAY
  SETTINGS index_granularity = 8192
`;

// Replay backgrounds contain pointers only; standalone backgrounds keep one
// masked DOM per page/width/day. Both expire with the interaction data.
export const HEATMAP_SNAPSHOT_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS heatmap_snapshots (
    site_id UInt32,
    snapshot_key String,
    timestamp DateTime64(3, 'UTC'),
    hostname LowCardinality(String),
    pathname LowCardinality(String),
    viewport_bucket UInt16,
    viewport_width UInt32,
    viewport_height UInt32,
    document_width UInt32,
    document_height UInt32,
    source LowCardinality(String),
    session_id String,
    user_id String,
    identified_user_id String,
    source_timestamp DateTime64(3, 'UTC'),
    source_sequence UInt32,
    source_hash String,
    event_data_key String,
    batch_index UInt32,
    snapshot_data String CODEC(ZSTD(3))
  ) ENGINE = ReplacingMergeTree(timestamp)
  PARTITION BY toYYYYMM(timestamp)
  ORDER BY (site_id, hostname, pathname, viewport_bucket, snapshot_key, source)
  TTL timestamp + INTERVAL 30 DAY
`;

export async function initializeHeatmapTables(): Promise<void> {
  await execClickhouseInitStep("create heatmap_events", HEATMAP_TABLE_SQL);
  await ensureUtcTimeColumns("heatmap_events", UTC_TIME_COLUMNS.heatmap_events);
  await execClickhouseInitStep("create heatmap_snapshots", HEATMAP_SNAPSHOT_TABLE_SQL);
}
