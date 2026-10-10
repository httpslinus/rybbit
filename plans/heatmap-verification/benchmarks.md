# Heatmap benchmark

Measured 2026-10-10 on an Apple M3 Pro (12 cores, 36 GiB host memory), Docker Desktop 28.5.1 with 12 CPUs and 17.54 GiB visible memory. The ClickHouse container has no separate CPU or memory cap. ClickHouse 26.3.17.4 and Node 24.21.0 ran on Linux arm64. Full hardware, settings, samples and cleanup evidence: [benchmark-evidence.json](benchmark-evidence.json).

The generated workload contains 1,000,000 heatmap rows across 100 sites and 45,100 sampled visitors/sessions over 15 calendar dates: 45,000 ordinary sessions with 20 interactions, and 100 long sessions with 1,000 interactions. There are 900,000 clicks, 100,000 scroll updates and 90,200 ordinary analytics rows. Each codec uses its own disposable database, removed after measurement. This is a synthetic sizing fixture; the responsive browser gates use actual trusted tracker interactions separately.

The selected site/page/375px bucket has 5,670 clicks from 315 sessions, returns 5,000 weighted points, and correctly reports truncation. Reads use production query builders and the complete `HeatmapQueryService.getHeatmaps` implementation, with five warmups followed by 30 serial measured runs. Full-service timings exclude HTTP and response serialization. Inserts use 50 batches of 20,000 rows with `async_insert=1` and `wait_for_async_insert=1`; timings include JSON serialization, transport and acknowledged flush. This insert size measures storage throughput and is deliberately larger than the public recorder's 100-event limit.

| Measurement | LZ4 baseline p50 / p95 | ZSTD(1) p50 / p95 | Acceptance |
|---|---:|---:|---|
| Full selected-page report service | 125.69 / 144.71 ms | 132.10 / 157.98 ms | p95 < 1,000 ms: PASS |
| Overview/page-list query | 25.20 / 28.82 ms | 27.22 / 29.45 ms | p95 < 2,000 ms: PASS |
| Selected points query | 41.23 / 46.19 ms | 42.21 / 44.43 ms | Bounded 5,000-point result |
| Metadata-filtered selected points | 35.18 / 39.25 ms | 36.07 / 38.82 ms | Actual ordinary analytics eligibility |
| Scroll histogram query | 28.12 / 39.49 ms | 28.73 / 32.53 ms | Actual maximum-depth aggregation |
| Acknowledged insert batch | 101.76 / 172.52 ms | 101.90 / 119.75 ms | 20,000 rows/batch |

| Merged retained table size | LZ4 | ZSTD(1) |
|---|---:|---:|
| Rows / active parts | 1,000,000 / 2 | 1,000,000 / 2 |
| Uncompressed column bytes | 284,014,648 | 284,014,616 |
| Compressed column bytes | 25,800,462 | 15,702,193 |
| Total bytes on disk | 25,821,453 | 15,722,247 |
| Compressed bytes/interaction | 25.80 | 15.70 |
| Compressed bytes/sampled session | 572.07 | 348.16 |

ZSTD(1) uses 39.14% fewer compressed column bytes in this workload. The full selected service p95 is about 9% higher but remains below the acceptance budget; insert and other read timings remain comparable. New heatmap tables therefore specify ZSTD(1). This sequential local comparison does not establish an intrinsic CPU-speed advantage. Existing tables retain their configured codec until explicitly changed.

Generated storage-row JSON averages 603.38 bytes/interaction and 13,378.67 bytes/sampled session. This is the internal row shape, including repeated site/session/identity fields; it is not the browser batch wire size. A normal 20-interaction session generates 11,994 JSON bytes. One 1,000-interaction long session generates 608,116 JSON bytes; its separately measured part occupies 26,355 bytes with LZ4 or 16,845 bytes with ZSTD(1), including small-part/dictionary overhead. Use full-table averages for workload sizing.

No replay storage-reduction percentage is claimed: a corresponding same-sampling replay workload was not measured. Volume scales with selected sessions and interactions per selected session, rather than with the configured percentage alone. Scroll updates are coalesced by the tracker, and retention remains 30 days.

Frontend 5,000-point measurement and acceptance are recorded separately in [performance-evidence.json](performance-evidence.json). Both observed layouts return exactly 5,000 stored points, all in the initial viewport, at DPR 2. The final measured run has 101 trusted interactions at p95 31.3 ms/max 82.2 ms, 1,014 animation-frame gaps at max 76.5 ms, zero interaction long tasks, 82 subsequent draws at max 9.4 ms, and initial dense canvas drawing at max 18 ms. Two measured confirmation runs pass the unchanged 100 ms interaction budget. Cold page startup is recorded separately, including initial bundle/hydration long tasks up to 182 ms. One earlier unattributed 258.3 ms frame gap is preserved in previous attempts; its timed interactions stayed below 63 ms and its canvas draws below 10 ms, so it cannot be attributed to the renderer from the available evidence.
