import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

const mode = process.argv[2];
// Match docker-compose defaults; the private env file may omit these non-secret fields.
process.env.POSTGRES_USER ||= "frog";
process.env.POSTGRES_DB ||= "analytics";
process.env.CLICKHOUSE_DB ||= "analytics";
const directory = new URL("./", import.meta.url);
const state = JSON.parse(await readFile(new URL(".cache/lifecycle-state.json", directory), "utf8"));
assert.match(state.suffix, /^[0-9a-f]{12}$/);
assert.equal(state.hostname, `lifecycle-${state.suffix}.heatmap.test`);
assert.ok(Number.isInteger(state.siteId) && state.siteId > 0);
assert.ok(Number.isInteger(state.foreignSiteId) && state.foreignSiteId > 0 && state.foreignSiteId !== state.siteId);
const evidence = {
  mode,
  startedAt: new Date().toISOString(),
  checks: [] as Record<string, unknown>[],
  cleanup: [] as Record<string, unknown>[],
  passed: false,
};
const check = (name: string, observed: unknown) => evidence.checks.push({ name, passed: true, observed });
const requireServer = createRequire(new URL("../../server/package.json", import.meta.url));
const { createClient } = requireServer("@clickhouse/client");
const ttlDatabase = `rybbit_heatmap_lifecycle_${state.suffix}`;
if (mode === "ttl") process.env.CLICKHOUSE_DB = ttlDatabase;
const admin = createClient({
  url: process.env.CLICKHOUSE_HOST,
  database: "default",
  password: process.env.CLICKHOUSE_PASSWORD,
});
let createdDatabase = false;
let ch;
let queryClient;
let pg;
let redisClients;
try {
  if (mode === "ttl") {
    await admin.command({ query: `CREATE DATABASE ${ttlDatabase}` });
    createdDatabase = true;
  }
  const appClients = await import("../../server/dist/db/clickhouse/client.js");
  ch = appClients.clickhouse;
  queryClient = appClients.clickhouseQuery;
  async function query(sql: string, params?: Record<string, unknown>) {
    const result = await ch.query({ query: sql, query_params: params, format: "JSONEachRow" });
    return result.json();
  }
  const clickRow = (siteId: number, pathname: string, userId: string, identified = "", batchId = randomUUID()) => ({
    site_id: siteId,
    session_id: randomUUID(),
    user_id: userId,
    identified_user_id: identified,
    timestamp: new Date(Date.now() - 2000).toISOString(),
    page_visit_id: randomUUID(),
    batch_id: batchId,
    event_index: 0,
    type: "click",
    hostname: siteId === state.siteId ? state.hostname : state.foreignHostname,
    pathname,
    viewport_bucket: 375,
    viewport_width: 375,
    viewport_height: 812,
    document_width: 375,
    document_height: 2000,
    client_x: 40,
    client_y: 60,
    page_x: 40,
    page_y: 60,
    max_depth: null,
  });
  const insert = (table: string, rows: Record<string, unknown>[]) =>
    ch.insert({ table, values: rows, format: "JSONEachRow" });
  if (mode === "ttl") {
    const { initializeHeatmapTables } = await import("../../server/dist/db/clickhouse/schema/heatmaps.js");
    await initializeHeatmapTables();
    await initializeHeatmapTables();
    const [schema] = await query(
      "SELECT create_table_query FROM system.tables WHERE database=currentDatabase() AND name='heatmap_events'"
    );
    assert.match(schema.create_table_query, /TTL timestamp \+ toIntervalDay\(30\)/);
    assert.match(schema.create_table_query, /CODEC\(ZSTD\(1\)\)/);
    await ch.command({ query: "SYSTEM STOP TTL MERGES heatmap_events" });
    const old = clickRow(1, "/old", "ttl-old");
    old.timestamp = new Date(Date.now() - 40 * 86400_000).toISOString();
    const fresh = clickRow(1, "/fresh", "ttl-fresh");
    await insert("heatmap_events", [old, fresh]);
    const before = await query("SELECT pathname FROM heatmap_events ORDER BY pathname");
    assert.deepEqual(
      before.map(row => row.pathname),
      ["/fresh", "/old"]
    );
    await ch.command({ query: "SYSTEM START TTL MERGES heatmap_events" });
    await ch.command({ query: "OPTIMIZE TABLE heatmap_events FINAL" });
    const after = await query("SELECT pathname FROM heatmap_events ORDER BY pathname");
    assert.deepEqual(
      after.map(row => row.pathname),
      ["/fresh"]
    );
    await initializeHeatmapTables();
    assert.equal(Number((await query("SELECT count() AS rows FROM heatmap_events"))[0].rows), 1);
    check("Repeated production ClickHouse initializer and real 30-day TTL remove only an expired fixture", {
      before,
      after,
      codec: "ZSTD(1)",
    });
  } else {
    ({ sql: pg } = await import("../../server/dist/db/postgres/postgres.js"));
    redisClients = await import("../../server/dist/db/redis/redis.js");
    const { redis } = redisClients;
    const siteIds = [state.siteId, state.foreignSiteId];
    const { HeatmapBatchClaims } = await import("../../server/dist/services/heatmaps/heatmapBatchClaims.js");
    const activeClaims = new HeatmapBatchClaims(redis);
    const retainedContexts = [
      { siteId: state.siteId, label: "alice", userId: state.fingerprint, identifiedUserId: state.alice },
      { siteId: state.siteId, label: "linked-anonymous", userId: state.fingerprint, identifiedUserId: "" },
      { siteId: state.siteId, label: "bob", userId: state.fingerprint, identifiedUserId: state.bob },
      { siteId: state.siteId, label: "unlinked-anonymous", userId: `${state.fingerprint}-unlinked`, identifiedUserId: "" },
      { siteId: state.foreignSiteId, label: "foreign-alice", userId: state.fingerprint, identifiedUserId: state.alice },
    ];
    const retainedBatch = (context) => `lifecycle-erasure-${state.suffix}-${context.siteId}-${context.label}`;
    const retainedKey = (context) => `heatmap-batch:${context.siteId}:${createHash("sha256").update(retainedBatch(context)).digest("hex")}`;
    const assertRetainedContexts = async (erasedLabels) => {
      for (const context of retainedContexts) {
        const key = retainedKey(context);
        const erased = erasedLabels.includes(context.label);
        const value = await redis.get(`${key}:attribution`);
        const indexed = await redis.zscore(`heatmap-attributions:${context.siteId}`, `${key}:attribution`);
        if (erased) {
          assert.equal(value, null);
          assert.equal(indexed, null);
          assert.equal((await activeClaims.claim(context.siteId, retainedBatch(context))).status, "completed");
        } else {
          assert.equal(JSON.parse(value).identifiedUserId, context.identifiedUserId);
          assert.notEqual(indexed, null);
        }
      }
    };
    const ownSites = await pg`SELECT site_id,domain FROM sites WHERE site_id IN ${pg(siteIds)}`;
    for (const row of ownSites) assert.ok([state.hostname, state.foreignHostname].includes(row.domain));
    const ownRows = (table: string) =>
      query(
        `SELECT site_id,user_id,identified_user_id,session_id FROM ${table} WHERE site_id IN {siteIds:Array(UInt32)} ORDER BY site_id,identified_user_id,user_id`,
        { siteIds }
      );
    const identityRows = async (table: string) =>
      (await ownRows(table)).filter(row => row.user_id === state.fingerprint);
    const privacyRows = async (table: string) =>
      (await ownRows(table)).filter(row => row.user_id.startsWith(state.fingerprint));
    const assertForeignPostgresIdentity = async () => {
      const aliases = await pg`SELECT anonymous_id,user_id FROM user_aliases WHERE site_id=${state.foreignSiteId}`;
      assert.deepEqual(
        aliases.map(row => [row.anonymous_id, row.user_id]),
        [[state.fingerprint, state.alice]]
      );
      const profiles =
        await pg`SELECT user_id FROM user_profiles WHERE site_id=${state.foreignSiteId} ORDER BY user_id`;
      assert.deepEqual(
        profiles.map(row => row.user_id),
        [state.alice, state.bob].sort()
      );
    };
    const tables = ["events", "heatmap_events", "session_replay_events", "session_replay_metadata_v2"];
    const waitFor = async (fn: () => Promise<boolean>) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await fn()) return;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error("Timed out waiting for this fixture's mutation");
    };
    if (mode === "faults") {
      assert.equal(ownSites.length, 2);
      const claimKey = `heatmap-batch:${state.siteId}:${createHash("sha256").update(state.publicBatchId).digest("hex")}`;
      assert.equal(await redis.get(claimKey), "done");
      assert.ok((await redis.pttl(claimKey)) > 29 * 86400_000);
      const [physical] = await query(
        "SELECT count() AS rows FROM heatmap_events WHERE site_id={siteId:UInt32} AND batch_id={batch:String}",
        { siteId: state.siteId, batch: state.publicBatchId }
      );
      assert.equal(Number(physical.rows), 1);
      check("Real Redis completed marker prevents physical duplicate concurrent HTTP inserts", {
        physicalRows: 1,
        completionTTLGreaterThan29Days: true,
      });

      const { HeatmapIngestService } = await import("../../server/dist/services/heatmaps/heatmapIngestService.js");
      const { HeatmapBatchClaims } = await import("../../server/dist/services/heatmaps/heatmapBatchClaims.js");
      const { siteConfig } = await import("../../server/dist/lib/siteConfig.js");
      const { HeatmapQueryService } = await import("../../server/dist/services/heatmaps/heatmapQueryService.js");
      const site = await siteConfig.reload(state.siteId);
      assert.equal(site.domain, state.hostname);
      for (const fault of ["throw", "false"]) {
        let heldClaim;
        class FaultClaims extends HeatmapBatchClaims {
          async complete(claim) {
            heldClaim = claim;
            if (fault === "throw")
              throw new Error("Lifecycle injected crash after durable insert, before acknowledgement");
            return false;
          }
        }
        const batchId = `lifecycle-crash-${state.suffix}-${fault}`;
        const events = Array.from({ length: 3 }, (_, index) => ({
          type: "click",
          timestamp: Date.now() - 2000,
          pageVisitId: `visit-${batchId}`,
          hostname: state.hostname,
          pathname: `/crash-${fault}`,
          viewportWidth: 375,
          viewportHeight: 812,
          documentWidth: 375,
          documentHeight: 2000,
          clientX: 20 + index,
          clientY: 50 + index,
          pageX: 20 + index,
          pageY: 50 + index,
        }));
        const batch = { batchId, anonymousId: `lifecycle-crash-device-${state.suffix}-${fault}`, events };
        const metadata = {
          headers: { "user-agent": "Mozilla/5.0 Chrome/140.0.0.0" },
          userAgent: "Mozilla/5.0 Chrome/140.0.0.0",
          ipAddress: "127.0.0.1",
          candidateIps: ["127.0.0.1"],
          lookupAsn: () => undefined,
          receivedAt: new Date(),
        };
        await assert.rejects(new HeatmapIngestService(new FaultClaims(redis)).recordEvents(site, batch, metadata));
        assert.ok(heldClaim && (await redis.get(heldClaim.key)) === heldClaim.token);
        assert.notEqual(await redis.get(`${heldClaim.key}:attribution`), null);
        assert.notEqual(await redis.zscore(`heatmap-attributions:${state.siteId}`, `${heldClaim.key}:attribution`), null);
        const service = new HeatmapIngestService(new HeatmapBatchClaims(redis));
        assert.equal((await service.recordEvents(site, batch, metadata)).status, "busy");
        const [firstIdentity] = await query(
          "SELECT DISTINCT user_id,session_id FROM heatmap_events WHERE site_id={siteId:UInt32} AND batch_id={batch:String}",
          { siteId: state.siteId, batch: batchId }
        );
        const ownSessionKey = `session:${state.siteId}:${firstIdentity.user_id}`;
        assert.equal(await redis.get(ownSessionKey), firstIdentity.session_id);
        await redis.pexpire(heldClaim.key, 1);
        await redis.pexpire(ownSessionKey, 1);
        await new Promise(resolve => setTimeout(resolve, 25));
        assert.equal(await redis.get(heldClaim.key), null);
        assert.equal((await service.recordEvents(site, batch, metadata)).status, "recorded");
        assert.equal((await service.recordEvents(site, batch, metadata)).status, "duplicate");
        assert.equal(await redis.get(`${heldClaim.key}:attribution`), null);
        assert.equal(await redis.zscore(`heatmap-attributions:${state.siteId}`, `${heldClaim.key}:attribution`), null);
        const [raw] = await query(
          "SELECT count() AS rows,uniqExact(session_id) AS physicalSessions FROM heatmap_events WHERE site_id={siteId:UInt32} AND batch_id={batch:String}",
          { siteId: state.siteId, batch: batchId }
        );
        assert.equal(Number(raw.rows), 6);
        assert.equal(Number(raw.physicalSessions), 1, "Lease recovery preserves original batch attribution");
        const report = await new HeatmapQueryService().getHeatmaps(
          state.siteId,
          {
            mode: "click",
            hostname: state.hostname,
            pathname: `/crash-${fault}`,
            bucket: 375,
            past_minutes_start: 120,
            past_minutes_end: 0,
            time_zone: "UTC",
          },
          state.hostname
        );
        assert.equal(report.count, 3);
        assert.equal(report.sessions, 1);
        assert.equal(report.points.length, 3);
        assert.equal(
          report.points.reduce((sum, point) => sum + point.count, 0),
          3
        );
        check(`Production ingest ${fault} after durable insert, shortened own Redis lease expiry and retry dedup`, {
          physicalRows: 6,
          physicalSessions: 1,
          reportCount: 3,
          reportSessions: 1,
          points: 3,
          busyBeforeExpiry: true,
          duplicateAfterCompletion: true,
        });
      }
    } else if (mode === "identity") {
      assert.equal(ownSites.length, 2);
      const fixtures = siteIds.flatMap(siteId =>
        ["", state.alice, state.bob].map(identified => clickRow(siteId, "/identity", state.fingerprint, identified))
      );
      const insertFixtureSet = async fixtures => {
        await insert("heatmap_events", fixtures);
        await insert(
          "events",
          fixtures.map(row => ({
            site_id: row.site_id,
            session_id: row.session_id,
            user_id: row.user_id,
            identified_user_id: row.identified_user_id,
            timestamp: row.timestamp,
            hostname: row.hostname,
            pathname: row.pathname,
            country: "GB",
            type: "pageview",
          }))
        );
        await insert(
          "session_replay_events",
          fixtures.map(row => ({
            site_id: row.site_id,
            session_id: row.session_id,
            user_id: row.user_id,
            identified_user_id: row.identified_user_id,
            timestamp: row.timestamp,
            event_type: "lifecycle",
            event_data: "[]",
            sequence_number: 0,
            event_size_bytes: 2,
          }))
        );
        await insert(
          "session_replay_metadata_v2",
          fixtures.map(row => ({
            site_id: row.site_id,
            session_id: row.session_id,
            user_id: row.user_id,
            identified_user_id: row.identified_user_id,
            start_time: row.timestamp,
            end_time: row.timestamp,
            event_count: 1,
            compressed_size_bytes: 2,
            country: "GB",
            page_url: `https://${row.hostname}${row.pathname}`,
            has_replay_data: 1,
          }))
        );
      };
      await insertFixtureSet(fixtures);
      await pg`INSERT INTO user_aliases(site_id,anonymous_id,user_id) VALUES (${state.siteId},${state.fingerprint},${state.alice}),(${state.foreignSiteId},${state.fingerprint},${state.alice})`;
      await pg`INSERT INTO user_profiles(site_id,user_id) VALUES (${state.siteId},${state.alice}),(${state.siteId},${state.bob}),(${state.foreignSiteId},${state.alice}),(${state.foreignSiteId},${state.bob})`;
      const { identityBackfillQueue } = await import("../../server/dist/services/tracker/identityBackfillQueue.js");
      identityBackfillQueue.enqueue({ siteId: state.siteId, anonymousId: state.fingerprint, userId: state.alice }, 30);
      await identityBackfillQueue.flush();
      const identities = {};
      for (const table of tables) {
        await waitFor(
          async () =>
            (await identityRows(table)).filter(
              row => row.site_id === state.siteId && row.identified_user_id === state.alice
            ).length === 2
        );
        const rows = await identityRows(table);
        assert.deepEqual(
          rows
            .filter(row => row.site_id === state.siteId)
            .map(row => row.identified_user_id)
            .sort(),
          [state.alice, state.alice, state.bob].sort()
        );
        assert.deepEqual(
          rows
            .filter(row => row.site_id === state.foreignSiteId)
            .map(row => row.identified_user_id)
            .sort(),
          ["", state.alice, state.bob].sort()
        );
        identities[table] = { primary: ["Alice", "Alice", "Bob"], foreign: ["anonymous", "Alice", "Bob"] };
      }
      check(
        "Actual identityBackfillQueue flush updates anonymous rows only and preserves Bob plus foreign site",
        identities
      );
      // Add unattributed activity after the backfill so erasure independently exercises the alias predicate.
      await insertFixtureSet([
        clickRow(state.siteId, "/identity", state.fingerprint, ""),
        clickRow(state.siteId, "/identity", `${state.fingerprint}-other`, ""),
        clickRow(state.siteId, "/identity", `${state.fingerprint}-other`, state.bob),
        clickRow(state.siteId, "/identity", `${state.fingerprint}-unlinked`, ""),
        clickRow(state.siteId, "/identity", `${state.fingerprint}-unlinked`, state.alice),
      ]);
      await pg`INSERT INTO user_aliases(site_id,anonymous_id,user_id) VALUES (${state.siteId},${`${state.fingerprint}-other`},${state.alice})`;
      for (const table of tables)
        assert.equal((await privacyRows(table)).filter(row => row.site_id === state.siteId).length, 8);
      check(
        "Erasure fixture includes late anonymous shared-device activity, another linked device and an unlinked device",
        { primaryRowsPerTable: 8, foreignRowsPerTable: 3 }
      );
      for (const context of retainedContexts) {
        const claimed = await activeClaims.claim(context.siteId, retainedBatch(context));
        assert.ok(claimed.status === "acquired");
        await activeClaims.saveAttribution(claimed.claim, {
          sessionId: randomUUID(), userId: context.userId,
          identifiedUserId: context.identifiedUserId, receivedAtMs: Date.now(),
        });
      }
      await assertRetainedContexts([]);
      check("Real Redis attribution index contains only the five active erasure fixtures", { primary: 4, foreign: 1 });
    } else if (mode === "after-user-delete") {
      const observed = {};
      for (const table of tables) {
        await waitFor(async () => (await privacyRows(table)).filter(row => row.site_id === state.siteId).length === 3);
        const rows = await privacyRows(table);
        assert.deepEqual(
          rows
            .filter(row => row.site_id === state.siteId)
            .map(row => [row.user_id, row.identified_user_id])
            .sort(),
          [
            [state.fingerprint, state.bob],
            [`${state.fingerprint}-other`, state.bob],
            [`${state.fingerprint}-unlinked`, ""],
          ].sort()
        );
        assert.deepEqual(
          rows
            .filter(row => row.site_id === state.foreignSiteId)
            .map(row => row.identified_user_id)
            .sort(),
          ["", state.alice, state.bob].sort()
        );
        observed[table] = {
          primaryRemaining: ["Bob on shared device", "Bob on other linked device", "unlinked anonymous device"],
          foreignRemaining: 3,
        };
      }
      assert.equal(
        Number(
          (
            await pg`SELECT count(*) AS count FROM user_aliases WHERE site_id=${state.siteId} AND user_id=${state.alice}`
          )[0].count
        ),
        0
      );
      assert.equal(
        Number(
          (
            await pg`SELECT count(*) AS count FROM user_profiles WHERE site_id=${state.siteId} AND user_id=${state.alice}`
          )[0].count
        ),
        0
      );
      assert.equal(
        Number(
          (
            await pg`SELECT count(*) AS count FROM user_profiles WHERE site_id=${state.siteId} AND user_id=${state.bob}`
          )[0].count
        ),
        1
      );
      check(
        "Authenticated user erasure removes Alice across four actual tables and PG aliases/profile while preserving Bob/foreign site",
        observed
      );
      await assertForeignPostgresIdentity();
      await assertRetainedContexts(["alice", "linked-anonymous"]);
      check("User erasure tombstones matching active retry contexts and preserves Bob, unlinked and foreign contexts", { erased: 2, retained: 3 });
    } else if (mode === "after-site-delete") {
      assert.deepEqual(
        ownSites.map(row => row.site_id),
        [state.foreignSiteId]
      );
      for (const table of ["heatmap_events", "session_replay_events", "session_replay_metadata_v2"]) {
        await waitFor(async () => (await ownRows(table)).filter(row => row.site_id === state.siteId).length === 0);
        assert.equal((await identityRows(table)).filter(row => row.site_id === state.foreignSiteId).length, 3);
      }
      assert.equal(Number((await pg`SELECT count(*) AS count FROM cohorts WHERE site_id=${state.siteId}`)[0].count), 0);
      assert.equal(
        Number((await pg`SELECT count(*) AS count FROM cohorts WHERE site_id=${state.foreignSiteId}`)[0].count),
        1
      );
      for (const table of ["user_profiles", "user_aliases"])
        assert.equal(
          Number((await pg.unsafe(`SELECT count(*) AS count FROM ${table} WHERE site_id=$1`, [state.siteId]))[0].count),
          0
        );
      await assertForeignPostgresIdentity();
      await assertRetainedContexts(["alice", "linked-anonymous", "bob", "unlinked-anonymous"]);
      assert.equal(await redis.exists(`heatmap-attributions:${state.siteId}`), 0);
      check("Site erasure clears its active Redis index and tombstones retries while preserving the foreign index", { primaryIndexRemoved: true, foreignContexts: 1 });
      check(
        "Authenticated site erasure removes interactions and cascades saved cohort/profile/alias rows while preserving foreign site",
        { primaryInteractionRows: 0, primaryCohorts: 0, foreignCohorts: 1, foreignRowsPerInteractionTable: 3 }
      );
    } else if (mode === "cleanup") {
      assert.equal(ownSites.length, 0);
      const derived = await query(
        "SELECT name FROM system.tables WHERE database=currentDatabase() AND name IN {names:Array(String)}",
        {
          names: [
            "hourly_events_by_site_mv_target",
            "sessions_mv_target",
            "overview_hourly_mv_target",
            "pathname_hourly_mv_target",
            "country_hourly_mv_target",
            "device_type_hourly_mv_target",
            "session_hourly_mv_target",
          ],
        }
      );
      const cleanupTables = [...tables, ...derived.map(row => row.name)];
      for (const table of cleanupTables)
        await ch.command({
          query: `DELETE FROM ${table} WHERE site_id IN {siteIds:Array(UInt32)}`,
          query_params: { siteIds },
        });
      let removedKeys = 0;
      for (const siteId of siteIds) {
        for (const pattern of [`heatmap-batch:${siteId}:*`, `heatmap-attributions:${siteId}`, `session:${siteId}:*`]) {
          let cursor = "0";
          do {
            const [next, keys] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 100);
            cursor = next;
            if (keys.length) removedKeys += await redis.del(...keys);
          } while (cursor !== "0");
        }
      }
      for (const table of cleanupTables)
        await waitFor(
          async () =>
            Number(
              (
                await query(`SELECT count() AS rows FROM ${table} WHERE site_id IN {siteIds:Array(UInt32)}`, {
                  siteIds,
                })
              )[0].rows
            ) === 0
        );
      const benchmarkDatabases = await query(
        "SELECT name FROM system.databases WHERE startsWith(name,'rybbit_heatmap_benchmark_')"
      );
      assert.deepEqual(benchmarkDatabases, []);
      check("Lifecycle test cleanup removes only its created sites' rows/keys and benchmark databases are absent", {
        removedKeys,
        remainingRows: 0,
        benchmarkDatabases,
      });
      evidence.cleanup.push({
        createdSitesRemoved: siteIds,
        removedKeys,
        remainingRows: 0,
        cleanedTables: cleanupTables,
        benchmarkDatabases: [],
      });
    } else throw new Error(`Unknown lifecycle mode: ${mode}`);
  }
  evidence.passed = true;
} finally {
  await ch?.close();
  await queryClient?.close();
  await pg?.end();
  if (redisClients)
    await Promise.all(
      [redisClients.redis, redisClients.dashboardCacheRedis, redisClients.sessionRedis, redisClients.identityRedis].map(
        client => client.quit()
      )
    );
  if (createdDatabase) {
    await admin.command({ query: `DROP DATABASE ${ttlDatabase}` });
    const result = await admin.query({
      query: "SELECT count() AS remaining FROM system.databases WHERE name={database:String}",
      query_params: { database: ttlDatabase },
      format: "JSONEachRow",
    });
    assert.equal(Number((await result.json())[0].remaining), 0);
    evidence.cleanup.push({ droppedDatabase: ttlDatabase, verifiedAbsent: true });
  }
  await admin.close();
  evidence.completedAt = new Date().toISOString();
  await writeFile(new URL(`lifecycle-services-${mode}.json`, directory), `${JSON.stringify(evidence, null, 2)}\n`);
}
// The production identity queue owns a recurring timer; the test process exits only after its explicit flush and cleanup.
process.exit(0);
