import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";

// Run after pnpm --filter rybbit-backend build:analytics:
// node plans/heatmap-verification/snapshot-browser.mjs
// Production browser bundles run against loopback fixtures; no deployed service
// or database is contacted, and captured DOM is never printed or saved.
const require = createRequire(new URL("../../server/package.json", import.meta.url));
const puppeteer = require("puppeteer");
const [trackerScript, snapshotScript] = await Promise.all([
  readFile(new URL("../../server/public/script.js", import.meta.url)),
  readFile(new URL("../../server/public/heatmap-snapshot.js", import.meta.url)),
]);
const buckets = [320, 375, 425, 768, 1024, 1440, 1920];
const bucketFor = width => buckets.reduce((nearest, bucket) =>
  Math.abs(bucket - width) < Math.abs(nearest - width) ? bucket : nearest
);
const batches = [];
const snapshots = [];
const runtimeErrors = [];
const serverErrors = [];
let snapshotAssetRequests = 0;
let origin;
let grant;
let nominatedPathname = "/fixture-next";
let cspBlocked = false;

function fixture() {
  return `<!doctype html><html><head>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>html,body,h1{margin:0;font:16px sans-serif}main{height:2000px}
  #target{position:fixed;top:20px;left:20px;width:150px;height:40px;background:rgb(23, 101, 211);z-index:2}
  #menu{position:fixed;inset:0;background:white;z-index:1}
  .fixture-style-marker{color:rgb(121, 23, 77)}</style></head><body>
  <main><h1 class="fixture-style-marker">Public initial route</h1>
    <div class="rr-block">fixture-blocked-private-content</div>
    <div class="rr-mask">fixture-masked-private-text</div>
    <div data-sensitive>fixture-selector-private-text</div>
    <input type="text" value="fixture-private-input-value">
    <input type="password" value="fixture-private-password-value">
    <input type="email" value="fixture-private-email@example.test">
    <textarea>fixture-private-textarea-value</textarea>
    <!-- fixture-private-comment-content -->
  </main><div id="menu" hidden>Fullscreen mobile menu</div>
  <button id="target" onclick="document.querySelector('#menu').hidden = false">Open menu</button>
  <script src="${origin}/api/script.js?siteId=browser-snapshot-fixture"
    data-replay-mask-text-selectors='["[data-sensitive]"]'></script>
  </body></html>`;
}

async function jsonBody(request) {
  let body = "";
  for await (const chunk of request) body += chunk;
  return { bytes: Buffer.byteLength(body), body: JSON.parse(body) };
}

const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, "http://127.0.0.1").pathname;
    if (path === "/api/script.js" || path === "/api/heatmap-snapshot.js") {
      if (path.endsWith("heatmap-snapshot.js")) snapshotAssetRequests++;
      response.writeHead(200, { "Content-Type": "text/javascript" });
      return response.end(path.endsWith("heatmap-snapshot.js") ? snapshotScript : trackerScript);
    }
    if (path.startsWith("/api/site/tracking-config/")) {
      response.writeHead(200, { "Content-Type": "application/json" });
      return response.end(JSON.stringify({
        heatmaps: true, heatmapSampleRate: 100, sessionReplay: false,
        trackInitialPageView: true, trackSpaNavigation: true, trackUrlParams: false,
        trackButtonClicks: false, webVitals: false, featureFlagsEnabled: false,
      }));
    }
    if (path.startsWith("/api/heatmaps/record/")) {
      const { body } = await jsonBody(request);
      assert.ok(body.events.length > 0, "Tracker submitted an empty interaction batch");
      assert.ok(body.events.every(event => event.documentHeight >= event.viewportHeight));
      batches.push(body);
      const latest = body.events.findLast(event => event.pathname === nominatedPathname);
      if (latest && !grant) {
        grant = {
          key: "loopback-background-key", token: "loopback-background-token",
          pageVisitId: latest.pageVisitId, hostname: latest.hostname,
          pathname: latest.pathname, bucket: bucketFor(latest.viewportWidth),
        };
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      // Repeat the grant to exercise client deduplication across later batches.
      return response.end(JSON.stringify({ success: true, ...(grant ? { snapshotRequest: grant } : {}) }));
    }
    if (path.startsWith("/api/heatmaps/snapshot/")) {
      snapshots.push(await jsonBody(request));
      response.writeHead(200, { "Content-Type": "application/json" });
      return response.end('{"success":true}');
    }
    if (path.startsWith("/api/")) {
      response.writeHead(200, { "Content-Type": "application/json" });
      return response.end('{"success":true}');
    }
    if (path === "/frame-probe") {
      response.writeHead(200, { "Content-Type": "text/html" });
      return response.end(`<!doctype html><iframe src="${origin}/fixture"></iframe>`);
    }
    response.writeHead(200, {
      "Content-Type": "text/html",
      "Content-Security-Policy": "frame-ancestors 'none'",
      "X-Frame-Options": "DENY",
    });
    response.end(fixture());
  } catch (error) {
    serverErrors.push(error.message);
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end('{"success":false}');
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
origin = `http://127.0.0.1:${server.address().port}`;
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function poll(predicate, label) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(40);
  }
  throw new Error(`Timed out: ${label}`);
}

