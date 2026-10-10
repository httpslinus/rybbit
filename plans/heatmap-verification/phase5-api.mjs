import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { baseUrl, localAccount } from "./qa-support.mjs";

// Uses the normal authenticated API and existing browser-collected samples.
// It never inserts analytics/heatmap rows or substitutes report responses.
const source = JSON.parse(await readFile(new URL("collection-evidence.json", import.meta.url), "utf8"));
const account = await localAccount();
assert.equal(account.siteId, source.siteId, "The API gate must use the collector's isolated QA site");
assert.equal(source.rrwebRequests, 0);
assert.ok(source.requests > 0);
assert.deepEqual(
  source.widths.map(row => row.width),
  [375, 768, 1440]
);

const evidence = {
  siteId: account.siteId,
  baseUrl,
  source: "Real trusted browser collection from collect-browser.mjs and collection-evidence.json",
  startedAt: new Date().toISOString(),
  sourceRequests: source.requests,
  sourceWidths: source.widths.map(row => row.width),
  steps: [],
  validation: [],
  cleanup: [],
  passed: false,
};
const cleanup = new Map();
const query = values =>
  new URLSearchParams(Object.entries(values).map(([key, value]) => [key, String(value)])).toString();
const window = { past_minutes_start: 120, past_minutes_end: 0, time_zone: "UTC" };
const selection = { mode: "click", hostname: "qa.heatmap.test", pathname: "/b", bucket: 375 };
const identifiedUser = { parameter: "user_id", type: "equals", value: ["responsive-375"] };
const trackedPath = { parameter: "pathname", type: "equals", value: ["/b"] };
const filters = value => JSON.stringify(value);
const summarize = data => ({ count: data.count, sessions: data.sessions, points: data.points });
const summarizePages = data =>
  data.pages
    .map(({ hostname, pathname, count, sessions }) => ({ hostname, pathname, count, sessions }))
    .sort((a, b) => `${a.hostname}${a.pathname}`.localeCompare(`${b.hostname}${b.pathname}`));
const pageCount = data => data.pages.reduce((total, page) => total + page.count, 0);
const reportPath = (extra = {}, siteId = account.siteId) =>
  `/sites/${siteId}/heatmaps?${query({ ...window, ...selection, ...extra })}`;
const report = async extra => (await account.call(reportPath(extra))).data;
const fail = async (name, path, body, method, status = 400) => {
  await assert.rejects(account.call(path, body, method), error => error.message.includes(`HTTP ${status} `), name);
  evidence.validation.push({ name, status });
};
const create = async (path, body, idField) => {
  const created = await account.call(path, body);
  assert.ok(Number.isInteger(created[idField]) && created[idField] > 0);
  cleanup.set(`${path}/${created[idField]}`, idField);
  return created;
};

