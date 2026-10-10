# Plan 001: Add independently sampled click and scroll heatmaps

> Completed 2026-10-10 on the existing `master` branch. All six phases and acceptance gates passed; see the [verification runbook](heatmap-verification/README.md), [parity matrix](heatmap-verification/parity-matrix.md) and [command evidence](heatmap-verification/verification-evidence.json). Migration generation and validation were explicitly authorized for the isolated local database. Changes remain uncommitted; no push or deployment was performed.
>
> Executor: read this entire plan before implementing. Work on the existing branch. Do not create branches, commit, push, or deploy unless separately requested. Update `plans/README.md` when implementation starts and when its acceptance gates pass.
>
> Drift check: `git diff --stat 6f845412..HEAD -- server/src client/src shared/src server/drizzle docs/content`. Reconcile changed code against the excerpts below before following the steps.

- Planned at: Rybbit commit `6f845412`, 2026-10-10.
- Priority: P1. Effort: L. Implementation risk: medium, concentrated in coordinate alignment, analytics filtering, and ingestion volume.
- Estimate: 12–20 engineer days for the core report; another 4–7 for the missing cohort/filter capabilities and final parity verification. These are planning estimates, not measured delivery dates.
- Depends on: no other plan. Execute the phases below in order.
- Target: the open-source, self-hosted Umami heatmap feature as inspected on 2026-10-10, upstream commit `ec0ff50388c264ed8ce46f00967e92f7e71476ae`. Umami describes heatmaps as included in self-hosted v3.2 and later.

## Why this matters

Rybbit can replay individual sessions and track button events, but cannot answer where visitors click across a page or how far they scroll. Heatmaps should work with replay disabled, so operators can collect useful aggregate interaction data without recording the DOM. Use compact ClickHouse rows and the existing Rybbit script/configuration pipeline rather than replay scans or a second recorder install.

## Verified parity target

The following is supported by upstream source, not inferred from screenshots. Links are pinned to the inspected commit; the product/API docs describe the current public interface.

| Capability                                                  | Umami evidence                                    | Rybbit target                                                                                         |
| ----------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Enable per website, independently of replay                 | `WebsiteReplaySettings.tsx`, `recorder/index.js`  | `heatmaps` setting defaults off; replay remains independently controlled                              |
| Separate sample rate                                        | same settings/recorder; default 0.15              | `heatmapSampleRate` defaults 15%, persisted per site, valid 0–100%; UI presents percent               |
| Capture primary clicks anywhere                             | recorder `beginHeatmapCapture`                    | Capture trusted primary clicks, including non-button content and links                                |
| Coordinates and geometry                                    | recorder/save/query                               | Viewport x/y, page x/y, viewport width/height, document width/height                                  |
| Scroll reach                                                | recorder `computeScrollPct`, SQL `getHeatmap`     | Maximum visible depth per session/page, 10 percentage-point buckets, cumulative reach overlay         |
| SPA navigation                                              | recorder history hooks                            | Flush old route and reset scroll state through Rybbit's existing navigation lifecycle                 |
| Page picker and search                                      | `HeatmapsPage.tsx`, `Heatmap.tsx`                 | Searchable pages with counts and distinct sampled sessions; separate selected page per mode           |
| Click and scroll views                                      | same UI                                           | Two modes with overlays, counts, low/high legend, empty/loading/error states                          |
| Responsive layout segmentation                              | `Heatmap.tsx`                                     | Nearest buckets 320, 375, 425, 768, 1024, 1440, 1920 CSS pixels; select observed buckets only         |
| Page background                                             | SQL `resolveHeatmapSnapshot`, UI `IframeSnapshot` | Live iframe of validated site origin/path at the selected layout dimensions                           |
| Date, timezone, visitor/acquisition filters                 | API docs, SQL filter context                      | Reuse Rybbit date/filter pipeline; include saved segments and the missing filter semantics in phase 5 |
| Saved cohort, all/any filters, event type, bounce exclusion | API docs and SQL filter context                   | Phase 5 is mandatory before calling the result full parity                                            |
| Self-hosted availability and authorized API                 | product docs, API route                           | Available self-hosted without subscription or replay quota; authenticated heatmap read API            |

Sources:

