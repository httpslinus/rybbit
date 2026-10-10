import { createHash } from "node:crypto";
import {
  heatmapWidthBucket,
  sanitizeHeatmapSnapshot,
  type HeatmapSnapshot,
  type HeatmapSnapshotContext,
  type HeatmapSnapshotNode,
  type HeatmapSnapshotRequest,
  type HeatmapWidthBucket,
} from "@rybbit/shared";
import { runAnalyticsQuery } from "../../api/analytics/utils/analyticsQuery.js";
import type { TimeWindow } from "../../api/analytics/utils/timeWindow.js";
import { clickhouse } from "../../db/clickhouse/clickhouse.js";
import { toClickHouseDateTime } from "../../db/clickhouse/dateTime.js";
import { redis } from "../../db/redis/redis.js";
import { createServiceLogger } from "../../lib/logger/logger.js";
import type { RecordSessionReplayRequest } from "../../types/sessionReplay.js";
import { r2Storage } from "../storage/r2StorageService.js";
import { heatmapSnapshotClaims, heatmapSnapshotKey } from "./heatmapSnapshotClaims.js";

const logger = createServiceLogger("heatmap-snapshots");
export const HEATMAP_SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;
type Attribution = { sessionId: string; userId: string; identifiedUserId: string };

export function heatmapSnapshotTimeStatement(window: TimeWindow, column: string) {
  // A daily representative remains usable for a later short interval that
  // overlaps its day, while the report's end still excludes future captures.
  return window
    .where(column)
    .replace(
      new RegExp(`${column.replace(/\./g, "\\.")} >=?`, "g"),
      `toStartOfDay(${column}, 'UTC') + INTERVAL 1 DAY >`
    );
}

export function buildLegacyHeatmapSnapshotQuery(
  siteId: number,
  page: Pick<HeatmapSnapshotContext, "hostname" | "pathname">,
  window: TimeWindow,
  bucket: HeatmapWidthBucket = 375
) {
  return {
    query: `SELECT f.session_id AS session_id, toUnixTimestamp64Milli(f.timestamp) AS timestamp, f.sequence_number AS sequence,
    ifNull(f.event_data_key, '') AS event_data_key, ifNull(f.batch_index, 0) AS batch_index,
    lower(hex(SHA256(f.event_data))) AS source_hash, any(m.event_data) AS meta
    FROM session_replay_events f INNER JOIN session_replay_events m
      ON f.site_id = m.site_id AND f.session_id = m.session_id AND f.sequence_number = m.sequence_number + 1
    WHERE f.site_id = {siteId:UInt32} AND f.event_type = '2' AND m.event_type = '4'
      AND f.timestamp >= m.timestamp AND f.timestamp <= m.timestamp + INTERVAL 1 SECOND
      AND ifNull(f.event_data_key, '') = ifNull(m.event_data_key, '')
      AND f.timestamp >= now() - INTERVAL 30 DAY ${heatmapSnapshotTimeStatement(window, "f.timestamp")}
    GROUP BY f.session_id, f.timestamp, f.sequence_number, f.event_data_key, f.batch_index, source_hash
    HAVING count() = 1 AND (f.event_data_key IS NOT NULL OR (
      domain(JSONExtractString(meta, 'href')) = {hostname:String}
      AND path(JSONExtractString(meta, 'href')) = {pathname:String}
      AND arraySort(b -> abs(toInt64(b) - toInt64(JSONExtractUInt(meta, 'width'))), [320,375,425,768,1024,1440,1920])[1] = {bucket:UInt16}
    ))
    ORDER BY f.timestamp DESC LIMIT 40`,
    params: { siteId, ...page, bucket },
  };
}
export function buildHeatmapSnapshotQuery(
  siteId: number,
  page: Pick<HeatmapSnapshotContext, "hostname" | "pathname">,
  bucket: HeatmapWidthBucket,
  window: TimeWindow
) {
  return {
    query: `SELECT snapshot_key, toUnixTimestamp64Milli(hs.timestamp) AS timestamp, hostname, pathname, viewport_width, viewport_height, document_width, document_height, source, session_id, toUnixTimestamp64Milli(hs.source_timestamp) AS source_timestamp, source_sequence, source_hash, event_data_key, batch_index, snapshot_data
      FROM heatmap_snapshots AS hs FINAL
      WHERE site_id = {siteId:UInt32} AND hostname = {hostname:String} AND pathname = {pathname:String} AND viewport_bucket = {bucket:UInt16}
        AND hs.timestamp >= now() - INTERVAL 30 DAY ${heatmapSnapshotTimeStatement(window, "hs.timestamp")}
      ORDER BY (source = 'replay') DESC, hs.timestamp DESC LIMIT 12`,
    params: { siteId, ...page, bucket },
  };
}

