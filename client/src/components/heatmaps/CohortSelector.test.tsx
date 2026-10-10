import React from "react";
import type { Cohort, Filter, Permission } from "@rybbit/shared";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cohorts: [] as Cohort[],
  filters: [] as Filter[],
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  refetch: vi.fn(),
  get: vi.fn(),
  error: null as Error | null,
}));
vi.mock("next-intl", () => ({
  useExtracted:
    () =>
    (message: string, values: Record<string, string | number> = {}) =>
      message.replace(/\{(\w+)(?:, number)?\}/g, (_, key: string) => String(values[key] ?? key)),
}));
vi.mock("@/lib/store", () => ({
  useStore: (select: (state: unknown) => unknown) =>
    select({ filters: mocks.filters, time: { mode: "day", day: "2026-10-10" } }),
  useTimezone: () => "Europe/Tirane",
}));
vi.mock("@/api/analytics/hooks/heatmaps/useCohorts", () => ({
  useGetCohorts: (...args: unknown[]) => {
    mocks.get(...args);
    return { data: mocks.cohorts, isLoading: false, error: mocks.error, refetch: mocks.refetch };
  },
  useCreateCohort: () => ({ mutateAsync: mocks.create, isPending: false }),
  useUpdateCohort: () => ({ mutateAsync: mocks.update, isPending: false }),
  useDeleteCohort: () => ({ mutateAsync: mocks.remove, isPending: false }),
}));
vi.mock("@/app/[site]/components/SubHeader/Filters/FilterChip", () => ({
  FilterChip: ({ filter, onRemove }: { filter: Filter; onRemove: () => void }) => (
    <div>
      {filter.parameter}: {filter.value.join(", ")}
      <button type="button" onClick={onRemove}>
        Remove {filter.parameter}
      </button>
    </div>
  ),
}));
vi.mock("@/app/[site]/components/SubHeader/Filters/FilterPicker", () => ({
  FilterPicker: ({ onCommit, onClose }: { onCommit: (filter: Filter) => void; onClose: () => void }) => (
    <button
      type="button"
      onClick={() => {
        onCommit({ parameter: "event_name", type: "equals", value: ["purchase"] });
        onClose();
      }}
    >
      Add purchase event
    </button>
  ),
}));

import { CohortSelector } from "./CohortSelector";

const permissions: Permission[] = ["cohorts:read", "cohorts:write"];
const definition = (): Cohort => ({
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
});

