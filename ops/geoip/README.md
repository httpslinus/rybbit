# Cyberia GeoIP updates

Coolify application `rybbit-fork` (`scnuwfer47okgt1ouqesu7l3`) runs
`update.cjs` in the `rybbit-api` container every six hours, at 17 minutes past
midnight, 06:00, noon and 18:00 in the deployment server's timezone. The same
command runs after deployments, so newly built containers refresh their bundled
databases immediately. This does not redeploy the application or run migrations.

The saved Coolify commands download this script at an immutable commit revision
from `httpslinus/rybbit`, then run it from `/app`. They do not depend on a local
file existing in the running image. When editing the script, publish the change
and update the pinned revision in both saved commands. Do not overwrite an
unrelated deployment hook. Coolify owns the schedule and its execution history.

The source is the latest City and ASN database commits in `rybbit-io/rybbit`,
not the direct MaxMind release feed. Updates published there are picked up
within six hours. GitHub metadata is checked first; unchanged databases are
not downloaded again. Downloads use immutable commit URLs and must match the
Git blob checksum and valid MaxMind metadata. Older databases are rejected.

Both downloads are validated before either file is replaced. Workers reload
one at a time, with socket readiness and health checks before moving to the
next worker. A failed reload restores the original files. Unchanged data does
not restart workers. A lock prevents overlapping scheduled and deployment runs.

Run the updater and its tests from `server/`:

```sh
node ../ops/geoip/update.cjs
node --test ../ops/geoip/update.test.cjs
```

The live files and `.geoip-update.json` are in the API container's `/app`.
Container restarts retain them; replacement containers restore the newest
upstream files using the post-deployment command. The personal site's separate
GeoIP database is not updated by this task.
