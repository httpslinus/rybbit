# Implementation plans

Prepared 2026-10-10 with the improve planning workflow against commit `6f845412`. Plan 001 was implemented and verified on the existing `master` branch on 2026-10-10. Migration generation and isolated local validation were explicitly authorized.

| Plan                               | Title                                                         | Priority | Effort | Depends on | Status                                         |
| ---------------------------------- | ------------------------------------------------------------- | -------- | ------ | ---------- | ---------------------------------------------- |
| [001](001-umami-heatmap-parity.md) | Independently sampled click/scroll heatmaps with Umami parity | P1       | L      | —          | COMPLETE — phases 1–6 and all acceptance gates |

Heatmaps now collect trusted clicks and scroll reach independently of replay, with per-site enablement and sampling. The responsive report includes page search, observed width buckets, live or geometry-only backgrounds, existing analytics filters, saved segments, historical cohorts, ALL/ANY matching, event type and bounce exclusion. Ingestion, authorization, identity backfill, user/site erasure, retention and bounded query/rendering behavior are verified.

The final workspace suite passed 4,413 tests. Every optional real SQL fixture ran separately: 61 database integration tests and 14 related unit tests passed with no skips. Typecheck, lint, both native builds, the full isolated Docker rebuild, local health, responsive capture/rendering, existing replay/button recording, fresh/upgrade migrations, restart persistence and 12 live lifecycle checks passed. The one-million-row benchmark measured selected-report p95 157.98 ms and overview p95 29.45 ms with ZSTD(1). The latest 5,000-point browser run measured trusted interactions at p95 31.3 ms/max 82.2 ms, within the 100 ms interaction budget.

The [verification runbook](heatmap-verification/README.md), [parity matrix](heatmap-verification/parity-matrix.md), [benchmarks](heatmap-verification/benchmarks.md) and [final evidence](heatmap-verification/verification-evidence.json) retain commands, measurements, screenshots, prior attempts and limitations. Backgrounds are live iframes; cohort membership reflects retained analytics; duplicate physical rows after ambiguous acknowledgements are deduplicated by reports. Cold browser startup and existing Stripe/replay-dashboard issues are recorded separately from the feature gates.

Local Docker setup and controls: [local/README.md](local/README.md). Changes remain uncommitted on the existing branch. No push, VPS change or production deployment was performed.
