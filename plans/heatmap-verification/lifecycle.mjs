import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { baseUrl, localAccount } from "./qa-support.mjs";

const directory = new URL("./", import.meta.url);
const root = fileURLToPath(new URL("../../", directory));
const account = await localAccount();
const suffix = randomBytes(6).toString("hex");
const state = {
  suffix,
  siteId: null,
  foreignSiteId: null,
  hostname: `lifecycle-${suffix}.heatmap.test`,
  foreignHostname: `lifecycle-foreign-${suffix}.heatmap.test`,
  alice: `lifecycle-alice-${suffix}`,
  bob: `lifecycle-bob-${suffix}`,
  fingerprint: `lifecycle-fingerprint-${suffix}`,
  publicBatchId: `lifecycle-concurrent-${suffix}`,
  cohorts: {},
};
const evidence = {
  startedAt: new Date().toISOString(),
  baseUrl,
  isolation: "Two newly created local QA sites; their own Redis keys and one disposable TTL database only",
  checks: [],
  cleanup: [],
  passed: false,
};
const remainingSites = new Set();
let runError;
await mkdir(new URL(".cache/", directory), { recursive: true });
const saveState = () =>
  writeFile(new URL(".cache/lifecycle-state.json", directory), JSON.stringify(state), { mode: 0o600 });
