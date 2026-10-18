import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageCapture } from "./pageCapture.js";
import type { ScriptConfig } from "./types.js";

const config = {
  analyticsHost: "https://analytics.example.com",
  skipPatterns: [],
  maskPatterns: [],
} as unknown as ScriptConfig;

describe("shared page capture", () => {
  let capture: PageCapture;

  beforeEach(() => {
    delete window.rybbitPageCapture;
    delete window.rybbitHeatmapSnapshot;
    capture = new PageCapture(config);
    capture.initialize();
  });

  afterEach(() => {
    capture.cleanup();
    delete window.rybbitPageCapture;
    delete window.rybbitHeatmapSnapshot;
    vi.restoreAllMocks();
  });

  it("prefers recording and sanitizes a copy without changing the replay tree", async () => {
    const node = {
      type: 0,
      id: 1,
      childNodes: [
        { type: 2, id: 2, tagName: "button", attributes: { onclick: "private handler" }, childNodes: [] },
        { type: 2, id: 3, tagName: "script", attributes: {}, childNodes: [] },
      ],
    };
    const original = JSON.stringify(node);
    const fallback = vi.fn();
    window.rybbitPageCapture = { capture: fallback };
    capture.registerRecorder(() => node);

    const result = await capture.capture(() => true);
    expect(result?.node).toEqual({
      type: 0,
      id: 1,
      childNodes: [{ type: 2, id: 2, tagName: "button", attributes: {}, childNodes: [] }],
    });
    expect(JSON.stringify(node)).toBe(original);
    expect(fallback).not.toHaveBeenCalled();
    expect(document.querySelector('script[src*="heatmap-snapshot.js"]')).toBeNull();
  });

  it.each(["unavailable", "failed", "invalid"])("uses standalone capture when recording is %s", async reason => {
    const node = { type: 0, id: 1, childNodes: [] };
    window.rybbitPageCapture = { capture: vi.fn(() => node) };
    capture.registerRecorder(() => {
      if (reason === "failed") throw new Error("Recorder stopped");
      return reason === "invalid" ? {} : null;
    });
    expect((await capture.capture(() => true))?.node).toBe(node);
    expect(window.rybbitPageCapture.capture).toHaveBeenCalledOnce();
  });

  it("can use a previously cached standalone capture API", async () => {
    const node = { type: 0, id: 1, childNodes: [] };
    window.rybbitHeatmapSnapshot = { capture: vi.fn(() => node) };
    expect((await capture.capture(() => true))?.node).toBe(node);
    expect(document.querySelector('script[src*="heatmap-snapshot.js"]')).toBeNull();
  });

  it("rejects stale nominations before invoking either provider", async () => {
    const recorder = vi.fn();
    const fallback = vi.fn();
    capture.registerRecorder(recorder);
    window.rybbitPageCapture = { capture: fallback };
    expect(await capture.capture(() => false)).toBeNull();
    expect(recorder).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
  });

  it("shares one guard and preserves the current provider when an older recorder unregisters", async () => {
    capture.cleanup();
    const listeners = vi.spyOn(window, "addEventListener");
    capture.initialize();
    capture.initialize();
    expect(listeners.mock.calls.filter(([name]) => name === "click")).toHaveLength(1);
    const unregister = capture.registerRecorder(() => null);
    const recorder = vi.fn(() => ({ type: 0, id: 1, childNodes: [] }));
    capture.registerRecorder(recorder);
    unregister();
    expect((await capture.capture(() => true))?.node.type).toBe(0);
    expect(recorder).toHaveBeenCalledOnce();
  });
});
