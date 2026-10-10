import React from "react";
import type { Cohort, Filter } from "@rybbit/shared";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NuqsTestingAdapter, type UrlUpdateEvent } from "nuqs/adapters/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";

const mocks = vi.hoisted(() => ({
  site: { type: "web", permissions: ["heatmaps:read", "cohorts:read", "cohorts:write"] },
  store: {
    site: "42",
    privateKey: null,
    filters: [] as Filter[],
    segmentId: null,
    time: { mode: "day", day: "2026-10-10" },
  },
  cohorts: [] as Cohort[],
  cohortsLoading: false,
}));
vi.mock("next-intl", () => ({ useExtracted: () => (message: string) => message }));
vi.mock("@/api/admin/hooks/useSites", () => ({ useGetSite: () => ({ data: mocks.site }) }));
vi.mock("@/lib/store", () => ({
  useStore: (select?: (state: typeof mocks.store) => unknown) => (select ? select(mocks.store) : mocks.store),
  useTimezone: () => "UTC",
  addFilter: vi.fn(),
  removeFilter: vi.fn(),
  updateFilter: vi.fn(),
}));
vi.mock("@/hooks/usePermissions", () => ({ useCanOnSite: () => false }));
vi.mock("@/api/analytics/hooks/useSegments", () => ({ useGetSegments: () => ({ data: [] }) }));
vi.mock("@/api/analytics/hooks/heatmaps/useCohorts", () => ({
  useGetCohorts: () => ({ data: mocks.cohorts, isLoading: mocks.cohortsLoading }),
  useCreateCohort: () => ({ isPending: false }),
  useUpdateCohort: () => ({ isPending: false }),
  useDeleteCohort: () => ({ isPending: false }),
}));
vi.mock("@/app/[site]/components/SubHeader/Filters/FilterPicker", () => ({
  FilterPicker: () => <div>Ordinary filter choices</div>,
}));
vi.mock("@/app/[site]/components/SubHeader/Filters/SegmentsTab", () => ({
  SegmentsTab: () => <div>Saved segment choices</div>,
}));
vi.mock("@/app/[site]/components/SubHeader/Filters/SegmentDialog", () => ({ SegmentDialog: () => null }));
vi.mock("@/app/[site]/components/SubHeader/SubHeader", async () => {
  const { NewFilterButton } = await import("@/app/[site]/components/SubHeader/Filters/NewFilterButton");
  const { Filters } = await import("@/app/[site]/components/SubHeader/Filters/Filters");
  return {
    SubHeader: (
      props: React.ComponentProps<typeof import("@/app/[site]/components/SubHeader/SubHeader").SubHeader>
    ) => (
      <>
        <NewFilterButton
          availableFilters={props.availableFilters}
          filterOptions={props.filterOptions}
          additionalTab={props.additionalTab}
        />
        <Filters availableFilters={props.availableFilters} matching={props.matching}>
          {props.activeFilters}
        </Filters>
      </>
    ),
  };
});

import { HeatmapSubHeader } from "./HeatmapSubHeader";
import { NewFilterButton } from "@/app/[site]/components/SubHeader/Filters/NewFilterButton";
import { useHeatmapUrlState } from "@/lib/heatmapUrlState";

function Header() {
  const state = useHeatmapUrlState();
  return <HeatmapSubHeader state={state} />;
}

const cohort: Cohort = {
  cohortId: 7,
  siteId: 42,
  name: "Chrome readers",
  userId: "owner",
  startDate: "2026-09-01",
  endDate: "2026-09-30",
  timeZone: "UTC",
  filters: [{ parameter: "browser", type: "equals", value: ["Chrome"] }],
  createdAt: "2026-10-10T00:00:00Z",
  updatedAt: "2026-10-10T00:00:00Z",
  canEdit: true,
};

