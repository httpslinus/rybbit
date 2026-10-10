import type { Filter, HeatmapPage, HeatmapPoint, HeatmapResponse, HeatmapWidthBucket } from "@rybbit/shared";
import { HEATMAP_WIDTH_BUCKETS } from "@rybbit/shared";
import type { QuerySpec } from "../../api/analytics/utils/analyticsQuery.js";
import { runAnalyticsQuery } from "../../api/analytics/utils/analyticsQuery.js";
import { filterParamError } from "../../api/analytics/utils/getFilterStatement.js";
import { validateFilters } from "../../api/analytics/utils/query-validation.js";
import type { TimeWindow, TimeWindowParams } from "../../api/analytics/utils/timeWindow.js";
import { buildHeatmapBackground } from "./heatmapBackground.js";
import {
  buildHeatmapCohortScope,
  buildHeatmapCohortSummaryQuery,
  type HeatmapCohortDefinition,
} from "./heatmapCohortFilter.js";
import {
  buildHeatmapFilterScope,
  HeatmapQueryValidationError,
  resolveBoundedHeatmapTime,
} from "./heatmapFilterScope.js";

export { HeatmapQueryValidationError } from "./heatmapFilterScope.js";

export const HEATMAP_PAGE_LIMIT = 100;
export const HEATMAP_POINT_LIMIT = 5_000;

export interface HeatmapQueryOptions extends TimeWindowParams {
  filters?: string;
  mode: "click" | "scroll";
  view?: "full" | "pages";
  hostname?: string;
  pathname?: string;
  bucket?: HeatmapWidthBucket;
  search?: string;
  pageLimit?: number;
  pointLimit?: number;
  match?: "all" | "any";
  analyticsEventType?: "pageview" | "custom_event";
  excludeBounce?: boolean;
  segmentFilters?: Filter[];
  cohort?: HeatmapCohortDefinition;
}

export interface HeatmapQueryContext extends TimeWindow {
  cohortScope?: ReturnType<typeof buildHeatmapCohortScope>;
}

// One tuple keeps nullable click/scroll fields together: independent any()
// aggregates skip NULL and can splice fields from different retries together.
const RAW_FIELDS = [
  "timestamp",
  "session_id",
  "user_id",
  "identified_user_id",
  "page_visit_id",
  "type",
  "hostname",
  "pathname",
  "viewport_bucket",
  "viewport_width",
  "viewport_height",
  "document_width",
  "document_height",
  "client_x",
  "client_y",
  "page_x",
  "page_y",
  "max_depth",
] as const;

function validateOptions(options: HeatmapQueryOptions, siteId: number, resolvedTime?: TimeWindow) {
  if (!Number.isInteger(siteId) || siteId <= 0 || siteId > 0xffff_ffff) {
    throw new HeatmapQueryValidationError("Invalid site ID");
  }
  const window = resolvedTime ?? resolveBoundedHeatmapTime(options);
  if (options.view !== undefined && options.view !== "full" && options.view !== "pages") {
    throw new HeatmapQueryValidationError("Invalid heatmap view");
  }
  if (options.match !== undefined && options.match !== "all" && options.match !== "any") {
    throw new HeatmapQueryValidationError("Invalid filter match mode");
  }
  if (options.analyticsEventType !== undefined && !["pageview", "custom_event"].includes(options.analyticsEventType)) {
    throw new HeatmapQueryValidationError("Invalid analytics event type");
  }
  if (options.excludeBounce !== undefined && typeof options.excludeBounce !== "boolean") {
    throw new HeatmapQueryValidationError("Invalid bounce exclusion");
  }
  if (options.mode !== "click" && options.mode !== "scroll") {
    throw new HeatmapQueryValidationError("Invalid heatmap mode");
  }
  if (options.bucket !== undefined && !HEATMAP_WIDTH_BUCKETS.includes(options.bucket)) {
    throw new HeatmapQueryValidationError("Invalid viewport bucket");
  }
  for (const [value, maximum, label] of [
    [options.pageLimit ?? HEATMAP_PAGE_LIMIT, HEATMAP_PAGE_LIMIT, "page"],
    [options.pointLimit ?? HEATMAP_POINT_LIMIT, HEATMAP_POINT_LIMIT, "point"],
  ] as const) {
    if (!Number.isInteger(value) || value < 1 || value > maximum) {
      throw new HeatmapQueryValidationError(`Invalid ${label} limit`);
    }
  }
  return window;
}

