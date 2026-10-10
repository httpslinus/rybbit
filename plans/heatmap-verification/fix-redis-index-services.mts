import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

process.env.POSTGRES_USER ||= "frog";
process.env.POSTGRES_DB ||= "analytics";
const directory = new URL("./", import.meta.url);
const state = JSON.parse(await readFile(new URL("fix-redis-index-state.json", directory), "utf8"));
assert.match(state.suffix, /^[0-9a-f]{12}$/);
assert.equal(state.hostname, `fix-redis-index-${state.suffix}.heatmap.test`);
assert.ok(Number.isInteger(state.siteId) && Number.isInteger(state.foreignSiteId) && state.siteId !== state.foreignSiteId);
const mode = process.argv[2];
assert.ok(["prepare", "after-user-delete", "after-site-delete", "after-foreign-delete", "cleanup"].includes(mode));
const evidence = { mode, startedAt: new Date().toISOString(), checks: [] as Record<string, unknown>[], cleanup: [] as Record<string, unknown>[], passed: false };
const redisClients = await import("../../server/dist/db/redis/redis.js");
const { redis } = redisClients;
const { sql: pg } = await import("../../server/dist/db/postgres/postgres.js");
const claimsModule = await import("../../server/dist/services/heatmaps/heatmapBatchClaims.js");
const { HeatmapBatchClaims, HEATMAP_ATTRIBUTION_PAGE_LUA, HEATMAP_ATTRIBUTION_TTL_MS } = claimsModule;
assert.match(HEATMAP_ATTRIBUTION_PAGE_LUA, /ZSCAN/);
assert.doesNotMatch(HEATMAP_ATTRIBUTION_PAGE_LUA, /'SCAN'/);
const claims = new HeatmapBatchClaims(redis);
const counts = { directAlice: 1300, directAnonymous: 200, bob: 300, foreignAlice: 100, apiAlice: 1300, apiAnonymous: 200, expired: 20, completed: 200 };
type Group = keyof typeof counts;
const batchId = (group: Group, index: number) => `fix-redis-index-${state.suffix}-${group}-${index}`;
const siteFor = (group: Group) => group === "foreignAlice" ? state.foreignSiteId : state.siteId;
const claimKey = (group: Group, index: number) => `heatmap-batch:${siteFor(group)}:${createHash("sha256").update(batchId(group, index)).digest("hex")}`;
const contextKey = (group: Group, index: number) => `${claimKey(group, index)}:attribution`;
const indexKey = (siteId: number) => `heatmap-attributions:${siteId}`;
const keysFor = (groups: Group[]) => groups.flatMap(group => Array.from({ length: counts[group] }, (_, index) => contextKey(group, index)));
const check = (name: string, observed: unknown) => evidence.checks.push({ name, passed: true, observed });
async function checkContexts(groups: Group[], exists: boolean) {
  const keys = keysFor(groups);
  for (let offset = 0; offset < keys.length; offset += 500) {
    const values = await redis.mget(...keys.slice(offset, offset + 500));
    assert.ok(values.every(value => exists ? value !== null : value === null), `${groups.join(",")} context preservation failed`);
  }
}
async function seed(groups: Group[]) {
  const work = groups.flatMap(group => Array.from({ length: counts[group] }, (_, index) => ({ group, index })));
  for (let offset = 0; offset < work.length; offset += 40) {
    await Promise.all(work.slice(offset, offset + 40).map(async ({ group, index }) => {
      const result = await claims.claim(siteFor(group), batchId(group, index));
      assert.equal(result.status, "acquired");
      if (result.status !== "acquired") throw new Error("Fixture claim not acquired");
      await claims.saveAttribution(result.claim, { sessionId: randomUUID(), userId: state.device,
        identifiedUserId: group === "bob" ? state.bob : group.endsWith("Anonymous") ? "" : state.alice,
        receivedAtMs: Date.now() });
      if (group === "completed") await claims.complete(result.claim);
    }));
  }
}
try {
  if (mode === "prepare") {
    const sites = await pg`SELECT site_id,domain FROM sites WHERE site_id IN (${state.siteId},${state.foreignSiteId}) ORDER BY site_id`;
    assert.equal(sites.length, 2);
    assert.deepEqual(new Set(sites.map(site => site.domain)), new Set([state.hostname, state.foreignHostname]));
    await pg`INSERT INTO user_aliases(site_id,anonymous_id,user_id) VALUES (${state.siteId},${state.device},${state.alice}),(${state.foreignSiteId},${state.device},${state.alice})`;
    await seed(["directAlice", "directAnonymous", "bob", "foreignAlice", "expired", "completed"]);
    assert.equal(await redis.zcard(indexKey(state.siteId)), 1820);
    assert.equal(await redis.zcard(indexKey(state.foreignSiteId)), 100);
    assert.ok((await redis.pttl(indexKey(state.siteId))) > HEATMAP_ATTRIBUTION_TTL_MS - 60_000);
    for (let index = 0; index < counts.expired; index++) {
      await redis.pexpire(contextKey("expired", index), 1);
      await redis.zadd(indexKey(state.siteId), Date.now() - 100, contextKey("expired", index));
    }
    await new Promise(resolve => setTimeout(resolve, 10));
    const pages: { inputCursor: string; outputCursor: string; indexedMembers: number }[] = [];
    const instrumented = new HeatmapBatchClaims({
      eval: async (...args: Parameters<typeof redis.eval>) => {
        const result = await redis.eval(...args);
        if (args[0] === HEATMAP_ATTRIBUTION_PAGE_LUA) {
          const [cursor, entries] = result as [string, string[]];
          pages.push({ inputCursor: String(args[3]), outputCursor: cursor, indexedMembers: entries.length / 2 });
        }
        return result;
      },
      mget: (...keys: string[]) => redis.mget(...keys),
    });
    await instrumented.clearAttributions(state.siteId, state.alice, [state.alice, state.device]);
    assert.ok(pages.length > 1, "Real Redis must exercise multiple cursor pages");
    assert.ok(pages.some(page => page.outputCursor !== "0"));
    assert.equal(pages.at(-1)?.outputCursor, "0");
    await checkContexts(["directAlice", "directAnonymous", "expired", "completed"], false);
    await checkContexts(["bob", "foreignAlice"], true);
    assert.equal(await redis.zcard(indexKey(state.siteId)), counts.bob);
    assert.equal(await redis.zcard(indexKey(state.foreignSiteId)), counts.foreignAlice);
    for (const group of ["directAlice", "directAnonymous"] as Group[]) {
      const keys = Array.from({ length: counts[group] }, (_, index) => claimKey(group, index));
      for (let offset = 0; offset < keys.length; offset += 500) assert.ok((await redis.mget(...keys.slice(offset, offset + 500))).every(value => value === "done"));
    }
    check("Production erasure traverses real Redis cursor pages, prunes expired entries and preserves other identities/sites", {
      activeBefore: 1800, expiredPruned: counts.expired, matchedErased: 1500, bobRetained: counts.bob,
      foreignRetained: counts.foreignAlice, completedNotIndexed: counts.completed, pages,
      returnedMembers: pages.reduce((total, page) => total + page.indexedMembers, 0),
    });
    await seed(["apiAlice", "apiAnonymous"]);
    assert.equal(await redis.zcard(indexKey(state.siteId)), 1800);
    check("Prepared a separate multi-page context population for the HTTP erasure endpoint", { activeContexts: 1800 });
  } else if (mode === "after-user-delete") {
    await checkContexts(["apiAlice", "apiAnonymous", "directAlice", "directAnonymous"], false);
    await checkContexts(["bob", "foreignAlice"], true);
    assert.equal(await redis.zcard(indexKey(state.siteId)), counts.bob);
    assert.equal(await redis.zcard(indexKey(state.foreignSiteId)), counts.foreignAlice);
    const aliases = await pg`SELECT site_id FROM user_aliases WHERE anonymous_id=${state.device} AND user_id=${state.alice}`;
    assert.deepEqual(aliases.map(row => row.site_id), [state.foreignSiteId]);
    check("HTTP user erasure removes every identified/linked anonymous context while preserving Bob and the foreign site", { erased: 1500, bobRetained: 300, foreignRetained: 100, ownIndexMembers: 300 });
  } else if (mode === "after-site-delete") {
    await checkContexts(["bob"], false);
    await checkContexts(["foreignAlice"], true);
    assert.equal(await redis.exists(indexKey(state.siteId)), 0);
    assert.equal(await redis.zcard(indexKey(state.foreignSiteId)), counts.foreignAlice);
    assert.equal((await pg`SELECT site_id FROM sites WHERE site_id=${state.siteId}`).length, 0);
    check("HTTP site erasure removes the final index and all retained Bob contexts without touching the foreign site", { ownIndexRemoved: true, foreignIndexMembers: 100 });
  } else if (mode === "after-foreign-delete") {
    await checkContexts(["foreignAlice"], false);
    assert.equal(await redis.exists(indexKey(state.foreignSiteId)), 0);
    assert.equal((await pg`SELECT site_id FROM sites WHERE site_id IN (${state.siteId},${state.foreignSiteId})`).length, 0);
    check("Both QA sites and their active attribution indexes are removed", { removedSites: 2, removedIndexes: 2 });
  } else {
    const keys = (Object.keys(counts) as Group[]).flatMap(group => Array.from({ length: counts[group] }, (_, index) => [claimKey(group, index), contextKey(group, index)]).flat());
    keys.push(indexKey(state.siteId), indexKey(state.foreignSiteId));
    for (let offset = 0; offset < keys.length; offset += 500) await redis.unlink(...keys.slice(offset, offset + 500));
    for (let offset = 0; offset < keys.length; offset += 500) assert.ok((await redis.mget(...keys.slice(offset, offset + 500))).every(value => value === null));
    const sites = await pg`SELECT site_id FROM sites WHERE site_id IN (${state.siteId},${state.foreignSiteId})`;
    assert.equal(sites.length, 0);
    evidence.cleanup.push({ knownFixtureRedisKeysRemoved: keys.length, qaSitesRemoved: 2 });
  }
  evidence.passed = true;
} finally {
  evidence.finishedAt = new Date().toISOString();
  await writeFile(new URL(`fix-redis-index-${mode}.json`, directory), `${JSON.stringify(evidence, null, 2)}\n`);
  await pg.end();
  for (const client of Object.values(redisClients)) if (client && typeof client === "object" && "quit" in client) await client.quit();
}
console.log(JSON.stringify({ mode, passed: evidence.passed, checks: evidence.checks.length }));