function show(search = "") {
  const onUrlUpdate = vi.fn<(event: UrlUpdateEvent) => void>();
  render(
    <NuqsTestingAdapter searchParams={search} onUrlUpdate={onUrlUpdate} hasMemory>
      <TooltipProvider>
        <Header />
      </TooltipProvider>
    </NuqsTestingAdapter>
  );
  return onUrlUpdate;
}

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  vi.clearAllMocks();
  mocks.site = { type: "web", permissions: ["heatmaps:read", "cohorts:read", "cohorts:write"] };
  mocks.store.filters = [];
  mocks.cohorts = [cohort];
  mocks.cohortsLoading = false;
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("heatmap filters in the shared popover", () => {
  it("hides default choices until Filter opens and preserves the Segments tab", () => {
    show();
    expect(screen.queryByRole("combobox", { name: "Analytics event type" })).toBeNull();
    expect(screen.queryByText("Exclude bounced sessions")).toBeNull();
    expect(screen.queryByRole("button", { name: "New cohort" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    expect(screen.getByRole("combobox", { name: "Analytics event type" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Exclude bounced sessions" })).toBeTruthy();
    expect(screen.getByText("Ordinary filter choices")).toBeTruthy();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Segments" }), { button: 0, ctrlKey: false });
    expect(screen.getByText("Saved segment choices")).toBeTruthy();
  });

  it("applies and removes event/bounce choices through URL state without resetting other selections", async () => {
    const updated = show(
      "?heatmap_click_host=fixture.test&heatmap_click_path=/pricing&heatmap_click_width=1440&heatmap_match=any&heatmap_cohort=7"
    );
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Analytics event type" }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "Custom events" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Exclude bounced sessions" }));
    fireEvent.keyDown(screen.getByRole("checkbox", { name: "Exclude bounced sessions" }), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("checkbox")).toBeNull());
    expect(screen.getByRole("combobox", { name: "Analytics event type" }).textContent).toBe("Custom events");
    expect(screen.getByText("Exclude bounced sessions")).toBeTruthy();
    await waitFor(() => expect(updated.mock.lastCall?.[0].searchParams.get("heatmap_event_type")).toBe("custom_event"));
    fireEvent.click(screen.getByRole("button", { name: "Remove event type filter" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove bounce filter" }));
    await waitFor(() => {
      const query = updated.mock.lastCall?.[0].searchParams;
      expect(query?.has("heatmap_event_type")).toBe(false);
      expect(query?.has("heatmap_exclude_bounce")).toBe(false);
      expect(query?.get("heatmap_cohort")).toBe("7");
      expect(query?.get("heatmap_match")).toBe("any");
      expect(query?.get("heatmap_click_path")).toBe("/pricing");
      expect(query?.get("heatmap_click_width")).toBe("1440");
    });
  });

  it("selects cohorts from their tab, closes the popover and exposes a removable detail chip", async () => {
    const updated = show();
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Cohorts" }), { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByRole("option", { name: "Chrome readers" }));
    await waitFor(() => expect(screen.queryByRole("tab")).toBeNull());
    expect(screen.getByRole("button", { name: "Chrome readers" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Chrome readers" }));
    expect(screen.getByText("2026-09-01–2026-09-30 (UTC)")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("button", { name: "Edit cohort" }), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Clear cohort" }));
    await waitFor(() => expect(updated.mock.lastCall?.[0].searchParams.has("heatmap_cohort")).toBe(false));
  });

  it("opens the cohort editor after closing Filter so it remains mounted and focused", () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Cohorts" }), { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByRole("button", { name: "New cohort" }));
    expect(screen.getByRole("dialog", { name: "New cohort" })).toBeTruthy();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(document.activeElement).toBe(screen.getByLabelText("Name"));
  });

  it("preserves unavailable bookmarked cohorts until explicitly cleared", async () => {
    const updated = show("?heatmap_cohort=999");
    expect(screen.getByRole("button", { name: "Cohort unavailable" })).toBeTruthy();
    expect(updated).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Clear cohort" }));
    await waitFor(() => expect(updated.mock.lastCall?.[0].searchParams.has("heatmap_cohort")).toBe(false));
  });

  it.each(["no heatmap access", "mobile", "no cohort access"])(
    "keeps report choices permission scoped: %s",
    condition => {
      if (condition === "mobile") mocks.site.type = "mobile";
      else mocks.site.permissions = condition === "no heatmap access" ? ["cohorts:read"] : ["heatmaps:read"];
      show();
      fireEvent.click(screen.getByRole("button", { name: "Filter" }));
      expect(screen.queryByRole("tab", { name: "Cohorts" })).toBeNull();
      expect(Boolean(screen.queryByRole("combobox", { name: "Analytics event type" }))).toBe(
        condition === "no cohort access"
      );
    }
  );

  it("leaves other reports with their existing two-tab filter picker", () => {
    render(<NewFilterButton availableFilters={["country"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    expect(screen.getAllByRole("tab").map(tab => tab.textContent)).toEqual(["Filters", "Segments"]);
    expect(screen.queryByRole("combobox", { name: "Analytics event type" })).toBeNull();
  });

  it("returns to ordinary filters if access to the selected report tab is removed", () => {
    const view = render(
      <NewFilterButton additionalTab={{ label: "Cohorts", content: () => <div>Cohort choices</div> }} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Cohorts" }), { button: 0, ctrlKey: false });
    expect(screen.getByText("Cohort choices")).toBeTruthy();
    view.rerender(<NewFilterButton />);
    expect(screen.getByRole("tab", { name: "Filters" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Ordinary filter choices")).toBeTruthy();
  });
});
