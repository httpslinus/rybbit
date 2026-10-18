import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import puppeteer from "puppeteer";

// Run the shipped tracker and both capture providers against loopback fixtures.
// Check requests and recorded events without saving or printing captured DOM.
const publicDir = new URL("../../public/", import.meta.url);
const assets = new Map(
  await Promise.all(
    [
      ["script.js", "script.js"],
      ["replay.js", "rrweb.min.js"],
      ["heatmap-snapshot.js", "heatmap-snapshot.js"],
    ].map(async ([url, file]) => [url, await readFile(new URL(file, publicDir))])
  )
);
const modes = ["recording", "disabled", "unsampled", "stopped", "capped", "load-failed"];
const states = new Map(
  modes.map(mode => [mode, { batches: [], snapshots: [], replayEvents: [], recorderLoads: 0, fallbackLoads: 0 }])
);
const errors = [];
let origin;

async function body(request) {
  let json = "";
  for await (const chunk of request) json += chunk;
  return JSON.parse(json);
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, origin);
    const referer = new URL(request.headers.referer ?? "/", origin);
    const mode = url.pathname.startsWith("/api/") ? url.pathname.split("/").at(-1) : url.pathname.split("/")[1];
    const state = states.get(mode) ?? states.get(referer.pathname.split("/")[1]);
    const asset = url.pathname.replace("/api/", "");
    if (assets.has(asset)) {
      if (asset === "replay.js") state.recorderLoads++;
      if (asset === "heatmap-snapshot.js") state.fallbackLoads++;
      if (asset === "replay.js" && referer.pathname === "/load-failed") {
        response.writeHead(503);
        return response.end();
      }
      response.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-store" });
      return response.end(assets.get(asset));
    }
    if (url.pathname.startsWith("/api/site/tracking-config/")) {
      response.writeHead(200, { "Content-Type": "application/json" });
      return response.end(
        JSON.stringify({
          heatmaps: true,
          heatmapSampleRate: 100,
          sessionReplay: mode !== "disabled",
          trackInitialPageView: true,
          trackSpaNavigation: true,
          trackUrlParams: false,
          trackButtonClicks: false,
          webVitals: false,
          featureFlagsEnabled: false,
        })
      );
    }
    if (url.pathname.startsWith("/api/heatmaps/record/")) {
      const batch = await body(request);
      state.batches.push(batch);
      const event = batch.events.at(-1);
      state.grant ??= {
        key: `fixture-${mode}`,
        token: `token-${mode}`,
        pageVisitId: event.pageVisitId,
        hostname: event.hostname,
        pathname: event.pathname,
        bucket: 375,
      };
      response.writeHead(200, { "Content-Type": "application/json" });
      return response.end(JSON.stringify({ success: true, snapshotRequest: state.grant }));
    }
    if (url.pathname.startsWith("/api/heatmaps/snapshot/")) {
      state.snapshots.push(await body(request));
    } else if (url.pathname.startsWith("/api/session-replay/record/")) {
      state.replayEvents.push(...(await body(request)).events);
      response.writeHead(200, { "Content-Type": "application/json" });
      return response.end(JSON.stringify({ success: true, stopRecording: mode === "capped" }));
    } else if (!url.pathname.startsWith("/api/")) {
      response.writeHead(200, { "Content-Type": "text/html" });
      return response.end(`<!doctype html><html><head><style>body{height:2000px}</style></head><body>
        <h1>Initial public heading</h1><div id="dynamic"></div>
        <div class="rr-block">blocked-secret</div><div class="rr-mask">masked-secret</div>
        <div data-private>selector-secret</div><input value="input-secret">
        <button id="button" onclick="void 'handler-secret'">Public button</button>
        <script src="${origin}/api/script.js?siteId=${mode}" data-replay-batch-interval="1000"
          data-replay-sample-rate="${mode === "unsampled" ? 0 : 100}"
          data-replay-mask-text-selectors='["[data-private]"]'></script>
        </body></html>`);
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end('{"success":true}');
  } catch (error) {
    errors.push(error.message);
    response.writeHead(500);
    response.end();
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
origin = `http://127.0.0.1:${server.address().port}`;
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(predicate, label) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait(25);
  }
  throw new Error(`Timed out: ${label}`);
}

let browser;
try {
  browser = await puppeteer.launch({ headless: true });
  const results = [];
  for (const mode of modes) {
    const state = states.get(mode);
    const page = await browser.newPage();
    page.on("pageerror", error => errors.push(`${mode}: ${error.message}`));
    await page.setViewport({ width: 375, height: 500 });
    await page.goto(`${origin}/${mode}`, { waitUntil: "networkidle0" });
    await page.evaluate(() => new Promise(resolve => window.rybbit.onReady(resolve)));
    if (["recording", "stopped"].includes(mode)) {
      await page.waitForFunction(() => window.rybbit.isSessionReplayActive());
      if (mode === "stopped") await page.evaluate(() => window.rybbit.stopSessionReplay());
    }
    if (mode === "capped") {
      await until(() => state.replayEvents.length > 0, "replay cap response");
      await page.waitForFunction(() => !window.rybbit.isSessionReplayActive());
    }
    await page.evaluate(() => {
      document.querySelector("h1").textContent = "Fresh public heading";
      window.scrollTo(0, 250);
    });
    await until(() => state.snapshots.length === 1, `${mode} background capture`);
    const snapshot = state.snapshots[0];
    assert.equal(snapshot.pathname, `/${mode}`);
    assert.equal(snapshot.pageVisitId, state.grant.pageVisitId);
    assert.ok(snapshot.documentHeight >= 2000);
    assert.equal(snapshot.node.type, 0);
    const serialized = JSON.stringify(snapshot.node);
    assert.match(serialized, /Fresh public heading/);
    assert.doesNotMatch(serialized, /blocked-secret|masked-secret|selector-secret|input-secret|handler-secret/);
    assert.doesNotMatch(serialized, /"tagName":"script"|"onclick"/);
    assert.equal(state.fallbackLoads, mode === "recording" ? 0 : 1);
    assert.equal(state.recorderLoads, ["disabled", "unsampled"].includes(mode) ? 0 : 1);
    assert.ok(state.batches.every(batch => !Object.hasOwn(batch, "node")));

    // The shared snapshot must leave recording functional, and stopping/capping
    // recording must leave independent heatmap clicks and scroll reach intact.
    await page.evaluate(() => {
      document.querySelector("#dynamic").textContent = "Public mutation after shared capture";
      window.scrollTo(0, 0);
    });
    await page.click("#button");
    await until(
      () => state.batches.some(batch => batch.events.some(event => event.type === "click")),
      `${mode} independent heatmap click`
    );
    assert.ok(state.batches.some(batch => batch.events.some(event => event.type === "scroll" && event.maxDepth > 25)));
    assert.equal(state.snapshots.length, 1, "Repeated nominations captured another background");
    if (mode === "recording") {
      await until(
        () =>
          state.replayEvents.some(event => JSON.stringify(event.data).includes("Public mutation after shared capture")),
        "recording after shared capture"
      );
      assert.ok(state.replayEvents.filter(event => event.type === 2).length >= 2);
      assert.doesNotMatch(
        JSON.stringify(state.replayEvents),
        /blocked-secret|masked-secret|selector-secret|input-secret/
      );
      assert.equal(await page.evaluate(() => window.rybbit.isSessionReplayActive()), true);
    }
    results.push({ mode, fallbackLoads: state.fallbackLoads, independentHeatmaps: true });
    console.log(`Verified page capture: ${mode}, ${state.fallbackLoads} fallback downloads`);
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, cases: results }, null, 2));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
