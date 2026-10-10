import { createClient } from "@clickhouse/client";
import SqlString from "sqlstring";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../api/analytics/utils/analyticsQuery.js", () => ({ runAnalyticsQuery: vi.fn() }));
import type { Filter } from "@rybbit/shared";
import type { QuerySpec } from "../../api/analytics/utils/analyticsQuery.js";
import { buildHeatmapSummaryQuery } from "./heatmapQueryService.js";
import { buildHeatmapCohortSummaryQuery, type HeatmapCohortDefinition } from "./heatmapCohortFilter.js";

const literal = (value: string | number) => (typeof value === "number" ? value : SqlString.escape(value));
// site, time, session, anonymous device, identified user, path
const events: [number, string, string, string, string, string][] = [
  [1, "2026-09-01 09:00:00", "historical-alice", "shared-device", "", "/docs"],
  [1, "2026-09-01 09:01:00", "historical-alice", "shared-device", "alice", "/checkout"],
  [1, "2026-09-01 10:00:00", "historical-anonymous", "anonymous-key", "", "/docs"],
  [2, "2026-09-01 09:00:00", "historical-alice", "foreign-device", "mallory", "/docs"],
  [1, "2026-08-01 09:00:00", "historical-old", "old-device", "old-user", "/docs"],
  [1, "2026-09-10 09:00:00", "alice-first", "shared-device", "alice", "/page"],
  [1, "2026-09-10 09:00:00", "alice-second", "second-device", "alice", "/page"],
  [1, "2026-09-10 09:00:00", "bob-shared", "shared-device", "bob", "/page"],
  [1, "2026-09-10 09:00:00", "unknown-shared", "shared-device", "", "/page"],
  [1, "2026-09-10 09:00:00", "anonymous-return", "anonymous-key", "", "/page"],
  [1, "2026-09-10 09:00:00", "bob-anonymous-device", "anonymous-key", "bob", "/page"],
  [1, "2026-09-10 09:00:00", "mallory-current", "foreign-device", "mallory", "/page"],
  [1, "2026-09-10 09:00:00", "old-current", "old-device", "old-user", "/page"],
  [2, "2026-09-10 09:00:00", "alice-first", "shared-device", "alice", "/page"],
];
const eventFields =
  "site_id UInt32, timestamp DateTime('UTC'), timestamp_ms DateTime64(3, 'UTC'), session_id String, user_id String, identified_user_id String, pathname String, hostname String, type String";
const heatmapFields =
  "site_id UInt32, timestamp DateTime64(3, 'UTC'), session_id String, user_id String, identified_user_id String, pathname String, hostname String, type String, page_visit_id String, batch_id String, event_index UInt16, viewport_bucket UInt16, viewport_width UInt32, viewport_height UInt32, document_width UInt32, document_height UInt32, client_x Nullable(Float64), client_y Nullable(Float64), page_x Nullable(Float64), page_y Nullable(Float64), max_depth Nullable(Float64)";
const analyticsValues = events
  .map(
    ([site, time, session, device, user, path]) =>
      `(${[site, time, time, session, device, user, path, "example.com", "pageview"].map(literal).join(",")})`
  )
  .join(",");
const heatmapValues = events
  .filter(event => event[1].startsWith("2026-09-10"))
  .map(
    ([site, time, session, device, user, path], index) =>
      `(${[
        site,
        time,
        session,
        device,
        user,
        path,
        "example.com",
        "click",
        `visit-${index}`,
        `batch-${index}`,
        0,
        375,
        375,
        750,
        375,
        2000,
        10,
        20,
        10,
        20,
      ]
        .map(literal)
        .join(",")}, NULL)`
  )
  .join(",");
const fixture = `WITH events AS (SELECT * FROM values(${literal(eventFields)}, ${analyticsValues})),
  heatmap_events AS (SELECT * FROM values(${literal(heatmapFields)}, ${heatmapValues}))`;
const cohort: HeatmapCohortDefinition = {
  cohortId: 7,
  siteId: 1,
  name: "Readers",
  startDate: "2026-09-01",
  endDate: "2026-09-01",
  timeZone: "UTC",
  filters: [{ parameter: "pathname", type: "equals", value: ["/docs"] }],
};
const report = {
  mode: "click" as const,
  hostname: "example.com",
  pathname: "/page",
  bucket: 375 as const,
  start_date: "2026-09-10",
  end_date: "2026-09-10",
  time_zone: "UTC",
  cohort,
};

