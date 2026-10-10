import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  pathname: "/1/heatmaps",
  search: "start_date=2026-10-01&end_date=2026-10-10",
  site: { siteId: 1, type: "web", domain: "example.com", heatmaps: false, permissions: ["heatmaps:read"] },
}));

vi.mock("next-intl", () => ({ useExtracted: () => (message: string) => message }));
vi.mock("next/navigation", () => ({
  usePathname: () => state.pathname,
  useSearchParams: () => new URLSearchParams(state.search),
}));
vi.mock("next/link", () => ({
  default: ({ children, ...props }: React.ComponentProps<"a">) => <a {...props}>{children}</a>,
}));
vi.mock("@/api/admin/hooks/useSites", () => ({ useGetSite: () => ({ data: state.site }) }));
vi.mock("@/lib/subscription/useStripeSubscription", () => ({
  useStripeSubscription: () => ({ data: { planName: "appsumo-tier-1" }, isLoading: true }),
}));
vi.mock("@/lib/const", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/const")>()),
  IS_CLOUD: true,
  DEPLOYMENT: false,
}));
vi.mock("@/hooks/useIsProduction", () => ({ useAppEnv: () => "demo" }));
vi.mock("@/app/[site]/utils", () => ({
  useEmbedPageOptions: () => ({ embed: false, hideSidebar: false }),
  useEmbedablePage: () => false,
}));
vi.mock("@/components/command-palette/CommandPaletteTrigger", () => ({ CommandPaletteTrigger: () => null }));
vi.mock("@/components/SiteSettings/SiteSettings", () => ({ SiteSettings: () => null }));
vi.mock("@/components/AppSidebar", () => ({ AppSidebar: () => null }));
vi.mock("@/components/Favicon", () => ({ Favicon: () => null }));
vi.mock("./SiteSelector", () => ({ SiteSelector: () => null }));

import { MobileSidebar } from "./MobileSidebar";
import { Sidebar } from "./Sidebar";

beforeEach(() => {
  state.pathname = "/1/heatmaps";
  state.site = { siteId: 1, type: "web", domain: "example.com", heatmaps: false, permissions: ["heatmaps:read"] };
});
afterEach(cleanup);

describe("heatmap navigation", () => {
  it("shows an active, keyboard-focusable link with dates even when collection is off and replay is unavailable", () => {
    render(<Sidebar />);
    const link = screen.getByRole("link", { name: "Heatmaps" });
    expect(link.getAttribute("href")).toBe("/1/heatmaps?start_date=2026-10-01&end_date=2026-10-10");
    expect(link.getAttribute("aria-current")).toBe("page");
    link.focus();
    expect(document.activeElement).toBe(link);
  });

  it("hides the link for public or unauthorized viewers without heatmaps:read", () => {
    state.site.permissions = [];
    render(<Sidebar />);
    expect(screen.queryByRole("link", { name: "Heatmaps" })).toBeNull();
  });

  it("hides the link on private share routes", () => {
    state.pathname = "/1/abcdef123456/main";
    render(<Sidebar />);
    expect(screen.queryByRole("link", { name: "Heatmaps" })).toBeNull();
  });

  it("hides the web-only link for mobile sites", () => {
    state.site.type = "mobile";
    render(<Sidebar />);
    expect(screen.queryByRole("link", { name: "Heatmaps" })).toBeNull();
  });

  it("includes the same authorized link in the phone navigation sheet", () => {
    render(<MobileSidebar />);
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    expect(screen.getByRole("link", { name: "Heatmaps" }).getAttribute("href")).toContain("/1/heatmaps?");
  });
});
