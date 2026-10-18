import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import puppeteer from "puppeteer";

// Compare the shipped standalone capture with an ordinary build of the same
// entry against rrweb's complete published package. No captured DOM is saved.
const candidate = await readFile(new URL("../../public/page-capture.js", import.meta.url), "utf8");
assert.doesNotMatch(candidate, /\bpostcss\b/, "Page capture includes replay-only CSS processing");
const baselineBuild = await build({
  entryPoints: [fileURLToPath(new URL("./standalonePageCapture.ts", import.meta.url))],
  bundle: true,
  format: "iife",
  target: "es2020",
  platform: "browser",
  minify: true,
  write: false,
  alias: {
    "@rybbit/shared/dist/heatmapSnapshot.js": fileURLToPath(
      new URL("../../../shared/src/heatmapSnapshot.ts", import.meta.url)
    ),
    "@rybbit/shared/dist/heatmaps.js": fileURLToPath(new URL("../../../shared/src/heatmaps.ts", import.meta.url)),
  },
});
const baseline = baselineBuild.outputFiles[0].text;
const fixture = `<!doctype html><html><head>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="description" content="Public description">
  <link rel="stylesheet" href="/styles/main.css">
  <style>body{margin:0;min-height:2200px}.inline{color:rgb(121,23,77)}
    #scrollable{height:60px;overflow:auto}#scrollable p{height:300px}</style>
  </head><body>
  <h1 class="inline">Public heading</h1><p class="external">External stylesheet content</p>
  <p class="imported">Imported stylesheet content</p>
  <div class="rr-block">blocked-secret</div><div class="rr-mask">masked-secret</div>
  <div class="custom-block">custom-block-secret</div><div class="custom-mask">custom-mask-secret</div>
  <div class="selector-block" data-block>selector-block-secret</div><div data-private>selector-mask-secret</div>
  <form id="form"><input id="text" value="input-secret"><input type="password" value="password-secret">
    <input type="email" value="email-secret@example.test"><textarea>textarea-secret</textarea>
    <input type="checkbox" checked><input type="radio" checked>
    <select id="select"><option value="one">First choice</option><option value="two">Second choice</option></select>
  </form>
  <div id="shadow-host"></div><div id="scrollable"><p>Scrollable public content</p></div>
  <img src="/image.svg" srcset="/image.svg 1x, /image.svg 2x" width="30" height="20">
  <svg width="30" height="20"><rect width="30" height="20" fill="blue"></rect></svg>
  <canvas width="30" height="20"></canvas><video muted></video>
  <iframe src="/frame"></iframe><button onclick="void 'handler-secret'">Public button</button>
  <a href="javascript:void(0)">Public inert link</a><!-- public fixture comment -->
  </body></html>`;