type SnapshotRow = {
  snapshot_key: string;
  timestamp: number;
  hostname: string;
  pathname: string;
  viewport_width: number;
  viewport_height: number;
  document_width: number;
  document_height: number;
  source: "replay" | "standalone";
  session_id: string;
  source_timestamp: number;
  source_sequence: number;
  source_hash: string;
  event_data_key: string;
  batch_index: number;
  snapshot_data: string;
};
function rowContext(row: SnapshotRow): HeatmapSnapshotContext {
  return {
    hostname: row.hostname,
    pathname: row.pathname,
    viewportWidth: row.viewport_width,
    viewportHeight: row.viewport_height,
    documentWidth: row.document_width,
    documentHeight: row.document_height,
  };
}
function snapshotRow(siteId: number, context: HeatmapSnapshotContext, timestamp: number, attribution: Attribution) {
  const bucket = heatmapWidthBucket(context.viewportWidth);
  return {
    site_id: siteId,
    snapshot_key: heatmapSnapshotKey(siteId, context, bucket, timestamp),
    timestamp: toClickHouseDateTime(timestamp),
    hostname: context.hostname,
    pathname: context.pathname,
    viewport_bucket: bucket,
    viewport_width: context.viewportWidth,
    viewport_height: context.viewportHeight,
    document_width: context.documentWidth,
    document_height: context.documentHeight,
    session_id: attribution.sessionId,
    user_id: attribution.userId,
    identified_user_id: attribution.identifiedUserId,
    source_timestamp: toClickHouseDateTime(timestamp),
    source_sequence: 0,
    source_hash: "",
    event_data_key: "",
    batch_index: 0,
    snapshot_data: "",
  };
}

export class HeatmapSnapshotService {
  async indexReplay(
    siteId: number,
    events: RecordSessionReplayRequest["events"],
    attribution: Attribution,
    r2Key: string | null
  ): Promise<void> {
    const rows = [];
    for (const [sequence, event] of events.entries()) {
      if (String(event.type) !== "2" || !event.snapshotContext) continue;
      const context = event.snapshotContext;
      const row = snapshotRow(siteId, context, event.timestamp, attribution);
      let won = false;
      try {
        // A replay marker is independent of standalone collection, so a later
        // replay can replace the day's fallback without retaining a DOM copy.
        won = Boolean(await redis.set(`${row.snapshot_key}:replay`, "1", "PX", 24 * 60 * 60_000, "NX"));
        if (!won) continue;
        sanitizeHeatmapSnapshot(event.data?.node);
        rows.push({
          ...row,
          source: "replay",
          source_sequence: sequence,
          source_hash: createHash("sha256").update(JSON.stringify(event.data)).digest("hex"),
          event_data_key: r2Key || "",
          batch_index: sequence,
        });
      } catch (error) {
        if (won) await redis.del(`${row.snapshot_key}:replay`);
        logger.debug({ err: error, siteId }, "Skipping unsuitable replay background");
      }
    }
    if (!rows.length) return;
    try {
      await clickhouse.insert({ table: "heatmap_snapshots", values: rows, format: "JSONEachRow" });
      for (const row of rows)
        await heatmapSnapshotClaims.markReplay(
          siteId,
          {
            hostname: row.hostname,
            pathname: row.pathname,
            viewportWidth: row.viewport_width,
            viewportHeight: row.viewport_height,
            documentWidth: row.document_width,
            documentHeight: row.document_height,
          },
          row.viewport_bucket,
          Date.parse(row.timestamp)
        );
    } catch (error) {
      for (const row of rows) await redis.del(`${row.snapshot_key}:replay`);
      throw error;
    }
  }

