import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { baseUrl, localAccount } from "../qa-support.mjs";
import { renderFixture } from "./fixture.mjs";
import { isKnownRuntimeError } from "./runtime-baseline.mjs";

const phase = process.argv[2] ?? "baseline";
assert.ok(["baseline", "refined"].includes(phase), "Use baseline or refined");
const require = createRequire(new URL("../../../server/package.json", import.meta.url));
const puppeteer = require("puppeteer");
const executablePath = puppeteer.executablePath();
assert.ok(!executablePath.includes("headless-shell"), "Use full Chrome, not headless shell");
const collection = JSON.parse(await readFile(new URL("collection.json", import.meta.url), "utf8"));
const calendarDate = collection.startedAt.slice(0, 10);
const account = await localAccount();
const evidenceFile = new URL("layout-evidence.json", import.meta.url);
let evidence = { siteId: collection.siteId, collectionStartedAt: collection.startedAt, runs: {} };
try {
  evidence = JSON.parse(await readFile(evidenceFile, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
evidence.history ??= [];
const previousRun = evidence.runs[phase];
if (
  previousRun &&
  !evidence.history.some(previous => previous.phase === phase && previous.capturedAt === previousRun.capturedAt)
) {
  const archived = structuredClone(previousRun);
  archived.archivedAt = new Date().toISOString();
  const snapshot = `${previousRun.buildLabel ?? phase}-${Date.parse(previousRun.capturedAt).toString(36)}`;
  const screenshotDirectory = new URL("screenshots/", import.meta.url);
  const archivedPaths = new Map();
  for (const filename of await readdir(screenshotDirectory)) {
    if (!filename.startsWith(`layout-${phase}-`) || !filename.endsWith(".png")) continue;
    const original = new URL(filename, screenshotDirectory).pathname;
    const destination = new URL(
      `layout-history-${snapshot}-${filename.slice(`layout-${phase}-`.length)}`,
      screenshotDirectory
    ).pathname;
    await copyFile(original, destination);
    archivedPaths.set(original, destination);
  }
  for (const record of [...archived.measurements, ...archived.checks])
    if (record.screenshotPath)
      record.screenshotPath = archivedPaths.get(record.screenshotPath) ?? record.screenshotPath;
  archived.screenshotFiles = [...archivedPaths.values()];
  evidence.history.push(archived);
  await writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
}
const run = {
  phase,
  capturedAt: new Date().toISOString(),
  buildLabel: process.env.HEATMAP_UI_QA_BUILD ?? null,
  calendarWindow: { startDate: calendarDate, endDate: calendarDate, timeZone: "UTC" },
  source: "Actual local dashboard, normal authenticated APIs, existing live fixture; no CSS overrides or report mocks",
  measurements: [],
  checks: [],
  apiResponses: [],
  runtimeErrors: [],
  runtimeErrorDetails: [],
  failedResources: [],
};
await mkdir(new URL("screenshots/", import.meta.url), { recursive: true });

function reportUrl({ mode = "click", width = 1440, filters = [], match } = {}) {
  const url = new URL(`/${collection.siteId}/heatmaps`, baseUrl);
  for (const [key, value] of Object.entries({
    timeMode: "range",
    startDate: calendarDate,
    endDate: calendarDate,
    heatmap_mode: mode,
    [`heatmap_${mode}_host`]: collection.hostname,
    [`heatmap_${mode}_path`]: "/",
    [`heatmap_${mode}_width`]: String(width),
    ...(filters.length ? { filters: JSON.stringify(filters) } : {}),
    ...(match ? { heatmap_match: match } : {}),
  }))
    url.searchParams.set(key, value);
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

async function waitForReport(page, mode = "click", width = 1440) {
  await page.waitForFunction(
    ({ mode, width }) => {
      const detail = document.querySelector('[aria-label="Heatmap detail"]');
      const overlay = detail?.querySelector(
        mode === "click" ? 'canvas[aria-label="Click intensity"]' : '[aria-label="Scroll reach"]'
      );
      const picker = detail?.querySelector('[aria-label="Viewport width"]');
      return (
        detail?.querySelector("h2")?.textContent === "/" &&
        overlay &&
        (!width || picker?.textContent.includes(`${width} CSS px`))
      );
    },
    { timeout: 30_000 },
    { mode, width }
  );
  const frame = await (await page.waitForSelector('iframe[title="Live page background"]')).contentFrame();
  await frame.waitForSelector('[data-qa="hero-cta"]');
  if (width) assert.equal(await frame.evaluate(() => innerWidth), width);
  await settle(page);
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
    run.runtimeErrors.push(error.message);
    run.runtimeErrorDetails.push({ message: error.message, url: page.url() });
  });
  page.on("response", response => {
    const url = new URL(response.url());
    if (response.status() >= 400)
      run.failedResources.push({ status: response.status(), url: `${url.origin}${url.pathname}` });
    if (url.pathname === `/api/sites/${collection.siteId}/heatmaps`)
      run.apiResponses.push({ status: response.status(), query: Object.fromEntries(url.searchParams) });
  });
  return page;
}

async function measure(page, label) {
  const measurement = await page.evaluate(() => {
    const rect = element => {
      if (!element) return null;
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        top: bounds.top,
        bottom: bounds.bottom,
        left: bounds.left,
        right: bounds.right,
        width: bounds.width,
        height: bounds.height,
        clientWidth: element.clientWidth,
        clientHeight: element.clientHeight,
        scrollWidth: element.scrollWidth,
        scrollHeight: element.scrollHeight,
        scrollTop: element.scrollTop,
        overflowX: style.overflowX,
        overflowY: style.overflowY,
      };
    };
    const scroller = document.querySelector('[role="region"][aria-label="Heatmap page"]');
    const detail = document.querySelector('[aria-label="Heatmap detail"]');
    const previousDate = [...document.querySelectorAll("button")].find(
      element => element.classList.contains("rounded-r-none") && element.querySelector("svg.lucide-chevron-left")
    );
    const dateControls = previousDate?.parentElement.parentElement;
    const labelledLegend =
      document.querySelector('[aria-label="Heatmap intensity legend"]') ??
      document.querySelector('[aria-label*="legend" i]');
    const low = [...document.querySelectorAll("span")].find(element => element.textContent.trim() === "Low");
    const legend = labelledLegend ?? low?.parentElement;
    const ancestors = [];
    for (let element = scroller?.parentElement; element; element = element.parentElement) {
      const bounds = rect(element);
      if (bounds.scrollHeight > bounds.clientHeight + 1 || bounds.scrollWidth > bounds.clientWidth + 1) {
        ancestors.push({
          tag: element.tagName,
          role: element.getAttribute("role"),
          ariaLabel: element.getAttribute("aria-label"),
          className: element.className,
          ...bounds,
        });
      }
    }
    return {
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      scroller: rect(scroller),
      detail: rect(detail),
      dateControls: {
        bounds: rect(dateControls),
        buttons: [...(dateControls?.querySelectorAll("button") ?? [])].map(element => ({
          text: element.textContent.trim(),
          ...rect(element),
        })),
      },
      selectedWidth: document.querySelector('[aria-label="Viewport width"]')?.textContent.trim(),
      legend: { text: legend?.textContent.trim(), bounds: rect(legend), row: rect(legend?.parentElement) },
      outOfViewportControls: [...document.querySelectorAll('button,input,[role="combobox"]')].flatMap(element => {
        const bounds = element.getBoundingClientRect();
        return bounds.width > 0 && bounds.height > 0 && (bounds.right > innerWidth + 1 || bounds.left < 0)
          ? [
              {
                tag: element.tagName,
                text: element.textContent.trim(),
                ariaLabel: element.getAttribute("aria-label"),
                top: bounds.top,
                left: bounds.left,
                right: bounds.right,
                width: bounds.width,
                parentClass: element.parentElement.className,
              },
            ]
          : [];
      }),
      outer: {
        document: rect(document.documentElement),
        body: rect(document.body),
        windowScrollX: scrollX,
        windowScrollY: scrollY,
        overflowAncestors: ancestors,
      },
    };
  });
  const screenshotPath = new URL(`screenshots/layout-${phase}-${label}.png`, import.meta.url).pathname;
  await page.screenshot({ path: screenshotPath, fullPage: false });
  const result = {
    label,
    screenshotPath,
    screenshotPixels: { width: measurement.viewport.width * 2, height: measurement.viewport.height * 2 },
    ...measurement,
  };
  run.measurements.push(result);
  if (phase === "refined") {
    assert.ok(
      result.scroller.top >= 0 && result.scroller.bottom <= result.viewport.height + 1,
      `${label}: scroller stays in viewport`
    );
    assert.equal(result.outOfViewportControls.length, 0, `${label}: controls stay inside viewport`);
    assert.ok(
      result.outer.document.scrollWidth <= result.viewport.width + 1,
      `${label}: no document horizontal overflow`
    );
  }
  console.log(
    JSON.stringify({
      phase,
      label,
      scroller: result.scroller,
      selectedWidth: result.selectedWidth,
      legend: result.legend,
      documentHeight: result.outer.document.scrollHeight,
      overflowAncestors: result.outer.overflowAncestors.length,
    })
  );
  return result;
}

async function checkWidthPopup(page, viewportWidth) {
  await page.click('[aria-label="Viewport width"]');
  await page.waitForSelector('[role="listbox"]', { visible: true });
  await settle(page);
  const popup = await page.$eval('[role="listbox"]', element => {
    const bounds = element.getBoundingClientRect();
    return {
      top: bounds.top,
      bottom: bounds.bottom,
      left: bounds.left,
      right: bounds.right,
      width: bounds.width,
      height: bounds.height,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      options: [...element.querySelectorAll('[role="option"]')].map(option => {
        const bounds = option.getBoundingClientRect();
        return {
          text: option.textContent.trim(),
          left: bounds.left,
          right: bounds.right,
          width: bounds.width,
          clientWidth: option.clientWidth,
          scrollWidth: option.scrollWidth,
        };
      }),
    };
  });
  assert.ok(
    popup.left >= 0 && popup.right <= viewportWidth + 1,
    `${viewportWidth}px width popup stays within viewport`
  );
  assert.ok(popup.scrollWidth <= popup.clientWidth + 1, `${viewportWidth}px popup content does not overflow`);
  assert.equal(popup.options.length, 3, "All three observed widths remain available");
  for (const option of popup.options) {
    assert.ok(
      option.text.includes("CSS px") && option.text.includes("sampled sessions") && option.text.includes("samples"),
      "Width option retains counts"
    );
    assert.ok(
      option.scrollWidth <= option.clientWidth + 1,
      `${viewportWidth}px option text wraps without horizontal overflow`
    );
  }
  await page.screenshot({
    path: new URL(`screenshots/layout-refined-${viewportWidth}-width-popup.png`, import.meta.url).pathname,
    fullPage: false,
  });
  run.checks.push({
    name: `${viewportWidth}px width popup stays on screen with all sample metadata`,
    passed: true,
    popup,
  });
  await page.keyboard.press("Escape");
}

async function chooseWidth(page, width) {
  await page.click('[aria-label="Viewport width"]');
  await page.waitForSelector('[role="option"]', { visible: true });
  for (const option of await page.$$('[role="option"]')) {
    if (await option.evaluate((element, width) => element.textContent.trim().startsWith(`${width} CSS px`), width)) {
      await option.click();
      return;
    }
  }
  throw new Error(`Missing observed width ${width}`);
}

async function reportData({ mode = "click", width = 1440, filters = [], match = "all" } = {}) {
  const query = new URLSearchParams({
    start_date: calendarDate,
    end_date: calendarDate,
    time_zone: "UTC",
    mode,
    hostname: collection.hostname,
    pathname: "/",
    bucket: String(width),
    match,
    ...(filters.length ? { filters: JSON.stringify(filters) } : {}),
  });
  return (await account.call(`/sites/${collection.siteId}/heatmaps?${query}`)).data;
}

async function checkSidebarIdentityOnly(page, mode) {
  const rows = await page.$$eval('aside [aria-label="Pages"] button', buttons =>
    buttons.map(button => ({
      text: button.textContent.trim(),
      children: [...button.children].map(element => element.textContent.trim()),
    }))
  );
  assert.equal(rows.length, 2, "Unfiltered fixture has two pages");
  for (const row of rows) {
    assert.equal(row.children.length, 1, "Single-host page rows contain only the path");
    assert.ok(["/", "/pricing"].includes(row.children[0]));
    assert.ok(!row.text.includes(collection.hostname), "The site hostname is not repeated");
    assert.ok(!/Sampled sessions|Clicks:|Scroll samples:/.test(row.text), "Sidebar does not contain sample metrics");
  }
  run.checks.push({ name: `${mode} single-host sidebar contains only paths`, passed: true, rows });
}

async function checkSampleDetails(page, data, { mode = "click", fullscreen = false, screenshot = false } = {}) {
  const trigger = fullscreen
    ? '[role="dialog"] button[aria-label="Sample details"]'
    : '[aria-label="Heatmap detail"] button[aria-label="Sample details"]';
  await page.click(trigger);
  await page.waitForSelector('[role="dialog"][aria-label="Sample details"]', { visible: true });
  await settle(page);
  const popup = await page.$eval('[role="dialog"][aria-label="Sample details"]', element => {
    const bounds = element.getBoundingClientRect();
    return {
      text: element.textContent.trim(),
      left: bounds.left,
      right: bounds.right,
      top: bounds.top,
      bottom: bounds.bottom,
    };
  });
  assert.ok(popup.text.includes(`Sampled sessions: ${data.sessions.toLocaleString("en-US")}`));
  assert.ok(
    popup.text.includes(`${mode === "click" ? "Clicks" : "Scroll samples"}: ${data.count.toLocaleString("en-US")}`)
  );
  assert.ok(popup.left >= 0 && popup.right <= page.viewport().width + 1, "Sample details stays in viewport");
  if (mode === "scroll")
    assert.equal(data.scroll.totalSessions, data.sessions, "Selected page/bucket denominator matches sampled sessions");
  const screenshotPath = screenshot
    ? new URL("screenshots/layout-refined-sample-details.png", import.meta.url).pathname
    : undefined;
  if (screenshotPath) await page.screenshot({ path: screenshotPath, fullPage: false });
  run.checks.push({
    name: `${fullscreen ? "Fullscreen " : ""}${mode} sample details retains selected page/viewport counts`,
    passed: true,
    selectedPage: data.selectedPage,
    selectedBucket: data.selectedBucket,
    count: data.count,
    sessions: data.sessions,
    ...(mode === "scroll" ? { denominator: data.scroll.totalSessions } : {}),
    popup,
    screenshotPath,
  });
  await page.keyboard.press("Escape");
  await page.waitForSelector('[role="dialog"][aria-label="Sample details"]', { hidden: true });
}

async function chooseMatch(page, label, wireValue) {
  const response = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === `/api/sites/${collection.siteId}/heatmaps` && url.searchParams.get("match") === wireValue;
  });
  await page.click('[aria-label="Match added filters"]');
  await page.waitForSelector('[role="option"]', { visible: true });
  let found = false;
  for (const option of await page.$$('[role="option"]')) {
    if (await option.evaluate((element, label) => element.textContent.trim() === label, label)) {
      await option.click();
      found = true;
      break;
    }
  }
  assert.ok(found, `Missing ${label} option`);
  assert.equal((await response).status(), 200);
}

