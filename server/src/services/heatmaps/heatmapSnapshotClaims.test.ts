import RedisMock from "ioredis-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../db/redis/redis.js", () => ({ redis: {} }));
import {
  HeatmapSnapshotClaims,
  HEATMAP_SNAPSHOT_GRACE_MS,
  HEATMAP_SNAPSHOT_LEASE_MS,
} from "./heatmapSnapshotClaims.js";
const context = {
  hostname: "example.com",
  pathname: "/product",
  viewportWidth: 375,
  viewportHeight: 800,
  documentWidth: 375,
  documentHeight: 3000,
};
const attribution = { sessionId: "session", userId: "device", identifiedUserId: "alice" };

describe("sampled heatmap snapshot claims", () => {
  let redis: ReturnType<typeof createRedis>;
  function createRedis() {
    return new RedisMock();
  }
  let claims: HeatmapSnapshotClaims;
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-11T12:00:00Z"));
    redis = new RedisMock();
    await redis.flushall();
    claims = new HeatmapSnapshotClaims(redis);
  });
  afterEach(() => {
    vi.useRealTimers();
    redis.disconnect();
  });
  async function nominate() {
    return claims.nominate(42, context, 375, "visit", attribution);
  }
  async function nominated() {
    expect(await nominate()).toBeUndefined();
    vi.advanceTimersByTime(HEATMAP_SNAPSHOT_GRACE_MS);
    const request = await nominate();
    expect(request).toBeDefined();
    return request!;
  }
  it("waits for replay coverage and nominates only one visitor concurrently", async () => {
    expect(await nominate()).toBeUndefined();
    vi.advanceTimersByTime(HEATMAP_SNAPSHOT_GRACE_MS);
    const requests = await Promise.all(Array.from({ length: 8 }, nominate));
    expect(requests.filter(Boolean)).toHaveLength(1);
    expect(await nominate()).toBeUndefined();
  });
  it("does not capture a standalone DOM when a replay already covers the day", async () => {
    await claims.markReplay(42, context, 375, Date.now());
    expect(await nominate()).toBeUndefined();
    vi.advanceTimersByTime(HEATMAP_SNAPSHOT_GRACE_MS);
    expect(await nominate()).toBeUndefined();
  });
  it("revokes a nomination when replay coverage arrives before its upload", async () => {
    const request = await nominated();
    const claim = await claims.get(42, request);
    await claims.markReplay(42, context, 375, Date.now());
    expect(await claims.get(42, request)).toBeNull();
    expect(await claims.beginUpload(request, claim!.value)).toBe(false);
    expect(await nominate()).toBeUndefined();
    expect(await redis.zrange("heatmap-snapshot-leases:42", 0, -1)).toEqual([]);
  });
  it("revokes an in-flight fallback so its stored copy can be removed", async () => {
    const request = await nominated();
    const claim = await claims.get(42, request);
    expect(await claims.beginUpload(request, claim!.value)).toBe(true);
    await claims.markReplay(42, context, 375, Date.now());
    expect(await claims.consume(42, request, `uploading:${claim!.value}`)).toBe(false);
    expect(await nominate()).toBeUndefined();
    expect(await redis.get(`${request.key}:lease`)).toBeNull();
  });
  it("binds tokens to their site, page, width, and page visit", async () => {
    const request = await nominated();
    expect(await claims.get(43, request)).toBeNull();
    expect(await claims.get(42, { ...request, pathname: "/other" })).toBeNull();
    expect(await claims.get(42, { ...request, pageVisitId: "other" })).toBeNull();
    expect(await claims.get(42, { ...request, bucket: 768 })).toBeNull();
    expect(await claims.get(42, { ...request, token: "forged" })).toBeNull();
    expect(await claims.get(42, request)).not.toBeNull();
  });
  it("consumes successful uploads once and keeps the daily completion marker", async () => {
    const request = await nominated();
    const claim = await claims.get(42, request);
    expect(await claims.beginUpload(request, claim!.value)).toBe(true);
    expect(await claims.beginUpload(request, claim!.value)).toBe(false);
    expect(await claims.get(42, request)).toBeNull();
    expect(await claims.consume(42, request, `uploading:${claim!.value}`)).toBe(true);
    expect(await claims.consume(42, request, `uploading:${claim!.value}`)).toBe(false);
    expect(await nominate()).toBeUndefined();
  });
  it("expires abandoned leases so a new visitor can provide missing coverage", async () => {
    const first = await nominated();
    vi.advanceTimersByTime(HEATMAP_SNAPSHOT_LEASE_MS + 1);
    expect(await claims.get(42, first)).toBeNull();
    const next = await nominate();
    expect(next).toBeDefined();
    expect(next!.token).not.toBe(first.token);
  });
  it("keeps extended in-flight uploads in the erasure index after their original expiry", async () => {
    const request = await nominated();
    const claim = await claims.get(42, request);
    vi.advanceTimersByTime(HEATMAP_SNAPSHOT_LEASE_MS - 1);
    expect(await claims.beginUpload(request, claim!.value)).toBe(true);
    vi.advanceTimersByTime(2);
    await claims.clear(42, "alice", []);
    expect(await redis.get(`${request.key}:lease`)).toBeNull();
    expect(await claims.consume(42, request, `uploading:${claim!.value}`)).toBe(false);
  });
  it("erases the correct identified person and tombstones outstanding capture tokens", async () => {
    const request = await nominated();
    await claims.clear(42, "bob", ["device"]);
    expect(await claims.get(42, request)).not.toBeNull();
    await claims.clear(42, "alice", []);
    expect(await claims.get(42, request)).toBeNull();
    expect(await nominate()).toBeUndefined();
  });
});
