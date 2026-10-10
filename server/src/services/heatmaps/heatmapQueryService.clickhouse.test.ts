import { createClient } from "@clickhouse/client";
import type { HeatmapWidthBucket } from "@rybbit/shared";
import SqlString from "sqlstring";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Every query shadows tables with fixture CTEs; this suite never mutates data.
vi.mock("../../api/analytics/utils/analyticsQuery.js", () => ({ runAnalyticsQuery: vi.fn() }));
import {
  buildHeatmapBucketsQuery,
  buildHeatmapPagesQuery,
  buildHeatmapPointsQuery,
  buildHeatmapScrollQuery,
  buildHeatmapSummaryQuery,
  type HeatmapQueryOptions,
} from "./heatmapQueryService.js";
import type { QuerySpec } from "../../api/analytics/utils/analyticsQuery.js";

type FixtureHeatmap = {
  site: number;
  session: string;
  batch: string;
  index: number;
  time: string;
  type: "click" | "scroll";
  hostname: string;
  path: string;
  bucket: number;
  viewportWidth: number;
  viewportHeight: number;
  documentWidth: number;
  documentHeight: number;
  x: number | null;
  y: number | null;
  depth: number | null;
  visit?: string;
};
const captured: FixtureHeatmap[] = [];
function interaction(overrides: Partial<FixtureHeatmap> = {}) {
  captured.push({
    site: 1,
    session: "a",
    batch: `batch-${captured.length}`,
    index: 0,
    time: "2026-09-10 09:00:00.000",
    type: "click",
    hostname: "example.com",
    path: "/page",
    bucket: 375,
    viewportWidth: 360,
    viewportHeight: 720,
    documentWidth: 360,
    documentHeight: 2000,
    x: 100,
    y: 500,
    depth: null,
    ...overrides,
  });
}
interaction({ batch: "duplicate" });
// A retry may resolve a different session. Deduplication must not key on it.
interaction({ batch: "duplicate", session: "retry", time: "2026-09-10 09:00:00.001" });
interaction({ session: "a" });
interaction({ session: "b", viewportWidth: 375, x: 50, y: 1000 });
interaction({
  session: "a",
  bucket: 1024,
  viewportWidth: 1000,
  viewportHeight: 800,
  documentWidth: 1000,
  x: 200,
  y: 1200,
});
interaction({ session: "a", hostname: "sub.example.com", x: 999, y: 999 });
interaction({ session: "a", path: "/other", x: 888, y: 888 });
interaction({ site: 2, session: "a", batch: "duplicate", x: 777, y: 777 });
interaction({ session: "old", time: "2026-09-09 09:00:00.000", x: 666, y: 666 });
interaction({ session: "missing", x: 0, y: 0 });
for (const [session, depth] of [
  ["a", 10],
  ["a", 30],
  ["a", 20],
  ["b", 60],
  ["c", 100],
] as const) {
  interaction({ type: "scroll", session, depth, x: null, y: null });
}
// Duplicate scroll retry and revisits do not change the denominator.
const repeat = captured.find(row => row.type === "scroll" && row.depth === 30)!;
interaction({ ...repeat });
interaction({ type: "scroll", hostname: "sub.example.com", depth: 100, x: null, y: null });
interaction({ type: "scroll", site: 2, depth: 100, x: null, y: null });
interaction({ type: "scroll", bucket: 1024, depth: 100, x: null, y: null });
interaction({ type: "scroll", session: "old", time: "2026-09-09 09:00:00.000", depth: 100, x: null, y: null });
interaction({ type: "scroll", session: "zero", path: "/edges", depth: 0, x: null, y: null });
interaction({ type: "scroll", session: "hundred", path: "/edges", depth: 100, x: null, y: null });
// Tirana's spring-forward day is 23 hours: midnight local is 23:00 UTC
// before the transition, and the next midnight is 22:00 UTC afterwards.
interaction({ path: "/dst", time: "2026-03-28 22:59:59.999" });
interaction({ path: "/dst", time: "2026-03-28 23:00:00.000" });
interaction({ path: "/dst", time: "2026-03-29 21:59:59.999" });
interaction({ path: "/dst", time: "2026-03-29 22:00:00.000" });

