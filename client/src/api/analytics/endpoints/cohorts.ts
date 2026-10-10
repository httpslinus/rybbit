import type { Cohort, CreateCohortBody, UpdateCohortBody } from "@rybbit/shared";
import { authedFetch } from "../../utils";

export function fetchCohorts(siteId: string | number) {
  return authedFetch<Cohort[]>(`/sites/${siteId}/cohorts`);
}

export function fetchCohort(siteId: string | number, cohortId: number) {
  return authedFetch<Cohort>(`/sites/${siteId}/cohorts/${cohortId}`);
}

export function createCohort(siteId: string | number, body: CreateCohortBody) {
  return authedFetch<Cohort>(`/sites/${siteId}/cohorts`, undefined, { method: "POST", data: body });
}

export function updateCohort(siteId: string | number, cohortId: number, body: UpdateCohortBody) {
  return authedFetch<Cohort>(`/sites/${siteId}/cohorts/${cohortId}`, undefined, { method: "PUT", data: body });
}

export function deleteCohort(siteId: string | number, cohortId: number) {
  return authedFetch<{ success: true }>(`/sites/${siteId}/cohorts/${cohortId}`, undefined, { method: "DELETE" });
}
