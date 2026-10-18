import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionRecorder } from "./sessionRecorder.js";
import { PageCapture } from "./pageCapture.js";
import type { PageCaptureBridge } from "./featureTypes.js";
import type { ScriptConfig } from "./types.js";

const config: ScriptConfig = {
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
  enableWebVitals: false,
  trackErrors: false,
  enableSessionReplay: true,
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

describe("SessionRecorder identity", () => {
  let emit: (event: unknown) => void;
  let recorder: SessionRecorder;
  let sendBatch: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    window.rrweb = {
      record: vi.fn(options => {
        emit = options.emit;
        return vi.fn();
      }),
    };

    sendBatch = vi.fn().mockResolvedValue(undefined);
    recorder = new SessionRecorder(config, "employee-alice", sendBatch);
    await recorder.initialize();
  });

  afterEach(() => {
    recorder.cleanup();
    delete window.rrweb;
  });

  it("flushes buffered events before changing the identified user", async () => {
    emit({ type: 2, data: { user: "employee-alice" }, timestamp: 1_700_000_000_000 });

    recorder.updateUserId("employee-bob");

    await vi.waitFor(() => expect(sendBatch).toHaveBeenCalledTimes(1));
    expect(sendBatch.mock.calls[0][0]).toMatchObject({
      userId: "employee-alice",
      events: [{ data: { user: "employee-alice" } }],
    });

    emit({ type: 2, data: { user: "employee-bob" }, timestamp: 1_700_000_001_000 });
    recorder.stopRecording();

    await vi.waitFor(() => expect(sendBatch).toHaveBeenCalledTimes(2));
    expect(sendBatch.mock.calls[1][0]).toMatchObject({
      userId: "employee-bob",
      events: [{ data: { user: "employee-bob" } }],
    });
  });
});

