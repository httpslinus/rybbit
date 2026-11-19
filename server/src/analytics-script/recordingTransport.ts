import type { FeatureRuntime } from "./featureTypes.js";
import type { ScriptConfig, SessionReplayBatch, SessionReplayBatchResult } from "./types.js";

const REPLAY_KEEPALIVE_BUDGET_BYTES = 48 * 1024;
// A 500 can come after event storage if the metadata insert failed.
const RETRYABLE_REPLAY_STATUSES = [408, 429, 502, 503, 504];

export async function sendRecordingBatch(
  config: ScriptConfig,
  runtime: FeatureRuntime,
  batch: SessionReplayBatch,
  exit = false
): Promise<SessionReplayBatchResult | void> {
  const body = JSON.stringify(batch);
  const bytes = body.length <= REPLAY_KEEPALIVE_BUDGET_BYTES ? new TextEncoder().encode(body).byteLength : Infinity;
  const canKeepalive = bytes <= REPLAY_KEEPALIVE_BUDGET_BYTES;
  const release = canKeepalive ? runtime.reserveKeepalive(bytes, REPLAY_KEEPALIVE_BUDGET_BYTES) : null;
  if (exit && canKeepalive && !release) throw new Error("Recording exceeds available keepalive budget");
  try {
    const response = await fetch(`${config.analyticsHost}/session-replay/record/${config.siteId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      mode: "cors",
      credentials: "omit",
      keepalive: release !== null,
    });
    if (!response.ok) {
      if (RETRYABLE_REPLAY_STATUSES.includes(response.status)) {
        throw new Error(`Recording upload failed: ${response.status}`);
      }
      return { recorded: false };
    }
    try {
      return (await response.json()) as SessionReplayBatchResult;
    } catch {
      return { recorded: false };
    }
  } finally {
    release?.();
  }
}