const serverErrors = [];
const server = createServer((request, response) => {
  try {
    if (request.url === "/styles/main.css") {
      response.writeHead(200, { "Content-Type": "text/css" });
      return response.end('@import url("/styles/imported.css");.external{color:rgb(17,91,43)}');
    }
    if (request.url === "/styles/imported.css") {
      response.writeHead(200, { "Content-Type": "text/css" });
      return response.end('.imported{color:rgb(11,22,33);background-image:url("../image.svg")}');
    }
    if (request.url === "/image.svg") {
      response.writeHead(200, { "Content-Type": "image/svg+xml" });
      return response.end(
        '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="20"><rect width="30" height="20" fill="red"/></svg>'
      );
    }
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(request.url === "/frame" ? "<!doctype html><p>frame-private-content</p>" : fixture);
  } catch (error) {
    serverErrors.push(error.message);
    response.writeHead(500);
    response.end();
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const runtimeErrors = [];
const cases = [
  { name: "desktop defaults", width: 1440, config: {} },
  { name: "mobile defaults", width: 375, config: {} },
  {
    name: "selectors",
    width: 768,
    config: {
      sessionReplayBlockSelector: "[data-block]",
      sessionReplayMaskTextSelectors: ["[data-private]"],
    },
  },
  {
    name: "custom classes and input policy",
    width: 1440,
    config: {
      sessionReplayBlockClass: "custom-block",
      sessionReplayMaskTextClass: "custom-mask",
      sessionReplayBlockSelector: "[data-block]",
      sessionReplayMaskTextSelectors: ["[data-private]"],
      sessionReplayMaskAllInputs: false,
      sessionReplayMaskInputOptions: { password: true, email: true },
      sessionReplaySlimDOMOptions: false,
    },
  },
  {
    name: "slim DOM and selective masks",
    width: 1440,
    config: {
      sessionReplayMaskAllInputs: false,
      sessionReplayMaskInputOptions: { password: true, email: true, text: true, textarea: true, select: true },
      sessionReplaySlimDOMOptions: true,
    },
  },
  {
    name: "existing classless block-selector rejection",
    width: 1440,
    classlessBlock: true,
    expectedError: "Invalid snapshot attribute",
    config: { sessionReplayBlockSelector: "[data-block]" },
  },
];
let browser;
try {
  browser = await puppeteer.launch({ headless: true });
  async function capture(source, testCase) {
    const page = await browser.newPage();
    page.on("pageerror", error => runtimeErrors.push(error.message));
    try {
      await page.setViewport({ width: testCase.width, height: 600 });
      await page.goto(`${origin}/fixture`, { waitUntil: "load" });
      await page.evaluate(classlessBlock => {
        const shadow = document.querySelector("#shadow-host").attachShadow({ mode: "open" });
        shadow.innerHTML =
          '<style>.shadow{color:rgb(45,67,89)}</style><p class="shadow">Public shadow content</p><span class="rr-mask">shadow-secret</span>';
        document.querySelector("#text").value = "input-secret-live-value";
        document.querySelector("#select").value = "two";
        document.querySelector("#scrollable").scrollTop = 120;
        document.querySelector("canvas").getContext("2d").fillRect(0, 0, 30, 20);
        if (classlessBlock) document.querySelector("[data-block]").removeAttribute("class");
        window.scrollTo(0, 250);
      }, testCase.classlessBlock === true);
      await page.addScriptTag({ content: source });
      const captureSnapshot = () =>
        page.evaluate(config => {
          try {
            return window.rybbitPageCapture.capture(config);
          } catch (error) {
            return { captureError: error.message };
          }
        }, testCase.config);
      const snapshots = [await captureSnapshot()];
      await page.evaluate(() => {
        document.querySelector("h1").textContent = "Updated public heading";
        document.querySelector("#text").value = "input-secret-next-value";
        const paragraph = document.createElement("p");
        paragraph.textContent = "Dynamically inserted public node";
        document.body.appendChild(paragraph);
      });
      snapshots.push(await captureSnapshot());
      return snapshots;
    } finally {
      await page.close();
    }
  }

  let rebuildSnapshot;
  for (const testCase of cases) {
    const expected = await capture(baseline, testCase);
    const actual = await capture(candidate, testCase);
    assert.equal(actual.length, 2);
    // Compare IDs as well as DOM, styles, geometry, state and privacy fields.
    assert.ok(JSON.stringify(actual) === JSON.stringify(expected), `Snapshot parity failed: ${testCase.name}`);
    if (testCase.expectedError) {
      for (const snapshot of actual) assert.deepEqual(snapshot, { captureError: testCase.expectedError });
      continue;
    }
    const serialized = JSON.stringify(actual);
    assert.doesNotMatch(
      serialized,
      /"tagName":"(?:script|iframe|meta)"|"onclick"|handler-secret|frame-private-content/
    );
    assert.doesNotMatch(serialized, /password-secret|email-secret/);
    assert.match(serialized, /Updated public heading/);
    assert.match(serialized, /Dynamically inserted public node/);
    assert.match(serialized, /Public shadow content/);
    assert.match(serialized, /17, 91, 43/);
    assert.match(serialized, /11, 22, 33/);
    if (testCase.name === "custom classes and input policy") {
      assert.doesNotMatch(
        serialized,
        /custom-block-secret|custom-mask-secret|selector-block-secret|selector-mask-secret/
      );
      assert.match(serialized, /input-secret-live-value|textarea-secret/);
    } else {
      assert.doesNotMatch(serialized, /blocked-secret|masked-secret|shadow-secret|input-secret|textarea-secret/);
    }
    if (testCase.name === "selectors") {
      assert.doesNotMatch(serialized, /selector-block-secret|selector-mask-secret/);
    }
    if (testCase.name === "desktop defaults") rebuildSnapshot = actual[1];
  }

  // The dashboard still uses the complete package to rebuild static backgrounds.
  const viewer = await browser.newPage();
  viewer.on("pageerror", error => runtimeErrors.push(error.message));
  await viewer.setContent('<!doctype html><iframe id="viewer"></iframe>');
  await viewer.addScriptTag({
    path: fileURLToPath(new URL("./rrweb-snapshot.umd.cjs", import.meta.resolve("rrweb-snapshot"))),
  });
  const rebuilt = await viewer.evaluate(snapshot => {
    const doc = document.querySelector("iframe").contentDocument;
    window.rrwebSnapshot.rebuild(snapshot, {
      doc,
      cache: window.rrwebSnapshot.createCache(),
      mirror: window.rrwebSnapshot.createMirror(),
    });
    return {
      heading: doc.querySelector("h1").textContent,
      inlineColor: doc.defaultView.getComputedStyle(doc.querySelector(".inline")).color,
      externalColor: doc.defaultView.getComputedStyle(doc.querySelector(".external")).color,
      importedColor: doc.defaultView.getComputedStyle(doc.querySelector(".imported")).color,
      shadow: doc.querySelector("#shadow-host").shadowRoot?.querySelector(".shadow")?.textContent,
      checkbox: doc.querySelector('[type="checkbox"]').checked,
      input: doc.querySelector("#text").value,
      unsafeNodes: doc.querySelectorAll("script,iframe,[onclick]").length,
    };
  }, rebuildSnapshot);
  assert.equal(rebuilt.heading, "Updated public heading");
  assert.equal(rebuilt.inlineColor, "rgb(121, 23, 77)");
  assert.equal(rebuilt.externalColor, "rgb(17, 91, 43)");
  assert.equal(rebuilt.importedColor, "rgb(11, 22, 33)");
  assert.equal(rebuilt.shadow, "Public shadow content");
  assert.equal(rebuilt.checkbox, true);
  assert.match(rebuilt.input, /^\*+$/);
  assert.equal(rebuilt.unsafeNodes, 0);
  assert.deepEqual(runtimeErrors, []);
  assert.deepEqual(serverErrors, []);
  console.log(
    JSON.stringify(
      {
        passed: true,
        parityCases: cases.map(testCase => testCase.name),
        identicalSnapshots: cases.filter(testCase => !testCase.expectedError).length * 2,
        matchingRejections: cases.filter(testCase => testCase.expectedError).length * 2,
        dashboardRebuildVerified: true,
        runtimeErrors: runtimeErrors.length,
      },
      null,
      2
    )
  );
} finally {
  if (browser) await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
