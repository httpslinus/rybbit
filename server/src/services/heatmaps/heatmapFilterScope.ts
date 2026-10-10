import type { Filter, FilterParameter } from "@rybbit/shared";
import { effectiveUserId } from "../../api/analytics/utils/effectiveUserId.js";
import { filterParamError, getFilterStatement } from "../../api/analytics/utils/getFilterStatement.js";
import { validateHttpTimeParams } from "../../api/analytics/utils/query-validation.js";
import { buildFilteredSessionsCTE } from "../../api/analytics/utils/sessionFilters.js";
import { resolveTimeWindow, type TimeWindowParams } from "../../api/analytics/utils/timeWindow.js";
import { normalizeHeatmapTimeZone } from "./heatmapTimeZone.js";

export class HeatmapQueryValidationError extends Error {}

export function resolveBoundedHeatmapTime(params: TimeWindowParams, now = Date.now()) {
  const timeZone = params.time_zone === undefined ? "UTC" : normalizeHeatmapTimeZone(params.time_zone);
  if (!timeZone) throw new HeatmapQueryValidationError("Invalid time_zone: use an IANA time zone");
  const normalizedParams = { ...params, time_zone: timeZone };
  const timeError = validateHttpTimeParams(normalizedParams);
  if (timeError) throw new HeatmapQueryValidationError(timeError);
  for (const value of [params.start_date, params.end_date, params.start_datetime, params.end_datetime]) {
    if (value && new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== value.slice(0, 10)) {
      throw new HeatmapQueryValidationError("Invalid calendar date");
    }
  }
  for (const value of [params.past_minutes_start, params.past_minutes_end]) {
    if (value !== undefined && !Number.isFinite(Number(value))) {
      throw new HeatmapQueryValidationError("past_minutes values must be finite");
    }
  }
  if (params.start_date && params.end_date && params.start_date > params.end_date) {
    throw new HeatmapQueryValidationError("start_date must not follow end_date");
  }
  const window = resolveTimeWindow(normalizedParams, now);
  if (window.isAllTime) throw new HeatmapQueryValidationError("Heatmaps require a bounded date or time window");
  // Date ranges ending today also contain a SQL now() bound. Freeze that
  // instant alongside relative windows so every stage sees the same samples.
  const instant = new Date(now).toISOString().replace("T", " ").replace("Z", "");
  return {
    ...window,
    where: (column?: string) =>
      window
        .where(column)
        .replace(/\bnow64\(3\)/g, `toDateTime64('${instant}', 3, 'UTC')`)
        .replace(/\bnow\(\)/g, `toDateTime('${instant.slice(0, 19)}', 'UTC')`),
  };
}

const ROW_FILTER_PARAMETERS: readonly FilterParameter[] = ["hostname", "pathname", "user_id"];
const EVENT_FILTER_PARAMETERS: readonly FilterParameter[] = ["event_name", "page_title", "querystring", "tag"];
const predicate = (statement: string) => statement.replace(/^AND\s+/i, "").trim();

/**
 * Produces one required predicate group. Site/time bounds belong to its raw
 * queries and the caller; they can never become alternatives in a match:any.
 */
export function buildHeatmapFilterScope(
  filters: Filter[],
  siteId: number,
  timeStatement: string,
  combination: "all" | "any" = "all",
  prefix = "AdHoc"
): { ctes: string[]; condition: string } {
  if (!timeStatement) throw new HeatmapQueryValidationError("Metadata filters require a bounded time window");
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(prefix)) throw new HeatmapQueryValidationError("Invalid filter scope");
  const error = filterParamError(JSON.stringify(filters));
  if (error) throw new HeatmapQueryValidationError(error);
  const rowFilters = filters.filter(filter => ROW_FILTER_PARAMETERS.includes(filter.parameter));
  const eventFilters = filters.filter(filter => EVENT_FILTER_PARAMETERS.includes(filter.parameter));
  const metadataFilters = filters.filter(filter => !rowFilters.includes(filter) && !eventFilters.includes(filter));
  const ctes: string[] = [];
  const conditions: string[] = [];
  if (rowFilters.length)
    conditions.push(
      predicate(
        getFilterStatement(JSON.stringify(rowFilters), siteId, timeStatement, {
          sessionLevelParams: [],
          combination,
          fieldMappings: { user_id: effectiveUserId() },
        })
      )
    );
  if (eventFilters.length) {
    const eventStatement = getFilterStatement(JSON.stringify(eventFilters), siteId, timeStatement, {
      sessionLevelParams: eventFilters.map(filter => filter.parameter),
      combination,
    });
    const name = `${prefix}EventSessions`;
    // Starting with existing bounded events also excludes heatmap-only
    // sessions for negative predicates such as "has no buy event".
    ctes.push(`${name} AS (
      SELECT DISTINCT session_id FROM events
      WHERE site_id = ${siteId} ${timeStatement} ${eventStatement}
    )`);
    conditions.push(`session_id IN (SELECT session_id FROM ${name})`);
  }
  // Reuse the shared first-attribution/session aggregations. For ANY, one CTE
  // per criterion makes each session predicate an independent alternative.
  const metadataGroups = combination === "all" ? [metadataFilters] : metadataFilters.map(filter => [filter]);
  for (const [index, group] of metadataGroups.entries()) {
    if (!group.length) continue;
    const name = `${prefix}MetadataSessions${index}`;
    const cte = buildFilteredSessionsCTE(JSON.stringify(group), siteId, timeStatement, name);
    if (!cte) throw new HeatmapQueryValidationError("Unsupported heatmap metadata filter");
    ctes.push(cte);
    conditions.push(`session_id IN (SELECT session_id FROM ${name})`);
  }
  return { ctes, condition: conditions.length ? `(${conditions.join(combination === "any" ? " OR " : " AND ")})` : "" };
}
