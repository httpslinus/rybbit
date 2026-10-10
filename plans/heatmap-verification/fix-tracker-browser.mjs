import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";

// Uses the freshly built browser asset and a private loopback fixture. Uploads
// stay in this process; no database, account or production site is involved.
const require = createRequire(new URL("../../server/package.json", import.meta.url));
const puppeteer = require("puppeteer");
const script = await readFile(new URL("../../server/public/script.js", import.meta.url));
const uploads = [];
const pendingResponses = new Set();
let holdNormalUpload = false;
let origin;
const evidence = { startedAt: new Date().toISOString(), checks: [], runtimeErrors: [], passed: false };

function fixture() {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
  <style>html,body{margin:0}main{height:2000px}button{position:fixed;left:30px;top:30px;width:120px;height:40px}</style>
  </head><body><main id="content">Old route</main><button id="target">Capture click</button>
  <script>
    window.navigateSlowly = (path, delay) => {
      history.pushState({}, '', path);
      setTimeout(() => {
        const main = document.getElementById('content');
        main.textContent = 'New route'; main.style.height = '4000px';
        scrollTo(0, 0);
      }, delay);
    };
  </script><script src="${origin}/api/script.js" data-site-id="fix-fixture" data-debug="true"></script>
  </body></html>`;
}

const server = createServer(async (request, response) => {
  if (request.url.startsWith("/api/script.js")) {
    response.writeHead(200, { "Content-Type": "text/javascript" });
    return response.end(script);
  }
  if (request.url.startsWith("/api/site/tracking-config/")) {
    response.writeHead(200, { "Content-Type": "application/json" });
    return response.end(JSON.stringify({ heatmaps: true, heatmapSampleRate: 100,
      trackInitialPageView: true, trackSpaNavigation: true, sessionReplay: false,
      featureFlagsEnabled: false, trackButtonClicks: false, webVitals: false }));
  }
  if (request.url.startsWith("/api/heatmaps/record/")) {
    let body = "";
    for await (const chunk of request) body += chunk;
    uploads.push({ receivedAt: Date.now(), batch: JSON.parse(body) });
    if (holdNormalUpload && !pendingResponses.size) {
      pendingResponses.add(response);
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    return response.end('{"success":true}');
  }
  if (request.url.startsWith("/api/")) {
    response.writeHead(200, { "Content-Type": "application/json" });
    return response.end('{"success":true}');
  }
  if (request.url === "/away") {
    response.writeHead(200, { "Content-Type": "text/html" });
    return response.end("<!doctype html><title>Away</title>");
  }
  response.writeHead(200, { "Content-Type": "text/html" });
  response.end(fixture());
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function poll(predicate, label) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(50);
  }
  throw new Error(`Timed out: ${label}`);
}
const events = () => {
  const logical = new Map();
  for (const { batch } of uploads) {
    batch.events.forEach((event, index) => logical.set(`${batch.batchId}:${index}`, event));
  }
  return [...logical.values()];
};

try {
  browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 375, height: 500 });
  page.on("pageerror", error => evidence.runtimeErrors.push(error.message));
  await page.goto(`${origin}/old`, { waitUntil: "networkidle0" });
  await page.evaluate(() => scrollTo(0, 1500));
  await delay(200);
  await page.evaluate(() => window.navigateSlowly("/new", 150));
  await delay(550);
  await page.click("#target");
  await poll(() => events().some(event => event.pathname === "/new" && event.type === "scroll"), "new route reach");
  const newDepths = events().filter(event => event.pathname === "/new" && event.type === "scroll");
  assert.ok(newDepths.length);
  assert.ok(newDepths.every(event => event.documentHeight === 4000 && event.maxDepth <= 12.5),
    `New route inherited previous reach: ${JSON.stringify(newDepths)}`);
  evidence.checks.push({ name: "Delayed SPA rendering never inherits old 100% reach", depths: newDepths.map(e => e.maxDepth) });

  const before = events().filter(event => event.type === "click").length;
  await page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    event.preventDefault();
    window.dispatchEvent(event);
  });
  await page.click("#target");
  await poll(() => events().filter(event => event.type === "click").length > before, "click after canceled unload");
  evidence.checks.push({ name: "Canceled beforeunload leaves collection active" });

  const cacheBefore = events().filter(event => event.type === "click").length;
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  });
  await page.click("#target");
  await poll(() => events().filter(event => event.type === "click").length > cacheBefore, "click after cached restoration");
  assert.equal(events().filter(event => event.type === "click").length - cacheBefore, 1);
  evidence.checks.push({ name: "Repeated persisted pageshow resumes without duplicate click listeners" });

  await page.goto(`${origin}/loading-old`, { waitUntil: "networkidle0" });
  await page.evaluate(() => {
    history.pushState({}, "", "/loading-new");
    document.querySelector("main").style.height = "500px";
    document.querySelector("main").textContent = "Loading";
    scrollTo(0, 0);
    setTimeout(() => {
      document.querySelector("main").style.height = "4000px";
      document.querySelector("main").textContent = "Loaded";
    }, 500);
  });
  await delay(800);
  await page.click("#target");
  await poll(() => events().some(event => event.pathname === "/loading-new" && event.type === "scroll" && event.documentHeight === 4000), "loaded route geometry");
  const loadingDepths = events().filter(event => event.pathname === "/loading-new" && event.type === "scroll");
  const greatestDocumentHeight = Math.max(...loadingDepths.map(event => event.documentHeight));
  const greatestReachedPixels = Math.max(...loadingDepths.map(event => event.maxDepth * event.documentHeight / 100));
  assert.equal(greatestReachedPixels / greatestDocumentHeight * 100, 12.5);
  evidence.checks.push({ name: "Loading skeleton followed by page growth carries geometry for corrected visit reach", uploaded: loadingDepths.map(event => ({ height: event.documentHeight, depth: event.maxDepth })), correctedVisitDepth: 12.5 });
  await page.close();

  uploads.length = 0;
  const exitPage = await browser.newPage();
  await exitPage.setViewport({ width: 375, height: 500 });
  exitPage.on("pageerror", error => evidence.runtimeErrors.push(error.message));
  await exitPage.goto(`${origin}/exit`, { waitUntil: "networkidle0" });
  holdNormalUpload = true;
  await exitPage.click("#target");
  await poll(() => pendingResponses.size === 1, "deliberately pending periodic upload");
  await exitPage.click("#target");
  await exitPage.goto(`${origin}/away`, { waitUntil: "load" });
  await poll(() => events().filter(event => event.type === "click").length === 2, "final click dispatched at exit");
  evidence.checks.push({ name: "Actual navigation dispatches final click while normal upload is unresolved", clicks: 2,
    requestsIssued: uploads.length, acknowledgedFirstRequest: false });
  assert.deepEqual(evidence.runtimeErrors, []);
  evidence.passed = true;
} catch (error) {
  evidence.failure = error.stack;
  process.exitCode = 1;
} finally {
  holdNormalUpload = false;
  for (const response of pendingResponses) response.end('{"success":true}');
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  evidence.completedAt = new Date().toISOString();
  await writeFile(new URL("fix-tracker-browser-evidence.json", import.meta.url), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
}
