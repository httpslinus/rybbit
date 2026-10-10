import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { baseUrl, interceptFixture, localAccount } from "./qa-support.mjs";

const require = createRequire(new URL("../../server/package.json", import.meta.url));
const puppeteer = require("puppeteer");
const evidenceFile = new URL("fix-ui-browser-evidence.json", import.meta.url);
const suffix = randomBytes(5).toString("hex");
const day = "2026-10-10";
const evidence = {
  source:
    "Local production build, authenticated real cohort/site/report APIs; requests delayed but responses never substituted",
  startedAt: new Date().toISOString(),
  checks: [],
  requests: [],
  reports: [],
  metadata: [],
  runtimeErrors: [],
  baselineErrors: [],
  cleanup: [],
  passed: false,
};
const ownedCohorts = new Set();
const observations = new Set();
let account,
  browser,
  page,
  secondSiteId,
  currentStep = "setup",
  unblockMetadata;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function poll(predicate, label) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(50);
  }
  throw new Error(`Timed out: ${label}`);
}
async function clickText(page, selector, text, keyboard = false, contains = false) {
  for (const element of await page.$$(selector)) {
    if (
      !(await element.isVisible()) ||
      !(await element.evaluate(
        (node, { text, contains }) =>
          contains ? node.textContent.trim().includes(text) : node.textContent.trim() === text,
        { text, contains }
      ))
    )
      continue;
    if (keyboard) {
      await element.focus();
      await page.keyboard.press("Enter");
    } else await element.click();
    return;
  }
  const visibleLabels = [];
  for (const element of await page.$$(selector))
    if (await element.isVisible()) {
      const label = await element.evaluate(node => node.textContent.trim());
      visibleLabels.push(label.includes("@") ? "[redacted account label]" : label);
    }
  throw new Error(`Visible ${selector} ${text} missing; candidates ${JSON.stringify(visibleLabels)}`);
}
const observe = promise => {
  observations.add(promise);
  promise.finally(() => observations.delete(promise));
};
function reportUrl(cohortId) {
  const url = new URL(`/${account.siteId}/heatmaps`, baseUrl);
  const params = {
    timeMode: "day",
    day,
    compare: "none",
    filters: "[]",
    heatmap_mode: "click",
    heatmap_click_host: "qa.heatmap.test",
    heatmap_click_path: "/a",
    heatmap_click_width: 375,
    heatmap_scroll_host: "qa.heatmap.test",
    heatmap_scroll_path: "/b",
    heatmap_scroll_width: 768,
    heatmap_cohort: cohortId,
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url.href;
}

try {
  account = await localAccount();
  evidence.sourceSiteId = account.siteId;
  const cohortBody = {
    startDate: day,
    endDate: day,
    timeZone: "UTC",
    filters: [{ parameter: "user_id", type: "equals", value: ["responsive-375"] }],
  };
  const a = await account.call(`/sites/${account.siteId}/cohorts`, { ...cohortBody, name: `Fix UI A ${suffix}` });
  ownedCohorts.add(a.cohortId);
  const b = await account.call(`/sites/${account.siteId}/cohorts`, { ...cohortBody, name: `Fix UI B ${suffix}` });
  ownedCohorts.add(b.cohortId);
  const second = await account.call(`/organizations/${account.organizationId}/sites`, {
    domain: `fix-ui-${suffix}.heatmap.test`,
    name: `Fix UI second ${suffix}`,
    blockBots: false,
    saltUserIds: false,
  });
  secondSiteId = evidence.destinationSiteId = second.siteId;
  await account.call(`/sites/${secondSiteId}/config`, { heatmaps: true, heatmapSampleRate: 100 }, "PUT");
  browser = await puppeteer.launch({ headless: true });
  const context = await browser.createBrowserContext();
  page = await context.newPage();
  await page.setViewport({ width: 1680, height: 1000, deviceScaleFactor: 2 });
  await page.emulateTimezone("UTC");
  await page.setCookie(
    ...account.cookies.map(cookie => ({
      ...cookie,
      path: "/",
      secure: cookie.name.startsWith("__Secure-") || cookie.name.startsWith("__Host-"),
    }))
  );
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem("theme", "dark");
    localStorage.setItem("rybbit-store", JSON.stringify({ state: { timezone: "UTC" }, version: 0 }));
  });
  let holdMetadata = false,
    metadataHeld = false;
  const metadataGate = new Promise(resolve => {
    unblockMetadata = resolve;
  });
  await interceptFixture(page, account.siteId, false, async request => {
    const url = new URL(request.url());
    if (holdMetadata && url.pathname === `/api/sites/${secondSiteId}` && request.method() === "GET") {
      metadataHeld = true;
      await metadataGate;
    }
  });
  page.on("pageerror", error =>
    (currentStep === "baseline main" ? evidence.baselineErrors : evidence.runtimeErrors).push({
      step: currentStep,
      message: error.message,
    })
  );
  page.on("request", request => {
    const url = new URL(request.url());
    if (
      url.pathname.startsWith("/api/sites/") &&
      (url.pathname.endsWith("/heatmaps") || url.pathname.includes("/cohorts"))
    )
      evidence.requests.push({
        step: currentStep,
        siteId: Number(url.pathname.split("/")[3]),
        method: request.method(),
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
      });
  });
  page.on("response", response => {
    const url = new URL(response.url());
    if (url.pathname.endsWith("/heatmaps") && url.pathname.startsWith("/api/sites/"))
      observe(
        (async () => {
          const body = await response.json().catch(() => null);
          evidence.reports.push({
            step: currentStep,
            siteId: Number(url.pathname.split("/")[3]),
            status: response.status(),
            query: Object.fromEntries(url.searchParams),
            selectedPage: body?.data?.selectedPage,
            count: body?.data?.count,
            cohortId: body?.data?.cohort?.cohortId,
            error: body?.error,
          });
        })()
      );
    if ([`/api/sites/${account.siteId}`, `/api/sites/${secondSiteId}`].includes(url.pathname))
      observe(
        (async () => {
          const body = await response.json().catch(() => null);
          evidence.metadata.push({
            siteId: body?.siteId,
            status: response.status(),
            heatmaps: body?.heatmaps,
            hasHeatmapRead: body?.permissions?.includes("heatmaps:read"),
          });
        })()
      );
  });
  currentStep = "baseline main";
  await page.goto(`${baseUrl}/${account.siteId}`, { waitUntil: "networkidle0" });
  currentStep = "selected cohort A";
  await page.goto(reportUrl(a.cohortId), { waitUntil: "networkidle0" });
  await page.waitForSelector('canvas[aria-label="Click intensity"]', { visible: true });
  await poll(
    () =>
      evidence.reports.some(
        report =>
          report.siteId === account.siteId && !report.query.view && report.cohortId === a.cohortId && report.count > 0
      ),
    "real cohort A detail"
  );
  const reportA = evidence.reports.findLast(
    report => report.siteId === account.siteId && !report.query.view && report.cohortId === a.cohortId
  );
  currentStep = "keyboard unrelated cohort B actions";
  await clickText(page, "button", "Filter", true);
  await clickText(page, '[role="tab"]', "Cohorts", true);
  const bOption = await page.evaluateHandle(
    name =>
      [...document.querySelectorAll('[role="option"]')]
        .find(element => element.textContent.trim() === name)
        ?.querySelector('[aria-label="Cohort actions"]'),
    b.name
  );
  const bActions = bOption.asElement();
  assert.ok(bActions, "Cohort B actions missing");
  await bActions.focus();
  await page.keyboard.press("Enter");
  await page.waitForSelector('[role="menuitem"]', { visible: true });
  assert.equal(
    new URL(page.url()).searchParams.get("heatmap_cohort"),
    String(a.cohortId),
    "Opening B actions changed selection"
  );
  await clickText(page, '[role="menuitem"]', "Edit cohort", true);
  await page.waitForSelector('[role="dialog"] form', { visible: true });
  assert.equal(
    new URL(page.url()).searchParams.get("heatmap_cohort"),
    String(a.cohortId),
    "Editing B changed selection"
  );
  const deleted = page.waitForResponse(
    response =>
      new URL(response.url()).pathname === `/api/sites/${account.siteId}/cohorts/${b.cohortId}` &&
      response.request().method() === "DELETE"
  );
  await clickText(page, "button", "Delete cohort", true);
  assert.equal((await deleted).status(), 200);
  ownedCohorts.delete(b.cohortId);
  await page.waitForSelector('[role="dialog"] form', { hidden: true });
  await page.waitForSelector('canvas[aria-label="Click intensity"]', { visible: true });
  assert.equal(new URL(page.url()).searchParams.get("heatmap_cohort"), String(a.cohortId), "Deleting B cleared A");
  await poll(() => observations.size === 0, "post-delete response observation");
  const remaining = await account.call(`/sites/${account.siteId}/cohorts`);
  assert.ok(remaining.some(cohort => cohort.cohortId === a.cohortId));
  assert.ok(!remaining.some(cohort => cohort.cohortId === b.cohortId));
  const reportAfter = evidence.reports.findLast(report => report.siteId === account.siteId && !report.query.view);
  assert.equal(reportAfter.cohortId, a.cohortId);
  assert.equal(reportAfter.count, reportA.count);
  assert.ok(
    evidence.requests
      .filter(
        request => request.method === "GET" && request.path.endsWith("/heatmaps") && request.siteId === account.siteId
      )
      .every(request => request.query.cohort_id === String(a.cohortId)),
    "An unrelated mutation expanded the report"
  );
  evidence.checks.push({
    name: "Keyboard actions/edit/delete on unrelated cohort B preserve A URL and real report",
    selectedCohortId: a.cohortId,
    deletedCohortId: b.cohortId,
    count: reportAfter.count,
    passed: true,
  });

  currentStep = "switch site while destination metadata is delayed";
  holdMetadata = true;
  const requestBoundary = evidence.requests.length;
  const sourceSite = await account.call(`/sites/${account.siteId}`);
  await clickText(page, "button", sourceSite.name, true, true);
  await clickText(page, 'button,[role="option"]', second.name, false, true);
  await poll(() => new URL(page.url()).pathname === `/${secondSiteId}/heatmaps`, "destination URL");
  await poll(() => metadataHeld, "destination metadata held");
  const destination = new URL(page.url());
  for (const key of [
    "heatmap_click_host",
    "heatmap_click_path",
    "heatmap_click_width",
    "heatmap_scroll_host",
    "heatmap_scroll_path",
    "heatmap_scroll_width",
    "heatmap_cohort",
  ])
    assert.equal(destination.searchParams.has(key), false, `Site-specific ${key} leaked`);
  assert.equal(destination.searchParams.get("day"), day);
  assert.equal(destination.searchParams.get("compare"), "none");
  await delay(500);
  assert.equal(
    await page.$('canvas[aria-label="Click intensity"]'),
    null,
    "Prior site canvas remained while permissions were pending"
  );
  assert.ok(
    !evidence.requests
      .slice(requestBoundary)
      .some(request => request.siteId === secondSiteId && request.path.endsWith("/heatmaps")),
    "Report requested before destination permissions"
  );
  evidence.checks.push({
    name: "Site switch clears all site-owned URL keys, preserves dates, and hides old report while permissions wait",
    destinationSiteId: secondSiteId,
    delayMs: 500,
    passed: true,
  });
  currentStep = "destination permissions and empty detail";
  unblockMetadata();
  await poll(
    () =>
      evidence.reports.some(report => report.siteId === secondSiteId && report.status === 200 && !report.query.view),
    "destination detail response"
  );
  await page.waitForFunction(() => document.body.textContent.includes("No heatmap samples"));
  await poll(() => observations.size === 0, "destination response observation");
  assert.ok(evidence.metadata.some(metadata => metadata.siteId === secondSiteId && metadata.hasHeatmapRead));
  const destinationReports = evidence.reports.filter(report => report.siteId === secondSiteId);
  assert.ok(
    destinationReports.every(
      report =>
        report.status === 200 &&
        report.selectedPage === null &&
        !report.query.hostname &&
        !report.query.pathname &&
        !report.query.bucket &&
        !report.query.cohort_id
    )
  );
  evidence.checks.push({
    name: "Destination uses its own permissions and empty report; no foreign page or cohort query",
    destinationSiteId: secondSiteId,
    requests: destinationReports.length,
    passed: true,
  });

  currentStep = "fresh heatmap-only site layout";
  assert.equal((await account.call(`/sites/${secondSiteId}/has-data`)).hasData, false);
  const recorded = await fetch(`${baseUrl}/api/heatmaps/record/${secondSiteId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: baseUrl },
    body: JSON.stringify({
      batchId: randomUUID(),
      userId: `layout-only-${suffix}`,
      events: [
        {
          timestamp: Date.now(),
          pageVisitId: `layout-only-${suffix}`,
          type: "click",
          hostname: "qa.heatmap.test",
          pathname: "/layout-only",
          viewportWidth: 375,
          viewportHeight: 600,
          documentWidth: 375,
          documentHeight: 2000,
          clientX: 100,
          clientY: 300,
          pageX: 100,
          pageY: 300,
        },
      ],
    }),
  });
  assert.equal(recorded.status, 200, "Heatmap-only sample ingestion");
  assert.equal(
    (await account.call(`/sites/${secondSiteId}/has-data`)).hasData,
    false,
    "Heatmaps unexpectedly created ordinary pageviews"
  );
  const layoutUrl = new URL(`/${secondSiteId}/heatmaps`, baseUrl);
  for (const [key, value] of Object.entries({
    timeMode: "day",
    day,
    compare: "none",
    heatmap_click_host: "qa.heatmap.test",
    heatmap_click_path: "/layout-only",
    heatmap_click_width: 375,
  }))
    layoutUrl.searchParams.set(key, String(value));
  for (const viewport of [
    { width: 375, height: 900 },
    { width: 320, height: 500 },
    { width: 1680, height: 650 },
  ]) {
    await page.setViewport({ ...viewport, deviceScaleFactor: 2 });
    currentStep = "baseline main";
    await page.goto(`${baseUrl}/${secondSiteId}?timeMode=day&day=${day}`, { waitUntil: "networkidle0" });
    currentStep = `heatmap-only ${viewport.width}x${viewport.height} layout`;
    await page.goto(layoutUrl.href, { waitUntil: "networkidle0" });
    await page.waitForSelector('canvas[aria-label="Click intensity"]', { visible: true });
    await delay(500);
    const layout = await page.evaluate(async () => {
      const region = document.querySelector('[aria-label="Heatmap page"]');
      let shell = region.parentElement;
      while (
        shell &&
        !(shell.scrollHeight > shell.clientHeight + 4 && ["auto", "scroll"].includes(getComputedStyle(shell).overflowY))
      )
        shell = shell.parentElement;
      if (!shell)
        return {
          regionHeight: region.clientHeight,
          regionScrollHeight: region.scrollHeight,
          outerScrollAvailable: false,
        };
      const before = shell.scrollTop;
      region.scrollIntoView({ block: "center", inline: "nearest" });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const rect = region.getBoundingClientRect();
      const detail = region.closest('section[aria-label="Heatmap detail"]');
      const detailRect = detail.getBoundingClientRect();
      const canvas = region.querySelector("canvas");
      const outerAfter = shell.scrollTop;
      region.scrollTop = 200;
      region.dispatchEvent(new Event("scroll", { bubbles: true }));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return {
        regionHeight: region.clientHeight,
        regionScrollHeight: region.scrollHeight,
        outerScrollAvailable: true,
        outerHeight: shell.clientHeight,
        outerScrollHeight: shell.scrollHeight,
        outerBefore: before,
        outerAfter,
        outerAfterInnerScroll: shell.scrollTop,
        innerScrollTop: region.scrollTop,
        visibleRegionHeight: Math.max(0, Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top)),
        detailHeaderHeight: rect.top - detailRect.top,
        detailClipsViewport: detailRect.bottom + 1 < rect.bottom,
        canvasHeight: canvas.height,
        dpr: devicePixelRatio,
      };
    });
    evidence.layoutMeasurements ??= [];
    evidence.layoutMeasurements.push({ viewport, layout });
    // Wrapped controls use slightly more space on short phones; keep their viewport usable.
    const minimumVisibleHeight = viewport.height <= 500 ? 200 : 240;
    assert.ok(layout.regionHeight >= minimumVisibleHeight, `Collapsed report viewport: ${JSON.stringify(layout)}`);
    assert.equal(layout.outerScrollAvailable, true, `Tall onboarding cannot scroll: ${JSON.stringify(layout)}`);
    assert.ok(layout.outerAfter > layout.outerBefore, "Outer scroll did not reveal the report below onboarding");
    assert.ok(layout.visibleRegionHeight >= minimumVisibleHeight, "Outer scroll did not expose a usable report");
    assert.ok(layout.detailHeaderHeight > 0, "Report controls lost their space above the viewer");
    assert.equal(layout.detailClipsViewport, false, "Report panel clips its viewer");
    assert.ok(
      layout.canvasHeight <= Math.ceil(layout.regionHeight * layout.dpr),
      "Canvas expanded to full document height"
    );
    assert.equal(layout.innerScrollTop, 200, "Heatmap document no longer scrolls independently");
    assert.equal(layout.outerAfterInnerScroll, layout.outerAfter, "Heatmap scroll moved the onboarding shell");
    evidence.checks.push({
      name: "Fresh heatmap-only site keeps usable viewport and separate outer/document scroll",
      viewport,
      minimumVisibleHeight,
      ordinaryPageviews: false,
      layout,
      passed: true,
    });
  }
  const baselineSignatures = new Set(evidence.baselineErrors.map(error => error.message));
  evidence.newRuntimeErrors = evidence.runtimeErrors.filter(error => !baselineSignatures.has(error.message));
  assert.equal(evidence.newRuntimeErrors.length, 0, "New browser runtime errors");
  evidence.passed = true;
} catch (error) {
  evidence.failedStep = currentStep;
  evidence.failure = error instanceof Error ? error.message : String(error);
  if (page)
    evidence.failureLayout = await page
      .evaluate(() => {
        const region = document.querySelector('[aria-label="Heatmap page"]');
        if (!region) return null;
        const ancestors = [];
        for (let node = region; node; node = node.parentElement)
          ancestors.push({
            tag: node.tagName,
            clientHeight: node.clientHeight,
            scrollHeight: node.scrollHeight,
            overflowY: getComputedStyle(node).overflowY,
            minHeight: getComputedStyle(node).minHeight,
            height: getComputedStyle(node).height,
            flex: getComputedStyle(node).flex,
          });
        return ancestors;
      })
      .catch(() => null);
  process.exitCode = 1;
} finally {
  unblockMetadata?.();
  await browser?.close().catch(() => {});
  if (account) {
    for (const cohortId of ownedCohorts) {
      try {
        await account.call(`/sites/${account.siteId}/cohorts/${cohortId}`, undefined, "DELETE");
        evidence.cleanup.push({ cohortId, success: true });
      } catch (error) {
        evidence.cleanup.push({ cohortId, success: false, error: error.message });
        process.exitCode = 1;
      }
    }
    if (secondSiteId) {
      try {
        await account.call(`/sites/${secondSiteId}`, undefined, "DELETE");
        evidence.cleanup.push({ siteId: secondSiteId, success: true });
      } catch (error) {
        evidence.cleanup.push({ siteId: secondSiteId, success: false, error: error.message });
        process.exitCode = 1;
      }
    }
  }
  await Promise.allSettled([...observations]);
  evidence.finishedAt = new Date().toISOString();
  await writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(
    JSON.stringify({
      passed: evidence.passed,
      checks: evidence.checks.length,
      failedStep: evidence.failedStep,
      failure: evidence.failure,
      runtimeErrors: evidence.runtimeErrors.length,
      cleanup: evidence.cleanup,
    })
  );
}
