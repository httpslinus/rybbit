import {
  heatmapWidthBucket,
  sanitizeHeatmapSnapshot,
  type HeatmapResponse,
  type HeatmapSnapshot,
  type HeatmapSnapshotNode,
} from "@rybbit/shared";

export function pageSnapshot(data: HeatmapResponse): HeatmapSnapshot | null {
  const snapshot = data.background?.snapshot;
  if (
    !snapshot ||
    !data.selectedPage ||
    !data.selectedBucket ||
    snapshot.hostname !== data.selectedPage.hostname ||
    snapshot.pathname !== data.selectedPage.pathname ||
    !Number.isFinite(Date.parse(snapshot.capturedAt)) ||
    ![snapshot.viewportWidth, snapshot.viewportHeight, snapshot.documentWidth, snapshot.documentHeight].every(
      dimension => Number.isFinite(dimension) && dimension > 0
    ) ||
    heatmapWidthBucket(snapshot.viewportWidth) !== data.selectedBucket
  ) {
    return null;
  }
  return snapshot;
}

/** Preserve captured viewport units when the static iframe is expanded to the full document. */
export function capturedViewportCss(css: string, snapshot: Pick<HeatmapSnapshot, "viewportWidth" | "viewportHeight">) {
  const unitSizes: Record<string, number> = {
    vh: snapshot.viewportHeight,
    vw: snapshot.viewportWidth,
    vmin: Math.min(snapshot.viewportWidth, snapshot.viewportHeight),
    vmax: Math.max(snapshot.viewportWidth, snapshot.viewportHeight),
  };
  return css.replace(
    /\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|url\(\s*(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|(?:\\[\s\S]|[^)\\])*)\s*\)|(?<![\w-])([+-]?(?:\d*\.?\d+)(?:e[+-]?\d+)?)(?:[sld])?(vh|vw|vmin|vmax)\b/gi,
    (match, amount: string | undefined, unit: string | undefined) =>
      amount && unit ? `${(Number(amount) * unitSizes[unit.toLowerCase()]) / 100}px` : match
  );
}

export function prepareSnapshot(snapshot: HeatmapSnapshot): HeatmapSnapshotNode {
  const node = sanitizeHeatmapSnapshot(snapshot.node);
  function visit(current: HeatmapSnapshotNode, inStyle = false) {
    if (current.attributes) {
      for (const attribute of ["style", "_cssText"]) {
        const value = current.attributes[attribute];
        if (typeof value === "string") current.attributes[attribute] = capturedViewportCss(value, snapshot);
      }
    }
    if ((inStyle || current.isStyle) && typeof current.textContent === "string") {
      current.textContent = capturedViewportCss(current.textContent, snapshot);
    }
    current.childNodes?.forEach(child => visit(child, current.tagName === "style"));
  }
  visit(node);
  return node;
}
