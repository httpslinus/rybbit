import React from "react";
import type { HeatmapPage } from "@rybbit/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ site: "1", fetch: vi.fn(), context: vi.fn() }));
vi.mock("../../useAnalyticsQuery", () => ({
  useAnalyticsContext: (options: unknown) => {
    mocks.context(options);
    return {
      site: mocks.site,
      hasPeriod: true,
      context: { time: { mode: "day", day: "2026-10-12" }, timeZone: "UTC" },
    };
  },
}));
vi.mock("../../analyticsRequest", async original => ({
  ...(await original<typeof import("../../analyticsRequest")>()),
  fetchAnalytics: mocks.fetch,
}));
import { useGetHeatmapPageTitles } from "./useGetHeatmapPageTitles";

const page = (hostname: string, pathname: string): HeatmapPage => ({ hostname, pathname, count: 10, sessions: 5 });
const pages = [page("one.test", "/docs/a"), page("one.test", "/docs/b"), page("two.test", "/docs/a")];
function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function QueryWrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.site = "1";
});
afterEach(cleanup);

describe("Pages title reuse in heatmaps", () => {
  it("looks up sampled paths in one Pages request per host and reuses cached results when the order changes", async () => {
    mocks.fetch.mockImplementation(async (_site, request) => ({
      data: JSON.parse(request.params.paths).map((key: string) => ({
        key,
        title: `${request.params.hostname}: ${key}`,
      })),
      totalCount: 2,
    }));
    const hook = renderHook(({ pages }) => useGetHeatmapPageTitles(pages, true), {
      initialProps: { pages },
      wrapper: wrapper(),
    });
    await waitFor(() => expect(hook.result.current[0].title).toBe("one.test: /docs/a"));
    expect(hook.result.current[2].title).toBe("two.test: /docs/a");
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    const request = mocks.fetch.mock.calls[0][1];
    expect(request.path).toBe("pages");
    expect(request.params).toMatchObject({
      group: "page",
      hostname: "one.test",
      paths: '["/docs/a","/docs/b"]',
      start_date: "2026-10-12",
    });
    expect(mocks.context).toHaveBeenCalledWith({ useFilters: false });
    hook.rerender({ pages: [...pages].reverse() });
    expect(hook.result.current[0].title).toBe("two.test: /docs/a");
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it("does not fetch without authorization, and keeps sampled pages usable if titles are unavailable", async () => {
    mocks.fetch.mockRejectedValue(new Error("Unavailable"));
    const hook = renderHook(({ enabled }) => useGetHeatmapPageTitles(pages, enabled), {
      initialProps: { enabled: false },
      wrapper: wrapper(),
    });
    expect(mocks.fetch).not.toHaveBeenCalled();
    hook.rerender({ enabled: true });
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2));
    expect(hook.result.current).toMatchObject(pages);
    expect(hook.result.current.every(page => page.title === undefined)).toBe(true);
  });

  it("clears titles when switching sites", async () => {
    mocks.fetch.mockResolvedValue({ data: [{ key: "/docs/a", title: "First site" }], totalCount: 1 });
    const hook = renderHook(() => useGetHeatmapPageTitles(pages, true), { wrapper: wrapper() });
    await waitFor(() => expect(hook.result.current[0].title).toBe("First site"));
    mocks.fetch.mockImplementation(() => new Promise(() => {}));
    mocks.site = "2";
    hook.rerender();
    expect(hook.result.current[0].title).toBeUndefined();
  });
});
