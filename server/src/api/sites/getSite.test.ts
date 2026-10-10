import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  getUserSiteRole: vi.fn(),
}));

vi.mock("../../db/postgres/postgres.js", () => ({
  db: { query: { sites: { findFirst: mocks.findFirst } } },
}));

vi.mock("../../lib/auth-utils.js", () => ({ getUserSiteRole: mocks.getUserSiteRole }));

vi.mock("../../lib/subscriptionUtils.js", () => ({
  siteRequiresPlan: vi.fn(() => false),
  getBestSubscription: vi.fn(),
}));

import { getSite } from "./getSite.js";

describe("getSite heatmap settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUserSiteRole.mockResolvedValue("viewer");
    mocks.findFirst.mockResolvedValue({
      siteId: 123,
      id: "abcdef123456",
      type: null,
      domain: "example.com",
      organizationId: "org_1",
      createdAt: "2026-10-10T00:00:00.000Z",
      sessionReplay: false,
    });
  });

  it("returns the defaults for a site without stored heatmap settings", async () => {
    const reply = { send: vi.fn(), status: vi.fn().mockReturnThis() } as any;

    await getSite({ params: { siteId: "123" }, log: { error: vi.fn() } } as any, reply);

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ heatmaps: false, heatmapSampleRate: 15 }));
  });

  it.each([0, 15, 100])("returns saved heatmaps with replay off and sample rate %s", async rate => {
    mocks.findFirst.mockResolvedValue({
      ...(await mocks.findFirst()),
      heatmaps: true,
      heatmapSampleRate: rate,
    });
    const reply = { send: vi.fn(), status: vi.fn().mockReturnThis() } as any;

    await getSite({ params: { siteId: "123" }, log: { error: vi.fn() } } as any, reply);

    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ heatmaps: true, heatmapSampleRate: rate, sessionReplay: false })
    );
  });
});