try {
  const baseline = await report({ filters: filters([identifiedUser]) });
  assert.ok(
    baseline.count > 0,
    "responsive-375 /b samples left the 120-minute window; coordinate a real collector rerun"
  );
  assert.ok(baseline.points.length > 0);
  const ordinary = (
    await account.call(
      `/sites/${account.siteId}/sessions?${query({ ...window, filters: filters([identifiedUser]), limit: 100 })}`
    )
  ).data;
  assert.ok(ordinary.length > 0, "The historical cohort must derive membership from actual ordinary analytics");
  assert.ok(ordinary.every(session => session.identified_user_id === "responsive-375"));
  assert.ok(ordinary.some(session => session.pageviews >= 1));
  evidence.steps.push({
    name: "browser source and ordinary identified analytics",
    ...summarize(baseline),
    ordinarySessions: ordinary.map(({ pageviews, events }) => ({ pageviews, events })),
  });

  for (const type of ["contains", "starts_with", "regex"]) {
    const value = type === "regex" ? "^responsive-375$" : "responsive-375";
    const matching = await report({ filters: filters([{ parameter: "user_id", type, value: [value] }]) });
    assert.deepEqual(summarize(matching), summarize(baseline));
    evidence.steps.push({ name: `identified visitor ${type} matches real browser samples`, count: matching.count });
  }
  const canonicalZone = await report({ time_zone: "utc", filters: filters([identifiedUser]) });
  assert.deepEqual(summarize(canonicalZone), summarize(baseline));
  evidence.steps.push({ name: "canonicalized IANA report timezone preserves real counts", count: canonicalZone.count });
  await fail("fixed-offset report timezone is rejected before SQL", reportPath({ time_zone: "+01:00" }));

  const day = new Date().toISOString().slice(0, 10);
  const definition = {
    name: "Phase5 responsive-375",
    startDate: day,
    endDate: day,
    timeZone: "UTC",
    filters: [identifiedUser, trackedPath],
  };
  const primary = await create(`/sites/${account.siteId}/cohorts`, definition, "cohortId");
  assert.equal(primary.siteId, account.siteId);
  assert.equal(primary.canEdit, true);
  assert.deepEqual(primary.filters, definition.filters);
  const primaryPath = `/sites/${account.siteId}/cohorts/${primary.cohortId}`;
  const fetched = await account.call(primaryPath);
  assert.deepEqual(fetched, primary);
  const listed = await account.call(`/sites/${account.siteId}/cohorts`);
  assert.ok(listed.some(cohort => cohort.cohortId === primary.cohortId && cohort.canEdit));
  const updated = await account.call(primaryPath, { name: "Phase5 responsive-375 renamed" }, "PUT");
  assert.equal(updated.name, "Phase5 responsive-375 renamed");
  assert.equal(updated.startDate, day);
  assert.equal(updated.endDate, day);
  assert.deepEqual(updated.filters, definition.filters);
  const cohort = await report({ cohort_id: primary.cohortId });
  assert.equal(cohort.cohort.members, 1);
  assert.equal(cohort.cohort.name, updated.name);
  assert.deepEqual(summarize(cohort), summarize(baseline));
  evidence.steps.push({
    name: "cohort create/read/list/update and identified membership",
    members: cohort.cohort.members,
    count: cohort.count,
    sessions: cohort.sessions,
  });
  const canonicalDefinition = await account.call(primaryPath, { timeZone: "utc" }, "PUT");
  assert.equal(canonicalDefinition.timeZone, "UTC");
  await fail("fixed-offset cohort timezone is rejected", `/sites/${account.siteId}/cohorts`, { ...definition, timeZone: "+01:00" }, "POST");
  await fail("fixed-offset cohort update is rejected", primaryPath, { timeZone: "-05:00" }, "PUT");
  await fail("year-zero cohort date is rejected before Postgres", `/sites/${account.siteId}/cohorts`, { ...definition, startDate: "0000-01-01" }, "POST");

  await fail(
    "one-sided update cannot reverse the stored window",
    primaryPath,
    { startDate: `${Number(day.slice(0, 4)) + 1}${day.slice(4)}` },
    "PUT"
  );
  await fail(
    "stored invalid calendar date",
    `/sites/${account.siteId}/cohorts`,
    { ...definition, startDate: "2026-02-31" },
    "POST"
  );
  await fail(
    "stored invalid timezone",
    `/sites/${account.siteId}/cohorts`,
    { ...definition, timeZone: "Mars/Olympus" },
    "POST"
  );
  await fail(
    "stored spoofed site field",
    `/sites/${account.siteId}/cohorts`,
    { ...definition, siteId: account.siteId + 1 },
    "POST"
  );

  const expired = await create(
    `/sites/${account.siteId}/cohorts`,
    { ...definition, name: "Phase5 expired history", startDate: "2000-01-01", endDate: "2000-01-31" },
    "cohortId"
  );
  const expiredReport = await report({ cohort_id: expired.cohortId });
  assert.equal(expiredReport.cohort.members, 0);
  assert.equal(expiredReport.count, 0);
  assert.equal(expiredReport.sessions, 0);
  assert.deepEqual(expiredReport.pages, []);
  assert.deepEqual(expiredReport.points, []);
  evidence.steps.push({ name: "empty retained historical cohort remains empty", members: 0, count: 0, pages: 0 });

  const segment = await create(
    `/sites/${account.siteId}/segments`,
    { name: "Phase5 required responsive-375", filters: [identifiedUser] },
    "segmentId"
  );
  const directAll = await report({ filters: filters([identifiedUser, trackedPath]), match: "all" });
  const directAny = await report({ filters: filters([identifiedUser, trackedPath]), match: "any" });
  assert.ok(
    pageCount(directAny) > pageCount(directAll),
    "ANY must also include other actual responsive visitors' /b clicks"
  );
  const segmentAny = await report({
    segment_id: segment.segmentId,
    match: "any",
    filters: filters([trackedPath, { ...identifiedUser, value: ["responsive-768"] }]),
  });
  assert.deepEqual(summarizePages(segmentAny), summarizePages(directAll));
  assert.deepEqual(summarize(segmentAny), summarize(directAll));
  const disjointAny = await report({
    segment_id: segment.segmentId,
    match: "any",
    filters: filters([
      { ...identifiedUser, value: ["responsive-768"] },
      { ...identifiedUser, value: ["responsive-1440"] },
    ]),
  });
  assert.equal(disjointAny.count, 0);
  assert.deepEqual(disjointAny.pages, []);
  const copiedSegmentAny = await report({
    segment_id: segment.segmentId,
    match: "any",
    filters: filters([
      identifiedUser,
      { parameter: "event_name", type: "equals", value: ["phase5-never-recorded-event"] },
    ]),
  });
  assert.equal(copiedSegmentAny.count, 0);
  assert.deepEqual(copiedSegmentAny.pages, []);
  evidence.steps.push({
    name: "all/any and required saved segment group",
    allPageClicks: pageCount(directAll),
    anyPageClicks: pageCount(directAny),
    segmentPageClicks: pageCount(segmentAny),
    disjointSegmentClicks: 0,
    copiedSegmentClicks: 0,
  });

  const pageviews = await report({ filters: filters([identifiedUser]), analytics_event_type: "pageview" });
  assert.deepEqual(summarize(pageviews), summarize(baseline));
  const customEvents = await report({ filters: filters([identifiedUser]), analytics_event_type: "custom_event" });
  if (ordinary.every(session => session.events === 0)) assert.equal(customEvents.count, 0);
  else assert.ok(customEvents.count <= baseline.count);
  const nonBounce = await report({ filters: filters([identifiedUser]), exclude_bounce: "true" });
  assert.ok(nonBounce.count <= baseline.count);
  if (ordinary.every(session => session.pageviews <= 1)) assert.equal(nonBounce.count, 0);
  if (ordinary.every(session => session.pageviews > 1)) assert.deepEqual(summarize(nonBounce), summarize(baseline));
  evidence.steps.push({
    name: "analytics event type and bounce exclusion use ordinary sessions",
    pageviewClicks: pageviews.count,
    customEventClicks: customEvents.count,
    nonBounceClicks: nonBounce.count,
    ordinaryPageviews: ordinary.map(session => session.pageviews),
  });

  const temporary = await account.call(`/organizations/${account.organizationId}/sites`, {
    domain: `phase5-${randomBytes(6).toString("hex")}.heatmap.test`,
    name: "Phase5 cross-site denial",
    blockBots: false,
  });
  assert.ok(temporary.siteId !== account.siteId);
  cleanup.set(`/sites/${temporary.siteId}`, "siteId");
  await fail(
    "same-org cross-site cohort report",
    reportPath({ cohort_id: primary.cohortId }, temporary.siteId),
    undefined,
    "GET",
    404
  );
  await fail("cross-site cohort read", `/sites/${temporary.siteId}/cohorts/${primary.cohortId}`, undefined, "GET", 404);
  await fail(
    "cross-site cohort update",
    `/sites/${temporary.siteId}/cohorts/${primary.cohortId}`,
    { name: "Forbidden change" },
    "PUT",
    404
  );
  await fail(
    "cross-site saved segment report",
    reportPath({ segment_id: segment.segmentId }, temporary.siteId),
    undefined,
    "GET",
    404
  );
  evidence.steps.push({ name: "same organization never widens cohort or segment site ownership", deniedStatus: 404 });

  for (const [name, extra] of [
    ["invalid match", { match: "some" }],
    ["invalid analytics event type", { analytics_event_type: "click" }],
    ["invalid bounce boolean", { exclude_bounce: "1" }],
    ["invalid cohort ID", { cohort_id: "-1" }],
    ["invalid width bucket", { bucket: "376" }],
    ["unknown filter field", { filters: filters([{ parameter: "session_id", type: "equals", value: ["any"] }]) }],
    ["invalid regex", { filters: filters([{ parameter: "pathname", type: "regex", value: ["(unclosed"] }]) }],
  ])
    await fail(name, reportPath(extra), undefined, "GET");
  await fail("unbounded report", `/sites/${account.siteId}/heatmaps`, undefined, "GET");
  await fail(
    "invalid calendar report",
    `/sites/${account.siteId}/heatmaps?${query({ start_date: "2026-02-30", end_date: "2026-03-01", time_zone: "UTC" })}`,
    undefined,
    "GET"
  );

  await account.call(primaryPath, {}, "DELETE");
  cleanup.delete(primaryPath);
  await fail("deleted cohort is absent", primaryPath, undefined, "GET", 404);
  assert.ok(!(await account.call(`/sites/${account.siteId}/cohorts`)).some(row => row.cohortId === primary.cohortId));
  evidence.steps.push({ name: "cohort delete and list removal", deleted: true });
  evidence.passed = true;
} catch (error) {
  evidence.failure = { name: error.name, message: error.message };
  throw error;
} finally {
  const errors = [];
  for (const [path, kind] of [...cleanup].reverse()) {
    try {
      await account.call(path, {}, "DELETE");
      evidence.cleanup.push({ kind, path, success: true });
    } catch (error) {
      errors.push(error);
      evidence.cleanup.push({ kind, path, success: false, message: error.message });
    }
  }
  evidence.finishedAt = new Date().toISOString();
  if (errors.length) evidence.passed = false;
  await writeFile(new URL("phase5-api-evidence.json", import.meta.url), JSON.stringify(evidence, null, 2));
  if (errors.length) throw new AggregateError(errors, "Only harness-created objects failed cleanup");
}
console.log(
  JSON.stringify({
    siteId: evidence.siteId,
    passed: evidence.passed,
    steps: evidence.steps.length,
    validations: evidence.validation.length,
    cleanup: evidence.cleanup.length,
  })
);
