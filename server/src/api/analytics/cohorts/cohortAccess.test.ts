import type { Filter, OrgRole } from "@rybbit/shared";
import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  site: { organizationId: "org_1" } as { organizationId: string | null } | undefined,
  rows: [] as Record<string, unknown>[],
  role: null as OrgRole | null,
  roleLookup: vi.fn(),
  reads: [] as unknown[],
  writes: [] as { operation: string; values?: Record<string, unknown>; where?: unknown }[],
}));

vi.mock("../../../db/postgres/postgres.js", () => ({
  db: {
    query: {
      sites: { findFirst: async () => state.site },
      cohorts: {
        findFirst: async (options: { where: unknown }) => {
          state.reads.push(options.where);
          return state.rows[0];
        },
        findMany: async (options: { where: unknown }) => {
          state.reads.push(options.where);
          return state.rows;
        },
      },
    },
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        state.writes.push({ operation: "insert", values });
        return {
          returning: async () => [{ cohortId: 99, createdAt: "2026-10-10", updatedAt: "2026-10-10", ...values }],
        };
      },
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: (where: unknown) => {
          state.writes.push({ operation: "update", values, where });
          return { returning: async () => [{ ...state.rows[0], ...values }] };
        },
      }),
    }),
    delete: () => ({
      where: (where: unknown) => {
        state.writes.push({ operation: "delete", where });
        return { returning: async () => [{ deleted: 7 }] };
      },
    }),
  },
}));
vi.mock("../../../lib/auth-utils.js", () => ({ getUserSiteRole: state.roleLookup }));

import { canEditCohort, canReadCohort, loadCohortForSite, parseCohortId, resolveCohortActor } from "./cohortAccess.js";
import { createCohort } from "./createCohort.js";
import { deleteCohort } from "./deleteCohort.js";
import { getCohort } from "./getCohort.js";
import { getCohorts } from "./getCohorts.js";
import { updateCohort } from "./updateCohort.js";

const filters: Filter[] = [{ parameter: "event_name", type: "equals", value: ["purchase"] }];
const definition = { name: "Buyers", startDate: "2026-09-01", endDate: "2026-09-30", timeZone: "UTC", filters };
const cohortRow = (overrides: Record<string, unknown> = {}) => ({
  cohortId: 7,
  siteId: 1,
  userId: "member_1",
  ...definition,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  ...overrides,
});
function request(overrides: Record<string, unknown> = {}) {
  return {
    params: { siteId: "1", cohortId: "7" },
    body: {},
    query: {},
    headers: {},
    user: { id: "member_1" },
    log: { error: vi.fn() },
    ...overrides,
  } as never;
}
function reply() {
  return {
    statusCode: 200,
    payload: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    send(payload: unknown) {
      this.payload = payload;
      return this;
    },
  };
}
const sqlQuery = (where: unknown) => new PgDialect().sqlToQuery(where as SQL);

beforeEach(() => {
  state.site = { organizationId: "org_1" };
  state.rows = [cohortRow()];
  state.role = "member";
  state.reads = [];
  state.writes = [];
  state.roleLookup.mockReset().mockImplementation(async () => state.role);
});

