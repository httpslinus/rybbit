import { clickhouse } from "../../db/clickhouse/clickhouse.js";
import { redis } from "../../db/redis/redis.js";
import { processResults } from "../../api/analytics/utils/utils.js";

/** Call with an internal, parameterized predicate before deleting the rows. */
export async function clearHeatmapSnapshotMarkers(
  siteId: number,
  condition = "",
  params: Record<string, unknown> = {}
): Promise<void> {
  const result = await clickhouse.query({
    query: `SELECT DISTINCT snapshot_key FROM heatmap_snapshots WHERE site_id = {snapshotSiteId:UInt32} ${condition}`,
    query_params: { ...params, snapshotSiteId: siteId },
    format: "JSONEachRow",
  });
  const rows = await processResults<{ snapshot_key: string }>(result, ["snapshot_key"]);
  for (const { snapshot_key: key } of rows) {
    if (!new RegExp(`^heatmap-snapshot:${siteId}:[a-f0-9]{64}$`).test(key)) continue;
    await redis.del(key, `${key}:replay`);
  }
}
