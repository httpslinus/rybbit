import { and, eq } from "drizzle-orm";
import { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { db } from "../../../db/postgres/postgres.js";
import { cohorts } from "../../../db/postgres/schema.js";
import {
  canEditCohort,
  canReadCohort,
  loadCohortForSite,
  parseCohortId,
  resolveCohortActor,
  serializeCohort,
} from "./cohortAccess.js";
import { cohortWindowSchema, updateCohortSchema } from "./cohortSchema.js";

export async function updateCohort(
  request: FastifyRequest<{ Params: { siteId: string; cohortId: string }; Body: unknown }>,
  reply: FastifyReply
) {
  const siteId = parseCohortId(request.params.siteId);
  const cohortId = parseCohortId(request.params.cohortId);
  if (!siteId) return reply.status(400).send({ error: "Invalid site ID" });
  if (!cohortId) return reply.status(400).send({ error: "Invalid cohort ID" });
  try {
    const body = updateCohortSchema.parse(request.body);
    const loaded = await loadCohortForSite(siteId, cohortId);
    if (!loaded) return reply.status(404).send({ error: "Cohort not found" });
    const actor = await resolveCohortActor(request, siteId, loaded.organizationId, { forWrite: true });
    if (!canReadCohort(loaded.cohort, actor)) return reply.status(404).send({ error: "Cohort not found" });
    if (!canEditCohort(loaded.cohort, actor))
      return reply.status(403).send({ error: "You can only edit cohorts you created" });
    cohortWindowSchema.parse({
      startDate: body.startDate ?? loaded.cohort.startDate,
      endDate: body.endDate ?? loaded.cohort.endDate,
      timeZone: body.timeZone ?? loaded.cohort.timeZone,
    });
    const [row] = await db
      .update(cohorts)
      .set({ ...body, updatedAt: new Date().toISOString() })
      .where(and(eq(cohorts.siteId, siteId), eq(cohorts.cohortId, cohortId)))
      .returning();
    if (!row) return reply.status(500).send({ error: "Failed to update cohort" });
    return reply.send(serializeCohort(row, actor));
  } catch (error) {
    if (error instanceof z.ZodError)
      return reply.status(400).send({ error: "Validation error", details: error.errors });
    request.log.error({ err: error }, "Error updating cohort");
    return reply.status(500).send({ error: "Failed to update cohort" });
  }
}
