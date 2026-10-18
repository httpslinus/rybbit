import type { record } from "@rrweb/record";
import { ScriptConfig, SessionReplayEvent, SessionReplayBatch, SessionReplayBatchResult } from "./types.js";
import { pageCapturePrivacyOptions, pageCaptureSlimDOMOptions } from "./pageCapturePrivacy.js";
import type { PageCaptureBridge } from "./featureTypes.js";

declare global {
  interface Window {
    rrweb?: {
      record: ((
        options: NonNullable<Parameters<typeof record>[0]> & { emit: (event: any) => void }
      ) => ReturnType<typeof record>) & { takeFullSnapshot?: typeof record.takeFullSnapshot };
    };
  }
}

export class SessionRecorder {
  private config: ScriptConfig;
  private isRecording: boolean = false;
  private disposed = false;
  private pendingCapture?: { node?: unknown };
  // Set once the server reports the session is over its size cap; recording
  // stays off for the rest of this page.
  private capped: boolean = false;
  private stopRecordingFn?: () => void;
  private userId: string;
  private eventBuffer: SessionReplayEvent[] = [];
  private batchTimer?: number;
  private sendBatch: (batch: SessionReplayBatch, exit?: boolean) => Promise<SessionReplayBatchResult | void>;

  constructor(
    config: ScriptConfig,
    userId: string,
    sendBatch: (batch: SessionReplayBatch, exit?: boolean) => Promise<SessionReplayBatchResult | void>,
    private bridge: PageCaptureBridge = {}
  ) {
    this.config = config;
    this.userId = userId;
    this.sendBatch = sendBatch;
  }

  async initialize(): Promise<void> {
    if (this.disposed || !this.config.enableSessionReplay) {
      return;
    }

    this.startRecording();
  }

  public startRecording(): void {
    if (this.disposed || this.capped || this.isRecording || !window.rrweb || !this.config.enableSessionReplay) {
      return;
    }

    try {
      // Default sampling configuration (can be overridden via config)
      const defaultSampling = {
        // Aggressive sampling to reduce data volume
        mousemove: false, // Don't record mouse moves at all
        mouseInteraction: {
          MouseUp: false,
          MouseDown: false,
          Click: true, // Only record clicks
          ContextMenu: false,
          DblClick: true,
          Focus: true,
          Blur: true,
          TouchStart: false,
          TouchEnd: false,
        },
        scroll: 500, // Sample scroll events every 500ms
        input: "last", // Only record the final input value
        media: 800, // Sample media interactions less frequently
      };

      const recordingOptions: any = {
        emit: (event: any) => {
          const snapshotContext = event.type === 2 ? this.bridge.context?.() : null;
          const heatmapEligible = Boolean(snapshotContext);
          if (this.pendingCapture && heatmapEligible && snapshotContext) this.pendingCapture.node = event.data?.node;
          this.addEvent({
            type: event.type,
            // Keep replay recording intact, but prevent ineligible DOM from
            // being reused through the legacy heatmap fallback as well.
            data: event.type === 2 ? { ...event.data, heatmapEligible } : event.data,
            timestamp: event.timestamp || Date.now(),
            ...(snapshotContext ? { snapshotContext } : {}),
          });
        },
        recordCanvas: false, // Always disabled to save disk space
        checkoutEveryNms: 60000, // Checkout every 60 seconds
        checkoutEveryNth: 500, // Checkout every 500 events
        // Use config values with fallbacks to defaults
        ...pageCapturePrivacyOptions(this.config),
        ignoreClass: this.config.sessionReplayIgnoreClass ?? "rr-ignore",
        ignoreSelector: this.config.sessionReplayIgnoreSelector ?? null,
        collectFonts: this.config.sessionReplayCollectFonts ?? true,
        sampling: this.config.sessionReplaySampling ?? defaultSampling,
        slimDOMOptions: pageCaptureSlimDOMOptions(this.config),
      };

      this.stopRecordingFn = window.rrweb.record(recordingOptions);
      if (!this.stopRecordingFn) return;

      this.isRecording = true;
      this.bridge.capture = this.capturePage;
      this.setupBatchTimer();
    } catch (error) {
      // Recording failed silently
    }
  }