describe.skipIf(!process.env.CLICKHOUSE_TEST_URL)("Heatmap cohorts: ClickHouse results", () => {
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
    const result = await client.query({
      query: spec.query.replace(/^\s*WITH\b/, `${fixture},`),
      query_params: spec.params,
      format: "JSONEachRow",
    });
    return result.json<Record<string, string | number>>();
  }

  it("evaluates a disjoint historical window and counts Alice across two current devices without Bob/shared-device leakage", async () => {
    const [members] = await run(buildHeatmapCohortSummaryQuery(cohort, 1));
    expect(Number(members.members)).toBe(2); // Alice + the truly anonymous member
    const [summary] = await run(buildHeatmapSummaryQuery(report, 1));
    expect(Number(summary.count)).toBe(3); // two Alice devices + anonymous member
    expect(Number(summary.sessions)).toBe(3);
    const [everyone] = await run(buildHeatmapSummaryQuery({ ...report, cohort: undefined }, 1));
    expect(Number(everyone.count)).toBe(8);
  });

  it("keeps cohort membership required when an ad-hoc ANY row predicate matches every current page", async () => {
    const [summary] = await run(
      buildHeatmapSummaryQuery(
        {
          ...report,
          match: "any",
          filters: JSON.stringify([
            { parameter: "pathname", type: "equals", value: ["/page"] },
            { parameter: "user_id", type: "equals", value: ["bob"] },
          ]),
        },
        1
      )
    );
    expect(Number(summary.count)).toBe(3);
  });

  it("applies string identity operators across devices without matching another identified user's fingerprint", async () => {
    for (const [type, value, count] of [
      ["contains", "ali", 2],
      ["starts_with", "ali", 2],
      ["regex", "^ali.*$", 2],
      ["not_contains", "ali", 6],
      ["contains", "bob", 2],
      ["contains", "shared-device", 1],
      ["regex", "^shared-device$", 1],
      ["not_contains", "shared-device", 7],
      ["contains", "anonymous-key", 1],
    ] as const) {
      const [summary] = await run(
        buildHeatmapSummaryQuery(
          { ...report, cohort: undefined, filters: JSON.stringify([{ parameter: "user_id", type, value: [value] }]) },
          1
        )
      );
      expect(Number(summary.count), `${type} ${value}`).toBe(count);
    }
    const identityCohort = {
      ...cohort,
      filters: [{ parameter: "user_id", type: "contains", value: ["ali"] }] as Filter[],
    };
    const [members] = await run(buildHeatmapCohortSummaryQuery(identityCohort, 1));
    expect(Number(members.members)).toBe(1);
    const [summary] = await run(buildHeatmapSummaryQuery({ ...report, cohort: identityCohort }, 1));
    expect(Number(summary.count)).toBe(2);
  });

  it.each(["utc", "us/eastern", "Etc/GMT+1"])(
    "evaluates report and historical windows using canonical IANA timezone %j",
    async timeZone => {
      const normalized = { ...cohort, timeZone };
      const [members] = await run(buildHeatmapCohortSummaryQuery(normalized, 1));
      expect(Number(members.members)).toBe(2);
      const [summary] = await run(buildHeatmapSummaryQuery({ ...report, time_zone: timeZone, cohort: normalized }, 1));
      expect(Number(summary.count)).toBe(3);
    }
  );

  it("returns zero members/samples for an absent historical window or predicate, with no fallback to current traffic", async () => {
    for (const empty of [
      { ...cohort, startDate: "2026-01-01", endDate: "2026-01-01" },
      { ...cohort, filters: [{ parameter: "pathname", type: "equals", value: ["/missing"] }] as typeof cohort.filters },
    ]) {
      const [members] = await run(buildHeatmapCohortSummaryQuery(empty, 1));
      expect(Number(members.members)).toBe(0);
      const [summary] = await run(buildHeatmapSummaryQuery({ ...report, cohort: empty }, 1));
      expect(Number(summary.count)).toBe(0);
    }
    expect(() => buildHeatmapSummaryQuery({ ...report, cohort: { ...cohort, siteId: 2 } }, 1)).toThrow("another site");
  });
});