async function checkConditionalMatching() {
  const page = await newPage({ width: 1680, height: 1050 });
  const filters = [
    { parameter: "hostname", type: "equals", value: [collection.hostname] },
    { parameter: "pathname", type: "equals", value: ["/"] },
  ];
  for (const count of [0, 1, 2]) {
    await page.goto(reportUrl({ filters: filters.slice(0, count) }), { waitUntil: "domcontentloaded" });
    await waitForReport(page);
    await page.waitForFunction(
      count => document.querySelectorAll('[aria-label="Remove filter"]').length === count,
      {},
      count
    );
    assert.equal(await page.$('[aria-label="Match filters"]'), null, "Old toolbar matching control is removed");
    const matching = await page.$('[aria-label="Match added filters"]');
    assert.equal(Boolean(matching), count >= 2, `Matching visibility for ${count} active ad hoc filters`);
    if (matching) {
      assert.equal(await matching.evaluate(element => element.textContent.trim()), "Match all");
      assert.equal(
        await matching.evaluate(
          element => element.parentElement.querySelectorAll('[aria-label="Remove filter"]').length
        ),
        2,
        "Matching is beside active filter chips"
      );
    }
    run.checks.push({ name: `${count} active ad hoc filters ${count >= 2 ? "show" : "hide"} matching`, passed: true });
  }
  await chooseMatch(page, "Match any", "any");
  await page.waitForFunction(
    () => document.querySelector('[aria-label="Match added filters"]')?.textContent.trim() === "Match any"
  );
  for (const count of [1, 0]) {
    await page.click('[aria-label="Remove filter"]');
    await page.waitForFunction(
      count => document.querySelectorAll('[aria-label="Remove filter"]').length === count,
      {},
      count
    );
    assert.equal(
      await page.$eval('[aria-label="Match added filters"]', element => element.textContent.trim()),
      "Match any"
    );
  }
  run.checks.push({ name: "Match any remains visible as active chips are removed", passed: true });
  await page.goto(reportUrl({ match: "any" }), { waitUntil: "domcontentloaded" });
  await waitForReport(page);
  assert.equal(await page.$$eval('[aria-label="Remove filter"]', elements => elements.length), 0);
  assert.equal(
    await page.$eval('[aria-label="Match added filters"]', element => element.textContent.trim()),
    "Match any"
  );
  await chooseMatch(page, "Match all", "all");
  await page.waitForSelector('[aria-label="Match added filters"]', { hidden: true });
  const value = new URL(page.url()).searchParams.get("heatmap_match");
  assert.ok(value === null || value === "all", "Bookmarked any resets in URL");
  run.checks.push({ name: "Zero-filter bookmarked any is visible and resets to all", passed: true });
  await page.close();
}

