import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const cache = new URL(".cache/old-drizzle/", import.meta.url);
const migrationDirectory = new URL("../../server/drizzle/", import.meta.url);
const journal = JSON.parse(await readFile(new URL("meta/_journal.json", migrationDirectory), "utf8"));
await mkdir(new URL("meta/", cache), { recursive: true });
const oldJournal = { ...journal, entries: journal.entries.filter(entry => entry.idx < 25) };
await writeFile(new URL("meta/_journal.json", cache), JSON.stringify(oldJournal));
for (const entry of oldJournal.entries) {
  await cp(new URL(`${entry.tag}.sql`, migrationDirectory), new URL(`${entry.tag}.sql`, cache));
}

function sql(database, statement) {
  return execFileSync("docker", ["exec", "-i", "rybbit-local-postgres", "sh", "-c",
    'exec psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$1" -At', "sh", database],
    { input: statement, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}
function migrate(database, directory) {
  execFileSync("docker", ["run", "--rm", "--network", "rybbit-local_default",
    "--env-file", `${root}plans/local/.env.local`, "-e", `POSTGRES_DB=${database}`,
    "--mount", `type=bind,src=${directory},dst=/app/drizzle,readonly`,
    "--entrypoint", "./node_modules/.bin/drizzle-kit", "rybbit-local-backend:workspace",
    "migrate", "--config=drizzle.config.ts"], { stdio: ["ignore", "pipe", "pipe"] });
}
function object(database, statement) { return JSON.parse(sql(database, statement)); }
const suffix = randomBytes(6).toString("hex");
const databases = [`heatmap_upgrade_${suffix}`, `heatmap_fresh_${suffix}`];
const evidence = { completedAt: null, isolation: "Disposable databases inside rybbit-local-postgres only", checks: [] };
try {
  for (const database of databases) sql("analytics", `CREATE DATABASE "${database}";`);
  const [upgrade, fresh] = databases;
  migrate(upgrade, fileURLToPath(cache));
  assert.equal(sql(upgrade, "SELECT count(*) FROM information_schema.columns WHERE table_name='sites' AND column_name='heatmaps';"), "0");
  sql(upgrade, `INSERT INTO sites (name,domain,"sessionReplay","trackButtonClicks") VALUES ('Old site','old-upgrade.example.test',true,true);`);
  migrate(upgrade, fileURLToPath(migrationDirectory));
  const oldSite = object(upgrade, `SELECT row_to_json(s) FROM (SELECT name,domain,"sessionReplay","trackButtonClicks",heatmaps,heatmap_sample_rate FROM sites) s;`);
  assert.deepEqual(oldSite, { name: "Old site", domain: "old-upgrade.example.test", sessionReplay: true, trackButtonClicks: true, heatmaps: false, heatmap_sample_rate: 15 });
  evidence.checks.push({ name: "Existing pre-feature site upgrade preserves settings and defaults collection off at 15%", passed: true, observed: oldSite });
  migrate(fresh, fileURLToPath(migrationDirectory));
  sql(fresh, "INSERT INTO sites (name,domain) VALUES ('Fresh site','fresh-install.example.test');");
  const newSite = object(fresh, "SELECT row_to_json(s) FROM (SELECT heatmaps,heatmap_sample_rate FROM sites) s;");
  assert.deepEqual(newSite, { heatmaps: false, heatmap_sample_rate: 15 });
  assert.equal(sql(fresh, "SELECT count(*) FROM information_schema.tables WHERE table_name='cohorts';"), "1");
  evidence.checks.push({ name: "Fresh installation creates cohort definitions and defaults new sites off at 15%", passed: true, observed: newSite });
  for (const database of databases) {
    migrate(database, fileURLToPath(migrationDirectory));
    assert.equal(Number(sql(database, 'SELECT count(*) FROM drizzle.__drizzle_migrations;')), journal.entries.length);
    for (const rate of [0, 15, 100]) sql(database, `UPDATE sites SET heatmaps=true,heatmap_sample_rate=${rate};`);
    sql(database, `DO $$ BEGIN
      BEGIN UPDATE sites SET heatmap_sample_rate=-1; RAISE EXCEPTION 'invalid negative rate accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
      BEGIN UPDATE sites SET heatmap_sample_rate=101; RAISE EXCEPTION 'invalid oversized rate accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
      BEGIN UPDATE sites SET heatmap_sample_rate='NaN'::real; RAISE EXCEPTION 'NaN rate accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
    END $$;`);
  }
  evidence.checks.push({ name: "Repeated migrations are idempotent and sample-rate constraints accept 0/15/100 but reject -1/101/NaN", passed: true, migrationCount: journal.entries.length });
  evidence.completedAt = new Date().toISOString();
} finally {
  for (const database of databases) sql("analytics", `DROP DATABASE IF EXISTS "${database}" WITH (FORCE);`);
}
await writeFile(new URL("migration-evidence.json", import.meta.url), JSON.stringify(evidence, null, 2) + "\n");
console.log(`Passed ${evidence.checks.length} fresh/upgrade migration checks; disposable databases removed.`);
