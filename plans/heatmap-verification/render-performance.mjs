import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { baseUrl, localAccount, responsiveFixture } from "./qa-support.mjs";

const require = createRequire(new URL("../../server/package.json", import.meta.url));
const puppeteer = require("puppeteer");
const account = await localAccount();
const suffix = randomBytes(5).toString("hex");
const hostname = `performance-${suffix}.heatmap.test`;
const evidence = {
  source:
    "Synthetic benchmark coordinates recorded through the public API and read from real storage by the unmodified production report; no API response interception",
  instrumentation:
    "Continuous requestAnimationFrame gaps, PerformanceObserver longtasks, canvas clear-to-drawImage timing including density rasterization, trusted event to second animation frame paint proxy. Instrumentation adds conservative timing overhead.",
  startedAt: new Date().toISOString(),
  budgetMs: 100,
  uploadedBatches: 0,
  uploadedEvents: 0,
  ingestionBackoffs: [],
  seed: [],
  initialRender: {},
  runtimeErrors: [],
  backgroundUploads: 0,
  passed: false,
};
try {
  const previous = JSON.parse(await readFile(new URL("performance-evidence.json", import.meta.url), "utf8"));
  const { previousAttempts = [], ...attempt } = previous;
  evidence.previousAttempts = [...previousAttempts, attempt];
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
let siteId, browser, page;
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function stats(values) {
  const ordered = values.toSorted((a, b) => a - b);
  const quantile = ratio => ordered[Math.min(ordered.length - 1, Math.floor((ordered.length - 1) * ratio))] ?? 0;
  return { count: values.length, p50: quantile(0.5), p95: quantile(0.95), max: ordered.at(-1) ?? 0 };
}

function reportUrl(width = 1440, mode = "click") {
  const url = new URL(`/${siteId}/heatmaps`, baseUrl);
  const params = {
    timeMode: "past-minutes",
    past_minutes_start: 30,
    past_minutes_end: 0,
    heatmap_mode: mode,
    [`heatmap_${mode}_host`]: hostname,
    [`heatmap_${mode}_path`]: "/benchmark",
    [`heatmap_${mode}_width`]: width,
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url.href;
}

async function recordBatch(payload) {
  const body = JSON.stringify(payload);
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(`${baseUrl}/api/heatmaps/record/${siteId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseUrl },
      body,
    });
    const result = await response.text();
    if (response.status === 429) {
      const advertised =
        Number(response.headers.get("Retry-After")) || Number(result.match(/retry in (\d+) seconds/)?.[1]) || 60;
      evidence.ingestionBackoffs.push({ batchId: payload.batchId, attempt, status: 429, waitSeconds: advertised });
      console.log(JSON.stringify({ stage: "honoring ingestion Retry-After", waitSeconds: advertised }));
      await delay((advertised + 1) * 1000);
      continue;
    }
    assert.equal(response.status, 200, `Public benchmark ingestion failed: ${result}`);
    evidence.uploadedBatches++;
    evidence.uploadedEvents += payload.events.length;
    return;
  }
  throw new Error("Public benchmark ingestion remained throttled after the advertised retries");
}

async function seedWidth(width) {
  const pageVisitId = `benchmark-visit-${width}-${suffix}`;
  const viewportHeight = 700;
  const geometry = {
    timestamp: Date.now(),
    pageVisitId,
    hostname,
    pathname: "/benchmark",
    viewportWidth: width,
    viewportHeight,
    documentWidth: width,
    documentHeight: 2000,
  };
  // All 5000 distinct points lie in the initial viewport, so this exercises
  // dense visible rendering rather than relying on off-screen culling.
  const clicks = Array.from({ length: 5000 }, (_, index) => {
    const x = 25 + ((index % 100) * (width - 50)) / 99;
    const y = 30 + Math.floor(index / 100) * 6;
    return { ...geometry, type: "click", clientX: x, clientY: y, pageX: x, pageY: y };
  });
  for (let offset = 0; offset < clicks.length; offset += 100) {
    await recordBatch({
      batchId: randomUUID(),
      userId: `benchmark-${width}`,
      events: clicks.slice(offset, offset + 100),
    });
  }
  console.log(JSON.stringify({ stage: "stored benchmark layout", width, points: clicks.length }));
  return { ...geometry, type: "scroll", maxDepth: 100 };
}

async function frames(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function settled(page) {
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        animation => animation.playState !== "running" || animation.effect?.getComputedTiming().iterations === Infinity
      )
  );
  await frames(page);
}

async function sample(page, type, label, action) {
  const before = await page.evaluate(
    ({ type, label }) => {
      const perf = window.__heatmapPerf;
      perf.label = label;
      perf.actions.push({ label, type, start: performance.now() });
      const before = perf.samples.length;
      window.addEventListener(
        type,
        event => {
          const start = performance.now();
          requestAnimationFrame(() =>
            requestAnimationFrame(() =>
              perf.samples.push({ label, type, trusted: event.isTrusted, duration: performance.now() - start })
            )
          );
        },
        { capture: true, once: true }
      );
      return before;
    },
    { type, label }
  );
  await action();
  await page.waitForFunction(before => window.__heatmapPerf.samples.length > before, {}, before);
  await delay(20);
}

async function clickText(page, selector, text) {
  for (const element of await page.$$(selector)) {
    if ((await element.isVisible()) && (await element.evaluate((node, text) => node.textContent.trim() === text, text)))
      return element.click();
  }
  throw new Error(`Visible ${selector} ${text} missing`);
}

async function regionPosition(page) {
  return page.$eval('[aria-label="Heatmap page"]', element => {
    const rect = element.getBoundingClientRect();
    return {
      x: Math.min(innerWidth - 25, rect.x + rect.width / 2),
      y: Math.min(innerHeight - 30, rect.y + rect.height / 2),
    };
  });
}

async function pointerAndScroll(page, label) {
  const position = await regionPosition(page);
  await page.mouse.move(position.x, position.y);
  for (let index = 0; index < 20; index++) {
    await sample(page, "pointermove", `${label} pointer`, () =>
      page.mouse.move(position.x + (index % 2 ? 8 : -8), position.y + (index % 3 ? 4 : -4))
    );
  }
  await page.waitForFunction(() => {
    const region = document.querySelector('[aria-label="Heatmap page"]');
    return region && region.scrollHeight > region.clientHeight + 200;
  });
  // Width changes can clamp a retained scroll position to the bottom. Start
  // measured wheel inputs centrally, so every input produces a real scroll.
  await page.$eval('[aria-label="Heatmap page"]', region => {
    region.scrollTop = (region.scrollHeight - region.clientHeight) / 2;
  });
  await frames(page);
  for (let index = 0; index < 20; index++) {
    await sample(page, "scroll", `${label} scroll`, () => page.mouse.wheel({ deltaY: index % 2 ? -100 : 100 }));
  }
}

async function fullscreen(page, label) {
  for (let index = 0; index < 3; index++) {
    await sample(page, "click", `${label} fullscreen open`, () => page.click('[aria-label="Open fullscreen"]'));
    await page.waitForSelector('[aria-label="Close fullscreen"]', { visible: true });
    await settled(page);
    await sample(page, "click", `${label} fullscreen close`, () => page.click('[aria-label="Close fullscreen"]'));
    await page.waitForSelector('[aria-label="Close fullscreen"]', { hidden: true });
    await settled(page);
  }
}

try {
  const site = await account.call(`/organizations/${account.organizationId}/sites`, {
    domain: hostname,
    name: `5000-point browser benchmark ${suffix}`,
    blockBots: false,
    saltUserIds: false,
  });
  siteId = evidence.siteId = site.siteId;
  await account.call(
    `/sites/${siteId}/config`,
    { heatmaps: true, heatmapSampleRate: 100, sessionReplay: false, blockBots: false },
    "PUT"
  );
  // Real tracker installations also send ordinary pageviews. Populate that
  // normal prerequisite so the site's install card cannot consume the phone
  // viewport and turn this renderer benchmark into an onboarding-layout test.
  const ordinary = await fetch(`${baseUrl}/api/track`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: baseUrl },
    body: JSON.stringify({ site_id: String(siteId), type: "pageview", hostname, pathname: "/benchmark", screenWidth: 1440, screenHeight: 900, language: "en-US", page_title: "Renderer benchmark" }),
  });
  assert.equal(ordinary.status, 200);
  const ordinaryDeadline = Date.now() + 15_000;
  while (!(await account.call(`/sites/${siteId}/has-data`)).hasData) {
    assert.ok(Date.now() < ordinaryDeadline, "Benchmark ordinary pageview was not stored");
    await delay(100);
  }
  const scrolls = [];
  for (const width of [375, 1440]) scrolls.push(await seedWidth(width));
  await recordBatch({ batchId: randomUUID(), userId: "benchmark-scroll", events: scrolls });
  assert.ok(evidence.uploadedBatches <= 120, "Public ingestion rate budget exceeded");
  for (const width of [375, 1440]) {
    const data = (
      await account.call(
        `/sites/${siteId}/heatmaps?past_minutes_start=30&past_minutes_end=0&mode=click&hostname=${hostname}&pathname=%2Fbenchmark&bucket=${width}`
      )
    ).data;
    assert.equal(data.points.length, 5000);
    assert.equal(data.count, 5000);
    assert.equal(new Set(data.points.map(point => `${point.x},${point.y}`)).size, 5000);
    evidence.seed.push({
      width,
      points: data.points.length,
      count: data.count,
      limits: data.limits,
      geometry: data.geometry,
      allPointsInitiallyVisible: true,
    });
  }
  // Inserts are acknowledged and no benchmark traffic runs during measurement.
  await delay(1000);
  browser = await puppeteer.launch({ headless: true });
  page = await browser.newPage();
  await page.setViewport({ width: 1680, height: 1000, deviceScaleFactor: 2 });
  await page.emulateTimezone("UTC");
  await page.setCookie(
    ...account.cookies.map(cookie => ({
      ...cookie,
      path: "/",
      secure: cookie.name.startsWith("__Secure-") || cookie.name.startsWith("__Host-"),
    }))
  );
  await page.setRequestInterception(true);
  page.on("request", request => {
    if (request.url().includes("/heatmaps/record/")) evidence.backgroundUploads++;
    if (new URL(request.url()).hostname === hostname)
      return request.respond({
        status: 200,
        contentType: "text/html",
        body: responsiveFixture(siteId, { tracking: false }),
      });
    return request.continue();
  });
  page.on("pageerror", error => evidence.runtimeErrors.push(error.message));
  await page.evaluateOnNewDocument(() => {
    if (window !== window.top) return;
    localStorage.setItem("theme", "light");
    localStorage.setItem("rybbit-store", JSON.stringify({ state: { timezone: "UTC" }, version: 0 }));
    const perf = (window.__heatmapPerf = {
      phase: "initial",
      active: false,
      frames: [],
      longTasks: [],
      draws: [],
      samples: [],
      actions: [],
      label: "initial",
      lastFrame: null,
      observerSupported: PerformanceObserver.supportedEntryTypes.includes("longtask"),
    });
    if (perf.observerSupported)
      new PerformanceObserver(list => {
        for (const entry of list.getEntries())
          perf.longTasks.push({ phase: perf.phase, duration: entry.duration, start: entry.startTime });
      }).observe({ type: "longtask", buffered: true });
    const frame = now => {
      if (perf.active && perf.lastFrame !== null)
        perf.frames.push({ duration: now - perf.lastFrame, start: perf.lastFrame, end: now, label: perf.label });
      perf.lastFrame = now;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    const prototype = CanvasRenderingContext2D.prototype;
    const clear = prototype.clearRect;
    const draw = prototype.drawImage;
    prototype.clearRect = function (...args) {
      if (this.canvas.getAttribute("aria-label") === "Click intensity") {
        this.__qaDraw = {
          phase: perf.phase,
          start: performance.now(),
          duration: 0,
          completed: false,
          width: this.canvas.width,
          height: this.canvas.height,
        };
        perf.draws.push(this.__qaDraw);
      }
      return Reflect.apply(clear, this, args);
    };
    prototype.drawImage = function (...args) {
      const result = Reflect.apply(draw, this, args);
      if (this.__qaDraw) {
        this.__qaDraw.completed = true;
        this.__qaDraw.duration = performance.now() - this.__qaDraw.start;
      }
      return result;
    };
  });
  const loadStarted = Date.now();
  await page.goto(reportUrl(), { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__heatmapPerf.draws.some(draw => draw.completed));
  console.log(JSON.stringify({ stage: "actual 5000-point canvas ready", siteId }));
  await page.waitForSelector('canvas[aria-label="Click intensity"]', { visible: true });
  assert.ok(await page.$eval('[aria-label="Heatmap page"]', element => element.clientHeight >= 200), "Benchmark viewer must have a usable viewport");
  await settled(page);
  await delay(500);
  evidence.initialRender = await page.evaluate(() => ({
    navigation: performance.getEntriesByType("navigation")[0]?.toJSON(),
    draws: window.__heatmapPerf.draws,
    longTasks: window.__heatmapPerf.longTasks,
    devicePixelRatio,
  }));
  evidence.initialRender.wallToReadyMs = Date.now() - loadStarted;
  evidence.initialRender.drawDurations = stats(evidence.initialRender.draws.map(draw => draw.duration));
  assert.ok(evidence.initialRender.drawDurations.max <= 100, "Initial density raster exceeded100ms");
  assert.equal(evidence.initialRender.devicePixelRatio, 2);
  assert.ok(
    await page.$eval(
      'canvas[aria-label="Click intensity"]',
      element => getComputedStyle(element).pointerEvents === "none"
    )
  );
  await page.evaluate(() => {
    window.__heatmapPerf.phase = "interaction";
    window.__heatmapPerf.active = true;
    window.__heatmapPerf.lastFrame = null;
  });
  await pointerAndScroll(page, "desktop DPR2");
  await fullscreen(page, "desktop DPR2");
  for (const width of [1440, 1280, 1680, 1440, 1280, 1680]) {
    await sample(page, "resize", "desktop resize", () =>
      page.setViewport({ width, height: 1000, deviceScaleFactor: 2 })
    );
    await settled(page);
  }
  await sample(page, "click", "desktop scroll mode", () =>
    clickText(page, '[aria-label="Heatmap mode"] button', "Scroll")
  );
  await page.waitForSelector('[aria-label="Scroll reach"]', { visible: true });
  await sample(page, "click", "desktop click mode", () =>
    clickText(page, '[aria-label="Heatmap mode"] button', "Clicks")
  );
  await page.waitForSelector('canvas[aria-label="Click intensity"]', { visible: true });
  await sample(page, "resize", "phone responsive resize", () =>
    page.setViewport({ width: 375, height: 900, deviceScaleFactor: 2 })
  );
  await settled(page);
  await page.click('[aria-label="Viewport width"]');
  await page.waitForSelector('[role="option"]', { visible: true });
  for (const option of await page.$$('[role="option"]')) {
    if (await option.evaluate(element => element.textContent.startsWith("375 CSS px"))) {
      await option.click();
      break;
    }
  }
  await page.waitForFunction(() =>
    document.querySelector('[aria-label="Viewport width"]')?.textContent.includes("375 CSS px")
  );
  await settled(page);
  await pointerAndScroll(page, "phone DPR2");
  await fullscreen(page, "phone DPR2");
  await settled(page);
  await page.evaluate(() => {
    window.__heatmapPerf.active = false;
    window.__heatmapPerf.phase = "complete";
  });
  const measured = await page.evaluate(() => JSON.parse(JSON.stringify(window.__heatmapPerf)));
  assert.equal(measured.observerSupported, true, "Long-task observation unavailable");
  assert.ok(
    measured.samples.length >= 90 && measured.samples.every(sample => sample.trusted),
    "Trusted interaction measurements incomplete"
  );
  const interactionTasks = measured.longTasks.filter(task => task.phase === "interaction");
  const interactionDraws = measured.draws.filter(draw => draw.phase === "interaction");
  evidence.measurements = {
    samples: measured.samples,
    actions: measured.actions,
    responsiveness: stats(measured.samples.map(sample => sample.duration)),
    byInteraction: Object.fromEntries(
      [...new Set(measured.samples.map(sample => sample.label))].map(label => [
        label,
        stats(measured.samples.filter(sample => sample.label === label).map(sample => sample.duration)),
      ])
    ),
    frameGaps: stats(measured.frames.map(frame => frame.duration)),
    slowFrames: measured.frames.filter(frame => frame.duration >= 50),
    longTasks: interactionTasks,
    longTaskDurations: stats(interactionTasks.map(task => task.duration)),
    drawDurations: stats(interactionDraws.map(draw => draw.duration)),
    draws: interactionDraws,
  };
  assert.equal(evidence.backgroundUploads, 0);
  assert.ok(evidence.measurements.drawDurations.max <= 100, "Density redraw exceeded100ms");
  const stripeError =
    "Uncaught (in promise) IntegrationError: Please call Stripe() with your publishable key. You used an empty string.";
  const baselineProof = JSON.parse(await readFile(new URL("render-evidence.json", import.meta.url), "utf8"));
  const stripeProven = baselineProof.baselineAudit.some(audit => audit.pageErrors.includes(stripeError));
  evidence.runtimeBaselineProof = { file: "render-evidence.json", stripeProven };
  assert.deepEqual(
    evidence.runtimeErrors.filter(error => !stripeProven || error !== stripeError),
    []
  );
  assert.ok(
    evidence.measurements.longTaskDurations.max <= 100,
    `Renderer interaction task exceeded100ms: ${JSON.stringify(evidence.measurements.longTaskDurations)}`
  );
  assert.ok(
    evidence.measurements.frameGaps.max <= 100,
    `Renderer stalled frames over100ms: ${JSON.stringify(evidence.measurements.frameGaps)}`
  );
  assert.ok(
    evidence.measurements.responsiveness.max <= 100,
    `Interaction paint proxy exceeded100ms: ${JSON.stringify(evidence.measurements.responsiveness)}`
  );
  evidence.passed = true;
} catch (error) {
  evidence.failure = { name: error.name, message: error.message };
  if (page && !page.isClosed()) {
    evidence.failureState = await page.evaluate(() => {
      const region = document.querySelector('[aria-label="Heatmap page"]');
      return { perf: window.__heatmapPerf, region: region && { top: region.scrollTop, height: region.clientHeight, extent: region.scrollHeight }, selectedWidth: document.querySelector('[aria-label="Viewport width"]')?.textContent };
    }).catch(() => null);
  }
  throw error;
} finally {
  if (browser) await browser.close();
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
  await writeFile(new URL("performance-evidence.json", import.meta.url), JSON.stringify(evidence, null, 2));
}
assert.ok(evidence.passed, "Renderer benchmark or cleanup failed");
console.log(
  JSON.stringify({
    passed: true,
    siteId,
    responsiveness: evidence.measurements.responsiveness,
    frameGaps: evidence.measurements.frameGaps,
    longTasks: evidence.measurements.longTaskDurations,
    initialDraw: evidence.initialRender.drawDurations,
  })
);
