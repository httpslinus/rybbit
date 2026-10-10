import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  store: vi.fn(),
  excluded: vi.fn(),
  bot: vi.fn(),
  overLimit: vi.fn(),
  noPlan: vi.fn(),
  isCloud: false,
}));
vi.mock("../../lib/siteConfig.js", () => ({ siteConfig: { getConfig: mocks.getConfig } }));
vi.mock("../../lib/const.js", () => ({
  get IS_CLOUD() {
    return mocks.isCloud;
  },
}));
vi.mock("../../db/geolocation/asn.js", () => ({ createAsnLookup: () => () => null }));
vi.mock("../../services/tracker/resolveClientIp.js", () => ({
  resolveClientIp: () => "198.51.100.10",
  collectCandidateClientIps: () => ["198.51.100.10"],
}));
vi.mock("../../services/heatmaps/heatmapSnapshotService.js", () => ({
  heatmapSnapshotService: { storeStandalone: mocks.store },
}));
vi.mock("../../services/heatmaps/heatmapBotExclusion.js", () => ({ isHeatmapBot: mocks.bot }));
vi.mock("../../services/sites/siteExclusionDecision.js", () => ({ decideSiteExclusion: mocks.excluded }));
vi.mock("../../services/usageService.js", () => ({
  usageService: { isSiteOverLimit: mocks.overLimit, isSiteWithoutPlan: mocks.noPlan },
}));
import { recordHeatmapSnapshot } from "./recordHeatmapSnapshot.js";
const site = {
  siteId: 42,
  type: "web",
  heatmaps: true,
  heatmapSampleRate: 100,
  sessionReplay: false,
  blockBots: false,
};
const node = { type: 0, id: 1, childNodes: [] };
const body = {
  key: "heatmap-snapshot:42:" + "a".repeat(64),
  token: "7c9a13d1-d1da-4a61-9447-7199f12f86e4",
  timestamp: Date.now(),
  pageVisitId: "visit",
  hostname: "example.com",
  pathname: "/page",
  viewportWidth: 375,
  viewportHeight: 800,
  documentWidth: 375,
  documentHeight: 3000,
  node,
};
describe("nominated heatmap snapshot HTTP uploads", () => {
  const apps: ReturnType<typeof Fastify>[] = [];
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isCloud = false;
    mocks.getConfig.mockResolvedValue(site);
    mocks.store.mockResolvedValue(true);
    mocks.excluded.mockResolvedValue({ excluded: false });
    mocks.bot.mockReturnValue(false);
    mocks.overLimit.mockReturnValue(false);
    mocks.noPlan.mockReturnValue(false);
  });
  afterEach(async () => {
    await Promise.all(apps.splice(0).map(app => app.close()));
  });
  function upload(payload: unknown = body) {
    const app = Fastify();
    apps.push(app);
    app.post("/heatmaps/snapshot/:siteId", { bodyLimit: 2 * 1024 * 1024 }, recordHeatmapSnapshot);
    return app.inject({
      method: "POST",
      url: "/heatmaps/snapshot/site_abc",
      payload: payload as object,
      headers: { "content-type": "application/json", "user-agent": "Browser/140" },
    });
  }
  it("stores the nominated snapshot independently of replay quota", async () => {
    const response = await upload();
    expect(response.statusCode).toBe(200);
    expect(mocks.store).toHaveBeenCalledWith(
      42,
      {
        key: body.key,
        token: body.token,
        pageVisitId: "visit",
        hostname: "example.com",
        pathname: "/page",
        bucket: 375,
      },
      {
        hostname: "example.com",
        pathname: "/page",
        viewportWidth: 375,
        viewportHeight: 800,
        documentWidth: 375,
        documentHeight: 3000,
      },
      node,
      body.timestamp
    );
  });
  it.each([{ heatmaps: false }, { type: "mobile" }, { heatmapSampleRate: 0 }])(
    "honors disabled collection (%j)",
    async changes => {
      mocks.getConfig.mockResolvedValue({ ...site, ...changes });
      expect((await upload()).statusCode).toBe(200);
      expect(mocks.store).not.toHaveBeenCalled();
    }
  );
  it("honors cloud collection limits", async () => {
    mocks.isCloud = true;
    mocks.overLimit.mockReturnValue(true);
    expect((await upload()).statusCode).toBe(200);
    expect(mocks.store).not.toHaveBeenCalled();
  });
  it("honors excluded routes and bot decisions without consuming the nomination", async () => {
    mocks.excluded.mockResolvedValue({ excluded: true });
    expect((await upload()).statusCode).toBe(200);
    expect(mocks.store).not.toHaveBeenCalled();
    mocks.excluded.mockResolvedValue({ excluded: false });
    mocks.bot.mockReturnValue(true);
    expect((await upload()).statusCode).toBe(200);
    expect(mocks.store).not.toHaveBeenCalled();
  });
  it("rejects forged or expired capture tokens", async () => {
    mocks.store.mockResolvedValue(false);
    expect((await upload()).statusCode).toBe(409);
  });
  it.each([{ token: "bad" }, { node: {} }, { viewportWidth: 0 }, { extra: "unexpected" }, { documentHeight: 1 }])(
    "rejects invalid upload input (%j)",
    async changes => {
      expect((await upload({ ...body, ...changes })).statusCode).toBe(400);
      expect(mocks.store).not.toHaveBeenCalled();
    }
  );
  it("bounds DOM bodies to two MiB", async () => {
    expect(
      (
        await upload({
          ...body,
          node: { ...node, childNodes: [{ type: 3, id: 2, textContent: "x".repeat(2 * 1024 * 1024) }] },
        })
      ).statusCode
    ).toBe(413);
    expect(mocks.store).not.toHaveBeenCalled();
  });
});