function scope(
  options: HeatmapQueryOptions,
  siteId: number,
  selection = true,
  bucket: HeatmapWidthBucket | null = options.bucket ?? null,
  resolvedTime?: HeatmapQueryContext
) {
  const timeStatement = validateOptions(options, siteId, resolvedTime).where();
  const filterError = filterParamError(options.filters);
  if (filterError) throw new HeatmapQueryValidationError(filterError);
  const filters = options.filters ? validateFilters(options.filters) : [];
  const adHoc = buildHeatmapFilterScope(filters, siteId, timeStatement, options.match ?? "all");
  const segment = buildHeatmapFilterScope(
    options.segmentFilters ?? [],
    siteId,
    timeStatement,
    "all",
    "RequiredSegment"
  );
  const cohort = options.cohort ? (resolvedTime?.cohortScope ?? buildHeatmapCohortScope(options.cohort, siteId)) : null;
  const params: Record<string, unknown> = { siteId, mode: options.mode };
  const restrictions = [
    "type = {mode:String}",
    adHoc.condition ? `AND ${adHoc.condition}` : "",
    segment.condition ? `AND ${segment.condition}` : "",
    cohort ? `AND ${cohort.condition}` : "",
  ];
  const extraCTEs: string[] = [];
  if (options.analyticsEventType) {
    params.analyticsEventType = options.analyticsEventType;
    extraCTEs.push(`AnalyticsTypeSessions AS (
      SELECT DISTINCT session_id FROM events
      WHERE site_id = {siteId:UInt32} ${timeStatement} AND type = {analyticsEventType:String}
    )`);
    restrictions.push("AND session_id IN (SELECT session_id FROM AnalyticsTypeSessions)");
  }
  if (options.excludeBounce) {
    extraCTEs.push(`NonBounceSessions AS (
      SELECT session_id FROM events
      WHERE site_id = {siteId:UInt32} ${timeStatement} AND type = 'pageview'
      GROUP BY session_id HAVING count() > 1
    )`);
    restrictions.push("AND session_id IN (SELECT session_id FROM NonBounceSessions)");
  }
  if (selection && options.hostname !== undefined) {
    restrictions.push("AND hostname = {hostname:String}");
    params.hostname = options.hostname;
  }
  if (selection && options.pathname !== undefined) {
    restrictions.push("AND pathname = {pathname:String}");
    params.pathname = options.pathname;
  }
  if (bucket !== null) {
    restrictions.push("AND viewport_bucket = {bucket:UInt16}");
    params.bucket = bucket;
  }
  // Narrow the expensive, geometry-bearing aggregate to candidate batches,
  // while retaining every copy of each batch before deduplication. Filtering
  // raw copies directly could resurrect a conflicting retry on another page.
  const candidateRestrictions = restrictions.filter(restriction =>
    /^AND (hostname|pathname|viewport_bucket) = \{/.test(restriction)
  );
  const candidates = candidateRestrictions.length
    ? `CandidateHeatmapBatches AS (
    SELECT DISTINCT batch_id FROM heatmap_events
    WHERE site_id = {siteId:UInt32} ${timeStatement}
      ${candidateRestrictions.join("\n      ")}
  )`
    : null;
  const payload = `tuple(${RAW_FIELDS.join(", ")})`;
  // Session/identity lead the tie-break so identical-time legacy retries use
  // the same attribution across events. New inserts retain original attribution
  // in Redis; the deterministic fallback covers rows written before that fix.
  const tieBreak = [
    "session_id",
    "user_id",
    "identified_user_id",
    "timestamp",
    ...RAW_FIELDS.filter(field => !["timestamp", "session_id", "user_id", "identified_user_id"].includes(field)).map(
      field =>
        ["client_x", "client_y", "page_x", "page_y", "max_depth"].includes(field) ? `ifNull(${field}, -1)` : field
    ),
  ];
  const ctes = [
    ...adHoc.ctes,
    ...segment.ctes,
    ...(cohort?.ctes ?? []),
    ...extraCTEs,
    ...(candidates ? [candidates] : []),
    `DeduplicatedHeatmaps AS (
    SELECT site_id, batch_id, event_index,
      argMax(${payload}, tuple(${tieBreak.join(", ")})) AS captured
    FROM heatmap_events
    WHERE site_id = {siteId:UInt32} ${timeStatement}
      ${candidates ? "AND batch_id IN (SELECT batch_id FROM CandidateHeatmapBatches)" : ""}
    GROUP BY site_id, batch_id, event_index
  )`,
    `HeatmapRows AS (
    SELECT * FROM (
      SELECT site_id, batch_id, event_index,
        ${RAW_FIELDS.map((field, i) => `tupleElement(captured, ${i + 1}) AS ${field}`).join(",\n        ")}
      FROM DeduplicatedHeatmaps
    ) WHERE ${restrictions.filter(Boolean).join("\n      ")}
  )`,
  ];
  return { ctes, params };
}

// Compare physical reach within one visit before combining revisits. A page
// growing after its loading skeleton must be able to lower its provisional
// percentage. Round away floating arithmetic noise at exact histogram edges.
const scrollSessions = `ScrollVisits AS (
  SELECT site_id, session_id, hostname, pathname, viewport_bucket, page_visit_id,
    round(least(100, max(max_depth * document_height * viewport_bucket / viewport_width)
      / max(document_height * viewport_bucket / viewport_width)), 6) AS max_depth
  FROM HeatmapRows
  GROUP BY site_id, session_id, hostname, pathname, viewport_bucket, page_visit_id
), ScrollSessions AS (
  SELECT site_id, session_id, hostname, pathname, viewport_bucket, max(max_depth) AS max_depth
  FROM ScrollVisits
  GROUP BY site_id, session_id, hostname, pathname, viewport_bucket
)`;

export function buildHeatmapPagesQuery(
  options: HeatmapQueryOptions,
  siteId: number,
  resolvedTime?: HeatmapQueryContext
): QuerySpec {
  // Selected page and layout affect the detail only; the picker stays useful.
  const { ctes, params } = scope(options, siteId, false, null, resolvedTime);
  if (options.mode === "scroll") ctes.push(scrollSessions);
  const search = options.search ? "WHERE positionCaseInsensitive(concat(hostname, pathname), {search:String}) > 0" : "";
  if (options.search) params.search = options.search;
  params.pageLimit = (options.pageLimit ?? HEATMAP_PAGE_LIMIT) + 1;
  return {
    query: `WITH ${ctes.join(",\n")}
      SELECT hostname, pathname, count() AS count, uniqExact(session_id) AS sessions
      FROM ${options.mode === "scroll" ? "ScrollSessions" : "HeatmapRows"}
      ${search}
      GROUP BY hostname, pathname
      ORDER BY sessions DESC, count DESC, hostname ASC, pathname ASC
      LIMIT {pageLimit:UInt32}`,
    params,
  };
}

export function buildHeatmapBucketsQuery(
  options: HeatmapQueryOptions,
  siteId: number,
  resolvedTime?: HeatmapQueryContext
): QuerySpec {
  const { ctes, params } = scope(options, siteId, true, null, resolvedTime);
  if (options.mode === "scroll") ctes.push(scrollSessions);
  return {
    query: `WITH ${ctes.join(",\n")}
      SELECT viewport_bucket AS width, count() AS count, uniqExact(session_id) AS sessions
      FROM ${options.mode === "scroll" ? "ScrollSessions" : "HeatmapRows"}
      GROUP BY viewport_bucket
      ORDER BY sessions DESC, count DESC, width ASC`,
    params,
  };
}

export function buildHeatmapPointsQuery(
  options: HeatmapQueryOptions,
  siteId: number,
  resolvedTime?: HeatmapQueryContext
): QuerySpec {
  const { ctes, params } = scope({ ...options, mode: "click" }, siteId, true, options.bucket ?? null, resolvedTime);
  params.pointLimit = (options.pointLimit ?? HEATMAP_POINT_LIMIT) + 1;
  // Original dimensions remain in the group key, preserving distinct captured
  // layouts even when their normalized coordinates happen to coincide.
  return {
    query: `WITH ${ctes.join(",\n")}
      SELECT page_x * viewport_bucket / viewport_width AS x,
        page_y * viewport_bucket / viewport_width AS y,
        viewport_bucket AS viewportWidth,
        viewport_height * viewport_bucket / viewport_width AS viewportHeight,
        document_width * viewport_bucket / viewport_width AS documentWidth,
        document_height * viewport_bucket / viewport_width AS documentHeight,
        count() AS count
      FROM HeatmapRows
      GROUP BY viewport_bucket, page_x, page_y, viewport_width, viewport_height, document_width, document_height
      ORDER BY count DESC, x ASC, y ASC, viewportWidth ASC, viewportHeight ASC, documentWidth ASC, documentHeight ASC
      LIMIT {pointLimit:UInt32}`,
    params,
  };
}

export function buildHeatmapScrollQuery(
  options: HeatmapQueryOptions,
  siteId: number,
  resolvedTime?: HeatmapQueryContext
): QuerySpec {
  const { ctes, params } = scope({ ...options, mode: "scroll" }, siteId, true, options.bucket ?? null, resolvedTime);
  ctes.push(scrollSessions);
  return {
    query: `WITH ${ctes.join(",\n")}
      SELECT band * 10 AS depth,
        countIf(least(10, floor(max_depth / 10)) = band) AS count,
        countIf(max_depth >= band * 10) AS reach,
        count() AS totalSessions
      FROM ScrollSessions
      ARRAY JOIN range(11) AS band
      GROUP BY band ORDER BY band ASC`,
    params,
  };
}

export function buildHeatmapSummaryQuery(
  options: HeatmapQueryOptions,
  siteId: number,
  resolvedTime?: HeatmapQueryContext
): QuerySpec {
  const { ctes, params } = scope(options, siteId, true, options.bucket ?? null, resolvedTime);
  if (options.mode === "scroll") ctes.push(scrollSessions);
  const source = options.mode === "scroll" ? "ScrollSessions" : "HeatmapRows";
  return {
    query: `WITH ${ctes.join(",\n")}
      SELECT (SELECT count() FROM ${source}) AS count,
        (SELECT uniqExact(session_id) FROM ${source}) AS sessions,
        max(viewport_bucket) AS viewportWidth,
        max(viewport_height * viewport_bucket / viewport_width) AS viewportHeight,
        max(document_width * viewport_bucket / viewport_width) AS documentWidth,
        max(document_height * viewport_bucket / viewport_width) AS documentHeight
      FROM HeatmapRows`,
    params,
  };
}

type SummaryRow = Pick<HeatmapResponse, "count" | "sessions"> & {
  viewportWidth: number;
  viewportHeight: number;
  documentWidth: number;
  documentHeight: number;
};
type ScrollRow = { depth: number; count: number; reach: number; totalSessions: number };

export class HeatmapQueryService {
  async getHeatmaps(siteId: number, options: HeatmapQueryOptions, configuredDomain: string): Promise<HeatmapResponse> {
    const capturedAt = Date.now();
    const window: HeatmapQueryContext = {
      ...validateOptions(options, siteId, resolveBoundedHeatmapTime(options, capturedAt)),
      ...(options.cohort
        ? {
            cohortScope: buildHeatmapCohortScope(
              options.cohort,
              siteId,
              resolveBoundedHeatmapTime(
                {
                  start_date: options.cohort.startDate,
                  end_date: options.cohort.endDate,
                  time_zone: options.cohort.timeZone,
                },
                capturedAt
              )
            ),
          }
        : {}),
    };
    const pageLimit = options.pageLimit ?? HEATMAP_PAGE_LIMIT;
    const pointLimit = options.pointLimit ?? HEATMAP_POINT_LIMIT;
    const [pageRows, cohortRows] = await Promise.all([
      runAnalyticsQuery<HeatmapPage>(buildHeatmapPagesQuery(options, siteId, window), ["hostname", "pathname"]),
      options.cohort && options.view !== "pages"
        ? runAnalyticsQuery<{ members: number }>(
            buildHeatmapCohortSummaryQuery(options.cohort, siteId, window.cohortScope)
          )
        : Promise.resolve([]),
    ]);
    const pages = pageRows.slice(0, pageLimit);
    const selectedPage =
      options.view === "pages"
        ? null
        : options.hostname !== undefined && options.pathname !== undefined
          ? { hostname: options.hostname, pathname: options.pathname }
          : pages[0]
            ? { hostname: pages[0].hostname, pathname: pages[0].pathname }
            : null;
    const empty: HeatmapResponse = {
      mode: options.mode,
      pages,
      buckets: [],
      selectedBucket: null,
      points: [],
      scroll: { histogram: [], totalSessions: 0 },
      background: null,
      geometry: null,
      selectedPage,
      count: 0,
      sessions: 0,
      truncated: { pages: pageRows.length > pageLimit, points: false },
      limits: { pages: pageLimit, points: pointLimit },
      ...(options.cohort && options.view !== "pages"
        ? {
            cohort: {
              cohortId: options.cohort.cohortId,
              name: options.cohort.name,
              members: cohortRows[0]?.members ?? 0,
              startDate: options.cohort.startDate,
              endDate: options.cohort.endDate,
              timeZone: options.cohort.timeZone,
            },
          }
        : {}),
    };
    if (!selectedPage) return empty;
    const selected = { ...options, ...selectedPage };
    const buckets = await runAnalyticsQuery<HeatmapResponse["buckets"][number]>(
      buildHeatmapBucketsQuery(selected, siteId, window)
    );
    const selectedBucket = options.bucket ?? buckets[0]?.width ?? null;
    if (selectedBucket === null || !buckets.some(bucket => bucket.width === selectedBucket))
      return { ...empty, buckets };
    const detail = { ...selected, bucket: selectedBucket };
    const [summaryRows, pointRows, scrollRows] = await Promise.all([
      runAnalyticsQuery<SummaryRow>(buildHeatmapSummaryQuery(detail, siteId, window)),
      options.mode === "click"
        ? runAnalyticsQuery<HeatmapPoint>(buildHeatmapPointsQuery(detail, siteId, window))
        : Promise.resolve([]),
      options.mode === "scroll"
        ? runAnalyticsQuery<ScrollRow>(buildHeatmapScrollQuery(detail, siteId, window))
        : Promise.resolve([]),
    ]);
    const summary = summaryRows[0];
    const geometry = summary?.count
      ? {
          viewportWidth: summary.viewportWidth,
          viewportHeight: summary.viewportHeight,
          documentWidth: summary.documentWidth,
          documentHeight: summary.documentHeight,
        }
      : null;
    return {
      ...empty,
      buckets,
      selectedBucket,
      points: pointRows.slice(0, pointLimit),
      geometry,
      count: summary?.count ?? 0,
      sessions: summary?.sessions ?? 0,
      scroll: {
        histogram: scrollRows.map(({ depth, count, reach }) => ({ depth, count, reach })),
        totalSessions: scrollRows[0]?.totalSessions ?? 0,
      },
      background: geometry
        ? buildHeatmapBackground({
            configuredDomain,
            ...selectedPage,
            width: geometry.viewportWidth,
            height: geometry.documentHeight,
          })
        : null,
      truncated: { pages: pageRows.length > pageLimit, points: pointRows.length > pointLimit },
    };
  }
}