describe("cohort actor rules", () => {
  it("lets every site viewer read while preventing even an owning viewer from editing", async () => {
    state.role = "viewer";
    const actor = await resolveCohortActor(request(), 1, "org_1");
    expect(actor).toMatchObject({ hasSiteAccess: true, canWrite: false, canManage: false });
    expect(canReadCohort({ siteId: 1 }, actor)).toBe(true);
    expect(canEditCohort({ userId: "member_1" }, actor)).toBe(false);
  });

  it("allows members to edit their own definition and editors to edit anyone's", async () => {
    const member = await resolveCohortActor(request(), 1, "org_1");
    expect(canEditCohort({ userId: "member_1" }, member)).toBe(true);
    expect(canEditCohort({ userId: "other" }, member)).toBe(false);
    expect(canEditCohort({ userId: null }, member)).toBe(false);
    state.role = "editor";
    const editor = await resolveCohortActor(request(), 1, "org_1");
    expect(canEditCohort({ userId: "other" }, editor)).toBe(true);
    expect(canEditCohort({ userId: null }, editor)).toBe(true);
  });

  it("scopes organization-owned keys to their own organization", async () => {
    const own = await resolveCohortActor(request({ user: undefined, apiKeyOrganizationId: "org_1" }), 1, "org_1");
    expect(own).toEqual({ userId: null, hasSiteAccess: true, canWrite: true, canManage: true });
    const foreign = await resolveCohortActor(request({ user: undefined, apiKeyOrganizationId: "org_2" }), 1, "org_1");
    expect(canReadCohort({ siteId: 1 }, foreign)).toBe(false);
    expect(canEditCohort({ userId: null }, foreign)).toBe(false);
  });

  it("gives anonymous and foreign-site users no read or write access", async () => {
    expect((await resolveCohortActor(request({ user: undefined }), 1, "org_1")).hasSiteAccess).toBe(false);
    state.role = null;
    expect((await resolveCohortActor(request(), 1, "org_1")).hasSiteAccess).toBe(false);
  });

  it("rechecks current site roles for writes", async () => {
    await resolveCohortActor(request(), 1, "org_1", { forWrite: true });
    expect(state.roleLookup).toHaveBeenCalledWith(expect.anything(), 1, { fresh: true });
  });

  it.each(["0", "-1", "1abc", "1.5", "01", "2147483648", "9007199254740992"])("rejects malformed IDs %j", raw => {
    expect(parseCohortId(raw)).toBeNull();
  });
});

describe("cohort reads", () => {
  it("lists all definitions for a viewer with canEdit false and a site-bound lookup", async () => {
    state.role = "viewer";
    state.rows = [cohortRow(), cohortRow({ cohortId: 8, userId: "other" })];
    const res = reply();
    await getCohorts(request(), res as never);
    expect((res.payload as { cohortId: number; canEdit: boolean }[]).map(row => [row.cohortId, row.canEdit])).toEqual([
      [7, false],
      [8, false],
    ]);
    expect(sqlQuery(state.reads[0]).params).toEqual([1]);
    expect(sqlQuery(state.reads[0]).sql).toContain('"cohorts"."site_id"');
  });

  it("flags only the caller's definitions editable for a member", async () => {
    state.rows = [cohortRow(), cohortRow({ cohortId: 8, userId: "other" })];
    const res = reply();
    await getCohorts(request(), res as never);
    expect((res.payload as { canEdit: boolean }[]).map(row => row.canEdit)).toEqual([true, false]);
  });

  it("never exposes a public list to an anonymous caller", async () => {
    const res = reply();
    await getCohorts(request({ user: undefined }), res as never);
    expect(res.statusCode).toBe(403);
    expect(state.reads).toEqual([]);
  });

  it("reads one cohort using both its ID and site and returns 404 for another site", async () => {
    expect((await loadCohortForSite(1, 7))?.cohort.name).toBe("Buyers");
    expect(sqlQuery(state.reads[0]).params).toEqual([1, 7]);
    state.rows = [cohortRow({ siteId: 2 })];
    const res = reply();
    await getCohort(request(), res as never);
    expect(res.statusCode).toBe(404);
  });

  it("does not reveal an existing cohort to an anonymous or foreign organization caller", async () => {
    for (const req of [request({ user: undefined }), request({ user: undefined, apiKeyOrganizationId: "org_2" })]) {
      const res = reply();
      await getCohort(req, res as never);
      expect(res.statusCode).toBe(404);
    }
  });

  it("returns 404 for nonexistent and unclaimed sites", async () => {
    for (const site of [undefined, { organizationId: null }]) {
      state.site = site;
      const res = reply();
      await getCohorts(request(), res as never);
      expect(res.statusCode).toBe(404);
    }
  });
});

