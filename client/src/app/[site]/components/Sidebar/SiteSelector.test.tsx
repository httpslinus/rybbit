import React from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ pathname: "/1/heatmaps", site: "1", push: vi.fn() }));
vi.mock("next-intl", () => ({ useExtracted: () => (text: string) => text }));
vi.mock("next/navigation", () => ({ usePathname: () => mocks.pathname, useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/lib/store", () => ({ useStore: () => ({ site: mocks.site }) }));
vi.mock("@/lib/userStore", () => ({ userStore: () => ({ user: { id: "user" } }) }));
vi.mock("@/lib/auth", () => ({ authClient: { useActiveOrganization: () => ({ data: { id: "org" } }) } }));
vi.mock("@/hooks/usePermissions", () => ({ useCanInOrg: () => false }));
vi.mock("../../utils", () => ({ useEmbedablePage: () => false }));
vi.mock("@/components/Favicon", () => ({ Favicon: () => null }));
vi.mock("@/app/components/AddSite", () => ({ AddSite: () => null }));
vi.mock("@/api/admin/hooks/useSites", () => ({
  useGetSite: () => ({ data: { name: mocks.site === "1" ? "First site" : "Second site", domain: "fixture.test" } }),
  useGetSitesFromOrg: () => ({
    data: {
      sites: [
        { siteId: 1, name: "First site", domain: "first.test" },
        { siteId: 2, name: "Second site", domain: "second.test" },
      ],
    },
  }),
}));

import { SiteSelector } from "./SiteSelector";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.pathname = "/1/heatmaps";
  mocks.site = "1";
});
afterEach(cleanup);

describe("heatmap site navigation", () => {
  it("switches between two sites without carrying either site's heatmap page, width or cohort", () => {
    window.history.replaceState(
      null,
      "",
      "/1/heatmaps?heatmap_click_host=first.test&heatmap_click_path=%2Fa" +
        "&heatmap_click_width=375&heatmap_scroll_host=first.test&heatmap_scroll_path=%2Fb" +
        "&heatmap_scroll_width=768&heatmap_cohort=7&heatmap_mode=scroll&date=2026-10-10&filters=country%3AAL"
    );
    const view = render(<SiteSelector />);
    fireEvent.click(screen.getByRole("button", { name: "First site" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /Second site/ }));
    expect(mocks.push).toHaveBeenLastCalledWith("/2/heatmaps?heatmap_mode=scroll&date=2026-10-10&filters=country%3AAL");
    mocks.pathname = "/2/heatmaps";
    mocks.site = "2";
    window.history.replaceState(
      null,
      "",
      "/2/heatmaps?heatmap_click_host=second.test&heatmap_click_path=%2Fc" +
        "&heatmap_click_width=1024&heatmap_cohort=8&heatmap_mode=click&date=2026-10-10&filters=country%3AAL"
    );
    view.rerender(<SiteSelector />);
    fireEvent.click(screen.getByRole("button", { name: "Second site" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /First site/ }));
    expect(mocks.push).toHaveBeenLastCalledWith("/1/heatmaps?heatmap_mode=click&date=2026-10-10&filters=country%3AAL");
  });
});
