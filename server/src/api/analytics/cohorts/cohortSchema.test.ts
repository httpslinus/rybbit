import { describe, expect, it } from "vitest";
import { cohortWindowSchema, createCohortSchema, updateCohortSchema } from "./cohortSchema.js";

const definition = {
  name: "Historical buyers",
  startDate: "2024-02-29",
  endDate: "2024-03-31",
  timeZone: "America/New_York",
  filters: [{ parameter: "event_name", type: "equals", value: ["purchase"] }],
};

describe("cohort definition validation", () => {
  it("accepts a real leap-day window and trims the name", () => {
    expect(createCohortSchema.parse({ ...definition, name: "  Buyers  " })).toEqual({ ...definition, name: "Buyers" });
  });

  it("requires all historical window endpoints and a timezone", () => {
    for (const field of ["startDate", "endDate", "timeZone"] as const) {
      const body: Record<string, unknown> = { ...definition };
      delete body[field];
      expect(createCohortSchema.safeParse(body).success).toBe(false);
    }
  });

  it.each(["2023-02-29", "2024-02-30", "2026-04-31", "2026-13-01", "2026-1-01", "", "2026-10-10T00:00:00Z"])(
    "rejects non-calendar or malformed historical dates %j",
    startDate => {
      expect(createCohortSchema.safeParse({ ...definition, startDate }).success).toBe(false);
    }
  );

  it("allows a one-day window and rejects a reversed window", () => {
    expect(cohortWindowSchema.safeParse({ ...definition, endDate: definition.startDate }).success).toBe(true);
    expect(createCohortSchema.safeParse({ ...definition, endDate: "2024-02-28" }).success).toBe(false);
  });

  it.each(["startDate", "endDate"] as const)("rejects PostgreSQL-incompatible year zero in %s", field => {
    expect(createCohortSchema.safeParse({ ...definition, [field]: "0000-01-01" }).success).toBe(false);
    expect(updateCohortSchema.safeParse({ [field]: "0000-01-01" }).success).toBe(false);
    expect(
      createCohortSchema.safeParse({ ...definition, startDate: "0001-01-01", endDate: "0001-01-01" }).success
    ).toBe(true);
  });

  it.each(["", "Mars/Olympus", "America/New_York' OR 1=1 --", "+01:00", "-0500"])(
    "rejects an invalid timezone %j",
    timeZone => {
      expect(createCohortSchema.safeParse({ ...definition, timeZone }).success).toBe(false);
      expect(updateCohortSchema.safeParse({ timeZone }).success).toBe(false);
    }
  );

  it.each([
    ["america/new_york", "America/New_York"],
    ["US/Eastern", "America/New_York"],
    ["Etc/GMT+1", "Etc/GMT+1"],
  ])("stores canonical IANA names while accepting supported alias %j", (timeZone, canonical) => {
    expect(createCohortSchema.parse({ ...definition, timeZone }).timeZone).toBe(canonical);
    expect(updateCohortSchema.parse({ timeZone }).timeZone).toBe(canonical);
  });

  it("rejects blank or oversized names and client-selected identity/scope fields", () => {
    expect(createCohortSchema.safeParse({ ...definition, name: "  " }).success).toBe(false);
    expect(createCohortSchema.safeParse({ ...definition, name: "x".repeat(81) }).success).toBe(false);
    for (const extra of [{ siteId: 2 }, { userId: "other" }, { scope: "organization" }, { isPublic: true }]) {
      expect(createCohortSchema.safeParse({ ...definition, ...extra }).success).toBe(false);
    }
  });

  it("uses the stored segment predicate limits for cohort filters", () => {
    const filter = (parameter: string, type: string, value: unknown[]) =>
      createCohortSchema.safeParse({ ...definition, filters: [{ parameter, type, value }] }).success;
    expect(filter("browser", "equals", [])).toBe(false);
    expect(filter("session_id", "equals", ["s"])).toBe(false);
    expect(filter("pathname", "regex", ["(unclosed"])).toBe(false);
    expect(filter("pathname", "regex", ["^(?!/secret)"])).toBe(false);
    expect(filter("pathname", "regex", ["^/a", "^/b"])).toBe(false);
    expect(
      filter(
        "country",
        "equals",
        Array.from({ length: 51 }, () => "US")
      )
    ).toBe(false);
    expect(filter("pathname", "equals", ["x".repeat(501)])).toBe(false);
    expect(filter("lat", "greater_than", ["north"])).toBe(false);
    expect(filter("user_id", "is_not_null", [])).toBe(true);
    expect(createCohortSchema.safeParse({ ...definition, filters: [] }).success).toBe(false);
    expect(
      createCohortSchema.safeParse({ ...definition, filters: Array.from({ length: 21 }, () => definition.filters[0]) })
        .success
    ).toBe(false);
  });

  it("validates each supplied update field and rejects empty or unknown updates", () => {
    expect(updateCohortSchema.safeParse({ name: "Renamed" }).success).toBe(true);
    expect(updateCohortSchema.safeParse({ startDate: "2024-01-01" }).success).toBe(true);
    expect(updateCohortSchema.safeParse({ startDate: "2024-02-30" }).success).toBe(false);
    expect(updateCohortSchema.safeParse({ startDate: "2024-03-01", endDate: "2024-02-01" }).success).toBe(false);
    expect(updateCohortSchema.safeParse({ filters: [] }).success).toBe(false);
    expect(updateCohortSchema.safeParse({}).success).toBe(false);
    expect(updateCohortSchema.safeParse({ userId: "other" }).success).toBe(false);
  });
});