  async storeStandalone(
    siteId: number,
    request: HeatmapSnapshotRequest,
    context: HeatmapSnapshotContext,
    node: HeatmapSnapshotNode,
    timestamp: number
  ): Promise<boolean> {
    const claim = await heatmapSnapshotClaims.get(siteId, request);
    if (!claim) return false;
    if (
      context.hostname !== claim.lease.context.hostname ||
      context.pathname !== claim.lease.context.pathname ||
      heatmapWidthBucket(context.viewportWidth) !== request.bucket
    )
      return false;
    const safeNode = sanitizeHeatmapSnapshot(node);
    const capturedAt = Date.now();
    // Reserve the upload before the insert. An ambiguous failure retains its
    // lease so repeated requests cannot continuously write the same DOM.
    if (!(await heatmapSnapshotClaims.beginUpload(request, claim.value))) return false;
    await clickhouse.insert({
      table: "heatmap_snapshots",
      values: [
        {
          ...snapshotRow(siteId, context, capturedAt, claim.lease),
          snapshot_key: request.key,
          source: "standalone",
          snapshot_data: JSON.stringify(safeNode),
        },
      ],
      format: "JSONEachRow",
    });
    let completed = false;
    try {
      completed = await heatmapSnapshotClaims.consume(siteId, request, `uploading:${claim.value}`);
    } finally {
      // Erasure can revoke a lease while its insert is in flight. Remove only
      // this upload, preserving a later replacement by another visitor.
      if (!completed)
        await clickhouse.command({
          query: `DELETE FROM heatmap_snapshots WHERE site_id = {siteId:UInt32} AND snapshot_key = {key:String} AND source = 'standalone' AND timestamp = fromUnixTimestamp64Milli({timestamp:Int64})`,
          query_params: { siteId, key: request.key, timestamp: capturedAt },
        });
    }
    return completed;
  }

  async getSnapshot(
    siteId: number,
    page: Pick<HeatmapSnapshotContext, "hostname" | "pathname">,
    bucket: HeatmapWidthBucket,
    window: TimeWindow,
    geometry: { viewportWidth: number; viewportHeight: number; documentWidth: number; documentHeight: number }
  ): Promise<HeatmapSnapshot | null> {
    const rows = await runAnalyticsQuery<SnapshotRow>(buildHeatmapSnapshotQuery(siteId, page, bucket, window), [
      "snapshot_key",
      "hostname",
      "pathname",
      "session_id",
      "source_hash",
      "event_data_key",
      "snapshot_data",
    ]);
    for (const row of rows) {
      if (!["replay", "standalone"].includes(row.source)) continue;
      try {
        const node =
          row.source === "standalone" ? JSON.parse(row.snapshot_data) : await this.readReplayNode(siteId, row);
        if (!node) continue;
        return {
          ...rowContext(row),
          source: row.source,
          capturedAt: new Date(row.timestamp).toISOString(),
          node: sanitizeHeatmapSnapshot(node),
        };
      } catch (error) {
        logger.debug({ err: error, siteId }, "Skipping expired or invalid heatmap background");
      }
    }
    return this.getLegacyReplaySnapshot(siteId, page, bucket, window, geometry);
  }

