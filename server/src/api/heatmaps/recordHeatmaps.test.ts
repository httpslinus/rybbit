import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  recordEvents: vi.fn(),
  isSiteOverLimit: vi.fn(),
  isSiteWithoutPlan: vi.fn(),
  isSiteWithoutReplay: vi.fn(),
  lookupAsn: vi.fn(),
  isCloud: false,
}));
vi.mock("../../lib/siteConfig.js", () => ({ siteConfig: { getConfig: mocks.getConfig } }));
vi.mock("../../lib/const.js", () => ({
  get IS_CLOUD() {
    return mocks.isCloud;
  },
}));
vi.mock("../../db/geolocation/asn.js", () => ({
  lookupAsn: mocks.lookupAsn,
  createAsnLookup: () => mocks.lookupAsn,
}));
vi.mock("../../services/heatmaps/heatmapIngestService.js", () => ({
  heatmapIngestService: { recordEvents: mocks.recordEvents },
}));
vi.mock("../../services/usageService.js", () => ({
  usageService: {
    isSiteOverLimit: mocks.isSiteOverLimit,
    isSiteWithoutPlan: mocks.isSiteWithoutPlan,
    isSiteWithoutReplay: mocks.isSiteWithoutReplay,
  },
}));

import { recordHeatmaps } from "./recordHeatmaps.js";

const site = {
  siteId: 42,
  heatmaps: true,
  heatmapSampleRate: 100,
  type: "web",
  firstPartyProxy: false,
  sessionReplay: false,
};
const body = {
  batchId: "batch",
  events: [
    {
      type: "scroll",
      timestamp: 1_700_000_000_000,
      pageVisitId: "visit",
      hostname: "example.com",
      pathname: "/page",
      viewportWidth: 375,
      viewportHeight: 800,
      documentWidth: 375,
      documentHeight: 2000,
      maxDepth: 40,
    },
  ],
};

