export interface HeatmapBackgroundInput {
  configuredDomain: string;
  hostname: string;
  pathname: string;
  width: number;
  height: number;
}

/** Produces a live iframe descriptor without fetching any visitor URL. */
export function buildHeatmapBackground(
  input: HeatmapBackgroundInput
): { url: string; width: number; height: number } | null {
  const { configuredDomain, hostname, pathname, width, height } = input;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  if (!configuredDomain || configuredDomain.startsWith("//") || /[\\\s]/.test(configuredDomain)) return null;
  if (!hostname || hostname.length > 253 || /[\\\s/?#@:%]/.test(hostname)) return null;
  if (!pathname.startsWith("/") || pathname.startsWith("//") || /[\\?#\u0000-\u0020]/.test(pathname)) return null;
  try {
    const configured = new URL(
      /^[a-z][a-z\d+.-]*:\/\//i.test(configuredDomain) ? configuredDomain : `https://${configuredDomain}`
    );
    if (!["http:", "https:"].includes(configured.protocol) || configured.username || configured.password) return null;
    const observed = new URL(`https://${hostname}/`);
    if (observed.hostname !== hostname.toLowerCase() || observed.port || observed.username || observed.password)
      return null;
    const sameHost = observed.hostname === configured.hostname;
    if (!sameHost && !observed.hostname.endsWith(`.${configured.hostname}`)) return null;
    // Encoded separators can become a foreign URL after a downstream decode.
    const decoded = decodeURIComponent(pathname);
    if (decoded.startsWith("//") || /[\\?#\u0000-\u001f]/.test(decoded)) return null;
    if (decoded.split("/").some(segment => segment === "." || segment === "..")) return null;
    const origin = sameHost ? configured.origin : observed.origin;
    const url = new URL(pathname, origin);
    if (url.origin !== origin) return null;
    // Masked path segments contain '*'; encoding retains the masked path and
    // does not invent the original route or reveal a masked identifier.
    return { url: url.href.replace(/\*/g, "%2A"), width, height };
  } catch {
    return null;
  }
}
