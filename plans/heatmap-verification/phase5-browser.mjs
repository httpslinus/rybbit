import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { baseUrl, interceptFixture, localAccount } from "./qa-support.mjs";

const require = createRequire(new URL("../../server/package.json", import.meta.url));
const puppeteer = require("puppeteer");
const account = await localAccount();
const source = JSON.parse(await readFile(new URL("collection-evidence.json", import.meta.url), "utf8"));
assert.equal(account.siteId, source.siteId);
const evidenceFile = new URL("phase5-browser-evidence.json", import.meta.url);
const screenshotDirectory = new URL("evidence/", import.meta.url);
await mkdir(screenshotDirectory, { recursive: true });
const prefix = `Phase5 UI ${randomBytes(5).toString("hex")}`;
const user = { parameter: "user_id", type: "equals", value: ["responsive-375"] };
const neverEvent = { parameter: "event_name", type: "equals", value: [`${prefix} never recorded`] };
const day = new Date().toISOString().slice(0, 10);
const ownedCohorts = new Set();
const pendingObservations = new Set();
const window = { past_minutes_start: 120, past_minutes_end: 0, time_zone: "UTC" };
const selection = { mode: "click", hostname: "qa.heatmap.test", pathname: "/a", bucket: 375 };
const evidence = {
  siteId: account.siteId,
  source:
    "Real prior trusted browser samples; normal report/cohort APIs, no substituted responses or synthetic analytics",
  startedAt: new Date().toISOString(),
  steps: [],
  reportResponses: [],
  cohortRequests: [],
  runtimeErrors: [],
  consoleErrors: [],
  baselineErrors: [],
  screenshots: [],
  cleanup: [],
  backgroundUploads: 0,
  passed: false,
};
let currentStep = "source preflight";
let browser;

function reportUrl({ filters = [user], match = "all", eventType, excludeBounce = false, cohortId } = {}) {
  const url = new URL(`/${account.siteId}/heatmaps`, baseUrl);
  const values = {
    timeMode: "past-minutes",
    past_minutes_start: 120,
    past_minutes_end: 0,
    filters: JSON.stringify(filters),
    heatmap_mode: "click",
    heatmap_click_host: "qa.heatmap.test",
    heatmap_click_path: "/a",
    heatmap_click_width: 375,
    heatmap_match: match,
    heatmap_event_type: eventType,
    heatmap_exclude_bounce: excludeBounce ? "true" : undefined,
    heatmap_cohort: cohortId,
  };
  for (const [key, value] of Object.entries(values)) if (value !== undefined) url.searchParams.set(key, String(value));
  return url.href;
}

const summary = report => ({ count: report.count, sessions: report.sessions, points: report.points });
const filterSummary = report => ({
  ...summary(report),
  pageClicks: report.pages.reduce((total, page) => total + page.count, 0),
});
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function apiReport(extra = {}) {
  const params = { ...window, ...selection, match: "all", filters: JSON.stringify([user]), ...extra };
  const query = new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)]));
  return (await account.call(`/sites/${account.siteId}/heatmaps?${query}`)).data;
}

