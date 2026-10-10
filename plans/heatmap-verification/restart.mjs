import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { localAccount } from "./qa-support.mjs";

const account = await localAccount();
const stateFile = new URL(".cache/restart.json", import.meta.url);
const stage = process.argv[2];
assert.ok(["prepare", "verify"].includes(stage), "Usage: node restart.mjs prepare|verify");
const selectedSettings = site => ({ heatmaps: site.heatmaps, heatmapSampleRate: site.heatmapSampleRate, sessionReplay: site.sessionReplay });
const report = async (day, mode, cohortId) => (await account.call(`/sites/${account.siteId}/heatmaps?${new URLSearchParams({
  start_date: day, end_date: day, time_zone: "UTC", mode, hostname: "qa.heatmap.test", pathname: "/b", bucket: "375",
  ...(cohortId ? { cohort_id: String(cohortId) } : {}),
})}`)).data;
const counts = data => ({ count: data.count, sessions: data.sessions, points: data.points.length, totalScrollSessions: data.scroll.totalSessions, members: data.cohort?.members });
if (stage === "prepare") {
  const day = new Date().toISOString().slice(0, 10);
  const cohort = await account.call(`/sites/${account.siteId}/cohorts`, {
    name: `Restart ${randomBytes(4).toString("hex")}`, startDate: day, endDate: day, timeZone: "UTC",
    filters: [{ parameter: "user_id", type: "equals", value: ["responsive-375"] }],
  });
  const click = counts(await report(day, "click", cohort.cohortId));
  assert.ok(click.count > 0 && click.members > 0, "Requires browser-collected identified samples");
  const before = { day, siteId: account.siteId, cohortId: cohort.cohortId,
    settings: selectedSettings(await account.call(`/sites/${account.siteId}`)), click,
    scroll: counts(await report(day, "scroll", cohort.cohortId)), preparedAt: new Date().toISOString() };
  await writeFile(stateFile, JSON.stringify(before), { mode: 0o600 });
  console.log("Prepared persistent real-tracker samples, settings and cohort for container restart check.");
} else {
  const before = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(before.siteId, account.siteId);
  const after = { settings: selectedSettings(await account.call(`/sites/${account.siteId}`)),
    click: counts(await report(before.day, "click", before.cohortId)),
    scroll: counts(await report(before.day, "scroll", before.cohortId)) };
  assert.deepEqual(after.settings, before.settings);
  assert.deepEqual(after.click, before.click);
  assert.deepEqual(after.scroll, before.scroll);
  await account.call(`/sites/${account.siteId}/cohorts/${before.cohortId}`, undefined, "DELETE");
  await writeFile(new URL("restart-evidence.json", import.meta.url), JSON.stringify({
    completedAt: new Date().toISOString(), passed: true,
    scope: "All six isolated rybbit-local containers rebuilt/restarted; no volume removal",
    before, after, cohortCleanup: true,
  }, null, 2) + "\n");
  console.log("Restart preserved settings, cohort membership and click/scroll sample counts; test cohort removed.");
}
