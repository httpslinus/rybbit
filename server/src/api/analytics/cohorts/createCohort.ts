import { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { db } from "../../../db/postgres/postgres.js";
import { cohorts } from "../../../db/postgres/schema.js";
import { getCohortSiteOrganizationId, parseCohortId, resolveCohortActor, serializeCohort } from "./cohortAccess.js";
import { createCohortSchema } from "./cohortSchema.js";

export async function createCohort(
  request: FastifyRequest<{ Params: { siteId: string }; Body: unknown }>,
  reply: FastifyReply
) {
  const siteId = parseCohortId(request.params.siteId);
  if (!siteId) return reply.status(400).send({ error: "Invalid site ID" });
  try {
    const body = createCohortSchema.parse(request.body);
    const organizationId = await getCohortSiteOrganizationId(siteId);
    if (!organizationId) return reply.status(404).send({ error: "Site not found" });
    const actor = await resolveCohortActor(request, siteId, organizationId, { forWrite: true });
    if (!actor.hasSiteAccess || !actor.canWrite) return reply.status(403).send({ error: "Forbidden" });
    const [row] = await db
      .insert(cohorts)
      .values({ ...body, siteId, userId: actor.userId })
      .returning();
    if (!row) return reply.status(500).send({ error: "Failed to create cohort" });
    return reply.status(201).send(serializeCohort(row, actor));
  } catch (error) {
    if (error instanceof z.ZodError)
      return reply.status(400).send({ error: "Validation error", details: error.errors });
    request.log.error({ err: error }, "Error creating cohort");
    return reply.status(500).send({ error: "Failed to create cohort" });
  }
}
