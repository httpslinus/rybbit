import { createHash, randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import type { HeatmapSnapshotContext, HeatmapSnapshotRequest, HeatmapWidthBucket } from "@rybbit/shared";
import { redis } from "../../db/redis/redis.js";

export const HEATMAP_SNAPSHOT_GRACE_MS = 90_000;
export const HEATMAP_SNAPSHOT_LEASE_MS = 10 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
export const SNAPSHOT_RESERVE_LUA = `
  local marker = redis.call('GET', KEYS[1])
  if marker == 'done' then return 0 end
  if not marker then
    redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[3])
    return 0
  end
  if tonumber(ARGV[1]) - tonumber(marker) < tonumber(ARGV[2]) then return 0 end
  if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
  redis.call('SET', KEYS[2], ARGV[4], 'PX', ARGV[5])
  redis.call('ZADD', KEYS[3], tonumber(ARGV[1]) + tonumber(ARGV[5]), KEYS[2])
  redis.call('PEXPIRE', KEYS[3], ARGV[5])
  return 1
`;
export const SNAPSHOT_CONSUME_LUA = `
  if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
  redis.call('DEL', KEYS[1])
  redis.call('ZREM', KEYS[3], KEYS[1])
  redis.call('SET', KEYS[2], 'done', 'PX', ARGV[2])
  return 1
`;
export const SNAPSHOT_BEGIN_UPLOAD_LUA = `
  if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
  redis.call('SET', KEYS[1], 'uploading:' .. ARGV[1], 'PX', ARGV[2])
  redis.call('ZADD', KEYS[2], tonumber(ARGV[3]) + tonumber(ARGV[2]), KEYS[1])
  redis.call('PEXPIRE', KEYS[2], ARGV[2])
  return 1
`;
const indexKey = (siteId: number) => `heatmap-snapshot-leases:${siteId}`;
export function heatmapSnapshotKey(
  siteId: number,
  context: Pick<HeatmapSnapshotContext, "hostname" | "pathname">,
  bucket: HeatmapWidthBucket,
  now: number
) {
  return `heatmap-snapshot:${siteId}:${createHash("sha256")
    .update(JSON.stringify([context.hostname, context.pathname, bucket, new Date(now).toISOString().slice(0, 10)]))
    .digest("hex")}`;
}
export type SnapshotLease = {
  request: HeatmapSnapshotRequest;
  context: HeatmapSnapshotContext;
  sessionId: string;
  userId: string;
  identifiedUserId: string;
};

export class HeatmapSnapshotClaims {
  constructor(
    private client: Pick<Redis, "eval" | "get" | "set" | "del" | "zrangebyscore" | "mget" | "zrem"> = redis
  ) {}
  async nominate(
    siteId: number,
    context: HeatmapSnapshotContext,
    bucket: HeatmapWidthBucket,
    pageVisitId: string,
    attribution: Pick<SnapshotLease, "sessionId" | "userId" | "identifiedUserId">,
    now = Date.now()
  ): Promise<HeatmapSnapshotRequest | undefined> {
    const key = heatmapSnapshotKey(siteId, context, bucket, now);
    const request = {
      key,
      token: randomUUID(),
      pageVisitId,
      hostname: context.hostname,
      pathname: context.pathname,
      bucket,
    };
    const lease: SnapshotLease = { request, context, ...attribution };
    const result = await this.client.eval(
      SNAPSHOT_RESERVE_LUA,
      3,
      key,
      `${key}:lease`,
      indexKey(siteId),
      now,
      HEATMAP_SNAPSHOT_GRACE_MS,
      2 * DAY_MS,
      JSON.stringify(lease),
      HEATMAP_SNAPSHOT_LEASE_MS
    );
    return Number(result) === 1 ? request : undefined;
  }
  async get(siteId: number, request: HeatmapSnapshotRequest): Promise<{ lease: SnapshotLease; value: string } | null> {
    if (
      !request.key.startsWith(`heatmap-snapshot:${siteId}:`) ||
      !/^heatmap-snapshot:\d+:[a-f0-9]{64}$/.test(request.key)
    )
      return null;
    const value = await this.client.get(`${request.key}:lease`);
    if (!value || value.startsWith("uploading:")) return null;
    const lease: SnapshotLease = JSON.parse(value);
    if (JSON.stringify(lease.request) !== JSON.stringify(request)) return null;
    return { lease, value };
  }
  async consume(siteId: number, request: HeatmapSnapshotRequest, value: string): Promise<boolean> {
    return (
      Number(
        await this.client.eval(
          SNAPSHOT_CONSUME_LUA,
          3,
          `${request.key}:lease`,
          request.key,
          indexKey(siteId),
          value,
          2 * DAY_MS
        )
      ) === 1
    );
  }
  async beginUpload(request: HeatmapSnapshotRequest, value: string): Promise<boolean> {
    return (
      Number(
        await this.client.eval(
          SNAPSHOT_BEGIN_UPLOAD_LUA,
          2,
          `${request.key}:lease`,
          indexKey(Number(request.key.split(":")[1])),
          value,
          HEATMAP_SNAPSHOT_LEASE_MS,
          Date.now()
        )
      ) === 1
    );
  }
  async markReplay(
    siteId: number,
    context: HeatmapSnapshotContext,
    bucket: HeatmapWidthBucket,
    timestamp: number
  ): Promise<void> {
    await this.client.set(heatmapSnapshotKey(siteId, context, bucket, timestamp), "done", "PX", 2 * DAY_MS);
  }
  async clear(siteId: number, userId?: string, deviceIds: readonly string[] = []): Promise<void> {
    const keys = await this.client.zrangebyscore(indexKey(siteId), Date.now(), "+inf");
    if (!keys.length) return;
    const values = await this.client.mget(...keys);
    for (const [i, value] of values.entries()) {
      if (!value) continue;
      const lease: SnapshotLease = JSON.parse(
        value.startsWith("uploading:") ? value.slice("uploading:".length) : value
      );
      if (
        userId !== undefined &&
        lease.identifiedUserId !== userId &&
        !(lease.identifiedUserId === "" && deviceIds.includes(lease.userId))
      )
        continue;
      await this.consume(siteId, lease.request, value);
      await this.client.del(lease.request.key, `${lease.request.key}:replay`);
    }
  }
}
export const heatmapSnapshotClaims = new HeatmapSnapshotClaims();
