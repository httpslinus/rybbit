import React from "react";
import type { HeatmapResponse } from "@rybbit/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  site: "1",
  time: { mode: "day" as const, day: "2026-10-10" },
  filters: [] as unknown[],
  segmentId: null as number | null,
  fetch: vi.fn(),
}));
vi.mock("@/lib/store", () => ({
  useStore: (select: (state: unknown) => unknown) =>
    select({
      site: mocks.site,
      time: mocks.time,
      filters: mocks.filters,
      segmentId: mocks.segmentId,
      previousTime: null,
    }),
  useTimezone: () => "UTC",
}));
vi.mock("../../analyticsRequest", async original => ({
  ...(await original<typeof import("../../analyticsRequest")>()),
  fetchAnalytics: mocks.fetch,
}));
import { useGetHeatmaps } from "./useGetHeatmaps";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.site = "1";
  mocks.time = { mode: "day", day: "2026-10-10" };
  mocks.filters = [];
  mocks.segmentId = null;
  mocks.fetch.mockImplementation(async (site: string) => ({ sessions: Number(site) }) as HeatmapResponse);
});
afterEach(cleanup);

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  return function QueryWrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe("independent heatmap queries", () => {
  it("searches only the page-list endpoint while retaining the detail and sharing report context", async () => {
    const hook = renderHook(
      ({ search }) => ({
        detail: useGetHeatmaps({ hostname: "first.test", pathname: "/a", cohortId: 7 }),
        pages: useGetHeatmaps({ view: "pages", search, cohortId: 7 }),
      }),
      { initialProps: { search: "" }, wrapper: wrapper() }
    );
    await waitFor(() => expect(hook.result.current.detail.isSuccess && hook.result.current.pages.isSuccess).toBe(true));
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    const detail = hook.result.current.detail.data;
    hook.rerender({ search: "checkout" });
    await waitFor(() => expect(hook.result.current.pages.isSuccess).toBe(true));
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
    expect(mocks.fetch.mock.lastCall?.[1].params).toEqual(
      expect.objectContaining({ view: "pages", search: "checkout", cohort_id: 7 })
    );
    expect(hook.result.current.detail.data).toBe(detail);
    mocks.time = { mode: "day", day: "2026-10-09" };
    hook.rerender({ search: "checkout" });
    await waitFor(() => expect(hook.result.current.detail.isSuccess && hook.result.current.pages.isSuccess).toBe(true));
    expect(mocks.fetch).toHaveBeenCalledTimes(5);
    expect(mocks.fetch.mock.calls.slice(-2).every(([, request]) => request.params.start_date === "2026-10-09")).toBe(
      true
    );
  });

  it("hard-resets cached page and detail data when the site changes", async () => {
    const hook = renderHook(() => ({ detail: useGetHeatmaps(), pages: useGetHeatmaps({ view: "pages" }) }), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(hook.result.current.detail.data?.sessions).toBe(1));
    await waitFor(() => expect(hook.result.current.pages.data?.sessions).toBe(1));
    mocks.fetch.mockImplementation(() => new Promise(() => {}));
    mocks.site = "2";
    hook.rerender();
    expect(hook.result.current.detail.data).toBeUndefined();
    expect(hook.result.current.pages.data).toBeUndefined();
    expect(mocks.fetch.mock.calls.slice(-2).every(([site]) => site === "2")).toBe(true);
  });
});
