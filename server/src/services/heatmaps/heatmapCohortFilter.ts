import type { Cohort } from "@rybbit/shared";
import type { QuerySpec } from "../../api/analytics/utils/analyticsQuery.js";
import type { TimeWindow } from "../../api/analytics/utils/timeWindow.js";
import { effectiveUserId, EFFECTIVE_SESSION_USER_ID } from "../../api/analytics/utils/effectiveUserId.js";
import {
  buildHeatmapFilterScope,
  HeatmapQueryValidationError,
  resolveBoundedHeatmapTime,
} from "./heatmapFilterScope.js";

export type HeatmapCohortDefinition = Pick<
  Cohort,
  "cohortId" | "siteId" | "name" | "startDate" | "endDate" | "timeZone" | "filters"
>;

export function buildHeatmapCohortScope(cohort: HeatmapCohortDefinition, siteId: number, resolvedTime?: TimeWindow) {
  if (cohort.siteId !== siteId) throw new HeatmapQueryValidationError("Cohort belongs to another site");
  if (!Array.isArray(cohort.filters) || !cohort.filters.length)
    throw new HeatmapQueryValidationError("Cohort requires historical filters");
  const timeStatement = (
    resolvedTime ??
    resolveBoundedHeatmapTime({
      start_date: cohort.startDate,
      end_date: cohort.endDate,
      time_zone: cohort.timeZone,
    })
  ).where();
  const scope = buildHeatmapFilterScope(cohort.filters, siteId, timeStatement, "all", "Cohort");
  const ctes = [
    ...scope.ctes,
    `CohortMatchingSessions AS (
    SELECT DISTINCT session_id FROM events
    WHERE site_id = ${siteId} ${timeStatement} ${scope.condition ? `AND ${scope.condition}` : ""}
  )`,
    `CohortMembers AS (
    SELECT DISTINCT effective_user_id FROM (
      SELECT session_id, ${EFFECTIVE_SESSION_USER_ID} AS effective_user_id
      FROM events
      WHERE site_id = ${siteId} ${timeStatement}
        AND session_id IN (SELECT session_id FROM CohortMatchingSessions)
      GROUP BY session_id
    ) WHERE effective_user_id != ''
  )`,
  ];
  // Current identified visitors match only their identity; a shared anonymous
  // device key cannot pull Bob into Alice's historical cohort.
  return { ctes, condition: `${effectiveUserId()} IN (SELECT effective_user_id FROM CohortMembers)` };
}

export function buildHeatmapCohortSummaryQuery(
  cohort: HeatmapCohortDefinition,
  siteId: number,
  resolvedScope?: ReturnType<typeof buildHeatmapCohortScope>
): QuerySpec {
  const { ctes } = resolvedScope ?? buildHeatmapCohortScope(cohort, siteId);
  return { query: `WITH ${ctes.join(",\n")} SELECT count() AS members FROM CohortMembers` };
}
