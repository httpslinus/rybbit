import { heatmapWidthBucket, type HeatmapBatch } from "@rybbit/shared";
import type { IncomingHttpHeaders } from "node:http";
import { clickhouse } from "../../db/clickhouse/clickhouse.js";
import { toClickHouseDateTime } from "../../db/clickhouse/dateTime.js";
import type { AsnLookup } from "../../db/geolocation/asn.js";
import { createServiceLogger } from "../../lib/logger/logger.js";
import type { SiteConfigData } from "../../lib/siteConfig.js";
import { correctReplayClockSkew } from "../replay/replayClockSkew.js";
import { sessionsService } from "../sessions/sessionsService.js";
import { decideSiteExclusion } from "../sites/siteExclusionDecision.js";
import { userIdService } from "../userId/userIdService.js";
import { HeatmapBatchClaims, heatmapBatchClaims } from "./heatmapBatchClaims.js";
import { isHeatmapBot } from "./heatmapBotExclusion.js";

const logger = createServiceLogger("heatmap-ingest");

export interface HeatmapRequestMetadata {
  headers: IncomingHttpHeaders;
  userAgent: string;
  ipAddress: string;
  candidateIps: string[];
  lookupAsn: AsnLookup;
  receivedAt: Date;
}

export type HeatmapIngestOutcome = { status: "recorded" | "duplicate" | "excluded" | "bot" | "busy" };

export class HeatmapIngestService {
  constructor(private claims: HeatmapBatchClaims = heatmapBatchClaims) {}

  async recordEvents(
    site: SiteConfigData,
    batch: HeatmapBatch,
    metadata: HeatmapRequestMetadata
  ): Promise<HeatmapIngestOutcome> {
    // Retain the original index when filtering a mixed SPA batch. Re-indexing
    // accepted events would make retries collide with another captured event.
    const accepted = [];
    const exclusions = new Map<string, boolean>();
    for (const [eventIndex, event] of batch.events.entries()) {
      const key = `${event.hostname}\0${event.pathname}`;
      let excluded = exclusions.get(key);
      if (excluded === undefined) {
        const decision = await decideSiteExclusion(site, {
          ipAddress: metadata.ipAddress,
          candidateIps: metadata.candidateIps,
          hostname: event.hostname,
          pathname: event.pathname,
          userAgent: metadata.userAgent,
          lookupAsn: metadata.lookupAsn,
        });
        excluded = decision.excluded;
        exclusions.set(key, excluded);
      }
      if (!excluded) accepted.push({ ...event, eventIndex });
    }
    if (!accepted.length) return { status: "excluded" };
    if (isHeatmapBot({ ...metadata, blockBots: site.blockBots })) return { status: "bot" };

    // Redis outages fail closed: an in-process fallback cannot coordinate
    // duplicate requests across workers. Only a completed claim is acknowledged.
    const claimed = await this.claims.claim(site.siteId, batch.batchId);
    if (claimed.status === "completed") return { status: "duplicate" };
    if (claimed.status === "busy") return { status: "busy" };

    let insertStarted = false;
    try {
      let attribution = await this.claims.getAttribution(claimed.claim);
      if (!attribution) {
        const identityOptions = {
          saltUserIds: site.saltUserIds,
          receivedAt: metadata.receivedAt,
          lookupAsn: metadata.lookupAsn,
        };
        const userId = batch.anonymousId
          ? await userIdService.generateUserIdFromClientId(batch.anonymousId, site.siteId, identityOptions)
          : await userIdService.generateUserId(metadata.ipAddress, metadata.userAgent, site.siteId, identityOptions);
        const clientUserId = batch.userId?.trim() || "";
        const identifiedUserId = clientUserId && clientUserId !== userId ? clientUserId : "";
        const { sessionId } = await sessionsService.updateSession({ userId, identifiedUserId, siteId: site.siteId });
        attribution = await this.claims.saveAttribution(claimed.claim, {
          sessionId,
          userId,
          identifiedUserId,
          receivedAtMs: metadata.receivedAt.getTime(),
        });
      }
      const { sessionId, userId, identifiedUserId, receivedAtMs } = attribution;
      const correction = correctReplayClockSkew(batch.events, receivedAtMs);
      const { skewMs } = correction;
      const events = accepted.map(event => ({ ...event, timestamp: correction.events[event.eventIndex].timestamp }));
      if (skewMs !== 0)
        logger.warn({ siteId: site.siteId, skewMs, eventCount: events.length }, "Corrected heatmap clock skew");
      const rows = events.map(event => ({
        site_id: site.siteId,
        session_id: sessionId,
        user_id: userId,
        identified_user_id: identifiedUserId,
        timestamp: toClickHouseDateTime(event.timestamp),
        page_visit_id: event.pageVisitId,
        batch_id: batch.batchId,
        event_index: event.eventIndex,
        type: event.type,
        hostname: event.hostname,
        pathname: event.pathname,
        viewport_bucket: heatmapWidthBucket(event.viewportWidth),
        viewport_width: event.viewportWidth,
        viewport_height: event.viewportHeight,
        document_width: event.documentWidth,
        document_height: event.documentHeight,
        client_x: event.type === "click" ? event.clientX : null,
        client_y: event.type === "click" ? event.clientY : null,
        page_x: event.type === "click" ? event.pageX : null,
        page_y: event.type === "click" ? event.pageY : null,
        max_depth: event.type === "scroll" ? event.maxDepth : null,
      }));
      insertStarted = true;
      await clickhouse.insert({
        table: "heatmap_events",
        values: rows,
        format: "JSONEachRow",
        clickhouse_settings: { async_insert: 1, wait_for_async_insert: 1 },
      });
      if (!(await this.claims.complete(claimed.claim)))
        throw new Error("Heatmap batch processing lease expired before completion");
      return { status: "recorded" };
    } catch (error) {
      // A rejected/timed-out insert can still have committed. Keep its claim,
      // just as after a crash between insert and completion. Once the lease
      // expires a retry may write a second physical row; every report dedups
      // persisted (site_id, batch_id, event_index) before counting it.
      if (!insertStarted) {
        try {
          await this.claims.release(claimed.claim);
        } catch (releaseError) {
          logger.error({ err: releaseError, siteId: site.siteId }, "Could not release heatmap pre-insert claim");
        }
      }
      throw error;
    }
  }
}

export const heatmapIngestService = new HeatmapIngestService();
