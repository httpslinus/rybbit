import React from "react";
import type { HeatmapMode, HeatmapResponse } from "@rybbit/shared";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";

const mocks = vi.hoisted(() => ({
  site: { type: "web", heatmaps: true, permissions: ["heatmaps:read"] } as Record<string, unknown>,
  siteLoading: false,
  siteError: null as Error | null,
  time: { mode: "day" },
  siteId: "1",
  routeSite: "1",
  response: null as HeatmapResponse | null,
  loading: false,
  error: null as Error | null,
  getHeatmaps: vi.fn(),
  getPages: vi.fn(),
  pagesLoading: false,
  pagesError: null as Error | null,
  viewerMount: vi.fn(),
  refetch: vi.fn(),
  viewer: vi.fn(),
  segmentId: null as number | null,
  analyticsEventType: undefined as "pageview" | "custom_event" | undefined,
  excludeBounce: false,
  cohortId: null as number | null,
}));

vi.mock("next/navigation", () => ({ useParams: () => ({ site: mocks.routeSite }) }));

vi.mock("next-intl", () => ({
  useFormatter: () => ({ dateTime: () => "Oct 11, 2026, 10:00 AM" }),
  useExtracted:
    () =>
    (message: string, values: Record<string, string | number> = {}) =>
      message.replace(/\{(\w+)(?:, number)?\}/g, (_, key: string) => String(values[key] ?? key)),
}));
vi.mock("@/api/admin/hooks/useSites", () => ({
  useGetSite: () => ({
    data: mocks.site,
    isLoading: mocks.siteLoading,
    error: mocks.siteError,
    refetch: mocks.refetch,
  }),
}));
vi.mock("@/lib/store", () => ({
  useStore: (select: (state: unknown) => unknown) => {
    const site = React.useSyncExternalStore(
      () => () => {},
      () => mocks.siteId,
      () => ""
    );
    return select({ time: mocks.time, site, segmentId: mocks.segmentId });
  },
}));
vi.mock("@/hooks/useSetPageTitle", () => ({ useSetPageTitle: vi.fn() }));
vi.mock("@/app/[site]/components/SubHeader/SubHeader", () => ({
  SubHeader: () => <div data-testid="heatmap-date-header">Date range</div>,
}));
vi.mock("./HeatmapSubHeader", () => ({
  HeatmapSubHeader: () => <div data-testid="heatmap-date-header">Date range</div>,
}));
vi.mock("@/lib/heatmapUrlState", () => ({
  useHeatmapUrlState: () => {
    const [mode, setMode] = React.useState<HeatmapMode>("click");
    const [search, setSearch] = React.useState("");
    const [selections, setSelections] = React.useState({ click: {}, scroll: {} });
    const [match, setMatch] = React.useState<"all" | "any">("all");
    const [analyticsEventType, setAnalyticsEventType] = React.useState(mocks.analyticsEventType);
    const [excludeBounce, setExcludeBounce] = React.useState(mocks.excludeBounce);
    const [cohortId, setCohortId] = React.useState(mocks.cohortId);
    return {
      mode,
      setMode,
      search,
      setSearch,
      selection: selections[mode],
      setSelection: (next: object) => setSelections(previous => ({ ...previous, [mode]: next })),
      match,
      setMatch,
      analyticsEventType,
      setAnalyticsEventType,
      excludeBounce,
      setExcludeBounce,
      cohortId,
      setCohortId,
    };
  },
}));
vi.mock("@/api/analytics/hooks/heatmaps/useGetHeatmaps", () => ({
  useGetHeatmaps: (options: {
    view?: "pages";
    mode: HeatmapMode;
    hostname?: string;
    pathname?: string;
    bucket?: number;
  }) => {
    (options.view === "pages" ? mocks.getPages : mocks.getHeatmaps)(options);
    return {
      data: mocks.response
        ? {
            ...mocks.response,
            mode: options.mode,
            selectedPage: mocks.response.selectedPage
              ? {
                  hostname: options.hostname ?? mocks.response.selectedPage.hostname,
                  pathname: options.pathname ?? mocks.response.selectedPage.pathname,
                }
              : null,
          }
        : undefined,
      isLoading: options.view === "pages" ? mocks.pagesLoading : mocks.loading,
      error: options.view === "pages" ? mocks.pagesError : mocks.error,
      refetch: mocks.refetch,
    };
  },
}));
vi.mock("./HeatmapViewer", () => ({
  HeatmapViewer: (props: { showBackground: boolean; fullscreen: boolean }) => {
    React.useEffect(() => {
      mocks.viewerMount();
    }, []);
    mocks.viewer(props);
    return <div data-testid="heatmap-viewer">{props.showBackground ? "Saved fixture" : "Geometry fixture"}</div>;
  },
}));

