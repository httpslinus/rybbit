export const HEATMAP_WIDTH_BUCKETS = [320, 375, 425, 768, 1024, 1440, 1920] as const;
export type HeatmapWidthBucket = (typeof HEATMAP_WIDTH_BUCKETS)[number];
export type HeatmapMode = "click" | "scroll";

export const HEATMAP_MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

export interface HeatmapSnapshotContext {
  hostname: string;
  pathname: string;
  viewportWidth: number;
  viewportHeight: number;
  documentWidth: number;
  documentHeight: number;
}

export interface HeatmapSnapshotNode {
  type: number;
  id: number;
  childNodes?: HeatmapSnapshotNode[];
  tagName?: string;
  attributes?: Record<string, string | number | boolean | null>;
  textContent?: string;
  name?: string;
  publicId?: string;
  systemId?: string;
  isSVG?: boolean;
  isShadow?: boolean;
  isShadowHost?: boolean;
  isStyle?: boolean;
  compatMode?: string;
}

export interface HeatmapSnapshotRequest {
  key: string;
  token: string;
  pageVisitId: string;
  hostname: string;
  pathname: string;
  bucket: HeatmapWidthBucket;
}

export interface HeatmapSnapshot extends HeatmapSnapshotContext {
  capturedAt: string;
  source: "replay" | "standalone";
  node: HeatmapSnapshotNode;
}

export function heatmapWidthBucket(width: number): HeatmapWidthBucket {
  return HEATMAP_WIDTH_BUCKETS.reduce((nearest, bucket) =>
    Math.abs(bucket - width) < Math.abs(nearest - width) ? bucket : nearest
  );
}

export interface HeatmapGeometry {
  timestamp: number;
  pageVisitId: string;
  hostname: string;
  pathname: string;
  viewportWidth: number;
  viewportHeight: number;
  documentWidth: number;
  documentHeight: number;
}

export type HeatmapEvent = HeatmapGeometry &
  (
    | { type: "click"; clientX: number; clientY: number; pageX: number; pageY: number }
    | { type: "scroll"; maxDepth: number }
  );

export interface HeatmapBatch {
  batchId: string;
  events: HeatmapEvent[];
  /** Identified user ID; session and anonymous identity are assigned by the server. */
  userId?: string;
  /** Optional explicit client identity used by the ordinary tracker. */
  anonymousId?: string;
}

export interface HeatmapPage {
  hostname: string;
  pathname: string;
  count: number;
  sessions: number;
}

export interface HeatmapPoint {
  x: number;
  y: number;
  viewportWidth: number;
  viewportHeight: number;
  documentWidth: number;
  documentHeight: number;
  count: number;
}

export interface HeatmapScrollBand {
  depth: number;
  count: number;
  reach: number;
}

export interface HeatmapResponse {
  cohort?: {
    cohortId: number;
    name: string;
    members: number;
    startDate: string;
    endDate: string;
    timeZone: string;
  };
  mode: HeatmapMode;
  pages: HeatmapPage[];
  buckets: { width: HeatmapWidthBucket; count: number; sessions: number }[];
  selectedBucket: HeatmapWidthBucket | null;
  selectedPage: { hostname: string; pathname: string } | null;
  points: HeatmapPoint[];
  scroll: { histogram: HeatmapScrollBand[]; totalSessions: number };
  geometry: { viewportWidth: number; viewportHeight: number; documentWidth: number; documentHeight: number } | null;
  background: { url: string; width: number; height: number; snapshot?: HeatmapSnapshot } | null;
  count: number;
  sessions: number;
  truncated: { pages: boolean; points: boolean };
  limits: { pages: number; points: number };
}
