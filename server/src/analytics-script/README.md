# Browser tracker

The core owns analytics, configuration, identity, navigation and feature loading.
Heatmaps and session recording keep independent settings, sampling and uploads.
Their implementations are downloaded only when enabled.

| Script            | Responsibility                                                                | Loaded when                                                              |
| ----------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `script.js`       | Analytics and feature loading                                                 | Always                                                                   |
| `heatmaps.js`     | Compact click and scroll collection, background nomination and capture policy | Heatmaps enabled with a positive sample rate                             |
| `recording.js`    | Session recording controller, upload transport and recording-only rrweb       | Recording enabled and selected by replay sampling, or explicitly started |
| `page-capture.js` | One static masked DOM capture                                                 | A background is nominated and recording cannot supply it                 |

Heatmap sampling remains independent of replay sampling. Heatmap clicks and precise
scroll reach continue if replay is disabled, sampled out, stopped, capped, fails
to load, or cannot upload. Recording alone does not load the heatmap module.
Feature collection begins after its deferred module initializes.

## Shared page capture

Replay ingestion indexes eligible full snapshots as heatmap backgrounds using
references to stored replay events, without storing a second DOM copy. Coverage
is tracked by site, hostname, pathname, viewport bucket and UTC day.

A tiny per-tracker capability bridge connects the two feature modules. Heatmaps
supply capture-time page context and a before-click guard. An active recorder
supplies a fresh checkpoint through rrweb's public `record.takeFullSnapshot()`
API. That checkpoint is uploaded once through the recording stream. The heatmap
module waits for its upload and skips the separate DOM upload.

When recording cannot supply a stored checkpoint, `page-capture.js` supplies a
standalone capture. Both paths use the same privacy options. Heatmaps recheck
page visit, route, dimensions and click eligibility after asynchronous work.
Trusted primary clicks exclude that page from background capture while click
and scroll collection continues. The core preserves this guard while heatmap
configuration and code are loading.

Standalone nomination waits at least 90 seconds for replay coverage and requires
a subsequent heatmap batch. It is not a capture on every visitor. Accepted replay
coverage revokes outstanding standalone leases; an in-flight fallback insert
removes its stored copy if its lease was revoked before completion.

Small heatmap summaries keep their own delivery path even during recording.
This preserves coverage through recording failures and avoids a transport
ownership state machine. DOM serialization and upload are the expensive overlap
that the two products share. Both feature transports use the core's keepalive
budget, including ordinary analytics and identity requests.

## Sizes

Measured 18 October 2026, gzip, decimal kB, cold cache. Upstream is its verified
`master` at [`1a8f1ff9`](https://github.com/rybbit-io/rybbit/commit/1a8f1ff9ca8beca1c2207866d659d34be3cdcae8).

| Download                        | Upstream Rybbit | This fork |
| ------------------------------- | --------------: | --------: |
| Core tracker                    |         11.1 kB |   10.7 kB |
| Session recording module        |         82.1 kB |   23.5 kB |
| Heatmap module                  |   Not available |    7.1 kB |
| Standalone page capture         |   Not available |    7.6 kB |
| Core + recording                |         93.1 kB |   34.2 kB |
| Core + heatmaps + recording     |   Not available |   41.3 kB |
| All modules, including fallback |   Not available |   48.9 kB |

The fallback is an additional download only when needed. The last row covers
cases such as recording stopping after its module loaded. Collected event data
is excluded. Exact current gzip sizes: core 10,717 bytes, recording 23,516 bytes,
heatmaps 7,061 bytes, standalone capture 7,633 bytes.

Reproduce the comparison from `server/` after building:

```sh
node src/analytics-script/compare-sizes.js
```

The script reads upstream assets directly from Git and current assets from
`public/`. Its optional argument overrides the pinned upstream Git ref.

## Names and compatibility

Page capture means DOM, styles and page state at one instant. Session recording
adds changes over time. The core coordinates features; it contains neither the
heatmap collector nor the recording controller.

Public script URLs use the `/api/` prefix. First-party proxies must forward
`recording.js`, `heatmaps.js` and `page-capture.js`, plus the heatmap and recording
upload endpoints. See the [proxy endpoint list](<../../../docs/content/docs/(docs)/proxy-guide/get-started.mdx>).

Cached trackers remain compatible: `/api/replay.js` still serves the recording
library alone, and `/api/heatmap-snapshot.js` aliases `page-capture.js`. New
trackers load the controller and recorder together through `recording.js`,
avoiding a stale library-only cache entry. The standalone globals
`window.rybbitPageCapture` and `window.rybbitHeatmapSnapshot` remain aliases.
Existing tracker attributes and public replay start/stop APIs retain their names.

## Capture-only build

The standalone build excludes rrweb's DOM rebuild and playback CSS processing.
The pinned `rrweb-snapshot` release publishes a combined bundle, so
`pageCaptureBuildPlugin.js` bundles unchanged capture modules from its source map.
Dependency version changes, missing source or new runtime imports fail the build
and require review. The adapter adds no runtime network dependency or vendored
serializer.

Recording uses `@rrweb/record` 2.1.7. Standalone capture and the dashboard rebuild
use `rrweb-snapshot` 2.0.0-alpha.20. Shared capture uses rrweb's public API.

## Verification

Run from `server/`:

```sh
pnpm run build
pnpm exec tsc -p src/analytics-script/tsconfig.json
pnpm run test:run --maxWorkers=4
pnpm run test:analytics-bundles
node ../plans/heatmap-verification/snapshot-browser.mjs
```

Bundle checks enforce an 11,000-byte gzip core budget, test privacy and dashboard
playback, and compare standalone capture with its complete dependency. Sixteen
Chromium scenarios exercise all feature combinations, sampling, stopped/capped
recording, script and upload failures, discarded recordings, download order and
early menu clicks. Shared capture must produce one recording upload and no
separate DOM upload; unavailable recording must preserve independent heatmaps.
