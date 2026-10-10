import type { HeatmapPoint } from "@rybbit/shared";
import { canvasBackingSize, pointPosition, type HeatmapFit } from "./geometry";

export const MAX_RENDERED_POINTS = 5000;
export const MAX_DENSITY_PIXELS = 2_097_152;

export function intensityColor(ratio: number, alpha = 1): string {
  const intensity = Math.max(0, Math.min(1, ratio));
  return `hsla(${(1 - intensity) * 240}, 95%, 50%, ${alpha})`;
}

const palette = new Uint8ClampedArray(256 * 4);
for (let index = 1; index < 256; index++) {
  const intensity = index / 255;
  const hue = (1 - intensity) * 4;
  const sector = Math.floor(hue);
  const intermediate = 1 - Math.abs((hue % 2) - 1);
  const color =
    sector === 0
      ? [1, intermediate, 0]
      : sector === 1
        ? [intermediate, 1, 0]
        : sector === 2
          ? [0, 1, intermediate]
          : [0, intermediate, 1];
  palette[index * 4] = (color[0] * 0.95 + 0.025) * 255;
  palette[index * 4 + 1] = (color[1] * 0.95 + 0.025) * 255;
  palette[index * 4 + 2] = (color[2] * 0.95 + 0.025) * 255;
  palette[index * 4 + 3] = intensity * 0.9 * 255;
}

export function rasterizeClickHotspots(
  points: HeatmapPoint[],
  fit: HeatmapFit,
  visibleTop: number,
  viewportHeight: number
) {
  const height = Math.min(viewportHeight, fit.sceneHeight);
  // Density needs CSS-pixel resolution, independently of the display's DPR.
  const raster = canvasBackingSize(
    fit.width,
    height,
    Math.min(1, Math.sqrt(MAX_DENSITY_PIXELS / (fit.width * height)))
  );
  const density = new Float32Array(raster.width * raster.height);
  const pixels = new Uint8ClampedArray(density.length * 4);
  const bounded = points
    .slice(0, MAX_RENDERED_POINTS)
    .filter(
      point => Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.count) && point.count > 0
    );
  const maximum = bounded.reduce((max, point) => Math.max(max, point.count), 1);
  // Stable addition also makes fractional weights reproducible across query order.
  bounded.sort((a, b) => a.x - b.x || a.y - b.y || a.count - b.count);
  const radius = Math.max(5, 24 * fit.scale) * raster.ratio;
  const radiusSquared = radius * radius;
  for (const point of bounded) {
    const position = pointPosition(point, fit, visibleTop);
    const x = position.x * raster.ratio;
    const y = position.y * raster.ratio;
    if (x < -radius || x > raster.width + radius || y < -radius || y > raster.height + radius) continue;
    const minX = Math.max(0, Math.ceil(x - radius));
    const maxX = Math.min(raster.width - 1, Math.floor(x + radius));
    const minY = Math.max(0, Math.ceil(y - radius));
    const maxY = Math.min(raster.height - 1, Math.floor(y + radius));
    const weight = point.count / maximum;
    for (let py = minY; py <= maxY; py++) {
      const dySquared = (py - y) ** 2;
      for (let px = minX; px <= maxX; px++) {
        const distanceSquared = (px - x) ** 2 + dySquared;
        if (distanceSquared >= radiusSquared) continue;
        const kernel = (1 - distanceSquared / radiusSquared) ** 2;
        density[py * raster.width + px] += weight * kernel;
      }
    }
  }
  // Apply the palette once to the sum, so a cold point cannot paint over heat.
  for (let index = 0; index < density.length; index++) {
    if (!density[index]) continue;
    const paletteOffset = Math.round(Math.sqrt(Math.min(1, density[index])) * 255) * 4;
    const offset = index * 4;
    pixels[offset] = palette[paletteOffset];
    pixels[offset + 1] = palette[paletteOffset + 1];
    pixels[offset + 2] = palette[paletteOffset + 2];
    pixels[offset + 3] = palette[paletteOffset + 3];
  }
  return { ...raster, pixels };
}

const rasterCanvases = new WeakMap<HTMLCanvasElement, HTMLCanvasElement>();

export function drawClickHotspots(
  canvas: HTMLCanvasElement,
  points: HeatmapPoint[],
  fit: HeatmapFit,
  visibleTop: number,
  viewportHeight: number,
  dpr = 1
): void {
  const height = Math.min(viewportHeight, fit.sceneHeight);
  const backing = canvasBackingSize(fit.width, height, dpr);
  if (canvas.width !== backing.width) canvas.width = backing.width;
  if (canvas.height !== backing.height) canvas.height = backing.height;
  const context = canvas.getContext("2d");
  if (!context) return;
  context.setTransform(backing.ratio, 0, 0, backing.ratio, 0, 0);
  context.clearRect(0, 0, fit.width, height);
  const raster = rasterizeClickHotspots(points, fit, visibleTop, height);
  let surface = rasterCanvases.get(canvas);
  if (!surface) {
    surface = canvas.ownerDocument.createElement("canvas");
    rasterCanvases.set(canvas, surface);
  }
  if (surface.width !== raster.width) surface.width = raster.width;
  if (surface.height !== raster.height) surface.height = raster.height;
  const rasterContext = surface.getContext("2d");
  if (!rasterContext) return;
  const bitmap = rasterContext.createImageData(raster.width, raster.height);
  bitmap.data.set(raster.pixels);
  rasterContext.putImageData(bitmap, 0, 0);
  context.drawImage(surface, 0, 0, fit.width, height);
}
