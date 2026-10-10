import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { baseUrl, interceptFixture, localAccount, responsiveFixture } from "./qa-support.mjs";

const require = createRequire(new URL("../../server/package.json", import.meta.url));
const puppeteer = require("puppeteer");
const evidenceFile = new URL("render-evidence.json", import.meta.url);
const screenshotDirectory = new URL("evidence/", import.meta.url);
const collection = JSON.parse(await readFile(new URL("collection-evidence.json", import.meta.url), "utf8"));
const account = await localAccount();
assert.equal(account.siteId, collection.siteId, "Renderer and collector must use the same isolated QA site");
assert.deepEqual(
  collection.widths.map(item => item.width),
  [375, 768, 1440]
);
await mkdir(screenshotDirectory, { recursive: true });

const evidence = {
  siteId: account.siteId,
  source: "Real trusted clicks collected by collect-browser.mjs; report responses are not substituted",
  startedAt: new Date().toISOString(),
  alignments: [],
  interactions: [],
  screenshots: [],
  heatmapUploadsFromBackground: 0,
  baselineAudit: [],
  pageErrors: [],
  reportRuntimeAudit: [],
  consoleErrors: [],
};
const browser = await puppeteer.launch({ headless: true });
let currentStep = "startup";
let delayedSearchRequest;
let releaseSearchRequest;
let detailRequests = 0;

function signatureCounts(errors) {
  return Object.fromEntries(
    [...new Set(errors)].map(signature => [signature, errors.filter(error => error === signature).length])
  );
}

function summarizeRuntimeEvidence() {
  evidence.runtimeErrorCounts = signatureCounts(evidence.pageErrors);
  evidence.consoleErrorCounts = signatureCounts(evidence.consoleErrors);
  for (const audit of evidence.baselineAudit) {
    audit.countsBySignature = signatureCounts(audit.pageErrors);
    audit.consoleCountsBySignature = signatureCounts(audit.consoleErrors);
  }
}

function reportUrl({ width = 375, path = "/a", mode = "click" } = {}) {
  const url = new URL(`/${account.siteId}/heatmaps`, baseUrl);
  url.searchParams.set("timeMode", "past-minutes");
  url.searchParams.set("past_minutes_start", "60");
  url.searchParams.set("past_minutes_end", "0");
  url.searchParams.set("heatmap_mode", mode);
  url.searchParams.set(`heatmap_${mode}_host`, "qa.heatmap.test");
  url.searchParams.set(`heatmap_${mode}_path`, path);
  url.searchParams.set(`heatmap_${mode}_width`, String(width));
  return url.href;
}

async function animationFrames(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function clickText(page, selector, text, { keyboard = false } = {}) {
  for (const element of await page.$$(selector)) {
    const match = await element.evaluate((node, expected) => node.textContent.trim() === expected, text);
    if (!match || !(await element.isVisible())) continue;
    if (keyboard) {
      await element.focus();
      await page.keyboard.press("Enter");
    } else {
      await element.click();
    }
    return;
  }
  throw new Error(`Visible ${selector} with text ${JSON.stringify(text)} not found`);
}

async function waitForSelection(page, { width, path = "/a", mode = "click" }) {
  await page.waitForFunction(
    ({ width, path, mode }) => {
      const region = document.querySelector('[aria-label="Heatmap page"]');
      const heading = document.querySelector('[aria-label="Heatmap detail"] h2');
      const picker = document.querySelector('[aria-label="Viewport width"]');
      const overlay = document.querySelector(
        mode === "click" ? 'canvas[aria-label="Click intensity"]' : '[aria-label="Scroll reach"]'
      );
      return region && heading?.textContent === path && picker?.textContent.includes(`${width} CSS px`) && overlay;
    },
    { timeout: 30_000 },
    { width, path, mode }
  );
  await animationFrames(page);
}

async function chooseWidth(page, width) {
  await page.click('[aria-label="Viewport width"]');
  await page.waitForSelector('[role="option"]', { visible: true });
  const options = await page.$$('[role="option"]');
  for (const option of options) {
    if (await option.evaluate((element, width) => element.textContent.startsWith(`${width} CSS px`), width)) {
      await option.click();
      await waitForSelection(page, { width });
      return;
    }
  }
  throw new Error(`Observed viewport ${width} is missing from the width picker`);
}

async function screenshot(page, name) {
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        animation => animation.playState !== "running" || animation.effect?.getComputedTiming().iterations === Infinity
      )
  );
  const path = new URL(name, screenshotDirectory);
  await page.screenshot({ path: path.pathname, fullPage: false });
  evidence.screenshots.push(`plans/heatmap-verification/evidence/${name}`);
}

