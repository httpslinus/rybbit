export function getTrackedPathname(url: URL, trackUrlFragments = false): string {
  if (url.hash.startsWith("#/")) {
    return url.hash.substring(1);
  }
  if (url.hash.startsWith("#!/")) {
    return url.hash.substring(2);
  }
  return url.pathname + (trackUrlFragments ? url.hash : "");
}
import { findMatchingPattern } from "./utils.js";
import type { ScriptConfig } from "./types.js";

export function getTrackedPage(
  url: URL,
  config: Pick<ScriptConfig, "trackUrlFragments" | "skipPatterns" | "maskPatterns">
): { hostname: string; pathname: string } | null {
  const pathname = getTrackedPathname(url, config.trackUrlFragments);
  if (findMatchingPattern(pathname, config.skipPatterns)) return null;
  return {
    hostname: url.hostname,
    pathname: findMatchingPattern(pathname, config.maskPatterns) || pathname,
  };
}
