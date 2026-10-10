import React from "react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() }));
vi.mock("../../endpoints/cohorts", () => ({
  fetchCohorts: mocks.fetch,
  createCohort: mocks.create,
  updateCohort: mocks.update,
  deleteCohort: mocks.remove,
}));

import { useCreateCohort, useDeleteCohort, useGetCohorts, useUpdateCohort } from "./useCohorts";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetch.mockResolvedValue([{ cohortId: 7, name: "Readers" }]);
  mocks.create.mockResolvedValue({ cohortId: 8 });
  mocks.update.mockResolvedValue({ cohortId: 7 });
  mocks.remove.mockResolvedValue({ success: true });
});
afterEach(cleanup);

describe("cohort definition queries", () => {
  it.each(["create", "update", "remove"] as const)(
    "refreshes the owning site's definitions and heatmap membership after %s",
    async operation => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
      const countForSite = vi.fn().mockResolvedValueOnce(2).mockResolvedValue(3);
      const countForOtherSite = vi.fn().mockResolvedValue(50);
      const pagesForSite = vi.fn().mockResolvedValueOnce(["/old"]).mockResolvedValue(["/new"]);
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      );
      const hook = renderHook(
        () => ({
          definitions: useGetCohorts(42),
          currentReport: useQuery({
            queryKey: ["heatmaps", "42", "heatmaps", { cohort_id: 7 }],
            queryFn: countForSite,
          }),
          otherReport: useQuery({
            queryKey: ["heatmaps", "43", "heatmaps", { cohort_id: 7 }],
            queryFn: countForOtherSite,
          }),
          pages: useQuery({
            queryKey: ["heatmap-pages", "42", "heatmaps", { cohort_id: 7, view: "pages" }],
            queryFn: pagesForSite,
          }),
          create: useCreateCohort(),
          update: useUpdateCohort(),
          remove: useDeleteCohort(),
        }),
        { wrapper }
      );
      await waitFor(() => expect(hook.result.current.currentReport.data).toBe(2));
      await waitFor(() => expect(hook.result.current.definitions.data).toHaveLength(1));
      await act(async () => {
        if (operation === "create")
          await hook.result.current.create.mutateAsync({
            siteId: 42,
            body: {
              name: "New",
              startDate: "2026-09-01",
              endDate: "2026-09-30",
              timeZone: "UTC",
              filters: [{ parameter: "browser", type: "equals", value: ["Chrome"] }],
            },
          });
        else if (operation === "update")
          await hook.result.current.update.mutateAsync({ siteId: 42, cohortId: 7, body: { endDate: "2026-09-15" } });
        else await hook.result.current.remove.mutateAsync({ siteId: 42, cohortId: 7 });
      });
      await waitFor(() => expect(hook.result.current.currentReport.data).toBe(3));
      await waitFor(() => expect(hook.result.current.pages.data).toEqual(["/new"]));
      expect(mocks.fetch).toHaveBeenCalledTimes(2);
      expect(countForOtherSite).toHaveBeenCalledOnce();
      expect(hook.result.current.otherReport.data).toBe(50);
    }
  );
});
