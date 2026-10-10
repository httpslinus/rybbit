vi.mock("../heatmaps/heatmapSnapshotClaims.js", () => ({
  heatmapSnapshotClaims: { clear: vi.fn(async () => undefined) },
}));
vi.mock("../heatmaps/heatmapSnapshotErasure.js", () => ({ clearHeatmapSnapshotMarkers: vi.fn(async () => undefined) }));
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  site: null as Record<string, unknown> | null,
  updateError: null as Error | null,
  deleteError: null as Error | null,
  updates: [] as Record<string, unknown>[],
  deletes: 0,
}));

const mocks = vi.hoisted(() => ({
  clickhouseCommand: vi.fn(),
  invalidate: vi.fn(),
  getConfig: vi.fn(),
  clearAttributions: vi.fn(),
}));

vi.mock("../../db/postgres/postgres.js", () => ({
  db: {
    query: {
      sites: {
        findFirst: vi.fn(async () => state.site),
      },
    },
    update: vi.fn(() => ({
      set: (data: Record<string, unknown>) => ({
        where: async () => {
          if (state.updateError) throw state.updateError;
          state.updates.push(data);
        },
      }),
    })),
    delete: vi.fn(() => ({
      where: async () => {
        if (state.deleteError) throw state.deleteError;
        state.deletes += 1;
      },
    })),
    // Rolls back the counted deletes when the callback throws.
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const { db } = await import("../../db/postgres/postgres.js");
      const deletesBefore = state.deletes;
      try {
        return await fn(db);
      } catch (error) {
        state.deletes = deletesBefore;
        throw error;
      }
    }),
  },
}));

vi.mock("../../db/clickhouse/clickhouse.js", () => ({
  clickhouse: { command: mocks.clickhouseCommand },
}));
vi.mock("../heatmaps/heatmapBatchClaims.js", () => ({
  heatmapBatchClaims: { clearAttributions: mocks.clearAttributions },
}));

vi.mock("../../lib/siteConfig.js", () => ({
  siteConfig: { invalidate: mocks.invalidate, getConfig: mocks.getConfig },
}));

vi.mock("../../api/stripe/getSubscription.js", () => ({
  getSubscriptionInner: vi.fn(),
}));

import { siteConfigurationLifecycle } from "./siteConfigurationLifecycle.js";

function makeSite() {
  return {
    siteId: 1,
    id: "abcdef123456",
    type: null,
    domain: "example.com",
    organizationId: "org_1",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.site = makeSite();
  state.updateError = null;
  state.deleteError = null;
  state.updates.length = 0;
  state.deletes = 0;
  mocks.clickhouseCommand.mockResolvedValue(undefined);
  mocks.clearAttributions.mockResolvedValue(undefined);
  mocks.getConfig.mockResolvedValue({ siteId: 1, id: "abcdef123456", name: "Renamed" });
});

