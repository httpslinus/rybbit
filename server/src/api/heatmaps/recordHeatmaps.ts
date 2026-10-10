import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { createAsnLookup } from "../../db/geolocation/asn.js";
import { IS_CLOUD } from "../../lib/const.js";
import { siteConfig } from "../../lib/siteConfig.js";
import { heatmapIngestService } from "../../services/heatmaps/heatmapIngestService.js";
import { collectCandidateClientIps, resolveClientIp } from "../../services/tracker/resolveClientIp.js";
import { usageService } from "../../services/usageService.js";
import { recordHeatmapsSchema } from "./heatmapValidation.js";

export async function recordHeatmaps(
  request: FastifyRequest<{ Params: { siteId: string }; Body: unknown }>,
  reply: FastifyReply
) {
  const receivedAt = new Date();
  try {
    const body = recordHeatmapsSchema.parse(request.body);
    const site = await siteConfig.getConfig(request.params.siteId);
    if (!site) return reply.status(404).send({ error: "Site not found" });
    if (!site.heatmaps || site.type === "mobile" || site.heatmapSampleRate <= 0) {
      return reply.send({ success: true });
    }
    // Heatmaps do not consume purchased events or replay quota. Existing
    // site-wide cloud collection limits still apply; self-hosted is ungated.
    if (IS_CLOUD && (usageService.isSiteOverLimit(site.siteId) || usageService.isSiteWithoutPlan(site.siteId))) {
      return reply.send({ success: true });
    }
    const lookupAsn = createAsnLookup();
    const ipAddress = resolveClientIp(request, { firstPartyProxy: site.firstPartyProxy, lookupAsn });
    const outcome = await heatmapIngestService.recordEvents(site, body, {
      headers: request.headers,
      userAgent: String(request.headers["user-agent"] || ""),
      ipAddress,
      candidateIps: collectCandidateClientIps(request, [ipAddress]),
      lookupAsn,
      receivedAt,
    });
    if (outcome.status === "busy") {
      return reply
        .header("Retry-After", "5")
        .header("Access-Control-Expose-Headers", "Retry-After")
        .status(503)
        .send({ error: "Heatmap batch is still being recorded", code: "HEATMAP_BATCH_BUSY" });
    }
    return reply.send({
      success: true,
      ...(outcome.snapshotRequest ? { snapshotRequest: outcome.snapshotRequest } : {}),
    });
  } catch (error) {
    if (error instanceof z.ZodError) return reply.status(400).send({ error: error.errors });
    request.log.error({ err: error, siteId: request.params.siteId }, "Error recording heatmaps");
    return reply.status(503).send({ error: "Unable to record heatmaps" });
  }
}
