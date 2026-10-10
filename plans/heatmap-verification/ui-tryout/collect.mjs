import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { baseUrl, localAccount } from "../qa-support.mjs";
import { renderFixture } from "./fixture.mjs";

const require = createRequire(new URL("../../../server/package.json", import.meta.url));
const puppeteer = require("puppeteer");
const account = await localAccount();
const validationOnly = process.argv.includes("--validate-existing");
const evidenceFile = new URL("collection.json", import.meta.url);
const existing = validationOnly ? JSON.parse(await readFile(evidenceFile, "utf8")) : null;
const suffix = existing?.hostname.split(".")[0].slice("tryout-".length) || randomBytes(4).toString("hex");
const hostname = existing?.hostname || `tryout-${suffix}.heatmap.test`;
const { siteId } = existing || await account.call(`/organizations/${account.organizationId}/sites`, {
  domain: hostname, name: "Heatmap UI tryout", blockBots: false, saltUserIds: false,
});
if (!validationOnly) await account.call(`/sites/${siteId}/config`, { heatmaps: true, heatmapSampleRate: 100, sessionReplay: false, blockBots: false }, "PUT");
const evidence = existing || { siteId, hostname, paths: ["/", "/pricing"], widths: [375, 768, 1440], startedAt: new Date().toISOString(), collectionMethod: "Trusted Chromium clicks through the shipped public tracker; real authenticated report APIs", sessions: [], heatmapRequests: 0, ordinaryRequests: 0, rrwebRequests: 0, errors: [], status: "collecting" };
if (validationOnly) {
  evidence.previousValidationAttempts = [...(evidence.previousValidationAttempts || []), { status: evidence.status, errors: evidence.errors, reason: "The first assertion assumed identify() would erase the initial anonymous scroll visit. Revalidation inspects both unfiltered and identified sessions without collecting again." }];
  evidence.errors = [];
  evidence.status = "validating";
  for (const session of evidence.sessions) session.expectedHomeClicks = session.visit === 2 ? 14 : 12;
}
const save = () => writeFile(evidenceFile, JSON.stringify(evidence, null, 2));
await save();
console.log(`Fixture metadata ready: ${JSON.stringify({ siteId, hostname, paths: evidence.paths, widths: evidence.widths })}`);
const server = createServer((request, response) => { response.writeHead(200, { "Content-Type": "text/html" }); response.end(renderFixture(siteId, { tracking: true, path: request.url.split("?")[0] })); });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://${hostname}:${server.address().port}`;
if (!validationOnly) evidence.origin = origin;
await save();
const browser = await puppeteer.launch({ headless: true, args: [`--host-resolver-rules=MAP ${hostname} 127.0.0.1`, "--no-proxy-server"] });
async function click(page, selector, repeats, spread = 6) {
  const element = await page.$(`[data-qa="${selector}"]`);
  assert.ok(element, `Missing fixture selector ${selector}`);
  await element.evaluate(node => node.scrollIntoView({ block: "center" }));
  const box = await element.boundingBox();
  for (let index = 0; index < repeats; index++) {
    await page.mouse.click(box.x + box.width / 2 + (index % 3 - 1) * spread, box.y + box.height / 2 + (index % 2 ? 3 : -3));
    await new Promise(resolve => setTimeout(resolve, 75));
  }
}
try {
  for (const width of validationOnly ? [] : evidence.widths) {
    for (let visit = 0; visit < 3; visit++) {
      const context = await browser.createBrowserContext();
      const page = await context.newPage();
      await page.setViewport({ width, height: 700, deviceScaleFactor: 2 });
      const session = { width, visit, userId: `ui-tryout-${suffix}-${width}-${visit}`, expectedHomeClicks: visit === 0 ? 12 : 10, expectedPricingClicks: 3, batches: [], responseStatuses: [], errors: [] };
      const responses = [];
      page.on("pageerror", error => session.errors.push(error.message));
      page.on("console", message => { if (message.type() === "error") session.errors.push(message.text()); });
      page.on("request", request => {
        if (/rrweb|replay-recorder/i.test(request.url())) evidence.rrwebRequests++;
        if (request.method() !== "POST") return;
        if (new URL(request.url()).pathname === "/api/track") evidence.ordinaryRequests++;
        if (!request.url().includes("/heatmaps/record/")) return;
        const payload = request.postData() || "";
        assert.ok(!payload.includes("ui-tryout-private-input-sentinel") && !payload.includes("ui-tryout-private-query-sentinel") && !payload.includes("Start your workspace") && !payload.includes("Good work"), "Heatmap upload contains fixture text or private input/query data");
        evidence.heatmapRequests++;
        session.batches.push(JSON.parse(payload));
      });
      page.on("response", response => {
        if (response.request().method() === "POST" && response.url().includes("/heatmaps/record/")) {
          session.responseStatuses.push(response.status());
          responses.push(response.status());
        }
      });
      await page.goto(`${origin}/?private=ui-tryout-private-query-sentinel`, { waitUntil: "networkidle0" });
      await page.waitForFunction(() => window.rybbit?.getUserId);
      await page.evaluate(id => window.rybbit.identify(id), session.userId);
      await click(page, "hero-cta", visit === 0 ? 7 : 5);
      await click(page, "hero-demo", 3);
      await click(page, "nav-start", 2);
      if (visit > 0) {
        await click(page, "feature-projects", 2);
        session.expectedHomeClicks += 2;
        if (visit === 2) {
          await click(page, "pricing-start", 2);
          session.expectedHomeClicks += 2;
        }
      }
      // Persist different maximum depths from the real page geometry.
      session.geometry = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth, documentHeight: document.documentElement.scrollHeight }));
      const fraction = [0.45, 0.78, 1][visit];
      await page.evaluate(fraction => scrollTo(0, Math.max(0, document.documentElement.scrollHeight * fraction - innerHeight)), fraction);
      await new Promise(resolve => setTimeout(resolve, 600));
      const routeResponse = page.waitForResponse(response => {
        const request = response.request();
        if (request.method() !== "POST" || new URL(request.url()).pathname !== "/api/track") return false;
        const payload = JSON.parse(request.postData() || "{}");
        return payload.type === "pageview" && payload.pathname === "/pricing" && payload.user_id === session.userId;
      });
      await page.evaluate(() => { history.pushState({}, "", "/pricing"); scrollTo(0, 0); });
      assert.ok((await routeResponse).ok());
      await click(page, "hero-cta", 2);
      await click(page, "hero-demo", 1);
      await page.goto("about:blank");
      await new Promise(resolve => setTimeout(resolve, 700));
      assert.ok(session.batches.length > 0, "No actual public heatmap uploads");
      assert.ok(responses.every(status => status === 200), `Heatmap upload failed: ${responses}`);
      assert.deepEqual(session.errors, []);
      evidence.sessions.push(session);
      await save();
      console.log(`Collected ${width}px visit ${visit + 1}: ${session.batches.length} actual batches`);
      await context.close();
    }
  }
  evidence.reports = [];
  for (const width of evidence.widths) {
    for (const pathname of evidence.paths) {
      let clicks, scroll;
      for (let attempt = 0; attempt < 50; attempt++) {
        const params = new URLSearchParams({ past_minutes_start: "120", past_minutes_end: "0", time_zone: "UTC", hostname, pathname, bucket: String(width), mode: "click" });
        clicks = (await account.call(`/sites/${siteId}/heatmaps?${params}`)).data;
        params.set("mode", "scroll");
        scroll = (await account.call(`/sites/${siteId}/heatmaps?${params}`)).data;
        if (clicks.sessions === 3 && scroll.scroll.totalSessions >= 3) break;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      assert.equal(clicks.sessions, 3, `Expected three actual sessions at ${width} ${pathname}`);
      assert.ok(scroll.scroll.totalSessions >= 3);
      assert.equal(clicks.count, pathname === "/" ? 38 : 9);
      assert.ok(clicks.points.length >= (pathname === "/" ? 5 : 3));
      const identifiedParams = new URLSearchParams({ past_minutes_start: "120", past_minutes_end: "0", time_zone: "UTC", hostname, pathname, bucket: String(width), mode: "scroll", filters: JSON.stringify([{ parameter: "user_id", type: "contains", value: [`ui-tryout-${suffix}-`] }]) });
      const identifiedScroll = (await account.call(`/sites/${siteId}/heatmaps?${identifiedParams}`)).data;
      assert.equal(identifiedScroll.scroll.totalSessions, 3);
      evidence.reports.push({ width, pathname, clicks: clicks.count, sessions: clicks.sessions, points: clicks.points.length, scrollSessions: scroll.scroll.totalSessions, identifiedScrollSessions: identifiedScroll.scroll.totalSessions, scroll: scroll.scroll.histogram, background: clicks.background });
    }
  }
  assert.equal(evidence.rrwebRequests, 0);
  assert.ok(evidence.ordinaryRequests >= 18);
  evidence.status = "passed";
  evidence.finishedAt = new Date().toISOString();
  await save();
  console.log(JSON.stringify({ siteId, hostname, status: evidence.status, reports: evidence.reports, heatmapRequests: evidence.heatmapRequests, ordinaryRequests: evidence.ordinaryRequests, rrwebRequests: evidence.rrwebRequests }));
} catch (error) {
  evidence.status = "failed";
  evidence.errors.push(error.stack || String(error));
  await save();
  throw error;
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