describe("SessionRecorder snapshot attribution", () => {
  let capture: PageCapture;
  let bridge: PageCaptureBridge;
  let originalLocation: PropertyDescriptor | undefined;
  let location: { href: string };
  let emit: (event: unknown) => void;
  let recorder: SessionRecorder;
  let sendBatch: ReturnType<typeof vi.fn>;
  let listeners: ReturnType<typeof vi.spyOn>;

  function click() {
    const listener = listeners.mock.calls.find(([name]) => name === "click")?.[1] as EventListener;
    listener({ isTrusted: true, button: 0 } as MouseEvent);
  }

  beforeEach(async () => {
    listeners = vi.spyOn(window, "addEventListener");
    originalLocation = Object.getOwnPropertyDescriptor(window, "location");
    location = { href: "https://example.com/start?token=secret" };
    Object.defineProperty(window, "location", { value: location, configurable: true });
    Object.defineProperties(window, {
      innerWidth: { value: 375, configurable: true },
      innerHeight: { value: 500, configurable: true },
    });
    Object.defineProperties(document.documentElement, {
      scrollWidth: { value: 400, configurable: true },
      scrollHeight: { value: 2000, configurable: true },
    });
    window.rrweb = {
      record: vi.fn(options => {
        emit = options.emit;
        return vi.fn();
      }),
    };
    sendBatch = vi.fn().mockResolvedValue(undefined);
    bridge = {};
    capture = new PageCapture(
      { ...config, skipPatterns: ["/private/**"], maskPatterns: ["/user/*/profile"] },
      false,
      bridge
    );
    capture.initialize();
    recorder = new SessionRecorder(
      { ...config, skipPatterns: ["/private/**"], maskPatterns: ["/user/*/profile"] },
      "",
      sendBatch,
      bridge
    );
    await recorder.initialize();
  });

  afterEach(() => {
    recorder.cleanup();
    capture.cleanup();
    if (originalLocation) Object.defineProperty(window, "location", originalLocation);
    delete window.rrweb;
    document.querySelectorAll('script[src$="/replay.js"]').forEach(script => script.remove());
    vi.restoreAllMocks();
  });

  it("preserves each snapshot's actual page and viewport when a batch spans SPA routes", async () => {
    emit({ type: 2, data: { node: {} }, timestamp: 1 });
    location.href = "https://example.com/next";
    Object.defineProperties(window, {
      innerWidth: { value: 768, configurable: true },
      innerHeight: { value: 600, configurable: true },
    });
    Object.defineProperty(document.documentElement, "scrollHeight", { value: 3000, configurable: true });
    emit({ type: 2, data: { node: {} }, timestamp: 2 });
    emit({ type: 3, data: { source: 0 }, timestamp: 3 });
    recorder.stopRecording();
    const batch = sendBatch.mock.calls[0][0];
    expect(batch.events.map((event: { snapshotContext?: unknown }) => event.snapshotContext)).toEqual([
      {
        hostname: "example.com",
        pathname: "/start",
        viewportWidth: 375,
        viewportHeight: 500,
        documentWidth: 400,
        documentHeight: 2000,
      },
      {
        hostname: "example.com",
        pathname: "/next",
        viewportWidth: 768,
        viewportHeight: 600,
        documentWidth: 768,
        documentHeight: 3000,
      },
      undefined,
    ]);
    expect(batch.metadata).toMatchObject({ viewportWidth: 768, viewportHeight: 600 });
  });

  it("applies masked and skipped routes while keeping query values out of snapshot attribution", () => {
    location.href = "https://example.com/user/123/profile?token=secret";
    emit({ type: 2, data: { node: {} }, timestamp: 1 });
    location.href = "https://example.com/private/account";
    emit({ type: 2, data: { node: {} }, timestamp: 2 });
    location.href = "https://example.com/base#!/public?password=secret";
    emit({ type: 2, data: { node: {} }, timestamp: 3 });
    recorder.stopRecording();
    const contexts = sendBatch.mock.calls[0][0].events.map(
      (event: { snapshotContext?: unknown }) => event.snapshotContext
    );
    expect(contexts).toMatchObject([{ pathname: "/user/*/profile" }, undefined, { pathname: "/public" }]);
    expect(JSON.stringify(contexts)).not.toMatch(/123|secret|password|token/);
  });

  it("keeps recording clicked DOM for replay without offering it as a heatmap background", () => {
    emit({ type: 2, data: { node: { id: 1 } }, timestamp: 1 });
    click();
    emit({ type: 2, data: { node: { id: 2 } }, timestamp: 2 });
    recorder.updateUserId("new-user");
    location.href = "https://example.com/start?changed=true";
    recorder.onPageChange();
    emit({ type: 2, data: { node: { id: 3 } }, timestamp: 3 });
    location.href = "https://example.com/next";
    recorder.onPageChange();
    emit({ type: 2, data: { node: { id: 4 } }, timestamp: 4 });
    recorder.stopRecording();
    const events = sendBatch.mock.calls.flatMap(([batch]) => batch.events);
    expect(events.map(event => event.data)).toEqual([
      { node: { id: 1 }, heatmapEligible: true },
      { node: { id: 2 }, heatmapEligible: false },
      { node: { id: 3 }, heatmapEligible: false },
      { node: { id: 4 }, heatmapEligible: true },
    ]);
    expect(events.map(event => event.snapshotContext?.pathname)).toEqual(["/start", undefined, undefined, "/next"]);
  });

  it("inherits clicks observed before the recorder was created", async () => {
    recorder.cleanup();
    capture.cleanup();
    capture = new PageCapture(config, true, bridge);
    capture.initialize();
    recorder = new SessionRecorder(config, "", sendBatch, bridge);
    await recorder.initialize();
    emit({ type: 2, data: { node: {} }, timestamp: 1 });
    recorder.stopRecording();
    capture.cleanup();
    expect(sendBatch.mock.calls[0][0].events[0]).toMatchObject({ data: { heatmapEligible: false } });
    expect(sendBatch.mock.calls[0][0].events[0]).not.toHaveProperty("snapshotContext");
  });

  it("leaves invalid viewport geometry unindexed", () => {
    Object.defineProperty(window, "innerWidth", { value: 100_000, configurable: true });
    emit({ type: 2, data: { node: {} }, timestamp: 1 });
    recorder.stopRecording();
    expect(sendBatch.mock.calls[0][0].events[0]).not.toHaveProperty("snapshotContext");
  });
});

describe("SessionRecorder size cap", () => {
  let emit: (event: unknown) => void;
  let stopRrweb: ReturnType<typeof vi.fn>;
  let recorder: SessionRecorder;
  let sendBatch: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    stopRrweb = vi.fn();
    window.rrweb = {
      record: vi.fn(options => {
        emit = options.emit;
        return stopRrweb;
      }),
    };

    sendBatch = vi.fn().mockResolvedValue({ success: true, stopRecording: true });
    recorder = new SessionRecorder(config, "visitor", sendBatch);
    await recorder.initialize();
  });

  afterEach(() => {
    recorder.cleanup();
    delete window.rrweb;
  });

  it("stops recording for the page when the server reports the cap", async () => {
    emit({ type: 2, data: {}, timestamp: 1_700_000_000_000 });
    recorder.onPageChange();

    await vi.waitFor(() => expect(recorder.isActive()).toBe(false));
    expect(stopRrweb).toHaveBeenCalledOnce();

    // Neither a later restart nor cleanup sends anything more.
    recorder.startRecording();
    expect(recorder.isActive()).toBe(false);
    recorder.cleanup();
    expect(sendBatch).toHaveBeenCalledOnce();
  });
});

