# Heatmap verification

These scripts exercise only the isolated checkout-built `rybbit-local` stack at `http://localhost:18033`. They never connect to Cyberia or Sys. See [local setup](../local/README.md). Keep the ignored mode-0600 `plans/local/.env.local`; it contains local database/authentication secrets. QA signup credentials also stay in ignored `.cache/state.json`.

Run commands from the repository root. Docker and browser commands need access to the local Docker daemon, browser executable and loopback network. Browser scripts use the existing server Puppeteer dependency and an installed Chromium/Chrome; set `PUPPETEER_EXECUTABLE_PATH` if needed. Normal application APIs create the QA account, organization and sites. The responsive fixture uses a local HTTP server with a browser host-resolver mapping for `qa.heatmap.test`.

## Repeat the end-to-end gates

```sh
docker compose --env-file plans/local/.env.local -p rybbit-local -f docker-compose.yml -f plans/local/compose.yaml up -d --build
curl -fsS http://localhost:18033/api/health

# Trusted responsive browser interactions through the actual shipped tracker
node plans/heatmap-verification/collect-browser.mjs
node plans/heatmap-verification/render-browser.mjs

# Historical cohort/filter HTTP counts, then actual dashboard controls/dialogs
node plans/heatmap-verification/phase5-api.mjs
node plans/heatmap-verification/phase5-browser.mjs

# Authorized migration validation: disposable databases inside local Postgres
node plans/heatmap-verification/migrations.mjs

# Restart persistence: retain volumes and run verification before collecting again
node plans/heatmap-verification/restart.mjs prepare
docker compose --env-file plans/local/.env.local -p rybbit-local -f docker-compose.yml -f plans/local/compose.yaml restart
curl -fsS http://localhost:18033/api/health
node plans/heatmap-verification/restart.mjs verify
```

The responsive gates use widths 375/768/1440, DPR 2, fixed headers, scroll and SPA routes. Render checks compare canvas hotspot centroids with known iframe targets within 3 CSS px, rather than supplying mock report responses. They also exercise phone picker/fullscreen, keyboard controls, themes and a frame-blocked geometry-only view. Embedded fixtures disable their own tracker to prevent report self-pollution. Advanced gates assert normal API cohort counts, required segments under ANY, event-type eligibility, pageview-based bounce exclusion, expired membership, missing definitions, URL persistence and editing/deletion.

## Execute every real SQL fixture

```sh
bash plans/heatmap-verification/run-clickhouse.sh \
  src/api/analytics/getPages.clickhouse.test.ts \
  src/api/analytics/siteCardsQuery.clickhouse.test.ts \
  src/api/analytics/lite/siteCardsQuery.clickhouse.test.ts \
  src/api/analytics/users/userQueries.clickhouse.test.ts \
  src/services/heatmaps/heatmapQueryService.clickhouse.test.ts \
  src/services/heatmaps/heatmapCohortFilter.clickhouse.test.ts \
  src/api/analytics/users/deleteUser.test.ts \
  src/services/tracker/identityBackfillQueue.test.ts
```

The disposable Linux dependency image mounts source only, avoiding Darwin native dependencies. It joins `rybbit-local_default` without publishing database ports. All 61 database integration tests and 14 related unit tests passed; no suite skipped. Fixtures cover exact scroll maxima 30/60/100, retry deduplication before merges, host/site isolation, real timezones, all five UTMs and other metadata, ALL/ANY and required segments, missing metadata, historical cohorts, effective identity across devices and shared-device erasure. Final review adds site IDs above 65535 without erasing the wrapped foreign site, canonical IANA names, fixed-offset rejection and string identity operators across devices.

## Workspace checks

```sh
TZ=UTC pnpm test
pnpm typecheck
pnpm lint
pnpm build:server
pnpm build:client
pnpm --filter client exec eslint --config eslint.heatmaps.config.mjs \
  'src/app/[site]/heatmaps/page.tsx' src/components/heatmaps \
  src/api/analytics/endpoints/heatmaps.ts src/api/analytics/endpoints/cohorts.ts \
  src/api/analytics/hooks/heatmaps src/lib/heatmapUrlState.ts
node plans/heatmap-verification/normalize-locales.mjs
git diff --check
```