import { HeatmapReport } from "./HeatmapReport";
import HeatmapsPage from "@/app/[site]/heatmaps/page";

function response(): HeatmapResponse {
  return {
    mode: "click",
    pages: [
      { hostname: "fixture.test", pathname: "/a", sessions: 3, count: 12 },
      { hostname: "fixture.test", pathname: "/b", sessions: 2, count: 4 },
    ],
    selectedPage: { hostname: "fixture.test", pathname: "/a" },
    buckets: [
      { width: 375, count: 12, sessions: 3 },
      { width: 768, count: 4, sessions: 2 },
    ],
    selectedBucket: 375,
    points: [],
    scroll: { histogram: [], totalSessions: 3 },
    geometry: { viewportWidth: 375, viewportHeight: 600, documentWidth: 375, documentHeight: 2000 },
    background: {
      url: "https://fixture.test/a",
      width: 375,
      height: 2000,
      snapshot: {
        source: "replay",
        capturedAt: "2026-10-11T10:00:00Z",
        hostname: "fixture.test",
        pathname: "/a",
        viewportWidth: 375,
        viewportHeight: 600,
        documentWidth: 375,
        documentHeight: 2000,
        node: { type: 0, id: 1, childNodes: [] },
      },
    },
    count: 12,
    sessions: 3,
    truncated: { pages: false, points: false },
    limits: { pages: 100, points: 5000 },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(Element.prototype, "scrollIntoView", { value: vi.fn(), configurable: true });
  mocks.site = { type: "web", heatmaps: true, permissions: ["heatmaps:read"] };
  mocks.siteLoading = false;
  mocks.siteError = null;
  mocks.time = { mode: "day" };
  mocks.siteId = "1";
  mocks.routeSite = "1";
  mocks.pagesLoading = false;
  mocks.pagesError = null;
  mocks.response = response();
  mocks.loading = false;
  mocks.error = null;
  mocks.segmentId = null;
  mocks.analyticsEventType = undefined;
  mocks.excludeBounce = false;
  mocks.cohortId = null;
});
afterEach(cleanup);

