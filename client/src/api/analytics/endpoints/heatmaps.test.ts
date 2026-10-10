import type { Filter } from "@rybbit/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildAnalyticsRequest } from "../analyticsRequest";

const mocks = vi.hoisted(() => ({ authedFetch: vi.fn() }));
vi.mock("../../utils", async original => ({
  ...(await original<typeof import("../../utils")>()),
  authedFetch: mocks.authedFetch,
}));
import { fetchHeatmaps, heatmapDescriptor } from "./heatmaps";

beforeEach(() => vi.clearAllMocks());

describe("heatmap analytics requests", () => {
  const filter: Filter = { parameter: "utm_source", type: "equals", value: ["newsletter"] };
  const context = { time: { mode: "day" as const, day: "2026-10-10" }, timeZone: "Europe/Tirane", filters: [filter] };

  it("includes the full date/filter context and distinct page/layout/mode selection", () => {
    const options = {
      mode: "click" as const,
      hostname: "example.com",
      pathname: "/a",
      bucket: 375 as const,
      segmentId: 7,
    };
    const request = buildAnalyticsRequest(heatmapDescriptor(options), context);
    expect(request.params).toEqual({
      start_date: "2026-10-10",
      end_date: "2026-10-10",
      time_zone: "Europe/Tirane",
      filters: [filter],
      mode: "click",
      hostname: "example.com",
      pathname: "/a",
      bucket: 375,
      segment_id: 7,
      match: "all",
    });
    for (const change of [
      { mode: "scroll" as const },
      { pathname: "/b" },
      { bucket: 768 as const },
      { segmentId: 8 },
      { search: "checkout" },
      { match: "any" as const },
      { analyticsEventType: "custom_event" as const },
      { excludeBounce: true },
      { cohortId: 9 },
      { view: "pages" as const },
    ]) {
      expect(buildAnalyticsRequest(heatmapDescriptor({ ...options, ...change }), context)).not.toEqual(request);
    }
    expect(buildAnalyticsRequest(heatmapDescriptor(options), { ...context, timeZone: "UTC" })).not.toEqual(request);
    expect(buildAnalyticsRequest(heatmapDescriptor(options), { ...context, filters: [] })).not.toEqual(request);
  });

  it("keeps analytics event type distinct from the overlay mode and sends every parity selector", () => {
    expect(
      buildAnalyticsRequest(
        heatmapDescriptor({
          mode: "scroll",
          match: "any",
          analyticsEventType: "pageview",
          excludeBounce: true,
          cohortId: 17,
        }),
        context
      ).params
    ).toEqual(
      expect.objectContaining({
        mode: "scroll",
        match: "any",
        analytics_event_type: "pageview",
        exclude_bounce: true,
        cohort_id: 17,
      })
    );
    const cleared = buildAnalyticsRequest(heatmapDescriptor({ excludeBounce: false, cohortId: null }), context);
    expect(cleared.params).not.toHaveProperty("exclude_bounce");
    expect(cleared.params).not.toHaveProperty("cohort_id");
    expect(cleared.params).not.toHaveProperty("analytics_event_type");
  });

  it("uses the authenticated site request and unwraps its response", async () => {
    const result = { mode: "scroll", sessions: 3 };
    mocks.authedFetch.mockResolvedValue({ data: result });
    expect(
      await fetchHeatmaps(42, {
        startDate: "2026-10-10",
        endDate: "2026-10-10",
        timeZone: "UTC",
        mode: "scroll",
        hostname: "example.com",
        pathname: "/",
        bucket: 768,
      })
    ).toEqual(result);
    expect(mocks.authedFetch).toHaveBeenCalledWith(
      "/sites/42/heatmaps",
      expect.objectContaining({
        mode: "scroll",
        hostname: "example.com",
        pathname: "/",
        bucket: 768,
        time_zone: "UTC",
      }),
      {}
    );
  });
});
