import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { baseUrl, localAccount } from "../qa-support.mjs";
import { renderFixture } from "./fixture.mjs";
import { isKnownRuntimeError } from "./runtime-baseline.mjs";

const require = createRequire(new URL("../../../server/package.json", import.meta.url));
const puppeteer = require("puppeteer");
const collection = JSON.parse(await readFile(new URL("collection.json", import.meta.url), "utf8"));
const account = await localAccount();
const evidence = {
  startedAt: new Date().toISOString(),
  source: "Fresh production page loads and normal APIs with CPU throttling",
  checks: [],
  runtimeErrors: [],
};
const browser = await puppeteer.launch({ headless: true, executablePath: puppeteer.executablePath() });
try {
  for (const cpu of [1, 6])
    for (const width of [1680, 375, 320]) {
      const page = await browser.newPage();
      await page.setViewport({ width, height: width === 1680 ? 1050 : 900, deviceScaleFactor: 2 });
      await page.emulateTimezone("UTC");
      await page.emulateCPUThrottling(cpu);
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
      const errors = [];
      page.on("pageerror", error => errors.push({ message: error.message, url: page.url(), stack: error.stack }));
      const url = new URL(`/${collection.siteId}/heatmaps`, baseUrl);
      for (const [key, value] of Object.entries({
        timeMode: "range",
        startDate: collection.startedAt.slice(0, 10),
        endDate: collection.startedAt.slice(0, 10),
        heatmap_mode: "click",
        heatmap_click_host: collection.hostname,
        heatmap_click_path: "/",
        heatmap_click_width: String(width === 1680 ? 1440 : 375),
      }))
        url.searchParams.set(key, value);
      await page.goto(url.href, { waitUntil: "networkidle0", timeout: 120000 });
      await page.waitForSelector('canvas[aria-label="Click intensity"]', { visible: true, timeout: 60000 });
      evidence.runtimeErrors.push(...errors);
      const unexpected = errors.filter(error => !isKnownRuntimeError(error, collection.siteId));
      assert.deepEqual(unexpected, []);
      evidence.checks.push({
        width,
        cpuThrottling: cpu,
        name: "Fresh load renders the report with no new runtime errors relative to the recorded previous build",
        knownBaselineErrors: errors.length,
        passed: true,
      });
      await page.close();
    }
  evidence.status = "passed";
} catch (error) {
  evidence.status = "failed";
  evidence.failure = error.stack;
  throw error;
} finally {
  evidence.completedAt = new Date().toISOString();
  await writeFile(new URL("load-evidence.json", import.meta.url), `${JSON.stringify(evidence, null, 2)}\n`);
  await browser.close();
}
console.log(JSON.stringify({ status: evidence.status, checks: evidence.checks.length }));
