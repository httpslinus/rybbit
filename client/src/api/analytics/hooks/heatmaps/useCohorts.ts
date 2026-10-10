import type { CreateCohortBody, UpdateCohortBody } from "@rybbit/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createCohort, deleteCohort, fetchCohorts, updateCohort } from "../../endpoints/cohorts";

export const COHORTS_QUERY_KEY = "cohorts";

export function useGetCohorts(siteId?: string | number, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: [COHORTS_QUERY_KEY, siteId],
    queryFn: () => fetchCohorts(siteId!),
    enabled: !!siteId && options?.enabled !== false,
    staleTime: 60_000,
  });
}

function useRefreshCohortReports() {
  const queryClient = useQueryClient();
  return (siteId: string | number) =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: [COHORTS_QUERY_KEY, siteId] }),
      queryClient.invalidateQueries({ queryKey: ["heatmaps", String(siteId)] }),
      queryClient.invalidateQueries({ queryKey: ["heatmaps", Number(siteId)] }),
      queryClient.invalidateQueries({ queryKey: ["heatmap-pages", String(siteId)] }),
      queryClient.invalidateQueries({ queryKey: ["heatmap-pages", Number(siteId)] }),
    ]);
}

export function useCreateCohort() {
  const refresh = useRefreshCohortReports();
  return useMutation({
    mutationFn: ({ siteId, body }: { siteId: string | number; body: CreateCohortBody }) => createCohort(siteId, body),
    onSuccess: (_, variables) => refresh(variables.siteId),
  });
}

export function useUpdateCohort() {
  const refresh = useRefreshCohortReports();
  return useMutation({
    mutationFn: ({ siteId, cohortId, body }: { siteId: string | number; cohortId: number; body: UpdateCohortBody }) =>
      updateCohort(siteId, cohortId, body),
    onSuccess: (_, variables) => refresh(variables.siteId),
  });
}

export function useDeleteCohort() {
  const refresh = useRefreshCohortReports();
  return useMutation({
    mutationFn: ({ siteId, cohortId }: { siteId: string | number; cohortId: number }) => deleteCohort(siteId, cohortId),
    onSuccess: (_, variables) => refresh(variables.siteId),
  });
}
