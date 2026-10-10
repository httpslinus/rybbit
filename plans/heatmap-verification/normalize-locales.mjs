import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const directory = new URL("../../client/messages/", import.meta.url);
const retiredMessageIds = new Set([
  "+cwRUL",
  "0jmIXV",
  "3fjXBS",
  "5laS0t",
  "69vvet",
  "B2ADID",
  "IeyT60",
  "JaSvR0",
  "SV4jZk",
  "Tb8Tak",
  "UAVBcs",
  "W8noVv",
  "WhfKQX",
  "ZHD2s7",
  "Zrm04A",
  "ajAsKV",
  "bdhDjs",
  "eIxOl4",
  "hPG7kH",
  "n6y0PU",
  "ttyUm0",
  "x3JS8n",
  "xqrBCi",
]);
const english = JSON.parse(readFileSync(new URL("en.json", directory), "utf8"));
for (const filename of readdirSync(directory).filter(name => name.endsWith(".json"))) {
  const path = new URL(filename, directory);
  const current = JSON.parse(readFileSync(path, "utf8"));
  const baseline = JSON.parse(
    execFileSync("git", ["show", `HEAD:client/messages/${filename}`], { cwd: root, encoding: "utf8" })
  );
  // Preserve existing translations and unrelated unused keys. Explicitly retired
  // separator messages must stay removed after extraction and native builds.
  const merged = Object.fromEntries(Object.entries(baseline).filter(([key]) => !retiredMessageIds.has(key)));
  for (const key of Object.keys(english)) {
    if (!retiredMessageIds.has(key)) merged[key] = current[key] || baseline[key] || english[key];
  }
  const sorted = Object.fromEntries(
    Object.keys(merged)
      .sort()
      .map(key => [key, merged[key]])
  );
  writeFileSync(path, `${JSON.stringify(sorted, null, 2)}\n`);
}
