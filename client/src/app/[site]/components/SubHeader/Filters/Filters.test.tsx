import React from "react";
import type { Filter, Segment } from "@rybbit/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";

const state = vi.hoisted(() => ({
  filters: [] as Filter[],
  segmentId: null as number | null,
  site: "1",
  segments: undefined as Segment[] | undefined,
}));

vi.mock("next-intl", () => ({ useExtracted: () => (message: string) => message }));
vi.mock("@/lib/store", () => ({ useStore: () => state, removeFilter: vi.fn(), updateFilter: vi.fn() }));
vi.mock("@/api/analytics/hooks/useSegments", () => ({ useGetSegments: () => ({ data: state.segments }) }));
vi.mock("./FilterChip", () => ({ FilterChip: ({ filter }: { filter: Filter }) => <span>{filter.parameter}</span> }));
vi.mock("./SegmentChip", () => ({ SegmentChip: ({ segment }: { segment: Segment }) => <span>{segment.name}</span> }));
vi.mock("./SegmentDialog", () => ({ SegmentDialog: () => null }));

import { Filters, type FilterMatching } from "./Filters";

const country: Filter = { parameter: "country", type: "equals", value: ["US", "DE"] };
const device: Filter = { parameter: "device_type", type: "equals", value: ["mobile"] };
const browser: Filter = { parameter: "browser", type: "equals", value: ["Firefox"] };
const tag: Filter = { parameter: "tag", type: "equals", value: ["campaign"] };
const segment: Segment = {
  segmentId: 7,
  siteId: 1,
  organizationId: "org",
  userId: "owner",
  name: "Saved audience",
  description: null,
  filters: [country, device],
  isPublic: false,
  type: "segment",
  createdAt: "2026-10-10T00:00:00Z",
  updatedAt: "2026-10-10T00:00:00Z",
  canEdit: true,
};

function filterRow(matching?: FilterMatching) {
  return (
    <TooltipProvider>
      <Filters availableFilters={["country", "device_type", "browser"]} matching={matching} />
    </TooltipProvider>
  );
}

beforeEach(() => {
  state.filters = [];
  state.segmentId = null;
  state.segments = undefined;
  vi.clearAllMocks();
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

describe("matching added filters", () => {
  it.each([[], [country]])("hides all matching with fewer than two criteria", (...filters) => {
    state.filters = filters as Filter[];
    render(filterRow({ value: "all", onChange: vi.fn() }));
    expect(screen.queryByRole("combobox", { name: "Match added filters" })).toBeNull();
  });

  it("counts filter objects rather than values and excludes inactive criteria", () => {
    state.filters = [country, tag];
    const view = render(filterRow({ value: "all", onChange: vi.fn() }));
    expect(screen.queryByRole("combobox", { name: "Match added filters" })).toBeNull();

    state.filters = [country, device, tag];
    view.rerender(filterRow({ value: "all", onChange: vi.fn() }));
    expect(screen.getByRole("combobox", { name: "Match added filters" }).textContent).toBe("Match all");
  });

  it("changes matching through the shared select", async () => {
    state.filters = [country, device];
    const onChange = vi.fn();
    render(filterRow({ value: "all", onChange }));
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Match added filters" }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "Match any" }));
    expect(onChange).toHaveBeenCalledWith("any");
  });

  it("keeps bookmarked any visible even without criteria and never resets it", () => {
    const onChange = vi.fn();
    render(filterRow({ value: "any", onChange }));
    expect(screen.getByRole("combobox", { name: "Match added filters" }).textContent).toBe("Match any");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("excludes saved-segment filter copies from the added group", () => {
    state.segmentId = segment.segmentId;
    state.segments = [segment];
    state.filters = [...segment.filters.map(filter => ({ ...filter, value: [...filter.value] })), browser];
    const view = render(filterRow({ value: "all", onChange: vi.fn() }));
    expect(screen.getByText("Saved audience")).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Match added filters" })).toBeNull();

    state.filters = [...state.filters, { parameter: "country", type: "equals", value: ["FR"] }];
    view.rerender(filterRow({ value: "all", onChange: vi.fn() }));
    expect(screen.getByRole("combobox", { name: "Match added filters" })).toBeTruthy();
  });

  it("defers all matching until the saved segment resolves", () => {
    state.segmentId = segment.segmentId;
    state.filters = [...segment.filters, browser];
    const onChange = vi.fn();
    const view = render(filterRow({ value: "all", onChange }));
    expect(screen.queryByRole("combobox", { name: "Match added filters" })).toBeNull();

    state.segments = [segment];
    view.rerender(filterRow({ value: "all", onChange }));
    expect(screen.queryByRole("combobox", { name: "Match added filters" })).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps bookmarked any available while a saved segment resolves", async () => {
    state.segmentId = segment.segmentId;
    state.filters = [...segment.filters];
    const onChange = vi.fn();
    const view = render(filterRow({ value: "any", onChange }));
    expect(screen.getByRole("combobox", { name: "Match added filters" }).textContent).toBe("Match any");

    state.segments = [segment];
    view.rerender(filterRow({ value: "any", onChange }));
    expect(screen.getByRole("combobox", { name: "Match added filters" }).textContent).toBe("Match any");
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByText("The saved segment must also match.")).toBeNull();
    fireEvent.focus(screen.getByRole("combobox", { name: "Match added filters" }));
    expect((await screen.findByRole("tooltip")).textContent).toBe("The saved segment must also match.");
  });

  it("preserves other reports without an optional matching prop", () => {
    state.filters = [country, device];
    render(filterRow());
    expect(screen.queryByRole("combobox", { name: "Match added filters" })).toBeNull();
  });
});
