import type { Filter } from "@rybbit/shared";
import { FastifyReply, FastifyRequest } from "fastify";
import { hasScope, scopeToString } from "../../../lib/scopes.js";
import { validateFilters } from "../utils/query-validation.js";
import { canReadSegment, loadSegmentForSite, resolveSegmentActor } from "./segmentAccess.js";

const SEGMENTS_READ = { resource: "segments", action: "read" } as const;

const filterKey = (filter: Filter) => JSON.stringify([filter.parameter, filter.type, filter.value]);

declare module "fastify" {
  interface FastifyRequest {
    /** Authorized stored predicates; never taken from request query parameters. */
    heatmapSegmentFilters?: Filter[];
  }
}

/**
 * Segment filters first, then any ad-hoc filters that are not already part of
 * the segment. Order matters only for readability of the expanded URL; every
 * filter is ANDed by getFilterStatement.
 */
export function mergeSegmentFilters(segmentFilters: Filter[], extra: Filter[]): Filter[] {
  const seen = new Set(segmentFilters.map(filterKey));
  return [...segmentFilters, ...extra.filter(filter => !seen.has(filterKey(filter)))];
}

/**
 * Expands `segment_id` into the `filters` query param before an analytics
 * handler runs, so every endpoint that already reads `filters` accepts a
 * segment with no per-endpoint change. Runs after the site access guard: a
 * caller without site access only expands public segments.
 */
export async function expandSegmentParam(request: FastifyRequest, reply: FastifyReply) {
  return expandSegment(request, reply, false);
}

/** Heatmaps keep the saved segment required when ad-hoc filters use match:any. */
export async function expandHeatmapSegmentParam(request: FastifyRequest, reply: FastifyReply) {
  request.heatmapSegmentFilters = [];
  return expandSegment(request, reply, true);
}

async function expandSegment(request: FastifyRequest, reply: FastifyReply, requiredGroup: boolean) {
  const query = request.query as Record<string, unknown> | undefined;
  const raw = query?.segment_id;
  if (raw === undefined || raw === null || raw === "") {
    return;
  }

  const segmentId = Number(raw);
  if (!Number.isInteger(segmentId) || segmentId <= 0) {
    return reply.status(400).send({ error: "Invalid segment_id" });
  }

  const params = request.params as { siteId?: string } | undefined;
  const siteId = Number(params?.siteId);
  if (!Number.isInteger(siteId) || siteId <= 0) {
    return reply.status(400).send({ error: "Site ID required" });
  }

  // The route guard only checked the endpoint's own scope. A scoped bearer
  // credential must also hold segments:read, or it could infer a private
  // segment's definition through this param that it cannot fetch directly.
  if (request.bearerAuth && !hasScope(request.bearerStatements ?? null, SEGMENTS_READ)) {
    return reply.status(403).send({ error: "Insufficient scope", required: scopeToString(SEGMENTS_READ) });
  }

  const loaded = await loadSegmentForSite(siteId, segmentId);
  if (!loaded) {
    return reply.status(404).send({ error: "Segment not found" });
  }

  const actor = await resolveSegmentActor(request, siteId, loaded.organizationId);
  if (!canReadSegment(loaded.segment, actor)) {
    return reply.status(404).send({ error: "Segment not found" });
  }

  let existing: Filter[] = [];
  const rawFilters = query!.filters;
  if (typeof rawFilters === "string" && rawFilters.length > 0) {
    try {
      existing = validateFilters(rawFilters);
    } catch {
      return reply.status(400).send({ error: "Invalid filters" });
    }
  }

  if (requiredGroup) {
    const storedKeys = new Set(loaded.segment.filters.map(filterKey));
    request.heatmapSegmentFilters = loaded.segment.filters;
    // The shared filter bar includes copies of selected segment predicates.
    // Remove only those exact copies from the ad-hoc any/all group.
    query!.filters = JSON.stringify(existing.filter(filter => !storedKeys.has(filterKey(filter))));
  } else {
    query!.filters = JSON.stringify(mergeSegmentFilters(loaded.segment.filters, existing));
  }
}