// Equal-timestamp historical retries must choose one deterministic attribution
// across every event, regardless of input order or event type.
for (const [session, reverse] of [
  ["a", false],
  ["b", true],
] as const) {
  for (const index of reverse ? [2, 1, 0] : [0, 1, 2]) {
    interaction({
      session,
      batch: "equal-retry",
      index,
      path: "/equal-retry",
      type: index === 2 ? "scroll" : "click",
      x: index === 2 ? null : 100 + index,
      y: index === 2 ? null : 200,
      depth: index === 2 ? 80 : null,
    });
  }
}
// Candidate narrowing must not resurrect an earlier copy whose final winner
// belongs to a different path/layout.
interaction({ batch: "conflicting-copy", path: "/candidate-old" });
interaction({ batch: "conflicting-copy", path: "/candidate-new", bucket: 1024, time: "2026-09-10 09:00:00.001" });

// One visit can report a short loading skeleton before its actual page grows.
interaction({
  type: "scroll",
  session: "growth",
  path: "/growing",
  visit: "growing-visit",
  documentHeight: 500,
  depth: 100,
  x: null,
  y: null,
});
interaction({
  type: "scroll",
  session: "growth",
  path: "/growing",
  visit: "growing-visit",
  documentHeight: 4000,
  depth: 12.5,
  x: null,
  y: null,
});
// A genuine deeper position before growth still contributes physical reach.
interaction({
  type: "scroll",
  session: "deep",
  path: "/growing-deep",
  visit: "deep-visit",
  documentHeight: 2000,
  depth: 80,
  x: null,
  y: null,
});
interaction({
  type: "scroll",
  session: "deep",
  path: "/growing-deep",
  visit: "deep-visit",
  documentHeight: 4000,
  depth: 12.5,
  x: null,
  y: null,
});
// A separate short-page revisit must not borrow the other visit's long extent.
interaction({
  type: "scroll",
  session: "revisit",
  path: "/revisited",
  visit: "first-visit",
  documentHeight: 4000,
  depth: 12.5,
  x: null,
  y: null,
});
interaction({
  type: "scroll",
  session: "revisit",
  path: "/revisited",
  visit: "second-visit",
  documentHeight: 500,
  depth: 100,
  x: null,
  y: null,
});
// Captured widths vary within the same selected bucket; normalize both reach
// and extent to that bucket before comparing the visit's samples.
interaction({
  type: "scroll",
  session: "width-change",
  path: "/width-change",
  visit: "width-visit",
  documentHeight: 1000,
  viewportWidth: 300,
  depth: 100,
  x: null,
  y: null,
});
interaction({
  type: "scroll",
  session: "width-change",
  path: "/width-change",
  visit: "width-visit",
  documentHeight: 2000,
  viewportWidth: 375,
  depth: 12.5,
  x: null,
  y: null,
});
interaction({
  type: "scroll",
  session: "width-change",
  path: "/width-change",
  visit: "width-visit",
  bucket: 1024,
  viewportWidth: 1024,
  documentHeight: 500,
  depth: 100,
  x: null,
  y: null,
});

const heatmapFields =
  "site_id UInt32, session_id String, user_id String, identified_user_id String, timestamp DateTime64(3, 'UTC'), page_visit_id String, batch_id String, event_index UInt16, type String, hostname String, pathname String, viewport_bucket UInt16, viewport_width UInt32, viewport_height UInt32, document_width UInt32, document_height UInt32, client_x Nullable(Float64), client_y Nullable(Float64), page_x Nullable(Float64), page_y Nullable(Float64), max_depth Nullable(Float64)";
const literal = (value: unknown) =>
  value === null ? "NULL" : typeof value === "number" ? String(value) : SqlString.escape(value);
