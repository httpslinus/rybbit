import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { heatmapWidthBucket } from "@rybbit/shared";

const { run, getSnapshot } = vi.hoisted(() => ({ run: vi.fn(), getSnapshot: vi.fn() }));
vi.mock("../../api/analytics/utils/analyticsQuery.js", () => ({ runAnalyticsQuery: run }));
vi.mock("./heatmapSnapshotService.js", () => ({ heatmapSnapshotService: { getSnapshot } }));
import {
  buildHeatmapBucketsQuery,
  buildHeatmapPagesQuery,
  buildHeatmapPointsQuery,
  buildHeatmapScrollQuery,
  buildHeatmapSummaryQuery,
  HeatmapQueryService,
  type HeatmapQueryOptions,
} from "./heatmapQueryService.js";

const options: HeatmapQueryOptions = {
  start_date: "2026-09-10",
  end_date: "2026-09-10",
  time_zone: "UTC",
  mode: "click",
};
const filter = (parameter: string, value: string, type = "equals") =>
  JSON.stringify([{ parameter, type, value: [value] }]);

describe("heatmap query builders", () => {
  it("deduplicates by persisted batch/index before all aggregates without merges", () => {
    for (const builder of [
      buildHeatmapPagesQuery,
      buildHeatmapBucketsQuery,
      buildHeatmapPointsQuery,
      buildHeatmapScrollQuery,
      buildHeatmapSummaryQuery,
    ]) {
      const { query } = builder(options, 1);
      expect(query).toContain("GROUP BY site_id, batch_id, event_index");
      expect(query).toContain("argMax(tuple(timestamp, session_id");
      expect(query).not.toContain("FINAL");
      expect(query).toContain("WHERE site_id = {siteId:UInt32} AND timestamp >=");
    }
  });

  it("binds page, search and bucket and leaves the page picker independent of selection", () => {
    const selected = {
      ...options,
      hostname: "example.com",
      pathname: "/it's",
      bucket: 375 as const,
      search: "o'brien",
    };
    const points = buildHeatmapPointsQuery(selected, 1);
    expect(points.query).not.toContain("/it's");
    expect(points.params).toMatchObject({
      siteId: 1,
      hostname: "example.com",
      pathname: "/it's",
      bucket: 375,
      mode: "click",
    });
    const pages = buildHeatmapPagesQuery(selected, 1);
    expect(pages.params).toMatchObject({ search: "o'brien", pageLimit: 101 });
    expect(pages.params).not.toHaveProperty("hostname");
    expect(pages.params).not.toHaveProperty("pathname");
    expect(pages.params).not.toHaveProperty("bucket");
    expect(buildHeatmapBucketsQuery(selected, 1).params).not.toHaveProperty("bucket");
    expect(points.query).toContain("CandidateHeatmapBatches AS");
    expect(points.query).toContain("AND batch_id IN (SELECT batch_id FROM CandidateHeatmapBatches)");
    expect(pages.query).not.toContain("CandidateHeatmapBatches");
  });

  it("keeps hostname, pathname and identity on heatmap rows, and metadata site/time bounded", () => {
    const direct = buildHeatmapPointsQuery({ ...options, filters: filter("pathname", "/page") }, 1).query;
    expect(direct).toContain("AND (pathname = '/page')");
    expect(direct).not.toContain("EventSessions");
    const identity = buildHeatmapPointsQuery({ ...options, filters: filter("user_id", "alice") }, 1).query;
    expect(identity).toContain("identified_user_id = 'alice'");
    expect(identity).not.toContain("EventSessions");
    const metadata = buildHeatmapPointsQuery(
      { ...options, filters: filter("event_name", "buy", "not_equals") },
      1
    ).query;
    expect(metadata).toContain("AdHocEventSessions AS");
    expect(metadata).toContain("session_id NOT IN");
    const scans = [...metadata.matchAll(/FROM events\s+WHERE([^)]*)/g)];
    expect(scans.length).toBe(2);
    for (const scan of scans) {
      expect(scan[1]).toMatch(/site_id = (?:1|\{siteId:UInt32\})/);
      expect(scan[1]).toContain("timestamp >=");
    }
  });

  it("uses any matching tag event, while acquisition retains existing session attribution", () => {
    const tag = buildHeatmapPointsQuery({ ...options, filters: filter("tag", "checkout") }, 1).query;
    expect(tag).toContain("AND tag = 'checkout'");
    expect(tag).not.toContain("argMax(tag");
    const acquisition = buildHeatmapPointsQuery({ ...options, filters: filter("utm_source", "google") }, 1).query;
    expect(acquisition).toContain("argMinIf(url_parameters['utm_source'], timestamp");
    expect(acquisition).toContain("AdHocMetadataSessions0");
  });

  it.each(["contains", "not_contains", "starts_with", "ends_with", "regex", "not_regex"])(
    "uses effective identity for the user_id %s operator",
    type => {
      const query = buildHeatmapSummaryQuery({ ...options, filters: filter("user_id", "alice", type) }, 1).query;
      expect(query).toContain("COALESCE(NULLIF(identified_user_id, ''), user_id)");
    }
  );

  it("canonicalizes IANA capitalization/aliases and rejects fixed offsets before querying", () => {
    expect(buildHeatmapSummaryQuery({ ...options, time_zone: "europe/tirane" }, 1).query).toContain("'Europe/Tirane'");
    expect(buildHeatmapSummaryQuery({ ...options, time_zone: "US/Eastern" }, 1).query).toContain("'America/New_York'");
    expect(buildHeatmapSummaryQuery({ ...options, time_zone: "Etc/GMT+1" }, 1).query).toContain("'Etc/GMT+1'");
    for (const time_zone of ["+01:00", "-0500"])
      expect(() => buildHeatmapSummaryQuery({ ...options, time_zone }, 1)).toThrow("IANA time zone");
  });

  it("normalizes page coordinates and every geometry dimension by bucket / captured viewport width", () => {
    const { query } = buildHeatmapPointsQuery(options, 1);
    expect(query).toContain("page_x * viewport_bucket / viewport_width AS x");
    expect(query).toContain("page_y * viewport_bucket / viewport_width AS y");
    expect(query).toContain("viewport_height * viewport_bucket / viewport_width AS viewportHeight");
    expect(query).toContain("document_height * viewport_bucket / viewport_width AS documentHeight");
    expect(query).toContain(
      "GROUP BY viewport_bucket, page_x, page_y, viewport_width, viewport_height, document_width, document_height"
    );
    expect(heatmapWidthBucket(400)).toBe(375);
    expect(heatmapWidthBucket(896)).toBe(768);
  });

  it("maxes scroll per site/session/host/path/bucket and includes exact 0/100 boundaries", () => {
    const { query } = buildHeatmapScrollQuery(options, 1);
    expect(query).toContain("GROUP BY site_id, session_id, hostname, pathname, viewport_bucket");
    expect(query).toContain("max(max_depth)");
    expect(query).toContain("GROUP BY site_id, session_id, hostname, pathname, viewport_bucket, page_visit_id");
    expect(query).toContain("max(max_depth * document_height * viewport_bucket / viewport_width)");
    expect(query).toContain("/ max(document_height * viewport_bucket / viewport_width)");
    expect(query).toContain("ARRAY JOIN range(11)");
    expect(query).toContain("max_depth >= band * 10");
  });

  it("rejects missing/malformed windows, nonfinite limits and unsupported buckets", () => {
    expect(() => buildHeatmapPagesQuery({ mode: "click" }, 1)).toThrow("bounded");
    expect(() => buildHeatmapPagesQuery({ ...options, start_date: "invalid" }, 1)).toThrow();
    expect(() => buildHeatmapPagesQuery({ ...options, start_date: "2026-02-31", end_date: "2026-03-10" }, 1)).toThrow(
      "calendar date"
    );
    expect(() => buildHeatmapPagesQuery({ ...options, start_date: "2026-09-12" }, 1)).toThrow();
    expect(() =>
      buildHeatmapPagesQuery({ mode: "click", past_minutes_start: Infinity, past_minutes_end: 0 }, 1)
    ).toThrow("finite");
    expect(() => buildHeatmapPointsQuery({ ...options, pointLimit: Infinity }, 1)).toThrow("point limit");
    expect(() => buildHeatmapPagesQuery({ ...options, pageLimit: 101 }, 1)).toThrow("page limit");
    expect(() => buildHeatmapPagesQuery({ ...options, bucket: 400 as never }, 1)).toThrow("bucket");
  });

  it("combines row and metadata alternatives inside a required group, with segments/type/bounce outside it", () => {
    const mixed = [
      { parameter: "pathname", type: "equals", value: ["/page"] },
      { parameter: "country", type: "equals", value: ["FR"] },
    ];
    const { query, params } = buildHeatmapPointsQuery(
      {
        ...options,
        filters: JSON.stringify(mixed),
        match: "any",
        hostname: "example.com",
        pathname: "/page",
        bucket: 375,
        analyticsEventType: "custom_event",
        excludeBounce: true,
        segmentFilters: [{ parameter: "tag", type: "equals", value: ["cta"] }],
      },
      1
    );
    expect(query).toContain(
      "AND ((pathname = '/page') OR session_id IN (SELECT session_id FROM AdHocMetadataSessions0))"
    );
    expect(query).toContain("AND (session_id IN (SELECT session_id FROM RequiredSegmentEventSessions))");
    expect(query).toContain("AND hostname = {hostname:String}");
    expect(query).toContain("AND pathname = {pathname:String}");
    expect(query).toContain("AND session_id IN (SELECT session_id FROM AnalyticsTypeSessions)");
    expect(query).toContain("AND session_id IN (SELECT session_id FROM NonBounceSessions)");
    expect(query).toContain("AND type = 'pageview'");
    expect(query).toContain("GROUP BY session_id HAVING count() > 1");
    expect(params).toMatchObject({ mode: "click", analyticsEventType: "custom_event", bucket: 375 });
  });

  it("rejects unsupported filters rather than silently dropping them", () => {
    expect(() => buildHeatmapPagesQuery({ ...options, filters: filter("url_param:secret", "value") }, 1)).toThrow();
    expect(() => buildHeatmapPagesQuery({ ...options, filters: "not-json" }, 1)).toThrow("Invalid JSON");
  });
});

