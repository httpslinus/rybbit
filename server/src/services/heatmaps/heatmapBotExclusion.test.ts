import { describe, expect, it, vi } from "vitest";
import { isHeatmapBot } from "./heatmapBotExclusion.js";

const userAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const headers = {
  "user-agent": userAgent,
  "accept-language": "en-US",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "cross-site",
};
const base = { blockBots: true, headers, userAgent, ipAddress: "198.51.100.10", lookupAsn: () => null };

describe("heatmap bot exclusions", () => {
  it("keeps normal browsers and general datacenter proxy users", () => {
    expect(isHeatmapBot(base)).toBe(false);
    expect(isHeatmapBot({ ...base, lookupAsn: () => ({ asn: 16509, organization: "Amazon" }) })).toBe(false);
  });

  it("excludes known crawlers, scripting clients and stale browser versions", () => {
    for (const userAgent of ["Googlebot/2.1", "python-requests/2.31", "Mozilla/5.0 Chrome/50.0.0.0 Safari/537.36"]) {
      expect(isHeatmapBot({ ...base, userAgent })).toBe(true);
    }
  });

  it("excludes dedicated bot provider ASNs", () => {
    expect(isHeatmapBot({ ...base, lookupAsn: () => ({ asn: 401518, organization: "OpenAI" }) })).toBe(true);
  });

  it("honors disabled site bot blocking without ASN lookups", () => {
    const lookupAsn = vi.fn();
    expect(isHeatmapBot({ ...base, blockBots: false, userAgent: "Googlebot/2.1", lookupAsn })).toBe(false);
    expect(lookupAsn).not.toHaveBeenCalled();
  });
});
