import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveBoundedHeatmapTime } from "./heatmapFilterScope.js";
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  insert: vi.fn(),
  command: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  getBatch: vi.fn(),
  enabled: vi.fn(),
  markReplay: vi.fn(),
  get: vi.fn(),
  beginUpload: vi.fn(),
  consume: vi.fn(),
}));
vi.mock("../../api/analytics/utils/analyticsQuery.js", () => ({ runAnalyticsQuery: mocks.query }));
vi.mock("../../db/clickhouse/clickhouse.js", () => ({ clickhouse: { insert: mocks.insert, command: mocks.command } }));
vi.mock("../../db/redis/redis.js", () => ({ redis: { set: mocks.set, del: mocks.del } }));
vi.mock("../storage/r2StorageService.js", () => ({
  r2Storage: { getBatch: mocks.getBatch, isEnabled: mocks.enabled },
}));
vi.mock("./heatmapSnapshotClaims.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./heatmapSnapshotClaims.js")>();
  return {
    ...actual,
    heatmapSnapshotClaims: {
      markReplay: mocks.markReplay,
      get: mocks.get,
      beginUpload: mocks.beginUpload,
      consume: mocks.consume,
    },
  };
});
import { HeatmapSnapshotService, buildLegacyHeatmapSnapshotQuery } from "./heatmapSnapshotService.js";
const now = Date.parse("2026-10-11T12:00:00Z");
const context = {
  hostname: "example.com",
  pathname: "/page",
  viewportWidth: 375,
  viewportHeight: 800,
  documentWidth: 375,
  documentHeight: 3000,
};
const node = { type: 0, id: 1, childNodes: [{ type: 2, id: 2, tagName: "html", attributes: {}, childNodes: [] }] };
const attribution = { sessionId: "session", userId: "device", identifiedUserId: "alice" };
const window = () => resolveBoundedHeatmapTime({ past_minutes_start: 5, past_minutes_end: 0 }, now);
const row = (overrides: Record<string, unknown> = {}) => ({
  snapshot_key: "heatmap-snapshot:42:" + "a".repeat(64),
  timestamp: now - 60_000,
  hostname: "example.com",
  pathname: "/page",
  viewport_width: 375,
  viewport_height: 800,
  document_width: 375,
  document_height: 3000,
  source: "replay",
  session_id: "session",
  source_timestamp: now - 60_000,
  source_sequence: 1,
  source_hash: "hash",
  event_data_key: "",
  batch_index: 1,
  snapshot_data: "",
  ...overrides,
});
const request = {
  key: "heatmap-snapshot:42:" + "a".repeat(64),
  token: "token",
  pageVisitId: "visit",
  hostname: "example.com",
  pathname: "/page",
  bucket: 375 as const,
};
let service: HeatmapSnapshotService;
beforeEach(() => {
  vi.clearAllMocks();
  service = new HeatmapSnapshotService();
  mocks.query.mockResolvedValue([]);
  mocks.insert.mockResolvedValue(undefined);
  mocks.command.mockResolvedValue(undefined);
  mocks.set.mockResolvedValue("OK");
  mocks.del.mockResolvedValue(1);
  mocks.enabled.mockReturnValue(true);
  mocks.markReplay.mockResolvedValue(undefined);
  mocks.get.mockResolvedValue(null);
  mocks.beginUpload.mockResolvedValue(true);
  mocks.consume.mockResolvedValue(true);
});
async function getSnapshot() {
  return service.getSnapshot(42, context, 375, window(), context);
}
describe("replay-first heatmap snapshots", () => {
  it("indexes only exact replay pointers without storing another DOM", async () => {
    const data = { node };
    await service.indexReplay(42, [{ type: 2, timestamp: now, data, snapshotContext: context }], attribution, null);
    expect(mocks.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        table: "heatmap_snapshots",
        values: [
          expect.objectContaining({
            source: "replay",
            source_sequence: 0,
            source_hash: createHash("sha256").update(JSON.stringify(data)).digest("hex"),
            snapshot_data: "",
            session_id: "session",
            user_id: "device",
            identified_user_id: "alice",
          }),
        ],
      })
    );
    expect(mocks.markReplay).toHaveBeenCalledWith(42, context, 375, now);
  });
  it("skips additional daily replay DOM validation and releases invalid winners", async () => {
    mocks.set.mockResolvedValueOnce(null).mockResolvedValueOnce("OK");
    await service.indexReplay(
      42,
      [
        { type: 2, timestamp: now, data: { node: {} }, snapshotContext: context },
        { type: 2, timestamp: now, data: { node: {} }, snapshotContext: context },
      ],
      attribution,
      null
    );
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.del).toHaveBeenCalledTimes(1);
  });
  it("loads only the selected full snapshot, constrained to its site, session, timestamp and content hash", async () => {
    mocks.query.mockResolvedValueOnce([row()]).mockResolvedValueOnce([{ event_data: JSON.stringify({ node }) }]);
    expect(await getSnapshot()).toMatchObject({ ...context, source: "replay", node });
    expect(mocks.query.mock.calls[1][0]).toMatchObject({
      params: { siteId: 42, sessionId: "session", timestamp: now - 60_000, sequence: 1, hash: "hash", key: "" },
    });
    expect(mocks.query.mock.calls[1][0].query).toContain("SHA256(event_data)");
  });
  it("skips deleted replay sources and selects an available standalone background", async () => {
    mocks.query
      .mockResolvedValueOnce([row(), row({ source: "standalone", snapshot_data: JSON.stringify(node) })])
      .mockResolvedValueOnce([]);
    expect(await getSnapshot()).toMatchObject({ source: "standalone", node });
    expect(mocks.getBatch).not.toHaveBeenCalled();
  });
  it("does not fetch an R2 source unless the ClickHouse event still exists", async () => {
    mocks.query
      .mockResolvedValueOnce([row({ event_data_key: "42/session/batch.json.zst" })])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    expect(await getSnapshot()).toBeNull();
    expect(mocks.getBatch).not.toHaveBeenCalled();
  });
  it("rejects R2 objects belonging to another site or session", async () => {
    mocks.query
      .mockResolvedValueOnce([row({ event_data_key: "43/session/batch.json.zst" })])
      .mockResolvedValueOnce([{ event_data_key: "43/session/batch.json.zst", batch_index: 1 }])
      .mockResolvedValueOnce([]);
    expect(await getSnapshot()).toBeNull();
    expect(mocks.getBatch).not.toHaveBeenCalled();
  });
  it("reuses exact legacy meta/full pairs while skipping SPA or page mismatches", async () => {
    mocks.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          session_id: "session",
          timestamp: now,
          sequence: 1,
          event_data_key: "",
          batch_index: 0,
          source_hash: "wrong",
          meta: JSON.stringify({ href: "https://example.com/other", width: 375, height: 800 }),
        },
        {
          session_id: "session",
          timestamp: now,
          sequence: 1,
          event_data_key: "",
          batch_index: 0,
          source_hash: "correct",
          meta: JSON.stringify({ href: "https://example.com/page", width: 375, height: 800 }),
        },
      ])
      .mockResolvedValueOnce([{ data: JSON.stringify({ node }) }]);
    expect(await getSnapshot()).toMatchObject({ source: "replay", node });
    expect(mocks.query.mock.calls[2][0].params.hash).toBe("correct");
  });
  it("keeps daily backgrounds usable for later report intervals and excludes future/expired sources", async () => {
    await getSnapshot();
    const query = mocks.query.mock.calls[0][0].query;
    expect(query).toContain("toStartOfDay(hs.timestamp, 'UTC') + INTERVAL 1 DAY >");
    expect(query).toContain("AND hs.timestamp <=");
    expect(query).toContain("hs.timestamp >= now() - INTERVAL 30 DAY");
    const legacy = buildLegacyHeatmapSnapshotQuery(42, context, window(), 375);
    expect(legacy.query.indexOf("HAVING count() = 1")).toBeLessThan(legacy.query.indexOf("LIMIT 40"));
    expect(legacy.query).toContain("path(JSONExtractString(meta, 'href')) = {pathname:String}");
    expect(legacy.query).toContain("f.event_data_key, '') = ifNull(m.event_data_key");
  });
  it("ignores an expired, forged, or wrong-page standalone upload", async () => {
    expect(await service.storeStandalone(42, request, context, node, now)).toBe(false);
    mocks.get.mockResolvedValueOnce({
      lease: { context: { ...context, pathname: "/other" }, request, ...attribution },
      value: "lease",
    });
    expect(await service.storeStandalone(42, request, context, node, now)).toBe(false);
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.consume).not.toHaveBeenCalled();
  });
  it("marks coverage complete only after storing the nominated masked standalone DOM", async () => {
    mocks.get.mockResolvedValue({ lease: { context, request, ...attribution }, value: "lease" });
    expect(await service.storeStandalone(42, request, context, node, now)).toBe(true);
    expect(mocks.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        values: [
          expect.objectContaining({
            source: "standalone",
            snapshot_key: request.key,
            snapshot_data: JSON.stringify(node),
            user_id: "device",
          }),
        ],
      })
    );
    expect(mocks.consume).toHaveBeenCalledWith(42, request, "uploading:lease");
    expect(mocks.insert.mock.invocationCallOrder[0]).toBeLessThan(mocks.consume.mock.invocationCallOrder[0]);
  });
  it("removes an upload if erasure revokes its lease while the insert is in flight", async () => {
    mocks.get.mockResolvedValue({ lease: { context, request, ...attribution }, value: "lease" });
    let finishInsert: () => void = () => undefined;
    mocks.insert.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finishInsert = resolve;
        })
    );
    const upload = service.storeStandalone(42, request, context, node, now);
    await vi.waitFor(() => expect(mocks.insert).toHaveBeenCalled());
    // An erasure removed the uploading lease and already deleted existing rows.
    mocks.consume.mockResolvedValueOnce(false);
    finishInsert();
    expect(await upload).toBe(false);
    expect(mocks.command).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining("source = 'standalone' AND timestamp ="),
        query_params: { siteId: 42, key: request.key, timestamp: expect.any(Number) },
      })
    );
  });
  it("does not record successful coverage when a standalone insert fails", async () => {
    mocks.get.mockResolvedValue({ lease: { context, request, ...attribution }, value: "lease" });
    mocks.insert.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(service.storeStandalone(42, request, context, node, now)).rejects.toThrow("database unavailable");
    expect(mocks.consume).not.toHaveBeenCalled();
  });
});
