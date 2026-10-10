import { build } from "esbuild";
import { existsSync, mkdirSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Ensure public directory exists
const publicDir = "../../public";
if (!existsSync(publicDir)) {
  mkdirSync(publicDir, { recursive: true });
}

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

async function buildScript() {
  try {
    // Build the full version
    await build({
      entryPoints: ["./index.ts"],
      bundle: true,
      format: "iife",
      target: "es2020",
      outfile: "../../public/script-full.js",
      minify: false,
      sourcemap: false,
      platform: "browser",
      alias: bundleContractFromSource,
    });

    console.log("✅ Built script-full.js");

    // Build the minified version
    await build({
      entryPoints: ["./index.ts"],
      bundle: true,
      format: "iife",
      target: "es2020",
      outfile: "../../public/script.js",
      minify: true,
      sourcemap: false,
      platform: "browser",
      alias: bundleContractFromSource,
    });

    console.log("✅ Built script.js (minified)");

    await build({
      entryPoints: ["./heatmapSnapshot.ts"],
      bundle: true,
      format: "iife",
      target: "es2020",
      outfile: "../../public/heatmap-snapshot.js",
      minify: true,
      sourcemap: false,
      platform: "browser",
      alias: bundleContractFromSource,
    });
    console.log("✅ Built heatmap-snapshot.js (minified)");
  } catch (error) {
    console.error("Build failed:", error);
    process.exit(1);
  }
}

buildScript();