  private async readReplayNode(siteId: number, row: SnapshotRow): Promise<unknown | null> {
    // Always confirm the ClickHouse source exists before fetching an R2 blob;
    // replay deletion and TTL must also invalidate derived heatmap backgrounds.
    const source = await runAnalyticsQuery<{ event_data: string; event_data_key: string; batch_index: number }>(
      {
        query: `SELECT event_data, ifNull(event_data_key, '') AS event_data_key, ifNull(batch_index, 0) AS batch_index
      FROM session_replay_events WHERE site_id = {siteId:UInt32} AND session_id = {sessionId:String} AND event_type = '2'
        AND timestamp = fromUnixTimestamp64Milli({timestamp:Int64}) AND sequence_number = {sequence:UInt32}
        AND (ifNull(event_data_key, '') = {key:String})
        AND ({key:String} != '' OR lower(hex(SHA256(event_data))) = {hash:String})
      LIMIT 1`,
        params: {
          siteId,
          sessionId: row.session_id,
          timestamp: row.source_timestamp,
          sequence: row.source_sequence,
          key: row.event_data_key,
          hash: row.source_hash,
        },
      },
      ["event_data", "event_data_key"]
    );
    if (!source[0]) return null;
    if (row.event_data_key) {
      if (!row.event_data_key.startsWith(`${siteId}/${row.session_id}/`) || !r2Storage.isEnabled()) return null;
      const batch = await r2Storage.getBatch(row.event_data_key);
      const data = batch[row.batch_index];
      if (row.source_hash && createHash("sha256").update(JSON.stringify(data)).digest("hex") !== row.source_hash)
        return null;
      return data?.node ?? null;
    }
    return JSON.parse(source[0].event_data)?.node ?? null;
  }

  private async getLegacyReplaySnapshot(
    siteId: number,
    page: Pick<HeatmapSnapshotContext, "hostname" | "pathname">,
    bucket: HeatmapWidthBucket,
    window: TimeWindow,
    geometry: { viewportWidth: number; viewportHeight: number; documentWidth: number; documentHeight: number }
  ): Promise<HeatmapSnapshot | null> {
    // Only adjacent Meta -> FullSnapshot pairs from the same batch establish
    // the URL. Session-level page_url cannot attribute SPA snapshots reliably.
    const rows = await runAnalyticsQuery<{
      session_id: string;
      timestamp: number;
      sequence: number;
      event_data_key: string;
      batch_index: number;
      source_hash: string;
      meta: string;
    }>(buildLegacyHeatmapSnapshotQuery(siteId, page, window, bucket), [
      "session_id",
      "event_data_key",
      "meta",
      "source_hash",
    ]);
    for (const row of rows) {
      try {
        let meta = row.meta ? JSON.parse(row.meta) : null;
        let data: any;
        if (row.event_data_key) {
          if (
            !row.event_data_key.startsWith(`${siteId}/${row.session_id}/`) ||
            !r2Storage.isEnabled() ||
            row.batch_index < 1
          )
            continue;
          const batch = await r2Storage.getBatch(row.event_data_key);
          meta = batch[row.batch_index - 1];
          data = batch[row.batch_index];
        }
        if (
          !meta ||
          !Number.isInteger(meta.width) ||
          !Number.isInteger(meta.height) ||
          meta.width <= 0 ||
          meta.height <= 0
        )
          continue;
        const url = new URL(meta.href);
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.hostname !== page.hostname ||
          url.pathname !== page.pathname ||
          heatmapWidthBucket(meta.width) !== bucket
        )
          continue;
        if (!data) {
          const values = await runAnalyticsQuery<{ data: string }>(
            {
              query: `SELECT event_data AS data FROM session_replay_events WHERE site_id = {siteId:UInt32} AND session_id = {sessionId:String} AND event_type = '2' AND timestamp = fromUnixTimestamp64Milli({timestamp:Int64}) AND sequence_number = {sequence:UInt32} AND event_data_key IS NULL AND lower(hex(SHA256(event_data))) = {hash:String} LIMIT 1`,
              params: {
                siteId,
                sessionId: row.session_id,
                timestamp: row.timestamp,
                sequence: row.sequence,
                hash: row.source_hash,
              },
            },
            ["data"]
          );
          if (!values[0]) continue;
          data = JSON.parse(values[0].data);
        }
        const scale = meta.width / bucket;
        return {
          ...page,
          viewportWidth: meta.width,
          viewportHeight: meta.height,
          documentWidth: Math.max(meta.width, Math.round(geometry.documentWidth * scale)),
          documentHeight: Math.max(meta.height, Math.round(geometry.documentHeight * scale)),
          source: "replay",
          capturedAt: new Date(row.timestamp).toISOString(),
          node: sanitizeHeatmapSnapshot(data.node),
        };
      } catch {
        continue;
      }
    }
    return null;
  }
}
export const heatmapSnapshotService = new HeatmapSnapshotService();