The final full suite passed 1,497 client and 2,916 server tests (4,413 total). Its 61 optional host SQL tests are executed separately by the real SQL runner above. UTC is deliberate: unchanged pre-existing PGlite OAuth/site-transfer tests mix timezone-less SQL timestamps with JavaScript dates and fail in the host's Europe/Tirane timezone; they pass unchanged in UTC. Heatmap timezone/DST tests specify their own zones and also pass against ClickHouse.

Root lint retains the repository's existing lint policy and ignores generated build/cache output. The additional scoped ESLint config applies actual Next.js/TypeScript rules to feature files. The client build invokes message extraction, which reorders locale files; normalization restores the baseline entries plus translated new keys without unrelated churn. All 88 feature messages are translated into the 11 other locales and retain matching ICU placeholders.

## Storage and browser performance

Run the storage benchmark while builds, uploads and browser measurements are paused:

```sh
bash plans/heatmap-verification/run-benchmark.sh
node plans/heatmap-verification/render-performance.mjs
```

[Benchmarks](benchmarks.md) record hardware, workload shape, batch latency, warm production reads, storage-row payloads, long sessions and LZ4/ZSTD(1). Synthetic benchmark databases are removed afterward. Renderer measurement uses a separately owned normal QA site and public validated batches, then the actual report API/canvas; its fixture is explicitly synthetic and does not replace responsive trusted-tracker evidence.

The dense renderer passed two measured runs. The latest run measured 101 trusted interactions at p95 31.3 ms/max 82.2 ms, 1,014 animation-frame gaps at max 76.5 ms, no interaction long tasks and an 18 ms maximum initial dense canvas draw. Cold page startup is recorded separately, including initial JavaScript long tasks. An earlier unattributed 258.3 ms frame gap and a premeasurement ingestion throttle remain in `previousAttempts`; neither is presented as a diagnosed renderer stall. The public ingestion limit is honored with immutable batches and `Retry-After` backoff.

## Lifecycle and existing recorder regression

```sh
bash plans/heatmap-verification/run-lifecycle.sh
node plans/heatmap-verification/browser-regressions.mjs
```

The lifecycle runner passed 12 actual HTTP/Redis/ClickHouse/Postgres checks. It tests disable/re-enable/rate changes, 12 concurrent retries, 30-day completed markers, both post-insert completion failures with shortened test-only lease expiry, physical duplicate rows across two sessions deduplicated to three logical clicks, the production identity queue, shared-device/foreign-site preservation, authenticated user/site erasure, cohort membership recomputation and real TTL expiry after repeated schema initialization. Helpers use explicit compose defaults and timestamp synthetic upload fixtures two seconds earlier to avoid the existing shared past-minutes endpoint's whole-second cutoff. Test sites, own rows/keys and the disposable TTL database are removed.

The actual recorder regression passed two automatic button events, one declarative custom event, an identified SPA pageview, two replay uploads containing 11 persisted full/incremental rrweb events with masked input, and three compact heatmap clicks. It reported no runtime or console errors. Prior interrupted attempts and QA observer/polling corrections remain in the evidence.

## Evidence and limitations

- [Final command and acceptance evidence](verification-evidence.json)
- [Parity matrix](parity-matrix.md)
- [Collection](collection-evidence.json), [responsive rendering](render-evidence.json)
- [Advanced HTTP](phase5-api-evidence.json), [advanced browser](phase5-browser-evidence.json)
- [Fresh/upgrade migrations](migration-evidence.json), [restart](restart-evidence.json)
- [Storage benchmark](benchmark-evidence.json), [renderer performance](performance-evidence.json)
- [Lifecycle](lifecycle-evidence.json), [replay/button recorder regression](browser-regressions-evidence.json)

Redis claims coordinate ingestion; ClickHouse and Redis do not form a distributed transaction. A crash after insert but before the completed marker may leave physical duplicate rows after the ten-minute processing lease expires. Every report deduplicates persisted `(site_id,batch_id,event_index)` before counting, independently of merges. Successful completion markers last 30 days.

The background is a live sandboxed iframe, not a stored screenshot. Layout changes, authentication, viewport-height-dependent content and embedding policy may differ from collection. Geometry-only mode retains points and counts. The known empty Stripe publishable-key runtime signature is recorded separately in browser evidence; responsive heatmap cold loads have no hydration failures. The existing replay dashboard page's HTTP 500 is recorded separately; the recorder/upload/read API regression uses actual rrweb data.

Migration and lifecycle cleanup touches only test-created local databases, sites, definitions and keys. Primary responsive QA samples remain available for review. No new Git branch, commit, push, VPS change or production deployment is part of this task.
