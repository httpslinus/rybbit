import { describe, expect, it, vi } from "vitest";
import type { HeatmapPoint } from "@rybbit/shared";
import { drawClickHotspots, MAX_DENSITY_PIXELS, rasterizeClickHotspots } from "./clickCanvas";
import { fitHeatmap } from "./geometry";

function fixture() {
  const context = {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    drawImage: vi.fn(),
    createImageData: vi.fn((width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) })),
    putImageData: vi.fn(),
  };
  const surface = { width: 0, height: 0, getContext: vi.fn(() => context) };
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => context),
    ownerDocument: { createElement: vi.fn(() => surface) },
  } as unknown as HTMLCanvasElement;
  const point = (x = 100, y = 200, count = 1): HeatmapPoint => ({
    x,
    y,
    count,
    viewportWidth: 1440,
    viewportHeight: 900,
    documentWidth: 1440,
    documentHeight: 100_000,
  });
  const fit = fitHeatmap(
    { viewportWidth: 1440, viewportHeight: 900, documentWidth: 1440, documentHeight: 100_000 },
    720
  );
  return { canvas, context, point, fit };
}

function pixel(raster: ReturnType<typeof rasterizeClickHotspots>, x: number, y: number) {
  const offset = (Math.round(y * raster.ratio) * raster.width + Math.round(x * raster.ratio)) * 4;
  return Array.from(raster.pixels.slice(offset, offset + 4));
}

function expectPixelsEqual(left: Uint8ClampedArray, right: Uint8ClampedArray) {
  expect(Buffer.from(left).equals(Buffer.from(right))).toBe(true);
}

describe("click canvas", () => {
  it("maps exact CSS coordinates through scroll and fit, with DPR only changing display backing", () => {
    const { canvas, context, point, fit } = fixture();
    drawClickHotspots(canvas, [point(200, 1200)], fit, 500, 600, 2);
    expect(context.setTransform).toHaveBeenCalledWith(2, 0, 0, 2, 0, 0);
    expect(context.drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 720, 600);
    expect(pixel(rasterizeClickHotspots([point(200, 1200)], fit, 500, 600), 100, 100)).toEqual([249, 6, 6, 230]);
    expect(canvas.width).toBe(1440);
    expect(canvas.height).toBe(1200);
  });

  it("accumulates coincident geometry variants before coloring and is pixel-identical after shuffling", () => {
    const { point } = fixture();
    const fit = { scale: 1, width: 200, height: 200, sceneHeight: 200, virtual: false };
    const points = [point(40, 40, 100), { ...point(40, 40, 1), documentHeight: 5000 }, point(160, 160, 1)];
    const raster = rasterizeClickHotspots(points, fit, 0, 200);
    expectPixelsEqual(raster.pixels, rasterizeClickHotspots([points[2], points[1], points[0]], fit, 0, 200).pixels);
    expect(pixel(raster, 40, 40)).toEqual([249, 6, 6, 230]);
    const cold = pixel(raster, 160, 160);
    expect(cold[2]).toBeGreaterThan(cold[0]);
    expect(cold[3]).toBeLessThan(30);
    expect(pixel(raster, 40, 40)[3]).toBeGreaterThan(pixel(raster, 52, 40)[3]);
    expect(pixel(raster, 64, 40)[3]).toBe(0);
  });

  it("culls offscreen points and retains a viewport canvas on very long pages", () => {
    const { canvas, point, fit } = fixture();
    const visible = rasterizeClickHotspots([point(100, 1000)], fit, 500, 600);
    expectPixelsEqual(
      rasterizeClickHotspots([point(100, 20), point(100, 1000), point(100, 90_000)], fit, 500, 600).pixels,
      visible.pixels
    );
    drawClickHotspots(canvas, [point(100, 20), point(100, 1000), point(100, 90_000)], fit, 500, 600, 3);
    expect(canvas.height).toBe(1800);
    expect(canvas.height).toBeLessThan(fit.height);
  });

  it("keeps kernel contributions across viewport edges and translates them continuously when scrolling", () => {
    const { point } = fixture();
    const fit = { scale: 1, width: 200, height: 1000, sceneHeight: 1000, virtual: false };
    const points = [point(-10, 600), point(210, 600), point(100, 490)];
    const raster = rasterizeClickHotspots(points, fit, 500, 200);
    expect(pixel(raster, 0, 100)[3]).toBeGreaterThan(0);
    expect(pixel(raster, 199, 100)[3]).toBeGreaterThan(0);
    expect(pixel(raster, 100, 0)[3]).toBeGreaterThan(0);
    const shifted = rasterizeClickHotspots(points, fit, 495, 200);
    expect(pixel(shifted, 0, 105)).toEqual(pixel(raster, 0, 100));
  });

  it("bounds rendering at 5000 points and density allocation independently of DPR", () => {
    const { point } = fixture();
    const fit = { scale: 1, width: 200, height: 200, sceneHeight: 200, virtual: false };
    const points = Array.from({ length: 5000 }, () => point(40, 40));
    const raster = rasterizeClickHotspots([...points, point(160, 160, 100)], fit, 0, 200);
    expect(pixel(raster, 160, 160)).toEqual([0, 0, 0, 0]);
    expect(pixel(raster, 40, 40)).toEqual([249, 6, 6, 230]);
    const large = rasterizeClickHotspots([], { ...fit, width: 20_000, sceneHeight: 20_000 }, 0, 20_000);
    expect(large.width * large.height).toBeLessThanOrEqual(MAX_DENSITY_PIXELS);
  });

  it("clears stale pixels and ignores invalid points without poisoning valid weights", () => {
    const { canvas, context, point, fit } = fixture();
    const invalid = [point(NaN), point(100, Infinity), point(100, 200, NaN), point(100, 200, 0), point()];
    expectPixelsEqual(
      rasterizeClickHotspots(invalid, fit, 0, 600).pixels,
      rasterizeClickHotspots([point()], fit, 0, 600).pixels
    );
    drawClickHotspots(canvas, invalid, fit, 0, 600);
    expect(context.clearRect).toHaveBeenCalledWith(0, 0, 720, 600);
    drawClickHotspots(canvas, [], fit, 0, 600);
    expect(context.putImageData.mock.lastCall?.[0].data.some((value: number) => value !== 0)).toBe(false);
  });
});
