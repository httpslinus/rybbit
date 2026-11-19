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
  it.each([408, 429, 502, 503, 504])("requeues batches after HTTP %i", async status => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status } as Response);
    await expect(sendRecordingBatch(config, runtime, batch)).rejects.toThrow(String(status));
  });

  it.each([400, 500])("discards batches after HTTP %i to avoid invalid uploads or duplicate events", async status => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status } as Response);
    await expect(sendRecordingBatch(config, runtime, batch)).resolves.toEqual({ recorded: false });
  });

  it("passes stop and full snapshot requests back to the recorder", async () => {
    for (const response of [{ stopRecording: true }, { takeFullSnapshot: true }]) {
      vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => response } as Response);
      await expect(sendRecordingBatch(config, runtime, batch)).resolves.toEqual(response);
    }
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

  it("uses keepalive when regular and exit batches fit the shared budget", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ recorded: true }) } as Response);
    const batchWithText = (text: string): SessionReplayBatch => ({
      ...batch,
      events: [{ type: 3, data: text, timestamp: 1 }],
    });
    const mediumBatch = batchWithText("x".repeat(30 * 1024));

    await sendRecordingBatch(config, runtime, batch);
    await Promise.all([sendRecordingBatch(config, runtime, mediumBatch), sendRecordingBatch(config, runtime, mediumBatch)]);
    await sendRecordingBatch(config, runtime, batchWithText("€".repeat(20_000)), true);

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("/session-replay/record/42"),
      expect.objectContaining({ credentials: "omit" })
    );
    expect(vi.mocked(fetch).mock.calls.map(([, options]) => options?.keepalive)).toEqual([true, true, false, false]);
  });
});
