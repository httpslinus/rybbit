import { heatmapWidthBucket } from "@rybbit/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { createAsnLookup } from "../../db/geolocation/asn.js";
import { IS_CLOUD } from "../../lib/const.js";
import { siteConfig } from "../../lib/siteConfig.js";
import { isHeatmapBot } from "../../services/heatmaps/heatmapBotExclusion.js";
import { heatmapSnapshotService } from "../../services/heatmaps/heatmapSnapshotService.js";
import { decideSiteExclusion } from "../../services/sites/siteExclusionDecision.js";
import { collectCandidateClientIps, resolveClientIp } from "../../services/tracker/resolveClientIp.js";
import { usageService } from "../../services/usageService.js";
import { recordHeatmapSnapshotSchema } from "./heatmapValidation.js";

export async function recordHeatmapSnapshot(
  request: FastifyRequest<{ Params: { siteId: string }; Body: unknown }>,
  reply: FastifyReply
) {
  try {
    const body = recordHeatmapSnapshotSchema.parse(request.body);
    const site = await siteConfig.getConfig(request.params.siteId);
    if (!site) return reply.status(404).send({ error: "Site not found" });
    if (
      !site.heatmaps ||
      site.type === "mobile" ||
      site.heatmapSampleRate <= 0 ||
      (IS_CLOUD && (usageService.isSiteOverLimit(site.siteId) || usageService.isSiteWithoutPlan(site.siteId)))
    )
      return reply.send({ success: true });
    const lookupAsn = createAsnLookup();
    const ipAddress = resolveClientIp(request, { firstPartyProxy: site.firstPartyProxy, lookupAsn });
    const candidateIps = collectCandidateClientIps(request, [ipAddress]);
    const userAgent = String(request.headers["user-agent"] || "");
    if (isHeatmapBot({ headers: request.headers, userAgent, blockBots: site.blockBots, ipAddress, lookupAsn }))
      return reply.send({ success: true });
    const exclusion = await decideSiteExclusion(site, {
      ipAddress,
      candidateIps,
      userAgent,
      lookupAsn,
      hostname: body.hostname,
      pathname: body.pathname,
    });
    if (exclusion.excluded) return reply.send({ success: true });
    const { hostname, pathname, viewportWidth, viewportHeight, documentWidth, documentHeight } = body;
    const recorded = await heatmapSnapshotService.storeStandalone(
      site.siteId,
      {
        key: body.key,
        token: body.token,
        pageVisitId: body.pageVisitId,
        hostname,
        pathname,
        bucket: heatmapWidthBucket(viewportWidth),
      },
      { hostname, pathname, viewportWidth, viewportHeight, documentWidth, documentHeight },
      body.node,
      body.timestamp
    );
    if (!recorded) return reply.status(409).send({ error: "Heatmap snapshot request expired or already completed" });
    return reply.send({ success: true });
  } catch (error) {
    if (error instanceof z.ZodError) return reply.status(400).send({ error: error.errors });
    request.log.error({ err: error, siteId: request.params.siteId }, "Error recording heatmap snapshot");
    return reply.status(503).send({ error: "Unable to record heatmap snapshot" });
  }
}
