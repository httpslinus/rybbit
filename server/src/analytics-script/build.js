import { build } from "esbuild";
import { mkdir, writeFile } from "fs/promises";
import { dirname, resolve } from "path";
import { minify } from "terser";
import { fileURLToPath } from "url";
import { gzipSync } from "zlib";

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

async function buildScript(entry, name, minified = true) {
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
    write: false,
  });
  let code = result.outputFiles[0].text;
  if (minified) {
    // Keep esbuild's tree-shaking and use Terser's extra compression passes.
    // Avoid unsafe transforms or property mangling: these scripts share public
    // browser APIs and must also work on sites with patched DOM prototypes.
    const result = await minify(code, { ecma: 2020, compress: { passes: 3 }, mangle: true });
    if (!result.code) throw new Error(`Empty bundle: ${name}`);
    code = result.code + "\n";
  }
  await writeFile(resolve(publicDir, name), code);
  console.log(`Built ${name}: ${Buffer.byteLength(code)} bytes (${gzipSync(code).length} gzip)`);
}

try {
  await mkdir(publicDir, { recursive: true });
  await buildScript("./index.ts", "script-full.js", false);
  await buildScript("./index.ts", "script.js");
  // Build only the recorder. Shipping rrweb's full UMD bundle also sends the
  // playback engine and its CSS parser to every recorded visitor.
  await buildScript("./replay.ts", "rrweb.min.js");
  await buildScript("./heatmapSnapshot.ts", "heatmap-snapshot.js");
} catch (error) {
  console.error("Build failed:", error);
  process.exitCode = 1;
}
