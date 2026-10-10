import type { HeatmapPoint, HeatmapResponse, HeatmapScrollBand } from "@rybbit/shared";

export const MAX_SCENE_HEIGHT = 8_000_000;
const MAX_CANVAS_EDGE = 4096;
const MAX_CANVAS_PIXELS = 8_388_608;

export interface PageGeometry {
  viewportWidth: number;
  viewportHeight: number;
  documentWidth: number;
  documentHeight: number;
}

export interface HeatmapFit {
  scale: number;
  width: number;
  height: number;
  sceneHeight: number;
  virtual: boolean;
}

const positive = (value: number | undefined, fallback: number) =>
  value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;

export function pageGeometry(data: HeatmapResponse): PageGeometry {
  const viewportWidth = positive(data.geometry?.viewportWidth, data.selectedBucket || data.background?.width || 320);
  const viewportHeight = positive(data.geometry?.viewportHeight, 600);
  return {
    viewportWidth,
    viewportHeight,
    documentWidth: Math.max(
      viewportWidth,
      positive(data.geometry?.documentWidth, viewportWidth),
      ...data.points.slice(0, 5000).map(p => positive(p.documentWidth, viewportWidth))
    ),
    documentHeight: Math.max(
      viewportHeight,
      positive(data.geometry?.documentHeight, data.background?.height || viewportHeight),
      ...data.points.slice(0, 5000).map(p => positive(p.documentHeight, viewportHeight))
    ),
  };
}

export function fitHeatmap(geometry: PageGeometry, availableWidth: number): HeatmapFit {
  const scale = Math.min(1, positive(availableWidth, geometry.documentWidth) / geometry.documentWidth);
  const height = geometry.documentHeight * scale;
  return {
    scale,
    width: geometry.documentWidth * scale,
    height,
    sceneHeight: Math.min(MAX_SCENE_HEIGHT, height),
    virtual: height > MAX_SCENE_HEIGHT,
  };
}

/** API coordinates and dimensions are already normalized into the selected width bucket. */
export function pointPosition(point: Pick<HeatmapPoint, "x" | "y">, fit: HeatmapFit, visibleTop = 0) {
  return { x: point.x * fit.scale, y: point.y * fit.scale - visibleTop };
}

export function visibleDocumentTop(scrollTop: number, viewportHeight: number, fit: HeatmapFit): number {
  const physicalRange = Math.max(0, fit.sceneHeight - viewportHeight);
  const top = Math.max(0, Math.min(scrollTop, physicalRange));
  return fit.virtual && physicalRange > 0 ? (top * (fit.height - viewportHeight)) / physicalRange : top;
}

export function canvasBackingSize(width: number, height: number, devicePixelRatio = 1) {
  const cssWidth = positive(width, 1);
  const cssHeight = positive(height, 1);
  const ratio = Math.min(
    positive(devicePixelRatio, 1),
    MAX_CANVAS_EDGE / cssWidth,
    MAX_CANVAS_EDGE / cssHeight,
    Math.sqrt(MAX_CANVAS_PIXELS / (cssWidth * cssHeight))
  );
  return {
    width: Math.max(1, Math.floor(cssWidth * ratio)),
    height: Math.max(1, Math.floor(cssHeight * ratio)),
    ratio,
  };
}

export function scrollReachBands(histogram: HeatmapScrollBand[], totalSessions: number) {
  return Array.from({ length: 10 }, (_, index) => {
    const depth = (index + 1) * 10;
    const band = histogram.find(item => item.depth === depth);
    const reach = Math.min(Math.max(0, totalSessions), Math.max(0, band?.reach || 0));
    return { depth, reach, percent: totalSessions > 0 ? (reach / totalSessions) * 100 : 0 };
  });
}
