import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageCapture } from "./pageCapture.js";
import type { PageCaptureBridge } from "./featureTypes.js";
import type { ScriptConfig } from "./types.js";
import type { HeatmapSnapshotNode } from "@rybbit/shared";

const config = {
  analyticsHost: "https://analytics.example.com",
  skipPatterns: [],
  maskPatterns: [],
} as unknown as ScriptConfig;

describe("shared page capture", () => {
  let capture: PageCapture;
  let bridge: PageCaptureBridge;

  beforeEach(() => {
    delete window.rybbitPageCapture;
    delete window.rybbitHeatmapSnapshot;
    bridge = {};
    capture = new PageCapture(config, false, bridge);
    capture.initialize();
  });

  afterEach(() => {
    capture.cleanup();
    delete window.rybbitPageCapture;
    delete window.rybbitHeatmapSnapshot;
    vi.restoreAllMocks();
  });

  it("uses a stored recording checkpoint without copying or uploading a second DOM", async () => {
    bridge.capture = vi.fn().mockResolvedValue(true);
    const fallback = vi.fn();
    window.rybbitPageCapture = { capture: fallback };
    const result = await capture.capture(() => true);
    expect(result).toMatchObject({ source: "replay", context: { hostname: expect.any(String) } });
    expect(result).not.toHaveProperty("node");
    expect(bridge.capture).toHaveBeenCalledOnce();
    expect(fallback).not.toHaveBeenCalled();
    expect(document.querySelector('script[src*="page-capture.js"]')).toBeNull();
  });

  it.each(["unavailable", "failed"])("uses standalone capture when recording is %s", async reason => {
    const node = { type: 0, id: 1, childNodes: [] };
    window.rybbitPageCapture = { capture: vi.fn(() => node) };
    bridge.capture = vi.fn(async () => {
      if (reason === "failed") throw new Error("Recorder stopped");
      return false;
    });
    const result = await capture.capture(() => true);
    expect(result).toMatchObject({ source: "standalone", node });
    expect(window.rybbitPageCapture.capture).toHaveBeenCalledOnce();
  });

  it("sanitizes a standalone copy without changing the captured tree", async () => {
    const node: HeatmapSnapshotNode = {
      type: 0,
      id: 1,
      childNodes: [
        { type: 2, id: 2, tagName: "button", attributes: { onclick: "private handler" }, childNodes: [] },
        { type: 2, id: 3, tagName: "script", attributes: {}, childNodes: [] },
      ],
    };
    const original = JSON.stringify(node);
    window.rybbitPageCapture = { capture: () => node };
    expect(await capture.capture(() => true)).toMatchObject({
      source: "standalone",
      node: { childNodes: [{ type: 2, id: 2, tagName: "button", attributes: {}, childNodes: [] }] },
    });
    expect(JSON.stringify(node)).toBe(original);
  });

  it("supports previously cached standalone APIs", async () => {
    const node = { type: 0, id: 1, childNodes: [] };
    window.rybbitHeatmapSnapshot = { capture: vi.fn(() => node) };
    expect(await capture.capture(() => true)).toMatchObject({ source: "standalone", node });
    expect(document.querySelector('script[src*="page-capture.js"]')).toBeNull();
  });

  it("rejects stale nominations before invoking either provider", async () => {
    bridge.capture = vi.fn();
    const fallback = vi.fn();
    window.rybbitPageCapture = { capture: fallback };
    expect(await capture.capture(() => false)).toBeNull();
    expect(bridge.capture).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
  });

  it("rechecks eligibility after awaiting a recording checkpoint", async () => {
    let current = true;
    bridge.capture = vi.fn(async () => {
      current = false;
      return true;
    });
    const fallback = vi.fn();
    window.rybbitPageCapture = { capture: fallback };
    expect(await capture.capture(() => current)).toBeNull();
    expect(fallback).not.toHaveBeenCalled();
  });

  it("installs one guard and removes only its own context capability", () => {
    capture.cleanup();
    const listeners = vi.spyOn(window, "addEventListener");
    capture.initialize();
    capture.initialize();
    expect(listeners.mock.calls.filter(([name]) => name === "click")).toHaveLength(1);
    const replacement = vi.fn(() => null);
    bridge.context = replacement;
    capture.cleanup();
    expect(bridge.context).toBe(replacement);
  });
});
