import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { baseUrl, localAccount } from "../qa-support.mjs";
import { renderFixture } from "./fixture.mjs";
import { isKnownRuntimeError } from "./runtime-baseline.mjs";

const require = createRequire(new URL("../../../server/package.json", import.meta.url));
const puppeteer = require("puppeteer");
const collection = JSON.parse(await readFile(new URL("collection.json", import.meta.url), "utf8"));
const calendarDate = collection.startedAt.slice(0, 10);
const account = await localAccount();
const evidencePath = new URL("filter-evidence.json", import.meta.url);
const history = [];
try {
  const previous = JSON.parse(await readFile(evidencePath, "utf8"));
  history.push(...(previous.history ?? []));
  delete previous.history;
  history.push(previous);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const evidence = {
  startedAt: new Date().toISOString(),
  siteId: collection.siteId,
  source:
    "Actual local dashboard, normal authenticated APIs, fixture background only; no report mocks or CSS overrides",
  checks: [],
  screenshots: [],
  apiResponses: [],
  runtimeErrors: [],
  runtimeErrorDetails: [],
  history,
};
const screenshotDirectory = new URL("screenshots/", import.meta.url);
await mkdir(screenshotDirectory, { recursive: true });
const executablePath = puppeteer.executablePath();
assert.ok(!executablePath.includes("headless-shell"));
const browser = await puppeteer.launch({ headless: true, executablePath });

function reportUrl({ filters = [], cohortId } = {}) {
  const url = new URL(`/${collection.siteId}/heatmaps`, baseUrl);
  for (const [key, value] of Object.entries({
    timeMode: "range",
    startDate: calendarDate,
    endDate: calendarDate,
    heatmap_click_host: collection.hostname,
    heatmap_click_path: "/",
    heatmap_click_width: "1440",
    ...(filters.length ? { filters: JSON.stringify(filters) } : {}),
    ...(cohortId ? { heatmap_cohort: String(cohortId) } : {}),
  }))
    url.searchParams.set(key, value);
  return url.href;
}
async function newPage(viewport) {
  const page = await browser.newPage();
  await page.setViewport({ ...viewport, deviceScaleFactor: 2 });
  await page.emulateTimezone("UTC");
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
    evidence.runtimeErrorDetails.push({ message: error.message, url: page.url() });
  });
  page.on("response", response => {
    const url = new URL(response.url());
    if (
      url.pathname === `/api/sites/${collection.siteId}/heatmaps` ||
      url.pathname.startsWith(`/api/sites/${collection.siteId}/cohorts`)
    )
      evidence.apiResponses.push({
        method: response.request().method(),
        status: response.status(),
        query: Object.fromEntries(url.searchParams),
        path: url.pathname,
      });
  });
  return page;
}
async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
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
async function screenshot(page, name) {
  await settle(page);
  const path = new URL(name, screenshotDirectory).pathname;
  await page.screenshot({ path });
  evidence.screenshots.push({ path, viewport: page.viewport() });
}
async function clickText(page, selector, text) {
  for (const node of await page.$$(selector)) {
    if (
      (await node.isVisible()) &&
      (await node.evaluate((element, text) => element.textContent.trim() === text, text))
    ) {
      await node.click();
      return;
    }
  }
  throw new Error(`Visible ${selector}: ${text} not found`);
}
async function waitForReport(page) {
  await page.waitForSelector('canvas[aria-label="Click intensity"]', { visible: true });
  await page.waitForSelector('[aria-label="Viewport width"]', { visible: true });
  await settle(page);
}
async function assertBounds(page, selector) {
  const bounds = await page.$eval(selector, element => {
    const r = element.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  });
  assert.ok(
    bounds.left >= -1 &&
      bounds.right <= page.viewport().width + 1 &&
      bounds.top >= -1 &&
      bounds.bottom <= page.viewport().height + 1
  );
  return bounds;
}
async function setInput(page, selector, value) {
  await page.$eval(
    selector,
    (element, value) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    },
    value
  );
}
async function waitForQuery(page, key, value) {
  await page.waitForFunction((key, value) => new URL(location.href).searchParams.get(key) === value, {}, key, value);
}

