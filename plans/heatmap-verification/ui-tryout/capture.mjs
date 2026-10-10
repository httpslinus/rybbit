import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { baseUrl, localAccount } from "../qa-support.mjs";
import { renderFixture } from "./fixture.mjs";
import { isKnownRuntimeError } from "./runtime-baseline.mjs";

const require = createRequire(new URL("../../../server/package.json", import.meta.url));
const puppeteer = require("puppeteer");
const collection = JSON.parse(await readFile(new URL("collection.json", import.meta.url), "utf8"));
const account = await localAccount();
const screenshotDirectory = new URL("screenshots/", import.meta.url);
await mkdir(screenshotDirectory, { recursive: true });
const previousAttempts = [];
try {
  const previous = JSON.parse(await readFile(new URL("report.json", import.meta.url), "utf8"));
  previousAttempts.push(...(previous.previousAttempts ?? []));
  delete previous.previousAttempts;
  previousAttempts.push(previous);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const evidence = {
  startedAt: new Date().toISOString(),
  siteId: collection.siteId,
  hostname: collection.hostname,
  source: "Fresh trusted browser interactions through the real tracker and unmodified local dashboard APIs",
  checks: [],
  screenshots: [],
  apiResponses: [],
  runtimeErrors: [],
  runtimeErrorDetails: [],
  consoleErrors: [],
  failedResources: [],
  backgroundUploads: 0,
  previousAttempts,
};

const browser = await puppeteer.launch({ headless: true, executablePath: puppeteer.executablePath() });

function reportUrl({ mode = "click", width = 1440, path = "/" } = {}) {
  const url = new URL(`/${collection.siteId}/heatmaps`, baseUrl);
  for (const [name, value] of Object.entries({
    timeMode: "range",
    startDate: collection.startedAt.slice(0, 10),
    endDate: collection.startedAt.slice(0, 10),
    heatmap_mode: mode,
    [`heatmap_${mode}_host`]: collection.hostname,
    [`heatmap_${mode}_path`]: path,
    [`heatmap_${mode}_width`]: String(width),
  }))
    url.searchParams.set(name, value);
  return url.href;
}

async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map(image => image.decode().catch(() => {})));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        animation => animation.playState !== "running" || animation.effect?.getComputedTiming().iterations === Infinity
      )
  );
}

async function waitForReport(page, { mode = "click", width, path = "/" } = {}) {
  await page.waitForFunction(
    ({ mode, width, path }) => {
      const title = document.querySelector('[aria-label="Heatmap detail"] h2');
      const overlay = document.querySelector(
        mode === "click" ? 'canvas[aria-label="Click intensity"]' : '[aria-label="Scroll reach"]'
      );
      const picker = document.querySelector('[aria-label="Viewport width"]');
      return title?.textContent === path && overlay && (!width || picker?.textContent.includes(`${width} CSS px`));
    },
    { timeout: 30_000 },
    { mode, width, path }
  );
  const frame = await (await page.waitForSelector('iframe[title="Live page background"]')).contentFrame();
  await frame.waitForSelector('[data-qa="hero-cta"]');
  if (width) assert.equal(await frame.evaluate(() => innerWidth), width);
  await settle(page);
}

async function clickText(page, selector, expected) {
  for (const node of await page.$$(selector)) {
    if (
      (await node.isVisible()) &&
      (await node.evaluate((element, text) => element.textContent.trim() === text, expected))
    ) {
      await node.click();
      return;
    }
  }
  throw new Error(`Visible control ${expected} not found`);
}

async function chooseWidth(page, width) {
  await page.click('[aria-label="Viewport width"]');
  await page.waitForSelector('[role="option"]', { visible: true });
  for (const node of await page.$$('[role="option"]')) {
    if (await node.evaluate((element, width) => element.textContent.startsWith(`${width} CSS px`), width)) {
      await node.click();
      return;
    }
  }
  throw new Error(`Observed width ${width} not found`);
}

async function screenshot(page, name, caption) {
  await settle(page);
  const path = new URL(name, screenshotDirectory).pathname;
  await page.screenshot({ path, fullPage: false });
  const viewport = page.viewport();
  evidence.screenshots.push({
    path,
    caption,
    cssViewport: viewport,
    outputPixels: {
      width: viewport.width * viewport.deviceScaleFactor,
      height: viewport.height * viewport.deviceScaleFactor,
    },
  });
}

