import type { IncomingHttpHeaders } from "node:http";
import type { AsnLookup } from "../../db/geolocation/asn.js";
import { classifyBotAsn } from "../tracker/botBlocking/botProviderAsns.js";
import { detectBot } from "../tracker/botBlocking/headerHeuristics.js";
import { classifyStaleBrowserVersion } from "../tracker/botBlocking/staleBrowserVersion.js";
import { classifyUA } from "../tracker/botBlocking/uaBots/index.js";

/** Reuse browser/ASN exclusions without charging batches to pageview anomaly counters. */
export function isHeatmapBot(input: {
  blockBots: boolean;
  headers: IncomingHttpHeaders;
  userAgent: string;
  ipAddress: string;
  lookupAsn: AsnLookup;
}): boolean {
  if (!input.blockBots) return false;
  if (classifyUA(input.userAgent).isBot || classifyStaleBrowserVersion(input.userAgent).isStale) return true;
  if (detectBot(input.headers, input.userAgent).isBot) return true;
  // General hosting/proxy infrastructure alone is supporting evidence in the
  // ordinary tracker too. Only dedicated bot providers exclude this request.
  return classifyBotAsn(input.lookupAsn(input.ipAddress)?.asn).source === "curated_bot_provider";
}