try {
  const desktop = await newPage({ width: 1680, height: 1050 });
  await desktop.goto(reportUrl(), { waitUntil: "networkidle0" });
  await waitForReport(desktop);
  assert.equal(await desktop.$('[aria-label="Analytics event type"]'), null);
  assert.equal(await desktop.$('[aria-label="Remove bounce filter"]'), null);
  assert.equal(await desktop.$('[role="tab"]'), null);
  assert.equal(
    await desktop.$eval('[aria-label="Sample details"]', button => button.textContent.trim()),
    "Sample details"
  );
  await screenshot(desktop, "filter-desktop-default.png");
  evidence.checks.push({
    name: "Default toolbar contains mode only; Sample details has an explicit label",
    passed: true,
  });

  await clickText(desktop, "button", "Filter");
  await desktop.waitForSelector('[role="tab"]', { visible: true });
  await desktop.waitForSelector('[aria-label="Analytics event type"]', { visible: true });
  await assertBounds(desktop, '[data-slot="popover-content"]');
  await screenshot(desktop, "filter-desktop-options.png");
  const tabs = await desktop.$$eval('[role="tab"]', nodes => nodes.map(node => node.textContent.trim()));
  assert.deepEqual(tabs, ["Filters", "Segments", "Cohorts"]);
  evidence.checks.push({
    name: "Existing Filter popover contains ordinary choices, event type, bounce and a Cohorts tab",
    passed: true,
  });

  await desktop.click('[aria-label="Analytics event type"]');
  await desktop.waitForSelector('[role="option"]', { visible: true });
  const eventResponse = desktop.waitForResponse(
    response =>
      new URL(response.url()).pathname === `/api/sites/${collection.siteId}/heatmaps` &&
      new URL(response.url()).searchParams.get("analytics_event_type") === "pageview"
  );
  await clickText(desktop, '[role="option"]', "Pageviews");
  const eventData = await (await eventResponse).json();
  assert.equal(eventData.data?.count ?? eventData.count, 38);
  await desktop.keyboard.press("Escape");
  await desktop.waitForSelector('[role="tab"]', { hidden: true });
  await waitForReport(desktop);
  assert.equal(
    await desktop.$eval('[aria-label="Analytics event type"]', button => button.textContent.trim()),
    "Pageviews"
  );
  await waitForQuery(desktop, "heatmap_event_type", "pageview");
  await screenshot(desktop, "filter-desktop-active.png");
  evidence.checks.push({
    name: "Event type applies through the normal API and remains visible as a removable chip",
    passed: true,
  });

  await clickText(desktop, "button", "Filter");
  await desktop.click('[role="checkbox"]');
  await waitForQuery(desktop, "heatmap_exclude_bounce", "true");
  await desktop.keyboard.press("Escape");
  await desktop.waitForSelector('[role="tab"]', { hidden: true });
  assert.ok(await desktop.$('[aria-label="Remove bounce filter"]'));
  await desktop.click('[aria-label="Remove bounce filter"]');
  await waitForQuery(desktop, "heatmap_exclude_bounce", null);
  await waitForReport(desktop);
  await desktop.click('[aria-label="Remove event type filter"]');
  await waitForQuery(desktop, "heatmap_event_type", null);
  const afterRemoval = new URL(desktop.url()).searchParams;
  assert.equal(afterRemoval.get("heatmap_click_path"), "/");
  assert.equal(afterRemoval.get("heatmap_click_width"), "1440");
  await waitForReport(desktop);
  evidence.checks.push({
    name: "Bounce/event chips reset only their own selectors and preserve page/width",
    passed: true,
  });

  const hostFilter = { parameter: "hostname", type: "equals", value: [collection.hostname] };
  await desktop.goto(reportUrl({ filters: [hostFilter] }), { waitUntil: "networkidle0" });
  await waitForReport(desktop);
  await clickText(desktop, "button", "Filter");
  await clickText(desktop, '[role="tab"]', "Cohorts");
  await screenshot(desktop, "filter-desktop-cohorts.png");
  await clickText(desktop, "button", "New cohort");
  await desktop.waitForSelector('[role="tab"]', { hidden: true });
  await desktop.waitForSelector('[role="dialog"] input', { visible: true });
  assert.equal(await desktop.$('[role="tab"]'), null);
  const cohortName = `Filter UI QA ${Date.now().toString(36)}`;
  const fields = await desktop.$$eval('[role="dialog"] label', labels =>
    Object.fromEntries(labels.map(label => [label.textContent.trim(), label.htmlFor]))
  );
  await setInput(desktop, `#${CSSescape(fields.Name)}`, cohortName);
  await setInput(desktop, `#${CSSescape(fields["Historical start date"])}`, calendarDate);
  await setInput(desktop, `#${CSSescape(fields["Historical end date"])}`, calendarDate);
  await setInput(desktop, `#${CSSescape(fields.Timezone)}`, "UTC");
  assert.equal(await desktop.evaluate(() => document.activeElement?.getAttribute("id")), fields.Name);
  const createResponse = desktop.waitForResponse(
    response =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === `/api/sites/${collection.siteId}/cohorts`
  );
  await clickText(desktop, "button", "Save cohort");
  const saved = await createResponse;
  assert.ok(saved.status() < 300);
  await desktop.waitForSelector('[role="dialog"]', { hidden: true });
  await desktop.waitForFunction(() => Number(new URL(location.href).searchParams.get("heatmap_cohort")) > 0);
  const cohortId = Number(new URL(desktop.url()).searchParams.get("heatmap_cohort"));
  evidence.retainedLocalCohort = { cohortId, name: cohortName };
  await waitForReport(desktop);
  await clickText(desktop, "button", cohortName);
  await desktop.waitForSelector('[data-slot="popover-content"]', { visible: true });
  await screenshot(desktop, "filter-desktop-cohort-details.png");
  evidence.checks.push({
    name: "Cohort creation closes Filter, keeps dialog focused and applies retained real historical membership",
    passed: true,
    cohortId,
  });
  await clickText(desktop, "button", "Edit cohort");
  await desktop.waitForSelector('[role="dialog"] input', { visible: true });
  await clickText(desktop, "button", "Cancel");
  await desktop.keyboard.press("Escape");
  await desktop.reload({ waitUntil: "networkidle0" });
  await waitForReport(desktop);
  assert.equal(new URL(desktop.url()).searchParams.get("heatmap_cohort"), String(cohortId));
  await desktop.click('[aria-label="Clear cohort"]');
  await waitForQuery(desktop, "heatmap_cohort", null);
  assert.ok(new URL(desktop.url()).searchParams.has("filters"));
  evidence.checks.push({
    name: "Cohort chip edits through existing dialog, persists after refresh and removes only membership",
    passed: true,
  });

  for (const width of [375, 320]) {
    const mobile = await newPage({ width, height: 900 });
    await mobile.goto(reportUrl(), { waitUntil: "networkidle0" });
    await waitForReport(mobile);
    await assertBounds(mobile, '[aria-label="Heatmap detail"]');
    await screenshot(mobile, `filter-mobile-${width}-default.png`);
    await mobile.click('[aria-label="Heatmap detail"] [aria-label="Sample details"]');
    const sampleBounds = await assertBounds(mobile, '[role="dialog"][aria-label="Sample details"]');
    await mobile.keyboard.press("Escape");
    await clickText(mobile, "button", "Filter");
    await mobile.waitForSelector('[aria-label="Analytics event type"]', { visible: true });
    const filterBounds = await assertBounds(mobile, '[data-slot="popover-content"]');
    await screenshot(mobile, `filter-mobile-${width}-options.png`);
    await clickText(mobile, '[role="tab"]', "Cohorts");
    await assertBounds(mobile, '[data-slot="popover-content"]');
    await mobile.keyboard.press("Escape");
    const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert.equal(overflow, 0);
    evidence.checks.push({
      name: `${width}px header, Sample details, Filter and Cohorts stay within the viewport`,
      passed: true,
      sampleBounds,
      filterBounds,
      overflow,
    });
    await mobile.close();
  }
  await desktop.goto(new URL(`/${collection.siteId}/main`, baseUrl).href, { waitUntil: "networkidle0" });
  await clickText(desktop, "button", "Filter");
  await desktop.waitForSelector('[data-slot="popover-content"] [role="tab"]', { visible: true });
  assert.deepEqual(
    await desktop.$$eval('[data-slot="popover-content"] [role="tab"]', nodes =>
      nodes.map(node => node.textContent.trim())
    ),
    ["Filters", "Segments"]
  );
  assert.equal(await desktop.$('[aria-label="Analytics event type"]'), null);
  evidence.checks.push({ name: "Main retains its existing two-tab Filter behavior", passed: true });

  assert.ok(evidence.apiResponses.every(response => response.status < 300));
  evidence.newRuntimeErrors = evidence.runtimeErrorDetails.filter(
    error => !isKnownRuntimeError(error, collection.siteId)
  );
  assert.equal(evidence.newRuntimeErrors.length, 0);
  evidence.status = "passed";
} catch (error) {
  evidence.status = "failed";
  evidence.failure = error.stack;
  throw error;
} finally {
  evidence.completedAt = new Date().toISOString();
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  await browser.close();
}
console.log(
  JSON.stringify({
    status: evidence.status,
    checks: evidence.checks.length,
    responses: evidence.apiResponses.length,
    retainedLocalCohort: evidence.retainedLocalCohort,
  })
);

function CSSescape(value) {
  return value.replace(/[^a-zA-Z0-9_-]/g, match => `\\${match}`);
}
