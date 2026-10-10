import { asc, eq } from "drizzle-orm";
import { FastifyReply, FastifyRequest } from "fastify";
import { db } from "../../../db/postgres/postgres.js";
import { cohorts } from "../../../db/postgres/schema.js";
import { getCohortSiteOrganizationId, parseCohortId, resolveCohortActor, serializeCohort } from "./cohortAccess.js";

export async function getCohorts(request: FastifyRequest<{ Params: { siteId: string } }>, reply: FastifyReply) {
  const siteId = parseCohortId(request.params.siteId);
  if (!siteId) return reply.status(400).send({ error: "Invalid site ID" });
  try {
    const organizationId = await getCohortSiteOrganizationId(siteId);
    if (!organizationId) return reply.status(404).send({ error: "Site not found" });
    const actor = await resolveCohortActor(request, siteId, organizationId);
    if (!actor.hasSiteAccess) return reply.status(403).send({ error: "Forbidden" });
    const rows = await db.query.cohorts.findMany({ where: eq(cohorts.siteId, siteId), orderBy: [asc(cohorts.name)] });
    return reply.send(rows.map(row => serializeCohort(row, actor)));
  } catch (error) {
    request.log.error({ err: error }, "Error fetching cohorts");
    return reply.status(500).send({ error: "Failed to fetch cohorts" });
  }
}
