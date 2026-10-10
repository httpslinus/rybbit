import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SiteResponse } from "@/api/admin/endpoints";

const mocks = vi.hoisted(() => ({
  updateSiteConfig: vi.fn(),
  refetch: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  planName: "pro",
  cloud: false,
}));

vi.mock("next-intl", () => ({ useExtracted: () => (message: string) => message }));
vi.mock("@/api/admin/endpoints", () => ({ updateSiteConfig: mocks.updateSiteConfig }));
vi.mock("@/api/admin/hooks/useSites", () => ({ useGetSitesFromOrg: () => ({ refetch: mocks.refetch }) }));
vi.mock("@/lib/subscription/useStripeSubscription", () => ({
  useStripeSubscription: () => ({ data: { planName: mocks.planName }, isLoading: false }),
}));
vi.mock("@/lib/const", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/const")>()),
  get IS_CLOUD() {
    return mocks.cloud;
  },
}));
vi.mock("@/components/ui/sonner", () => ({ toast: { success: mocks.success, error: mocks.error } }));

import { TrackingTab } from "./TrackingTab";

function renderTracking(overrides: Partial<SiteResponse> = {}, disabled = false, adminMode = false) {
  const siteMetadata = { siteId: 17571, type: "web", organizationId: "org_1", ...overrides } as SiteResponse;
  const queryClient = new QueryClient();
  const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
  const result = render(
    <QueryClientProvider client={queryClient}>
      <TrackingTab siteMetadata={siteMetadata} disabled={disabled} adminMode={adminMode} />
    </QueryClientProvider>
  );
  return { ...result, invalidateQueries };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updateSiteConfig.mockResolvedValue({ success: true });
  mocks.planName = "pro";
  mocks.cloud = false;
});

describe("independent heatmap settings", () => {
  it("defaults collection off and the sample rate to 15 percent", () => {
    renderTracking();
    expect(screen.getByRole("switch", { name: "Heatmaps" }).getAttribute("aria-checked")).toBe("false");
    expect((screen.getByRole("spinbutton", { name: "Heatmap sample rate" }) as HTMLInputElement).value).toBe("15");
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("enables heatmaps while replay is off and the cloud plan does not include replay", async () => {
    mocks.cloud = true;
    mocks.planName = "appsumo-tier-1";
    renderTracking({ sessionReplay: false });
    const toggle = screen.getByRole("switch", { name: "Heatmaps" });
    expect((toggle as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(toggle);
    await waitFor(() => expect(mocks.updateSiteConfig).toHaveBeenCalledWith(17571, { heatmaps: true }));
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  });

  it("retains the saved toggle value when enabling fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.updateSiteConfig.mockRejectedValueOnce(new Error("Unavailable"));
    renderTracking({ heatmaps: false });
    const toggle = screen.getByRole("switch", { name: "Heatmaps" });
    fireEvent.click(toggle);
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith("Failed to update heatmaps"));
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect((toggle as HTMLButtonElement).disabled).toBe(false);
    expect(mocks.refetch).not.toHaveBeenCalled();
  });

  it("shows the saved settings and disables future collection without changing the rate", async () => {
    const { invalidateQueries } = renderTracking({ heatmaps: true, heatmapSampleRate: 40 }, false, true);
    const toggle = screen.getByRole("switch", { name: "Heatmaps" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect((screen.getByRole("spinbutton", { name: "Heatmap sample rate" }) as HTMLInputElement).value).toBe("40");
    fireEvent.click(toggle);
    await waitFor(() => expect(mocks.updateSiteConfig).toHaveBeenCalledWith(17571, { heatmaps: false }));
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["admin-organizations"] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["get-site"] });
    expect(mocks.refetch).not.toHaveBeenCalled();
  });

  it.each([0, 15.5, 100])("saves a sample rate of %s percent even while collection is off", async rate => {
    const { invalidateQueries } = renderTracking({ heatmaps: false, heatmapSampleRate: 25 });
    const input = screen.getByRole("spinbutton", { name: "Heatmap sample rate" });
    fireEvent.change(input, { target: { value: String(rate) } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.updateSiteConfig).toHaveBeenCalledWith(17571, { heatmapSampleRate: rate }));
    await waitFor(() => expect(mocks.success).toHaveBeenCalledWith("Heatmap sample rate updated"));
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["get-site"] });
    expect(mocks.refetch).toHaveBeenCalledOnce();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it.each(["", "-1", "101", "Infinity", "NaN"])("does not submit an invalid rate %j", value => {
    renderTracking();
    fireEvent.change(screen.getByRole("spinbutton", { name: "Heatmap sample rate" }), { target: { value } });
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(mocks.updateSiteConfig).not.toHaveBeenCalled();
  });

  it("restores the saved rate after an API failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.updateSiteConfig.mockRejectedValueOnce(new Error("Unavailable"));
    renderTracking({ heatmapSampleRate: 25 });
    const input = screen.getByRole("spinbutton", { name: "Heatmap sample rate" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith("Failed to update heatmap sample rate"));
    expect(input.value).toBe("25");
    expect(input.disabled).toBe(false);
    expect(mocks.refetch).not.toHaveBeenCalled();
  });

  it("disables rate editing during a save and invalidates admin queries after success", async () => {
    let resolveSave!: (value: unknown) => void;
    mocks.updateSiteConfig.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveSave = resolve;
        })
    );
    const { invalidateQueries } = renderTracking({}, false, true);
    const input = screen.getByRole("spinbutton", { name: "Heatmap sample rate" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "100" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(input.disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    resolveSave({ success: true });
    await waitFor(() => expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["admin-organizations"] }));
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["get-site"] });
    expect(mocks.refetch).not.toHaveBeenCalled();
  });

  it("respects read-only access for both controls", () => {
    renderTracking({}, true);
    expect((screen.getByRole("switch", { name: "Heatmaps" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("spinbutton", { name: "Heatmap sample rate" }) as HTMLInputElement).disabled).toBe(true);
  });

  it("hides heatmap collection and rate settings on mobile sites", () => {
    renderTracking({ type: "mobile" });
    expect(screen.queryByRole("switch", { name: "Heatmaps" })).toBeNull();
    expect(screen.queryByRole("spinbutton", { name: "Heatmap sample rate" })).toBeNull();
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("URL fragment tracking setting", () => {
  it("defaults off and saves the site setting when enabled", async () => {
    renderTracking();
    const toggle = screen.getByRole("switch", { name: "Track URL fragments" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    await waitFor(() => expect(mocks.updateSiteConfig).toHaveBeenCalledWith(17571, { trackUrlFragments: true }));
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
    expect(mocks.refetch).toHaveBeenCalledOnce();
  });

  it("shows a saved value and lets the user turn it off", async () => {
    renderTracking({ trackUrlFragments: true });
    const toggle = screen.getByRole("switch", { name: "Track URL fragments" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    await waitFor(() => expect(mocks.updateSiteConfig).toHaveBeenCalledWith(17571, { trackUrlFragments: false }));
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
  });

  it("respects read-only access", () => {
    renderTracking({}, true);
    expect((screen.getByRole("switch", { name: "Track URL fragments" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("hides the browser-only setting for mobile sites", () => {
    renderTracking({ type: "mobile" });
    expect(screen.queryByRole("switch", { name: "Track URL fragments" })).toBeNull();
  });
});