  public stopRecording(): void {
    if (!this.isRecording) {
      return;
    }

    if (this.stopRecordingFn) {
      this.stopRecordingFn();
    }

    this.isRecording = false;
    if (this.bridge.capture === this.capturePage) delete this.bridge.capture;
    this.clearBatchTimer();

    // Send any remaining events
    if (this.eventBuffer.length > 0) {
      this.flushEvents();
    }
  }

  public isActive(): boolean {
    return this.isRecording;
  }

  private capturePage = async (): Promise<boolean> => {
    const takeFullSnapshot = window.rrweb?.record.takeFullSnapshot;
    if (!this.isRecording || !takeFullSnapshot || !this.bridge.context?.()) return false;
    const pending: { node?: unknown } = {};
    this.pendingCapture = pending;
    try {
      // Keep a fresh checkpoint in the recording stream. The server indexes its
      // existing DOM rather than accepting a second upload through heatmaps.
      takeFullSnapshot();
      if (!pending.node) return false;
    } finally {
      this.pendingCapture = undefined;
    }
    return this.flushEvents();
  };

  private addEvent(event: SessionReplayEvent): void {
    this.eventBuffer.push(event);

    // Auto-flush if buffer is full
    if (!this.pendingCapture && this.eventBuffer.length >= this.config.sessionReplayBatchSize) {
      this.flushEvents();
    }
  }

  private setupBatchTimer(): void {
    this.clearBatchTimer();
    this.batchTimer = window.setInterval(() => {
      if (this.eventBuffer.length > 0) {
        this.flushEvents();
      }
    }, this.config.sessionReplayBatchInterval);
  }

  private clearBatchTimer(): void {
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
      this.batchTimer = undefined;
    }
  }

  private async flushEvents(exit = false): Promise<boolean> {
    if (this.eventBuffer.length === 0) {
      return true;
    }

    const events = [...this.eventBuffer];
    this.eventBuffer = [];

    const batch: SessionReplayBatch = {
      userId: this.userId,
      events,
      metadata: {
        pageUrl: window.location.href,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        language: navigator.language,
      },
    };

    try {
      const result = await this.sendBatch(batch, exit);
      if (result?.stopRecording) {
        this.stopForSizeCap();
        return false;
      }
      return result?.recorded !== false;
    } catch (error) {
      // Re-queue the events for retry since this batch failed
      if (!this.capped) this.eventBuffer.unshift(...events);
      return false;
    }
  }

  // Unlike stopRecording, drops what's buffered: the server refuses it anyway.
  private stopForSizeCap(): void {
    this.capped = true;
    if (this.stopRecordingFn) {
      this.stopRecordingFn();
      this.stopRecordingFn = undefined;
    }
    this.isRecording = false;
    if (this.bridge.capture === this.capturePage) delete this.bridge.capture;
    this.clearBatchTimer();
    this.eventBuffer = [];
  }

  // Update user ID when it changes
  public updateUserId(userId: string): void {
    if (userId === this.userId) {
      return;
    }

    // Keep events captured under the previous identity in their original batch.
    // flushEvents snapshots this.userId before its first await, so the identity
    // can be changed immediately after starting the send.
    if (this.eventBuffer.length > 0) {
      void this.flushEvents();
    }

    this.userId = userId;
  }

  // Handle page navigation for SPAs
  public onPageChange(): void {
    if (this.isRecording) {
      // Flush current events before page change
      this.flushEvents();
    }
  }

  public flushForExit(): void {
    if (!this.eventBuffer.length) return;
    const bytes = new TextEncoder().encode(JSON.stringify(this.eventBuffer)).byteLength;
    void this.flushEvents(bytes <= 48 * 1024);
  }

  // Cleanup on page unload
  public cleanup(): void {
    this.disposed = true;
    this.stopRecording();
  }
}
