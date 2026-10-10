import type { HeatmapBatch, HeatmapEvent } from "@rybbit/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SiteConfigData } from "../../lib/siteConfig.js";

const mocks = vi.hoisted(() => ({
  insert: vi.fn(),
  generateUserId: vi.fn(),
  generateUserIdFromClientId: vi.fn(),
  updateSession: vi.fn(),
  decideSiteExclusion: vi.fn(),
  isHeatmapBot: vi.fn(),
}));

vi.mock("../../db/clickhouse/clickhouse.js", () => ({ clickhouse: { insert: mocks.insert } }));
vi.mock("../../db/redis/redis.js", async () => {
  const { default: RedisMock } = await import("ioredis-mock");
  return { redis: new RedisMock() };
});
vi.mock("../userId/userIdService.js", () => ({
  userIdService: { generateUserId: mocks.generateUserId, generateUserIdFromClientId: mocks.generateUserIdFromClientId },
}));
vi.mock("../sessions/sessionsService.js", () => ({ sessionsService: { updateSession: mocks.updateSession } }));
vi.mock("../sites/siteExclusionDecision.js", () => ({ decideSiteExclusion: mocks.decideSiteExclusion }));
vi.mock("./heatmapBotExclusion.js", () => ({ isHeatmapBot: mocks.isHeatmapBot }));

import { redis } from "../../db/redis/redis.js";
import { HeatmapBatchClaims, HEATMAP_PROCESSING_TTL_MS } from "./heatmapBatchClaims.js";
import { HeatmapIngestService, type HeatmapRequestMetadata } from "./heatmapIngestService.js";

const site = {
  siteId: 42,
  type: "web",
  heatmaps: true,
  heatmapSampleRate: 100,
  saltUserIds: false,
  blockBots: true,
} as SiteConfigData;
const metadata: HeatmapRequestMetadata = {
  headers: { "user-agent": "Browser/140" },
  userAgent: "Browser/140",
  ipAddress: "198.51.100.10",
  candidateIps: ["198.51.100.10", "203.0.113.10"],
  lookupAsn: () => null,
  receivedAt: new Date("2026-10-10T12:00:00Z"),
};

function event(fields: Partial<HeatmapEvent> = {}): HeatmapEvent {
  return {
    type: "scroll",
    timestamp: metadata.receivedAt.getTime(),
    pageVisitId: "page-visit",
    hostname: "example.com",
    pathname: "/page",
    viewportWidth: 375,
    viewportHeight: 800,
    documentWidth: 375,
    documentHeight: 100_000,
    maxDepth: 40,
    ...fields,
  } as HeatmapEvent;
}

function batch(fields: Partial<HeatmapBatch> = {}): HeatmapBatch {
  return { batchId: "batch", events: [event()], ...fields };
}