async function frames(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

function observe(promise) {
  pendingObservations.add(promise);
  promise.finally(() => pendingObservations.delete(promise));
}

async function newPage({ width = 1680, baseline = false } = {}) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width, height: width === 375 ? 900 : 1000, deviceScaleFactor: 2 });
  await page.emulateTimezone("UTC");
  await page.setCookie(
    ...account.cookies.map(cookie => ({
      ...cookie,
      path: "/",
      secure: cookie.name.startsWith("__Secure-") || cookie.name.startsWith("__Host-"),
    }))
  );
  await page.evaluateOnNewDocument(() => {
    if (globalThis === globalThis.top) {
      localStorage.setItem("theme", "light");
      localStorage.setItem("rybbit-store", JSON.stringify({ state: { timezone: "UTC" }, version: 0 }));
    }
  });
  await interceptFixture(page, account.siteId, false);
  const state = { page, context, responses: [] };
  page.on("pageerror", error => {
    const record = { step: currentStep, message: error.message, url: page.url() };
    (baseline ? evidence.baselineErrors : evidence.runtimeErrors).push(record);
  });
  page.on("console", message => {
    if (message.type() === "error")
      evidence.consoleErrors.push({ step: currentStep, baseline, message: message.text() });
  });
  page.on("request", request => {
    if (request.url().includes("/heatmaps/record/")) evidence.backgroundUploads++;
    const url = new URL(request.url());
    if (url.pathname.startsWith(`/api/sites/${account.siteId}/cohorts`) && request.method() !== "GET") {
      evidence.cohortRequests.push({
        method: request.method(),
        path: url.pathname,
        body: request.postData() ? JSON.parse(request.postData()) : null,
      });
    }
  });
  page.on("response", response => {
    const url = new URL(response.url());
    if (url.pathname === `/api/sites/${account.siteId}/heatmaps`) {
      observe(
        (async () => {
          const body = await response.json().catch(() => null);
          const record = { status: response.status(), query: Object.fromEntries(url.searchParams), body };
          state.responses.push(record);
          evidence.reportResponses.push({
            step: currentStep,
            status: record.status,
            query: record.query,
            ...(body?.data ? { ...filterSummary(body.data), cohort: body.data.cohort } : { error: body }),
          });
        })()
      );
    }
    if (
      url.pathname === `/api/sites/${account.siteId}/cohorts` &&
      response.request().method() === "POST" &&
      response.ok()
    ) {
      observe(
        (async () => {
          const created = await response.json();
          if (created.name?.startsWith(prefix)) ownedCohorts.add(created.cohortId);
        })()
      );
    }
  });
  return state;
}

function matches(record, { filters = [user], match = "all", eventType, excludeBounce = false, cohortId } = {}) {
  const params = record.query;
  return (
    params.past_minutes_start === "120" &&
    params.past_minutes_end === "0" &&
    params.time_zone === "UTC" &&
    params.mode === "click" &&
    params.hostname === selection.hostname &&
    params.pathname === selection.pathname &&
    params.bucket === "375" &&
    params.match === match &&
    params.analytics_event_type === eventType &&
    params.exclude_bounce === (excludeBounce ? "true" : undefined) &&
    params.cohort_id === (cohortId === undefined ? undefined : String(cohortId)) &&
    JSON.stringify(JSON.parse(params.filters || "[]")) === JSON.stringify(filters)
  );
}

async function reportResponse(state, expected = {}, { after = 0, status = 200 } = {}) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const record = state.responses.slice(after).findLast(item => matches(item, expected));
    if (record) {
      assert.equal(record.status, status, `Unexpected report response: ${JSON.stringify(record)}`);
      await frames(state.page);
      return record.body?.data ?? record.body;
    }
    await sleep(50);
  }
  throw new Error(
    `No normal report response for ${JSON.stringify(expected)}; observed ${JSON.stringify(state.responses)}`
  );
}

async function compareReport(state, expected, apiExtra = {}, options = {}) {
  const rendered = await reportResponse(state, expected, options);
  const direct = await apiReport(apiExtra);
  assert.deepEqual(filterSummary(rendered), filterSummary(direct));
  if (rendered.count > 0) {
    await state.page.waitForSelector('canvas[aria-label="Click intensity"]', { visible: true });
    await state.page.waitForFunction(() =>
      document.querySelector('[aria-label="Viewport width"]')?.textContent.includes("375 CSS px")
    );
  } else {
    await state.page.waitForSelector('canvas[aria-label="Click intensity"]', { hidden: true });
  }
  return rendered;
}

async function clickText(page, selector, text, { keyboard = false } = {}) {
  for (const element of await page.$$(selector)) {
    if (
      !(await element.isVisible()) ||
      !(await element.evaluate((node, text) => node.textContent.trim() === text, text))
    )
      continue;
    if (keyboard) {
      await element.focus();
      await page.keyboard.press("Enter");
    } else await element.click();
    return;
  }
  throw new Error(`Visible ${selector} with ${JSON.stringify(text)} was not found`);
}

