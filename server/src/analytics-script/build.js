import { build } from "esbuild";
import { mkdir, writeFile } from "fs/promises";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { gzipSync } from "zlib";
import { pageCaptureBuildPlugin } from "./pageCaptureBuildPlugin.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const publicDir = resolve(__dirname, "../../public");

// The tracker shares the Bot Signal contract with the server through
// @rybbit/shared, which is published as CommonJS. Resolving it normally would
// bundle the module unshaken, so point esbuild at the TypeScript source and let
// it tree-shake down to the handful of values the browser actually uses. The
// alias names the contract module, not the package barrel, so nothing else in
// @rybbit/shared can ever reach a tracked page.
const botSignalContractSource = resolve(__dirname, "../../../shared/src/botSignalContract.ts");
const bundleContractFromSource = {
  "@rybbit/shared/dist/botSignalContract.js": botSignalContractSource,
  "@rybbit/shared/dist/heatmaps.js": resolve(__dirname, "../../../shared/src/heatmaps.ts"),
  "@rybbit/shared/dist/heatmapSnapshot.js": resolve(__dirname, "../../../shared/src/heatmapSnapshot.ts"),
};

async function buildScript(entry, name, minified = true, plugins = []) {
  const result = await build({
    absWorkingDir: __dirname,
    entryPoints: [entry],
    bundle: true,
    format: "iife",
    target: "es2020",
    minify: minified,
    sourcemap: false,
    platform: "browser",
    alias: bundleContractFromSource,
    plugins,
    write: false,
  });
  const code = result.outputFiles[0].text;
  await writeFile(resolve(publicDir, name), code);
  console.log(`Built ${name}: ${Buffer.byteLength(code)} bytes (${gzipSync(code).length} gzip)`);
}

try {
  await mkdir(publicDir, { recursive: true });
  await buildScript("./index.ts", "script-full.js", false);
  await buildScript("./index.ts", "script.js");
  // Build only the recorder. Shipping rrweb's full UMD bundle also sends the
  // playback engine and its CSS parser to every recorded visitor.
  await buildScript("./sessionRecorderBundle.ts", "recording.js");
  await buildScript("./heatmapBundle.ts", "heatmaps.js");
  await buildScript("./standalonePageCapture.ts", "page-capture.js", true, [pageCaptureBuildPlugin()]);
  // Existing cached trackers still request the recording library on its own.
  await buildScript("./sessionRecorderLibrary.ts", "rrweb.min.js");
} catch (error) {
  console.error("Build failed:", error);
  process.exitCode = 1;
}
