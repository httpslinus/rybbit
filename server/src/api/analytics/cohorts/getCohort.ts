import { FastifyReply, FastifyRequest } from "fastify";
import {
  canReadCohort,
  loadCohortForSite,
  parseCohortId,
  resolveCohortActor,
  serializeCohort,
} from "./cohortAccess.js";

export async function getCohort(
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
    const actor = await resolveCohortActor(request, siteId, loaded.organizationId);
    if (!canReadCohort(loaded.cohort, actor)) return reply.status(404).send({ error: "Cohort not found" });
    return reply.send(serializeCohort(loaded.cohort, actor));
  } catch (error) {
    request.log.error({ err: error }, "Error fetching cohort");
    return reply.status(500).send({ error: "Failed to fetch cohort" });
  }
}
