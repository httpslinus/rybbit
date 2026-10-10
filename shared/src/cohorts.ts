import type { Filter } from "./filters";

/** Visitors matching a predicate in a retained historical analytics window. */
export interface Cohort {
  cohortId: number;
  siteId: number;
  name: string;
  userId: string | null;
  startDate: string;
  endDate: string;
  timeZone: string;
  filters: Filter[];
  createdAt: string;
  updatedAt: string;
  canEdit: boolean;
}

export interface CreateCohortBody {
  name: string;
  startDate: string;
  endDate: string;
  timeZone: string;
  filters: Filter[];
}

export type UpdateCohortBody = Partial<CreateCohortBody>;

export const COHORT_NAME_MAX_LENGTH = 80;
export const COHORT_MAX_FILTERS = 20;
