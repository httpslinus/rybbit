import { and, eq } from "drizzle-orm";
import { FastifyReply, FastifyRequest } from "fastify";
import { db } from "../../../db/postgres/postgres.js";
import { cohorts } from "../../../db/postgres/schema.js";
import { canEditCohort, canReadCohort, loadCohortForSite, parseCohortId, resolveCohortActor } from "./cohortAccess.js";

export async function deleteCohort(
  request: FastifyRequest<{ Params: { siteId: string; cohortId: string } }>,
  reply: FastifyReply
) {
  const siteId = parseCohortId(request.params.siteId);
  const cohortId = parseCohortId(request.params.cohortId);
  if (!siteId) return reply.status(400).send({ error: "Invalid site ID" });
  if (!cohortId) return reply.status(400).send({ error: "Invalid cohort ID" });
  try {
    const loaded = await loadCohortForSite(siteId, cohortId);
    if (!loaded) return reply.status(404).send({ error: "Cohort not found" });
    const actor = await resolveCohortActor(request, siteId, loaded.organizationId, { forWrite: true });
    if (!canReadCohort(loaded.cohort, actor)) return reply.status(404).send({ error: "Cohort not found" });
    if (!canEditCohort(loaded.cohort, actor))
      return reply.status(403).send({ error: "You can only delete cohorts you created" });
    const result = await db
      .delete(cohorts)
      .where(and(eq(cohorts.siteId, siteId), eq(cohorts.cohortId, cohortId)))
      .returning({ deleted: cohorts.cohortId });
    if (!result.length) return reply.status(500).send({ error: "Failed to delete cohort" });
    return reply.send({ success: true });
  } catch (error) {
    request.log.error({ err: error }, "Error deleting cohort");
    return reply.status(500).send({ error: "Failed to delete cohort" });
  }
}