function show({ cohortId = null, granted = permissions }: { cohortId?: number | null; granted?: Permission[] } = {}) {
  const onChange = vi.fn();
  render(
    <CohortSelector
      siteId="42"
      cohortId={cohortId}
      onChange={onChange}
      permissions={granted}
      availableFilters={["browser", "utm_source", "event_name"]}
    >
      {({ tab, chip }) => (
        <>
          {tab?.(() => {})}
          {chip}
        </>
      )}
    </CohortSelector>
  );
  return onChange;
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
  Object.defineProperty(Element.prototype, "scrollIntoView", { value: vi.fn(), configurable: true });
  mocks.cohorts = [definition()];
  mocks.filters = [{ parameter: "utm_source", type: "equals", value: ["newsletter"] }];
  mocks.error = null;
  mocks.create.mockResolvedValue({ ...definition(), cohortId: 9 });
  mocks.update.mockResolvedValue(definition());
  mocks.remove.mockResolvedValue({ success: true });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("historical cohort controls", () => {
  it("lets viewers select a cohort without exposing write controls", () => {
    const onChange = show({ granted: ["cohorts:read"] });
    expect(screen.queryByRole("button", { name: "New cohort" })).toBeNull();
    fireEvent.click(screen.getByRole("option", { name: "Chrome readers" }));
    expect(onChange).toHaveBeenCalledWith(7);
  });

  it("requires both write permissions and server-provided ownership before editing", () => {
    mocks.cohorts[0].canEdit = false;
    show({ cohortId: 7 });
    expect(screen.queryByRole("button", { name: "Cohort actions" })).toBeNull();
    cleanup();
    mocks.cohorts[0].canEdit = true;
    show({ cohortId: 7, granted: ["cohorts:read"] });
    expect(screen.queryByRole("button", { name: "Cohort actions" })).toBeNull();
    cleanup();
    show({ cohortId: 7, granted: ["cohorts:read", "cohorts:manage"] });
    expect(screen.getByRole("button", { name: "Cohort actions" })).toBeTruthy();
  });

  it("saves an explicit historical window and a snapshot of current filters", async () => {
    const onChange = show();
    fireEvent.click(screen.getByRole("button", { name: "New cohort" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: " Newsletter readers " } });
    fireEvent.change(screen.getByLabelText("Historical start date"), { target: { value: "2026-09-01" } });
    fireEvent.change(screen.getByLabelText("Historical end date"), { target: { value: "2026-09-30" } });
    fireEvent.change(screen.getByLabelText("Timezone"), { target: { value: "America/New_York" } });
    expect(
      screen.getByText("Members are visitors matching these filters within retained historical analytics.")
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save cohort" }));
    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith({
        siteId: "42",
        body: {
          name: "Newsletter readers",
          startDate: "2026-09-01",
          endDate: "2026-09-30",
          timeZone: "America/New_York",
          filters: [{ parameter: "utm_source", type: "equals", value: ["newsletter"] }],
        },
      })
    );
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(9));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.filters).toEqual([{ parameter: "utm_source", type: "equals", value: ["newsletter"] }]);
  });

  it("edits saved predicates locally without changing the dashboard filters", async () => {
    show({ cohortId: 7 });
    fireEvent.click(screen.getByRole("button", { name: "Chrome readers" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit cohort" }));
    const dialog = screen.getByRole("dialog", { name: "Edit cohort" });
    expect(within(dialog).getByText("browser: Chrome")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove browser" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Add filter" }));
    fireEvent.click(screen.getByRole("button", { name: "Add purchase event" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith({
        siteId: "42",
        cohortId: 7,
        body: {
          name: "Chrome readers",
          startDate: "2026-09-01",
          endDate: "2026-09-30",
          timeZone: "UTC",
          filters: [{ parameter: "event_name", type: "equals", value: ["purchase"] }],
        },
      })
    );
    expect(mocks.filters[0].parameter).toBe("utm_source");
  });

  it("rejects empty predicates instead of saving a cohort containing everyone", async () => {
    mocks.filters = [];
    show();
    fireEvent.click(screen.getByRole("button", { name: "New cohort" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Empty" } });
    fireEvent.click(screen.getByRole("button", { name: "Save cohort" }));
    expect(screen.getByRole("alert").textContent).toBe("Add at least one filter.");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it.each(["range", "timezone"])("keeps invalid historical %s input reviewable", condition => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "New cohort" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Readers" } });
    if (condition === "range")
      fireEvent.change(screen.getByLabelText("Historical start date"), { target: { value: "2026-11-01" } });
    else fireEvent.change(screen.getByLabelText("Timezone"), { target: { value: "Invalid/Zone" } });
    fireEvent.click(screen.getByRole("button", { name: "Save cohort" }));
    expect(screen.getByRole("alert").textContent).toBe(
      condition === "range" ? "Choose a valid historical date range." : "Enter a valid IANA timezone."
    );
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("keeps a failed save in the dialog and clears only the cohort selection after deletion", async () => {
    const onChange = show({ cohortId: 7 });
    fireEvent.click(screen.getByRole("button", { name: "Chrome readers" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit cohort" }));
    mocks.update.mockRejectedValueOnce(new Error("Save failed"));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Save failed"));
    expect(screen.getByLabelText("Name").getAttribute("value")).toBe("Chrome readers");
    fireEvent.click(screen.getByRole("button", { name: "Delete cohort" }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith({ siteId: "42", cohortId: 7 }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(null));
    expect(mocks.filters).toEqual([{ parameter: "utm_source", type: "equals", value: ["newsletter"] }]);
  });

  it("does not silently clear an unavailable cohort or expand it to everyone", () => {
    const onChange = show({ cohortId: 999 });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Clear cohort" }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("keeps cohort A selected when deleting unrelated cohort B from its actions", async () => {
    mocks.cohorts.push({ ...definition(), cohortId: 8, name: "Other readers" });
    const onChange = show({ cohortId: 7 });
    const other = screen.getByRole("option", { name: "Other readers" });
    fireEvent.keyDown(within(other).getByRole("button", { name: "Cohort actions" }), { key: "Enter" });
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit cohort" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete cohort" }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith({ siteId: "42", cohortId: 8 }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Chrome readers" })).toBeTruthy();
  });

  it("reports list errors with retry and hides all controls without read access", () => {
    mocks.error = new Error("List failed");
    show();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mocks.refetch).toHaveBeenCalledOnce();
    cleanup();
    show({ granted: [] });
    expect(mocks.get).toHaveBeenLastCalledWith("42", { enabled: false });
    expect(screen.queryByRole("combobox")).toBeNull();
  });
});
