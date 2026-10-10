import type { HeatmapSnapshotContext } from "@rybbit/shared";
import type { ScriptConfig } from "./types.js";
import { getTrackedPage, getTrackedPathname } from "./url.js";

/** Capture page attribution together with the DOM, rather than at batch upload time. */
export function captureSnapshotContext(config: ScriptConfig): HeatmapSnapshotContext | null {
  const url = new URL(window.location.href);
  const page = getTrackedPage(url, config);
  if (!page) return null;
  const rawPath = getTrackedPathname(url, config.trackUrlFragments);
  const pathname = page.pathname === rawPath ? rawPath.split("?")[0] : page.pathname;
  if (!pathname || pathname.length > 2048 || page.hostname.length > 253) return null;

  const viewportWidth = Math.ceil(window.innerWidth);
  const viewportHeight = Math.ceil(window.innerHeight);
  if (
    !Number.isFinite(viewportWidth) ||
    !Number.isFinite(viewportHeight) ||
    viewportWidth <= 0 ||
    viewportHeight <= 0 ||
    viewportWidth > 0xffff ||
    viewportHeight > 0xffff
  )
    return null;

  let documentWidth = viewportWidth;
  let documentHeight = viewportHeight;
  for (const element of new Set([document.documentElement, document.body, document.scrollingElement])) {
    if (!element) continue;
    for (const width of [element.scrollWidth, element.clientWidth, (element as HTMLElement).offsetWidth]) {
      if (Number.isFinite(width) && width >= 0) documentWidth = Math.max(documentWidth, width);
    }
    for (const height of [element.scrollHeight, element.clientHeight, (element as HTMLElement).offsetHeight]) {
      if (Number.isFinite(height) && height >= 0) documentHeight = Math.max(documentHeight, height);
    }
  }
  documentWidth = Math.ceil(documentWidth);
  documentHeight = Math.ceil(documentHeight);
  if (documentWidth > 0xffffffff || documentHeight > 0xffffffff) return null;
  return { hostname: page.hostname, pathname, viewportWidth, viewportHeight, documentWidth, documentHeight };
}
