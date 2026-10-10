import { HEATMAP_WIDTH_BUCKETS, type HeatmapWidthBucket } from "@rybbit/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { siteConfig } from "../../lib/siteConfig.js";
import { hasScope, scopeToString } from "../../lib/scopes.js";
import { canReadCohort, loadCohortForSite, resolveCohortActor } from "../analytics/cohorts/cohortAccess.js";
import {
  HEATMAP_PAGE_LIMIT,
  HEATMAP_POINT_LIMIT,
  HeatmapQueryService,
  HeatmapQueryValidationError,
} from "../../services/heatmaps/heatmapQueryService.js";

export const heatmapQuerySchema = z
  .object({
    mode: z.enum(["click", "scroll"]).default("click"),
    view: z.enum(["full", "pages"]).default("full"),
    hostname: z.string().min(1).max(253).optional(),
    pathname: z.string().min(1).max(2048).optional(),
    bucket: z.coerce
      .number()
      .refine(value => HEATMAP_WIDTH_BUCKETS.includes(value as HeatmapWidthBucket), "Invalid viewport bucket")
      .transform(value => value as HeatmapWidthBucket)
      .optional(),
    search: z.string().trim().max(200).optional(),
    page_limit: z.coerce.number().int().min(1).max(HEATMAP_PAGE_LIMIT).default(HEATMAP_PAGE_LIMIT),
    point_limit: z.coerce.number().int().min(1).max(HEATMAP_POINT_LIMIT).default(HEATMAP_POINT_LIMIT),
    match: z.enum(["all", "any"]).default("all"),
    analytics_event_type: z.enum(["pageview", "custom_event"]).optional(),
    exclude_bounce: z
      .enum(["true", "false"])
      .default("false")
      .transform(value => value === "true"),
    cohort_id: z.coerce.number().int().min(1).max(2147483647).optional(),
  })
  .refine(query => (query.hostname === undefined) === (query.pathname === undefined), {
    message: "Select both hostname and pathname",
  });

type HeatmapRequest = { Params: { siteId: string }; Querystring: Record<string, string | undefined> };

export async function getHeatmaps(request: FastifyRequest<HeatmapRequest>, reply: FastifyReply) {
  const parsed = heatmapQuerySchema.safeParse(request.query);
  if (!parsed.success)
    return reply.status(400).send({ error: parsed.error.issues.map(issue => issue.message).join("; ") });
  try {
    const siteId = Number(request.params.siteId);
    const config = await siteConfig.getConfig(siteId);
    if (!config) return reply.status(404).send({ error: "Site not found" });
    if (config.type === "mobile") return reply.status(400).send({ error: "Heatmaps are available for web sites" });
    const {
      page_limit: pageLimit,
      point_limit: pointLimit,
      analytics_event_type: analyticsEventType,
      exclude_bounce: excludeBounce,
      cohort_id: cohortId,
      ...selection
    } = parsed.data;
    let cohort;
    if (cohortId !== undefined) {
      const scope = { resource: "cohorts", action: "read" } as const;
      if (request.bearerAuth && !hasScope(request.bearerStatements ?? null, scope)) {
        return reply.status(403).send({ error: "Insufficient scope", required: scopeToString(scope) });
      }
      const loaded = await loadCohortForSite(siteId, cohortId);
      if (!loaded) return reply.status(404).send({ error: "Cohort not found" });
      const actor = await resolveCohortActor(request, siteId, loaded.organizationId);
      if (!canReadCohort(loaded.cohort, actor)) return reply.status(404).send({ error: "Cohort not found" });
      cohort = loaded.cohort;
    }
    const data = await new HeatmapQueryService().getHeatmaps(
      siteId,
      {
        ...request.query,
        ...selection,
        pageLimit,
        pointLimit,
        analyticsEventType,
        excludeBounce,
        segmentFilters: request.heatmapSegmentFilters ?? [],
        cohort,
      },
      config.domain
    );
    return reply.send({ data });
  } catch (error) {
    if (error instanceof HeatmapQueryValidationError) return reply.status(400).send({ error: error.message });
    request.log.error({ err: error }, "Failed to fetch heatmaps");
    return reply.status(500).send({ error: "Failed to fetch heatmaps" });
  }
}
