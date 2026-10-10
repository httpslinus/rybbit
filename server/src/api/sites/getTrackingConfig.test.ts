import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  hasFeatureFlagsForRuntime: vi.fn(),
  isSiteWithoutReplay: vi.fn(),
}));

vi.mock("../../lib/siteConfig.js", () => ({
  siteConfig: { getConfig: mocks.getConfig },
}));

vi.mock("../../services/featureFlags/definitions.js", () => ({
  hasFeatureFlagsForRuntime: mocks.hasFeatureFlagsForRuntime,
}));

vi.mock("../../services/usageService.js", () => ({
  usageService: { isSiteWithoutReplay: mocks.isSiteWithoutReplay },
}));

import { getTrackingConfig } from "./getTrackingConfig.js";

describe("getTrackingConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConfig.mockResolvedValue({
      siteId: 123,
      type: "web",
      sessionReplay: false,
      heatmaps: false,
      heatmapSampleRate: 15,
      webVitals: false,
      trackErrors: false,
      trackOutbound: true,
      trackUrlParams: true,
      trackUrlFragments: false,
      trackInitialPageView: true,
      trackSpaNavigation: true,
      trackButtonClicks: false,
      trackCopy: false,
      trackFormInteractions: false,
    });
    mocks.hasFeatureFlagsForRuntime.mockResolvedValue(false);
    mocks.isSiteWithoutReplay.mockReturnValue(false);
  });

  it("tells the tracking script to skip evaluation when a site has no flags", async () => {
    const request = { params: { siteId: "123" }, log: { error: vi.fn() } } as any;
    const reply = { send: vi.fn(), status: vi.fn().mockReturnThis() } as any;

    await getTrackingConfig(request, reply);

    expect(mocks.hasFeatureFlagsForRuntime).toHaveBeenCalledWith(123, "client");
    expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ featureFlagsEnabled: false }));
  });

  it.each([true, false])("returns URL fragment tracking set to %s", async enabled => {
    mocks.getConfig.mockResolvedValue({
      ...(await mocks.getConfig()),
      trackUrlFragments: enabled,
    });
    const request = { params: { siteId: "123" }, log: { error: vi.fn() } } as any;
    const reply = { send: vi.fn(), status: vi.fn().mockReturnThis() } as any;

    await getTrackingConfig(request, reply);

    expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ trackUrlFragments: enabled }));
  });

  it("keeps heatmap collection enabled when replay is disabled by its entitlement", async () => {
    mocks.getConfig.mockResolvedValue({
      ...(await mocks.getConfig()),
      sessionReplay: true,
      heatmaps: true,
      heatmapSampleRate: 15,
    });
    mocks.isSiteWithoutReplay.mockReturnValue(true);
    const request = { params: { siteId: "123" }, log: { error: vi.fn() } } as any;
    const reply = { send: vi.fn(), status: vi.fn().mockReturnThis() } as any;

    await getTrackingConfig(request, reply);

    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ sessionReplay: false, heatmaps: true, heatmapSampleRate: 15 })
    );
  });

  it.each([0, 15, 100])("passes through the independent heatmap sample rate %s", async rate => {
    mocks.getConfig.mockResolvedValue({ ...(await mocks.getConfig()), heatmaps: true, heatmapSampleRate: rate });
    const request = { params: { siteId: "123" }, log: { error: vi.fn() } } as any;
    const reply = { send: vi.fn(), status: vi.fn().mockReturnThis() } as any;

    await getTrackingConfig(request, reply);

    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ sessionReplay: false, heatmaps: true, heatmapSampleRate: rate })
    );
  });

  it("disables heatmaps for mobile sites even if the persisted setting is enabled", async () => {
    mocks.getConfig.mockResolvedValue({ ...(await mocks.getConfig()), type: "mobile", heatmaps: true });
    const request = { params: { siteId: "123" }, log: { error: vi.fn() } } as any;
    const reply = { send: vi.fn(), status: vi.fn().mockReturnThis() } as any;

    await getTrackingConfig(request, reply);

    expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ heatmaps: false, heatmapSampleRate: 15 }));
  });
});
