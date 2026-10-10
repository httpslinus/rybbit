import { describe, expect, it } from "vitest";
import type { HeatmapResponse } from "@rybbit/shared";
import {
  canvasBackingSize,
  fitHeatmap,
  MAX_SCENE_HEIGHT,
  pageGeometry,
  pointPosition,
  scrollReachBands,
  visibleDocumentTop,
} from "./geometry";

const geometry = { viewportWidth: 1440, viewportHeight: 900, documentWidth: 1440, documentHeight: 2000 };

describe("heatmap geometry", () => {
  it.each([375, 768, 1440])("aligns the page background and already-normalized API points at width %s", bucket => {
    const sourceWidth = bucket === 1440 ? 1366 : bucket;
    const available = Math.min(600, bucket);
    const fit = fitHeatmap({ ...geometry, viewportWidth: bucket, documentWidth: bucket }, available);
    const captured = { x: sourceWidth * 0.6, y: 1234 };
    const normalized = { x: (captured.x * bucket) / sourceWidth, y: (captured.y * bucket) / sourceWidth };
    const point = pointPosition(normalized, fit);
    expect(point.x).toBeCloseTo((captured.x * available) / sourceWidth, 10);
    expect(point.y).toBeCloseTo((captured.y * available) / sourceWidth, 10);
    expect(Math.abs(point.x - available * 0.6)).toBeLessThan(3);
    expect(fit.width).toBe(available);
    expect(fit.height).toBe(2000 * fit.scale);
  });

  it("fits by document width without stretching small pages or normalizing points twice", () => {
    const wide = fitHeatmap({ ...geometry, viewportWidth: 375, documentWidth: 1000 }, 500);
    expect(wide.scale).toBe(0.5);
    expect(pointPosition({ x: 900, y: 1500 }, wide, 500)).toEqual({ x: 450, y: 250 });
    expect(fitHeatmap(geometry, 2000).scale).toBe(1);
  });

  it("uses summary geometry even if the point limit omits the longest document", () => {
    const data = {
      selectedBucket: 375,
      geometry: { viewportWidth: 375, viewportHeight: 500, documentWidth: 375, documentHeight: 100_000 },
      points: [{ documentWidth: 375, documentHeight: 2000 }],
      background: null,
    } as HeatmapResponse;
    expect(pageGeometry(data).documentHeight).toBe(100_000);
    expect(pageGeometry({ ...data, geometry: null }).documentHeight).toBe(2000);
  });

  it("virtualizes extreme lengths while retaining actual point offsets at both ends", () => {
    const fit = fitHeatmap({ ...geometry, documentHeight: 4_000_000_000 }, 1440);
    expect(fit.virtual).toBe(true);
    expect(fit.sceneHeight).toBe(MAX_SCENE_HEIGHT);
    expect(visibleDocumentTop(0, 600, fit)).toBe(0);
    expect(visibleDocumentTop(MAX_SCENE_HEIGHT - 600, 600, fit)).toBe(4_000_000_000 - 600);
    expect(
      pointPosition({ x: 200, y: 4_000_000_000 - 20 }, fit, visibleDocumentTop(MAX_SCENE_HEIGHT - 600, 600, fit)).y
    ).toBe(580);
  });

  it.each([
    [375, 600, 3],
    [1920, 1200, 4],
    [100_000, 100_000, 2],
  ])("bounds backing pixels for %s × %s at DPR %s", (width, height, dpr) => {
    const backing = canvasBackingSize(width, height, dpr);
    expect(backing.width).toBeLessThanOrEqual(4096);
    expect(backing.height).toBeLessThanOrEqual(4096);
    expect(backing.width * backing.height).toBeLessThanOrEqual(8_388_608);
    expect(backing.ratio).toBeLessThanOrEqual(dpr);
  });

  it("keeps ordinary DPR sizing precise", () => {
    expect(canvasBackingSize(375, 600, 2)).toEqual({ width: 750, height: 1200, ratio: 2 });
  });

  it("renders inclusive cumulative reach with zero and 100% boundaries", () => {
    const maxima = [30, 60, 100];
    const histogram = Array.from({ length: 11 }, (_, index) => {
      const depth = index * 10;
      return {
        depth,
        count: maxima.filter(max => Math.floor(max / 10) * 10 === depth).length,
        reach: maxima.filter(max => max >= depth).length,
      };
    });
    const bands = scrollReachBands(histogram, 3);
    expect([10, 30, 50, 70, 100].map(depth => bands.find(band => band.depth === depth)?.reach)).toEqual([
      3, 3, 2, 1, 1,
    ]);
    expect(bands[9].percent).toBeCloseTo(100 / 3);
    expect(scrollReachBands([], 0)).toHaveLength(10);
    expect(scrollReachBands([], 0).every(band => band.percent === 0)).toBe(true);
    expect(
      scrollReachBands(
        histogram.map(band => ({ ...band, reach: 3 })),
        3
      ).every(band => band.percent === 100)
    ).toBe(true);
  });
});
