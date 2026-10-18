import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

// Compare pinned upstream assets with the fork's current production build.
const upstream = process.argv[2] ?? "1a8f1ff9ca8beca1c2207866d659d34be3cdcae8";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const publicDir = new URL("../../public/", import.meta.url);
const at = (ref, name) => gzipSync(execFileSync("git", ["show", `${ref}:server/public/${name}`], { cwd: root })).length;
const now = name => gzipSync(readFileSync(new URL(name, publicDir))).length;
const mainCore = at(upstream, "script.js");
const mainRecording = at(upstream, "rrweb.min.js");
const core = now("script.js");
const recording = now("recording.js");
const heatmaps = now("heatmaps.js");
const capture = now("page-capture.js");
const kb = bytes => `${(bytes / 1000).toFixed(1)} kB`;
const rows = [
  ["Core tracker", kb(mainCore), kb(core)],
  ["Session recording module", kb(mainRecording), kb(recording)],
  ["Heatmap module", "Not available", kb(heatmaps)],
  ["Standalone page capture", "Not available", kb(capture)],
  ["Core + recording", kb(mainCore + mainRecording), kb(core + recording)],
  ["Core + heatmaps + recording", "Not available", kb(core + heatmaps + recording)],
  ["All modules, including fallback", "Not available", kb(core + heatmaps + recording + capture)],
];
console.log(`Upstream: ${upstream}\nGzip, decimal kB, cold cache. Collected event data is excluded.\n`);
console.log("| Download | Upstream Rybbit | This fork |");
console.log("| --- | ---: | ---: |");
for (const row of rows) console.log(`| ${row.join(" | ")} |`);
