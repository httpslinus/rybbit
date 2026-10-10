import { createHash, randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { redis } from "../../db/redis/redis.js";

// The processing lease exceeds ClickHouse's 300-second request timeout. A
// completed marker covers the raw rows' 30-day retention window.
export const HEATMAP_PROCESSING_TTL_MS = 10 * 60_000;
export const HEATMAP_COMPLETION_TTL_MS = 30 * 24 * 60 * 60_000;
// Covers the recorder's 15-minute retry budget, a five-minute insert timeout,
// and a processing lease, without retaining identity after successful uploads.
export const HEATMAP_ATTRIBUTION_TTL_MS = 30 * 60_000;

export const HEATMAP_CLAIM_LUA = `
  local state = redis.call('GET', KEYS[1])
  if state == 'done' then return 2 end
  if state then return 0 end
  redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
  return 1
`;

export const HEATMAP_COMPLETE_LUA = `
  if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
  redis.call('SET', KEYS[1], 'done', 'PX', ARGV[2])
  redis.call('DEL', KEYS[2])
  redis.call('ZREM', KEYS[3], KEYS[2])
  if redis.call('ZCARD', KEYS[3]) == 0 then redis.call('DEL', KEYS[3]) end
  return 1
`;

export const HEATMAP_RELEASE_LUA = `
  if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
  redis.call('DEL', KEYS[2])
  redis.call('ZREM', KEYS[3], KEYS[2])
  if redis.call('ZCARD', KEYS[3]) == 0 then redis.call('DEL', KEYS[3]) end
  return redis.call('DEL', KEYS[1])
`;

export const HEATMAP_READ_ATTRIBUTION_LUA = `
  if redis.call('GET', KEYS[1]) ~= ARGV[1] then return false end
  return redis.call('GET', KEYS[2])
`;

export const HEATMAP_SAVE_ATTRIBUTION_LUA = `
  if redis.call('GET', KEYS[1]) ~= ARGV[1] then return false end
  local attribution = redis.call('GET', KEYS[2])
  if attribution then return attribution end
  redis.call('SET', KEYS[2], ARGV[2], 'PX', ARGV[3])
  redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', ARGV[4])
  redis.call('ZADD', KEYS[3], tonumber(ARGV[4]) + tonumber(ARGV[3]), KEYS[2])
  redis.call('PEXPIRE', KEYS[3], ARGV[3])
  return ARGV[2]
`;

export const HEATMAP_ERASE_ATTRIBUTION_LUA = `
  if redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end
  redis.call('SET', KEYS[1], 'done', 'PX', ARGV[2])
  redis.call('DEL', KEYS[2])
  redis.call('ZREM', KEYS[3], KEYS[2])
  if redis.call('ZCARD', KEYS[3]) == 0 then redis.call('DEL', KEYS[3]) end
  return 1
`;

export const HEATMAP_ATTRIBUTION_PAGE_LUA = `
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[2])
  if redis.call('ZCARD', KEYS[1]) == 0 then redis.call('DEL', KEYS[1]) end
  return redis.call('ZSCAN', KEYS[1], ARGV[1], 'COUNT', 500)
`;

const attributionIndex = (siteId: number | string) => `heatmap-attributions:${siteId}`;
const claimAttributionIndex = (claim: HeatmapBatchClaim) => attributionIndex(claim.key.split(":")[1]);

export type HeatmapBatchAttribution = {
  sessionId: string;
  userId: string;
  identifiedUserId: string;
  receivedAtMs: number;
};

export type HeatmapBatchClaim = { key: string; token: string };
export type HeatmapClaimResult =
  | { status: "acquired"; claim: HeatmapBatchClaim }
  | { status: "busy" }
  | { status: "completed" };

export class HeatmapBatchClaims {
  constructor(private client: Pick<Redis, "eval" | "mget"> = redis) {}

  async claim(siteId: number, batchId: string): Promise<HeatmapClaimResult> {
    const key = `heatmap-batch:${siteId}:${createHash("sha256").update(batchId).digest("hex")}`;
    const token = randomUUID();
    const result = Number(await this.client.eval(HEATMAP_CLAIM_LUA, 1, key, token, HEATMAP_PROCESSING_TTL_MS));
    if (result === 1) return { status: "acquired", claim: { key, token } };
    if (result === 2) return { status: "completed" };
    return { status: "busy" };
  }

  async complete(claim: HeatmapBatchClaim): Promise<boolean> {
    return (
      Number(
        await this.client.eval(
          HEATMAP_COMPLETE_LUA,
          3,
          claim.key,
          `${claim.key}:attribution`,
          claimAttributionIndex(claim),
          claim.token,
          HEATMAP_COMPLETION_TTL_MS
        )
      ) === 1
    );
  }

  async getAttribution(claim: HeatmapBatchClaim): Promise<HeatmapBatchAttribution | null> {
    const value = await this.client.eval(
      HEATMAP_READ_ATTRIBUTION_LUA,
      2,
      claim.key,
      `${claim.key}:attribution`,
      claim.token
    );
    return typeof value === "string" ? JSON.parse(value) : null;
  }

  async saveAttribution(
    claim: HeatmapBatchClaim,
    attribution: HeatmapBatchAttribution
  ): Promise<HeatmapBatchAttribution> {
    // Keep capture attribution after a processing lease expires: an ambiguous
    // insert retry must not move a batch into a different analytics session.
    const value = await this.client.eval(
      HEATMAP_SAVE_ATTRIBUTION_LUA,
      3,
      claim.key,
      `${claim.key}:attribution`,
      claimAttributionIndex(claim),
      claim.token,
      JSON.stringify(attribution),
      HEATMAP_ATTRIBUTION_TTL_MS,
      Date.now()
    );
    if (typeof value !== "string") throw new Error("Heatmap batch processing lease expired before attribution");
    return JSON.parse(value);
  }

  async release(claim: HeatmapBatchClaim): Promise<boolean> {
    return (
      Number(
        await this.client.eval(
          HEATMAP_RELEASE_LUA,
          3,
          claim.key,
          `${claim.key}:attribution`,
          claimAttributionIndex(claim),
          claim.token
        )
      ) === 1
    );
  }

  async clearAttributions(siteId: number, userId?: string, deviceIds: readonly string[] = []): Promise<void> {
    let cursor = "0";
    do {
      // Scan only active contexts for this site. Global SCAN would traverse all
      // 30-day completion markers even when the site's active index is empty.
      const [nextCursor, indexed] = (await this.client.eval(
        HEATMAP_ATTRIBUTION_PAGE_LUA,
        1,
        attributionIndex(siteId),
        cursor,
        Date.now()
      )) as [string, string[]];
      cursor = nextCursor;
      const keys = indexed.filter((_, index) => index % 2 === 0);
      if (!keys.length) continue;
      const values = await this.client.mget(...keys);
      for (const [index, value] of values.entries()) {
        if (value === null) continue;
        const attributionKey = keys[index];
        const attribution: HeatmapBatchAttribution = JSON.parse(value);
        if (
          userId !== undefined &&
          attribution.identifiedUserId !== userId &&
          !(attribution.identifiedUserId === "" && deviceIds.includes(attribution.userId))
        )
          continue;
        // Tombstone erased batches too: a later retry must not recreate the
        // deleted person's events after their canonical attribution is removed.
        await this.client.eval(
          HEATMAP_ERASE_ATTRIBUTION_LUA,
          3,
          attributionKey.slice(0, -":attribution".length),
          attributionKey,
          attributionIndex(siteId),
          value,
          HEATMAP_COMPLETION_TTL_MS
        );
      }
    } while (cursor !== "0");
  }
}

export const heatmapBatchClaims = new HeatmapBatchClaims();
