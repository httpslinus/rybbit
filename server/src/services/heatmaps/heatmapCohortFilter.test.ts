import { describe, expect, it } from "vitest";
import {
  buildHeatmapCohortScope,
  buildHeatmapCohortSummaryQuery,
  type HeatmapCohortDefinition,
} from "./heatmapCohortFilter.js";

const cohort: HeatmapCohortDefinition = {
  cohortId: 7,
  siteId: 1,
  name: "Readers",
  startDate: "2026-09-01",
  endDate: "2026-09-02",
  timeZone: "Europe/Tirane",
  filters: [{ parameter: "pathname", type: "equals", value: ["/docs"] }],
};

describe("historical heatmap cohort filter", () => {
  it("bounds every historical scan by the cohort site/window and uses effective session identity", () => {
    const { ctes, condition } = buildHeatmapCohortScope(cohort, 1);
    expect(ctes.join("\n")).toContain("pathname = '/docs'");
    expect(ctes.join("\n")).toContain("anyIf(identified_user_id, identified_user_id != '')");
    expect(ctes.join("\n")).toContain("'2026-09-01'");
    expect(ctes.join("\n")).toContain("'Europe/Tirane'");
    expect(condition).toBe(
      "COALESCE(NULLIF(identified_user_id, ''), user_id) IN (SELECT effective_user_id FROM CohortMembers)"
    );
    for (const scan of ctes.join("\n").matchAll(/FROM events\s+WHERE([^)]*)/g)) {
      expect(scan[1]).toContain("site_id = 1");
      expect(scan[1]).toContain("timestamp >=");
    }
    expect(buildHeatmapCohortSummaryQuery(cohort, 1).query).toContain("SELECT count() AS members FROM CohortMembers");
  });

  it("rejects cross-site and absent/invalid historical windows instead of expanding membership", () => {
    expect(() => buildHeatmapCohortScope(cohort, 2)).toThrow("another site");
    expect(() => buildHeatmapCohortScope({ ...cohort, filters: [] }, 1)).toThrow("historical filters");
    expect(() => buildHeatmapCohortScope({ ...cohort, startDate: "" }, 1)).toThrow();
    expect(() => buildHeatmapCohortScope({ ...cohort, startDate: "2026-02-31" }, 1)).toThrow("calendar");
    expect(() => buildHeatmapCohortScope({ ...cohort, timeZone: "Invalid/Zone" }, 1)).toThrow();
  });
});