async function measureAlignment(page, width, label) {
  currentStep = `pixel alignment ${label} (${width} CSS px)`;
  const captured = collection.widths.find(item => item.width === width);
  assert.ok(captured, `No collector evidence for ${width}`);
  const frameElement = await page.waitForSelector('iframe[title="Live page background"]');
  const frame = await frameElement.contentFrame();
  assert.ok(frame, "Live fixture frame is unavailable");
  await frame.waitForSelector('[data-qa="target"]');
  const target = await frame.evaluate(() => {
    const bounds = document.querySelector('[data-qa="target"]').getBoundingClientRect();
    return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2, width: innerWidth, height: innerHeight };
  });
  assert.equal(target.width, width, "Iframe breakpoint must match the selected recorded layout");
  assert.ok(
    Math.abs(target.x - captured.x) <= 0.01 && Math.abs(target.y - captured.pageY) <= 0.01,
    `Live fixture moved from its captured target at ${width}`
  );
  await page.evaluate(({ y }) => {
    const region = document.querySelector('[aria-label="Heatmap page"]');
    const scene = document.querySelector('[data-testid="heatmap-scene"]');
    const iframe = scene.querySelector("iframe");
    const scale = iframe.getBoundingClientRect().width / Number(iframe.style.width.replace("px", ""));
    region.scrollTop = Math.max(0, y * scale - region.clientHeight / 2);
  }, target);
  await animationFrames(page);
  await page.waitForFunction(() => {
    const canvas = document.querySelector('canvas[aria-label="Click intensity"]');
    const pixels = canvas?.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height).data;
    if (!pixels) return false;
    for (let index = 3; index < pixels.length; index += 4) if (pixels[index]) return true;
    return false;
  });
  const measurement = await page.evaluate(target => {
    const canvas = document.querySelector('canvas[aria-label="Click intensity"]');
    const iframe = document.querySelector('iframe[title="Live page background"]');
    const region = document.querySelector('[aria-label="Heatmap page"]');
    const canvasBounds = canvas.getBoundingClientRect();
    const frameBounds = iframe.getBoundingClientRect();
    const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    let total = 0,
      x = 0,
      y = 0;
    for (let index = 3; index < pixels.length; index += 4) {
      const alpha = pixels[index];
      if (!alpha) continue;
      const pixel = (index - 3) / 4;
      total += alpha;
      x += ((pixel % canvas.width) + 0.5) * alpha;
      y += (Math.floor(pixel / canvas.width) + 0.5) * alpha;
    }
    const center = {
      x: canvasBounds.x + ((x / total) * canvasBounds.width) / canvas.width,
      y: canvasBounds.y + ((y / total) * canvasBounds.height) / canvas.height,
    };
    const scale = frameBounds.width / target.width;
    const expected = { x: frameBounds.x + target.x * scale, y: frameBounds.y + target.y * scale };
    return {
      center,
      expected,
      scale,
      errorX: Math.abs(center.x - expected.x),
      errorY: Math.abs(center.y - expected.y),
      devicePixelRatio,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      scrollTop: region.scrollTop,
      frameScripts: iframe.getAttribute("sandbox"),
      overlayPointerEvents: getComputedStyle(canvas).pointerEvents,
    };
  }, target);
  assert.ok(
    measurement.errorX <= 3 && measurement.errorY <= 3,
    `Hotspot missed responsive target at ${width}: ${JSON.stringify(measurement)}`
  );
  assert.equal(measurement.overlayPointerEvents, "none");
  assert.equal(measurement.frameScripts, "allow-scripts");
  evidence.alignments.push({ label, width, ...measurement });
  return measurement;
}