describe("heatmap ingestion", () => {
  let claims: HeatmapBatchClaims;
  let service: HeatmapIngestService;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(metadata.receivedAt);
    vi.clearAllMocks();
    await redis.flushall();
    claims = new HeatmapBatchClaims(redis);
    service = new HeatmapIngestService(claims);
    mocks.insert.mockResolvedValue(undefined);
    mocks.generateUserId.mockResolvedValue("server-fingerprint");
    mocks.generateUserIdFromClientId.mockResolvedValue("hashed-client-id");
    mocks.updateSession.mockImplementation(async ({ userId, identifiedUserId }) => ({
      sessionId: `session-${userId}-${identifiedUserId || "anonymous"}`,
    }));
    mocks.decideSiteExclusion.mockResolvedValue({ excluded: false });
    mocks.isHeatmapBot.mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("assigns fingerprint/session server-side and stores capture-time geometry with acknowledged async inserts", async () => {
    const click = event({ type: "click", clientX: 30, clientY: 50, pageX: 30, pageY: 1000 });
    expect(await service.recordEvents(site, batch({ events: [click, event()] }), metadata)).toEqual({
      status: "recorded",
    });
    expect(mocks.generateUserId).toHaveBeenCalledWith(metadata.ipAddress, metadata.userAgent, 42, {
      saltUserIds: false,
      lookupAsn: metadata.lookupAsn,
      receivedAt: metadata.receivedAt,
    });
    expect(mocks.updateSession).toHaveBeenCalledWith({
      siteId: 42,
      userId: "server-fingerprint",
      identifiedUserId: "",
    });
    const write = mocks.insert.mock.calls[0][0];
    expect(write).toMatchObject({
      table: "heatmap_events",
      format: "JSONEachRow",
      clickhouse_settings: { async_insert: 1, wait_for_async_insert: 1 },
    });
    expect(write.values).toEqual([
      expect.objectContaining({
        site_id: 42,
        session_id: "session-server-fingerprint-anonymous",
        user_id: "server-fingerprint",
        identified_user_id: "",
        timestamp: "2026-10-10T12:00:00.000Z",
        batch_id: "batch",
        event_index: 0,
        page_visit_id: "page-visit",
        hostname: "example.com",
        pathname: "/page",
        viewport_bucket: 375,
        viewport_width: 375,
        viewport_height: 800,
        document_width: 375,
        document_height: 100_000,
        type: "click",
        client_x: 30,
        client_y: 50,
        page_x: 30,
        page_y: 1000,
        max_depth: null,
      }),
      expect.objectContaining({
        event_index: 1,
        type: "scroll",
        client_x: null,
        client_y: null,
        page_x: null,
        page_y: null,
        max_depth: 40,
      }),
    ]);
  });

  it("separates identified people behind one fingerprint without replacing anonymous identity", async () => {
    await service.recordEvents(site, batch({ batchId: "alice", userId: "  alice  " }), metadata);
    await service.recordEvents(site, batch({ batchId: "bob", userId: "bob" }), metadata);
    const rows = mocks.insert.mock.calls.flatMap(([write]) => write.values);
    expect(rows.map(row => row.user_id)).toEqual(["server-fingerprint", "server-fingerprint"]);
    expect(rows.map(row => row.identified_user_id)).toEqual(["alice", "bob"]);
    expect(new Set(rows.map(row => row.session_id)).size).toBe(2);
  });

  it("hashes explicit client identities with server salt and never stores their raw value", async () => {
    await service.recordEvents({ ...site, saltUserIds: true }, batch({ anonymousId: "raw-client-id" }), metadata);
    expect(mocks.generateUserId).not.toHaveBeenCalled();
    expect(mocks.generateUserIdFromClientId).toHaveBeenCalledWith("raw-client-id", 42, {
      saltUserIds: true,
      receivedAt: metadata.receivedAt,
      lookupAsn: metadata.lookupAsn,
    });
    expect(mocks.insert.mock.calls[0][0].values[0].user_id).toBe("hashed-client-id");
    expect(JSON.stringify(mocks.insert.mock.calls[0][0].values)).not.toContain("raw-client-id");
  });

  it("does not treat the server fingerprint itself as an identified user", async () => {
    await service.recordEvents(site, batch({ userId: "server-fingerprint" }), metadata);
    expect(mocks.updateSession).toHaveBeenCalledWith({
      siteId: 42,
      userId: "server-fingerprint",
      identifiedUserId: "",
    });
  });

  it("checks captured paths and hosts individually, retaining original indices in mixed SPA batches", async () => {
    mocks.decideSiteExclusion.mockImplementation(async (_site, input) => ({
      excluded: input.pathname === "/private" || input.hostname === "excluded.example",
    }));
    const events = [
      event({ pathname: "/private" }),
      event({ pathname: "/public" }),
      event({ hostname: "excluded.example", pathname: "/public" }),
      event({ pathname: "/public" }),
    ];
    await service.recordEvents(site, batch({ events }), metadata);
    expect(mocks.decideSiteExclusion).toHaveBeenCalledTimes(3);
    expect(mocks.decideSiteExclusion).toHaveBeenCalledWith(
      site,
      expect.objectContaining({
        hostname: "example.com",
        pathname: "/private",
        ipAddress: metadata.ipAddress,
        candidateIps: metadata.candidateIps,
        lookupAsn: metadata.lookupAsn,
      })
    );
    expect(mocks.insert.mock.calls[0][0].values.map((row: { event_index: number }) => row.event_index)).toEqual([1, 3]);
    expect(
      mocks.insert.mock.calls[0][0].values.every(
        (row: { pathname: string; hostname: string }) => row.pathname === "/public" && row.hostname === "example.com"
      )
    ).toBe(true);
  });

  it("skips fully excluded batches before identity, sessions, bot checks and claims", async () => {
    mocks.decideSiteExclusion.mockResolvedValue({ excluded: true });
    expect(await service.recordEvents(site, batch(), metadata)).toEqual({ status: "excluded" });
    expect(mocks.generateUserId).not.toHaveBeenCalled();
    expect(mocks.updateSession).not.toHaveBeenCalled();
    expect(mocks.isHeatmapBot).not.toHaveBeenCalled();
    expect(await redis.keys("*")).toEqual([]);
  });

  it("excludes bots before creating identity or session without charging tracking anomaly counters", async () => {
    mocks.isHeatmapBot.mockReturnValue(true);
    expect(await service.recordEvents(site, batch(), metadata)).toEqual({ status: "bot" });
    expect(mocks.generateUserId).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(await redis.keys("*")).toEqual([]);
  });

  it("inserts one of concurrent identical requests and acknowledges a repeat only after completion", async () => {
    let inserted!: () => void;
    let finishInsert!: () => void;
    const reachedInsert = new Promise<void>(resolve => {
      inserted = resolve;
    });
    mocks.insert.mockImplementationOnce(() => {
      inserted();
      return new Promise<void>(resolve => {
        finishInsert = resolve;
      });
    });
    const first = service.recordEvents(site, batch(), metadata);
    await reachedInsert;
    expect(await service.recordEvents(site, batch(), metadata)).toEqual({ status: "busy" });
    expect(mocks.insert).toHaveBeenCalledOnce();
    finishInsert();
    expect(await first).toEqual({ status: "recorded" });
    expect(await service.recordEvents(site, batch(), metadata)).toEqual({ status: "duplicate" });
    expect(mocks.insert).toHaveBeenCalledOnce();
    expect(mocks.updateSession).toHaveBeenCalledOnce();
  });

  it("isolates identical batch IDs between sites", async () => {
    await service.recordEvents(site, batch(), metadata);
    await service.recordEvents({ ...site, siteId: 43 }, batch(), metadata);
    expect(mocks.insert).toHaveBeenCalledTimes(2);
    expect(mocks.insert.mock.calls.map(([write]) => write.values[0].site_id)).toEqual([42, 43]);
  });

  it.each(["identity", "session"])("releases a confirmed pre-insert %s failure so a retry can proceed", async stage => {
    const failure = new Error(`${stage} failed`);
    if (stage === "identity") mocks.generateUserId.mockRejectedValueOnce(failure);
    else mocks.updateSession.mockRejectedValueOnce(failure);
    await expect(service.recordEvents(site, batch(), metadata)).rejects.toThrow(failure.message);
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(await service.recordEvents(site, batch(), metadata)).toEqual({ status: "recorded" });
  });

  it("retains an ambiguous insert failure until lease expiry", async () => {
    mocks.insert.mockRejectedValueOnce(new Error("Insert response lost"));
    await expect(service.recordEvents(site, batch(), metadata)).rejects.toThrow("Insert response lost");
    expect(await service.recordEvents(site, batch(), metadata)).toEqual({ status: "busy" });
    vi.advanceTimersByTime(HEATMAP_PROCESSING_TTL_MS + 1);
    expect(await service.recordEvents(site, batch(), metadata)).toEqual({ status: "recorded" });
    expect(mocks.insert).toHaveBeenCalledTimes(2);
  });

  it("preserves persisted dedup keys through the crash-after-insert-before-ack window", async () => {
    vi.spyOn(claims, "complete").mockRejectedValueOnce(new Error("Completion connection lost"));
    await expect(service.recordEvents(site, batch(), metadata)).rejects.toThrow("Completion connection lost");
    expect(await service.recordEvents(site, batch(), metadata)).toEqual({ status: "busy" });
    vi.advanceTimersByTime(HEATMAP_PROCESSING_TTL_MS + 1);
    mocks.updateSession.mockResolvedValueOnce({ sessionId: "session-after-restart" });
    await service.recordEvents(site, batch(), metadata);
    const rows = mocks.insert.mock.calls.flatMap(([write]) => write.values);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map(row => row.session_id)).size).toBe(1);
    expect(new Set(rows.map(row => `${row.site_id}:${row.batch_id}:${row.event_index}`)).size).toBe(1);
    expect(mocks.updateSession).toHaveBeenCalledOnce();
  });

  it("reuses original identity, session and corrected timestamps across a multi-event retry", async () => {
    const future = new Date("2032-01-01T00:00:00Z").getTime();
    const original = batch({
      userId: "alice",
      events: [
        event({ type: "click", timestamp: future, clientX: 20, clientY: 30, pageX: 20, pageY: 30 }),
        event({ timestamp: future + 20, maxDepth: 70 }),
      ],
    });
    mocks.insert.mockRejectedValueOnce(new Error("Response lost"));
    await expect(service.recordEvents(site, original, metadata)).rejects.toThrow("Response lost");
    vi.advanceTimersByTime(HEATMAP_PROCESSING_TTL_MS + 1);
    mocks.generateUserId.mockResolvedValue("new-device");
    mocks.updateSession.mockResolvedValue({ sessionId: "retry-without-pageviews" });
    await service.recordEvents(
      site,
      { ...original, userId: "changed-on-retry" },
      {
        ...metadata,
        receivedAt: new Date(Date.now()),
        ipAddress: "203.0.113.20",
      }
    );
    expect(mocks.insert.mock.calls[1][0].values).toEqual(mocks.insert.mock.calls[0][0].values);
    expect(mocks.updateSession).toHaveBeenCalledOnce();
    expect(mocks.generateUserId).toHaveBeenCalledOnce();
    expect(
      mocks.insert.mock.calls[1][0].values.every(
        (row: { identified_user_id: string }) => row.identified_user_id === "alice"
      )
    ).toBe(true);
    expect(await redis.keys("*:attribution")).toEqual([]);
  });

  it("corrects future device clocks as a batch while preserving interaction intervals", async () => {
    const future = new Date("2032-01-01T00:00:00Z").getTime();
    await service.recordEvents(
      site,
      batch({ events: [event({ timestamp: future }), event({ timestamp: future + 20 })] }),
      metadata
    );
    const timestamps = mocks.insert.mock.calls[0][0].values.map((row: { timestamp: string }) =>
      new Date(row.timestamp).getTime()
    );
    expect(timestamps).toEqual([metadata.receivedAt.getTime() - 10, metadata.receivedAt.getTime() + 10]);
  });

  it("never inserts when Redis cannot coordinate a claim", async () => {
    vi.spyOn(claims, "claim").mockRejectedValueOnce(new Error("Redis unavailable"));
    await expect(service.recordEvents(site, batch(), metadata)).rejects.toThrow("Redis unavailable");
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.generateUserId).not.toHaveBeenCalled();
  });
});