async function selectKeyboard(page, label, optionText) {
  const trigger = await page.waitForSelector(`[aria-label="${label}"]`, { visible: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await page.waitForSelector('[role="option"]', { visible: true });
  const options = await page.$$('[role="option"]');
  for (const option of options) {
    if (!(await option.evaluate((element, text) => element.textContent.trim() === text, optionText))) continue;
    await option.focus();
    await page.keyboard.press("Enter");
    return;
  }
  throw new Error(`Keyboard option ${optionText} missing from ${label}`);
}

async function labelledInput(page, label) {
  const handle = await page.evaluateHandle(label => {
    const element = [...document.querySelectorAll('[role="dialog"] label')].find(
      item => item.textContent.trim() === label
    );
    return element?.control ?? null;
  }, label);
  const element = handle.asElement();
  assert.ok(element, `Dialog input ${label} is missing its accessible label`);
  return element;
}

async function setInput(page, label, value) {
  const input = await labelledInput(page, label);
  if ((await input.evaluate(element => element.type)) === "date") {
    await input.evaluate((element, value) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    }, value);
  } else {
    await input.click({ clickCount: 3 });
    await page.keyboard.press("Backspace");
    await input.type(value);
  }
  assert.equal(await input.evaluate(element => element.value), value);
}

async function screenshot(page, name) {
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        animation => animation.playState !== "running" || animation.effect?.getComputedTiming().iterations === Infinity
      )
  );
  await page.screenshot({ path: new URL(name, screenshotDirectory).pathname, fullPage: false });
  evidence.screenshots.push(`plans/heatmap-verification/evidence/${name}`);
}

function assertUrl(page, expected) {
  const params = new URL(page.url()).searchParams;
  for (const [key, value] of Object.entries(expected))
    assert.equal(params.get(key), value === null ? null : String(value), `URL dropped ${key}`);
}

async function waitCohortUrl(page) {
  await page.waitForFunction(() => Number(new URL(location.href).searchParams.get("heatmap_cohort")) > 0);
  const cohortId = Number(new URL(page.url()).searchParams.get("heatmap_cohort"));
  assert.ok(Number.isInteger(cohortId) && cohortId > 0);
  ownedCohorts.add(cohortId);
  return cohortId;
}