- [Umami self-hosted availability](https://umami.is/product-analytics).
- [Heatmap API](https://docs.umami.is/docs/api-reference/get-website-heatmaps).
- [Settings source](https://github.com/umami-software/umami/blob/ec0ff50388c264ed8ce46f00967e92f7e71476ae/src/app/%28main%29/websites/%5BwebsiteId%5D/settings/WebsiteReplaySettings.tsx).
- [Capture source](https://github.com/umami-software/umami/blob/ec0ff50388c264ed8ce46f00967e92f7e71476ae/src/recorder/index.js).
- [Aggregation and filter source](https://github.com/umami-software/umami/blob/ec0ff50388c264ed8ce46f00967e92f7e71476ae/src/queries/sql/heatmap/getHeatmap.ts).
- [Report source](https://github.com/umami-software/umami/blob/ec0ff50388c264ed8ce46f00967e92f7e71476ae/src/app/%28main%29/websites/%5BwebsiteId%5D/%28reports%29/heatmaps/Heatmap.tsx).

Umami's `snapshot` is currently an iframe descriptor, not a stored screenshot or rrweb DOM snapshot. Mouse-movement heatmaps, rage/dead-click classification, exports, element-ranking tables, and historical screenshot capture are not part of this verified parity target. The report/API is feature-equivalent; matching Umami's URLs or wire names is unnecessary.

## Current Rybbit architecture and constraints

Read `server/AGENTS.md` and `client/AGENTS.md` before implementation. Server code is TypeScript ESM with `.js` import specifiers, Fastify, Zod, Drizzle/Postgres, ClickHouse and Vitest. Client code is Next.js 16/React 19, TanStack Query, Zustand, Shadcn and next-intl. Match adjacent files and existing light/dark theme variables.

Concrete starting points:

- `server/src/db/postgres/schema.ts:92`: `sessionReplay: boolean().default(false)`. Add heatmap settings alongside this; there are no existing heatmap fields.
- `server/src/services/sites/siteConfigurationLifecycle.ts`: authoritative create/update/delete service. Both `CreateSiteInput` and `UpdateSiteConfigurationInput`, `DIRECT_UPDATE_FIELDS`, defaults, type validation and deletion must be extended. Adding only the HTTP schema will silently lose the setting.
- `server/src/lib/siteConfig.ts`: `SiteConfigData` and cached/defaulted row mapping. Tracking config must pass through this service and its invalidation lifecycle.
- `server/src/api/sites/getTrackingConfig.ts`: public tracker config endpoint returns `sessionReplay` and applies mobile/entitlement overrides. Add independent heatmap fields.
- `server/src/analytics-script/config.ts`: fetches `/site/tracking-config/:siteId`; merges script attributes into `ScriptConfig`.
- `server/src/analytics-script/tracking.ts:549`: `onPageChange()` already notifies recorder; use it for heatmaps as well. Coordinate collection belongs in a new module, not `clickTracking.ts`, whose button tracking includes a one-second throttle and gathers text rather than geometry.
- `server/src/analytics-script/sessionReplay.ts:240`: replay batch metadata uses `screen.width/height` and flush-time `window.location.href`. Neither is reliable for heatmap viewport/path attribution. Capture `innerWidth/innerHeight` and route/geometry at interaction time.
- `server/src/api/sessionReplay/recordSessionReplay.ts`: model for Zod validation, server-side identity/session assignment, exclusions and usage checks. Its replay enablement/quota guard must not gate heatmaps.
- `server/src/services/replay/sessionReplayIngestService.ts`: model for server-side anonymous fingerprint and `sessionsService.updateSession()`. Cloud replay payloads can live in R2; never scan or depend on them for heatmaps.
- `server/src/db/clickhouse/schema/core.ts:280`: replay uses a MergeTree table with UTC millisecond timestamps and 30-day TTL. Add a separate heatmap schema initializer, invoked from `clickhouse.ts`, using existing idempotent initialization helpers.
- `server/src/services/sites/siteConfigurationLifecycle.ts:547`, `server/src/api/analytics/users/deleteUser.ts`: explicit table deletion lists. Add heatmap deletion, preserving the shared-device identity erasure rules.
- `server/src/services/tracker/identityBackfillQueue.ts`: identity backfill has an explicit table list; add heatmap rows so anonymous-to-identified filtering stays consistent.
- `server/src/api/routes.ts:254`: the authoritative registration location is this file, not `index.ts`. Its `site()` helper resolves site ID, enforces permission, validates time/filter input, and expands saved segments. Use it.
- `shared/src/permissions.ts`, `shared/src/scopes.ts`: role/bearer permission taxonomy. A heatmap read must be declared explicitly; route registration tests enforce it.
- `client/src/api/analytics/useAnalyticsQuery.ts`, `analyticsRequest.ts`: derive query key from the full serialized request; use these wrappers for dates/filters/timezone rather than manually constructing a partial key.
- `client/src/app/[site]/replay/page.tsx`: existing `SubHeader` and analytics layout pattern. Add a sibling heatmaps route, not a mode inside the replay player.
- `client/src/components/SiteSettings/TrackingTab.tsx`, `client/src/api/admin/endpoints/sites.ts`: settings UI and site request/response types.
- `client/src/app/[site]/components/Sidebar/Sidebar.tsx` and `MobileSidebar.tsx`: navigation targets. The replay sidebar has desktop/mobile and plan restrictions that must not inadvertently hide self-hosted heatmaps.
- Saved segments exist; saved cohorts, all/any combination controls, and heatmap-specific bounce/event-type selectors do not currently exist. This is a real parity dependency, not merely a new chart.

Current pattern excerpts to retain:

```ts
// server/src/api/routes.ts:254 — route security/time/filter convention
const site = (permission: Permission, options = {}) => ({
  // preHandler: resolveSiteId, requireSitePermission,
  // validateTimeParams, validateFilterParam, expandSegmentParam
  config: { access: { level: "site", permission, allowPublic: false } },
});

// server/src/api/sites/getTrackingConfig.ts — replay is independently gated
const sessionReplay = config.type === "mobile"
  ? false
  : config.sessionReplay && !usageService.isSiteWithoutReplay(config.siteId);

// server/src/analytics-script/tracking.ts:549 — one SPA lifecycle
onPageChange(): void {
  void this.refreshFeatureFlags();
  if (this.sessionReplayRecorder) this.sessionReplayRecorder.onPageChange();
}
```

The first excerpt is abbreviated to show the contract; inspect the live helper for its complete typed implementation.

## Scope and implementation decisions

In scope: new `shared/src/heatmaps.ts` and exports; site/config/lifecycle code above and focused tests; new `server/src/analytics-script/heatmaps.ts`; new `server/src/api/heatmaps/` and `server/src/services/heatmaps/`; ClickHouse initializer/time-column registration; route/CORS/access/logging integration; deletion/backfill lists; new client heatmap API hooks/components/route; settings/navigation/locales; minimal cohort/filter additions specified in phase 5; focused docs and verification fixtures. Dependency lockfile changes are allowed only if the renderer or browser-test tooling requires them.

Postgres migration files are a required implementation prerequisite for persisted settings/cohorts. This planning task does not generate or run them. The server AGENTS requires explicit authorization for generating migration files and migration commands; obtain that authorization as part of the implementation request before that phase. Never apply migrations to either VPS for local verification.

Out of scope: production deployment, existing replay serialization/storage overhaul, mobile SDK heatmaps, tracking exports, unrelated cleanup, replacing session identity, and a general event-model rewrite. Do not change existing analytics filter semantics globally just to satisfy this report.

### Data contract

Use a discriminated `click | scroll` event with bounded fields, shared read-response types, and server-local Zod schemas. A batch contains a random `batchId`, a bounded `events` array, and optional identified user ID. Each interaction contains capture timestamp, hostname, normalized tracked path, viewport/document dimensions, and a per-page-visit identifier. Clicks additionally contain client x/y and page x/y; scroll updates contain max depth 0–100. Sample decisions and batch IDs must be namespaced by analytics host plus site ID.

Store `site_id`, server-assigned `session_id`, anonymous `user_id`, `identified_user_id`, `timestamp DateTime64(3, 'UTC')`, `page_visit_id`, `batch_id`, `event_index`, type, hostname/path, viewport bucket/dimensions, document dimensions, geometry and max depth. Use UInt32 for document dimensions: long pages can exceed 65,535 pixels. Keep nullable type-specific fields and explicitly reject NaN, infinity, impossible/negative dimensions and oversize paths/arrays.

Use a MergeTree layout partitioned monthly, ordered by `(site_id, hostname, pathname, viewport_bucket, timestamp, session_id)`, with 30-day TTL initially. Store raw compact interactions; postpone materialized rollups until benchmarks justify them. This keeps filtered queries and user/site erasure straightforward.

Capture fields at the moment of interaction. Do not send DOM text, input values, selectors containing text, full DOM snapshots or query-string values solely for heatmaps. Reuse existing URL masking/fragment policy. Join existing analytics data for acquisition/event/title/query filters with explicit site/time/page bounds. Define the behavior for heatmap-only sessions that lack a corresponding analytics event: unfiltered geometry can remain visible, while filters requiring absent analytics metadata cannot match.

Response: `mode`, `pages` (hostname/path, count, sessions), `points` (geometry and count), `scroll` (max-depth histogram plus denominator), `background` (validated iframe URL and dimensions), and `truncated`/limit metadata. Default page limit 100 and point limit 5,000 match Umami. Never silently present a top-N response as all data.

### Storage budget and quality-preserving reductions

Added after the storage review. The local instance has zero replay rows, so there is no observed per-session comparison yet. Budget provisionally for 20 retained compact interaction records per sampled session at 100 compressed bytes each: 2 KB/session. This is a sizing assumption to benchmark, not a measured ClickHouse result or an upper bound. Long sessions, path/identifier cardinality and small insert parts can cost more. One million monthly sessions at 15% sampling gives about 300 MB of compressed event payload per 30-day window; 100% gives about 2 GB. Separately account for indexes/part metadata, temporary merge space, backups and replicas.

Preserve quality before lowering sampling:

- Store exact click coordinates and dimensions in typed columns; no DOM, text, screenshots, mouse movements or JSON property bags. Use appropriately sized numeric types and low-cardinality path/host encodings where benchmarks support them. Compare ZSTD(1) with the default codec and choose from observed CPU/size results.
- Coalesce scroll maxima in memory until a periodic/route/unload flush. Keep the initial reach and durable checkpoints, but do not append a row for every scroll callback. Within one flush, only the highest reach for a page visit and compatible viewport/document geometry is needed. Do not merge across routes or resize/layout changes. The report still derives the maximum per session/page/bucket; retaining every intermediate scroll position does not improve that result.
- Batch across sessions before writing small ClickHouse parts through the established async insert settings. Keep stable IDs compact when their existing format permits lossless representation. Repeated geometry columns may compress better than introducing a separate dimension table; measure before normalizing them into extra joins.
- Retain raw compact rows for the planned 30 days. Longer-lived rollups are optional later, because dimensions omitted from a rollup prevent future filtering and aggregated identity removal requires a separate design.
- Keep sampling configurable. Use 100% for low-traffic pages where rare interactions matter; 15% can be suitable for busy sites, but sparse page/device/cohort slices must show their sample counts. Sampling, coordinate quantization and dropping arbitrary clicks are quality tradeoffs, not lossless storage optimizations.

Acceptance measurement: report `sum(bytes_on_disk)` and `sum(rows)` over active `system.parts`, together with compressed/uncompressed payload bytes, sampled sessions and interactions/session. Include a representative long-session case. Measure replay bytes/session at the same sampling rate and retention before claiming a specific reduction ratio. Total heatmap/replay storage depends on both per-session size and how many sessions each feature captures.

## Phase 1 — Persist independent settings and declare API access (2–3 days)

1. Add `heatmaps=false` and `heatmapSampleRate=15` in the sites schema and all create/update/default/config/type paths. Validate finite rate in [0,100]; reject enabling heatmaps on mobile sites. Old sites keep collection off. Extend client site types and public tracker config. Extend lifecycle cache invalidation rather than inventing a second cache.
2. Add `heatmaps:read` as a viewer permission and bearer scope. Configuration uses existing `sites:write`; no heatmap write scope is needed for the public recorder. Add authenticated `GET /sites/:siteId/heatmaps` using `site("heatmaps:read")`. Do not opt into public/private-share reads by copying `publicReplayRead`: Umami's inspected endpoint requires authenticated website access. Keep frontend navigation and API authorization consistent.
3. Register public `POST /heatmaps/record/:siteId`, with explicit route access, bounded body size and rate limiting consistent with existing ingestion. Add its path to tracking CORS classification in `server/src/lib/cors.ts` and successful high-volume logging rules.
4. Self-hosted heatmaps bypass cloud billing and replay quota. Preserve existing cloud behavior; if a cloud heatmap entitlement is required, make it separate from replay collection and document its policy. Never count clicks/scroll samples as purchased pageviews.

Verify: `pnpm --filter @rybbit/shared build`; `pnpm --filter rybbit-backend test:run src/api/sites/getTrackingConfig.test.ts src/api/sites/updateSiteConfig.test.ts src/services/sites/siteConfigurationLifecycle.test.ts src/api/routes.test.ts src/lib/cors.test.ts`; `pnpm typecheck` → exit 0. Review the intentional route-access snapshot update; do not blindly accept unrelated route changes.

Tests: settings round trip, defaults, rate 0/15/100 and invalid rates, replay off/heatmaps on, mobile rejection, viewer/owner/foreign-site/anonymous/bearer scope matrix, config invalidation. Follow `getTrackingConfig.test.ts` and the lifecycle `vi.hoisted` mocks.

## Phase 2 — Capture compact clicks and scroll reach (2–3 days)

1. Implement `HeatmapRecorder` in the new tracker module. Initialize only when enabled and selected by its independent site-scoped 0–100 sample rate. Reuse tracker lifecycle hooks for navigation, identity change and cleanup. Do not load rrweb for heatmaps-only sites and do not create another history patch.
2. Collect trusted primary clicks in a passive capture listener over the document. Record client coordinates and page coordinates accounting for horizontal/vertical scroll; use `innerWidth/innerHeight`. Read bounded document/body/scrolling-element sizes and target bounds. Avoid walking the whole DOM for every click.
3. On load, resize and throttled scroll, compute visible reach `clamp((scrollY + innerHeight) / max(1, documentHeight) * 100, 0, 100)`. Record an initial reach even when the user never scrolls; a one-screen page starts at 100%. Track the maximum per page visit, coalescing updates until the next periodic/route/unload flush rather than queueing every scroll callback. Flush the old-route final maximum before SPA reset. Preserve separate checkpoints when viewport/document geometry changes and attribute them to capture-time path and dimensions.
4. Keep buffers bounded, flush on a fixed interval (suggest 5s), event threshold (100), `visibilitychange:hidden` and `pagehide`. Split into byte-bounded chunks below the browser keepalive/beacon budget (target <48 KiB). Use `credentials:omit`. Retain failed chunks for bounded retries with the same batch ID. Keep retry errors observable in debug mode. Stable listener references must be removed on cleanup.
5. Sampling decision is stable through a page visit/session, and independent of replay sampling. Use a site/host scoped sessionStorage entry with an explicit expiry and a memory fallback. Do not inherit the existing globally named replay sampling key. Preserve existing consent/disable behavior; explain heatmap collection in tracker docs.

Verify: `pnpm --filter rybbit-backend test:run src/analytics-script/heatmaps.test.ts src/analytics-script/config.test.ts src/analytics-script/tracking.test.ts`; `pnpm build:server` → exit 0, rebuilt script includes heatmap support. Existing replay/button tests must remain green.

Tests: coordinates after scrolling, tablet/mobile taps producing a primary click without duplicate touch listeners, trusted/untrusted/right clicks, initial/no-scroll reach, short/long/dynamic page, resize, rapid route changes, push/replace/pop navigation through existing hooks, identity switch, rates 0/100, host/site sampling isolation, storage unavailable, byte splitting, failed response/retry, unload flush and cleanup.

## Phase 3 — Ingest and aggregate in ClickHouse (3–4 days)

1. Add `schema/heatmaps.ts`, initialize it from `clickhouse.ts`, and register UTC time columns. Startup must be idempotent on an empty database and an upgraded instance.
2. Implement Zod validation and a thin record handler using server-generated fingerprint and `sessionsService.updateSession()`; do not trust client session IDs. Apply `decideSiteExclusion` to each captured hostname/path, bot exclusions, first-party proxy IP resolution, and applicable site-wide limits. A mixed SPA batch must not evade exclusions using only its last URL. Replay disabled/quota must not block it.
3. Add deduplication keyed by resolved site and batch ID, with atomic Redis claims and completion state. Concurrent identical requests must insert once. Clear claim on confirmed pre-insert failure; acknowledge repeats only after completion. ClickHouse/Redis cannot provide a distributed transaction: explicitly test and document the crash-after-insert-before-ack window. Use persisted batch/index deduplication in report queries so retries/crashes do not inflate results before database merges. Never assume a ReplacingMergeTree merge has already happened.
4. Query selected site + bounded date/time window + hostname/path/bucket. Group click points by page coordinates and original dimensions. Page list sorts by sampled sessions then interaction count. Bucket by nearest width, ties favor lower bucket. Normalize a point into bucket width using `bucketWidth / recordedViewportWidth`, including page geometry. Keep unlike buckets separate.
5. For scroll, first compute maximum depth per distinct `(site_id, session_id, hostname, pathname, viewport_bucket)` in the window; multiple updates or revisits must not inflate the denominator. Build 10-point histogram and cumulative reach. Example maxima 30,60,100 produce totalSessions=3 and reach at 10/30/50/70/100 of 3/3/2/1/1. Treat exact bucket boundaries inclusively; do not drop a 100% visitor at 100%.
6. Put query builders in `heatmapQueryService.ts` and test them separately. Reuse `getTimeStatement`, validated filter rendering and parameterized site/path arguments. Every nested eligible-session/events query must explicitly constrain site and window. Apply path/hostname to the heatmap rows themselves, so sessions that visited another page cannot leak points into this page.
7. Extend site deletion, user erasure and identity backfill. Avoid cumulative aggregate tables that cannot erase an identified user. Provide empty responses and enforce pagination/limits; avoid falling back to unbounded all-time scans for malformed dates.

Verify: `pnpm --filter rybbit-backend test:run src/api/heatmaps src/services/heatmaps src/db/clickhouse src/services/sites/siteConfigurationLifecycle.test.ts src/services/tracker/identityBackfillQueue.test.ts`; `pnpm typecheck`; `pnpm build:server` → exit 0.

Real SQL gate: add `server/src/services/heatmaps/heatmapQueryService.clickhouse.test.ts` following `api/analytics/getPages.clickhouse.test.ts` (fixture CTE, `CLICKHOUSE_TEST_URL`, optional test user/password). Run it against the local isolated database and assert actual counts, not SQL-string snapshots alone. A skipped integration suite does not satisfy this phase. Use `docker compose ... exec -T backend` or a disposable test runner on `rybbit-local_default` to reach ClickHouse without publishing database ports.

Tests: exact scroll fixture above, multiple updates/revisits, 0/100% boundaries, dedup retry/concurrency/crash, two sites with same session ID, two hosts with same path, foreign-site exclusion, arbitrary quotes/regex in filters, timezone/DST date limits, clock skew via existing replay correction pattern, oversize/invalid batches, missing metadata, deletion/shared-device erasure, and repeat schema initialization.

## Phase 4 — Build the heatmap report (3–5 days)

1. Add `client/src/api/analytics/endpoints/heatmaps.ts`, `hooks/heatmaps/useGetHeatmaps.ts`, shared types and exports. Use `useAnalyticsQuery`/`analyticsRequest` so the key includes site, dates, timezone, segment/filters, hostname/path, mode and width bucket. Preserve endpoint-functions vs hooks separation; no component fetches.
2. Add `client/src/app/[site]/heatmaps/page.tsx` plus focused components under `client/src/components/heatmaps/`. Reuse `SubHeader`, date selector, filter bar, Shadcn controls, resize measurement and existing URL-state conventions. Add desktop and mobile navigation for web sites. Provide explicit states for disabled collection, no samples, no matching page, errors, loading and missing background. Do not hide existing data simply because future collection is disabled.
3. Add settings toggle and sample-rate control to TrackingTab, with saved-state rollback/error handling. Use next-intl consistently with adjacent extracted-copy components and update locale messages via the existing extraction script.
4. Page search and mode controls sit above a searchable page list/detail split. Retain selected page per mode. Show sampled sessions separately from clicks; never imply a 15% sample represents every visitor. Width selector uses observed buckets/counts with the most represented bucket as default. Add fullscreen/detail layout that remains usable on phones.
5. Render weighted click hotspots using a canvas or bounded SVG/DOM overlay (maximum 5,000 points). Implement coordinate transforms as pure tested helpers in `geometry.ts`. Overlay dimensions, page iframe width and dashboard fit-scale must agree. Scroll mode shades 10% bands and displays depth/reach labels. The canvas must have a legend and accessible count summary; pointer overlays cannot interact with the underlying site.
6. Construct iframe URL from validated configured/observed site origin plus normalized path, allowing only http/https and rejecting protocol-relative foreign hosts or traversal into a different origin. Do not proxy arbitrary URLs through the server. Use `referrerPolicy=no-referrer`, a deliberate sandbox policy, no dashboard-origin privileges, and a visible background toggle. Scripts may be needed to render SPA pages; capture the resulting behavior in a test fixture. Prevent the report fixture from polluting its own tracking data.
7. Label live background behavior accurately: layouts can change since collection, authenticated routes may not render, and CSP frame-ancestors/X-Frame-Options can block embedding. Do not pretend iframe `onload` reliably detects cross-origin frame blocking. Provide an operator-selectable geometry-only view that preserves the overlay/counts. A historical masked rrweb backdrop can be added later; it is not a dependency for verified Umami parity.

Verify: `pnpm --filter client test:run src/components/heatmaps src/api/analytics`; `pnpm --filter client lint`; `pnpm --filter client typecheck`; `pnpm --filter client extract`; `pnpm build:client` → exit 0. Use existing `.test.ts` node / `.test.tsx` jsdom Vitest projects and `TrackingTab.test.tsx` as the component-test exemplar.

Browser gate: fixture with known button positions, 2,000px page height, fixed header and a responsive breakpoint. At widths 375/768/1440, scroll, click, change SPA routes and compare rendered hotspots to known targets (within 3 CSS px after scaling). Exercise a frame-blocked page, phone page picker, keyboard navigation, light/dark themes and fullscreen. Do not judge parity from a fabricated report with no real tracked events.

## Phase 5 — Close the remaining analytics-filter parity gaps (4–7 days)

This phase is required for full parity. A phase-4 release is a useful core heatmap feature, but must not be called complete Umami parity.

1. Expose heatmap filters covering browser/OS/device/language/location, hostname/path/title/query, referrer, five UTMs, tag, identified user, custom event and saved segment using Rybbit's equivalent names. Query event/acquisition filters through a distinct eligible-session set using bounded analytics events, while direct path/hostname constraints stay on heatmap rows. Explicitly test missing analytics metadata and session attribution. Do not silently ignore a selected unsupported filter.
2. Add report-local `match=all|any`, `analyticsEventType=pageview|custom_event`, and `excludeBounce`. Combine user filters in the chosen mode while invariant site/time/path constraints stay outside the OR expression. Bounce exclusion uses sessions with >1 pageview, not >1 heatmap interaction. `mode=click|scroll` must remain distinct from analytics event type. Reuse the existing validated predicate renderer; extend it with an optional combination parameter that defaults to existing behavior, and regression-test ordinary reports unchanged.
3. Add minimal saved-cohort support, since the repository has only predicate-based segments. Define a cohort as visitors matching a page/event predicate within an explicit historical window; its members then constrain a possibly different current heatmap window. Implement `shared/src/cohorts.ts`, Postgres cohort definitions (site, name, owner, historical window, validated filters), `server/src/api/analytics/cohorts/` CRUD and `services/heatmaps/heatmapCohortFilter.ts`. Derive membership with a bounded query over effective user identity rather than duplicating stale member lists. Use viewer read/member write/editor manage rules modeled on segment ownership, and enforce site access before evaluating members.
4. Add a cohort selector/create dialog under `client/src/components/heatmaps/` and API functions/hooks under `client/src/api/analytics/`. Preserve stored cohort selection in URL/query keys. Explain that membership reflects retained historical analytics; empty/expired windows must be visible, not expand to everyone. Delete definitions with their site and ensure identity erasure removes matching events rather than leaving separately cached permanent membership.
5. Saved segment expansion currently appends filter arrays. Define how segment predicates combine with ad-hoc `match:any` (segment predicate remains a required group; only ad-hoc criteria use any), and test it. Do not unintentionally turn tenant/site constraints or segment restrictions into optional OR terms.

Verify: `pnpm --filter rybbit-backend test:run src/api/analytics/cohorts src/services/heatmaps src/api/analytics/segments src/api/analytics/utils`; `pnpm --filter client test:run src/components/heatmaps src/api/analytics`; `pnpm typecheck`; `pnpm lint` → exit 0. Run real ClickHouse cohort/filter fixtures: historical cohort selection followed by a disjoint report window, identified IDs across two devices, tag/event/UTM combinations, all vs any, bounce exclusion and cross-site cohort denial.

## Phase 6 — Benchmark, document and prove parity (2–3 days)

1. Add `docs/content/docs/(docs)/feature-guides/heatmaps.mdx` and API docs, update guide navigation and tracker configuration docs. Cover setup, independent sampling, click/scroll definitions, observed width buckets, live backgrounds, retained-data window, authorization, cohort/filter behavior and collection exclusions. Reuse existing docs conventions; keep setup copy short.
2. Add a repeatable fixture/QA script under `plans/heatmap-verification/` or a scoped test-support directory. Run a complete path from site setting through real tracker requests, storage, filtered API and dashboard. Test existing site upgrade as well as fresh installation. Re-run replay/button recording to detect regressions.
3. Benchmark 1 million compact heatmap rows across 100 sites with representative date/path/bucket filters and 5,000 rendered points. Record hardware, row/storage size, insert batch latency and p50/p95 read latency. Initial local targets: p95 selected-page read <1s and p95 overview <2s on a warm local database; bounded frontend rendering without >100ms interaction stalls. Treat these as acceptance budgets to validate, not promised existing performance. Tune sort key/query before adding rollups.
4. Test disable/re-enable, rate changes, restarted containers, duplicate uploads, retention and user/site erasure. Test API access independently of sidebar visibility. Complete every row in the parity matrix and record evidence. Do not deploy to Cyberia or Sys in this task.

Verify: `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build:server`, `pnpm build:client`; `docker compose --env-file plans/local/.env.local -p rybbit-local -f docker-compose.yml -f plans/local/compose.yaml up -d --build` → all succeed. `curl -fsS http://localhost:18033/api/health` → healthy; browser tracking/API/rendering gates and real SQL fixtures must also pass.

## Done criteria

- [x] Heatmaps collect with replay off and no rrweb request; default remains off for existing/new sites.
- [x] Independent sample rate works at 0/15/100%, survives ordinary session navigation, and is scoped to site/host.
- [x] Both overlays align on the real responsive fixture; short pages and zero-scroll sessions contribute correctly.
- [x] Page search, mode switching, fullscreen/mobile layout and observed width buckets work.
- [x] Date/timezone and every parity filter, including segment/cohort/all-any/event-type/bounce, have real count assertions.
- [x] No cross-site or cross-host leakage; authenticated read/scoped bearer access is enforced.
- [x] Captured input values/DOM text are absent from heatmap requests and tables.
- [x] Retry duplication, site/user erasure, identity backfill, 30-day retention and restart behavior are tested.
- [x] Fixed limits are communicated; sample counts and live background limitations are accurate.
- [x] All named verification commands pass; integration/browser suites ran rather than skipped.
- [x] Benchmarks and parity matrix have recorded evidence; docs and locales are updated.
- [x] Only scoped files changed; existing branch retained; no production changes or deployment.

## STOP conditions and maintenance

Stop implementation and report a concrete blocker if a required migration is unauthorized, identity/session assignment cannot be shared without changing unrelated tracking behavior, the bounded query cannot express a parity filter correctly, a viewport overlay fails the coordinate fixture, or the design requires DOM capture to deliver the basic report. Do not solve a background failure by server-side fetching arbitrary visitor URLs. Two failed attempts at a phase gate warrant diagnosis rather than widening scope.

Review future changes to URL normalization, session attribution, feature gating, identity backfill, time filters, route permissions and erasure lists against heatmap behavior. Larger retention or rollups need explicit erasure/filter designs. Layout-version separation and masked historical backdrops are sensible follow-ups once the verified live-iframe report exists.
