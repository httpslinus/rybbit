import { beforeEach, describe, expect, it, vi } from "vitest";

const { getConfig, getReport, loadCohort, resolveActor, canRead } = vi.hoisted(() => ({
  getConfig: vi.fn(),
  getReport: vi.fn(),
  loadCohort: vi.fn(),
  resolveActor: vi.fn(),
  canRead: vi.fn(),
}));
vi.mock("../analytics/cohorts/cohortAccess.js", () => ({
  loadCohortForSite: loadCohort,
  resolveCohortActor: resolveActor,
  canReadCohort: canRead,
}));
vi.mock("../../lib/siteConfig.js", () => ({ siteConfig: { getConfig } }));
vi.mock("../../api/analytics/utils/analyticsQuery.js", () => ({ runAnalyticsQuery: vi.fn() }));
import { HeatmapQueryValidationError } from "../../services/heatmaps/heatmapQueryService.js";
vi.mock("../../services/heatmaps/heatmapQueryService.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../services/heatmaps/heatmapQueryService.js")>();
  return {
    ...actual,
    HeatmapQueryService: class {
      getHeatmaps = getReport;
    },
  };
});
import { getHeatmaps, heatmapQuerySchema } from "./getHeatmaps.js";

function request(query = {}, extras = {}) {
  return { params: { siteId: "1" }, query, log: { error: vi.fn() }, ...extras } as never;
}
function reply() {
  const res = { status: vi.fn(), send: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
}

describe("heatmap report handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getConfig.mockResolvedValue({ type: "web", domain: "example.com", heatmaps: false });
    getReport.mockResolvedValue({ mode: "click", points: [] });
    loadCohort.mockResolvedValue(null);
    resolveActor.mockResolvedValue({ hasSiteAccess: true });
    canRead.mockReturnValue(true);
  });

  it("reads previously captured samples even when future collection is disabled", async () => {
    const res = reply();
    await getHeatmaps(request({ start_date: "2026-09-10", end_date: "2026-09-10" }), res as never);
    expect(getReport).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ mode: "click", pageLimit: 100, pointLimit: 5000 }),
      "example.com"
    );
    expect(res.send).toHaveBeenCalledWith({ data: { mode: "click", points: [] } });
  });

  it("reports bounded-window validation as 400 and query failures as 500", async () => {
    let res = reply();
    getReport.mockRejectedValueOnce(new HeatmapQueryValidationError("Heatmaps require a bounded date or time window"));
    await getHeatmaps(request(), res as never);
    expect(res.status).toHaveBeenCalledWith(400);
    res = reply();
    getReport.mockRejectedValueOnce(new Error("database failed"));
    await getHeatmaps(request(), res as never);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it("rejects invalid page selection, widths and finite limits before executing queries", async () => {
    for (const query of [
      { hostname: "example.com" },
      { bucket: "400" },
      { page_limit: "101" },
      { point_limit: "Infinity" },
      { mode: "pageview" },
      { view: "invalid" },
    ]) {
      const res = reply();
      await getHeatmaps(request(query), res as never);
      expect(res.status).toHaveBeenCalledWith(400);
    }
    expect(getReport).not.toHaveBeenCalled();
    expect(heatmapQuerySchema.parse({ bucket: "375" }).bucket).toBe(375);
    expect(heatmapQuerySchema.parse({ view: "pages" }).view).toBe("pages");
    expect(heatmapQuerySchema.parse({}).view).toBe("full");
  });

  it("rejects mobile sites and missing configurations", async () => {
    getConfig.mockResolvedValueOnce({ type: "mobile" }).mockResolvedValueOnce(undefined);
    const mobile = reply();
    await getHeatmaps(request(), mobile as never);
    expect(mobile.status).toHaveBeenCalledWith(400);
    const missing = reply();
    await getHeatmaps(request(), missing as never);
    expect(missing.status).toHaveBeenCalledWith(404);
    expect(getReport).not.toHaveBeenCalled();
  });

  it("passes trusted required segments separately and parses strict report-local options", async () => {
    const segmentFilters = [{ parameter: "country", type: "equals", value: ["FR"] }];
    await getHeatmaps(
      request(
        { match: "any", analytics_event_type: "custom_event", exclude_bounce: "true" },
        { heatmapSegmentFilters: segmentFilters }
      ),
      reply() as never
    );
    expect(getReport).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        match: "any",
        analyticsEventType: "custom_event",
        excludeBounce: true,
        segmentFilters,
      }),
      "example.com"
    );
    for (const query of [
      { match: "some" },
      { analytics_event_type: "click" },
      { exclude_bounce: "1" },
      { exclude_bounce: true },
      { cohort_id: "0" },
    ]) {
      const res = reply();
      await getHeatmaps(request(query), res as never);
      expect(res.status).toHaveBeenCalledWith(400);
    }
  });

  it("requires additional cohort read scope before loading membership", async () => {
    const res = reply();
    await getHeatmaps(
      request({ cohort_id: "7" }, { bearerAuth: true, bearerStatements: { heatmaps: ["read"] } }),
      res as never
    );
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.send).toHaveBeenCalledWith({ error: "Insufficient scope", required: "cohorts:read" });
    expect(loadCohort).not.toHaveBeenCalled();
  });

  it("loads a site-scoped cohort, enforces actor access and overrides attacker-supplied definitions", async () => {
    const cohort = {
      cohortId: 7,
      siteId: 1,
      name: "Returning",
      startDate: "2026-09-01",
      endDate: "2026-09-01",
      timeZone: "UTC",
      filters: [],
    };
    loadCohort.mockResolvedValue({ cohort, organizationId: "org" });
    await getHeatmaps(
      request({ cohort_id: "7", cohort: { siteId: 2 } }, { bearerAuth: true, bearerStatements: { cohorts: ["read"] } }),
      reply() as never
    );
    expect(loadCohort).toHaveBeenCalledWith(1, 7);
    expect(getReport).toHaveBeenCalledWith(1, expect.objectContaining({ cohort }), "example.com");
    canRead.mockReturnValueOnce(false);
    const denied = reply();
    await getHeatmaps(request({ cohort_id: "7" }), denied as never);
    expect(denied.status).toHaveBeenCalledWith(404);
    const untrusted = reply();
    await getHeatmaps(request({ cohort: { siteId: 2 } }), untrusted as never);
    expect(getReport).toHaveBeenLastCalledWith(1, expect.objectContaining({ cohort: undefined }), "example.com");
  });

  it("does not evaluate a missing or foreign-site cohort", async () => {
    const res = reply();
    await getHeatmaps(request({ cohort_id: "7" }), res as never);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(getReport).not.toHaveBeenCalled();
  });
});