const helper = async mode => {
  execFileSync(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "rybbit-local_default",
      "--env-file",
      `${root}plans/local/.env.local`,
      "--env",
      "CLICKHOUSE_HOST=http://clickhouse:8123",
      "--env",
      "REDIS_HOST=redis",
      "--mount",
      `type=bind,src=${fileURLToPath(directory)},dst=/app/plans/heatmap-verification`,
      "--mount",
      `type=bind,src=${root}server/GeoLite2-City.mmdb,dst=/app/server/GeoLite2-City.mmdb,readonly`,
      "--mount",
      `type=bind,src=${root}server/GeoLite2-ASN.mmdb,dst=/app/server/GeoLite2-ASN.mmdb,readonly`,
      "--workdir",
      "/app/server",
      "rybbit-local-benchmark:workspace",
      "node",
      "/app/plans/heatmap-verification/lifecycle-services.mts",
      mode,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
  const result = JSON.parse(await readFile(new URL(`lifecycle-services-${mode}.json`, directory), "utf8"));
  assert.equal(result.passed, true);
  evidence.checks.push(...result.checks);
  if (mode !== "cleanup") evidence.cleanup.push(...result.cleanup);
  return result;
};
const query = values =>
  new URLSearchParams(Object.entries(values).map(([key, value]) => [key, String(value)])).toString();
const window = { past_minutes_start: 120, past_minutes_end: 0, time_zone: "UTC" };
const report = async (pathname = "/controls", siteId = state.siteId, hostname = state.hostname, extra = {}) =>
  (
    await account.call(
      `/sites/${siteId}/heatmaps?${query({ ...window, mode: "click", hostname, pathname, bucket: 375, ...extra })}`
    )
  ).data;
const click = (pathname, index = 0, hostname = state.hostname) => ({
  type: "click",
  // Existing relative report windows round endpoints to seconds; keep synthetic samples inside their bounds.
  timestamp: Date.now() - 2000,
  pageVisitId: randomUUID(),
  hostname,
  pathname,
  viewportWidth: 375,
  viewportHeight: 812,
  documentWidth: 375,
  documentHeight: 2000,
  clientX: 20 + index,
  clientY: 50 + index,
  pageX: 20 + index,
  pageY: 50 + index,
});
const batch = (pathname = "/controls", batchId = randomUUID()) => ({
  batchId,
  anonymousId: `lifecycle-public-${suffix}`,
  events: [click(pathname)],
});
const publicCall = async (path, body) => {
  const response = await fetch(`${baseUrl}/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Origin: `https://${state.hostname}`,
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
};
const upload = body => publicCall(`/heatmaps/record/${state.siteId}`, body);
const configure = async (heatmaps, heatmapSampleRate) => {
  await account.call(`/sites/${state.siteId}/config`, { heatmaps, heatmapSampleRate }, "PUT");
  const settings = await account.call(`/sites/${state.siteId}`);
  const runtime = await publicCall(`/site/tracking-config/${state.siteId}`);
  assert.equal(runtime.status, 200);
  assert.equal(settings.heatmaps, heatmaps);
  assert.equal(settings.heatmapSampleRate, heatmapSampleRate);
  assert.equal(runtime.body.heatmaps, heatmaps);
  assert.equal(runtime.body.heatmapSampleRate, heatmapSampleRate);
};

try {
  for (const [field, domain] of [
    ["siteId", state.hostname],
    ["foreignSiteId", state.foreignHostname],
  ]) {
    const created = await account.call(`/organizations/${account.organizationId}/sites`, {
      domain,
      name: `Heatmap lifecycle ${suffix}`,
      heatmaps: true,
      heatmapSampleRate: 100,
      blockBots: false,
      saltUserIds: false,
      sessionReplay: false,
    });
    state[field] = created.siteId;
    assert.ok(Number.isInteger(created.siteId) && created.siteId > 0);
    remainingSites.add(created.siteId);
  }
  await saveState();
  evidence.sites = [state.siteId, state.foreignSiteId];
  assert.equal((await upload(batch())).status, 200);
  assert.equal((await report()).count, 1);
  await configure(false, 100);
  assert.equal((await upload(batch())).status, 200);
  assert.equal((await report()).count, 1);
  await configure(true, 0);
  assert.equal((await upload(batch())).status, 200);
  assert.equal((await report()).count, 1);
  await configure(true, 15);
  assert.equal((await upload(batch())).status, 200);
  assert.equal((await report()).count, 2);
  await configure(true, 100);
  assert.equal((await upload(batch())).status, 200);
  assert.equal((await report()).count, 3);
  await configure(false, 15);
  assert.equal((await report()).count, 3);
  await configure(true, 100);
  assert.equal((await upload(batch())).status, 200);
  assert.equal((await report()).count, 4);
  evidence.checks.push({
    name: "Public HTTP disabled/0/15/100 settings and re-enable preserve historical samples",
    passed: true,
    observedCounts: [1, 1, 1, 2, 3, 3, 4],
    note: "Positive sampling rates configure tracker-side selection; the server accepts a valid sampled upload without a second downsample.",
  });

  const duplicate = batch("/concurrent", state.publicBatchId);
  const concurrent = await Promise.all(Array.from({ length: 12 }, () => upload(duplicate)));
  assert.ok(concurrent.every(response => [200, 503].includes(response.status)));
  assert.ok(concurrent.some(response => response.status === 200));
  assert.equal((await upload(duplicate)).status, 200);
  assert.equal((await report("/concurrent")).count, 1);
  state.concurrentStatuses = concurrent.map(response => response.status);
  await saveState();
  evidence.checks.push({
    name: "Twelve concurrent public HTTP retries count one interaction",
    passed: true,
    statuses: state.concurrentStatuses,
  });
  await helper("faults");
  await helper("identity");

  const day = new Date().toISOString().slice(0, 10);
  for (const siteId of [state.siteId, state.foreignSiteId]) {
    const cohort = await account.call(`/sites/${siteId}/cohorts`, {
      name: `Lifecycle cohort ${suffix}`,
      startDate: day,
      endDate: day,
      timeZone: "UTC",
      filters: [{ parameter: "user_id", type: "equals", value: [state.alice] }],
    });
    assert.ok(cohort.cohortId > 0);
    state.cohorts[siteId] = cohort.cohortId;
  }
  await saveState();
  const primaryCohortBefore = await report("/identity", state.siteId, state.hostname, {
    cohort_id: state.cohorts[state.siteId],
  });
  const foreignCohortBefore = await report("/identity", state.foreignSiteId, state.foreignHostname, {
    cohort_id: state.cohorts[state.foreignSiteId],
  });
  assert.equal(primaryCohortBefore.cohort.members, 1);
  assert.equal(foreignCohortBefore.cohort.members, 1);
  assert.equal(primaryCohortBefore.count, 3);
  assert.equal(foreignCohortBefore.count, 1);
  await account.call(`/sites/${state.siteId}/users/${encodeURIComponent(state.alice)}`, undefined, "DELETE");
  await helper("after-user-delete");
  const primaryCohortAfter = await report("/identity", state.siteId, state.hostname, {
    cohort_id: state.cohorts[state.siteId],
  });
  const foreignCohortAfter = await report("/identity", state.foreignSiteId, state.foreignHostname, {
    cohort_id: state.cohorts[state.foreignSiteId],
  });
  assert.equal(primaryCohortAfter.cohort.members, 0);
  assert.equal(primaryCohortAfter.count, 0);
  assert.equal(primaryCohortAfter.cohort.cohortId, state.cohorts[state.siteId]);
  assert.equal(foreignCohortAfter.cohort.members, 1);
  assert.equal(foreignCohortAfter.count, foreignCohortBefore.count);
  evidence.checks.push({
    name: "Normal HTTP cohort reports recompute membership after erasure without a permanent member cache",
    passed: true,
    primaryBefore: { members: 1, count: 3 },
    primaryAfter: { members: 0, count: 0 },
    foreignBeforeAndAfter: { members: 1, count: 1 },
  });
  await account.call(`/sites/${state.siteId}`, undefined, "DELETE");
  remainingSites.delete(state.siteId);
  await helper("after-site-delete");
  await helper("ttl");
  evidence.passed = true;
} catch (error) {
  runError = error;
  evidence.failure = error.message;
} finally {
  for (const siteId of remainingSites) {
    try {
      await account.call(`/sites/${siteId}`, undefined, "DELETE");
      evidence.cleanup.push({ siteId, deletedThroughAuthenticatedAPI: true });
    } catch (error) {
      runError ||= error;
      evidence.cleanup.push({ siteId, error: error.message });
      evidence.passed = false;
    }
  }
  if (state.siteId && state.foreignSiteId) {
    await saveState();
    try {
      const cleaned = await helper("cleanup");
      evidence.cleanup.push(...cleaned.cleanup);
    } catch (error) {
      runError ||= error;
      evidence.cleanup.push({ error: error.message });
      evidence.passed = false;
    }
  }
  evidence.completedAt = new Date().toISOString();
  await writeFile(new URL("lifecycle-evidence.json", directory), `${JSON.stringify(evidence, null, 2)}\n`);
}
if (runError) throw runError;
console.log(
  `Passed ${evidence.checks.length} real HTTP/Redis/ClickHouse/Postgres lifecycle checks; test sites, keys and TTL database removed.`
);
