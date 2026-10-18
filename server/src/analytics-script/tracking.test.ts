import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Tracker } from "./tracking.js";
import { HeatmapCollector } from "./heatmapCollector.js";
import { FeatureLoader } from "./featureLoader.js";
import { ScriptConfig } from "./types.js";
import { resetBotScoreCacheForTests } from "./botSignals.js";
import { reserveKeepalive } from "./keepalive.js";

// Mock fetch globally
global.fetch = vi.fn();
const NativeURL = URL;

describe("Tracker", () => {
  let tracker: Tracker;
  let config: ScriptConfig;
  let mockLocation: any;

  beforeEach(() => {
    resetBotScoreCacheForTests();
    window.rybbitModules = {
      heatmaps: { create: (config, userId, runtime) => new HeatmapCollector(config, userId, undefined, runtime) },
    };

    // Reset fetch mock
    vi.mocked(global.fetch).mockReset();
    vi.mocked(global.fetch).mockResolvedValue({} as Response);

    // Mock localStorage
    const localStorageMock = {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    Object.defineProperty(window, "localStorage", {
      value: localStorageMock,
      writable: true,
    });

    // Mock window properties
    mockLocation = {
      href: "https://example.com/page?query=test",
      origin: "https://example.com",
      hostname: "example.com",
      pathname: "/page",
      search: "?query=test",
      hash: "",
    };

    Object.defineProperty(window, "location", {
      value: mockLocation,
      configurable: true,
      writable: true,
    });

    // Mock URL constructor to use our mockLocation
    vi.stubGlobal(
      "URL",
      vi.fn().mockImplementation((input: string | URL, base?: string | URL) => {
        if (String(input) !== mockLocation.href) return new NativeURL(input, base);
        return {
          hostname: mockLocation.hostname,
          pathname: mockLocation.pathname,
          search: mockLocation.search,
          hash: mockLocation.hash,
          searchParams: { entries: () => [["query", "test"]] },
        };
      })
    );

    Object.defineProperty(screen, "width", {
      value: 1920,
      writable: true,
    });

    Object.defineProperty(screen, "height", {
      value: 1080,
      writable: true,
    });

    Object.defineProperty(navigator, "language", {
      value: "en-US",
      writable: true,
    });

    Object.defineProperty(document, "title", {
      value: "Test Page",
      writable: true,
    });

    Object.defineProperty(document, "referrer", {
      value: "https://google.com",
      writable: true,
    });

    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      value: vi.fn(() => null),
      configurable: true,
    });

    config = {
      namespace: "rybbit",
      analyticsHost: "https://analytics.example.com",
      siteId: "123",
      visitorId: "visitor-123",
      debounceDuration: 0,
      autoTrackPageview: true,
      autoTrackSpa: true,
      trackQuerystring: true,
      trackUrlFragments: false,
      trackOutbound: true,
      trackErrors: false,
      enableWebVitals: false,
      enableSessionReplay: false,
      sessionReplayBatchSize: 50,
      sessionReplayBatchInterval: 5000,
      sessionReplayMaskTextSelectors: [],
      skipPatterns: [],
      maskPatterns: [],
      trackButtonClicks: false,
      trackCopy: false,
      trackFormInteractions: false,
      tag: "",
      featureFlagsEnabled: false,
      featureFlags: {},
    };

    tracker = new Tracker(config);
  });

  afterEach(() => {
    tracker.cleanup();
    delete window.rybbitModules;
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe("createBasePayload", () => {
    it("should create base payload with all required fields", () => {
      const payload = tracker.createBasePayload();

      expect(payload).toEqual({
        site_id: "123",
        hostname: "example.com",
        pathname: "/page",
        querystring: "?query=test",
        screenWidth: 1920,
        screenHeight: 1080,
        language: "en-US",
        page_title: "Test Page",
        referrer: "https://google.com",
        _bs: expect.any(Number),
        _bsm: expect.any(Number),
      });
    });

    it("should handle hash-based routing", () => {
      mockLocation.hash = "#/dashboard/users";
      const payload = tracker.createBasePayload();
      expect(payload?.pathname).toBe("/dashboard/users");
    });

    it("handles hashbang routes without changing slash-prefixed hash routes", () => {
      mockLocation.hash = "#!/shipping";
      expect(tracker.createBasePayload()?.pathname).toBe("/shipping");
    });

    it("ignores ordinary fragments by default", () => {
      mockLocation.pathname = "/checkout/";
      mockLocation.hash = "#shipping";
      expect(tracker.createBasePayload()?.pathname).toBe("/checkout/");
    });

    it("preserves checkout stages when URL fragment tracking is enabled", () => {
      config.trackUrlFragments = true;
      tracker = new Tracker(config);
      mockLocation.pathname = "/checkout/";
      mockLocation.hash = "#shipping";
      expect(tracker.createBasePayload()?.pathname).toBe("/checkout/#shipping");
      mockLocation.hash = "#payment";
      expect(tracker.createBasePayload()?.pathname).toBe("/checkout/#payment");
    });

    it("should skip tracking for matching skip patterns", () => {
      config.skipPatterns = ["/admin/**", "/api/**"];
      tracker = new Tracker(config);

      mockLocation.pathname = "/admin/settings";
      const payload = tracker.createBasePayload();
      expect(payload).toBeNull();
    });

    it("should apply mask patterns", () => {
      config.maskPatterns = ["/user/*/profile"];
      tracker = new Tracker(config);

      mockLocation.pathname = "/user/123/profile";
      const payload = tracker.createBasePayload();
      expect(payload?.pathname).toBe("/user/*/profile");
    });

    it("should support regex skip and mask patterns", () => {
      config.skipPatterns = ["re:^/private/.*$"];
      config.maskPatterns = ["re:^/user/\\d+/profile$"];
      tracker = new Tracker(config);

      mockLocation.pathname = "/private/settings";
      expect(tracker.createBasePayload()).toBeNull();

      mockLocation.pathname = "/user/123/profile";
      const payload = tracker.createBasePayload();
      expect(payload?.pathname).toBe("re:^/user/\\d+/profile$");
    });

    it("should exclude querystring when disabled", () => {
      config.trackQuerystring = false;
      tracker = new Tracker(config);

      const payload = tracker.createBasePayload();
      expect(payload?.querystring).toBe("");
    });

    it("should include user ID when set", () => {
      vi.mocked(window.localStorage.getItem).mockReturnValue("user-123");
      tracker = new Tracker(config);

      const payload = tracker.createBasePayload();
      expect(payload?.user_id).toBe("user-123");
    });

    it("should include evaluated feature flags in payloads", () => {
      config.featureFlags = {
        new_checkout: {
          key: "new_checkout",
          value: true,
          flagType: "boolean",
          payload: { copy: "Try it now" },
          version: 1,
          reason: "rollout",
          matched: true,
          rolloutPercentage: 100,
        },
      };
      tracker = new Tracker(config);

      const payload = tracker.createBasePayload();
      expect(payload?.feature_flags).toEqual({ new_checkout: "true" });
      expect(tracker.getFeatureFlagPayload("new_checkout")).toEqual({ copy: "Try it now" });
    });
  });

  describe("tracking methods", () => {
    it("should track pageview", async () => {
      tracker.trackPageview();

      expect(global.fetch).toHaveBeenCalledWith(
        "https://analytics.example.com/track",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: expect.stringContaining('"type":"pageview"'),
          mode: "cors",
          keepalive: true,
        })
      );
    });

    it("should track custom event", async () => {
      tracker.trackEvent("button_click", { button: "submit" });

      expect(global.fetch).toHaveBeenCalledWith(
        "https://analytics.example.com/track",
        expect.objectContaining({
          body: expect.stringContaining('"type":"custom_event"'),
        })
      );

      const body = JSON.parse(vi.mocked(global.fetch).mock.calls[0][1]!.body as string);
      expect(body.event_name).toBe("button_click");
      expect(body.properties).toBe(JSON.stringify({ button: "submit" }));
    });

    it("should track feature flag exposure once when a flag is read", () => {
      config.featureFlags = {
        new_checkout: {
          key: "new_checkout",
          value: true,
          flagType: "boolean",
          version: 1,
          reason: "rollout",
          matched: true,
          rolloutPercentage: 100,
        },
      };
      tracker = new Tracker(config);
      vi.mocked(global.fetch).mockClear();

      expect(tracker.getFeatureFlag("new_checkout", false)).toBe(true);
      expect(tracker.getFeatureFlag("new_checkout", false)).toBe(true);

      expect(global.fetch).toHaveBeenCalledTimes(1);
      const body = JSON.parse(vi.mocked(global.fetch).mock.calls[0][1]!.body as string);
      expect(body.type).toBe("custom_event");
      expect(body.event_name).toBe("feature_flag_exposure");
      expect(JSON.parse(body.properties)).toMatchObject({
        key: "new_checkout",
        value: "true",
        version: 1,
        reason: "rollout",
      });
    });

    it("should validate custom event name", () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      tracker.trackEvent("", {});
      expect(global.fetch).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith("Event name is required and must be a string for custom events");

      consoleSpy.mockRestore();
    });

    it("should track outbound link", async () => {
      tracker.trackOutbound("https://external.com", "External Link", "_blank");

      const body = JSON.parse(vi.mocked(global.fetch).mock.calls[0][1]!.body as string);
      expect(body.type).toBe("outbound");
      expect(body.properties).toBe(
        JSON.stringify({
          url: "https://external.com",
          text: "External Link",
          target: "_blank",
        })
      );
    });

    it("should track web vitals", async () => {
      const vitals = {
        lcp: 2500,
        cls: 0.1,
        inp: 200,
        fcp: 1800,
        ttfb: 800,
      };

      tracker.trackWebVitals(vitals);

      const body = JSON.parse(vi.mocked(global.fetch).mock.calls[0][1]!.body as string);
      expect(body.type).toBe("performance");
      expect(body.event_name).toBe("web-vitals");
      expect(body.lcp).toBe(2500);
      expect(body.cls).toBe(0.1);
    });

    it("should handle fetch errors gracefully", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(global.fetch).mockRejectedValue(new Error("Network error"));

      tracker.trackPageview();

      // Wait for async operation
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(consoleSpy).toHaveBeenCalledWith("Failed to send tracking data:", expect.any(Error));

      consoleSpy.mockRestore();
    });

    it("handles payload serialization failures without escaping the tracking error boundary", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const payload = { ...tracker.createBasePayload()!, type: "pageview" as const };
      Object.assign(payload, { self: payload });

      await expect(tracker.sendTrackingData(payload)).resolves.toBeUndefined();

      expect(fetch).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith("Failed to send tracking data:", expect.any(TypeError));
      const release = reserveKeepalive("x".repeat(64 * 1024));
      expect(release).not.toBeNull();
      release?.();
    });

    describe("error tracking", () => {
      it("should track first-party errors", () => {
        // Enable error tracking for this test
        const errorConfig = { ...config, trackErrors: true };
        const tracker = new Tracker(errorConfig);
        const sendSpy = vi.spyOn(tracker, "sendTrackingData").mockResolvedValue();

        const error = new Error("Test error");
        error.stack = "Error: Test error\n    at https://example.com/app.js:10:5";

        tracker.trackError(error, {
          filename: "https://example.com/app.js",
          lineno: 10,
          colno: 5,
        });

        expect(sendSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "error",
            event_name: "Error",
            properties: expect.stringContaining("Test error"),
          })
        );
      });

      it("should filter out third-party errors by filename", () => {
        const errorConfig = { ...config, trackErrors: true };
        const tracker = new Tracker(errorConfig);
        const sendSpy = vi.spyOn(tracker, "sendTrackingData").mockResolvedValue();

        // Mock window.location.origin to ensure we have a proper origin for comparison
        Object.defineProperty(window, "location", {
          value: {
            ...mockLocation,
            origin: "https://example.com",
          },
          configurable: true,
          writable: true,
        });

        const error = new Error("Third party error");
        // Clear the stack to avoid test environment paths interfering
        error.stack = undefined;

        tracker.trackError(error, {
          filename: "https://ads.google.com/script.js",
          lineno: 1,
          colno: 1,
        });

        expect(sendSpy).not.toHaveBeenCalled();
      });

      it("should filter out third-party errors by stack trace", () => {
        const errorConfig = { ...config, trackErrors: true };
        const tracker = new Tracker(errorConfig);
        const sendSpy = vi.spyOn(tracker, "sendTrackingData").mockResolvedValue();

        const error = new Error("Third party error");
        error.stack = "Error: Third party error\n    at https://ads.google.com/script.js:1:1";

        tracker.trackError(error, {
          lineno: 1,
          colno: 1,
        });

        expect(sendSpy).not.toHaveBeenCalled();
      });

      it("should track errors with unknown origin (e.g., NetworkError)", () => {
        const errorConfig = { ...config, trackErrors: true };
        const tracker = new Tracker(errorConfig);
        const sendSpy = vi.spyOn(tracker, "sendTrackingData").mockResolvedValue();

        const error = new Error("NetworkError when attempting to fetch resource");
        error.name = "TypeError";
        // Clear stack to avoid test environment paths
        error.stack = undefined;

        tracker.trackError(error, {
          type: "unhandledrejection",
        });

        expect(sendSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "error",
            event_name: "TypeError",
            properties: expect.stringContaining("NetworkError"),
          })
        );
      });

      it("should handle invalid filename URLs gracefully", () => {
        const errorConfig = { ...config, trackErrors: true };
        const tracker = new Tracker(errorConfig);
        const sendSpy = vi.spyOn(tracker, "sendTrackingData").mockResolvedValue();

        const error = new Error("Test error");
        error.stack = "Error: Test error\n    at https://example.com/app.js:10:5";

        tracker.trackError(error, {
          filename: "invalid-url",
          lineno: 10,
          colno: 5,
        });

        // Should fall back to stack trace check and track the error
        expect(sendSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "error",
            event_name: "Error",
            properties: expect.stringContaining("Test error"),
          })
        );
      });
    });
  });

  describe("user identification", () => {
    it("should identify user", () => {
      tracker.identify("user-456");

      expect(window.localStorage.setItem).toHaveBeenCalledWith(`${config.namespace}-user-id`, "user-456");
      expect(tracker.getUserId()).toBe("user-456");
    });

    it("shares pending identify requests with the heatmap keepalive budget and releases it on completion", async () => {
      let completeIdentify!: (response: Response) => void;
      vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>(resolve => (completeIdentify = resolve)));
      const releaseHeatmap = reserveKeepalive("x".repeat(48 * 1024));
      let releaseRemainder: (() => void) | null = null;
      try {
        tracker.identify("user-456", { plan: "x".repeat(1500) });
        const identify = vi.mocked(fetch).mock.calls[0][1]!;
        expect(identify.keepalive).toBe(true);
        const identifyBytes = new TextEncoder().encode(identify.body as string).byteLength;
        releaseRemainder = reserveKeepalive("x".repeat(16 * 1024 - identifyBytes));
        expect(releaseRemainder).not.toBeNull();
        expect(reserveKeepalive("x")).toBeNull();

        tracker.setTraits({ plan: "pro" });
        expect(vi.mocked(fetch).mock.calls[1][1]?.keepalive).toBe(false);

        completeIdentify({} as Response);
        await Promise.resolve();
        await Promise.resolve();
        const releasedIdentify = reserveKeepalive("x".repeat(identifyBytes));
        expect(releasedIdentify).not.toBeNull();
        releasedIdentify?.();
      } finally {
        completeIdentify({} as Response);
        releaseHeatmap?.();
        releaseRemainder?.();
      }
    });

    it("should validate user ID", () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      tracker.identify("");
      expect(window.localStorage.setItem).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith("User ID must be a non-empty string");

      consoleSpy.mockRestore();
    });

    it("should clear user ID", () => {
      const updateReplayUserId = vi.fn();
      (
        tracker as unknown as { sessionRecorder: { updateUserId: (userId: string) => void; cleanup: () => void } }
      ).sessionRecorder = {
        updateUserId: updateReplayUserId,
        cleanup: vi.fn(),
      };

      tracker.identify("user-789");
      tracker.clearUserId();

      expect(window.localStorage.removeItem).toHaveBeenCalledWith(`${config.namespace}-user-id`);
      expect(tracker.getUserId()).toBeNull();
      expect(updateReplayUserId).toHaveBeenLastCalledWith("");
    });

    it("should handle localStorage errors", () => {
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.mocked(window.localStorage.setItem).mockImplementation(() => {
        throw new Error("Storage full");
      });

      tracker.identify("user-123");
      expect(consoleSpy).toHaveBeenCalledWith("Could not persist user ID to localStorage");

      consoleSpy.mockRestore();
    });
  });

  describe("feature flag refresh", () => {
    it("does not evaluate flags on page changes when the site has no flags", () => {
      tracker.onPageChange();

      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("evaluates flags on page changes when feature flags are enabled", () => {
      config.featureFlagsEnabled = true;
      tracker = new Tracker(config);

      tracker.onPageChange();

      expect(global.fetch).toHaveBeenCalledWith(
        "https://analytics.example.com/site/123/feature-flags/evaluate",
        expect.objectContaining({ method: "POST", signal: expect.any(AbortSignal) })
      );
    });
  });

  describe("deferred feature loading", () => {
    it("loads heatmaps independently without fetching recording", () => {
      const initialize = vi.spyOn(HeatmapCollector.prototype, "initialize").mockImplementation(() => {});
      tracker = new Tracker({ ...config, enableSessionReplay: false, enableHeatmaps: true });
      expect(initialize).toHaveBeenCalledOnce();
      expect(document.querySelector('script[src*="recording.js"]')).toBeNull();
    });

    it("keeps zero-rate replay out of the page until manually started", () => {
      const initialize = vi.spyOn(FeatureLoader.prototype, "initialize").mockResolvedValue();
      tracker = new Tracker({ ...config, enableSessionReplay: true, sessionReplaySampleRate: 0 });
      expect(initialize).not.toHaveBeenCalled();
      tracker.startSessionReplay();
      expect(initialize).toHaveBeenCalledOnce();
    });
  });

  describe("heatmap collector lifecycle", () => {
    let initialize: ReturnType<typeof vi.spyOn>;
    let updateUserId: ReturnType<typeof vi.spyOn>;
    let onPageChange: ReturnType<typeof vi.spyOn>;
    let cleanup: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      initialize = vi.spyOn(HeatmapCollector.prototype, "initialize").mockImplementation(() => {});
      updateUserId = vi.spyOn(HeatmapCollector.prototype, "updateUserId");
      onPageChange = vi.spyOn(HeatmapCollector.prototype, "onPageChange");
      cleanup = vi.spyOn(HeatmapCollector.prototype, "cleanup");
    });

    it("initializes heatmaps independently while replay is disabled", () => {
      expect(initialize).not.toHaveBeenCalled();

      tracker = new Tracker({ ...config, enableHeatmaps: true, heatmapSampleRate: 100 });

      expect(initialize).toHaveBeenCalledOnce();
      expect(tracker.isSessionReplayActive()).toBe(false);
    });

    it("forwards trimmed identity changes and clearing to the collector", () => {
      tracker = new Tracker({ ...config, enableHeatmaps: true, heatmapSampleRate: 100 });

      tracker.identify("  user-456  ");
      tracker.clearUserId();

      expect(updateUserId.mock.calls).toEqual([["user-456"], [""]]);
      expect(tracker.getUserId()).toBeNull();
    });

    it("does not forward an invalid identity to the collector", () => {
      tracker = new Tracker({ ...config, enableHeatmaps: true, heatmapSampleRate: 100 });
      vi.spyOn(console, "error").mockImplementation(() => {});

      tracker.identify("   ");

      expect(updateUserId).not.toHaveBeenCalled();
    });

    it("forwards page changes and cleanup to the collector", () => {
      tracker = new Tracker({ ...config, enableHeatmaps: true, heatmapSampleRate: 100 });

      tracker.onPageChange();
      tracker.cleanup();

      expect(onPageChange).toHaveBeenCalledOnce();
      expect(cleanup).toHaveBeenCalledOnce();
    });

    it("flushes impending navigation without disposing the heatmap collector", () => {
      const flush = vi.spyOn(HeatmapCollector.prototype, "flushForExit");
      tracker = new Tracker({ ...config, enableHeatmaps: true, heatmapSampleRate: 100 });
      tracker.flushForExit();
      expect(flush).toHaveBeenCalledOnce();
      expect(cleanup).not.toHaveBeenCalled();
    });
  });
});