async function newPage(viewport) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  await page.setCookie(
    ...account.cookies.map(cookie => ({
      ...cookie,
      path: "/",
      secure: cookie.name.startsWith("__Secure-") || cookie.name.startsWith("__Host-"),
    }))
  );
  await page.evaluateOnNewDocument(() => {
    if (window === window.top) localStorage.setItem("theme", "dark");
  });
  await page.setRequestInterception(true);
  page.on("request", request => {
    const url = new URL(request.url());
    if (request.url().includes("/heatmaps/record/")) evidence.backgroundUploads++;
    if (url.hostname === collection.hostname)
      return request.respond({
        status: 200,
        contentType: "text/html",
        body: renderFixture(collection.siteId, { tracking: false, path: url.pathname }),
      });
    return request.continue();
  });
  page.on("pageerror", error => {
    evidence.runtimeErrors.push(error.message);
    evidence.runtimeErrorDetails.push({ url: page.url(), message: error.message, stack: error.stack });
  });
  page.on("console", message => {
    if (message.type() === "error") evidence.consoleErrors.push(message.text());
  });
  page.on("response", response => {
    const url = new URL(response.url());
    if (response.status() >= 400) {
      evidence.failedResources.push({ status: response.status(), url: `${url.origin}${url.pathname}` });
    }
    if (url.pathname === `/api/sites/${collection.siteId}/heatmaps`) {
      evidence.apiResponses.push({ status: response.status(), query: Object.fromEntries(url.searchParams) });
    }
  });
  return page;
}

