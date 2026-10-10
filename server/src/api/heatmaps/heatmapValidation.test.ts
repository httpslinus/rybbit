import { describe, expect, it } from "vitest";
import { recordHeatmapsSchema } from "./heatmapValidation.js";

const geometry = {
  timestamp: 1_700_000_000_000,
  pageVisitId: "page-visit",
  hostname: "example.com",
  pathname: "/page",
  viewportWidth: 375,
  viewportHeight: 800,
  documentWidth: 375,
  documentHeight: 100_000,
};
const click = { ...geometry, type: "click", clientX: 100, clientY: 300, pageX: 100, pageY: 2000 };
const scroll = { ...geometry, type: "scroll", maxDepth: 100 };

describe("heatmap upload validation", () => {
  it("accepts bounded click and scroll geometry including documents larger than UInt16", () => {
    expect(recordHeatmapsSchema.parse({ batchId: "batch", events: [click, scroll] }).events).toHaveLength(2);
  });

  it("accepts width/height UInt32 boundaries while bounding the viewport separately", () => {
    expect(
      recordHeatmapsSchema.safeParse({
        batchId: "batch",
        events: [
          {
            ...scroll,
            viewportWidth: 65535,
            viewportHeight: 65535,
            documentWidth: 0xffffffff,
            documentHeight: 0xffffffff,
          },
        ],
      }).success
    ).toBe(true);
  });

  it("keeps bounded mask patterns and quoted paths for parameterized storage", () => {
    const events = [
      { ...scroll, pathname: "re:^/user/\\d+/profile$" },
      { ...scroll, pathname: "/product/it's-here" },
    ];
    expect(recordHeatmapsSchema.parse({ batchId: "batch", events }).events).toEqual(events);
  });

  it.each([NaN, Infinity, -Infinity])("rejects non-finite geometry and timestamps (%s)", value => {
    for (const field of ["timestamp", "viewportWidth", "documentHeight", "clientX", "pageY"]) {
      expect(recordHeatmapsSchema.safeParse({ batchId: "batch", events: [{ ...click, [field]: value }] }).success).toBe(
        false
      );
    }
    expect(recordHeatmapsSchema.safeParse({ batchId: "batch", events: [{ ...scroll, maxDepth: value }] }).success).toBe(
      false
    );
  });

  it.each([
    { viewportWidth: 0 },
    { viewportHeight: -1 },
    { viewportWidth: 65536 },
    { documentHeight: 0x100000000 },
    { documentWidth: 1 },
    { documentHeight: 1 },
    { documentHeight: 1000.5 },
    { timestamp: -1 },
    { timestamp: 0.5 },
    { clientX: -1 },
    { clientY: 801 },
    { pageX: 376 },
    { pageY: 100001 },
    { pageX: 99 },
    { pageY: 299 },
  ])("rejects impossible or unbounded dimensions and coordinates %j", fields => {
    expect(recordHeatmapsSchema.safeParse({ batchId: "batch", events: [{ ...click, ...fields }] }).success).toBe(false);
  });

  it.each([-1, 100.1])("rejects scroll depth outside 0–100 (%s)", maxDepth => {
    expect(recordHeatmapsSchema.safeParse({ batchId: "batch", events: [{ ...scroll, maxDepth }] }).success).toBe(false);
  });

  it.each([
    { batchId: "" },
    { batchId: "b".repeat(129) },
    { events: [] },
    { events: Array(101).fill(scroll) },
    { userId: "u".repeat(257) },
    { anonymousId: "a".repeat(257) },
    { anonymousId: "" },
    { sessionId: "client-controlled" },
    { querystring: "?secret=value" },
  ])("rejects oversized or unsupported batch fields %j", fields => {
    expect(recordHeatmapsSchema.safeParse({ batchId: "batch", events: [scroll], ...fields }).success).toBe(false);
  });

  it.each([
    { pathname: "/" + "a".repeat(2048) },
    { pathname: "" },
    { pathname: "/page\0secret" },
    { hostname: "h".repeat(254) },
    { hostname: "example.com/foreign" },
    { hostname: "https://example.com" },
    { hostname: "example.com:443" },
    { pageVisitId: "i".repeat(257) },
    { type: "mousemove" },
    { maxDepth: 50 },
    { selector: "#personal-info" },
    { sessionId: "spoofed" },
  ])("rejects unsupported or oversized event fields %j", fields => {
    expect(recordHeatmapsSchema.safeParse({ batchId: "batch", events: [{ ...click, ...fields }] }).success).toBe(false);
  });

  it("accepts IPv6/localhost capture hosts and normalizes case", () => {
    for (const hostname of ["[::1]", "localhost", "EXAMPLE.COM"]) {
      const batch = recordHeatmapsSchema.parse({ batchId: "batch", events: [{ ...scroll, hostname }] });
      expect(batch.events[0].hostname).toBe(hostname.toLowerCase());
    }
  });
});
