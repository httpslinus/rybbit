import type { FeatureRuntime } from "./featureTypes.js";
import type { ScriptConfig, SessionReplayBatch, SessionReplayBatchResult } from "./types.js";

export async function sendRecordingBatch(
  config: ScriptConfig,
  runtime: FeatureRuntime,
  batch: SessionReplayBatch,
  exit = false
): Promise<SessionReplayBatchResult | void> {
  const body = JSON.stringify(batch);
  const release = exit ? runtime.reserveKeepalive(body) : null;
  if (exit && !release) throw new Error("Recording exceeds available keepalive budget");
  try {
    const response = await fetch(`${config.analyticsHost}/session-replay/record/${config.siteId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      mode: "cors",
      credentials: "omit",
      keepalive: release !== null,
    });
    if (!response.ok) throw new Error(`Recording upload failed: ${response.status}`);
    try {
      return (await response.json()) as SessionReplayBatchResult;
    } catch {
      return { recorded: false };
    }
  } finally {
    release?.();
  }
}