try {
  const clicks = (
    await account.call(
      `/sites/${collection.siteId}/heatmaps?start_date=${collection.startedAt.slice(0, 10)}&end_date=${collection.startedAt.slice(0, 10)}&mode=click&hostname=${collection.hostname}&pathname=%2F&bucket=1440`
    )
  ).data;
  assert.ok(clicks.count > 0 && clicks.points.length > 1);
  evidence.checks.push({
    name: "Fresh recorded clicks and distinct hotspots returned by normal API",
    passed: true,
    count: clicks.count,
    sessions: clicks.sessions,
    points: clicks.points.length,
  });

  const desktop = await newPage({ width: 1680, height: 1050, deviceScaleFactor: 2 });
  await desktop.goto(reportUrl(), { waitUntil: "domcontentloaded" });
  await waitForReport(desktop, { width: 1440 });
  assert.ok(
    await desktop.evaluate(() => {
      const canvas = document.querySelector('canvas[aria-label="Click intensity"]');
      return canvas
        .getContext("2d")
        .getImageData(0, 0, canvas.width, canvas.height)
        .data.some((value, index) => index % 4 === 3 && value > 0);
    })
  );
  await screenshot(desktop, "desktop-clicks.png", "Desktop click heatmap with fresh trusted tracker data");

  await chooseWidth(desktop, 768);
  await waitForReport(desktop, { width: 768 });
  await chooseWidth(desktop, 1440);
  await waitForReport(desktop, { width: 1440 });
  evidence.checks.push({ name: "Observed viewport switch 1440 → 768 → 1440 updates live frame width", passed: true });

  const search = await desktop.$('[aria-label="Search pages"]');
  await search.type("/pricing");
  await desktop.waitForFunction(() => {
    const rows = [...document.querySelectorAll('aside [aria-label="Pages"] button')];
    return rows.length === 1 && rows[0].textContent.startsWith("/pricing");
  });
  await desktop.click('aside [aria-label="Pages"] button');
  await waitForReport(desktop, { path: "/pricing" });
  await search.click({ clickCount: 3 });
  await desktop.keyboard.press("Backspace");
  await desktop.goto(reportUrl(), { waitUntil: "domcontentloaded" });
  await waitForReport(desktop, { width: 1440 });
  evidence.checks.push({ name: "Page search and selection open persisted /pricing samples", passed: true });

  await clickText(desktop, '[aria-label="Heatmap mode"] button', "Scroll");
  await waitForReport(desktop, { mode: "scroll" });
  await chooseWidth(desktop, 1440);
  await waitForReport(desktop, { mode: "scroll", width: 1440 });
  assert.equal(await desktop.$$eval("[data-depth]", rows => rows.length), 10);
  assert.equal(await desktop.$eval("table caption", element => element.textContent), "Scroll reach by page depth");
  await screenshot(desktop, "desktop-scroll.png", "Desktop cumulative scroll-reach report");
  evidence.checks.push({ name: "Scroll mode has ten reach bands and accessible reach table", passed: true });

  await clickText(desktop, '[aria-label="Heatmap mode"] button', "Clicks");
  await waitForReport(desktop, { width: 1440 });
  await desktop.click('[role="switch"][aria-label="Live background"]');
  await desktop.waitForSelector('iframe[title="Live page background"]', { hidden: true });
  assert.ok(await desktop.$('canvas[aria-label="Click intensity"]'));
  await desktop.click('[role="switch"][aria-label="Live background"]');
  await waitForReport(desktop, { width: 1440 });
  evidence.checks.push({ name: "Geometry-only mode retains click overlay; live background restores", passed: true });

  await clickText(desktop, "button", "Filter");
  await clickText(desktop, '[role="tab"]', "Cohorts");
  await clickText(desktop, "button", "New cohort");
  await desktop.waitForSelector('[role="dialog"] form', { visible: true });
  assert.ok(await desktop.$('[role="dialog"] input[type="date"]'));
  await screenshot(desktop, "cohort-dialog.png", "Historical cohort controls");
  await desktop.keyboard.press("Escape");
  await desktop.waitForSelector('[role="dialog"]', { hidden: true });
  evidence.checks.push({ name: "Historical cohort editor opens and closes", passed: true });

  const mobile = await newPage({ width: 375, height: 900, deviceScaleFactor: 2 });
  await mobile.goto(reportUrl({ width: 375 }), { waitUntil: "domcontentloaded" });
  await waitForReport(mobile, { width: 375 });
  assert.ok(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await clickText(mobile, '[aria-label="Heatmap detail"] button', "Pages");
  await mobile.waitForSelector('[role="dialog"] [aria-label="Search pages"]', { visible: true });
  await mobile.keyboard.press("Escape");
  await mobile.waitForSelector('[role="dialog"]', { hidden: true });
  await mobile.click('[aria-label="Open fullscreen"]');
  await mobile.waitForSelector('[aria-label="Close fullscreen"]', { visible: true });
  await waitForReport(mobile, { width: 375 });
  await screenshot(mobile, "mobile-fullscreen.png", "Phone fullscreen click heatmap");
  await mobile.keyboard.press("Escape");
  await mobile.waitForSelector('[aria-label="Close fullscreen"]', { hidden: true });
  await mobile.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Open fullscreen");
  evidence.checks.push({
    name: "Mobile page picker/fullscreen, no horizontal overflow and Escape focus restoration",
    passed: true,
  });

  assert.equal(evidence.backgroundUploads, 0);
  assert.ok(evidence.apiResponses.length > 0 && evidence.apiResponses.every(response => response.status === 200));
  const existingStripeError =
    "Uncaught (in promise) IntegrationError: Please call Stripe() with your publishable key. You used an empty string.";
  evidence.knownBaselineRuntimeErrors = evidence.runtimeErrorDetails.filter(error =>
    isKnownRuntimeError(error, collection.siteId)
  );
  assert.deepEqual(
    evidence.runtimeErrorDetails.filter(error => !isKnownRuntimeError(error, collection.siteId)),
    []
  );
  const baselineErrors = [];
  const baselineResources = [];
  const baseline = await browser.newPage();
  await baseline.setCookie(
    ...account.cookies.map(cookie => ({
      ...cookie,
      path: "/",
      secure: cookie.name.startsWith("__Secure-") || cookie.name.startsWith("__Host-"),
    }))
  );
  baseline.on("console", message => {
    if (message.type() === "error") baselineErrors.push(message.text());
  });
  baseline.on("response", response => {
    if (response.status() >= 400) {
      const url = new URL(response.url());
      baselineResources.push({ status: response.status(), url: `${url.origin}${url.pathname}` });
    }
  });
  await baseline.goto(
    `${baseUrl}/${collection.siteId}/main?timeMode=past-minutes&past_minutes_start=60&past_minutes_end=0`,
    { waitUntil: "networkidle0" }
  );
  evidence.existingDashboardBaseline = { consoleErrors: baselineErrors, failedResources: baselineResources };
  const missingResourceError = "Failed to load resource: the server responded with a status of 404 (Not Found)";
  const knownMissingResources = evidence.failedResources.filter(
    resource =>
      resource.status === 404 &&
      baselineResources.some(baseline => baseline.status === resource.status && baseline.url === resource.url)
  );
  evidence.knownBaselineMissingResources = knownMissingResources;
  assert.deepEqual(
    evidence.failedResources.filter(resource => !knownMissingResources.includes(resource)),
    []
  );
  assert.deepEqual(
    evidence.consoleErrors.filter(error => !(error === missingResourceError && knownMissingResources.length)),
    []
  );
  evidence.passed = true;
} catch (error) {
  evidence.passed = false;
  evidence.failure = { name: error.name, message: error.message };
  throw error;
} finally {
  evidence.finishedAt = new Date().toISOString();
  await writeFile(new URL("report.json", import.meta.url), JSON.stringify(evidence, null, 2));
  await browser.close();
}
console.log(JSON.stringify({ passed: true, checks: evidence.checks.length, screenshots: evidence.screenshots }));
