"use client";

import type { HeatmapMode, HeatmapWidthBucket } from "@rybbit/shared";
import { parseAsBoolean, parseAsInteger, parseAsString, parseAsStringEnum, useQueryStates } from "nuqs";

// Type-only workspace imports keep this compatible with the client bundler.
const WIDTHS: readonly number[] = [320, 375, 425, 768, 1024, 1440, 1920];
export interface HeatmapPageSelection {
  hostname?: string;
  pathname?: string;
  bucket?: HeatmapWidthBucket;
}

export const heatmapUrlParsers = {
  heatmap_mode: parseAsStringEnum<HeatmapMode>(["click", "scroll"]).withDefault("click"),
  heatmap_search: parseAsString.withDefault(""),
  heatmap_click_host: parseAsString,
  heatmap_click_path: parseAsString,
  heatmap_click_width: parseAsInteger,
  heatmap_scroll_host: parseAsString,
  heatmap_scroll_path: parseAsString,
  heatmap_scroll_width: parseAsInteger,
  heatmap_match: parseAsStringEnum<"all" | "any">(["all", "any"]).withDefault("all"),
  heatmap_event_type: parseAsStringEnum<"pageview" | "custom_event">(["pageview", "custom_event"]),
  heatmap_exclude_bounce: parseAsBoolean.withDefault(false),
  heatmap_cohort: parseAsInteger,
};

export function heatmapSearchForSiteSwitch(search: string): string {
  const params = new URLSearchParams(search);
  for (const key of [
    "heatmap_click_host",
    "heatmap_click_path",
    "heatmap_click_width",
    "heatmap_scroll_host",
    "heatmap_scroll_path",
    "heatmap_scroll_width",
    "heatmap_cohort",
  ])
    params.delete(key);
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function readHeatmapSelection(values: {
  hostname: string | null;
  pathname: string | null;
  bucket: number | null;
}): HeatmapPageSelection {
  if (!values.hostname || !values.pathname) return {};
  return {
    hostname: values.hostname,
    pathname: values.pathname,
    ...(values.bucket !== null && WIDTHS.includes(values.bucket)
      ? { bucket: values.bucket as HeatmapWidthBucket }
      : {}),
  };
}

export function useHeatmapUrlState() {
  const [values, setValues] = useQueryStates(heatmapUrlParsers, { history: "replace", shallow: true });
  const mode = values.heatmap_mode;
  const selection = readHeatmapSelection(
    mode === "click"
      ? { hostname: values.heatmap_click_host, pathname: values.heatmap_click_path, bucket: values.heatmap_click_width }
      : {
          hostname: values.heatmap_scroll_host,
          pathname: values.heatmap_scroll_path,
          bucket: values.heatmap_scroll_width,
        }
  );
  return {
    mode,
    search: values.heatmap_search,
    selection,
    match: values.heatmap_match,
    analyticsEventType: values.heatmap_event_type ?? undefined,
    excludeBounce: values.heatmap_exclude_bounce,
    cohortId: values.heatmap_cohort !== null && values.heatmap_cohort > 0 ? values.heatmap_cohort : null,
    setMatch: (next: "all" | "any") => setValues({ heatmap_match: next }),
    setAnalyticsEventType: (next: "pageview" | "custom_event" | undefined) =>
      setValues({ heatmap_event_type: next ?? null }),
    setExcludeBounce: (next: boolean) => setValues({ heatmap_exclude_bounce: next || null }),
    setCohortId: (next: number | null) => setValues({ heatmap_cohort: next }),
    setMode: (next: HeatmapMode) => setValues({ heatmap_mode: next }),
    setSearch: (next: string) => setValues({ heatmap_search: next || null }),
    setSelection: (next: HeatmapPageSelection) =>
      setValues(
        mode === "click"
          ? {
              heatmap_click_host: next.hostname ?? null,
              heatmap_click_path: next.pathname ?? null,
              heatmap_click_width: next.bucket ?? null,
            }
          : {
              heatmap_scroll_host: next.hostname ?? null,
              heatmap_scroll_path: next.pathname ?? null,
              heatmap_scroll_width: next.bucket ?? null,
            }
      ),
  };
}