describe("heatmap report", () => {
  it("waits for the site context before hydrating date and report controls", async () => {
    const serverMarkup = renderToString(<HeatmapsPage />);
    expect(serverMarkup).toBe("");
    const container = document.createElement("div");
    container.innerHTML = serverMarkup;
    document.body.append(container);
    const recoverableError = vi.fn();
    const root = hydrateRoot(container, <HeatmapsPage />, { onRecoverableError: recoverableError });
    try {
      await waitFor(() => expect(within(container).getByTestId("heatmap-date-header")).toBeTruthy());
      expect(within(container).getByRole("heading", { name: "Heatmaps" })).toBeTruthy();
      expect(recoverableError).not.toHaveBeenCalled();
    } finally {
      root.unmount();
      container.remove();
    }
  });

  it("saves the API's initial page and width, then retains separate pages per mode", async () => {
    render(<HeatmapReport />);
    await waitFor(() =>
      expect(mocks.getHeatmaps).toHaveBeenLastCalledWith(
        expect.objectContaining({ mode: "click", hostname: "fixture.test", pathname: "/a", bucket: 375 })
      )
    );
    fireEvent.click(screen.getByRole("button", { name: "/b" }));
    expect(mocks.getHeatmaps).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "click", pathname: "/b" }));
    expect(mocks.getHeatmaps.mock.lastCall?.[0].bucket).toBeUndefined();
    fireEvent.click(screen.getByRole("radio", { name: "Scroll" }));
    await waitFor(() =>
      expect(mocks.getHeatmaps).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "scroll", pathname: "/a" }))
    );
    fireEvent.click(screen.getByRole("radio", { name: "Clicks" }));
    expect(mocks.getHeatmaps).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "click", pathname: "/b" }));
  });

  it("keeps collected samples visible when collection is disabled", () => {
    mocks.site.heatmaps = false;
    mocks.response!.pages[0].sessions = 99;
    mocks.response!.pages[0].count = 999;
    render(<HeatmapReport />);
    expect(
      screen.getByText("Collection is off. Enable heatmaps in site settings to collect new samples.")
    ).toBeTruthy();
    expect(screen.getByTestId("heatmap-viewer")).toBeTruthy();
    expect(screen.getByRole("button", { name: "/a" }).textContent).toBe("/a");
    expect(screen.queryByText("fixture.test")).toBeNull();
    expect(screen.queryByText(/Sampled sessions:/)).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Match filters" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sample details" }));
    const samples = screen.getByRole("dialog", { name: "Sample details" });
    expect(within(samples).getByText("Sampled sessions: 3")).toBeTruthy();
    expect(within(samples).getByText("Clicks: 12")).toBeTruthy();
  });

  it("distinguishes identical paths on different hosts and selects the correct host", () => {
    mocks.response!.pages[1] = { hostname: "shop.fixture.test", pathname: "/a", sessions: 2, count: 4 };
    render(<HeatmapReport />);
    expect(screen.getByRole("button", { name: /^\/afixture\.test$/ })).toBeTruthy();
    const shop = screen.getByRole("button", { name: /\/a.*shop\.fixture\.test/ });
    fireEvent.click(shop);
    expect(mocks.getHeatmaps).toHaveBeenLastCalledWith(
      expect.objectContaining({ hostname: "shop.fixture.test", pathname: "/a" })
    );
    expect(within(screen.getByRole("region", { name: "Heatmap detail" })).getByText("shop.fixture.test")).toBeTruthy();
  });

  it("keeps the host distinction when the selected page is outside the searched list", () => {
    mocks.response!.pages = [{ hostname: "shop.fixture.test", pathname: "/b", sessions: 2, count: 4 }];
    render(<HeatmapReport />);
    expect(screen.getByRole("button", { name: /\/b.*shop\.fixture\.test/ })).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Heatmap detail" })).getByText("fixture.test")).toBeTruthy();
  });

  it("offers geometry-only rendering and communicates report limits", () => {
    mocks.response!.truncated = { pages: true, points: true };
    render(<HeatmapReport />);
    fireEvent.click(screen.getByRole("switch", { name: "Page background" }));
    expect(mocks.viewer).toHaveBeenLastCalledWith(expect.objectContaining({ showBackground: false }));
    expect(screen.getByText("Geometry only")).toBeTruthy();
    expect(screen.getByText("Showing the top 100 pages. Search to find another page.")).toBeTruthy();
    expect(screen.getByText("Showing the 5,000 most frequent click points.")).toBeTruthy();
  });

  it("disables page background when unavailable without hiding the overlay", () => {
    mocks.response!.background = null;
    render(<HeatmapReport />);
    expect((screen.getByRole("switch", { name: "Page background" }) as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.viewer).toHaveBeenLastCalledWith(expect.objectContaining({ showBackground: true }));
    expect(screen.getByTestId("heatmap-viewer")).toBeTruthy();
  });

  it("opens a phone page picker and closes it after choosing a page", () => {
    render(<HeatmapReport />);
    fireEvent.click(screen.getByRole("button", { name: "Pages" }));
    const picker = screen.getByRole("dialog", { name: "Pages" });
    fireEvent.click(within(picker).getByRole("button", { name: "/b" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.getHeatmaps).toHaveBeenLastCalledWith(expect.objectContaining({ pathname: "/b" }));
  });

  it("opens and closes an accessible fullscreen detail and restores keyboard focus", async () => {
    render(<HeatmapReport />);
    const trigger = screen.getByRole("button", { name: "Open fullscreen" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "/a" })).toBeTruthy();
    expect(mocks.viewer).toHaveBeenLastCalledWith(expect.objectContaining({ fullscreen: true }));
    fireEvent.click(screen.getByRole("button", { name: "Close fullscreen" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("lets a keyboard user choose among observed widths", () => {
    render(<HeatmapReport />);
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Viewport width" }), { key: "ArrowDown" });
    const options = screen.getAllByRole("option");
    expect(options.map(option => option.textContent)).toEqual([
      "375 CSS px3 sampled sessions12 samples",
      "768 CSS px2 sampled sessions4 samples",
    ]);
    fireEvent.click(options[1]);
    expect(mocks.getHeatmaps).toHaveBeenLastCalledWith(expect.objectContaining({ bucket: 768 }));
  });

  it("sends saved analytics event type, bounce and cohort choices with the overlay request", () => {
    mocks.analyticsEventType = "custom_event";
    mocks.excludeBounce = true;
    mocks.cohortId = 7;
    render(<HeatmapReport />);
    expect(screen.queryByRole("combobox", { name: "Analytics event type" })).toBeNull();
    expect(screen.queryByText("Exclude bounced sessions")).toBeNull();
    expect(mocks.getHeatmaps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        mode: "click",
        match: "all",
        analyticsEventType: "custom_event",
        excludeBounce: true,
        cohortId: 7,
      })
    );
  });

  it("keeps an empty historical cohort selected and identifies the retained-data boundary", () => {
    mocks.cohortId = 7;
    mocks.response!.cohort = {
      cohortId: 7,
      name: "Old readers",
      members: 0,
      startDate: "2020-01-01",
      endDate: "2020-01-31",
      timeZone: "UTC",
    };
    mocks.response!.selectedPage = null;
    render(<HeatmapReport />);
    expect(mocks.getHeatmaps).toHaveBeenLastCalledWith(expect.objectContaining({ cohortId: 7 }));
    expect(
      screen.getByText(
        "No matching visitors in retained historical analytics. Choose another cohort or historical window."
      )
    ).toBeTruthy();
  });

  it("debounces page-list search and keeps the selected viewer and its scroll position while loading", async () => {
    const view = render(<HeatmapReport />);
    const viewer = screen.getByTestId("heatmap-viewer");
    viewer.scrollTop = 320;
    const detailRequest = mocks.getHeatmaps.mock.lastCall?.[0];
    const mountCount = mocks.viewerMount.mock.calls.length;
    fireEvent.change(screen.getByRole("searchbox", { name: "Search pages" }), { target: { value: "missing" } });
    expect(mocks.getHeatmaps.mock.lastCall?.[0]).toEqual(detailRequest);
    expect(mocks.getPages.mock.lastCall?.[0].search).toBe("");
    await waitFor(() => expect(mocks.getPages.mock.lastCall?.[0].search).toBe("missing"));
    mocks.pagesLoading = true;
    view.rerender(<HeatmapReport />);
    expect(screen.getByTestId("heatmap-viewer")).toBe(viewer);
    expect(viewer.scrollTop).toBe(320);
    expect(mocks.viewerMount).toHaveBeenCalledTimes(mountCount);
    mocks.pagesLoading = false;
    mocks.response!.pages = [];
    view.rerender(<HeatmapReport />);
    expect(screen.getByText("No matching pages")).toBeTruthy();
    expect(screen.getByTestId("heatmap-viewer")).toBeTruthy();
  });

  it("isolates a failed page-list request from the selected detail", () => {
    mocks.pagesError = new Error("Page search failed");
    render(<HeatmapReport />);
    expect(screen.getByText("Page search failed")).toBeTruthy();
    expect(screen.getByTestId("heatmap-viewer")).toBeTruthy();
  });

  it("does not display or persist the previous site's cached selection during navigation", () => {
    mocks.routeSite = "2";
    const view = render(<HeatmapReport />);
    expect(mocks.getHeatmaps).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
    expect(mocks.getHeatmaps.mock.lastCall?.[0]).not.toHaveProperty("pathname");
    expect(screen.queryByTestId("heatmap-viewer")).toBeNull();
    expect(screen.queryByRole("button", { name: "/a" })).toBeNull();
    mocks.siteId = "2";
    mocks.response!.selectedPage = { hostname: "other.test", pathname: "/new-site" };
    view.rerender(<HeatmapReport />);
    expect(mocks.getHeatmaps).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: true, hostname: "other.test", pathname: "/new-site" })
    );
  });

  it.each([
    ["permission", "You don't have access to heatmaps for this site."],
    ["mobile", "Heatmaps are available for web sites."],
    ["all-time", "Choose a date range to view heatmaps."],
  ])("does not request inaccessible or unbounded data: %s", (condition, message) => {
    if (condition === "permission") mocks.site.permissions = [];
    if (condition === "mobile") mocks.site.type = "mobile";
    if (condition === "all-time") mocks.time = { mode: "all-time" };
    mocks.response = null;
    render(<HeatmapReport />);
    expect(mocks.getHeatmaps).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
    expect(screen.getByText(message)).toBeTruthy();
    expect(screen.queryByTestId("heatmap-viewer")).toBeNull();
  });

  it("does not expose cached pages after read access is removed", () => {
    mocks.site.permissions = [];
    render(<HeatmapReport />);
    expect(screen.queryByRole("button", { name: "/a" })).toBeNull();
    expect(screen.queryByTestId("heatmap-viewer")).toBeNull();
  });

  it("shows loading, an empty result, and an actionable request error", () => {
    mocks.response = null;
    mocks.loading = true;
    const view = render(<HeatmapReport />);
    expect(screen.getByRole("status", { name: "Loading heatmaps" })).toBeTruthy();
    mocks.loading = false;
    view.rerender(<HeatmapReport />);
    expect(screen.getByText("No heatmap samples")).toBeTruthy();
    mocks.error = new Error("Request failed");
    view.rerender(<HeatmapReport />);
    expect(screen.getByText("Unable to load heatmaps")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mocks.refetch).toHaveBeenCalledOnce();
  });
});