const heatmapValues = captured
  .map(
    row =>
      `(${[
        row.site,
        row.session,
        `device-${row.session}`,
        row.session === "b" ? "bob" : "",
        row.time,
        row.visit ?? `visit-${row.batch}`,
        row.batch,
        row.index,
        row.type,
        row.hostname,
        row.path,
        row.bucket,
        row.viewportWidth,
        row.viewportHeight,
        row.documentWidth,
        row.documentHeight,
        row.x,
        row.y,
        row.x,
        row.y,
        row.depth,
      ]
        .map(literal)
        .join(",")})`
  )
  .join(",\n");

type AnalyticsFixture = [number, string, string, string, string, string, string, string, string, string, string];
// site, timestamp, session, path, browser, country, referrer, channel, utm, event, tag
const analytics: AnalyticsFixture[] = [
  [1, "2026-09-10 08:00:00", "a", "/", "Chrome", "GB", "", "Direct", "", "", ""],
  [
    1,
    "2026-09-10 09:00:00",
    "a",
    "/page",
    "Chrome",
    "GB",
    "https://search.test/",
    "Organic Search",
    "google",
    "buy",
    "cta",
  ],
  [1, "2026-09-10 10:00:00", "a", "/other", "Chrome", "GB", "", "Direct", "", "", ""],
  [1, "2026-09-10 09:00:00", "retry", "/page", "Chrome", "GB", "", "Direct", "", "", ""],
  [
    1,
    "2026-09-10 09:00:00",
    "b",
    "/page",
    "Chrome",
    "FR",
    "https://social.test/",
    "Paid Social",
    "facebook",
    "pay",
    "checkout",
  ],
  [1, "2026-09-10 09:00:00", "c", "/page", "Firefox", "GB", "", "Direct", "", "", ""],
  // Same session on another site, and older acquisition, cannot qualify this window.
  [2, "2026-09-10 09:00:00", "a", "/page", "Chrome", "DE", "", "Direct", "foreign", "foreign", "foreign"],
  [1, "2026-09-09 09:00:00", "a", "/page", "Chrome", "GB", "", "Direct", "old", "old", "old"],
];
const analyticsFields =
  "site_id UInt32, timestamp DateTime('UTC'), timestamp_ms DateTime64(3, 'UTC'), session_id String, user_id String, identified_user_id String, pathname String, hostname String, browser String, country String, referrer String, channel String, url_parameters Map(String, String), event_name String, tag String, type String, page_title String, querystring String";
const analyticsValues = analytics
  .map(
    ([site, time, session, path, browser, country, referrer, channel, utm, event, tag]) =>
      `(${[
        site,
        time,
        time,
        session,
        `device-${session}`,
        session === "b" ? "bob" : "",
        path,
        "example.com",
        browser,
        country,
        referrer,
        channel,
      ]
        .map(literal)
        .join(",")}, map('utm_source', ${literal(utm)}, 'utm_medium', ${literal(utm === "google" ? "organic" : "")},
          'utm_campaign', ${literal(utm === "google" ? "launch" : "")}, 'utm_term', ${literal(utm === "google" ? "heatmaps" : "")},
          'utm_content', ${literal(utm === "google" ? "link" : "")}), ${[
            event,
            tag,
            event ? "custom_event" : "pageview",
            "Page",
            "campaign=one",
          ]
            .map(literal)
            .join(",")})`
  )
  .join(",\n");
const fixture = `WITH heatmap_events AS (SELECT * FROM values(${literal(heatmapFields)}, ${heatmapValues})),
  events AS (SELECT * FROM values(${literal(analyticsFields)}, ${analyticsValues}))`;
const day: HeatmapQueryOptions = { start_date: "2026-09-10", end_date: "2026-09-10", time_zone: "UTC", mode: "click" };
const selected = { ...day, hostname: "example.com", pathname: "/page", bucket: 375 as HeatmapWidthBucket };
const filter = (parameter: string, value: string, type = "equals") =>
  JSON.stringify([{ parameter, type, value: [value] }]);