describe("heatmap record HTTP handler", () => {
  const apps: ReturnType<typeof Fastify>[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isCloud = false;
    mocks.getConfig.mockResolvedValue(site);
    mocks.recordEvents.mockResolvedValue({ status: "recorded" });
    mocks.isSiteOverLimit.mockReturnValue(false);
    mocks.isSiteWithoutPlan.mockReturnValue(false);
    mocks.isSiteWithoutReplay.mockReturnValue(true);
    mocks.lookupAsn.mockReturnValue(null);
  });

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(app => app.close()));
  });

  function upload(payload: unknown = body, headers: Record<string, string> = {}) {
    const app = Fastify();
    apps.push(app);
    app.post("/heatmaps/record/:siteId", { bodyLimit: 64 * 1024 }, recordHeatmaps);
    return app.inject({
      method: "POST",
      url: "/heatmaps/record/site_abc",
      payload: payload as object,
      headers: {
        "content-type": "application/json",
        "user-agent": "Browser/140",
        "x-real-ip": "198.51.100.10",
        ...headers,
      },
    });
  }

  it("records with replay disabled or unavailable, without consulting replay quota", async () => {
    const response = await upload();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true });
    expect(mocks.getConfig).toHaveBeenCalledWith("site_abc");
    expect(mocks.recordEvents).toHaveBeenCalledWith(
      site,
      body,
      expect.objectContaining({
        ipAddress: "198.51.100.10",
        candidateIps: expect.arrayContaining(["198.51.100.10"]),
        userAgent: "Browser/140",
        receivedAt: expect.any(Date),
        lookupAsn: mocks.lookupAsn,
      })
    );
    expect(mocks.isSiteWithoutReplay).not.toHaveBeenCalled();
  });

  it("does not apply cloud subscription or pageview quota gates to self-hosted collection", async () => {
    mocks.isSiteOverLimit.mockReturnValue(true);
    mocks.isSiteWithoutPlan.mockReturnValue(true);
    expect((await upload()).statusCode).toBe(200);
    expect(mocks.recordEvents).toHaveBeenCalledOnce();
    expect(mocks.isSiteOverLimit).not.toHaveBeenCalled();
    expect(mocks.isSiteWithoutPlan).not.toHaveBeenCalled();
  });

  it.each(["over_limit", "no_plan"])("honors applicable site-wide cloud collection limits: %s", async limit => {
    mocks.isCloud = true;
    if (limit === "over_limit") mocks.isSiteOverLimit.mockReturnValue(true);
    else mocks.isSiteWithoutPlan.mockReturnValue(true);
    expect((await upload()).statusCode).toBe(200);
    expect(mocks.recordEvents).not.toHaveBeenCalled();
    expect(mocks.isSiteWithoutReplay).not.toHaveBeenCalled();
  });

  it.each([{ heatmaps: false }, { type: "mobile" }, { heatmapSampleRate: 0 }])(
    "skips collection for disabled/mobile/zero-rate config %j",
    async fields => {
      mocks.getConfig.mockResolvedValue({ ...site, ...fields });
      expect((await upload()).statusCode).toBe(200);
      expect(mocks.recordEvents).not.toHaveBeenCalled();
    }
  );

  it("rejects an unknown site", async () => {
    mocks.getConfig.mockResolvedValue(undefined);
    expect((await upload()).statusCode).toBe(404);
    expect(mocks.recordEvents).not.toHaveBeenCalled();
  });

  it("rejects forged sessions, invalid batches and non-finite numbers before ingest", async () => {
    expect((await upload({ ...body, sessionId: "spoofed" })).statusCode).toBe(400);
    expect((await upload({ ...body, events: [] })).statusCode).toBe(400);
    const wire = JSON.stringify(body).replace('"maxDepth":40', '"maxDepth":1e400');
    expect((await upload(wire)).statusCode).toBe(400);
    expect(mocks.recordEvents).not.toHaveBeenCalled();
  });

  it("rejects a payload above the route's 64-KiB bound", async () => {
    expect((await upload({ ...body, oversized: "a".repeat(64 * 1024) })).statusCode).toBe(413);
    expect(mocks.recordEvents).not.toHaveBeenCalled();
  });

  it("uses the first-party proxy IP while keeping every candidate for exclusions", async () => {
    mocks.getConfig.mockResolvedValue({ ...site, firstPartyProxy: true });
    await upload(body, { "cf-connecting-ip": "203.0.113.15", "x-forwarded-for": "198.51.100.20, 203.0.113.15" });
    expect(mocks.recordEvents).toHaveBeenCalledWith(
      expect.anything(),
      body,
      expect.objectContaining({
        ipAddress: "198.51.100.10",
        candidateIps: expect.arrayContaining(["198.51.100.10", "198.51.100.20", "203.0.113.15"]),
      })
    );
  });

  it("uses direct Cloudflare visitor IP rather than spoofable forwarded headers", async () => {
    await upload(body, { "cf-connecting-ip": "203.0.113.15", "x-forwarded-for": "198.51.100.20" });
    expect(mocks.recordEvents).toHaveBeenCalledWith(
      expect.anything(),
      body,
      expect.objectContaining({ ipAddress: "203.0.113.15" })
    );
  });

  it("does not acknowledge an in-progress duplicate", async () => {
    mocks.recordEvents.mockResolvedValue({ status: "busy" });
    const response = await upload();
    expect(response.statusCode).toBe(503);
    expect(response.headers["retry-after"]).toBe("5");
    expect(response.headers["access-control-expose-headers"]).toBe("Retry-After");
    expect(response.json().code).toBe("HEATMAP_BATCH_BUSY");
  });

  it("acknowledges a completed duplicate", async () => {
    mocks.recordEvents.mockResolvedValue({ status: "duplicate" });
    expect((await upload()).json()).toEqual({ success: true });
  });

  it("returns a retryable response without exposing internal storage errors", async () => {
    mocks.recordEvents.mockRejectedValue(new Error("private database connection detail"));
    const response = await upload();
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "Unable to record heatmaps" });
  });
});
