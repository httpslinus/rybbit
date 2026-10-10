import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { QuerySpec } from "../../api/analytics/utils/analyticsQuery.js";

vi.mock("../../api/analytics/utils/analyticsQuery.js", () => ({ runAnalyticsQuery: vi.fn() }));
import { buildHeatmapPointsQuery } from "./heatmapQueryService.js";

// Opt-in, read-only benchmark. All rows are generated inside each SELECT;
// production tables are neither read nor written.
describe.skipIf(!process.env.CLICKHOUSE_TEST_URL || process.env.HEATMAP_SINGLE_SITE_BENCHMARK !== "1")(
  "Heatmap selected-page single-site benchmark",
  () => {
    let client: ReturnType<typeof createClient>;
    beforeAll(() => {
      client = createClient({
        url: process.env.CLICKHOUSE_TEST_URL,
        username: process.env.CLICKHOUSE_TEST_USER || "default",
        password: process.env.CLICKHOUSE_TEST_PASSWORD || "",
        compression: { request: false, response: false },
        request_timeout: 90_000,
        clickhouse_settings: { readonly: "2", max_threads: 2, max_execution_time: 60 },
      });
    });
    afterAll(async () => {
      await client.close();
    });

    it("compares candidate-batch aggregation against a site-wide aggregate over one million interactions", async () => {
      const fixture = `WITH heatmap_events AS (
        SELECT toUInt32(1) AS site_id,
          concat('session-', toString(intDiv(number, 100))) AS session_id,
          concat('device-', toString(intDiv(number, 100))) AS user_id, '' AS identified_user_id,
          toDateTime64('2026-09-10 09:00:00', 3, 'UTC') + toIntervalMillisecond(number % 1000) AS timestamp,
          concat('visit-', toString(intDiv(number, 100))) AS page_visit_id,
          concat('batch-', toString(intDiv(number, 100))) AS batch_id,
          toUInt16(number % 100) AS event_index, 'click' AS type, 'example.com' AS hostname,
          concat('/page-', toString(intDiv(number, 100) % 1000)) AS pathname,
          toUInt16(375) AS viewport_bucket, toUInt32(375) AS viewport_width,
          toUInt32(800) AS viewport_height, toUInt32(375) AS document_width,
          toUInt32(6000) AS document_height,
          toNullable(toFloat64(number % 375)) AS client_x,
          toNullable(toFloat64(number % 800)) AS client_y,
          toNullable(toFloat64(number % 375)) AS page_x,
          toNullable(toFloat64(number % 6000)) AS page_y,
          CAST(NULL AS Nullable(Float64)) AS max_depth
        FROM numbers(1000000)
      ),`;
      const selected = buildHeatmapPointsQuery(
        {
          mode: "click",
          start_date: "2026-09-10",
          end_date: "2026-09-10",
          time_zone: "UTC",
          hostname: "example.com",
          pathname: "/page-7",
          bucket: 375,
        },
        1
      );
      const siteWide = {
        ...selected,
        query: selected.query
          .replace(/CandidateHeatmapBatches AS \([\s\S]*?\),\s*(?=DeduplicatedHeatmaps AS)/, "")
          .replace(/AND batch_id IN \(SELECT batch_id FROM CandidateHeatmapBatches\)/, ""),
      };
      expect(siteWide.query).not.toContain("CandidateHeatmapBatches");
      async function measure(spec: QuerySpec) {
        const started = performance.now();
        const result = await client.query({
          query: spec.query.replace(/^\s*WITH\b/, fixture),
          query_params: spec.params,
          format: "JSON",
          clickhouse_settings: { enable_http_compression: 0 },
        });
        const body = await result.json<{ count: number | string }>();
        return {
          elapsedMs: performance.now() - started,
          rowsRead: body.statistics?.rows_read,
          bytesRead: body.statistics?.bytes_read,
          count: body.data.reduce((sum, row) => sum + Number(row.count), 0),
        };
      }
      await measure(selected);
      await measure(siteWide);
      const results = {
        candidateBatches: [] as Awaited<ReturnType<typeof measure>>[],
        siteWide: [] as Awaited<ReturnType<typeof measure>>[],
      };
      for (let run = 0; run < 5; run++) {
        results.candidateBatches.push(await measure(selected));
        results.siteWide.push(await measure(siteWide));
      }
      for (const result of [...results.candidateBatches, ...results.siteWide]) expect(result.count).toBe(1000);
      console.log(
        JSON.stringify({
          benchmark: "one-million-single-site",
          sites: 1,
          pages: 1000,
          batches: 10000,
          interactionsPerBatch: 100,
          selectedInteractions: 1000,
          maxThreads: 2,
          results,
          limitations:
            "Generated SELECT fixture measures aggregation CPU and input rows; it does not measure MergeTree primary-index pruning, disk IO, metadata joins, or production concurrency.",
        })
      );
    }, 600_000);
  }
);