describe.skipIf(!process.env.CLICKHOUSE_TEST_URL)("Heatmap report: ClickHouse results", () => {
  let client: ReturnType<typeof createClient>;
  beforeAll(() => {
    client = createClient({
      url: process.env.CLICKHOUSE_TEST_URL,
      username: process.env.CLICKHOUSE_TEST_USER || "default",
      password: process.env.CLICKHOUSE_TEST_PASSWORD || "",
      compression: { request: false, response: false },
      clickhouse_settings: { readonly: "2", max_threads: 2, max_execution_time: 10 },
    });
  });
  afterAll(async () => {
    await client.close();
  });

  async function run(spec: QuerySpec) {
    const sql = spec.query.replace(/^\s*WITH\b/, `${fixture},`);
    const result = await client.query({ query: sql, query_params: spec.params, format: "JSONEachRow" });
    return (await result.json<Record<string, unknown>>()).map(row =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          key,
          typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : value,
        ])
      )
    );
  }

  it("uses consistent historical attribution for equal-time multi-event retries and metadata/scroll denominators", async () => {
    const selection = { ...selected, pathname: "/equal-retry" };
    const [clicks] = await run(buildHeatmapSummaryQuery(selection, 1));
    expect(clicks).toMatchObject({ count: 2, sessions: 1 });
    const [fr] = await run(buildHeatmapSummaryQuery({ ...selection, filters: filter("country", "FR") }, 1));
    const [gb] = await run(buildHeatmapSummaryQuery({ ...selection, filters: filter("country", "GB") }, 1));
    const [bob] = await run(buildHeatmapSummaryQuery({ ...selection, filters: filter("user_id", "bob") }, 1));
    expect(fr.count).toBe(2);
    expect(gb.count).toBe(0);
    expect(bob.count).toBe(2);
    const scroll = await run(buildHeatmapScrollQuery({ ...selection, filters: filter("country", "FR") }, 1));
    expect(scroll.every(row => row.totalSessions === 1)).toBe(true);
    expect(scroll[8]).toMatchObject({ depth: 80, count: 1, reach: 1 });
    expect(scroll[9]).toMatchObject({ depth: 90, reach: 0 });
  });

  it("deduplicates every candidate batch copy before applying page and viewport selection", async () => {
    const [old] = await run(buildHeatmapSummaryQuery({ ...selected, pathname: "/candidate-old" }, 1));
    expect(old.count).toBe(0);
    const [winner] = await run(buildHeatmapSummaryQuery({ ...selected, pathname: "/candidate-new", bucket: 1024 }, 1));
    expect(winner).toMatchObject({ count: 1, sessions: 1 });
  });

  it("normalizes physical reach within each growing visit before taking session maxima", async () => {
    const histogram = async (pathname: string, bucket: HeatmapWidthBucket = 375) =>
      run(buildHeatmapScrollQuery({ ...selected, pathname, bucket }, 1));
    const growing = await histogram("/growing");
    expect(growing[1]).toMatchObject({ depth: 10, count: 1, reach: 1, totalSessions: 1 });
    expect(growing[2]).toMatchObject({ depth: 20, count: 0, reach: 0 });
    const deeper = await histogram("/growing-deep");
    expect(deeper[4]).toMatchObject({ depth: 40, count: 1, reach: 1 });
    expect(deeper[5].reach).toBe(0);
    const revisited = await histogram("/revisited");
    expect(revisited[10]).toMatchObject({ depth: 100, count: 1, reach: 1, totalSessions: 1 });
    const resized = await histogram("/width-change");
    expect(resized[6]).toMatchObject({ depth: 60, count: 1, reach: 1, totalSessions: 1 });
    expect(resized[7].reach).toBe(0); // normalized physical reach: 1250 / 2000 = 62.5%
    const wide = await histogram("/width-change", 1024);
    expect(wide[10]).toMatchObject({ depth: 100, count: 1, reach: 1, totalSessions: 1 });
  });

  it("counts each persisted batch/index once, isolates host/path/site and normalizes geometry", async () => {
    const points = await run(buildHeatmapPointsQuery(selected, 1));
    expect(points.reduce((total, row) => total + Number(row.count), 0)).toBe(4);
    const grouped = points.find(row => row.count === 2)!;
    expect(grouped.x).toBeCloseTo((100 * 375) / 360);
    expect(grouped.y).toBeCloseTo((500 * 375) / 360);
    expect(grouped.viewportWidth).toBe(375);
    expect(grouped.viewportHeight).toBe(750);
    expect(grouped.documentWidth).toBe(375);
    expect(grouped.documentHeight).toBeCloseTo((2000 * 375) / 360);
    expect(points.some(row => Number(row.x) > 700)).toBe(false);
    const [summary] = await run(buildHeatmapSummaryQuery(selected, 1));
    expect(summary).toMatchObject({ count: 4, sessions: 4, viewportWidth: 375, viewportHeight: 750 });
    const foreign = await run(buildHeatmapPointsQuery(selected, 2));
    expect(foreign).toHaveLength(1);
    expect(foreign[0].count).toBe(1);
  });

  it("keeps pages and observed layouts separate, searches literal quotes and enforces finite limits", async () => {
    const pages = await run(buildHeatmapPagesQuery({ ...selected, pageLimit: 1 }, 1));
    expect(pages).toHaveLength(2); // one extra row signals truncation
    expect(pages[0]).toMatchObject({ hostname: "example.com", pathname: "/page", count: 5, sessions: 4 });
    const buckets = await run(buildHeatmapBucketsQuery(selected, 1));
    expect(buckets.map(row => [row.width, row.count])).toEqual([
      [375, 4],
      [1024, 1],
    ]);
    expect(await run(buildHeatmapPagesQuery({ ...day, search: "o'brien" }, 1))).toEqual([]);
    expect(await run(buildHeatmapPagesQuery({ ...day, search: "sub.example" }, 1))).toMatchObject([
      { hostname: "sub.example.com" },
    ]);
    expect(await run(buildHeatmapPointsQuery({ ...selected, pointLimit: 1 }, 1))).toHaveLength(2);
  });

  it("maxes revisits/updates and gives inclusive cumulative reach for 30,60,100", async () => {
    const scroll = await run(buildHeatmapScrollQuery(selected, 1));
    expect(scroll).toHaveLength(11);
    expect(scroll.every(row => row.totalSessions === 3)).toBe(true);
    expect(
      scroll.filter(row => [10, 30, 50, 70, 100].includes(Number(row.depth))).map(row => [row.depth, row.reach])
    ).toEqual([
      [10, 3],
      [30, 3],
      [50, 2],
      [70, 1],
      [100, 1],
    ]);
    expect(scroll.filter(row => Number(row.count) > 0).map(row => [row.depth, row.count])).toEqual([
      [30, 1],
      [60, 1],
      [100, 1],
    ]);
    const [summary] = await run(buildHeatmapSummaryQuery({ ...selected, mode: "scroll" }, 1));
    expect(summary).toMatchObject({ count: 3, sessions: 3 });
  });

  it("includes no-scroll 0% and short-page 100% sessions exactly once", async () => {
    const rows = await run(buildHeatmapScrollQuery({ ...selected, pathname: "/edges" }, 1));
    expect(rows[0]).toMatchObject({ depth: 0, count: 1, reach: 2, totalSessions: 2 });
    expect(rows[10]).toMatchObject({ depth: 100, count: 1, reach: 1, totalSessions: 2 });
  });

  it("qualifies metadata only from this site/window, retains heatmap-only geometry without metadata filters", async () => {
    const count = async (parameter: string, value: string, type = "equals") => {
      const rows = await run(buildHeatmapSummaryQuery({ ...selected, filters: filter(parameter, value, type) }, 1));
      return rows[0].count;
    };
    expect(await count("browser", "Chrome")).toBe(3);
    expect(await count("country", "DE")).toBe(0);
    expect(await count("event_name", "foreign")).toBe(0);
    expect(await count("event_name", "old")).toBe(0);
    expect(await count("event_name", "buy")).toBe(1);
    expect(await count("event_name", "buy", "not_equals")).toBe(2);
    expect(await count("tag", "cta")).toBe(1); // tag on an earlier event qualifies
    expect(await count("utm_source", "google")).toBe(1); // first non-empty, not first row
    expect(await count("user_id", "bob")).toBe(1);
    expect(await count("user_id", "device-missing")).toBe(1); // identity is direct row metadata
    expect(await count("pathname", "^/page$", "regex")).toBe(4);
    expect(await count("pathname", "/it's")).toBe(0);
  });

  it("uses actual timezone/DST midnight boundaries", async () => {
    const [summary] = await run(
      buildHeatmapSummaryQuery(
        { ...selected, pathname: "/dst", start_date: "2026-03-29", end_date: "2026-03-29", time_zone: "Europe/Tirane" },
        1
      )
    );
    expect(summary.count).toBe(2);
  });

  it("combines mixed row/session ALL and ANY predicates while keeping saved segments and detail bounds required", async () => {
    const filters = JSON.stringify([
      { parameter: "user_id", type: "equals", value: ["bob"] },
      { parameter: "country", type: "equals", value: ["GB"] },
    ]);
    const counts = async (extra: Partial<HeatmapQueryOptions>) =>
      (await run(buildHeatmapSummaryQuery({ ...selected, filters, ...extra }, 1)))[0].count;
    expect(await counts({ match: "all" })).toBe(0);
    expect(await counts({ match: "any" })).toBe(3);
    expect(
      await counts({ match: "any", segmentFilters: [{ parameter: "country", type: "equals", value: ["FR"] }] })
    ).toBe(1);
    expect(
      await counts({ match: "any", segmentFilters: [{ parameter: "pathname", type: "equals", value: ["/other"] }] })
    ).toBe(0);
    expect(await counts({ match: "any", hostname: "sub.example.com" })).toBe(1);
    expect(await counts({ match: "any", bucket: 1024 })).toBe(1);
  });

  it("keeps analytics event type and pageview bounce exclusion independent from heatmap interactions and ANY alternatives", async () => {
    const count = async (extra: Partial<HeatmapQueryOptions>) =>
      (await run(buildHeatmapSummaryQuery({ ...selected, ...extra }, 1)))[0].count;
    expect(await count({ analyticsEventType: "pageview" })).toBe(2); // a and retry; b has only custom events
    expect(await count({ analyticsEventType: "custom_event" })).toBe(2); // a and b
    expect(await count({ excludeBounce: true })).toBe(1); // only a has two bounded pageviews
    expect(
      await count({
        match: "any",
        filters: JSON.stringify([
          { parameter: "pathname", type: "equals", value: ["/page"] },
          { parameter: "country", type: "equals", value: ["FR"] },
        ]),
        analyticsEventType: "custom_event",
        excludeBounce: true,
      })
    ).toBe(1);
  });

  it("evaluates all five UTM attribution fields, referrer/channel and any-event title/query/tag predicates", async () => {
    for (const [parameter, value] of [
      ["utm_source", "google"],
      ["utm_medium", "organic"],
      ["utm_campaign", "launch"],
      ["utm_term", "heatmaps"],
      ["utm_content", "link"],
      ["referrer", "search.test"],
      ["channel", "Organic Search"],
      ["tag", "cta"],
      ["event_name", "buy"],
    ]) {
      const [summary] = await run(buildHeatmapSummaryQuery({ ...selected, filters: filter(parameter, value) }, 1));
      expect(summary.count, parameter).toBe(1);
    }
    for (const parameter of ["page_title", "querystring"]) {
      const [summary] = await run(
        buildHeatmapSummaryQuery(
          { ...selected, filters: filter(parameter, parameter === "page_title" ? "Page" : "campaign=one") },
          1
        )
      );
      expect(summary.count, parameter).toBe(3); // the metadata-missing session cannot match
    }
  });
});
