import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import puppeteer from "puppeteer";

// Exercise the shipped, minified assets, including compatibility with the
// existing rrweb player version. The fixtures never contact a remote service.
const publicDir = new URL("../../public/", import.meta.url);
const sizes = {};
for (const [name, budget] of [
  ["script.js", 18_000],
  ["rrweb.min.js", 25_000],
  ["heatmap-snapshot.js", 25_000],
]) {
  const code = await readFile(new URL(name, publicDir));
  sizes[name] = { raw: code.length, gzip: gzipSync(code).length };
  assert.ok(sizes[name].gzip <= budget, `${name} exceeds its ${budget}-byte gzip budget`);
}

const browser = await puppeteer.launch({ headless: true });
const runtimeErrors = [];
try {
  const page = await browser.newPage();
  page.on("pageerror", error => runtimeErrors.push(error.message));
  await page.setContent(`<!doctype html><html><head>
    <style>.public{color:rgb(121,23,77)}body{height:2000px}</style>
    </head><body><h1 class="public">Initial public text</h1>
    <div class="rr-block">blocked-secret</div><div class="rr-mask">masked-secret</div>
    <div data-private>selector-secret</div><input id="input" value="input-secret">
    <button id="button">Click</button><div id="dynamic"></div></body></html>`);
  await page.addScriptTag({ path: fileURLToPath(new URL("rrweb.min.js", publicDir)) });
  await page.evaluate(() => {
    window.recorded = [];
    window.stopRecording = window.rrweb.record({
      emit: event => window.recorded.push(event),
      maskAllInputs: true,
      maskTextSelector: "[data-private]",
      collectFonts: true,
      recordCanvas: false,
      sampling: { mousemove: false, input: "last", scroll: 100 },
    });
  });
  await page.waitForFunction(() => window.recorded.some(event => event.type === 2));
  await page.evaluate(() => {
    document.querySelector("h1").textContent = "Updated public text";
    document.querySelector("#dynamic").innerHTML = "<p>Inserted public node</p>";
    document.querySelector("#input").value = "changed-secret";
    document.querySelector("#input").dispatchEvent(new Event("change", { bubbles: true }));
    window.scrollTo(0, 200);
  });
  await page.click("#button");
  await page.waitForFunction(() =>
    [0, 2, 3, 5].every(source => window.recorded.some(event => event.type === 3 && event.data.source === source))
  );
  const events = await page.evaluate(() => {
    window.stopRecording();
    return window.recorded;
  });
  const privateContent = /blocked-secret|masked-secret|selector-secret|input-secret|changed-secret/;
  assert.doesNotMatch(JSON.stringify(events), privateContent);
  assert.equal(await page.evaluate(() => typeof window.rrweb.Replayer), "undefined");

  await page.addScriptTag({ path: fileURLToPath(new URL("heatmap-snapshot.js", publicDir)) });
  const snapshot = await page.evaluate(() =>
    window.rybbitHeatmapSnapshot.capture({ sessionReplayMaskTextSelectors: ["[data-private]"] })
  );
  assert.equal(snapshot.type, 0);
  assert.doesNotMatch(JSON.stringify(snapshot), privateContent);
  assert.match(JSON.stringify(snapshot), /Updated public text/);
  assert.match(JSON.stringify(snapshot), /121, 23, 77/);
  assert.doesNotMatch(JSON.stringify(snapshot), /"tagName":"script"/);

  const playback = await browser.newPage();
  playback.on("pageerror", error => runtimeErrors.push(error.message));
  await playback.setContent('<!doctype html><div id="root"></div>');
  // rrweb remains pinned by the lockfile to the same alpha used by the current
  // dashboard player; keep this compatibility check when updating the recorder.
  const player = new URL("./rrweb.umd.min.cjs", import.meta.resolve("rrweb"));
  await playback.addScriptTag({ path: fileURLToPath(player) });
  await playback.evaluate(events => {
    window.player = new window.rrweb.Replayer(events, {
      root: document.querySelector("#root"),
      showWarning: true,
      mouseTail: false,
    });
    window.player.pause(events.at(-1).timestamp - events[0].timestamp + 100);
  }, events);
  await playback.waitForFunction(
    () => document.querySelector("iframe")?.contentDocument?.querySelector("h1")?.textContent === "Updated public text"
  );
  const replay = await playback.evaluate(() => {
    const doc = document.querySelector("iframe").contentDocument;
    return {
      heading: doc.querySelector("h1").textContent,
      inserted: doc.querySelector("#dynamic").textContent,
      input: doc.querySelector("#input").value,
      color: doc.defaultView.getComputedStyle(doc.querySelector("h1")).color,
    };
  });
  assert.equal(replay.inserted, "Inserted public node");
  assert.match(replay.input, /^\*+$/);
  assert.equal(replay.color, "rgb(121, 23, 77)");
  assert.deepEqual(runtimeErrors, []);
  console.log(
    JSON.stringify({ passed: true, sizes, replayEvents: events.length, replay, privacyVerified: true }, null, 2)
  );
} finally {
  await browser.close();
}
