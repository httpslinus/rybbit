"use client";

import type { HeatmapPage } from "@rybbit/shared";
import { Check, ChevronDown, ChevronRight, Folder } from "lucide-react";
import { useExtracted } from "next-intl";
import { useState } from "react";
import type { TitledHeatmapPage } from "@/api/analytics/hooks/heatmaps/useGetHeatmapPageTitles";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const INITIAL_PAGES = 4;
const PAGE_INCREMENT = 10;

interface PageEntry {
  key: string;
  hostname: string;
  section: string | null;
  pages: TitledHeatmapPage[];
}

function groupPages(pages: TitledHeatmapPage[]): PageEntry[] {
  const entries = new Map<string, PageEntry>();
  for (const page of pages) {
    const section = page.pathname.match(/^\/[^/?#]+/)?.[0] ?? null;
    const key = `${page.hostname}\u0000${section ?? page.pathname}`;
    const entry = entries.get(key);
    if (entry) entry.pages.push(page);
    else entries.set(key, { key, hostname: page.hostname, section, pages: [page] });
  }
  return [...entries.values()];
}

export function HeatmapPageList({
  pages,
  selectedPage,
  showHostname,
  search,
  truncated,
  limit,
  onSelect,
}: {
  pages: TitledHeatmapPage[];
  selectedPage: Pick<HeatmapPage, "hostname" | "pathname"> | null;
  showHostname: boolean;
  search: string;
  truncated: boolean;
  limit: number;
  onSelect: (page: HeatmapPage) => void;
}) {
  const t = useExtracted();
  const [expanded, setExpanded] = useState<Record<string, { open: boolean; selection: string }>>({});
  const [visiblePages, setVisiblePages] = useState<Record<string, number>>({});
  const isSelected = (page: HeatmapPage) =>
    selectedPage?.hostname === page.hostname && selectedPage.pathname === page.pathname;
  const entries = search
    ? pages.map(page => ({
        key: `${page.hostname}\u0000${page.pathname}`,
        hostname: page.hostname,
        section: null,
        pages: [page],
      }))
    : groupPages(pages);
  const groups = entries.filter(entry => entry.section && entry.pages.length > 1);
  const selection = selectedPage ? `${selectedPage.hostname}\u0000${selectedPage.pathname}` : "";
  const isExpanded = (entry: PageEntry) => {
    const override = expanded[entry.key];
    const selected = entry.pages.some(isSelected);
    return override ? override.open || (selected && override.selection !== selection) : selected;
  };
  const allExpanded = groups.length > 0 && groups.every(isExpanded);

  const pageButton = (page: TitledHeatmapPage, child = false) => {
    const title = page.title?.trim();
    const path = showHostname ? `${page.hostname}${page.pathname}` : page.pathname;
    return (
      <button
        type="button"
        aria-label={[title, page.pathname, showHostname ? page.hostname : undefined].filter(Boolean).join(" ")}
        aria-pressed={isSelected(page)}
        title={title ? `${title}\n${path}` : path}
        onClick={() => onSelect(page)}
        className={cn(
          "flex w-full cursor-pointer items-center gap-3 py-2.5 pr-3.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-500",
          child ? "pl-[52px]" : "pl-3.5",
          isSelected(page) ? "bg-neutral-100 dark:bg-neutral-800" : "hover:bg-neutral-50 dark:hover:bg-neutral-850"
        )}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm font-medium">{title || page.pathname}</span>
          <span className="min-h-4 truncate text-xs text-neutral-500 dark:text-neutral-400">
            {title || showHostname ? path : page.title !== undefined ? t("No page title") : null}
          </span>
        </span>
        <span className="flex w-3.5 shrink-0 justify-end" aria-hidden="true">
          {isSelected(page) && <Check className="size-3.5" />}
        </span>
      </button>
    );
  };

  return (
    <>
      <ul aria-label={t("Pages")} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {entries.map(entry => {
          if (!entry.section || entry.pages.length === 1) {
            return <li key={entry.key}>{pageButton(entry.pages[0])}</li>;
          }
          const open = isExpanded(entry);
          const label = `${entry.section}/`;
          const accessibleLabel = showHostname ? `${entry.hostname}${label}` : label;
          const selectedIndex = entry.pages.findIndex(isSelected);
          const visible = Math.max(visiblePages[entry.key] ?? INITIAL_PAGES, selectedIndex + 1);
          const remaining = Math.max(0, entry.pages.length - visible);
          return (
            <li key={entry.key} className="border-t border-neutral-150 dark:border-neutral-800">
              <button
                type="button"
                aria-expanded={open}
                aria-label={
                  open
                    ? t("Collapse {section}", { section: accessibleLabel })
                    : t("Expand {section}", { section: accessibleLabel })
                }
                onClick={() => setExpanded(previous => ({ ...previous, [entry.key]: { open: !open, selection } }))}
                className="flex w-full cursor-pointer items-center gap-3 px-3.5 py-2 text-left hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-500 dark:hover:bg-neutral-850"
              >
                <span className="flex w-3 shrink-0 text-neutral-500 dark:text-neutral-400" aria-hidden="true">
                  {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-medium" title={label}>
                      {label}
                    </span>
                    <Folder className="size-3.5 shrink-0 text-neutral-500 dark:text-neutral-400" aria-hidden="true" />
                  </span>
                  <span className="text-xs text-neutral-500 dark:text-neutral-400">
                    {t("{count, plural, one {# page} other {# pages}}", { count: entry.pages.length })}
                  </span>
                  {showHostname && (
                    <span className="truncate text-xs text-neutral-500 dark:text-neutral-400">{entry.hostname}</span>
                  )}
                </span>
              </button>
              {open && (
                <ul aria-label={showHostname ? `${entry.hostname}${label}` : label}>
                  {entry.pages.slice(0, visible).map(page => (
                    <li key={page.pathname}>{pageButton(page, true)}</li>
                  ))}
                  {remaining > 0 && (
                    <li>
                      <button
                        type="button"
                        aria-label={t("Show {count} more pages in {section}", {
                          count: Math.min(remaining, PAGE_INCREMENT).toLocaleString(),
                          section: accessibleLabel,
                        })}
                        onClick={() =>
                          setVisiblePages(previous => ({ ...previous, [entry.key]: visible + PAGE_INCREMENT }))
                        }
                        className="w-full cursor-pointer py-2 pl-[52px] pr-3.5 text-left text-xs text-neutral-500 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-500 dark:text-neutral-400 dark:hover:text-neutral-100"
                      >
                        {t("Show {count} more", { count: Math.min(remaining, PAGE_INCREMENT).toLocaleString() })}
                      </button>
                    </li>
                  )}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-neutral-150 p-3 dark:border-neutral-800">
        <span
          className="text-xs text-neutral-500 dark:text-neutral-400"
          title={
            truncated
              ? t("Showing the top {count} pages. Search to find another page.", { count: limit.toLocaleString() })
              : undefined
          }
        >
          {truncated
            ? t("Top {count} pages", { count: limit.toLocaleString() })
            : t("{count, plural, one {# page} other {# pages}}", { count: pages.length })}
        </span>
        {groups.length > 0 && (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() =>
              setExpanded(Object.fromEntries(groups.map(entry => [entry.key, { open: !allExpanded, selection }])))
            }
          >
            {allExpanded ? t("Collapse all") : t("Expand all")}
          </Button>
        )}
      </div>
    </>
  );
}
