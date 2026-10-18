# Browser tracker

One installed tracker coordinates independent analytics and heatmap collection,
continuous session recording, and page capture.

| Component                  | Responsibility                                                                                                                                           |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Tracker`                  | Owns identity, navigation, cleanup and one shared `PageCapture`.                                                                                         |
| `HeatmapCollector`         | Collects compact clicks and scroll reach independently of replay sampling, stopping and size limits. Requests a background only after server nomination. |
| `PageCapture`              | Owns the shared before-click guard, capture-time context and selection of recording or standalone capture.                                               |
| `SessionRecorder`          | Records and uploads the visit timeline. Supplies page capture while actively recording.                                                                  |
| `standalonePageCapture.ts` | Captures a static DOM tree when the recorder cannot supply one. Installs no ongoing observers or interaction collection.                                 |

## Capture flow

Replay ingestion already indexes eligible full snapshots as heatmap backgrounds
using references to stored replay events. It does not store a second DOM copy.
Coverage is tracked by site, hostname, pathname, viewport bucket and UTC day.
Standalone nomination waits at least 90 seconds for replay coverage and requires
a subsequent heatmap batch; it is not a timer-driven capture on every visit.

When a visitor receives a valid nomination, `PageCapture` first asks the active
`SessionRecorder` for a fresh snapshot through rrweb's public
`record.takeFullSnapshot()` API. The resulting checkpoint remains in the replay
stream. A sanitized copy supplies the heatmap background, preserving the
recorder's original tree, node IDs and observers. This avoids loading the
standalone serializer on that visit. It adds a replay checkpoint only when a
background is requested, rather than retaining potentially stale DOM in memory.

If recording is disabled, sampled out, stopped, capped, fails, or lacks the public
capture API, the standalone module supplies the capture. Both paths share masking
settings and recheck eligibility. The heatmap collector also verifies the
nomination's page visit, settled route and viewport, then compares capture-time
context before uploading. Trusted primary clicks exclude that page from background
capture while click and scroll collection continues.

When accepted replay coverage arrives, the server atomically revokes pending
standalone leases. A fallback insert already in flight removes its stored copy if
its lease was revoked before completion.

## Names and compatibility

Page capture serializes DOM, styles and page state at one instant. The dashboard
renders that state underneath aggregated heatmap measurements. Session recording
adds changes over time to make the visit replayable.

The public URLs `/api/script.js`, `/api/replay.js` and
`/api/heatmap-snapshot.js` remain stable for cached trackers and existing proxies.
The standalone capture API is `window.rybbitPageCapture`; the old
`window.rybbitHeatmapSnapshot` global remains an alias for cached scripts. The new
tracker also accepts the old global when an older capture asset is cached.
Existing configuration attributes and the public `startSessionReplay` /
`stopSessionReplay` API retain their names.

## Download sizes

Measured on 2026-10-18, in decimal kB with gzip, for a cold cache. The middle
column is the capture-only draft that was local before the shared capture work.
Background rows assume a valid nomination on an eligible page.

| Visit                                                                              | Previously pushed (`952a0a28`) | Capture-only draft | Shared capture |
| ---------------------------------------------------------------------------------- | -----------------------------: | -----------------: | -------------: |
| Core only                                                                          |                           15.9 |               15.9 |           17.0 |
| Core and session recording                                                         |                           38.0 |               38.0 |           39.0 |
| Active recording supplies a requested background                                   |                           61.2 |               45.6 |           39.0 |
| Heatmaps with a requested standalone background, replay disabled                   |                           39.2 |               23.6 |           24.6 |
| Both recording and fallback modules loaded, e.g. recording stops before nomination |                           61.2 |               45.6 |           46.7 |

Sharing adds 1,034 gzip bytes to the core for coordination and sanitization. It
avoids the 7,633-byte standalone download when the active recorder supplies a
background. A fresh requested recording snapshot also adds a checkpoint to the
replay upload; script sizes do not include collected data. The largest combined
script download remains 62% below the original 122.8 kB before tracker optimization.

## Capture-only build

The standalone build excludes rrweb's DOM rebuild and playback CSS processing.
The pinned `rrweb-snapshot` release only publishes a combined bundle, so
`pageCaptureBuildPlugin.js` bundles unchanged capture modules from its published
source map. Dependency version changes, missing source or new runtime imports
fail the build and require review. This is a build adapter, with no runtime
network dependency or vendored serializer.

The recorder uses `@rrweb/record` 2.1.7; standalone capture and the dashboard
rebuild currently use `rrweb-snapshot` 2.0.0-alpha.20. Reusing recorder output
through the public API avoids importing either serializer's private internals.

## Verification

Run from `server/`:

```sh
pnpm run build
pnpm exec tsc -p src/analytics-script/tsconfig.json
pnpm run test:run --maxWorkers=4
pnpm run test:analytics-bundles
node ../plans/heatmap-verification/snapshot-browser.mjs
```

The bundle checks enforce gzip budgets, validate privacy and replay playback,
compare standalone capture against the complete dependency, and rebuild its
output with the dashboard's serializer version. Chromium scenarios exercise the
shipped tracker with recording active, disabled, sampled out, stopped, capped and
failing to load. They assert that active recording avoids the fallback download
and that independent heatmap collection continues in every scenario.
