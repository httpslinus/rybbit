import { roleHasPermission, type Cohort } from "@rybbit/shared";
import { and, eq } from "drizzle-orm";
import { FastifyRequest } from "fastify";
import { db } from "../../../db/postgres/postgres.js";
import { cohorts, sites } from "../../../db/postgres/schema.js";
import { getUserSiteRole } from "../../../lib/auth-utils.js";

export type CohortRow = typeof cohorts.$inferSelect;

export interface CohortActor {
  userId: string | null;
  hasSiteAccess: boolean;
  canWrite: boolean;
  canManage: boolean;
}

const NO_ACCESS: CohortActor = { userId: null, hasSiteAccess: false, canWrite: false, canManage: false };

export async function getCohortSiteOrganizationId(siteId: number): Promise<string | null> {
  const site = await db.query.sites.findFirst({ where: eq(sites.siteId, siteId), columns: { organizationId: true } });
  return site?.organizationId ?? null;
}

export async function resolveCohortActor(
  request: FastifyRequest,
  siteId: number,
  organizationId: string,
  { forWrite = false }: { forWrite?: boolean } = {}
): Promise<CohortActor> {
  if (!request.user?.id && request.apiKeyOrganizationId) {
    const ownsSite = request.apiKeyOrganizationId === organizationId;
    return { userId: null, hasSiteAccess: ownsSite, canWrite: ownsSite, canManage: ownsSite };
  }
  const userId = request.user?.id ?? null;
  if (!userId) return NO_ACCESS;
  const role = await getUserSiteRole(request, siteId, { fresh: forWrite });
  return {
    userId,
    hasSiteAccess: roleHasPermission(role, "cohorts:read"),
    canWrite: roleHasPermission(role, "cohorts:write"),
    canManage: roleHasPermission(role, "cohorts:manage"),
  };
}

export function canReadCohort(_cohort: Pick<CohortRow, "siteId">, actor: CohortActor): boolean {
  return actor.hasSiteAccess;
}

export function canEditCohort(cohort: Pick<CohortRow, "userId">, actor: CohortActor): boolean {
  return (
    actor.hasSiteAccess &&
    (actor.canManage || (actor.canWrite && actor.userId !== null && cohort.userId === actor.userId))
  );
}

export async function loadCohortForSite(
  siteId: number,
  cohortId: number
): Promise<{ cohort: CohortRow; organizationId: string } | null> {
  const organizationId = await getCohortSiteOrganizationId(siteId);
  if (!organizationId) return null;
  const cohort = await db.query.cohorts.findFirst({
    where: and(eq(cohorts.siteId, siteId), eq(cohorts.cohortId, cohortId)),
  });
  if (!cohort || cohort.siteId !== siteId) return null;
  return { cohort, organizationId };
}

export function serializeCohort(row: CohortRow, actor: CohortActor): Cohort {
  return {
    cohortId: row.cohortId,
    siteId: row.siteId,
    name: row.name,
    userId: row.userId,
    startDate: row.startDate,
    endDate: row.endDate,
    timeZone: row.timeZone,
    filters: row.filters,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    canEdit: canEditCohort(row, actor),
  };
}

export function parseCohortId(raw: string): number | null {
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id <= 2147483647 ? id : null;
}
