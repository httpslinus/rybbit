import { describe, expect, it } from "vitest";
import { heatmapSearchForSiteSwitch, heatmapUrlParsers, readHeatmapSelection } from "./heatmapUrlState";
import { isSyncedAnalyticsRoute } from "./siteRoute";

describe("heatmap URL selection", () => {
  it("clears selections owned by the old site while preserving shared report context", () => {
    const search =
      "?heatmap_click_host=old.test&heatmap_click_path=%2Fprivate&heatmap_click_width=375" +
      "&heatmap_scroll_host=old.test&heatmap_scroll_path=%2Fstory&heatmap_scroll_width=768&heatmap_cohort=7" +
      "&heatmap_mode=scroll&heatmap_search=checkout&heatmap_match=any&heatmap_event_type=pageview" +
      "&heatmap_exclude_bounce=true&date=2026-10-10&filters=country%3AAL&bucket=hour&segment=4";
    const query = new URLSearchParams(heatmapSearchForSiteSwitch(search));
    expect([...query.keys()]).toEqual([
      "heatmap_mode",
      "heatmap_search",
      "heatmap_match",
      "heatmap_event_type",
      "heatmap_exclude_bounce",
      "date",
      "filters",
      "bucket",
      "segment",
    ]);
    expect(query.get("filters")).toBe("country:AL");
    expect(heatmapSearchForSiteSwitch("?heatmap_cohort=7")).toBe("");
    expect(heatmapSearchForSiteSwitch("")).toBe("");
  });
  it("requires a complete host/path pair and only accepts observed-width bucket values", () => {
    expect(readHeatmapSelection({ hostname: "example.com", pathname: "/a", bucket: 375 })).toEqual({
      hostname: "example.com",
      pathname: "/a",
      bucket: 375,
    });
    expect(readHeatmapSelection({ hostname: "example.com", pathname: null, bucket: 375 })).toEqual({});
    expect(readHeatmapSelection({ hostname: "example.com", pathname: "/a", bucket: 500 })).toEqual({
      hostname: "example.com",
      pathname: "/a",
    });
  });

  it("keeps heatmap widths distinct from the synchronized timeseries bucket", () => {
    expect(heatmapUrlParsers).not.toHaveProperty("bucket");
    expect(heatmapUrlParsers.heatmap_mode.parse("scroll")).toBe("scroll");
    expect(heatmapUrlParsers.heatmap_mode.parse("pageview")).toBeNull();
    expect(isSyncedAnalyticsRoute("heatmaps")).toBe(true);
  });

  it("validates and serializes report-local parity selectors without changing global filters", () => {
    expect(heatmapUrlParsers.heatmap_match.parse("any")).toBe("any");
    expect(heatmapUrlParsers.heatmap_match.parse("some")).toBeNull();
    expect(heatmapUrlParsers.heatmap_event_type.parse("custom_event")).toBe("custom_event");
    expect(heatmapUrlParsers.heatmap_event_type.parse("scroll")).toBeNull();
    expect(heatmapUrlParsers.heatmap_exclude_bounce.parse("true")).toBe(true);
    expect(heatmapUrlParsers.heatmap_exclude_bounce.serialize(true)).toBe("true");
    expect(heatmapUrlParsers.heatmap_cohort.parse("17")).toBe(17);
    expect(heatmapUrlParsers.heatmap_cohort.serialize(17)).toBe("17");
    expect(heatmapUrlParsers).not.toHaveProperty("filters");
    expect(heatmapUrlParsers).not.toHaveProperty("segment");
  });
});
