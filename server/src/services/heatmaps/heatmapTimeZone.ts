/** ClickHouse requires an IANA name, including its canonical capitalization. */
export function normalizeHeatmapTimeZone(timeZone: string): string | null {
  // Modern Intl also accepts fixed offsets, which ClickHouse cannot load.
  if (/^[+-]/.test(timeZone)) return null;
  try {
    return new Intl.DateTimeFormat("en", { timeZone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}