let browser;
try {
  browser = await puppeteer.launch({ headless: true });
  const probe = await browser.newPage();
  probe.on("console", message => {
    if (message.type() === "error" && /frame-ancestors/.test(message.text())) cspBlocked = true;
  });
  await probe.goto(`${origin}/frame-probe`, { waitUntil: "networkidle0" });
  await poll(() => cspBlocked, "original page blocked by its frame-ancestors policy");
  assert.equal(snapshotAssetRequests, 0, "Blocked iframe unexpectedly loaded snapshot capture");
  await probe.close();

  const page = await browser.newPage();
  await page.setViewport({ width: 375, height: 500 });
  page.on("pageerror", error => runtimeErrors.push(error.message));
  const navigation = await page.goto(`${origin}/fixture`, { waitUntil: "networkidle0" });
  assert.equal(navigation.headers()["content-security-policy"], "frame-ancestors 'none'");
  await page.evaluate(() => new Promise(resolve => window.rybbit.onReady(() => resolve(true))));
  assert.equal(await page.evaluate(() => window.rybbit.isSessionReplayActive()), false);
  assert.equal(snapshotAssetRequests, 0, "Ordinary heatmap visitors loaded the snapshot library before nomination");
  assert.equal(snapshots.length, 0);

  await page.evaluate(() => {
    history.pushState({}, "", "/fixture-next?token=fixture-url-private-value");
    document.querySelector("h1").textContent = "Public next route";
    document.querySelector("main").style.height = "2200px";
  });
  await delay(250);
  await page.evaluate(() => window.scrollTo(0, 200));
  await poll(() => snapshots.length === 1, "nominated static DOM background upload");
  const uploaded = snapshots[0];
  const captured = uploaded.body;
  assert.equal(captured.pathname, "/fixture-next");
  assert.equal(captured.hostname, "127.0.0.1");
  assert.equal(captured.pageVisitId, grant.pageVisitId);
  assert.equal(captured.viewportWidth, 375);
  assert.equal(captured.viewportHeight, 500);
  assert.equal(captured.documentHeight, 2200);
  assert.ok(uploaded.bytes < 2 * 1024 * 1024, "Static snapshot exceeds its payload cap");
  assert.equal(captured.node.type, 0);
  const serialized = JSON.stringify(captured.node);
  for (const sentinel of [
    "fixture-blocked-private-content", "fixture-masked-private-text", "fixture-selector-private-text",
    "fixture-private-input-value", "fixture-private-password-value", "fixture-private-email@example.test",
    "fixture-private-textarea-value", "fixture-private-comment-content", "fixture-url-private-value",
  ]) assert.ok(!serialized.includes(sentinel), "Static snapshot exposed a private fixture sentinel");
  assert.ok(serialized.includes("Public next route"), "Static snapshot lost public route content");
  assert.ok(serialized.includes("121, 23, 77"), "Static snapshot lost stylesheet content");
  assert.ok(!serialized.includes('"tagName":"script"'), "Static snapshot retained a script node");
  assert.equal(snapshotAssetRequests, 1);

  const priorClickCount = batches.flatMap(batch => batch.events).filter(event => event.type === "click").length;
  await page.click("#target");
  await poll(() => batches.flatMap(batch => batch.events).filter(event => event.type === "click").length > priorClickCount,
    "second interaction batch repeating the grant");
  await delay(300);
  assert.equal(snapshots.length, 1, "A repeated grant uploaded a duplicate DOM background");
  assert.equal(snapshotAssetRequests, 1, "A repeated grant fetched another capture library");
  assert.ok(batches.every(batch => !Object.hasOwn(batch, "node")), "Ordinary batches include duplicate DOM snapshots");
  // A real trusted tap opens a full viewport menu before nomination. The DOM
  // must remain ineligible while the click itself is still delivered.
  grant = undefined;
  nominatedPathname = "/fixture-clicked";
  const batchesBeforeClick = batches.length;
  await page.goto(`${origin}/fixture-clicked`, { waitUntil: "networkidle0" });
  await page.evaluate(() => new Promise(resolve => window.rybbit.onReady(() => resolve(true))));
  await page.click("#target");
  assert.equal(await page.$eval("#menu", menu => menu.hidden), false);
  await poll(() => batches.slice(batchesBeforeClick).some(batch =>
    batch.events.some(event => event.type === "click" && event.pathname === "/fixture-clicked")),
    "mobile menu click delivery");
  assert.equal(grant.pathname, "/fixture-clicked", "Clicked page did not receive a matching nomination");
  await delay(300);
  assert.equal(snapshots.length, 1, "Clicked mobile page uploaded its fullscreen menu as a background");
  assert.equal(snapshotAssetRequests, 1, "Clicked mobile page loaded the snapshot library");
  assert.deepEqual(runtimeErrors, []);
  assert.deepEqual(serverErrors, []);
  console.log(JSON.stringify({
    passed: true, fixtureFramingBlockedByCsp: cspBlocked, replayDisabled: true,
    lazySnapshotAssetRequests: snapshotAssetRequests, standaloneUploads: snapshots.length,
    snapshotBytes: uploaded.bytes, pathname: captured.pathname,
    viewport: { width: captured.viewportWidth, height: captured.viewportHeight },
    document: { width: captured.documentWidth, height: captured.documentHeight },
    privacyMaskingVerified: true, blockedContentOmitted: true, stylesCaptured: true,
    repeatedGrantDeduplicated: true, clickedMobileMenuExcluded: true, ordinaryBatchesRemainCompact: true,
    runtimeErrors: runtimeErrors.length,
  }, null, 2));
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