async function search(page, value, scope = "") {
  const input = await page.waitForSelector(`${scope} [aria-label="Search pages"]`.trim(), { visible: true });
  await input.click({ clickCount: 3 });
  await page.keyboard.press("Backspace");
  if (value) await input.type(value);
}

async function newReportPage({ blocked = false } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1680, height: 1000, deviceScaleFactor: 2 });
  await page.setCookie(
    ...account.cookies.map(cookie => ({
      ...cookie,
      path: "/",
      secure: cookie.name.startsWith("__Secure-") || cookie.name.startsWith("__Host-"),
    }))
  );
  if (blocked) {
    // Reuse real /a report data, but serve the same fixture with frame blocking
    // headers. No report response, click point or row is fabricated.
    await page.setRequestInterception(true);
    page.on("request", request => {
      if (new URL(request.url()).hostname !== "qa.heatmap.test") return request.continue();
      return request.respond({
        status: 200,
        contentType: "text/html",
        headers: { "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'" },
        body: responsiveFixture(account.siteId, { tracking: false, blocked: true }),
      });
    });
  } else {
    await interceptFixture(page, account.siteId, false, async request => {
      const url = new URL(request.url());
      if (url.pathname !== `/api/sites/${account.siteId}/heatmaps`) return;
      if (url.searchParams.get("view") !== "pages") detailRequests++;
      if (releaseSearchRequest && url.searchParams.get("view") === "pages" && url.searchParams.get("search") === "/b") {
        delayedSearchRequest = true;
        await new Promise(resolve => { releaseSearchRequest = resolve; });
      }
    });
  }
  page.on("request", request => {
    if (request.url().includes("/heatmaps/record/")) evidence.heatmapUploadsFromBackground++;
  });
  page.on("pageerror", error => {
    evidence.pageErrors.push(error.message);
    evidence.reportRuntimeAudit.push({
      url: page.url(),
      step: currentStep,
      message: error.message,
      stack: error.stack,
    });
  });
  page.on("console", message => {
    if (message.type() === "error") evidence.consoleErrors.push(message.text());
  });
  return page;
}

async function auditExistingPages() {
  for (const route of ["main", "replay"]) {
    for (const [width, theme] of [
      [1680, "light"],
      [375, "light"],
      [1680, "dark"],
      [375, "dark"],
    ]) {
      currentStep = `existing /${route} baseline at ${width} in ${theme}`;
      const context = await browser.createBrowserContext();
      const page = await context.newPage();
      await page.setViewport({ width, height: width === 375 ? 900 : 1000, deviceScaleFactor: 2 });
      await page.setCookie(
        ...account.cookies.map(cookie => ({
          ...cookie,
          path: "/",
          secure: cookie.name.startsWith("__Secure-") || cookie.name.startsWith("__Host-"),
        }))
      );
      await page.evaluateOnNewDocument(theme => {
        if (window === window.top) localStorage.setItem("theme", theme);
      }, theme);
      const audit = { route: `/${account.siteId}/${route}`, width, theme, pageErrors: [], consoleErrors: [] };
      page.on("pageerror", error => audit.pageErrors.push(error.message));
      page.on("console", message => {
        if (message.type() === "error") audit.consoleErrors.push(message.text());
      });
      const url = new URL(audit.route, baseUrl);
      url.searchParams.set("timeMode", "past-minutes");
      url.searchParams.set("past_minutes_start", "60");
      url.searchParams.set("past_minutes_end", "0");
      const response = await page.goto(url.href, { waitUntil: "networkidle0" });
      audit.httpStatus = response.status();
      if (audit.httpStatus !== 200)
        audit.errorPageText = await page.$eval("body", element => element.textContent.slice(0, 250));
      await animationFrames(page);
      audit.countsBySignature = signatureCounts(audit.pageErrors);
      audit.consoleCountsBySignature = signatureCounts(audit.consoleErrors);
      evidence.baselineAudit.push(audit);
      await context.close();
    }
  }
}