describe("SessionRecorder shared page capture", () => {
  let recorder: SessionRecorder;
  let capture: PageCapture;
  let bridge: PageCaptureBridge;
  let emit: (event: unknown) => void;
  let sendBatch: ReturnType<typeof vi.fn>;
  let takeFullSnapshot: ReturnType<typeof vi.fn>;
  const node = {
    type: 0,
    id: 1,
    childNodes: [
      { type: 2, id: 2, tagName: "button", attributes: { onclick: "handler" }, childNodes: [] },
      { type: 2, id: 3, tagName: "script", attributes: {}, childNodes: [] },
    ],
  };

  beforeEach(async () => {
    Object.defineProperties(window, {
      innerWidth: { value: 375, configurable: true },
      innerHeight: { value: 500, configurable: true },
    });
    Object.defineProperties(document.documentElement, {
      scrollWidth: { value: 375, configurable: true },
      scrollHeight: { value: 2000, configurable: true },
    });
    takeFullSnapshot = vi.fn(() => emit({ type: 2, timestamp: Date.now(), data: { node } }));
    window.rrweb = {
      record: Object.assign(
        vi.fn(options => {
          emit = options.emit;
          return vi.fn();
        }),
        { takeFullSnapshot }
      ),
    };
    bridge = {};
    capture = new PageCapture(config, false, bridge);
    capture.initialize();
    sendBatch = vi.fn().mockResolvedValue(undefined);
    recorder = new SessionRecorder(config, "visitor", sendBatch, bridge);
    await recorder.initialize();
  });

  afterEach(() => {
    recorder.cleanup();
    capture.cleanup();
    delete window.rrweb;
    delete window.rybbitPageCapture;
  });

  it("uses the public snapshot API and leaves the complete replay event untouched", async () => {
    const captured = await capture.capture(() => true);
    expect(takeFullSnapshot).toHaveBeenCalledOnce();
    expect(captured?.source).toBe("replay");
    expect(captured).not.toHaveProperty("node");
    expect(sendBatch).toHaveBeenCalledOnce();
    expect(recorder.isActive()).toBe(true);
    expect(document.querySelector('script[src*="page-capture.js"]')).toBeNull();

    recorder.onPageChange();
    expect(sendBatch.mock.calls[0][0].events[0].data.node).toBe(node);
    expect(node.childNodes[0].attributes.onclick).toBe("handler");
    expect(node.childNodes[1].tagName).toBe("script");
  });

  it.each([
    "stopped",
    "capped",
    "unsampled",
    "disabled",
    "older recorder",
    "capture failure",
    "missing snapshot",
    "upload failure",
    "not recorded",
  ])("keeps standalone capture available with %s recording", async reason => {
    if (reason === "stopped") recorder.stopRecording();
    else if (reason === "capped") {
      sendBatch.mockResolvedValue({ stopRecording: true });
      emit({ type: 3, data: {}, timestamp: Date.now() });
      recorder.onPageChange();
      await vi.waitFor(() => expect(recorder.isActive()).toBe(false));
    } else if (reason === "unsampled" || reason === "disabled") {
      recorder.cleanup();
      recorder = new SessionRecorder(
        { ...config, enableSessionReplay: reason !== "disabled", sessionReplaySampleRate: 0 },
        "visitor",
        sendBatch,
        bridge
      );
      if (reason !== "unsampled") await recorder.initialize();
    } else if (reason === "older recorder") delete window.rrweb!.record.takeFullSnapshot;
    else if (reason === "capture failure") {
      takeFullSnapshot.mockImplementation(() => {
        throw new Error("Snapshot failed");
      });
    } else if (reason === "upload failure") sendBatch.mockRejectedValue(new Error("Upload failed"));
    else if (reason === "not recorded") sendBatch.mockResolvedValue({ recorded: false });
    else takeFullSnapshot.mockImplementation(() => undefined);

    const fallback = vi.fn(() => ({ type: 0, id: 1, childNodes: [] }));
    window.rybbitPageCapture = { capture: fallback };
    expect(await capture.capture(() => true)).toMatchObject({ source: "standalone", node: { type: 0 } });
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("waits for the checkpoint upload even when its event fills the recording batch", async () => {
    recorder.cleanup();
    recorder = new SessionRecorder({ ...config, sessionReplayBatchSize: 1 }, "visitor", sendBatch, bridge);
    await recorder.initialize();
    let rejectUpload!: (error: Error) => void;
    sendBatch.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectUpload = reject;
        })
    );
    const fallback = vi.fn(() => ({ type: 0, id: 1, childNodes: [] }));
    window.rybbitPageCapture = { capture: fallback };
    const capturing = capture.capture(() => true);
    expect(sendBatch).toHaveBeenCalledOnce();
    expect(fallback).not.toHaveBeenCalled();
    rejectUpload(new Error("offline"));
    expect(await capturing).toMatchObject({ source: "standalone" });
    expect(fallback).toHaveBeenCalledOnce();
    sendBatch.mockResolvedValue(undefined);
  });

  it("can resume supplying captures after a manual stop without restarting the shared guard", async () => {
    recorder.stopRecording();
    expect(capture.canCapture()).toBe(true);
    recorder.startRecording();
    expect((await capture.capture(() => true))?.source).toBe("replay");
    expect(takeFullSnapshot).toHaveBeenCalledOnce();
  });
});