describe("siteConfigurationLifecycle", () => {
  it.each([0, 15, 100])("persists the independent heatmap rate %s and reloads its cached config", async rate => {
    mocks.getConfig.mockResolvedValue({ siteId: 1, heatmaps: true, heatmapSampleRate: rate });

    const config = await siteConfigurationLifecycle.update(1, { heatmaps: true, heatmapSampleRate: rate });

    expect(state.updates).toEqual([expect.objectContaining({ heatmaps: true, heatmapSampleRate: rate })]);
    expect(mocks.invalidate).toHaveBeenCalledWith(state.site);
    expect(mocks.getConfig).toHaveBeenCalledWith(1);
    expect(config).toMatchObject({ heatmaps: true, heatmapSampleRate: rate });
  });

  it.each([-1, 101, NaN, Infinity, -Infinity])("rejects invalid rate %s at the lifecycle boundary", async rate => {
    await expect(siteConfigurationLifecycle.update(1, { heatmapSampleRate: rate })).rejects.toThrow(
      "Heatmap sample rate must be a finite number between 0 and 100"
    );

    expect(state.updates).toHaveLength(0);
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });

  it("rejects enabling heatmaps on a mobile site at the lifecycle boundary", async () => {
    state.site = { ...makeSite(), type: "mobile", domain: "com.example.app" };

    await expect(siteConfigurationLifecycle.update(1, { heatmaps: true })).rejects.toThrow(
      "Heatmaps are only available for web sites"
    );

    expect(state.updates).toHaveLength(0);
  });

  it.each([true, false])("persists URL fragment tracking set to %s and invalidates the cache", async enabled => {
    await siteConfigurationLifecycle.update(1, { trackUrlFragments: enabled });

    expect(state.updates).toEqual([expect.objectContaining({ trackUrlFragments: enabled })]);
    expect(mocks.invalidate).toHaveBeenCalledWith(state.site);
  });

  it("updates persistence once, invalidates the Site, and reloads its configuration", async () => {
    const result = await siteConfigurationLifecycle.update(1, { name: "Renamed" });

    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]).toMatchObject({ name: "Renamed" });
    expect(mocks.invalidate).toHaveBeenCalledOnce();
    expect(mocks.invalidate).toHaveBeenCalledWith(state.site);
    expect(mocks.getConfig).toHaveBeenCalledWith(1);
    expect(result).toMatchObject({ name: "Renamed" });
  });

  it("propagates persistence failures without invalidating the cache", async () => {
    state.updateError = new Error("postgres unavailable");

    await expect(siteConfigurationLifecycle.update(1, { name: "Renamed" })).rejects.toThrow("postgres unavailable");

    expect(mocks.invalidate).not.toHaveBeenCalled();
    expect(mocks.getConfig).not.toHaveBeenCalled();
  });

  it("owns private-link persistence and invalidation", async () => {
    const privateLinkKey = await siteConfigurationLifecycle.updatePrivateLink(1, "generate_private_link_key");

    expect(privateLinkKey).toMatch(/^[a-f0-9]{12}$/);
    expect(state.updates).toEqual([{ privateLinkKey }]);
    expect(mocks.invalidate).toHaveBeenCalledWith(state.site);
  });

  it("deletes the import rows and the Site row, wipes replay data, then invalidates the Site", async () => {
    await siteConfigurationLifecycle.delete(1);

    expect(state.deletes).toBe(2);
    expect(mocks.clickhouseCommand).toHaveBeenCalledTimes(4);
    expect(mocks.clearAttributions).toHaveBeenCalledWith(1);
    expect(mocks.clearAttributions.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.clickhouseCommand.mock.invocationCallOrder[0]
    );
    expect(mocks.clickhouseCommand).toHaveBeenCalledWith({
      query: "DELETE FROM heatmap_events WHERE site_id = {id:UInt32}",
      query_params: { id: 1 },
    });
    expect(mocks.invalidate).toHaveBeenCalledWith(state.site);
  });

  it("keeps replay data when the Postgres delete fails", async () => {
    state.deleteError = new Error("foreign key violation");

    await expect(siteConfigurationLifecycle.delete(1)).rejects.toThrow("foreign key violation");

    expect(mocks.clickhouseCommand).not.toHaveBeenCalled();
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });

  it("rolls the Site back when replay cleanup fails", async () => {
    mocks.clickhouseCommand.mockRejectedValueOnce(new Error("clickhouse unavailable"));

    await expect(siteConfigurationLifecycle.delete(1)).rejects.toThrow("clickhouse unavailable");

    expect(state.deletes).toBe(0);
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });

  it("rolls the Site back before data cleanup if retry attribution erasure fails", async () => {
    mocks.clearAttributions.mockRejectedValueOnce(new Error("Redis unavailable"));
    await expect(siteConfigurationLifecycle.delete(1)).rejects.toThrow("Redis unavailable");
    expect(state.deletes).toBe(0);
    expect(mocks.clickhouseCommand).not.toHaveBeenCalled();
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });
});
