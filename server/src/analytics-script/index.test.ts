import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HeatmapBatch } from "@rybbit/shared";
import { heatmapWidthBucket } from "@rybbit/shared/dist/heatmaps.js";
import type { ScriptConfig } from "./types.js";

const mocks = vi.hoisted(() => ({ parseScriptConfig: vi.fn() }));
vi.mock("./config.js", () => ({ parseScriptConfig: mocks.parseScriptConfig }));

describe("automatic navigation tracking", () => {
  let config: ScriptConfig;
  let location: { href: string };
  let originalLocation: PropertyDescriptor | undefined;
  let originalPushState: History["pushState"];
  let originalReplaceState: History["replaceState"];
  let windowListeners: ReturnType<typeof vi.spyOn>;
  let documentListeners: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.resetModules();
    const { HeatmapCollector } = await import("./heatmapCollector.js");
    window.rybbitModules = {
      heatmaps: { create: (config, userId, runtime) => new HeatmapCollector(config, userId, undefined, runtime) },
    };
    vi.useFakeTimers();
    originalLocation = Object.getOwnPropertyDescriptor(window, "location");
    location = { href: "https://example.com/checkout/" };
    Object.defineProperty(window, "location", { configurable: true, value: location });
    originalPushState = history.pushState;
    originalReplaceState = history.replaceState;
    const navigate = (_data: unknown, _unused: string, url?: string | URL | null) => {
      if (url != null) location.href = new URL(String(url), location.href).href;
    };
    history.pushState = navigate;
    history.replaceState = navigate;
    windowListeners = vi.spyOn(window, "addEventListener");
    documentListeners = vi.spyOn(document, "addEventListener");
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    localStorage.clear();
    sessionStorage.clear();
    delete window.__RYBBIT_OPTOUT__;
    document.body.innerHTML = '<script src="https://analytics.example.com/script.js"></script>';
    config = {
      namespace: "rybbit",
      analyticsHost: "https://analytics.example.com",
      siteId: "17571",
      visitorId: "visitor",
      debounceDuration: 500,
      autoTrackPageview: true,
      autoTrackSpa: true,
      trackQuerystring: true,
      trackUrlFragments: false,
      trackOutbound: false,
      enableWebVitals: false,
      trackErrors: false,
      enableSessionReplay: false,
      sessionReplayBatchSize: 250,
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
    mocks.parseScriptConfig.mockImplementation(async () => config);
  });

  afterEach(() => {
    window.dispatchEvent(new Event("pagehide"));
    for (const [type, listener, options] of windowListeners.mock.calls) {
      window.removeEventListener(type as string, listener as EventListener, options as boolean);
    }
    for (const [type, listener, options] of documentListeners.mock.calls) {
      document.removeEventListener(type as string, listener as EventListener, options as boolean);
    }
    history.pushState = originalPushState;
    history.replaceState = originalReplaceState;
    if (originalLocation) Object.defineProperty(window, "location", originalLocation);
    delete (window as Partial<Window>).rybbit;
    delete window.__RYBBIT_OPTOUT__;
    delete window.rybbitPageCapture;
    delete window.rybbitModules;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function start() {
    await import("./index.js");
    await vi.advanceTimersByTimeAsync(0);
  }

  function pageviews() {
    return vi
      .mocked(fetch)
      .mock.calls.filter(([url]) => url === `${config.analyticsHost}/track`)
      .map(([, init]) => JSON.parse(init!.body as string));
  }

  function heatmapBatches(): HeatmapBatch[] {
    return vi
      .mocked(fetch)
      .mock.calls.filter(([url]) => url === `${config.analyticsHost}/heatmaps/record/${config.siteId}`)
      .map(([, init]) => JSON.parse(init!.body as string));
  }

  async function flushHeatmaps() {
    window.dispatchEvent(new Event("beforeunload"));
    await vi.advanceTimersByTimeAsync(0);
  }

  async function changeHash(hash: string) {
    const url = new URL(location.href);
    url.hash = hash;
    location.href = url.href;
    window.dispatchEvent(new Event("hashchange"));
    if (config.trackUrlFragments || /^#!?\//.test(hash)) renderRoute(url.href);
    await vi.advanceTimersByTimeAsync(500);
  }

  function renderRoute(route: string) {
    document.body.setAttribute("data-route", route);
    Object.defineProperty(document.documentElement, "scrollHeight", {
      configurable: true,
      value: Math.max(window.innerHeight, document.documentElement.scrollHeight) + 500,
    });
  }

  it("ignores ordinary anchor changes and same-URL History API updates", async () => {
    await start();
    await changeHash("#shipping");
    history.replaceState({}, "", location.href);
    await vi.advanceTimersByTimeAsync(500);
    await changeHash("#payment");
    expect(pageviews().map(event => event.pathname)).toEqual(["/checkout/"]);
  });

  it("records checkout fragments separately when enabled, including returning to the base path", async () => {
    config.trackUrlFragments = true;
    location.href += "#shipping";
    await start();
    await changeHash("#payment");
    await changeHash("");
    expect(pageviews().map(event => event.pathname)).toEqual([
      "/checkout/#shipping",
      "/checkout/#payment",
      "/checkout/",
    ]);
  });

  it("tracks slash-prefixed and hashbang routes automatically", async () => {
    await start();
    await changeHash("#/shipping");
    await changeHash("#!/payment");
    expect(pageviews().map(event => event.pathname)).toEqual(["/checkout/", "/shipping", "/payment"]);
  });

  it("records one pageview when popstate and hashchange describe the same navigation", async () => {
    config.debounceDuration = 0;
    await start();
    location.href += "#/shipping";
    window.dispatchEvent(new Event("popstate"));
    window.dispatchEvent(new Event("hashchange"));
    expect(pageviews().map(event => event.pathname)).toEqual(["/checkout/", "/shipping"]);
  });

  it("honors URL parameter tracking when deciding whether navigation changed", async () => {
    config.trackQuerystring = false;
    await start();
    history.pushState({}, "", "/checkout/?utm_source=test");
    await vi.advanceTimersByTimeAsync(500);
    expect(pageviews()).toHaveLength(1);
    config.trackQuerystring = true;
    history.pushState({}, "", "/checkout/?utm_source=other");
    await vi.advanceTimersByTimeAsync(500);
    expect(pageviews().map(event => event.querystring)).toEqual(["", "?utm_source=other"]);
  });

  it("allows explicit pageviews of an unchanged URL", async () => {
    await start();
    window.rybbit.pageview();
    window.rybbit.pageview();
    await changeHash("#shipping");
    expect(pageviews()).toHaveLength(3);
  });

  it("ignores anchors with initial tracking disabled and still tracks subsequent routes", async () => {
    config.autoTrackPageview = false;
    await start();
    await changeHash("#shipping");
    expect(pageviews()).toHaveLength(0);
    history.pushState({}, "", "/order/success/");
    await vi.advanceTimersByTimeAsync(500);
    expect(pageviews().map(event => event.pathname)).toEqual(["/order/success/"]);
  });

  describe("heatmap integration", () => {
    beforeEach(() => {
      config.enableHeatmaps = true;
      config.heatmapSampleRate = 100;
    });

    it("flushes old pages through push, replace, pop and hash navigation without duplicate resets", async () => {
      config.debounceDuration = 0;
      await start();

      history.pushState({}, "", "/products/");
      renderRoute("/products/");
      await vi.advanceTimersByTimeAsync(150);
      history.replaceState({}, "", "/products/widget/");
      renderRoute("/products/widget/");
      await vi.advanceTimersByTimeAsync(150);
      location.href = "https://example.com/orders/";
      window.dispatchEvent(new Event("popstate"));
      window.dispatchEvent(new Event("hashchange"));
      renderRoute("/orders/");
      await vi.advanceTimersByTimeAsync(150);
      await changeHash("#/payment");
      await changeHash("#!/complete");
      await flushHeatmaps();

      const events = heatmapBatches().flatMap(batch => batch.events);
      expect(events.map(event => event.pathname)).toEqual([
        "/checkout/",
        "/products/",
        "/products/widget/",
        "/orders/",
        "/payment",
        "/complete",
      ]);
      expect(new Set(events.map(event => event.pageVisitId)).size).toBe(6);
      expect(events.every(event => event.type === "scroll")).toBe(true);
      expect(pageviews().map(event => event.pathname)).toEqual(events.map(event => event.pathname));
    });

    it("keeps the same heatmap page visit for ordinary anchors and unchanged History API URLs", async () => {
      await start();
      await flushHeatmaps();
      expect(heatmapBatches().flatMap(batch => batch.events)).toHaveLength(1);

      await changeHash("#shipping");
      history.replaceState({}, "", location.href);
      history.pushState({}, "", location.href);
      window.dispatchEvent(new Event("popstate"));
      window.dispatchEvent(new Event("hashchange"));
      await changeHash("#payment");
      await flushHeatmaps();

      expect(heatmapBatches().flatMap(batch => batch.events)).toHaveLength(1);
      expect(pageviews().map(event => event.pathname)).toEqual(["/checkout/"]);
    });

    it("collects heatmaps without initializing replay or loading replay.js", async () => {
      const { SessionRecorder } = await import("./sessionRecorder.js");
      const initializeReplay = vi.spyOn(SessionRecorder.prototype, "initialize");
      await start();
      await flushHeatmaps();

      expect(heatmapBatches().flatMap(batch => batch.events)).toHaveLength(1);
      expect(initializeReplay).not.toHaveBeenCalled();
      expect(window.rybbit.isSessionReplayActive()).toBe(false);
      expect(document.querySelector('script[src*="replay.js"]')).toBeNull();
      expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("replay"))).toBe(false);
    });

    it("remembers menu clicks made while tracking configuration is still loading", async () => {
      let resolveConfig!: (config: ScriptConfig) => void;
      mocks.parseScriptConfig.mockImplementationOnce(
        () =>
          new Promise(resolve => {
            resolveConfig = resolve;
          })
      );
      const capture = vi.fn(() => ({ type: 0, id: 1, childNodes: [] }));
      window.rybbitPageCapture = { capture };
      vi.mocked(fetch).mockImplementation(async (url, init) => {
        if (!String(url).includes("/heatmaps/record/")) return { ok: true } as Response;
        const event = (JSON.parse(init!.body as string) as HeatmapBatch).events[0];
        return {
          ok: true,
          json: async () => ({
            snapshotRequest: {
              key: "key",
              token: "token",
              pageVisitId: event.pageVisitId,
              hostname: event.hostname,
              pathname: event.pathname,
              bucket: heatmapWidthBucket(event.viewportWidth),
            },
          }),
        } as Response;
      });
      await import("./index.js");
      const earlyClick = windowListeners.mock.calls.find(([name]) => name === "click")![1] as EventListener;
      earlyClick({ isTrusted: true, button: 0 } as MouseEvent);
      resolveConfig(config);
      await vi.advanceTimersByTimeAsync(5000);
      expect(heatmapBatches()).toHaveLength(1);
      expect(capture).not.toHaveBeenCalled();
      expect(document.querySelector('script[src*="page-capture.js"]')).toBeNull();
    });

    it("keeps recording after canceled beforeunload and BFCache restoration without duplicate listeners", async () => {
      await start();
      const clickHandlers = () =>
        documentListeners.mock.calls.filter(
          ([name, , options]) =>
            name === "click" && typeof options === "object" && (options as AddEventListenerOptions)?.capture === true
        );
      const click = (clientX: number) => {
        const listener = clickHandlers()[0][1] as EventListener;
        listener({ isTrusted: true, button: 0, clientX, clientY: 10, target: document.body } as unknown as MouseEvent);
      };
      click(10);
      window.dispatchEvent(new Event("beforeunload", { cancelable: true }));
      await vi.advanceTimersByTimeAsync(0);
      click(20);
      window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
      await vi.advanceTimersByTimeAsync(0);
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
      click(30);
      await flushHeatmaps();
      expect(clickHandlers()).toHaveLength(1);
      expect(
        heatmapBatches()
          .flatMap(batch => batch.events)
          .filter(event => event.type === "click")
          .map(event => event.clientX)
      ).toEqual([10, 20, 30]);
    });

    it("starts the full script and collects heatmaps when both storage APIs are unavailable", async () => {
      const unavailable = () => {
        throw new DOMException("Storage is disabled", "SecurityError");
      };
      vi.spyOn(window, "localStorage", "get").mockImplementation(unavailable);
      vi.spyOn(window, "sessionStorage", "get").mockImplementation(unavailable);

      await start();
      await flushHeatmaps();

      expect(window.rybbit.getUserId()).toBeNull();
      expect(pageviews()).toHaveLength(1);
      expect(heatmapBatches().flatMap(batch => batch.events)).toHaveLength(1);
    });

    it.each(["localStorage", "window"])("honors %s opt-out before initializing heatmaps", async optOut => {
      if (optOut === "localStorage") localStorage.setItem("disable-rybbit", "1");
      else window.__RYBBIT_OPTOUT__ = true;
      const { HeatmapCollector } = await import("./heatmapCollector.js");
      const initializeHeatmaps = vi.spyOn(HeatmapCollector.prototype, "initialize");

      await start();
      window.rybbit.pageview();
      window.rybbit.identify("user");
      await flushHeatmaps();

      expect(initializeHeatmaps).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(window.rybbit.getUserId()).toBeNull();
    });
  });
});
