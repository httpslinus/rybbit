import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { baseUrl, localAccount, responsiveFixture } from "./qa-support.mjs";

const require = createRequire(new URL("../../server/package.json", import.meta.url));
const puppeteer = require("puppeteer");
const account = await localAccount();
const suffix = randomBytes(5).toString("hex");
const hostname = `replay-${suffix}.heatmap.test`;
const identifiedUser = `replay-regression-${suffix}`;
const evidence = {
  source: "Trusted real browser clicks and rrweb recorder, normal ingestion/read APIs",
  startedAt: new Date().toISOString(),
  steps: [],
  replayUploads: [],
  ordinaryUploads: [],
  heatmapUploads: [],
  rrwebRequests: 0,
  runtimeErrors: [],
  consoleErrors: [],
  passed: false,
};
try {
  const previous = JSON.parse(await readFile(new URL("browser-regressions-evidence.json", import.meta.url), "utf8"));
  const { interruptedRuns = [], previousAttempts = [], ...attempt } = previous;
  evidence.interruptedRuns = interruptedRuns;
  evidence.previousAttempts = previous.startedAt ? [...previousAttempts, attempt] : previousAttempts;
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
let siteId, server, browser;
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function progress(stage) {
  evidence.stage = stage;
  await writeFile(new URL("browser-regressions-evidence.json", import.meta.url), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ stage, siteId }));
}

async function poll(read, matches, description) {
  const deadline = Date.now() + 30_000;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (matches(value)) return value;
    await delay(200);
  }
  throw new Error(`Normal API did not persist ${description}: ${JSON.stringify(value)}`);
}

