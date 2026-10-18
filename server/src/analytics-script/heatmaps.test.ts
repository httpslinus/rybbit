import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HeatmapBatch, HeatmapEvent, HeatmapSnapshotRequest } from "@rybbit/shared";
import { HEATMAP_MAX_SNAPSHOT_BYTES, heatmapWidthBucket } from "@rybbit/shared/dist/heatmaps.js";
import { HeatmapRecorder, HEATMAP_MAX_BATCH_BYTES } from "./heatmaps.js";
import type { ScriptConfig } from "./types.js";

let siteCounter = 0;
const last = <T>(array: T[]): T | undefined => array[array.length - 1];

describe("HeatmapRecorder", () => {
  let config: ScriptConfig;
  let location: { href: string };
  let originalLocation: PropertyDescriptor | undefined;
  let listeners: ReturnType<typeof vi.spyOn>;
  let windowListeners: ReturnType<typeof vi.spyOn>;
  let recorders: HeatmapRecorder[];
  let resize: () => void;
  let disconnect: ReturnType<typeof vi.fn>;

  function size(width = 375, height = 500, documentHeight = 2000, documentWidth = width) {
    Object.defineProperties(window, {
      innerWidth: { value: width, configurable: true },
      innerHeight: { value: height, configurable: true },
    });
    Object.defineProperties(document.documentElement, {
      scrollWidth: { value: documentWidth, configurable: true },
      scrollHeight: { value: documentHeight, configurable: true },
    });
  }

  function scroll(x: number, y: number) {
    Object.defineProperties(window, {
      scrollX: { value: x, configurable: true },
      scrollY: { value: y, configurable: true },
    });
    window.dispatchEvent(new Event("scroll"));
  }

  function start(overrides: Partial<ScriptConfig> = {}, userId = "") {
    const recorder = new HeatmapRecorder({ ...config, ...overrides }, userId);
    recorders.push(recorder);
    recorder.initialize();
    return recorder;
  }

  function click(overrides: Partial<MouseEvent> = {}) {
    const handler = last(listeners.mock.calls.filter(([name]) => name === "click"))?.[1] as EventListener | undefined;
    const event = {
      isTrusted: true,
      button: 0,
      clientX: 100,
      clientY: 120,
      target: document.body,
      ...overrides,
    } as MouseEvent;
    for (const [, listener] of windowListeners.mock.calls.filter(([name]) => name === "click")) {
      (listener as EventListener)(event);
    }
    handler?.(event);
  }

  function batches(): HeatmapBatch[] {
    return vi
      .mocked(fetch)
      .mock.calls.filter(([url]) => String(url).includes("/heatmaps/record/"))
      .map(([, init]) => JSON.parse(init!.body as string));
  }

  function snapshotUploads() {
    return vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes("/heatmaps/snapshot/"));
  }

  function nominateSnapshot(onUpload: () => Promise<Response> = async () => ({ ok: true }) as Response) {
    let nominated = false;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url).includes("/heatmaps/snapshot/")) return onUpload();
      const event = (JSON.parse(init!.body as string) as HeatmapBatch).events[0];
      const snapshotRequest: HeatmapSnapshotRequest = {
        key: "snapshot-key",
        token: "lease-token",
        pageVisitId: event.pageVisitId,
        hostname: event.hostname,
        pathname: event.pathname,
        bucket: heatmapWidthBucket(event.viewportWidth),
      };
      const body = nominated ? {} : { snapshotRequest };
      nominated = true;
      return { ok: true, status: 200, json: async () => body } as Response;
    });
  }

  function events(): HeatmapEvent[] {
    return batches().flatMap(batch => batch.events);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-10T12:00:00Z"));
    originalLocation = Object.getOwnPropertyDescriptor(window, "location");
    location = { href: "https://example.com/page?password=secret" };
    Object.defineProperty(window, "location", { value: location, configurable: true });
    document.body.innerHTML = '<button data-private="secret">Private text</button><input value="private input">';
    delete window.rybbitHeatmapSnapshot;
    document.querySelectorAll('script[src*="heatmap-snapshot.js"]').forEach(script => script.remove());
    listeners = vi.spyOn(document, "addEventListener");
    windowListeners = vi.spyOn(window, "addEventListener");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    recorders = [];
    disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resize = callback;
        }
        observe = vi.fn();
        disconnect = disconnect;
      }
    );
    sessionStorage.clear();
    size();
    scroll(0, 0);
    config = {
      namespace: "rybbit",
      analyticsHost: "https://analytics.example.com",
      siteId: `heatmap-test-${siteCounter++}`,
      visitorId: "feature-flag-only-id",
      debounceDuration: 500,
      autoTrackPageview: true,
      autoTrackSpa: true,
      trackQuerystring: true,
      trackUrlFragments: false,
      trackOutbound: true,
      enableWebVitals: false,
      trackErrors: false,
      enableSessionReplay: false,
      enableHeatmaps: true,
      heatmapSampleRate: 100,
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
  });

  afterEach(async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200 } as Response);
    for (const recorder of recorders) recorder.cleanup();
    for (const recorder of recorders) await recorder.flush();
    delete window.rybbitHeatmapSnapshot;
    document.querySelectorAll('script[src*="heatmap-snapshot.js"]').forEach(script => script.remove());
    if (originalLocation) Object.defineProperty(window, "location", originalLocation);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("records trusted primary clicks in a passive capture listener with scroll-adjusted viewport geometry", async () => {
    size(375, 500, 2000, 1000);
    const recorder = start();
    scroll(200, 750);
    click({ clientX: 12.5, clientY: 20.25 });
    await recorder.flush();
    expect(listeners).toHaveBeenCalledWith("click", expect.any(Function), { capture: true, passive: true });
    expect(events().find(event => event.type === "click")).toMatchObject({
      type: "click",
      hostname: "example.com",
      pathname: "/page",
      viewportWidth: 375,
      viewportHeight: 500,
      documentWidth: 1000,
      documentHeight: 2000,
      clientX: 12.5,
      clientY: 20.25,
      pageX: 212.5,
      pageY: 770.25,
      timestamp: Date.now(),
      pageVisitId: expect.any(String),
    });
    expect(vi.mocked(fetch).mock.calls[0][1]).toMatchObject({ credentials: "omit", keepalive: false });
    const body = JSON.stringify(batches());
    for (const secret of [
      "secret",
      "private input",
      "Private text",
      "querystring",
      "selector",
      "feature-flag-only-id",
    ]) {
      expect(body).not.toContain(secret);
    }
    expect(batches()[0]).not.toHaveProperty("anonymousId");
  });

  it("ignores synthetic and secondary clicks and records mobile/tablet primary taps once without touch listeners", async () => {
    const recorder = start();
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    click({ isTrusted: false });
    click({ button: 1 });
    click({ button: 2 });
    click({ clientX: 200, clientY: 300 });
    size(768, 600);
    click({ clientX: 500, clientY: 300 });
    await recorder.flush();
    expect(events().filter(event => event.type === "click")).toHaveLength(2);
    expect(listeners.mock.calls.some(([name]) => name === "touchstart" || name === "touchend")).toBe(false);
  });

  it.each([
    [-1, 0],
    [NaN, 0],
    [0, Infinity],
    [376, 0],
    [0, 501],
  ])("rejects invalid client coordinates %s/%s", async (clientX, clientY) => {
    const recorder = start();
    click({ clientX, clientY });
    await recorder.flush();
    expect(events().filter(event => event.type === "click")).toHaveLength(0);
  });

  it("includes initial/no-scroll reach on the fixed five-second flush", async () => {
    start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({ type: "scroll", maxDepth: 25, documentHeight: 2000 });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(events()).toHaveLength(1);
  });

  it("starts a short page at 100% and accepts long documents beyond UInt16", async () => {
    size(375, 500, 100);
    const recorder = start();
    await recorder.flush();
    expect(events()[0]).toMatchObject({ type: "scroll", maxDepth: 100, documentHeight: 500 });
    size(375, 500, 100_000);
    resize();
    await recorder.flush();
    expect(last(events())).toMatchObject({ type: "scroll", maxDepth: 0.5, documentHeight: 100_000 });
  });

  it("coalesces scroll maxima and keeps capture geometry through resize and dynamic page growth", async () => {
    const recorder = start();
    scroll(0, 250);
    scroll(0, 1000);
    scroll(0, 0);
    await vi.advanceTimersByTimeAsync(100);
    size(375, 500, 4000);
    resize();
    scroll(0, 2500);
    size(768, 600, 4000);
    window.dispatchEvent(new Event("resize"));
    await recorder.flush();
    expect(events().filter(event => event.type === "scroll")).toMatchObject([
      { viewportWidth: 375, documentHeight: 2000, maxDepth: 75 },
      { viewportWidth: 375, documentHeight: 4000, maxDepth: 75 },
      { viewportWidth: 768, documentHeight: 4000, maxDepth: 77.5 },
    ]);
  });

  it("uses bounded target bounds without inspecting ancestors", async () => {
    const recorder = start();
    const target = document.querySelector("button")!;
    const bounds = vi.spyOn(target, "getBoundingClientRect").mockReturnValue({ right: 420, bottom: 2300 } as DOMRect);
    click({ target });
    await recorder.flush();
    expect(bounds).toHaveBeenCalledOnce();
    expect(events().find(event => event.type === "click")).toMatchObject({ documentWidth: 420, documentHeight: 2300 });
    bounds.mockReturnValue({ right: Infinity, bottom: NaN } as DOMRect);
    click({ target });
    await recorder.flush();
    expect(events().filter(event => event.type === "click")).toHaveLength(2);
  });

  it("flushes the old route's trailing maximum before rapid SPA changes and ignores duplicate notifications", async () => {
    const recorder = start();
    click();
    scroll(0, 1500);
    location.href = "https://example.com/second";
    size(375, 500, 1000);
    recorder.onPageChange();
    const secondVisit = (recorder as unknown as { page: { pageVisitId: string } }).page.pageVisitId;
    recorder.onPageChange();
    expect((recorder as unknown as { page: { pageVisitId: string } }).page.pageVisitId).toBe(secondVisit);
    scroll(0, 0);
    click();
    location.href = "https://example.com/third";
    recorder.onPageChange();
    size(375, 500, 3000);
    document.body.appendChild(document.createElement("main"));
    await vi.advanceTimersByTimeAsync(150);
    await recorder.flush();
    expect(events().find(event => event.type === "scroll" && event.pathname === "/page")).toMatchObject({
      maxDepth: 100,
      documentHeight: 2000,
    });
    expect(
      events()
        .filter(event => event.type === "click")
        .map(event => event.pathname)
    ).toEqual(["/page", "/second"]);
    expect(new Set(events().map(event => event.pageVisitId)).size).toBe(3);
  });

  it("waits for a delayed SPA render and scroll reset before measuring the new route", async () => {
    const recorder = start();
    scroll(0, 1500);
    location.href = "https://example.com/async-route";
    recorder.onPageChange();
    // The old page remains mounted, including a spurious old-layout resize.
    resize();
    await vi.advanceTimersByTimeAsync(150);
    await recorder.flush();
    expect(events().filter(event => event.pathname === "/async-route")).toHaveLength(0);
    size(375, 500, 4000);
    document.body.appendChild(document.createElement("main"));
    resize();
    // A new layout alone is insufficient while it still has the old offset.
    await vi.advanceTimersByTimeAsync(150);
    await recorder.flush();
    expect(events().filter(event => event.pathname === "/async-route")).toHaveLength(0);
    scroll(0, 0);
    await vi.advanceTimersByTimeAsync(150);
    await recorder.flush();
    expect(events().filter(event => event.pathname === "/async-route")).toMatchObject([
      { type: "scroll", documentHeight: 4000, maxDepth: 12.5 },
    ]);
    expect(events().find(event => event.pathname === "/page" && event.type === "scroll")).toMatchObject({
      maxDepth: 100,
    });
  });

  it("guards rapid route generations and never seeds a new long page from old short content", async () => {
    size(375, 500, 100);
    const recorder = start();
    location.href = "https://example.com/intermediate";
    recorder.onPageChange();
    document.body.appendChild(document.createElement("aside"));
    await vi.advanceTimersByTimeAsync(50);
    location.href = "https://example.com/final";
    recorder.onPageChange();
    document.body.setAttribute("data-loading", "true");
    await vi.advanceTimersByTimeAsync(200);
    await recorder.flush();
    expect(events().map(event => event.pathname)).toEqual(["/page"]);
    size(375, 500, 4000);
    document.body.appendChild(document.createElement("main"));
    await vi.advanceTimersByTimeAsync(150);
    await recorder.flush();
    expect(events().filter(event => event.pathname === "/final")).toMatchObject([{ maxDepth: 12.5 }]);
    expect(events().some(event => event.pathname === "/intermediate")).toBe(false);
  });

  it("ignores an old short-page loading mutation while the new long route is still rendering", async () => {
    size(375, 500, 100);
    const recorder = start();
    location.href = "https://example.com/loading-route";
    recorder.onPageChange();
    document.body.setAttribute("data-loading", "true");
    await vi.advanceTimersByTimeAsync(200);
    await recorder.flush();
    expect(events().some(event => event.pathname === "/loading-route")).toBe(false);
    size(375, 500, 4000);
    document.body.appendChild(document.createElement("main"));
    await vi.advanceTimersByTimeAsync(150);
    await recorder.flush();
    expect(events().filter(event => event.pathname === "/loading-route")).toMatchObject([{ maxDepth: 12.5 }]);
  });

  it("allows trusted scroll intent to establish a route whose geometry is unchanged", async () => {
    const windowListeners = vi.spyOn(window, "addEventListener");
    const recorder = start();
    location.href = "https://example.com/same-layout";
    recorder.onPageChange();
    await vi.advanceTimersByTimeAsync(150);
    const wheel = windowListeners.mock.calls.find(([name]) => name === "wheel")![1] as EventListener;
    wheel({ type: "wheel", isTrusted: false } as unknown as Event);
    await recorder.flush();
    expect(events().some(event => event.pathname === "/same-layout")).toBe(false);
    wheel({ type: "wheel", isTrusted: true } as unknown as Event);
    scroll(0, 1000);
    await recorder.flush();
    expect(events().filter(event => event.pathname === "/same-layout")).toMatchObject([{ maxDepth: 75 }]);
  });

  it("retains an early trusted click as route evidence without measuring reach before settlement", async () => {
    const recorder = start();
    location.href = "https://example.com/early-click";
    recorder.onPageChange();
    await vi.advanceTimersByTimeAsync(20);
    scroll(0, 600);
    click();
    scroll(0, 0);
    await recorder.flush();
    expect(events().filter(event => event.pathname === "/early-click" && event.type === "scroll")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(79);
    await recorder.flush();
    expect(events().filter(event => event.pathname === "/early-click" && event.type === "scroll")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await recorder.flush();
    expect(events().filter(event => event.pathname === "/early-click" && event.type === "scroll")).toMatchObject([
      { maxDepth: expect.closeTo(55, 8) },
    ]);
  });

  it.each(["wheel", "touchmove", "keydown"])(
    "retains early trusted %s intent through delayed rendering and rapid route replacement",
    async type => {
      const windowListeners = vi.spyOn(window, "addEventListener");
      size(375, 500, 100);
      const recorder = start();
      const intent = windowListeners.mock.calls.find(([name]) => name === type)![1] as EventListener;
      location.href = "https://example.com/early-input";
      recorder.onPageChange();
      await vi.advanceTimersByTimeAsync(20);
      intent({ type, code: "PageDown", isTrusted: true } as unknown as Event);
      await vi.advanceTimersByTimeAsync(40);
      size(375, 500, 4000);
      document.body.appendChild(document.createElement("main"));
      scroll(0, 600);
      scroll(0, 0);
      await recorder.flush();
      expect(events().filter(event => event.pathname === "/early-input" && event.type === "scroll")).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(40);
      await recorder.flush();
      expect(events().filter(event => event.pathname === "/early-input" && event.type === "scroll")).toMatchObject([
        { documentHeight: 4000, maxDepth: expect.closeTo(27.5, 8) },
      ]);
      location.href = "https://example.com/abandoned-input";
      recorder.onPageChange();
      intent({ type, code: "PageDown", isTrusted: true } as unknown as Event);
      await vi.advanceTimersByTimeAsync(20);
      location.href = "https://example.com/replacement-input";
      recorder.onPageChange();
      await vi.advanceTimersByTimeAsync(200);
      await recorder.flush();
      expect(
        events().some(event => event.pathname === "/abandoned-input" || event.pathname === "/replacement-input")
      ).toBe(false);
    }
  );

  it("uses the ordinary mask, skip and fragment policy while dropping hash-router query values", async () => {
    const recorder = start({ skipPatterns: ["/private/**"], maskPatterns: ["/user/*/profile"] });
    location.href = "https://example.com/user/123/profile";
    recorder.onPageChange();
    click();
    location.href = "https://example.com/private/input";
    recorder.onPageChange();
    click();
    location.href = "https://example.com/base#/public?token=secret";
    recorder.onPageChange();
    click();
    await recorder.flush();
    expect(
      events()
        .filter(event => event.type === "click")
        .map(event => event.pathname)
    ).toEqual(["/user/*/profile", "/public"]);
    expect(JSON.stringify(batches())).not.toContain("secret");
    location.href = "https://example.com/base#anchor";
    recorder.onPageChange();
    size(375, 500, 4000);
    document.body.appendChild(document.createElement("main"));
    await vi.advanceTimersByTimeAsync(150);
    await recorder.flush();
    expect(last(events())?.pathname).toBe("/base");
  });

  it("captures route changes before clicks even when automatic SPA tracking is disabled", async () => {
    const recorder = start({ autoTrackSpa: false });
    location.href = "https://example.com/next";
    click();
    await recorder.flush();
    expect(events().find(event => event.type === "click")?.pathname).toBe("/next");
  });

  it("keeps the same visit for query-only and ignored fragment changes, including hash-router query values", async () => {
    const recorder = start();
    click();
    location.href = "https://example.com/page?password=another#ignored";
    recorder.onPageChange();
    click();
    await recorder.flush();
    const clicks = events().filter(event => event.type === "click");
    expect(clicks[0].pageVisitId).toBe(clicks[1].pageVisitId);
    location.href = "https://example.com/page#/hash?token=one";
    recorder.onPageChange();
    click();
    location.href = "https://example.com/page#/hash?token=two";
    recorder.onPageChange();
    click();
    await recorder.flush();
    const hashClicks = events().filter(event => event.type === "click" && event.pathname === "/hash");
    expect(hashClicks[0].pageVisitId).toBe(hashClicks[1].pageVisitId);
    expect(JSON.stringify(batches())).not.toContain("token");
  });

  it("captures dynamic document growth through the MutationObserver fallback", async () => {
    let mutation: () => void = () => {};
    const stop = vi.fn();
    vi.stubGlobal("ResizeObserver", undefined);
    vi.stubGlobal(
      "MutationObserver",
      class {
        constructor(callback: () => void) {
          mutation = callback;
        }
        observe = vi.fn();
        disconnect = stop;
      }
    );
    const recorder = start();
    size(375, 500, 5000);
    mutation();
    await vi.advanceTimersByTimeAsync(100);
    await recorder.flush();
    expect(events()).toMatchObject([
      { documentHeight: 2000, maxDepth: 25 },
      { documentHeight: 5000, maxDepth: 10 },
    ]);
    recorder.cleanup();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("rejects impossible viewport and document dimensions and overlong paths/identities", async () => {
    const recorder = start();
    size(100_000, 500);
    click();
    size(375, 500, 0x100000000);
    click();
    location.href = `https://example.com/${"x".repeat(2048)}`;
    recorder.onPageChange();
    click();
    location.href = "https://example.com/valid";
    recorder.onPageChange();
    recorder.updateUserId("x".repeat(257));
    click();
    await recorder.flush();
    expect(events().filter(event => event.type === "click")).toHaveLength(0);
  });

  it("retains the original identity, timestamp and batch ID on HTTP failure and retry", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 503 } as Response);
    const recorder = start({}, "first-user");
    click();
    await recorder.flush();
    const first = batches()[0];
    vi.setSystemTime(Date.now() + 10_000);
    recorder.updateUserId("second-user");
    click();
    await recorder.flush();
    expect(batches()[1]).toEqual(first);
    expect(last(batches())?.userId).toBe("second-user");
    expect(last(batches())?.events[0].pageVisitId).not.toBe(first.events[0].pageVisitId);
    recorder.updateUserId("");
    click();
    await recorder.flush();
    expect(last(batches())).not.toHaveProperty("userId");
  });

  it("honors busy Retry-After past the ten-minute lease without starving new batches", async () => {
    let busyId = "";
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      const batch = JSON.parse(init!.body as string) as HeatmapBatch;
      if (!busyId) busyId = batch.batchId;
      if (batch.batchId === busyId && Date.now() < new Date("2026-10-10T12:10:05Z").getTime()) {
        return { ok: false, status: 503, headers: new Headers({ "Retry-After": "60" }) } as Response;
      }
      return { ok: true, status: 200 } as Response;
    });
    const recorder = start();
    click();
    await recorder.flush();
    click({ clientX: 200 });
    await recorder.flush();
    expect(batches().filter(batch => batch.batchId === busyId)).toHaveLength(1);
    expect(batches().find(batch => batch.batchId !== busyId)?.events).toMatchObject([{ clientX: 200 }]);
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(batches().filter(batch => batch.batchId === busyId).length).toBeGreaterThan(3);
    expect((recorder as unknown as { chunks: unknown[] }).chunks).toHaveLength(0);
  });

  it("issues final interactions immediately while an ordinary upload is pending", async () => {
    let resolveNormal!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveNormal = resolve;
        })
    );
    const recorder = start();
    click();
    const normal = recorder.flush();
    const original = batches()[0];
    click({ clientX: 200 });
    window.dispatchEvent(new Event("pagehide"));
    expect(
      vi
        .mocked(fetch)
        .mock.calls.slice(1)
        .every(([, init]) => init?.keepalive)
    ).toBe(true);
    expect(batches()[1].events).toMatchObject([{ type: "click", clientX: 200 }]);
    expect(batches().some((batch, index) => index > 0 && batch.batchId === original.batchId)).toBe(true);
    resolveNormal({ ok: true, status: 200 } as Response);
    await normal;
    await recorder.flush();
    expect((recorder as unknown as { chunks: unknown[] }).chunks).toHaveLength(0);
  });

  it("bounds concurrent exit bodies and retains excess until BFCache restoration", async () => {
    location.href = `https://example.com/${"x".repeat(2000)}`;
    const resolves: ((response: Response) => void)[] = [];
    vi.mocked(fetch).mockImplementation(() => new Promise(resolve => resolves.push(resolve)));
    const recorder = start();
    for (let i = 0; i < 105; i++) click();
    const normal = recorder.flush();
    window.dispatchEvent(new Event("pagehide"));
    const exits = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.keepalive);
    const bytes = exits.reduce((sum, [, init]) => sum + new TextEncoder().encode(init!.body as string).byteLength, 0);
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThanOrEqual(HEATMAP_MAX_BATCH_BYTES);
    expect((recorder as unknown as { chunks: unknown[] }).chunks.length).toBeGreaterThan(0);
    for (const resolve of resolves) resolve({ ok: true, status: 200 } as Response);
    await normal;
    await Promise.resolve();
    vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200 } as Response);
    window.dispatchEvent(new Event("pageshow"));
    await recorder.flush();
    expect((recorder as unknown as { chunks: unknown[] }).chunks).toHaveLength(0);
  });

  it("suspends on freeze and restores capture without duplicating listeners", async () => {
    const recorder = start();
    click();
    document.dispatchEvent(new Event("freeze"));
    click({ clientX: 200 });
    document.dispatchEvent(new Event("resume"));
    click({ clientX: 300 });
    await recorder.flush();
    expect(
      events()
        .filter(event => event.type === "click")
        .map(event => event.clientX)
    ).toEqual([100, 300]);
    expect(listeners.mock.calls.filter(([name]) => name === "click")).toHaveLength(1);
  });

  it("splits by UTF-8 bytes below 48KiB and 100 events without losing clicks", async () => {
    location.href = `https://example.com/${"x".repeat(2000)}`;
    const recorder = start({}, "界".repeat(200));
    for (let i = 0; i < 105; i++) click();
    await recorder.flush();
    expect(events().filter(event => event.type === "click")).toHaveLength(105);
    expect(batches().length).toBeGreaterThan(2);
    expect(new Set(batches().map(batch => batch.batchId)).size).toBe(batches().length);
    for (const [, init] of vi.mocked(fetch).mock.calls) {
      expect(new TextEncoder().encode(init!.body as string).byteLength).toBeLessThanOrEqual(HEATMAP_MAX_BATCH_BYTES);
      expect(JSON.parse(init!.body as string).events.length).toBeLessThanOrEqual(100);
    }
  });

  it("bounds queued interactions and retains transient failures beyond three attempts until a fixed deadline", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("offline"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const recorder = start({ debug: true });
    for (let i = 0; i < 1500; i++) click();
    const internals = recorder as unknown as { events: HeatmapEvent[]; chunks: { eventCount: number }[] };
    expect(
      internals.events.length + internals.chunks.reduce((total, chunk) => total + chunk.eventCount, 0)
    ).toBeLessThanOrEqual(1000);
    await recorder.flush();
    const firstId = batches()[0].batchId;
    await vi.advanceTimersByTimeAsync(80_000);
    await recorder.flush();
    expect(batches().filter(batch => batch.batchId === firstId).length).toBeGreaterThan(3);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("Upload failed"), expect.any(Error));
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("Buffer full"), "");
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    const count = batches().filter(batch => batch.batchId === firstId).length;
    await recorder.flush();
    expect(batches().filter(batch => batch.batchId === firstId)).toHaveLength(count);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("Expired retry batch"), "");
  });

  it("flushes hidden/pagehide and cleanup removes all listeners, timers and observer", async () => {
    const removeDocument = vi.spyOn(document, "removeEventListener");
    const removeWindow = vi.spyOn(window, "removeEventListener");
    const recorder = start();
    click();
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await recorder.flush();
    click();
    window.dispatchEvent(new Event("pagehide"));
    await recorder.flush();
    window.dispatchEvent(new Event("pageshow"));
    click();
    recorder.cleanup();
    await recorder.flush();
    const count = vi.mocked(fetch).mock.calls.length;
    expect(events().filter(event => event.type === "click")).toHaveLength(3);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(removeDocument).toHaveBeenCalledWith("click", expect.any(Function), true);
    for (const name of ["resize", "scroll", "load", "pagehide", "pageshow"]) {
      expect(removeWindow).toHaveBeenCalledWith(name, expect.any(Function));
    }
    click();
    scroll(0, 1000);
    window.dispatchEvent(new Event("resize"));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(vi.mocked(fetch).mock.calls).toHaveLength(count);
    expect(recorder.isActive()).toBe(false);
  });

  it("does not initialize when disabled or sampled at zero, and always samples at 100", () => {
    expect(start({ enableHeatmaps: false }).isActive()).toBe(false);
    expect(start({ heatmapSampleRate: 0 }).isActive()).toBe(false);
    expect(start({ heatmapSampleRate: NaN }).isActive()).toBe(false);
    expect(start().isActive()).toBe(true);
    expect(document.querySelector('script[src*="replay.js"]')).toBeNull();
  });

  it("keeps 15% decisions through routes/reloads with a thirty-minute expiry independently from replay", () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0.1);
    sessionStorage.setItem("rybbit-replay-sampled", "0");
    const recorder = start({ heatmapSampleRate: 15 });
    expect(recorder.isActive()).toBe(true);
    location.href = "https://example.com/another";
    recorder.onPageChange();
    recorder.cleanup();
    random.mockReturnValue(0.9);
    expect(start({ heatmapSampleRate: 15 }).isActive()).toBe(true);
    vi.setSystemTime(Date.now() + 30 * 60_000);
    expect(start({ heatmapSampleRate: 15 }).isActive()).toBe(false);
  });

  it("isolates sample decisions and batch IDs by analytics host and site", async () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0.1);
    const first = start({ heatmapSampleRate: 15 });
    random.mockReturnValue(0.9);
    expect(start({ heatmapSampleRate: 15, analyticsHost: "https://other-analytics.example.com" }).isActive()).toBe(
      false
    );
    expect(start({ heatmapSampleRate: 15, siteId: "another-site" }).isActive()).toBe(false);
    await first.flush();
    const second = start({ siteId: "third-site" });
    await second.flush();
    const [firstBatch, secondBatch] = batches();
    expect(firstBatch.batchId.split("-")[0]).not.toBe(secondBatch.batchId.split("-")[0]);
    expect(firstBatch.batchId.length).toBeLessThanOrEqual(128);
  });

  it("keeps a stable memory fallback when sessionStorage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const random = vi.spyOn(Math, "random").mockReturnValue(0.1);
    const first = start({ heatmapSampleRate: 15 });
    expect(first.isActive()).toBe(true);
    first.cleanup();
    random.mockReturnValue(0.9);
    expect(start({ heatmapSampleRate: 15 }).isActive()).toBe(true);
  });

  it("uses canonical host/site keys so relative and absolute tracker hosts share only their own decision", () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0.1);
    expect(start({ analyticsHost: "https://ANALYTICS.EXAMPLE.COM:443/", heatmapSampleRate: 15 }).isActive()).toBe(true);
    random.mockReturnValue(0.9);
    expect(start({ analyticsHost: "https://analytics.example.com", heatmapSampleRate: 15 }).isActive()).toBe(true);
    random.mockReturnValue(0.1);
    expect(start({ analyticsHost: "/analytics", heatmapSampleRate: 15 }).isActive()).toBe(true);
    random.mockReturnValue(0.9);
    expect(start({ analyticsHost: "https://example.com/analytics/", heatmapSampleRate: 15 }).isActive()).toBe(true);
    expect(sessionStorage.length).toBe(2);
  });

  it("renews sample expiry on activity while background flushes do not prolong an inactive session", async () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0.1);
    const first = start({ heatmapSampleRate: 15 });
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    click();
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    first.cleanup();
    random.mockReturnValue(0.9);
    expect(start({ heatmapSampleRate: 15 }).isActive()).toBe(true);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(start({ heatmapSampleRate: 15 }).isActive()).toBe(false);
  });

  it("renews unsampled sessions on loads and interaction without collecting geometry", async () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0.9);
    expect(start({ heatmapSampleRate: 15 }).isActive()).toBe(false);
    random.mockReturnValue(0.1);
    vi.setSystemTime(Date.now() + 20 * 60_000);
    const reload = start({ heatmapSampleRate: 15 });
    expect(reload.isActive()).toBe(false);
    vi.setSystemTime(Date.now() + 20 * 60_000);
    click();
    scroll(0, 1000);
    vi.setSystemTime(Date.now() + 20 * 60_000);
    expect(start({ heatmapSampleRate: 15 }).isActive()).toBe(false);
    location.href = "https://example.com/new-page";
    reload.onPageChange();
    await reload.flush();
    expect(fetch).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
  });

  it.each([15, 100])(
    "coalesces sample persistence on hot scroll paths without skipping capture geometry at rate %s",
    async rate => {
      vi.spyOn(Math, "random").mockReturnValue(0.9);
      const storage = vi.spyOn(Storage.prototype, "setItem");
      const geometry = vi.fn(() => 2000);
      Object.defineProperty(document.documentElement, "scrollHeight", { configurable: true, get: geometry });
      start({ heatmapSampleRate: rate });
      storage.mockClear();
      geometry.mockClear();
      for (let i = 0; i < 200; i++) scroll(0, i * 5);
      expect(storage).not.toHaveBeenCalled();
      // One live root extent read per sampled scroll, plus the leading scan.
      expect(geometry).toHaveBeenCalledTimes(rate === 100 ? 201 : 0);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(storage).toHaveBeenCalledOnce();
    }
  );

  it("captures CSS-driven document growth even without an observer callback", async () => {
    const recorder = start();
    scroll(0, 500);
    size(375, 500, 4000);
    scroll(0, 2500);
    await recorder.flush();
    expect(events().filter(event => event.type === "scroll")).toMatchObject([
      { documentHeight: 2000, maxDepth: 50 },
      { documentHeight: 4000, maxDepth: 75 },
    ]);
  });

  it("reduces full geometry scans to leading and trailing measurements in a 200-scroll burst while preserving its maximum", async () => {
    const fullScan = vi.fn(() => 0);
    Object.defineProperty(document.documentElement, "clientHeight", { configurable: true, get: fullScan });
    const recorder = start();
    fullScan.mockClear();
    for (let i = 0; i < 199; i++) scroll(0, i * 5);
    scroll(0, 0);
    expect(fullScan).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(100);
    expect(fullScan).toHaveBeenCalledTimes(2);
    await recorder.flush();
    expect(events().filter(event => event.type === "scroll")).toMatchObject([{ documentHeight: 2000, maxDepth: 74.5 }]);
  });

  it("keeps CSS-growth capture-time geometry when an SPA replaces the DOM before the trailing scan", async () => {
    const recorder = start();
    scroll(0, 500);
    size(375, 500, 4000);
    scroll(0, 2500);
    // Both old-route snapshots must already be complete before the new DOM.
    location.href = "https://example.com/next-after-growth";
    size(375, 500, 1000);
    recorder.onPageChange();
    scroll(0, 0);
    await vi.advanceTimersByTimeAsync(150);
    await recorder.flush();
    expect(events().filter(event => event.pathname === "/page" && event.type === "scroll")).toMatchObject([
      { documentHeight: 2000, maxDepth: 50 },
      { documentHeight: 4000, maxDepth: 75 },
    ]);
    expect(events().filter(event => event.pathname === "/next-after-growth")).toMatchObject([
      { documentHeight: 1000, maxDepth: 50 },
    ]);
  });

  it("captures only a nominated background with capture-time geometry and leaves ordinary batches compact", async () => {
    const capture = vi.fn(() => ({ type: 0, id: 1, childNodes: [] }));
    window.rybbitHeatmapSnapshot = { capture };
    nominateSnapshot();
    const recorder = start({ sessionReplayMaskTextSelectors: [".private"] });
    await recorder.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(capture).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({ sessionReplayMaskTextSelectors: [".private"] }));
    expect(snapshotUploads()).toHaveLength(1);
    const [url, init] = snapshotUploads()[0];
    expect(url).toBe(`https://analytics.example.com/heatmaps/snapshot/${config.siteId}`);
    expect(init).toMatchObject({ credentials: "omit", keepalive: false });
    expect(JSON.parse(init!.body as string)).toMatchObject({
      key: "snapshot-key",
      token: "lease-token",
      pageVisitId: batches()[0].events[0].pageVisitId,
      hostname: "example.com",
      pathname: "/page",
      viewportWidth: 375,
      viewportHeight: 500,
      documentWidth: 375,
      documentHeight: 2000,
      node: { type: 0, id: 1, childNodes: [] },
    });
    expect(batches()[0]).not.toHaveProperty("node");
    expect(document.querySelector('script[src*="heatmap-snapshot.js"]')).toBeNull();
  });

  it.each(["click", "invalid click", "identity", "query", "resume"])(
    "keeps clicked pages ineligible for backgrounds after %s while recording interactions",
    async change => {
      const capture = vi.fn(() => ({ type: 0, id: 1, childNodes: [] }));
      window.rybbitHeatmapSnapshot = { capture };
      nominateSnapshot();
      const recorder = start();
      click(change === "invalid click" ? { clientX: -1 } : {});
      if (change === "identity") recorder.updateUserId("new-user");
      else if (change === "query") {
        location.href = "https://example.com/page?query=changed";
        recorder.onPageChange();
      } else if (change === "resume") {
        window.dispatchEvent(new Event("pagehide"));
        window.dispatchEvent(new Event("pageshow"));
      }
      await recorder.flush();
      await vi.advanceTimersByTimeAsync(0);
      expect(capture).not.toHaveBeenCalled();
      expect(snapshotUploads()).toHaveLength(0);
      expect(document.querySelector('script[src*="heatmap-snapshot.js"]')).toBeNull();
      expect(events().some(event => event.type === "scroll")).toBe(true);
      expect(events().filter(event => event.type === "click")).toHaveLength(change === "invalid click" ? 0 : 1);
    }
  );

  it("allows backgrounds after synthetic clicks and scrolling", async () => {
    const capture = vi.fn(() => ({ type: 0, id: 1, childNodes: [] }));
    window.rybbitHeatmapSnapshot = { capture };
    nominateSnapshot();
    const recorder = start();
    click({ isTrusted: false });
    scroll(0, 500);
    await recorder.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(capture).toHaveBeenCalledOnce();
    expect(snapshotUploads()).toHaveLength(1);
  });

  it("allows a fresh SPA page to supply a background after the previous page was clicked", async () => {
    const capture = vi.fn(() => ({ type: 0, id: 1, childNodes: [] }));
    window.rybbitHeatmapSnapshot = { capture };
    const recorder = start();
    click();
    await recorder.flush();
    location.href = "https://example.com/next";
    size(375, 500, 3000);
    recorder.onPageChange();
    await vi.advanceTimersByTimeAsync(100);
    nominateSnapshot();
    await recorder.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(capture).toHaveBeenCalledOnce();
    expect(JSON.parse(snapshotUploads()[0][1]!.body as string)).toMatchObject({ pathname: "/next" });
  });

  it.each(["click", "navigation", "skip", "return", "resize", "identity", "cleanup", "pagehide"])(
    "discards nominated backgrounds after %s during lazy bundle loading",
    async race => {
      nominateSnapshot();
      const recorder = start({ skipPatterns: ["/private/**"] });
      await recorder.flush();
      await vi.advanceTimersByTimeAsync(0);
      const script = document.querySelector<HTMLScriptElement>('script[src*="heatmap-snapshot.js"]');
      expect(script?.src).toBe("https://analytics.example.com/heatmap-snapshot.js");
      if (race === "navigation" || race === "skip" || race === "return") {
        location.href = race === "skip" ? "https://example.com/private/account" : "https://example.com/next";
        recorder.onPageChange();
        if (race === "return") {
          location.href = "https://example.com/page";
          recorder.onPageChange();
        }
      } else if (race === "click") click();
      else if (race === "resize") size(1024);
      else if (race === "identity") recorder.updateUserId("new-user");
      else if (race === "cleanup") recorder.cleanup();
      else window.dispatchEvent(new Event("pagehide"));
      const capture = vi.fn(() => ({ type: 0, id: 1, childNodes: [] }));
      window.rybbitHeatmapSnapshot = { capture };
      script!.dispatchEvent(new Event("load"));
      await vi.advanceTimersByTimeAsync(0);
      expect(capture).not.toHaveBeenCalled();
      expect(snapshotUploads()).toHaveLength(0);
    }
  );

  it("does not hold or retry successful interaction batches when snapshot upload fails", async () => {
    window.rybbitHeatmapSnapshot = { capture: () => ({ type: 0, id: 1, childNodes: [] }) };
    let rejectUpload!: (error: Error) => void;
    nominateSnapshot(
      () =>
        new Promise((_resolve, reject) => {
          rejectUpload = reject;
        })
    );
    const recorder = start();
    await recorder.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshotUploads()).toHaveLength(1);
    expect((recorder as unknown as { chunks: unknown[] }).chunks).toHaveLength(0);
    click();
    await recorder.flush();
    expect(batches()).toHaveLength(2);
    rejectUpload(new Error("offline"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(snapshotUploads()).toHaveLength(1);
    expect(batches()).toHaveLength(2);
  });

  it("rejects oversized static backgrounds without changing interaction delivery", async () => {
    window.rybbitHeatmapSnapshot = {
      capture: () => ({
        type: 0,
        id: 1,
        childNodes: [{ type: 3, id: 2, textContent: "x".repeat(HEATMAP_MAX_SNAPSHOT_BYTES) }],
      }),
    };
    nominateSnapshot();
    const recorder = start();
    await recorder.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshotUploads()).toHaveLength(0);
    expect(batches()).toHaveLength(1);
    expect((recorder as unknown as { chunks: unknown[] }).chunks).toHaveLength(0);
  });

  it("ignores nominations received through unload keepalive responses", async () => {
    window.rybbitHeatmapSnapshot = { capture: vi.fn(() => ({ type: 0, id: 1, childNodes: [] })) };
    nominateSnapshot();
    start();
    window.dispatchEvent(new Event("pagehide"));
    await vi.advanceTimersByTimeAsync(0);
    expect(window.rybbitHeatmapSnapshot.capture).not.toHaveBeenCalled();
    expect(snapshotUploads()).toHaveLength(0);
  });

  it.each(["navigation", "click"])(
    "does not load a capture bundle after %s while a nomination response is still parsing",
    async race => {
      let resolveBody!: (body: unknown) => void;
      let request: HeatmapSnapshotRequest;
      vi.mocked(fetch).mockImplementationOnce(async (_url, init) => {
        const event = (JSON.parse(init!.body as string) as HeatmapBatch).events[0];
        request = {
          key: "snapshot-key",
          token: "lease-token",
          pageVisitId: event.pageVisitId,
          hostname: event.hostname,
          pathname: event.pathname,
          bucket: heatmapWidthBucket(event.viewportWidth),
        };
        return {
          ok: true,
          status: 200,
          json: () =>
            new Promise(resolve => {
              resolveBody = resolve;
            }),
        } as Response;
      });
      const recorder = start();
      await recorder.flush();
      if (race === "click") click();
      else {
        location.href = "https://example.com/next";
        recorder.onPageChange();
      }
      resolveBody({ snapshotRequest: request! });
      await vi.advanceTimersByTimeAsync(0);
      expect(document.querySelector('script[src*="heatmap-snapshot.js"]')).toBeNull();
      expect(snapshotUploads()).toHaveLength(0);
    }
  );

  it("does not retry interactions or reload the bundle when its capture script fails", async () => {
    nominateSnapshot();
    const recorder = start();
    await recorder.flush();
    await vi.advanceTimersByTimeAsync(0);
    const script = document.querySelector<HTMLScriptElement>('script[src*="heatmap-snapshot.js"]');
    script!.dispatchEvent(new Event("error"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(document.querySelector('script[src*="heatmap-snapshot.js"]')).toBeNull();
    expect(snapshotUploads()).toHaveLength(0);
    expect(batches()).toHaveLength(1);
  });

  it("honors a snapshot grant only once even if a later successful batch repeats it", async () => {
    const capture = vi.fn(() => ({ type: 0, id: 1, childNodes: [] }));
    window.rybbitHeatmapSnapshot = { capture };
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url).includes("/heatmaps/snapshot/")) return { ok: true } as Response;
      const event = (JSON.parse(init!.body as string) as HeatmapBatch).events[0];
      return {
        ok: true,
        status: 200,
        json: async () => ({
          snapshotRequest: {
            key: "snapshot-key",
            token: "lease-token",
            pageVisitId: event.pageVisitId,
            hostname: event.hostname,
            pathname: event.pathname,
            bucket: heatmapWidthBucket(event.viewportWidth),
          },
        }),
      } as Response;
    });
    const recorder = start();
    await recorder.flush();
    await vi.advanceTimersByTimeAsync(0);
    scroll(0, 500);
    await recorder.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(batches()).toHaveLength(2);
    expect(capture).toHaveBeenCalledOnce();
    expect(snapshotUploads()).toHaveLength(1);
  });
});
