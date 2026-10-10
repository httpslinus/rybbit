import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateCohortBody } from "@rybbit/shared";

const mocks = vi.hoisted(() => ({ authedFetch: vi.fn() }));
vi.mock("../../utils", () => ({ authedFetch: mocks.authedFetch }));
import { createCohort, deleteCohort, fetchCohort, fetchCohorts, updateCohort } from "./cohorts";

beforeEach(() => vi.clearAllMocks());

describe("site-scoped cohort definitions", () => {
  const body: CreateCohortBody = {
    name: "Newsletter readers",
    startDate: "2026-09-01",
    endDate: "2026-09-30",
    timeZone: "Europe/Tirane",
    filters: [{ parameter: "utm_source", type: "equals", value: ["newsletter"] }],
  };

  it("lists and reads definitions through authenticated site routes", async () => {
    const definition = { cohortId: 7, ...body };
    mocks.authedFetch.mockResolvedValueOnce([definition]).mockResolvedValueOnce(definition);
    expect(await fetchCohorts(42)).toEqual([definition]);
    expect(await fetchCohort(42, 7)).toEqual(definition);
    expect(mocks.authedFetch.mock.calls).toEqual([["/sites/42/cohorts"], ["/sites/42/cohorts/7"]]);
  });

  it("writes explicit historical windows and predicates, then deletes only the selected definition", async () => {
    await createCohort("42", body);
    await updateCohort("42", 7, { name: "Readers" });
    await deleteCohort("42", 7);
    expect(mocks.authedFetch.mock.calls).toEqual([
      ["/sites/42/cohorts", undefined, { method: "POST", data: body }],
      ["/sites/42/cohorts/7", undefined, { method: "PUT", data: { name: "Readers" } }],
      ["/sites/42/cohorts/7", undefined, { method: "DELETE" }],
    ]);
  });
});
