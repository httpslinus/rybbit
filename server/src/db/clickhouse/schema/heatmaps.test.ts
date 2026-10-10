import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ exec: vi.fn(), utc: vi.fn() }));
vi.mock("../initUtils.js", () => ({ execClickhouseInitStep: mocks.exec, ensureUtcTimeColumns: mocks.utc }));
import { HEATMAP_TABLE_SQL, HEATMAP_SNAPSHOT_TABLE_SQL, initializeHeatmapTables } from "./heatmaps.js";

beforeEach(() => vi.clearAllMocks());

describe("heatmap schema", () => {
  it("can initialize repeatedly with UTC millisecond timestamps", async () => {
    await initializeHeatmapTables();
    await initializeHeatmapTables();
    expect(mocks.exec).toHaveBeenCalledTimes(4);
    expect(mocks.exec).toHaveBeenCalledWith(
      "create heatmap_events",
      expect.stringContaining("CREATE TABLE IF NOT EXISTS")
    );
    expect(mocks.utc).toHaveBeenCalledWith("heatmap_events", [{ name: "timestamp", type: "DateTime64(3, 'UTC')" }]);
    expect(mocks.exec).toHaveBeenCalledWith("create heatmap_snapshots", HEATMAP_SNAPSHOT_TABLE_SQL);
  });

  it("supports long documents and retains compact rows for 30 days", () => {
    expect(HEATMAP_TABLE_SQL).toContain("document_height UInt32 CODEC(ZSTD(1))");
    expect(HEATMAP_TABLE_SQL).toContain("document_width UInt32 CODEC(ZSTD(1))");
    expect(HEATMAP_TABLE_SQL).toContain("TTL timestamp + INTERVAL 30 DAY");
    expect(HEATMAP_TABLE_SQL).toContain("PARTITION BY toYYYYMM(timestamp)");
    expect(HEATMAP_TABLE_SQL).toContain(
      "ORDER BY (site_id, hostname, pathname, viewport_bucket, timestamp, session_id)"
    );
    expect(HEATMAP_TABLE_SQL).not.toMatch(/event_data|properties|selector|text|snapshot/i);
  });
});