describe("cohort creation", () => {
  it("records the site and member owner, with no stored member list", async () => {
    const res = reply();
    await createCohort(request({ body: definition }), res as never);
    expect(res.statusCode).toBe(201);
    expect(state.writes).toEqual([{ operation: "insert", values: { ...definition, siteId: 1, userId: "member_1" } }]);
    expect(res.payload).toMatchObject({ cohortId: 99, canEdit: true, ...definition });
  });

  it("accepts an organization-owned key and stores a null account owner", async () => {
    const res = reply();
    await createCohort(request({ user: undefined, apiKeyOrganizationId: "org_1", body: definition }), res as never);
    expect(res.statusCode).toBe(201);
    expect(state.writes[0].values?.userId).toBeNull();
  });

  it("denies viewers and anonymous callers even when invoked without a route guard", async () => {
    state.role = "viewer";
    for (const req of [request({ body: definition }), request({ user: undefined, body: definition })]) {
      const res = reply();
      await createCohort(req, res as never);
      expect(res.statusCode).toBe(403);
    }
    expect(state.writes).toEqual([]);
  });

  it("rejects malformed history and predicates before persistence", async () => {
    for (const body of [
      { ...definition, startDate: "2026-02-31" },
      { ...definition, filters: [] },
      { ...definition, siteId: 2 },
    ]) {
      const res = reply();
      await createCohort(request({ body }), res as never);
      expect(res.statusCode).toBe(400);
    }
    expect(state.writes).toEqual([]);
  });
});

describe("cohort edits and deletion", () => {
  it("updates an owned definition with a site-bound mutation and retains its historical window", async () => {
    const res = reply();
    await updateCohort(request({ body: { name: "Renamed" } }), res as never);
    expect(res.statusCode).toBe(200);
    expect(res.payload).toMatchObject({ ...definition, name: "Renamed", canEdit: true });
    expect(sqlQuery(state.writes[0].where).params).toEqual([1, 7]);
  });

  it("validates partial date edits against the stored window", async () => {
    for (const body of [{ startDate: "2026-10-01" }, { endDate: "2026-08-31" }]) {
      const res = reply();
      await updateCohort(request({ body }), res as never);
      expect(res.statusCode).toBe(400);
    }
    expect(state.writes).toEqual([]);
  });

  it("denies owning viewers and members editing someone else's cohort", async () => {
    state.role = "viewer";
    let res = reply();
    await updateCohort(request({ body: { name: "Renamed" } }), res as never);
    expect(res.statusCode).toBe(403);
    state.role = "member";
    state.rows = [cohortRow({ userId: "other" })];
    res = reply();
    await updateCohort(request({ body: { name: "Renamed" } }), res as never);
    expect(res.statusCode).toBe(403);
    expect(state.writes).toEqual([]);
  });

  it("allows editors to manage another user's or account-deleted cohort", async () => {
    state.role = "editor";
    state.rows = [cohortRow({ userId: null })];
    let res = reply();
    await updateCohort(request({ body: { name: "Renamed" } }), res as never);
    expect(res.statusCode).toBe(200);
    res = reply();
    await deleteCohort(request(), res as never);
    expect(res.payload).toEqual({ success: true });
    expect(sqlQuery(state.writes[1].where).params).toEqual([1, 7]);
  });

  it("allows members to delete their own, never another user's cohort", async () => {
    let res = reply();
    await deleteCohort(request(), res as never);
    expect(res.statusCode).toBe(200);
    expect(sqlQuery(state.writes[0].where).params).toEqual([1, 7]);
    state.writes = [];
    state.rows = [cohortRow({ userId: "other" })];
    res = reply();
    await deleteCohort(request(), res as never);
    expect(res.statusCode).toBe(403);
    expect(state.writes).toEqual([]);
  });

  it("denies cross-site changes and deletion before evaluating ownership", async () => {
    state.role = "owner";
    state.rows = [cohortRow({ siteId: 2 })];
    let res = reply();
    await updateCohort(request({ body: { name: "Renamed" } }), res as never);
    expect(res.statusCode).toBe(404);
    res = reply();
    await deleteCohort(request(), res as never);
    expect(res.statusCode).toBe(404);
    expect(state.writes).toEqual([]);
  });
});