async function checkMainHeader(viewport) {
  const page = await newPage(viewport);
  const url = new URL(`/${collection.siteId}/main`, baseUrl);
  url.search = new URLSearchParams({ timeMode: "range", startDate: calendarDate, endDate: calendarDate });
  await page.goto(url.href, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() =>
    [...document.querySelectorAll("button")].some(
      element => element.classList.contains("rounded-r-none") && element.querySelector("svg.lucide-chevron-left")
    )
  );
  await settle(page);
  const controls = await page.evaluate(() => {
    const previous = [...document.querySelectorAll("button")].find(
      element => element.classList.contains("rounded-r-none") && element.querySelector("svg.lucide-chevron-left")
    );
    const group = previous.parentElement.parentElement;
    return [...group.querySelectorAll("button")].map(element => {
      const bounds = element.getBoundingClientRect();
      return {
        text: element.textContent.trim(),
        top: bounds.top,
        bottom: bounds.bottom,
        left: bounds.left,
        right: bounds.right,
        width: bounds.width,
        height: bounds.height,
      };
    });
  });
  assert.ok(
    controls.every(bounds => bounds.left >= 0 && bounds.right <= viewport.width + 1),
    `${viewport.width}px Main date/navigation controls stay in viewport`
  );
  if (viewport.width === 375)
    assert.equal(
      new Set(controls.map(bounds => Math.round(bounds.top))).size,
      1,
      "375px Main header retains one control row"
    );
  run.checks.push({ name: `${viewport.width}px actual Main header controls fit`, passed: true, controls });
  await page.close();
}

