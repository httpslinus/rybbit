import type { HeatmapMode, HeatmapResponse, HeatmapWidthBucket } from "@rybbit/shared";
import type { AnalyticsDescriptor } from "../analyticsRequest";
import { fetchAnalytics } from "../analyticsRequest";
import { toQueryParams, type CommonApiParams } from "./types";

export interface HeatmapSelection {
  view?: "pages";
  mode?: HeatmapMode;
  hostname?: string;
  pathname?: string;
  bucket?: HeatmapWidthBucket;
  search?: string;
  segmentId?: number | null;
  pageLimit?: number;
  pointLimit?: number;
  match?: "all" | "any";
  analyticsEventType?: "pageview" | "custom_event";
  excludeBounce?: boolean;
  cohortId?: number | null;
}

export interface HeatmapParams extends CommonApiParams, HeatmapSelection {}

export function heatmapDescriptor(options: HeatmapSelection = {}): AnalyticsDescriptor {
  return {
    path: "heatmaps",
    params: {
      view: options.view,
      mode: options.mode ?? "click",
      hostname: options.hostname,
      pathname: options.pathname,
      bucket: options.bucket,
      search: options.search || undefined,
      segment_id: options.segmentId ?? undefined,
      page_limit: options.pageLimit,
      point_limit: options.pointLimit,
      match: options.match ?? "all",
      analytics_event_type: options.analyticsEventType,
      exclude_bounce: options.excludeBounce || undefined,
      cohort_id: options.cohortId ?? undefined,
    },
  };
}

export function fetchHeatmaps(site: number | string, params: HeatmapParams): Promise<HeatmapResponse> {
  const descriptor = heatmapDescriptor(params);
  return fetchAnalytics<HeatmapResponse>(site, {
    path: descriptor.path,
    params: { ...toQueryParams(params), ...descriptor.params },
    unwrap: true,
  });
}
