import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import puppeteer from "puppeteer";

// Exercise minified production assets against loopback only. Feature flags,
// download order and recording failures must not couple independent products.
const publicDir = new URL("../../public/", import.meta.url);
const assets = new Map(
  await Promise.all(
    ["script.js", "recording.js", "heatmaps.js", "page-capture.js"].map(async name => [
      name,
      await readFile(new URL(name, publicDir)),
    ])
  )
);
const modes = [
  "analytics",
  "recording-only",
  "heatmaps-only",
  "both",
  "unsampled",
  "zero-heatmaps",
  "stopped",
  "capped",
  "recording-failed",
  "recording-upload-failed",
  "recording-discarded",
  "heatmaps-failed",
  "heatmaps-late",
  "recording-late",
  "early-click",
  "early-config-click",
];
const states = new Map(
  modes.map(mode => [
    mode,
    { batches: [], snapshots: [], replayEvents: [], recordingRequests: 0, loads: {}, ready: false },
  ])
);
const errors = [];
let origin;
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function body(request) {
  let json = "";
  for await (const chunk of request) json += chunk;
  return JSON.parse(json);
}
async function until(predicate, label) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait(25);
  }
  throw new Error(`Timed out: ${label}`);
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, origin);
    const referer = new URL(request.headers.referer ?? "/", origin);
    const mode = states.has(url.pathname.slice(1)) ? url.pathname.slice(1) : referer.pathname.slice(1);
    const state = states.get(mode);
    const name = url.pathname.replace("/api/", "");
    if (assets.has(name)) {
      state.loads[name] = (state.loads[name] ?? 0) + 1;
      if (
        (name === "recording.js" && mode === "recording-failed") ||
        (name === "heatmaps.js" && mode === "heatmaps-failed")
      ) {
        response.writeHead(503);
        return response.end();
      }
      if (
        (name === "heatmaps.js" && ["heatmaps-late", "early-click"].includes(mode)) ||
        (name === "recording.js" && mode === "recording-late")
      )
        await wait(800);
      response.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-store" });
      return response.end(assets.get(name));
    }
    if (url.pathname.startsWith("/api/site/tracking-config/")) {
      if (mode === "early-config-click") await wait(800);
      response.writeHead(200, { "Content-Type": "application/json" });
      return response.end(
        JSON.stringify({
          heatmaps: !["analytics", "recording-only"].includes(mode),
          heatmapSampleRate: mode === "zero-heatmaps" ? 0 : 100,
          sessionReplay: !["analytics", "heatmaps-only", "early-click", "early-config-click"].includes(mode),
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
      response.writeHead(200, { "Content-Type": "application/json" });
      if (!state.ready) return response.end('{"success":true}');
      const event = batch.events.at(-1);
      state.grant ??= {
        key: `fixture-${mode}`,
        token: `token-${mode}`,
        pageVisitId: event.pageVisitId,
        hostname: event.hostname,
        pathname: event.pathname,
        bucket: 375,
      };
      return response.end(JSON.stringify({ success: true, snapshotRequest: state.grant }));
    }
    if (url.pathname.startsWith("/api/heatmaps/snapshot/")) {
      state.snapshots.push(await body(request));
    } else if (url.pathname.startsWith("/api/session-replay/record/")) {
      const batch = await body(request);
      state.recordingRequests++;
      if (mode === "recording-upload-failed") {
        response.writeHead(503);
        return response.end();
      }
      const recorded = !["capped", "recording-discarded"].includes(mode);
      if (recorded) state.replayEvents.push(...batch.events);
      response.writeHead(200, { "Content-Type": "application/json" });
      return response.end(JSON.stringify({ success: true, recorded, stopRecording: mode === "capped" }));
    } else if (!url.pathname.startsWith("/api/")) {
      response.writeHead(200, { "Content-Type": "text/html" });
      return response.end(`<!doctype html><html><head><style>body{height:2000px;margin:0}</style></head><body>
        <h1>Initial public heading</h1><div id="dynamic"></div>
        <div class="rr-block">blocked-secret</div><div class="rr-mask">masked-secret</div>
        <div data-private>selector-secret</div><input value="input-secret">
        <button id="button" onclick="void 'handler-secret'">Public button</button>
        <script>const originalInterval=window.setInterval;window.setInterval=(fn,ms,...args)=>originalInterval(fn,ms===5000?250:ms,...args);</script>
        <script src="${origin}/api/script.js?siteId=${mode}" data-replay-batch-interval="500"
          data-replay-sample-rate="${mode === "unsampled" ? 0 : 100}"
          data-replay-mask-text-selectors='["[data-private]"]'></script></body></html>`);
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

let browser;
try {
  browser = await puppeteer.launch({ headless: true });
  const results = [];
  for (const mode of modes) {
    const state = states.get(mode);
    const page = await browser.newPage();
    page.on("pageerror", error => errors.push(`${mode}: ${error.message}`));
    await page.setViewport({ width: 375, height: 500 });
    await page.goto(`${origin}/${mode}`, { waitUntil: "domcontentloaded" });
    const early = mode.startsWith("early-");
    if (early) {
      if (mode === "early-click") await page.evaluate(() => new Promise(resolve => window.rybbit.onReady(resolve)));
      await page.click("#button");
    }
    await page.evaluate(() => new Promise(resolve => window.rybbit.onReady(resolve)));
    const heatmaps = !["analytics", "recording-only", "zero-heatmaps", "heatmaps-failed"].includes(mode);
    const recording = ![
      "analytics",
      "heatmaps-only",
      "unsampled",
      "recording-failed",
      "early-click",
      "early-config-click",
    ].includes(mode);
    if (heatmaps) await until(() => state.batches.length > 0, `${mode} heatmap initialization`);
    if (recording)
      await page.waitForFunction(
        () => window.rybbit.isSessionReplayActive() || document.location.pathname === "/capped"
      );
    if (mode === "stopped") await page.evaluate(() => window.rybbit.stopSessionReplay());
    if (mode === "capped") {
      await until(() => state.recordingRequests > 0, "recording cap response");
      await page.waitForFunction(() => !window.rybbit.isSessionReplayActive());
    }
    await page.evaluate(() => {
      document.querySelector("h1").textContent = "Fresh public heading";
      window.scrollTo(0, 250);
    });
    state.ready = true;
    const shared = ["both", "heatmaps-late", "recording-late"].includes(mode);
    const standalone = heatmaps && !shared && !early;
    if (shared) {
      await until(
        () =>
          state.replayEvents.some(
            event =>
              event.type === 2 &&
              event.snapshotContext?.pathname === `/${mode}` &&
              JSON.stringify(event.data).includes("Fresh public heading")
          ),
        `${mode} stored recording checkpoint`
      );
      assert.equal(state.snapshots.length, 0, "Shared capture uploaded a second DOM");
    } else if (standalone) {
      await until(() => state.snapshots.length === 1, `${mode} standalone capture`);
      const snapshot = state.snapshots[0];
      assert.equal(snapshot.pathname, `/${mode}`);
      assert.equal(snapshot.pageVisitId, state.grant.pageVisitId);
      assert.ok(snapshot.documentHeight >= 2000);
      assert.equal(snapshot.node.type, 0);
      assert.match(JSON.stringify(snapshot.node), /Fresh public heading/);
      assert.doesNotMatch(
        JSON.stringify(snapshot.node),
        /blocked-secret|masked-secret|selector-secret|input-secret|handler-secret|"tagName":"script"|"onclick"/
      );
    }
    if (heatmaps)
      await until(
        () => state.batches.some(batch => batch.events.some(event => event.type === "scroll" && event.maxDepth > 25)),
        `${mode} visible scroll reach`
      );
    await page.evaluate(() => {
      document.querySelector("#dynamic").textContent = "Public mutation after shared capture";
      window.scrollTo(0, 0);
    });
    await page.click("#button");
    if (heatmaps) {
      await until(
        () => state.batches.some(batch => batch.events.some(event => event.type === "click")),
        `${mode} independent heatmap click`
      );
      assert.ok(
        state.batches.some(batch => batch.events.some(event => event.type === "scroll" && event.maxDepth > 25))
      );
    } else assert.equal(state.batches.length, 0);
    if (recording && !["stopped", "capped", "recording-upload-failed", "recording-discarded"].includes(mode)) {
      await until(
        () =>
          state.replayEvents.some(event => JSON.stringify(event.data).includes("Public mutation after shared capture")),
        `${mode} recording continues`
      );
      assert.doesNotMatch(
        JSON.stringify(state.replayEvents),
        /blocked-secret|masked-secret|selector-secret|input-secret/
      );
    }
    if (early) {
      assert.equal(state.snapshots.length, 0);
      assert.equal(state.loads["page-capture.js"] ?? 0, 0, "An early menu click did not prevent background capture");
    }
    assert.equal(state.loads["recording.js"] ?? 0, recording || mode === "recording-failed" ? 1 : 0);
    assert.equal(state.loads["heatmaps.js"] ?? 0, heatmaps || mode === "heatmaps-failed" ? 1 : 0);
    assert.equal(state.loads["page-capture.js"] ?? 0, standalone ? 1 : 0);
    assert.equal(state.snapshots.length, standalone ? 1 : 0);
    if (mode === "recording-only") {
      assert.ok(state.replayEvents.every(event => !event.snapshotContext));
      assert.equal(await page.evaluate(() => window.rybbit.isSessionReplayActive()), true);
    }
    results.push({ mode, downloads: state.loads, sharedDomUpload: shared });
    console.log(`Verified feature mode: ${mode}`);
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, cases: results }, null, 2));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
