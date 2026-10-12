import React from "react";
import type { TitledHeatmapPage } from "@/api/analytics/hooks/heatmaps/useGetHeatmapPageTitles";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useExtracted:
    () =>
    (message: string, values: Record<string, string | number> = {}) => {
      if (message === "{count, plural, one {# page} other {# pages}}") {
        return `${values.count} ${values.count === 1 ? "page" : "pages"}`;
      }
      return message.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? key));
    },
}));

import { HeatmapPageList } from "./HeatmapPageList";

const page = (pathname: string, title = "", hostname = "shop.test"): TitledHeatmapPage => ({
  hostname,
  pathname,
  title,
  count: 10,
  sessions: 5,
});
const pages = [
  page("/", "Storefront"),
  page("/collections/all", "All products"),
  page("/collections/basics", "Basics"),
  page("/search", "Search"),
];
function list(overrides: Partial<React.ComponentProps<typeof HeatmapPageList>> = {}) {
  const onSelect = vi.fn();
  render(
    <HeatmapPageList
      pages={pages}
      selectedPage={pages[0]}
      showHostname={false}
      search=""
      truncated={false}
      limit={100}
      onSelect={onSelect}
      {...overrides}
    />
  );
  return onSelect;
}

afterEach(cleanup);

describe("heatmap page browser", () => {
  it("reopens the folder when a newly selected search result returns to the grouped list", () => {
    const props = {
      pages,
      selectedPage: pages[0],
      showHostname: false,
      search: "",
      truncated: false,
      limit: 100,
      onSelect: vi.fn(),
    };
    const view = render(<HeatmapPageList {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand /collections/" }));
    fireEvent.click(screen.getByRole("button", { name: "Collapse /collections/" }));
    view.rerender(<HeatmapPageList {...props} selectedPage={pages[1]} />);
    expect(screen.getByRole("button", { name: "All products /collections/all" }).getAttribute("aria-pressed")).toBe(
      "true"
    );
  });
  it("opens folders independently of page selection and leads with actual page titles", () => {
    const onSelect = list();
    expect(screen.queryByRole("button", { name: "All products /collections/all" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Expand /collections/" }));
    expect(onSelect).not.toHaveBeenCalled();
    const all = screen.getByRole("button", { name: "All products /collections/all" });
    expect(within(all).getByText("All products")).toBeTruthy();
    expect(within(all).getByText("/collections/all")).toBeTruthy();
    expect(screen.getByText("2 pages")).toBeTruthy();
    fireEvent.click(all);
    expect(onSelect).toHaveBeenCalledWith(pages[1]);
    fireEvent.click(screen.getByRole("button", { name: "Collapse /collections/" }));
    expect(screen.queryByRole("button", { name: "All products /collections/all" })).toBeNull();
  });

  it("reveals a selected page beyond the initial four rows and supports expanding and collapsing all", () => {
    const children = Array.from({ length: 16 }, (_, index) => page(`/collections/${index}`, `Product ${index}`));
    list({ pages: children, selectedPage: children[8] });
    expect(screen.getByRole("button", { name: "Product 8 /collections/8" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("button", { name: "Product 15 /collections/15" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show 7 more pages in /collections/" }));
    expect(screen.getByRole("button", { name: "Product 15 /collections/15" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(screen.queryByRole("button", { name: "Product 8 /collections/8" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
    expect(screen.getByRole("button", { name: "Product 8 /collections/8" })).toBeTruthy();
  });

  it("keeps hosts separate when the same folders and page titles appear on both", () => {
    const hostPages = ["shop.test", "other.test"].flatMap(hostname => [
      page("/collections/all", "All", hostname),
      page("/collections/basics", "Basics", hostname),
    ]);
    const onSelect = list({ pages: hostPages, selectedPage: hostPages[0], showHostname: true });
    fireEvent.click(screen.getByRole("button", { name: "Expand other.test/collections/" }));
    fireEvent.click(screen.getByRole("button", { name: "All /collections/all other.test" }));
    expect(onSelect).toHaveBeenCalledWith(hostPages[2]);
    expect(screen.getByRole("button", { name: "All /collections/all shop.test" }).getAttribute("aria-pressed")).toBe(
      "true"
    );
  });

  it("shows title search matches directly and gives untitled pages a path fallback", () => {
    list({ pages: [page("/collections/all", "All products"), page("/collections/basics")], search: "collections" });
    expect(screen.queryByRole("button", { name: "Expand /collections/" })).toBeNull();
    expect(screen.getByRole("button", { name: "All products /collections/all" })).toBeTruthy();
    expect(within(screen.getByRole("button", { name: "/collections/basics" })).getByText("No page title")).toBeTruthy();
  });
});
