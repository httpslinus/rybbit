import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeatureLoader, sampleRecording } from "./featureLoader.js";
import type { FeatureRuntime } from "./featureTypes.js";
import type { ScriptConfig } from "./types.js";
import { reserveKeepalive } from "./keepalive.js";

const config = { analyticsHost: "https://analytics.example.com", trackUrlFragments: false } as ScriptConfig;

describe("deferred feature lifecycle", () => {
  let loader: FeatureLoader;
  let runtime: FeatureRuntime;
  let feature: Record<
    "initialize" | "cleanup" | "startRecording" | "updateUserId" | "onPageChange" | "flushForExit",
    ReturnType<typeof vi.fn>
  >;
  const script = () => document.querySelector<HTMLScriptElement>('script[src$="/heatmaps.js"]')!;

  beforeEach(() => {
    vi.useFakeTimers();
    delete window.rybbitModules;
    runtime = { capture: {}, reserveKeepalive, pageAlreadyClicked: false };
    feature = {
      initialize: vi.fn(),
      cleanup: vi.fn(),
      startRecording: vi.fn(),
      updateUserId: vi.fn(),
      onPageChange: vi.fn(),
      flushForExit: vi.fn(),
    };
    loader = new FeatureLoader("heatmaps", config, "alice", runtime);
    sessionStorage.clear();
  });

  afterEach(() => {
    loader.cleanup();
    document
      .querySelectorAll('script[src$="/heatmaps.js"],script[src$="/recording.js"]')
      .forEach(script => script.remove());
    delete window.rybbitModules;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("preserves identity and pre-load click eligibility without loading the other feature", async () => {
    const listeners = vi.spyOn(window, "addEventListener");
    loader.cleanup();
    loader = new FeatureLoader("heatmaps", config, "alice", runtime);
    const initializing = loader.initialize();
    const listener = listeners.mock.calls.find(([type]) => type === "click")![1] as EventListener;
    listener({ isTrusted: true, button: 0 } as MouseEvent);
    loader.updateUserId("bob");
    const create = vi.fn(() => feature);
    window.rybbitModules = { heatmaps: { create } };
    script().dispatchEvent(new Event("load"));
    await initializing;
    expect(create).toHaveBeenCalledWith(config, "bob", expect.objectContaining({ pageAlreadyClicked: true }));
    expect(feature.initialize).toHaveBeenCalledOnce();
    expect(document.querySelector('script[src$="/recording.js"]')).toBeNull();
  });

  it("does not restart a feature after cleanup before its download finishes", async () => {
    const initializing = loader.initialize();
    loader.cleanup();
    const create = vi.fn(() => feature);
    window.rybbitModules = { heatmaps: { create } };
    script().dispatchEvent(new Event("load"));
    await initializing;
    expect(create).not.toHaveBeenCalled();
  });

  it("honors a manual stop issued during the download", async () => {
    const initializing = loader.initialize();
    loader.stopRecording();
    window.rybbitModules = { heatmaps: { create: () => feature as any } };
    script().dispatchEvent(new Event("load"));
    await initializing;
    expect(feature.initialize).not.toHaveBeenCalled();
    loader.startRecording();
    expect(feature.startRecording).toHaveBeenCalledOnce();
  });

  it("cleans up failed downloads and permits a later retry", async () => {
    const initializing = loader.initialize();
    script().dispatchEvent(new Event("error"));
    await expect(initializing).rejects.toThrow("Failed to load heatmaps");
    expect(script()).toBeNull();
    const retry = loader.initialize();
    window.rybbitModules = { heatmaps: { create: () => feature as any } };
    script().dispatchEvent(new Event("load"));
    await retry;
    expect(feature.initialize).toHaveBeenCalledOnce();
  });

  it("times out a download without leaving it running after cleanup", async () => {
    const initializing = loader.initialize();
    const rejected = expect(initializing).rejects.toThrow("Timed out loading heatmaps");
    await vi.advanceTimersByTimeAsync(10000);
    await rejected;
    expect(script()).toBeNull();
  });

  it("cleans up a partially initialized feature before retrying", async () => {
    window.rybbitModules = { heatmaps: { create: () => feature } };
    feature.initialize.mockImplementationOnce(() => {
      throw new Error("Initialization failed");
    });
    await expect(loader.initialize()).rejects.toThrow("Initialization failed");
    expect(feature.cleanup).toHaveBeenCalledOnce();
    await loader.initialize();
    expect(feature.initialize).toHaveBeenCalledTimes(2);
  });

  it("does not let a late recording download clear a new page's click guard", async () => {
    const previousUrl = window.location.href;
    const listeners = vi.spyOn(window, "addEventListener");
    loader.cleanup();
    loader = new FeatureLoader("heatmaps", config, "alice", runtime);
    const recording = new FeatureLoader("recording", config, "alice", runtime);
    try {
      const heatmapsReady = loader.initialize();
      const recordingReady = recording.initialize();
      history.pushState({}, "", "/new-page");
      const listener = listeners.mock.calls.find(([type]) => type === "click")![1] as EventListener;
      listener({ isTrusted: true, button: 0 } as MouseEvent);
      window.rybbitModules = { recording: { create: () => feature }, heatmaps: { create: () => feature } };
      document.querySelector('script[src$="/recording.js"]')!.dispatchEvent(new Event("load"));
      await recordingReady;
      expect(runtime.pageAlreadyClicked).toBe(true);
      script().dispatchEvent(new Event("load"));
      await heatmapsReady;
      expect(runtime.pageAlreadyClicked).toBe(true);
    } finally {
      recording.cleanup();
      history.replaceState({}, "", previousUrl);
    }
  });

  it("deduplicates concurrent asset downloads but gives each tracker its own instance and runtime", async () => {
    const otherRuntime = { ...runtime, capture: {} };
    const other = new FeatureLoader("heatmaps", config, "bob", otherRuntime);
    const first = loader.initialize();
    const second = other.initialize();
    const create = vi.fn(() => feature);
    window.rybbitModules = { heatmaps: { create } };
    expect(document.querySelectorAll('script[src$="/heatmaps.js"]')).toHaveLength(1);
    script().dispatchEvent(new Event("load"));
    await Promise.all([first, second]);
    expect(create).toHaveBeenCalledWith(config, "alice", runtime);
    expect(create).toHaveBeenCalledWith(config, "bob", otherRuntime);
    other.cleanup();
  });

  it("records every session by default and keeps explicit sampling stable", () => {
    expect(sampleRecording(undefined)).toBe(true);
    expect(sampleRecording(100)).toBe(true);
    expect(sampleRecording(0)).toBe(false);
    const random = vi.spyOn(Math, "random").mockReturnValueOnce(0.1).mockReturnValue(0.9);
    expect(sampleRecording(20)).toBe(true);
    expect(sampleRecording(20)).toBe(true);
    expect(random).toHaveBeenCalledOnce();
  });
});