const browser = await puppeteer.launch({ headless: true, executablePath });
try {
  const clicks = await reportData();
  assert.ok(
    clicks.count > 0 && clicks.points.length > 1,
    "Retained fixture samples must exist in the fixed date range"
  );
  assert.equal(clicks.count, 38, "Selected 1440px fixture retains 38 trusted clicks");
  assert.equal(clicks.sessions, 3, "Selected 1440px fixture retains three sampled sessions");
  run.checks.push({
    name: "Fixed calendar range returns retained samples through normal API",
    passed: true,
    clicks: clicks.count,
    sessions: clicks.sessions,
    points: clicks.points.length,
  });

  for (const viewport of [
    { width: 1680, height: 1050 },
    { width: 375, height: 900 },
  ]) {
    const page = await newPage(viewport);
    await page.goto(reportUrl(), { waitUntil: "domcontentloaded" });
    await waitForReport(page);
    await measure(page, `${viewport.width}x${viewport.height}-click`);
    if (phase === "refined" && viewport.width === 1680) {
      await checkSidebarIdentityOnly(page, "click");
      await checkSampleDetails(page, clicks, { screenshot: true });
      await page.click('[aria-label="Open fullscreen"]');
      await page.waitForSelector('[aria-label="Close fullscreen"]', { visible: true });
      await checkSampleDetails(page, clicks, { fullscreen: true });
      assert.ok(await page.$('[aria-label="Close fullscreen"]'), "Closing the popover preserves fullscreen");
      await page.keyboard.press("Escape");
      await page.waitForSelector('[aria-label="Close fullscreen"]', { hidden: true });
    }
    if (phase === "refined" && viewport.width === 375) {
      await checkWidthPopup(page, viewport.width);
      await chooseWidth(page, 375);
      await waitForReport(page, "click", 375);
      await measure(page, "375x900-native-width-click");
    }
    await page.close();
  }
  if (phase === "refined") {
    for (const viewport of [
      { width: 320, height: 900 },
      { width: 768, height: 900 },
      { width: 1440, height: 900 },
    ]) {
      const page = await newPage(viewport);
      await page.goto(reportUrl(), { waitUntil: "domcontentloaded" });
      await waitForReport(page);
      await measure(page, `${viewport.width}x${viewport.height}-click`);
      if (viewport.width === 320 || viewport.width === 768) await checkWidthPopup(page, viewport.width);
      if (viewport.width === 320) {
        await page.close();
        continue;
      }
      const scrollable = await page.$eval(
        '[role="region"][aria-label="Heatmap page"]',
        element => element.scrollHeight > element.clientHeight + 1
      );
      if (!scrollable) {
        await chooseWidth(page, 375);
        await waitForReport(page, "click", 375);
      }
      const before = await page.$eval('[role="region"][aria-label="Heatmap page"]', element => element.scrollTop);
      await page.focus('[role="region"][aria-label="Heatmap page"]');
      await page.keyboard.press("PageDown");
      await page.waitForFunction(
        before => document.querySelector('[role="region"][aria-label="Heatmap page"]').scrollTop > before,
        {},
        before
      );
      const after = await page.$eval('[role="region"][aria-label="Heatmap page"]', element => element.scrollTop);
      run.checks.push({
        name: `${viewport.width}px keyboard PageDown scrolls the heatmap`,
        passed: true,
        before,
        after,
      });
      await page.$eval('[role="region"][aria-label="Heatmap page"]', element => {
        element.scrollTop = 0;
      });
      const info = await page.$('[aria-label="About live backgrounds"]');
      if (info) {
        await info.focus();
        await page.waitForSelector('[role="tooltip"]', { visible: true });
        run.checks.push({
          name: `${viewport.width}px live background tooltip opens on keyboard focus`,
          passed: true,
          text: await page.$eval('[role="tooltip"]', element => element.textContent),
        });
        await page.keyboard.press("Escape");
      }
      await page.close();
    }
    const page = await newPage({ width: 1680, height: 1050 });
    await page.goto(reportUrl({ mode: "scroll" }), { waitUntil: "domcontentloaded" });
    await waitForReport(page, "scroll");
    const scroll = await reportData({ mode: "scroll" });
    assert.equal(await page.$$eval("[data-depth]", rows => rows.length), 10);
    await measure(page, "1680x1050-scroll");
    await checkSidebarIdentityOnly(page, "scroll");
    await checkSampleDetails(page, scroll, { mode: "scroll" });
    await page.goto(reportUrl(), { waitUntil: "domcontentloaded" });
    await waitForReport(page);
    await page.focus('[aria-label="Heatmap mode"] [role="radio"][aria-checked="true"]');
    await page.keyboard.press("ArrowRight");
    await waitForReport(page, "scroll", null);
    assert.equal(
      await page.$eval('[aria-label="Heatmap mode"] [role="radio"][aria-checked="true"]', element =>
        element.getAttribute("aria-label")
      ),
      "Scroll"
    );
    await page.keyboard.press("ArrowLeft");
    await waitForReport(page);
    assert.equal(
      await page.$eval('[aria-label="Heatmap mode"] [role="radio"][aria-checked="true"]', element =>
        element.getAttribute("aria-label")
      ),
      "Clicks"
    );
    run.checks.push({ name: "Mode radio group ArrowRight/ArrowLeft changes mode and restores Clicks", passed: true });
    run.checks.push({ name: "Scroll mode retains ten inclusive reach bands and intensity legend", passed: true });
    await page.close();
    await checkConditionalMatching();
    for (const viewport of [
      { width: 320, height: 900 },
      { width: 375, height: 900 },
    ])
      await checkMainHeader(viewport);
    const mobile = run.measurements.find(measurement => measurement.label === "375x900-click");
    assert.equal(
      new Set(mobile.dateControls.buttons.map(bounds => Math.round(bounds.top))).size,
      1,
      "375px heatmap header retains one control row"
    );
    run.checks.push({
      name: "375px heatmap header has one date/navigation control row",
      passed: true,
      bounds: mobile.dateControls,
    });
  }
  const baselineErrors = new Set(evidence.runs.baseline?.runtimeErrors ?? []);
  run.newRuntimeErrors =
    phase === "refined"
      ? run.runtimeErrorDetails.filter(
          error => !baselineErrors.has(error.message) && !isKnownRuntimeError(error, collection.siteId)
        )
      : [];
  run.knownEnvironmentErrors = run.runtimeErrors.filter(error =>
    error.includes("Please call Stripe() with your publishable key. You used an empty string.")
  );
  if (phase === "refined")
    assert.equal(run.newRuntimeErrors.length, 0, "No new runtime errors relative to the captured baseline");
  assert.equal(
    run.apiResponses.filter(response => response.status !== 200).length,
    0,
    "Normal report API requests succeed"
  );
  assert.ok(
    run.apiResponses.every(
      response => response.query.start_date === calendarDate && response.query.end_date === calendarDate
    ),
    "UI uses the fixed calendar window"
  );
  run.status = "passed";
} catch (error) {
  run.status = "failed";
  run.failure = error.stack;
  throw error;
} finally {
  run.completedAt = new Date().toISOString();
  evidence.runs[phase] = run;
  await writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
  await browser.close();
}
