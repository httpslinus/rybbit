import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../db/redis/redis.js", async () => {
  const { default: RedisMock } = await import("ioredis-mock");
  return { redis: new RedisMock() };
});

import {
  HeatmapBatchClaims,
  HEATMAP_ATTRIBUTION_TTL_MS,
  HEATMAP_COMPLETION_TTL_MS,
  HEATMAP_PROCESSING_TTL_MS,
  HEATMAP_ERASE_ATTRIBUTION_LUA,
} from "./heatmapBatchClaims.js";

describe("atomic heatmap batch claims", () => {
  let client: Redis;
  let claims: HeatmapBatchClaims;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-10T12:00:00Z"));
    client = new RedisMock() as unknown as Redis;
    await client.flushall();
    claims = new HeatmapBatchClaims(client);
  });

  afterEach(() => {
    client.disconnect();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("allows exactly one of concurrent claims and keeps in-progress requests distinct from completion", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => claims.claim(42, "same-batch")));
    expect(results.filter(result => result.status === "acquired")).toHaveLength(1);
    expect(results.filter(result => result.status === "busy")).toHaveLength(7);
    const owner = results.find(result => result.status === "acquired")!;
    if (owner.status !== "acquired") throw new Error("No owner");
    expect(await client.pttl(owner.claim.key)).toBe(HEATMAP_PROCESSING_TTL_MS);
    expect(await claims.complete(owner.claim)).toBe(true);
    expect(await claims.claim(42, "same-batch")).toEqual({ status: "completed" });
    expect(await client.pttl(owner.claim.key)).toBe(HEATMAP_COMPLETION_TTL_MS);
  });

  it("isolates the same batch ID by resolved site and avoids putting raw IDs in keys", async () => {
    const first = await claims.claim(42, "same-batch");
    const second = await claims.claim(43, "same-batch");
    expect(first.status).toBe("acquired");
    expect(second.status).toBe("acquired");
    const keys = await client.keys("*");
    expect(keys).toHaveLength(2);
    expect(keys.every(key => !key.includes("same-batch"))).toBe(true);
  });

  it("releases only the owner on a confirmed pre-insert failure", async () => {
    const owner = await claims.claim(42, "batch");
    if (owner.status !== "acquired") throw new Error("No owner");
    expect(await claims.release({ ...owner.claim, token: "other-worker" })).toBe(false);
    expect(await claims.claim(42, "batch")).toEqual({ status: "busy" });
    expect(await claims.release(owner.claim)).toBe(true);
    expect((await claims.claim(42, "batch")).status).toBe("acquired");
  });

  it("does not let an expired owner complete or clear a new worker's lease", async () => {
    const expired = await claims.claim(42, "batch");
    if (expired.status !== "acquired") throw new Error("No owner");
    vi.advanceTimersByTime(HEATMAP_PROCESSING_TTL_MS + 1);
    const current = await claims.claim(42, "batch");
    if (current.status !== "acquired") throw new Error("No new owner");
    expect(await claims.complete(expired.claim)).toBe(false);
    expect(await claims.release(expired.claim)).toBe(false);
    expect(await client.get(current.claim.key)).toBe(current.claim.token);
    expect(await claims.complete(current.claim)).toBe(true);
    expect(await claims.release(current.claim)).toBe(false);
  });

  it("expires completed markers after retained-row deduplication's initial 30-day budget", async () => {
    const owner = await claims.claim(42, "batch");
    if (owner.status !== "acquired") throw new Error("No owner");
    await claims.complete(owner.claim);
    vi.advanceTimersByTime(HEATMAP_COMPLETION_TTL_MS + 1);
    expect((await claims.claim(42, "batch")).status).toBe("acquired");
  });

  it("fails closed when Redis cannot coordinate workers", async () => {
    vi.spyOn(client, "eval").mockRejectedValue(new Error("Redis unavailable"));
    await expect(claims.claim(42, "batch")).rejects.toThrow("Redis unavailable");
  });

  it("retains one canonical attribution through lease expiry and deletes it on completion", async () => {
    const first = await claims.claim(42, "batch");
    if (first.status !== "acquired") throw new Error("No owner");
    const attribution = {
      sessionId: "original",
      userId: "device",
      identifiedUserId: "alice",
      receivedAtMs: Date.now(),
    };
    expect(await claims.saveAttribution(first.claim, attribution)).toEqual(attribution);
    expect(await client.pttl(`${first.claim.key}:attribution`)).toBe(HEATMAP_ATTRIBUTION_TTL_MS);
    expect(await client.zrange("heatmap-attributions:42", 0, -1)).toEqual([`${first.claim.key}:attribution`]);
    vi.advanceTimersByTime(HEATMAP_PROCESSING_TTL_MS + 1);
    const retry = await claims.claim(42, "batch");
    if (retry.status !== "acquired") throw new Error("No retry owner");
    expect(await claims.getAttribution(retry.claim)).toEqual(attribution);
    expect(await claims.saveAttribution(retry.claim, { ...attribution, sessionId: "new" })).toEqual(attribution);
    await expect(claims.saveAttribution(first.claim, attribution)).rejects.toThrow("lease expired");
    expect(await claims.complete(first.claim)).toBe(false);
    expect(await claims.release(first.claim)).toBe(false);
    expect(await client.zcard("heatmap-attributions:42")).toBe(1);
    expect(await claims.getAttribution(retry.claim)).toEqual(attribution);
    expect(await claims.complete(retry.claim)).toBe(true);
    expect(await client.get(`${retry.claim.key}:attribution`)).toBeNull();
    expect(await client.exists("heatmap-attributions:42")).toBe(0);
  });

  it("clears a confirmed pre-insert attribution together with its owner's released lease", async () => {
    const owner = await claims.claim(42, "batch");
    if (owner.status !== "acquired") throw new Error("No owner");
    await claims.saveAttribution(owner.claim, {
      sessionId: "s",
      userId: "d",
      identifiedUserId: "",
      receivedAtMs: Date.now(),
    });
    await claims.release(owner.claim);
    expect(await client.keys("*")).toEqual([]);
  });

  it("erases matching identity context and tombstones retries while preserving shared-device and foreign-site people", async () => {
    const entries = [
      [42, "alice", "device", "alice"],
      [42, "anonymous", "device", ""],
      [42, "bob", "device", "bob"],
      [43, "foreign", "device", "alice"],
    ] as const;
    for (const [siteId, batchId, userId, identifiedUserId] of entries) {
      const owner = await claims.claim(siteId, batchId);
      if (owner.status !== "acquired") throw new Error("No owner");
      await claims.saveAttribution(owner.claim, {
        sessionId: batchId,
        userId,
        identifiedUserId,
        receivedAtMs: Date.now(),
      });
    }
    await claims.clearAttributions(42, "alice", ["alice", "device"]);
    const keys = await client.keys("*:attribution");
    expect(keys).toHaveLength(2);
    expect(await claims.claim(42, "alice")).toEqual({ status: "completed" });
    expect(await claims.claim(42, "anonymous")).toEqual({ status: "completed" });
    await claims.clearAttributions(42);
    expect(await client.keys("heatmap-batch:42:*:attribution")).toEqual([]);
    expect(await client.keys("heatmap-batch:43:*:attribution")).toHaveLength(1);
    expect(await client.exists("heatmap-attributions:42")).toBe(0);
    expect(await client.zcard("heatmap-attributions:43")).toBe(1);
  });

  it("clears an empty site in one indexed operation without traversing other sites' completion markers", async () => {
    for (let index = 0; index < 200; index++) {
      await client.set(`heatmap-batch:99:completed-${index}`, "done", "PX", HEATMAP_COMPLETION_TTL_MS);
    }
    const globalScan = vi.spyOn(client, "scan");
    const evalCalls = vi.spyOn(client, "eval");
    await claims.clearAttributions(42);
    expect(globalScan).not.toHaveBeenCalled();
    expect(evalCalls).toHaveBeenCalledTimes(1);
    expect(evalCalls.mock.calls[0].slice(1, 3)).toEqual([1, "heatmap-attributions:42"]);
    expect(await client.keys("heatmap-batch:99:*")).toHaveLength(200);
  });

  it("prunes expired contexts while newer active contexts keep the site's index alive", async () => {
    const old = await claims.claim(42, "old");
    if (old.status !== "acquired") throw new Error("No owner");
    await claims.saveAttribution(old.claim, {
      sessionId: "old",
      userId: "device",
      identifiedUserId: "alice",
      receivedAtMs: Date.now(),
    });
    vi.advanceTimersByTime(HEATMAP_ATTRIBUTION_TTL_MS - 1);
    const newer = await claims.claim(42, "newer");
    if (newer.status !== "acquired") throw new Error("No owner");
    await claims.saveAttribution(newer.claim, {
      sessionId: "newer",
      userId: "device",
      identifiedUserId: "bob",
      receivedAtMs: Date.now(),
    });
    vi.advanceTimersByTime(2);
    expect(await client.get(`${old.claim.key}:attribution`)).toBeNull();
    expect(await client.zcard("heatmap-attributions:42")).toBe(2);
    await claims.clearAttributions(42, "alice", ["device"]);
    expect(await client.zrange("heatmap-attributions:42", 0, -1)).toEqual([`${newer.claim.key}:attribution`]);
    expect(await claims.getAttribution(newer.claim)).toMatchObject({ identifiedUserId: "bob" });
    vi.advanceTimersByTime(HEATMAP_ATTRIBUTION_TTL_MS);
    expect(await client.exists("heatmap-attributions:42")).toBe(0);
  });

  it("does not erase a replaced context or remove its index entry using stale erasure data", async () => {
    const owner = await claims.claim(42, "batch");
    if (owner.status !== "acquired") throw new Error("No owner");
    const attribution = { sessionId: "s", userId: "device", identifiedUserId: "bob", receivedAtMs: Date.now() };
    await claims.saveAttribution(owner.claim, attribution);
    const result = await client.eval(
      HEATMAP_ERASE_ATTRIBUTION_LUA,
      3,
      owner.claim.key,
      `${owner.claim.key}:attribution`,
      "heatmap-attributions:42",
      JSON.stringify({ ...attribution, identifiedUserId: "alice" }),
      HEATMAP_COMPLETION_TTL_MS
    );
    expect(result).toBe(0);
    expect(await claims.getAttribution(owner.claim)).toEqual(attribution);
    expect(await client.zcard("heatmap-attributions:42")).toBe(1);
    expect(await client.get(owner.claim.key)).toBe(owner.claim.token);
  });
});