try {
  const site = await account.call(`/organizations/${account.organizationId}/sites`, {
    domain: hostname,
    name: `Replay/button browser QA ${suffix}`,
    blockBots: false,
    saltUserIds: false,
  });
  siteId = evidence.siteId = site.siteId;
  await progress("own temporary site created");
  await account.call(
    `/sites/${siteId}/config`,
    { sessionReplay: true, trackButtonClicks: true, heatmaps: true, heatmapSampleRate: 100, blockBots: false },
    "PUT"
  );
  const configured = await account.call(`/sites/${siteId}`);
  assert.equal(configured.sessionReplay, true);
  assert.equal(configured.trackButtonClicks, true);
  assert.equal(configured.heatmaps, true);
  await progress("tracker configuration verified");
  let fixture = responsiveFixture(siteId, { tracking: true })
    .replace('data-qa="target"', 'data-qa="target" data-rybbit-prop-source="browser-regression"')
    .replace(
      "<input value=",
      '<button id="custom" data-rybbit-event="qa_regression_custom" style="position:absolute;top:920px;left:40px">Custom regression</button><input value='
    )
    .replace('data-debug="true"', 'data-debug="true" data-replay-sample-rate="100" data-replay-batch-interval="1000"');
  server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(fixture);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://${hostname}:${server.address().port}`;
  browser = await puppeteer.launch({
    headless: true,
    args: [`--host-resolver-rules=MAP ${hostname} 127.0.0.1`, "--no-proxy-server"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  // Begin this isolated fixture with one stable QA identity, so its full
  // snapshot and subsequent real interactions belong to the same replay.
  await page.evaluateOnNewDocument(
    (id, fixtureHostname) => {
      if (location.hostname === fixtureHostname) localStorage.setItem("rybbit-user-id", id);
    },
    identifiedUser,
    hostname
  );
  page.on("pageerror", error => evidence.runtimeErrors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error") evidence.consoleErrors.push(message.text());
  });
  page.on("request", request => {
    if (request.url().endsWith("/replay.js")) evidence.rrwebRequests++;
  });
  page.on("response", response => {
    const request = response.request();
    if (request.method() !== "POST") return;
    const url = new URL(response.url());
    const target =
      url.pathname === "/api/track"
        ? evidence.ordinaryUploads
        : url.pathname.includes("/session-replay/record/")
          ? evidence.replayUploads
          : url.pathname.includes("/heatmaps/record/")
            ? evidence.heatmapUploads
            : null;
    if (!target) return;
    // Read the actual request geometry and acknowledged HTTP status. Puppeteer
    // response.json() can remain pending when an unload beacon's frame goes
    // away. Persistence is verified separately through the normal read APIs.
    {
      const payload = JSON.parse(request.postData());
      if (target === evidence.heatmapUploads) {
        const raw = JSON.stringify(payload);
        assert.ok(
          !raw.includes("Sensitive DOM sentinel") &&
            !raw.includes("sensitive-input-sentinel") &&
            !raw.includes("private-query-sentinel")
        );
        target.push({
          status: response.status(),
          events: payload.events.length,
          types: [...new Set(payload.events.map(event => event.type))],
        });
      } else if (target === evidence.replayUploads) {
        target.push({
          status: response.status(),
          userId: payload.userId,
          events: payload.events.length,
          types: [...new Set(payload.events.map(event => event.type))],
        });
      } else {
        target.push({
          status: response.status(),
          type: payload.type,
          pathname: payload.pathname,
          eventName: payload.event_name,
          properties: payload.properties ? JSON.parse(payload.properties) : undefined,
        });
      }
    }
  });
  await page.goto(`${origin}/a?private=private-query-sentinel`, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => window.rybbit?.isSessionReplayActive());
  await progress("real rrweb recorder active");
  await page.evaluate(id => window.rybbit.identify(id), identifiedUser);
  await page.evaluate(() => window.scrollTo(0, 600));
  await page.click('[data-qa="target"]');
  await page.click("#custom");
  await page.waitForFunction(() => new Promise(resolve => setTimeout(resolve, 1100)).then(() => true));
  await page.click('[data-qa="target"]');
  const spaResponse = page.waitForResponse(response => {
    if (new URL(response.url()).pathname !== "/api/track" || response.request().method() !== "POST") return false;
    const payload = JSON.parse(response.request().postData());
    return payload.type === "pageview" && payload.pathname === "/b";
  });
  await page.evaluate(() => history.pushState({}, "", "/b"));
  assert.equal((await spaResponse).status(), 200);
  await progress("trusted clicks and SPA pageview captured");
  await page.evaluate(() => window.rybbit.stopSessionReplay());
  await progress("real recorder stopped");
  await poll(
    async () => evidence.replayUploads,
    rows => rows.some(row => row.status === 200 && row.events > 0),
    "real rrweb upload"
  );
  await page.goto("about:blank", { waitUntil: "domcontentloaded", timeout: 10_000 });
  await progress("real recorder uploads observed");
  const time = "past_minutes_start=10&past_minutes_end=0&time_zone=UTC";
  const events = (
    await poll(
      () => account.call(`/sites/${siteId}/events?${time}&page_size=100`),
      result =>
        result.data.filter(event => event.type === "button_click").length >= 2 &&
        result.data.some(event => event.event_name === "qa_regression_custom") &&
        result.data.some(
          event => event.type === "pageview" && event.pathname === "/b" && event.identified_user_id === identifiedUser
        ),
      "button and declarative custom events"
    )
  ).data;
  const buttons = events.filter(event => event.type === "button_click");
  assert.ok(buttons.length >= 2);
  assert.ok(buttons.every(event => event.event_name === ""));
  assert.ok(
    buttons.some(event => {
      const properties = JSON.parse(event.properties);
      return properties.text === "Sensitive DOM sentinel" && properties.source === "browser-regression";
    })
  );
  assert.ok(
    events.some(
      event => event.type === "pageview" && event.pathname === "/b" && event.identified_user_id === identifiedUser
    )
  );
  evidence.steps.push({
    check: "Trusted automatic button capture and declarative custom event remain separate",
    buttons: buttons.length,
    customEvents: events.filter(event => event.event_name === "qa_regression_custom").length,
    spaPageviews: events.filter(event => event.type === "pageview" && event.pathname === "/b").length,
  });
  const list = (
    await poll(
      () => account.call(`/sites/${siteId}/session-replay/list?${time}&minDuration=0`),
      result => result.data.some(replay => replay.event_count > 0),
      "replay list metadata"
    )
  ).data;
  const replay = list.find(row => row.identified_user_id === identifiedUser) ?? list[0];
  const read = await account.call(`/sites/${siteId}/session-replay/${encodeURIComponent(replay.session_id)}`);
  assert.ok(read.events.some(event => Number(event.type) === 2));
  assert.ok(read.events.some(event => Number(event.type) === 3));
  assert.ok(read.metadata.event_count > 0 && read.metadata.screen_width > 0 && read.metadata.screen_height > 0);
  assert.equal(read.metadata.hostname, hostname);
  assert.equal(Number(read.metadata.has_replay_data), 1);
  assert.ok(!JSON.stringify(read.events).includes("sensitive-input-sentinel"), "Replay input masking regressed");
  const heatmap = (
    await poll(
      () => account.call(`/sites/${siteId}/heatmaps?${time}&mode=click&hostname=${hostname}&pathname=%2Fa&bucket=1440`),
      result => result.data.count >= 3,
      "coexisting compact heatmap clicks"
    )
  ).data;
  evidence.steps.push({
    check: "Real rrweb script/upload/list/read and compact heatmaps coexist",
    rrwebRequests: evidence.rrwebRequests,
    replayUploads: evidence.replayUploads.length,
    eventCount: read.events.length,
    hasFullSnapshot: true,
    hasIncrementalSnapshot: true,
    maskedInput: true,
    heatmapClicks: heatmap.count,
    metadata: {
      event_count: read.metadata.event_count,
      screen_width: read.metadata.screen_width,
      screen_height: read.metadata.screen_height,
      hostname: read.metadata.hostname,
    },
  });
  assert.ok(evidence.rrwebRequests > 0 && evidence.replayUploads.every(row => row.status === 200));
  assert.ok(evidence.ordinaryUploads.every(row => row.status === 200));
  assert.ok(evidence.heatmapUploads.every(row => row.status === 200));
  assert.deepEqual(evidence.runtimeErrors, []);
  evidence.passed = true;
} catch (error) {
  evidence.failure = { name: error.name, message: error.message };
  throw error;
} finally {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
  if (siteId) {
    try {
      await account.call(`/sites/${siteId}`, undefined, "DELETE");
      evidence.cleanup = { siteId, success: true };
    } catch (error) {
      evidence.cleanup = { siteId, success: false, message: error.message };
      evidence.passed = false;
    }
  }
  evidence.finishedAt = new Date().toISOString();
  await writeFile(new URL("browser-regressions-evidence.json", import.meta.url), JSON.stringify(evidence, null, 2));
}
assert.ok(evidence.passed, "Regression or cleanup failed");
console.log(
  JSON.stringify({
    passed: true,
    steps: evidence.steps.length,
    rrwebRequests: evidence.rrwebRequests,
    replayUploads: evidence.replayUploads.length,
    heatmapUploads: evidence.heatmapUploads.length,
  })
);
