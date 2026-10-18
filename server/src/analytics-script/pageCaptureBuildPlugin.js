import { readFile } from "node:fs/promises";

const SNAPSHOT_VERSION = "2.0.0-alpha.20";
const NAMESPACE = "rrweb-snapshot-capture";
const CAPTURE_MODULES = {
  "./snapshot": { source: "../src/snapshot.ts", loader: "ts" },
  "./utils": { source: "../src/utils.ts", loader: "ts" },
  "@rrweb/types": { source: "../../types/dist/types.js", loader: "js" },
  "@rrweb/utils": { source: "../../utils/dist/utils.js", loader: "js" },
};

/**
 * The pinned npm release exposes only a prebuilt snapshot + rebuild bundle.
 * Its replay-only PostCSS initialization survives ordinary tree-shaking.
 * The published source map includes the original MIT-licensed modules, so
 * esbuild can bundle the unchanged capture graph instead. No network access,
 * vendored copy, dependency rewriting, or runtime loader is needed.
 *
 * A version change, missing source, or new runtime import fails the build:
 * review the capture graph and run test:analytics-bundles when upgrading.
 */
export function pageCaptureBuildPlugin() {
  return {
    name: NAMESPACE,
    async setup(build) {
      const entry = import.meta.resolve("rrweb-snapshot");
      const manifest = JSON.parse(await readFile(new URL("../package.json", entry), "utf8"));
      if (manifest.version !== SNAPSHOT_VERSION) {
        throw new Error(
          `Review the capture-only build for rrweb-snapshot ${manifest.version}; expected ${SNAPSHOT_VERSION}`
        );
      }
      const map = JSON.parse(await readFile(new URL(entry + ".map"), "utf8"));
      const modules = new Map();
      for (const [name, { source, loader }] of Object.entries(CAPTURE_MODULES)) {
        const index = map.sources.indexOf(source);
        const contents = map.sourcesContent?.[index];
        if (typeof contents !== "string" || !contents.trim()) {
          throw new Error(`Missing rrweb-snapshot capture source: ${source}`);
        }
        modules.set(name, { contents, loader });
      }
      modules.set("entry", { contents: 'export { default as snapshot } from "./snapshot";', loader: "js" });

      build.onResolve({ filter: /^rrweb-snapshot$/ }, () => ({ path: "entry", namespace: NAMESPACE }));
      build.onResolve({ filter: /.*/, namespace: NAMESPACE }, ({ path }) => {
        if (!modules.has(path)) {
          throw new Error(`Review the new rrweb-snapshot capture dependency: ${path}`);
        }
        return { path, namespace: NAMESPACE };
      });
      build.onLoad({ filter: /.*/, namespace: NAMESPACE }, ({ path }) => modules.get(path));
    },
  };
}