try {
  await auditExistingPages();
  const page = await newReportPage();
  const lightThemeScript = await page.evaluateOnNewDocument(() => {
    if (window === window.top) localStorage.setItem("theme", "light");
  });
  currentStep = "load real heatmap report";
  await page.goto(reportUrl(), { waitUntil: "domcontentloaded" });
  await waitForSelection(page, { width: 375 });
  for (const width of [375, 768, 1440]) {
    if (width !== 375) await chooseWidth(page, width);
    await measureAlignment(page, width, "desktop light");
    await screenshot(page, `desktop-light-${width}.png`);
  }

  currentStep = "keyboard search and per-mode page selection";
  await page.evaluate(() => {
    window.__originalHeatmapFrame = document.querySelector('iframe[title="Live page background"]');
    window.__originalHeatmapScroller = document.querySelector('[aria-label="Heatmap page"]');
    window.__originalHeatmapScroller.scrollTop = 200;
  });
  await animationFrames(page);
  const beforeSearchDetails = detailRequests;
  releaseSearchRequest = true;
  await search(page, "/b");
  for (let attempt = 0; !delayedSearchRequest && attempt < 100; attempt++)
    await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(delayedSearchRequest, "Pages-only search request did not start");
  const retained = await page.evaluate(() => ({
    sameFrame: window.__originalHeatmapFrame === document.querySelector('iframe[title="Live page background"]'),
    sameScroller: window.__originalHeatmapScroller === document.querySelector('[aria-label="Heatmap page"]'),
    scrollTop: document.querySelector('[aria-label="Heatmap page"]').scrollTop,
  }));
  assert.deepEqual(retained, { sameFrame: true, sameScroller: true, scrollTop: 200 });
  assert.equal(detailRequests, beforeSearchDetails, "Page search refetched heatmap detail");
  releaseSearchRequest();
  releaseSearchRequest = null;
  evidence.interactions.push({ check: "Delayed page search preserves actual iframe, scroller and scroll without detail request", passed: true });
  await page.waitForFunction(() => [...document.querySelectorAll('aside [aria-label="Pages"] button')].some(button => button.textContent.startsWith("/b")));
  await search(page, "");
  await chooseWidth(page, 768);
  await clickText(page, '[aria-label="Heatmap mode"] button', "Scroll", { keyboard: true });
  await waitForSelection(page, { width: 375, mode: "scroll" });
  assert.equal(await page.$$eval("[data-depth]", elements => elements.length), 10);
  assert.equal(await page.$eval("table caption", element => element.textContent), "Scroll reach by page depth");
  await search(page, "/b");
  await page.waitForFunction(() =>
    [...document.querySelectorAll('aside [aria-label="Pages"] button')].some(button =>
      button.textContent.startsWith("/b")
    )
  );
  const secondPage = await page.$('aside [aria-label="Pages"] button');
  await secondPage.focus();
  await page.keyboard.press("Enter");
  await waitForSelection(page, { width: 375, path: "/b", mode: "scroll" });
  await search(page, "");
  await clickText(page, '[aria-label="Heatmap mode"] button', "Clicks", { keyboard: true });
  await waitForSelection(page, { width: 768 });
  await clickText(page, '[aria-label="Heatmap mode"] button', "Scroll", { keyboard: true });
  await waitForSelection(page, { width: 375, path: "/b", mode: "scroll" });
  evidence.interactions.push({
    check: "Keyboard mode/page navigation and independent click/scroll selection",
    passed: true,
  });

  currentStep = "page search empty state";
  await search(page, "no-page-has-this-qa-name");
  await page.waitForFunction(() => document.querySelector("aside").textContent.includes("No matching pages"));
  await search(page, "");
  await page.waitForSelector('aside [aria-label="Pages"] button');
  evidence.interactions.push({ check: "Search matches pages and reports no matches", passed: true });

  currentStep = "dark theme";
  await page.evaluate(() => localStorage.setItem("theme", "dark"));
  // Remove the startup-only light preference before reloading into the stored dark theme.
  await page.removeScriptToEvaluateOnNewDocument(lightThemeScript.identifier);
  const darkPage = await newReportPage();
  await darkPage.goto(reportUrl({ width: 768 }), { waitUntil: "domcontentloaded" });
  await darkPage.waitForFunction(() => document.documentElement.classList.contains("dark"));
  await waitForSelection(darkPage, { width: 768 });
  await measureAlignment(darkPage, 768, "desktop dark");
  await screenshot(darkPage, "desktop-dark-768.png");
  evidence.interactions.push({ check: "Stored dark theme with aligned canvas", passed: true });

  currentStep = "phone page picker";
  await darkPage.setViewport({ width: 375, height: 900, deviceScaleFactor: 2 });
  await darkPage.goto(reportUrl({ width: 375 }), { waitUntil: "domcontentloaded" });
  await waitForSelection(darkPage, { width: 375 });
  await measureAlignment(darkPage, 375, "phone dark");
  assert.ok(
    await darkPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    "Phone report overflows horizontally"
  );
  await clickText(darkPage, '[aria-label="Heatmap detail"] button', "Pages", { keyboard: true });
  await darkPage.waitForSelector('[role="dialog"] [aria-label="Search pages"]', { visible: true });
  await search(darkPage, "/b", '[role="dialog"]');
  await darkPage.waitForFunction(() =>
    [...document.querySelectorAll('[role="dialog"] [aria-label="Pages"] button')].some(button =>
      button.textContent.startsWith("/b")
    )
  );
  await (await darkPage.$('[role="dialog"] [aria-label="Pages"] button')).focus();
  await darkPage.keyboard.press("Enter");
  await darkPage.waitForSelector('[role="dialog"]', { hidden: true });
  await waitForSelection(darkPage, { width: 375, path: "/b" });
  evidence.interactions.push({ check: "Phone page picker search and keyboard selection", passed: true });

  currentStep = "phone fullscreen and focus restoration";
  await darkPage.click('[aria-label="Open fullscreen"]');
  await darkPage.waitForSelector('[aria-label="Close fullscreen"]', { visible: true });
  const fullscreenBounds = await (await darkPage.$('[role="dialog"]')).boundingBox();
  assert.ok(
    Math.abs(fullscreenBounds.width - 375) <= 1 && Math.abs(fullscreenBounds.height - 900) <= 1,
    `Fullscreen does not fill the phone viewport: ${JSON.stringify(fullscreenBounds)}`
  );
  await measureAlignment(darkPage, 375, "phone fullscreen dark");
  await screenshot(darkPage, "phone-fullscreen-dark.png");
  await darkPage.keyboard.press("Escape");
  await darkPage.waitForSelector('[aria-label="Close fullscreen"]', { hidden: true });
  await darkPage.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Open fullscreen");
  evidence.interactions.push({
    check: "Phone fullscreen fills viewport, Escape closes, trigger focus restores",
    passed: true,
  });

  currentStep = "geometry-only view";
  await darkPage.click('[role="switch"][aria-label="Live background"]');
  await darkPage.waitForSelector('iframe[title="Live page background"]', { hidden: true });
  assert.ok(await darkPage.$('canvas[aria-label="Click intensity"]'));
  assert.ok(await darkPage.evaluate(() => document.body.textContent.includes("Geometry only")));
  await screenshot(darkPage, "phone-geometry-only.png");
  evidence.interactions.push({ check: "Geometry-only retains click overlay without iframe", passed: true });

  currentStep = "frame blocking with real recorded geometry";
  const blockedPage = await newReportPage({ blocked: true });
  await blockedPage.goto(reportUrl({ width: 375 }), { waitUntil: "domcontentloaded" });
  await waitForSelection(blockedPage, { width: 375 });
  await blockedPage.waitForFunction(() =>
    document.body.textContent.includes("Sign-in and embedding rules may hide the page.")
  );
  await blockedPage.waitForFunction(() => !!document.querySelector('iframe[title="Live page background"]'));
  const deadline = Date.now() + 5000;
  while (
    !evidence.consoleErrors.some(error => /frame-ancestors|X-Frame-Options|Refused to frame/i.test(error)) &&
    Date.now() < deadline
  ) {
    await animationFrames(blockedPage);
  }
  assert.ok(
    evidence.consoleErrors.some(error => /frame-ancestors|X-Frame-Options|Refused to frame/i.test(error)),
    "Browser did not exercise a frame-blocked response"
  );
  await blockedPage.click('[role="switch"][aria-label="Live background"]');
  await blockedPage.waitForSelector('iframe[title="Live page background"]', { hidden: true });
  await blockedPage.evaluate(() => {
    document.querySelector('[aria-label="Heatmap page"]').scrollTop = 600;
  });
  await animationFrames(blockedPage);
  assert.ok(
    await blockedPage.evaluate(() => {
      const canvas = document.querySelector('canvas[aria-label="Click intensity"]');
      const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      for (let index = 3; index < pixels.length; index += 4) if (pixels[index]) return true;
      return false;
    }),
    "Frame blocking removed the recorded hotspot"
  );
  evidence.interactions.push({
    check: "Blocked live frame exposes embedding limitation; geometry-only remains usable",
    passed: true,
  });
  await screenshot(blockedPage, "blocked-frame-geometry-only.png");

  assert.equal(evidence.heatmapUploadsFromBackground, 0, "Live backgrounds polluted tracking data");
  summarizeRuntimeEvidence();
  // The only exception is the independently reproduced local Stripe setup
  // error. A report hydration error must fail even if a baseline is flaky.
  const existingStripeError =
    "Uncaught (in promise) IntegrationError: Please call Stripe() with your publishable key. You used an empty string.";
  const provenBaselineSignatures = new Set(
    evidence.baselineAudit.flatMap(audit => audit.pageErrors).filter(signature => signature === existingStripeError)
  );
  evidence.provenExistingClientIssues = Object.fromEntries(
    [...new Set(evidence.pageErrors)]
      .filter(signature => provenBaselineSignatures.has(signature))
      .map(signature => [
        signature,
        {
          reportCount: evidence.pageErrors.filter(error => error === signature).length,
          observedOnExistingPages: evidence.baselineAudit
            .filter(audit => audit.pageErrors.includes(signature))
            .map(audit => ({
              route: audit.route,
              width: audit.width,
              theme: audit.theme,
              count: audit.countsBySignature[signature],
            })),
        },
      ])
  );
  const newRuntimeErrors = evidence.pageErrors.filter(error => !provenBaselineSignatures.has(error));
  assert.deepEqual(
    newRuntimeErrors,
    [],
    "Heatmaps introduced client runtime errors absent from both existing-page baselines"
  );
  evidence.passed = true;
  evidence.finishedAt = new Date().toISOString();
  await writeFile(evidenceFile, JSON.stringify(evidence, null, 2));
  console.log(
    JSON.stringify({
      passed: true,
      alignments: evidence.alignments.length,
      interactions: evidence.interactions.length,
      maximumError: Math.max(...evidence.alignments.flatMap(item => [item.errorX, item.errorY])),
      evidence: evidenceFile.pathname,
    })
  );
} catch (error) {
  summarizeRuntimeEvidence();
  evidence.passed = false;
  evidence.failure = { step: currentStep, message: error.message };
  evidence.finishedAt = new Date().toISOString();
  await writeFile(evidenceFile, JSON.stringify(evidence, null, 2));
  throw error;
} finally {
  await browser.close();
}