try {
  const original = await apiReport();
  assert.ok(
    original.count > 0,
    "Prior real /a375 samples expired; coordinate the real collector rather than substituting reports"
  );
  const sessionsQuery = new URLSearchParams({
    ...Object.fromEntries(Object.entries(window).map(([key, value]) => [key, String(value)])),
    filters: JSON.stringify([user]),
    limit: "100",
  });
  const ordinary = (await account.call(`/sites/${account.siteId}/sessions?${sessionsQuery}`)).data;
  assert.ok(
    ordinary.some(session => session.identified_user_id === "responsive-375" && session.pageviews > 0),
    "Historical membership requires real identified ordinary analytics"
  );
  evidence.steps.push({
    check: "Real source preflight",
    ...summary(original),
    ordinarySessions: ordinary.map(({ pageviews, events }) => ({ pageviews, events })),
  });
  browser = await puppeteer.launch({ headless: true });

  currentStep = "independent existing-client runtime baseline";
  const baseline = await newPage({ baseline: true });
  const baselineUrl = new URL(`/${account.siteId}/main`, baseUrl);
  baselineUrl.searchParams.set("timeMode", "past-minutes");
  baselineUrl.searchParams.set("past_minutes_start", "120");
  baselineUrl.searchParams.set("past_minutes_end", "0");
  assert.equal((await baseline.page.goto(baselineUrl.href, { waitUntil: "networkidle0" })).status(), 200);
  await baseline.context.close();

  currentStep = "cold advanced URL hydration and wire params";
  const state = await newPage();
  const advanced = { filters: [user, neverEvent], match: "any", eventType: "pageview", excludeBounce: true };
  await state.page.goto(reportUrl(advanced), { waitUntil: "domcontentloaded" });
  const advancedData = await compareReport(state, advanced, {
    filters: JSON.stringify(advanced.filters),
    match: "any",
    analytics_event_type: "pageview",
    exclude_bounce: "true",
  });
  await state.page.waitForFunction(
    () =>
      document.querySelector('[aria-label="Match filters"]')?.textContent.includes("Any filter") &&
      document.querySelector('[aria-label="Analytics event type"]')?.textContent.includes("Pageviews") &&
      document.querySelector('[aria-label="Exclude bounced sessions"]')?.getAttribute("aria-checked") === "true"
  );
  assertUrl(state.page, {
    heatmap_match: "any",
    heatmap_event_type: "pageview",
    heatmap_exclude_bounce: "true",
    filters: JSON.stringify(advanced.filters),
  });
  const reloadAfter = state.responses.length;
  await state.page.reload({ waitUntil: "domcontentloaded" });
  await compareReport(
    state,
    advanced,
    {
      filters: JSON.stringify(advanced.filters),
      match: "any",
      analytics_event_type: "pageview",
      exclude_bounce: "true",
    },
    { after: reloadAfter }
  );
  evidence.steps.push({
    check: "Cold advanced URL persists across reload and uses exact wire params",
    ...filterSummary(advancedData),
  });

  currentStep = "keyboard filters and ordinary-event controls";
  await state.page.click('[aria-label="Exclude bounced sessions"]');
  const anyData = await compareReport(
    state,
    { ...advanced, excludeBounce: false },
    { filters: JSON.stringify(advanced.filters), match: "any", analytics_event_type: "pageview" }
  );
  assert.ok(anyData.count > 0);
  await selectKeyboard(state.page, "Match filters", "All filters");
  const allData = await compareReport(
    state,
    { ...advanced, match: "all", excludeBounce: false },
    { filters: JSON.stringify(advanced.filters), match: "all", analytics_event_type: "pageview" }
  );
  assert.equal(allData.count, 0);
  await selectKeyboard(state.page, "Match filters", "Any filter");
  await compareReport(
    state,
    { ...advanced, excludeBounce: false },
    { filters: JSON.stringify(advanced.filters), match: "any", analytics_event_type: "pageview" }
  );
  await selectKeyboard(state.page, "Analytics event type", "Custom events");
  const custom = await compareReport(
    state,
    { ...advanced, eventType: "custom_event", excludeBounce: false },
    { filters: JSON.stringify(advanced.filters), match: "any", analytics_event_type: "custom_event" }
  );
  assert.equal(custom.count, 0);
  assertUrl(state.page, {
    heatmap_mode: "click",
    heatmap_event_type: "custom_event",
    heatmap_match: "any",
    heatmap_exclude_bounce: null,
  });
  await selectKeyboard(state.page, "Analytics event type", "Pageviews");
  await compareReport(
    state,
    { ...advanced, excludeBounce: false },
    { filters: JSON.stringify(advanced.filters), match: "any", analytics_event_type: "pageview" }
  );
  await state.page.click('[aria-label="Exclude bounced sessions"]');
  const nonBounce = await compareReport(state, advanced, {
    filters: JSON.stringify(advanced.filters),
    match: "any",
    analytics_event_type: "pageview",
    exclude_bounce: "true",
  });
  assert.ok(nonBounce.count <= anyData.count);
  evidence.steps.push({
    check: "Keyboard all/any and event selectors; bounce switch uses distinct current requests",
    anyClicks: anyData.count,
    allClicks: allData.count,
    customClicks: custom.count,
    nonBounceClicks: nonBounce.count,
  });
  await state.context.close();

  currentStep = "create historical cohort through normal UI";
  const cohortPage = await newPage();
  await cohortPage.page.goto(reportUrl(), { waitUntil: "domcontentloaded" });
  await compareReport(cohortPage, {});
  await clickText(cohortPage.page, "button", "New cohort", { keyboard: true });
  await cohortPage.page.waitForSelector('[role="dialog"]', { visible: true });
  assert.ok(
    await cohortPage.page.$eval(
      '[role="dialog"]',
      element =>
        element.textContent.includes("Historical filters") &&
        element.textContent.includes("responsive-375") &&
        element.textContent.includes("Every historical filter must match.")
    )
  );
  await setInput(cohortPage.page, "Name", prefix);
  await setInput(cohortPage.page, "Historical start date", day);
  await setInput(cohortPage.page, "Historical end date", day);
  await setInput(cohortPage.page, "Timezone", "UTC");
  await screenshot(cohortPage.page, "phase5-cohort-create-desktop.png");
  await clickText(cohortPage.page, '[role="dialog"] button', "Save cohort", { keyboard: true });
  const cohortId = await waitCohortUrl(cohortPage.page);
  await cohortPage.page.waitForSelector('[role="dialog"]', { hidden: true });
  const saved = await account.call(`/sites/${account.siteId}/cohorts/${cohortId}`);
  assert.deepEqual(
    {
      name: saved.name,
      startDate: saved.startDate,
      endDate: saved.endDate,
      timeZone: saved.timeZone,
      filters: saved.filters,
    },
    { name: prefix, startDate: day, endDate: day, timeZone: "UTC", filters: [user] }
  );
  const cohortData = await compareReport(cohortPage, { cohortId }, { cohort_id: cohortId });
  assert.equal(cohortData.cohort.members, 1);
  assert.deepEqual(summary(cohortData), summary(original));
  evidence.steps.push({
    check: "UI cohort save copies reviewed filters; actual history yields one member",
    cohortId,
    members: cohortData.cohort.members,
    ...summary(cohortData),
  });

  currentStep = "edit cohort dates and timezone with query invalidation";
  await cohortPage.page.click('[aria-label="Edit cohort"]');
  await cohortPage.page.waitForSelector('[role="dialog"]', { visible: true });
  assert.equal(
    await (await labelledInput(cohortPage.page, "Historical start date")).evaluate(element => element.value),
    day
  );
  const renamed = `${prefix} edited`;
  await setInput(cohortPage.page, "Name", renamed);
  await setInput(cohortPage.page, "Timezone", "Europe/Tirane");
  const editAfter = cohortPage.responses.length;
  await clickText(cohortPage.page, '[role="dialog"] button', "Save changes", { keyboard: true });
  await cohortPage.page.waitForSelector('[role="dialog"]', { hidden: true });
  const edited = await compareReport(cohortPage, { cohortId }, { cohort_id: cohortId }, { after: editAfter });
  assert.equal(edited.cohort.name, renamed);
  assert.equal(edited.cohort.timeZone, "Europe/Tirane");
  assert.equal(edited.cohort.members, 1);
  assert.deepEqual(summary(edited), summary(original));
  evidence.steps.push({
    check: "Editing cohort invalidates current report using historical timezone",
    cohortId,
    name: renamed,
    timeZone: edited.cohort.timeZone,
    count: edited.count,
  });
  await cohortPage.context.close();

  currentStep = "phone cohort controls and editor usability";
  const phone = await newPage({ width: 375 });
  await phone.page.goto(reportUrl({ cohortId }), { waitUntil: "domcontentloaded" });
  await compareReport(phone, { cohortId }, { cohort_id: cohortId });
  assert.ok(
    await phone.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    "Advanced phone controls overflow horizontally"
  );
  await phone.page.waitForFunction(
    name => document.querySelector('[aria-label="Cohort"]')?.textContent.includes(name),
    {},
    renamed
  );
  await screenshot(phone.page, "phase5-phone-selected-cohort.png");
  await (await phone.page.$('[aria-label="Edit cohort"]')).focus();
  await phone.page.keyboard.press("Enter");
  const dialog = await phone.page.waitForSelector('[role="dialog"]', { visible: true });
  const bounds = await dialog.boundingBox();
  assert.ok(
    bounds.width <= 375 && bounds.height <= 811 && bounds.x >= 0 && bounds.y >= 0,
    `Phone cohort dialog does not fit: ${JSON.stringify(bounds)}`
  );
  assert.equal(await (await labelledInput(phone.page, "Timezone")).evaluate(element => element.value), "Europe/Tirane");
  await screenshot(phone.page, "phase5-phone-cohort-editor.png");
  await phone.page.keyboard.press("Escape");
  await phone.page.waitForSelector('[role="dialog"]', { hidden: true });
  assertUrl(phone.page, { heatmap_cohort: cohortId });
  evidence.steps.push({
    check: "Phone selected cohort and labelled editor fit, keyboard Escape preserves selection",
    bounds,
  });

  currentStep = "expired cohort retains selection and zero report";
  await phone.page.click('[aria-label="Edit cohort"]');
  await phone.page.waitForSelector('[role="dialog"]', { visible: true });
  await setInput(phone.page, "Name", `${prefix} expired`);
  await setInput(phone.page, "Historical start date", "2000-01-01");
  await setInput(phone.page, "Historical end date", "2000-01-31");
  const expiredAfter = phone.responses.length;
  await clickText(phone.page, '[role="dialog"] button', "Save changes", { keyboard: true });
  await phone.page.waitForSelector('[role="dialog"]', { hidden: true });
  const expired = await compareReport(phone, { cohortId }, { cohort_id: cohortId }, { after: expiredAfter });
  assert.equal(expired.cohort.members, 0);
  assert.equal(expired.count, 0);
  assert.equal(expired.sessions, 0);
  assert.deepEqual(expired.points, []);
  assert.deepEqual(expired.pages, []);
  await phone.page.waitForFunction(() =>
    document.body.textContent.includes(
      "No matching visitors in retained historical analytics. Choose another cohort or historical window."
    )
  );
  assertUrl(phone.page, { heatmap_cohort: cohortId, heatmap_click_path: "/a", heatmap_click_width: 375 });
  const expiredReloadAfter = phone.responses.length;
  await phone.page.reload({ waitUntil: "domcontentloaded" });
  await compareReport(phone, { cohortId }, { cohort_id: cohortId }, { after: expiredReloadAfter });
  assertUrl(phone.page, { heatmap_cohort: cohortId });
  await screenshot(phone.page, "phase5-phone-expired-cohort.png");
  evidence.steps.push({
    check: "Expired retained history remains selected across cold reload with zero visitors/samples",
    cohortId,
    members: 0,
    count: 0,
  });

  currentStep = "delete only harness cohort through UI";
  await phone.page.click('[aria-label="Edit cohort"]');
  await phone.page.waitForSelector('[role="dialog"]', { visible: true });
  const deleteAfter = phone.responses.length;
  await clickText(phone.page, '[role="dialog"] button', "Delete cohort", { keyboard: true });
  await phone.page.waitForSelector('[role="dialog"]', { hidden: true });
  await phone.page.waitForFunction(() => !new URL(location.href).searchParams.has("heatmap_cohort"));
  await compareReport(phone, {}, {}, { after: deleteAfter });
  assert.ok(!(await account.call(`/sites/${account.siteId}/cohorts`)).some(item => item.cohortId === cohortId));
  ownedCohorts.delete(cohortId);
  evidence.cleanup.push({ cohortId, via: "UI", success: true });
  evidence.steps.push({ check: "UI deletion removes definition and clears only the cohort selection", cohortId });
  await phone.context.close();

  currentStep = "missing cohort is a persistent query error, never all visitors";
  const missing = await newPage({ width: 375 });
  await missing.page.goto(reportUrl({ cohortId }), { waitUntil: "domcontentloaded" });
  const missingResult = await reportResponse(missing, { cohortId }, { status: 404 });
  assert.equal(missingResult.error, "Cohort not found");
  await missing.page.waitForFunction(
    () =>
      document.body.textContent.includes("Cohort unavailable") &&
      document.body.textContent.includes("Unable to load heatmaps")
  );
  assertUrl(missing.page, { heatmap_cohort: cohortId });
  assert.equal(await missing.page.$('canvas[aria-label="Click intensity"]'), null);
  assert.ok(
    missing.responses.every(record => record.query.cohort_id === String(cohortId)),
    "Missing cohort triggered an unfiltered fallback request"
  );
  await screenshot(missing.page, "phase5-phone-missing-cohort.png");
  evidence.steps.push({
    check: "Deleted/missing cohort retains URL and404 query error without fallback report",
    cohortId,
    status: 404,
  });
  await missing.context.close();

  await Promise.allSettled([...pendingObservations]);
  assert.equal(evidence.backgroundUploads, 0);
  const stripeError =
    "Uncaught (in promise) IntegrationError: Please call Stripe() with your publishable key. You used an empty string.";
  const stripeProven = evidence.baselineErrors.some(error => error.message === stripeError);
  const newErrors = evidence.runtimeErrors.filter(error => !stripeProven || error.message !== stripeError);
  assert.deepEqual(newErrors, [], "Advanced heatmap controls introduced runtime/hydration errors");
  evidence.provenExistingStripeError = {
    reproducedOnMain: stripeProven,
    reportCount: evidence.runtimeErrors.filter(error => error.message === stripeError).length,
  };
  evidence.passed = true;
} catch (error) {
  evidence.failure = { step: currentStep, name: error.name, message: error.message };
  throw error;
} finally {
  await Promise.allSettled([...pendingObservations]);
  for (const cohortId of ownedCohorts) {
    try {
      await account.call(`/sites/${account.siteId}/cohorts/${cohortId}`, undefined, "DELETE");
      evidence.cleanup.push({ cohortId, via: "failure cleanup API", success: true });
    } catch (error) {
      evidence.cleanup.push({ cohortId, success: false, message: error.message });
      evidence.passed = false;
    }
  }
  if (browser) await browser.close();
  evidence.finishedAt = new Date().toISOString();
  await writeFile(evidenceFile, JSON.stringify(evidence, null, 2));
}
assert.ok(evidence.passed, "Browser gate or cleanup failed");
console.log(
  JSON.stringify({
    passed: true,
    checks: evidence.steps.length,
    reportResponses: evidence.reportResponses.length,
    screenshots: evidence.screenshots.length,
    evidence: evidenceFile.pathname,
  })
);
