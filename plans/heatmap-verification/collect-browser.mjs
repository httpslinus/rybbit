import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { localAccount, startFixtureServer } from "./qa-support.mjs";

const require = createRequire(new URL("../../server/package.json", import.meta.url));
const puppeteer = require("puppeteer");
const account = await localAccount();
const initial = await account.call(`/sites/${account.siteId}`);
assert.equal(initial.sessionReplay, false);
await account.call(
  `/sites/${account.siteId}/config`,
  { heatmaps: true, heatmapSampleRate: 100, blockBots: false, sessionReplay: false },
  "PUT"
);
const fixture = await startFixtureServer(account.siteId);
const browser = await puppeteer.launch({
  headless: true,
  args: ["--host-resolver-rules=MAP qa.heatmap.test 127.0.0.1", "--no-proxy-server"],
});
const evidence = {
  siteId: account.siteId,
  startedAt: new Date().toISOString(),
  widths: [],
  requests: 0,
  ordinaryAnalyticsRequests: 0,
  rrwebRequests: 0,
};
try {
  for (const width of [375, 768, 1440]) {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.setViewport({ width, height: 600, deviceScaleFactor: 2 });
    const batches = [];
    const errors = [];
    page.on("console", message => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", error => errors.push(error.message));
    page.on("requestfailed", request =>
      errors.push(`${request.url().split("?", 1)[0]}: ${request.failure()?.errorText}`)
    );
    page.on("request", request => {
      if (/rrweb|replay-recorder/i.test(request.url())) evidence.rrwebRequests++;
      if (request.method() === "POST" && request.url().includes("/heatmaps/record/")) {
        const body = request.postData();
        assert.ok(
          body &&
            !body.includes("Sensitive DOM sentinel") &&
            !body.includes("sensitive-input-sentinel") &&
            !body.includes("sensitive-query-sentinel")
        );
        batches.push(JSON.parse(body));
        evidence.requests++;
      }
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/track")
        evidence.ordinaryAnalyticsRequests++;
    });
    await page.goto(`${fixture.origin}/a?private=sensitive-query-sentinel`, { waitUntil: "networkidle0" });
    await page
      .waitForFunction(() => window.rybbit && window.rybbit.getUserId)
      .catch(() => {
        throw new Error(`Recorder initialization failed: ${errors.join(" | ")}`);
      });
    await page.evaluate(id => window.rybbit.identify(id), `responsive-${width}`);
    await page.evaluate(() => window.scrollTo(0, 600));
    const target = await page.$("[data-qa=target]");
    const rectangle = await target.boundingBox();
    const x = rectangle.x + rectangle.width / 2;
    const y = rectangle.y + rectangle.height / 2;
    await page.mouse.click(x, y);
    await page.evaluate(() => window.scrollTo(0, 1400));
    await page.waitForFunction(() => window.scrollY === 1400);
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 250)));
    // The ordinary tracker debounces SPA pageviews. Await its actual request
    // before leaving, so cohort/event/bounce checks have real analytics metadata.
    const ordinaryRouteResponse = page.waitForResponse(response => {
      const request = response.request();
      if (request.method() !== "POST" || new URL(request.url()).pathname !== "/api/track") return false;
      const body = JSON.parse(request.postData() || "{}");
      return body.type === "pageview" && body.pathname === "/b" && body.user_id === `responsive-${width}`;
    });
    await page.evaluate(() => {
      history.pushState({}, "", "/b");
      window.scrollTo(0, 0);
    });
    await page.waitForFunction(() => location.pathname === "/b");
    await page.waitForFunction(() => window.scrollY === 0);
    await page.evaluate(() => window.scrollTo(0, 600));
    await target.click();
    const ordinaryResponse = await ordinaryRouteResponse;
    assert.ok(ordinaryResponse.ok(), `Ordinary SPA pageview failed: HTTP ${ordinaryResponse.status()}`);
    await page.goto("about:blank");
    // The recorder's keepalive upload can finish after the old document closes.
    const deadline = Date.now() + 15_000;
    let data;
    while (Date.now() < deadline) {
      data = (
        await account.call(
          `/sites/${account.siteId}/heatmaps?past_minutes_start=60&past_minutes_end=0&mode=click&hostname=qa.heatmap.test&pathname=%2Fa&bucket=${width}`
        )
      ).data;
      if (data.points.some(point => Math.abs(point.x - x) < 0.01 && Math.abs(point.y - (y + 600)) < 0.01)) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.ok(
      data?.points.some(point => Math.abs(point.x - x) < 0.01 && Math.abs(point.y - (y + 600)) < 0.01),
      `No recorded point at width ${width}; browser errors: ${errors.join(" | ")}`
    );
    const scroll = (
      await account.call(
        `/sites/${account.siteId}/heatmaps?past_minutes_start=60&past_minutes_end=0&mode=scroll&hostname=qa.heatmap.test&pathname=%2Fa&bucket=${width}`
      )
    ).data;
    assert.ok(scroll.scroll.histogram.find(band => band.depth === 100)?.reach >= 1);
    const ordinaryQuery = new URLSearchParams({
      past_minutes_start: "120",
      past_minutes_end: "0",
      time_zone: "UTC",
      filters: JSON.stringify([
        { parameter: "user_id", type: "equals", value: [`responsive-${width}`] },
        { parameter: "pathname", type: "equals", value: ["/b"] },
      ]),
    });
    const ordinaryDeadline = Date.now() + 30_000;
    let ordinarySessions = [];
    while (Date.now() < ordinaryDeadline) {
      ordinarySessions = (await account.call(`/sites/${account.siteId}/sessions?${ordinaryQuery}`)).data;
      if (
        ordinarySessions.some(session => session.identified_user_id === `responsive-${width}` && session.pageviews >= 1)
      )
        break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.ok(
      ordinarySessions.some(session => session.identified_user_id === `responsive-${width}` && session.pageviews >= 1),
      `Ordinary identified /b analytics did not persist at ${width}`
    );
    evidence.widths.push({
      width,
      x,
      pageY: y + 600,
      count: data.count,
      sessions: data.sessions,
      batches: batches.length,
      scrollSessions: scroll.scroll.totalSessions,
      ordinaryRouteStatus: ordinaryResponse.status(),
      ordinaryIdentifiedSessions: ordinarySessions.length,
      ordinaryPageviews: ordinarySessions.reduce((total, session) => total + session.pageviews, 0),
    });
    await context.close();
  }
  assert.ok(evidence.requests > 0);
  assert.equal(evidence.rrwebRequests, 0);
  assert.ok(evidence.ordinaryAnalyticsRequests >= 6);
  evidence.finishedAt = new Date().toISOString();
  await writeFile(new URL("collection-evidence.json", import.meta.url), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  await browser.close();
  await fixture.close();
}