describe("HeatmapQueryService", () => {
  beforeEach(() => {
    run.mockReset();
    getSnapshot.mockReset().mockResolvedValue(null);
  });
  afterEach(() => vi.useRealTimers());

  it("searches page lists without selecting a page or scanning bucket/detail/cohort summary", async () => {
    run.mockResolvedValueOnce([{ hostname: "example.com", pathname: "/find", count: 1, sessions: 1 }]);
    const report = await new HeatmapQueryService().getHeatmaps(
      1,
      {
        ...options,
        view: "pages",
        search: "find",
        hostname: "example.com",
        pathname: "/old",
        bucket: 375,
      },
      "example.com"
    );
    expect(report).toMatchObject({
      selectedPage: null,
      selectedBucket: null,
      pages: [{ pathname: "/find" }],
      points: [],
      geometry: null,
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("renders captured hash-route backgrounds independently of live URL framing validation", async () => {
    run
      .mockResolvedValueOnce([{ hostname: "example.com", pathname: "/#/pricing", count: 1, sessions: 1 }])
      .mockResolvedValueOnce([{ width: 375, count: 1, sessions: 1 }])
      .mockResolvedValueOnce([
        { count: 1, sessions: 1, viewportWidth: 375, viewportHeight: 800, documentWidth: 375, documentHeight: 3000 },
      ])
      .mockResolvedValueOnce([]);
    const snapshot = {
      hostname: "example.com",
      pathname: "/#/pricing",
      viewportWidth: 375,
      viewportHeight: 800,
      documentWidth: 375,
      documentHeight: 3000,
      source: "replay",
      capturedAt: "2026-09-10T00:00:00Z",
      node: { type: 0, id: 1, childNodes: [] },
    };
    getSnapshot.mockResolvedValue(snapshot);
    const report = await new HeatmapQueryService().getHeatmaps(1, options, "example.com");
    expect(getSnapshot).toHaveBeenCalledWith(
      1,
      { hostname: "example.com", pathname: "/#/pricing" },
      375,
      expect.any(Object),
      expect.any(Object)
    );
    expect(report.background).toEqual({ url: "", width: 375, height: 3000, snapshot });
  });

  it.each([
    { mode: "click" as const, past_minutes_start: 60, past_minutes_end: 0 },
    { mode: "click" as const, start_date: "2026-10-10", end_date: "2026-10-10" },
  ])("freezes the report time across delayed page, layout and detail queries: %j", async time => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-10T12:00:00.123Z"));
    run.mockImplementation(async ({ query }: { query: string }) => {
      vi.advanceTimersByTime(60_000);
      if (query.includes("SELECT hostname, pathname, count()"))
        return [{ hostname: "example.com", pathname: "/page", count: 1, sessions: 1 }];
      if (query.includes("viewport_bucket AS width")) return [{ width: 375, count: 1, sessions: 1 }];
      return [];
    });
    await new HeatmapQueryService().getHeatmaps(1, time, "example.com");
    expect(run).toHaveBeenCalledTimes(4);
    for (const [{ query }] of run.mock.calls) {
      expect(query).toContain("past_minutes_start" in time ? "2026-10-10 12:00:00" : "2026-10-10 12:00:00.123");
      expect(query).not.toContain("now()");
      expect(query).not.toContain("now64(3)");
      expect(query).not.toContain("2026-10-10 12:01:");
    }
  });

  it("renders geometry-only reports for opaque numeric pathname labels", async () => {
    run
      .mockResolvedValueOnce([{ hostname: "example.com", pathname: "123", count: 1, sessions: 1 }])
      .mockResolvedValueOnce([{ width: 375, count: 1, sessions: 1 }])
      .mockResolvedValueOnce([
        { count: 1, sessions: 1, viewportWidth: 375, viewportHeight: 800, documentWidth: 375, documentHeight: 2000 },
      ])
      .mockResolvedValueOnce([]);
    expect(await new HeatmapQueryService().getHeatmaps(1, options, "example.com")).toMatchObject({
      selectedPage: { pathname: "123" },
      background: null,
      count: 1,
    });
  });

  it("uses one frozen historical cohort scope for membership and every report stage", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-10T12:00:00.123Z"));
    run.mockImplementation(async ({ query }: { query: string }) => {
      vi.advanceTimersByTime(60_000);
      if (query.includes("SELECT count() AS members")) return [{ members: 1 }];
      if (query.includes("SELECT hostname, pathname, count()"))
        return [{ hostname: "example.com", pathname: "/page", count: 1, sessions: 1 }];
      if (query.includes("viewport_bucket AS width")) return [{ width: 375, count: 1, sessions: 1 }];
      return [];
    });
    await new HeatmapQueryService().getHeatmaps(
      1,
      {
        ...options,
        cohort: {
          cohortId: 7,
          siteId: 1,
          name: "Readers",
          startDate: "2026-10-10",
          endDate: "2026-10-10",
          timeZone: "UTC",
          filters: [{ parameter: "pathname", type: "equals", value: ["/docs"] }],
        },
      },
      "example.com"
    );
    expect(run).toHaveBeenCalledTimes(5);
    for (const [{ query }] of run.mock.calls) {
      expect(query).toContain("2026-10-10 12:00:00.123");
      expect(query).not.toContain("2026-10-10 12:01:");
      expect(query).not.toContain("now()");
    }
  });

  it("returns a complete empty report without scanning a nonexistent selected page", async () => {
    run.mockResolvedValueOnce([]);
    expect(await new HeatmapQueryService().getHeatmaps(1, options, "example.com")).toMatchObject({
      pages: [],
      buckets: [],
      selectedPage: null,
      selectedBucket: null,
      geometry: null,
      count: 0,
      sessions: 0,
      scroll: { histogram: [], totalSessions: 0 },
      truncated: { pages: false, points: false },
      limits: { pages: 100, points: 5000 },
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("shows truncation, observed bucket default, geometry and samples even if background is invalid", async () => {
    run
      .mockResolvedValueOnce([
        { hostname: "unrelated.test", pathname: "/page", count: 2, sessions: 1 },
        { hostname: "example.com", pathname: "/other", count: 1, sessions: 1 },
      ])
      .mockResolvedValueOnce([{ width: 375, count: 2, sessions: 1 }])
      .mockResolvedValueOnce([
        { count: 2, sessions: 1, viewportWidth: 375, viewportHeight: 800, documentWidth: 375, documentHeight: 3000 },
      ])
      .mockResolvedValueOnce([
        {
          x: 100,
          y: 2500,
          viewportWidth: 375,
          viewportHeight: 800,
          documentWidth: 375,
          documentHeight: 3000,
          count: 1,
        },
        { x: 50, y: 100, viewportWidth: 375, viewportHeight: 800, documentWidth: 375, documentHeight: 3000, count: 1 },
      ]);
    const report = await new HeatmapQueryService().getHeatmaps(
      1,
      { ...options, pageLimit: 1, pointLimit: 1 },
      "example.com"
    );
    expect(report).toMatchObject({
      selectedBucket: 375,
      background: null,
      count: 2,
      sessions: 1,
      truncated: { pages: true, points: true },
    });
    expect(report.geometry?.documentHeight).toBe(3000);
    expect(report.points).toHaveLength(1);
    expect(report.points[0].y).toBe(2500);
  });

  it("does not combine an unobserved explicitly selected bucket with another layout", async () => {
    run
      .mockResolvedValueOnce([{ hostname: "example.com", pathname: "/page", count: 1, sessions: 1 }])
      .mockResolvedValueOnce([{ width: 375, count: 1, sessions: 1 }]);
    const report = await new HeatmapQueryService().getHeatmaps(1, { ...options, bucket: 1440 }, "example.com");
    expect(report.points).toEqual([]);
    expect(report.selectedBucket).toBeNull();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("exposes an empty retained historical cohort instead of expanding it to everyone", async () => {
    run.mockResolvedValueOnce([]).mockResolvedValueOnce([{ members: 0 }]);
    const cohort = {
      cohortId: 7,
      siteId: 1,
      name: "Expired readers",
      startDate: "2026-01-01",
      endDate: "2026-01-01",
      timeZone: "UTC",
      filters: [{ parameter: "pathname", type: "equals", value: ["/docs"] }] as import("@rybbit/shared").Filter[],
    };
    const report = await new HeatmapQueryService().getHeatmaps(1, { ...options, cohort }, "example.com");
    expect(report.cohort).toEqual({
      cohortId: 7,
      name: "Expired readers",
      members: 0,
      startDate: "2026-01-01",
      endDate: "2026-01-01",
      timeZone: "UTC",
    });
    expect(report.count).toBe(0);
    expect(report.points).toEqual([]);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
