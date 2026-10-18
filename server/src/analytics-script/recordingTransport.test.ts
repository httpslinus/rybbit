import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendRecordingBatch } from "./recordingTransport.js";
import { reserveKeepalive } from "./keepalive.js";
import type { FeatureRuntime } from "./featureTypes.js";
import type { ScriptConfig, SessionReplayBatch } from "./types.js";

const config = { analyticsHost: "https://analytics.example.com", siteId: "42" } as ScriptConfig;
const runtime: FeatureRuntime = { capture: {}, reserveKeepalive, pageAlreadyClicked: false };
const batch: SessionReplayBatch = { userId: "alice", events: [{ type: 3, data: {}, timestamp: 1 }] };

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("recording transport", () => {
  it("rejects HTTP failures so recording events remain available for retry", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 503 } as Response);
    await expect(sendRecordingBatch(config, runtime, batch)).rejects.toThrow("Recording upload failed: 503");
  });

  it("recognizes discarded recordings rather than treating them as stored backgrounds", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, recorded: false }),
    } as Response);
    expect(await sendRecordingBatch(config, runtime, batch)).toMatchObject({ recorded: false });
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => {
        throw new Error("Plain-text limit response");
      },
    } as unknown as Response);
    expect(await sendRecordingBatch(config, runtime, batch)).toEqual({ recorded: false });
  });

  it("shares exit capacity with analytics and heatmaps and releases it after network failures", async () => {
    const releaseOther = reserveKeepalive("x".repeat(64 * 1024));
    await expect(sendRecordingBatch(config, runtime, batch, true)).rejects.toThrow("keepalive budget");
    expect(fetch).not.toHaveBeenCalled();
    releaseOther?.();
    vi.mocked(fetch).mockRejectedValue(new Error("offline"));
    await expect(sendRecordingBatch(config, runtime, batch, true)).rejects.toThrow("offline");
    const released = reserveKeepalive("x".repeat(64 * 1024));
    expect(released).not.toBeNull();
    released?.();
  });

  it("uses ordinary uploads for recording batches and keepalive only for exit batches", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ recorded: true }) } as Response);
    await sendRecordingBatch(config, runtime, batch);
    expect(fetch).toHaveBeenLastCalledWith(
      expect.stringContaining("/session-replay/record/42"),
      expect.objectContaining({ keepalive: false, credentials: "omit" })
    );
    await sendRecordingBatch(config, runtime, batch, true);
    expect(fetch).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ keepalive: true }));
  });
});
