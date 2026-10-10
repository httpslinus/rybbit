import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { baseUrl } from "./qa-support.mjs";

const directory = new URL("./", import.meta.url);
const root = fileURLToPath(new URL("../../", directory));
const credentials = JSON.parse(await readFile(new URL(".cache/state.json", directory), "utf8"));
const cookies = new Map();
async function call(path, body, method = body === undefined ? "GET" : "POST") {
  const response = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: { Origin: baseUrl, Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; "),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(";", 1)[0];
    const separator = pair.indexOf("=");
    cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
  if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status}`);
  return response.json();
}
await call("/auth/sign-in/email", { email: credentials.email, password: credentials.password });
await call("/auth/organization/set-active", { organizationId: credentials.organizationId });
const suffix = randomBytes(6).toString("hex");
const state = { suffix, siteId: null, foreignSiteId: null,
  hostname: `fix-redis-index-${suffix}.heatmap.test`, foreignHostname: `fix-redis-index-foreign-${suffix}.heatmap.test`,
  alice: `fix-redis-alice-${suffix}`, bob: `fix-redis-bob-${suffix}`, device: `fix-redis-device-${suffix}` };
const evidence = { startedAt: new Date().toISOString(), isolation: "Two new local QA sites and their own known Redis keys only",
  checks: [], cleanup: [], passed: false };
const remaining = new Set();
const saveState = () => writeFile(new URL("fix-redis-index-state.json", directory), JSON.stringify(state), { mode: 0o600 });
async function helper(mode) {
  execFileSync("docker", ["run", "--rm", "--network", "rybbit-local_default", "--env-file", `${root}plans/local/.env.local`,
    "--env", "CLICKHOUSE_HOST=http://clickhouse:8123", "--env", "REDIS_HOST=redis",
    "--mount", `type=bind,src=${fileURLToPath(directory)},dst=/app/plans/heatmap-verification`,
    "--workdir", "/app/server", "rybbit-local-benchmark:workspace", "node", "/app/plans/heatmap-verification/fix-redis-index-services.mts", mode],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
  const result = JSON.parse(await readFile(new URL(`fix-redis-index-${mode}.json`, directory), "utf8"));
  assert.equal(result.passed, true, `Redis helper ${mode} failed`);
  evidence.checks.push(...result.checks);
  evidence.cleanup.push(...result.cleanup);
}
let failure;
try {
  for (const [key, domain] of [["siteId", state.hostname], ["foreignSiteId", state.foreignHostname]]) {
    const site = await call(`/organizations/${credentials.organizationId}/sites`, { domain, name: "Redis index local QA", blockBots: false, saltUserIds: false });
    state[key] = site.siteId;
    remaining.add(site.siteId);
  }
  await saveState();
  await helper("prepare");
  await call(`/sites/${state.siteId}/users/${encodeURIComponent(state.alice)}`, undefined, "DELETE");
  await helper("after-user-delete");
  await call(`/sites/${state.siteId}`, undefined, "DELETE");
  remaining.delete(state.siteId);
  await helper("after-site-delete");
  await call(`/sites/${state.foreignSiteId}`, undefined, "DELETE");
  remaining.delete(state.foreignSiteId);
  await helper("after-foreign-delete");
  evidence.passed = true;
} catch (error) {
  failure = error;
  evidence.failure = error.message;
} finally {
  for (const siteId of remaining) {
    try { await call(`/sites/${siteId}`, undefined, "DELETE"); evidence.cleanup.push({ siteId, removed: true }); }
    catch { evidence.cleanup.push({ siteId, removed: false }); evidence.passed = false; }
  }
  if (state.siteId && state.foreignSiteId) {
    try { await helper("cleanup"); }
    catch { evidence.cleanup.push({ knownRedisKeysRemoved: false }); evidence.passed = false; }
  }
  evidence.finishedAt = new Date().toISOString();
  await writeFile(new URL("fix-redis-index-evidence.json", directory), `${JSON.stringify(evidence, null, 2)}\n`);
}
console.log(JSON.stringify({ passed: evidence.passed, checks: evidence.checks.length, cleanup: evidence.cleanup }));
if (failure) throw failure;
assert.equal(evidence.passed, true);
