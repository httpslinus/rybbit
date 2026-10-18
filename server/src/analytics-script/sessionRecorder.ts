import type { record } from "@rrweb/record";
import { ScriptConfig, SessionReplayEvent, SessionReplayBatch, SessionReplayBatchResult } from "./types.js";
import { pageCapturePrivacyOptions, pageCaptureSlimDOMOptions } from "./pageCapturePrivacy.js";
import { capturePageContext } from "./pageCaptureContext.js";
import { PageCapture } from "./pageCapture.js";

const SAMPLE_STORAGE_KEY = "rybbit-replay-sampled";

/**
 * Determines if this session should have replay enabled based on sample rate.
 * Uses sessionStorage to persist the decision for the entire browser session.
 */
function shouldSampleSession(sampleRate: number): boolean {
  // 100% = always record, 0% = never record
  if (sampleRate >= 100) return true;
  if (sampleRate <= 0) return false;

  // Check if we already made a decision for this session
  try {
    const existingDecision = sessionStorage.getItem(SAMPLE_STORAGE_KEY);
    if (existingDecision !== null) {
      return existingDecision === "1";
    }

    // Make new sampling decision
    const sampled = Math.random() * 100 < sampleRate;
    sessionStorage.setItem(SAMPLE_STORAGE_KEY, sampled ? "1" : "0");

    return sampled;
  } catch {
    // sessionStorage not available, default to sampling
    return Math.random() * 100 < sampleRate;
  }
}

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
  private readonly pageCapture: PageCapture;
  private readonly ownsPageCapture: boolean;
  private unregisterCapture?: () => void;
  private pendingCapture?: { node?: unknown };
  // Set once the server reports the session is over its size cap; recording
  // stays off for the rest of this page.
  private capped: boolean = false;
  private stopRecordingFn?: () => void;
  private userId: string;
  private eventBuffer: SessionReplayEvent[] = [];
  private batchTimer?: number;
  private sendBatch: (batch: SessionReplayBatch) => Promise<SessionReplayBatchResult | void>;

  constructor(
    config: ScriptConfig,
    userId: string,
    sendBatch: (batch: SessionReplayBatch) => Promise<SessionReplayBatchResult | void>,
    pageCapture?: PageCapture
  ) {
    this.config = config;
    this.pageCapture = pageCapture ?? new PageCapture(config);
    this.ownsPageCapture = !pageCapture;
    this.userId = userId;
    this.sendBatch = sendBatch;
  }

  async initialize(): Promise<void> {
    if (this.disposed || !this.config.enableSessionReplay) {
      return;
    }

    // Check sample rate if specified
    const sampleRate = this.config.sessionReplaySampleRate;
    if (sampleRate !== undefined && !shouldSampleSession(sampleRate)) {
      return;
    }

    this.pageCapture.initialize();

    // Load rrweb if not already loaded
    if (!window.rrweb) {
      await this.loadRrweb();
    }

    if (!this.disposed && window.rrweb) {
      this.startRecording();
    }
  }

  private async loadRrweb(): Promise<void> {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      // Load from same origin to avoid CDN blocking
      script.src = `${this.config.analyticsHost}/replay.js`;
      script.async = false;
      script.onload = () => {
        resolve();
      };
      script.onerror = () => reject(new Error("Failed to load rrweb"));
      document.head.appendChild(script);
    });
  }

  public startRecording(): void {
    if (this.disposed || this.capped || this.isRecording || !window.rrweb || !this.config.enableSessionReplay) {
      return;
    }

    this.pageCapture.initialize();
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
          const heatmapEligible = event.type === 2 && this.pageCapture.canCapture();
          const snapshotContext = heatmapEligible ? capturePageContext(this.config) : null;
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
      this.unregisterCapture = this.pageCapture.registerRecorder(() => this.capturePage());
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
    this.unregisterCapture?.();
    this.unregisterCapture = undefined;
    this.clearBatchTimer();

    // Send any remaining events
    if (this.eventBuffer.length > 0) {
      this.flushEvents();
    }
  }

  public isActive(): boolean {
    return this.isRecording;
  }

  private capturePage(): unknown {
    const takeFullSnapshot = window.rrweb?.record.takeFullSnapshot;
    if (!this.isRecording || !takeFullSnapshot || !this.pageCapture.canCapture()) return null;
    const pending: { node?: unknown } = {};
    this.pendingCapture = pending;
    try {
      // Use rrweb's public API so its mirror and mutation observers stay intact.
      // This fresh checkpoint also remains in the normal replay event stream.
      takeFullSnapshot();
      return pending.node ?? null;
    } finally {
      this.pendingCapture = undefined;
    }
  }

  private addEvent(event: SessionReplayEvent): void {
    this.eventBuffer.push(event);

    // Auto-flush if buffer is full
    if (this.eventBuffer.length >= this.config.sessionReplayBatchSize) {
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

  private async flushEvents(): Promise<void> {
    if (this.eventBuffer.length === 0) {
      return;
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
      const result = await this.sendBatch(batch);
      if (result?.stopRecording) {
        this.stopForSizeCap();
      }
    } catch (error) {
      // Re-queue the events for retry since this batch failed
      this.eventBuffer.unshift(...events);
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
    this.unregisterCapture?.();
    this.unregisterCapture = undefined;
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
    this.pageCapture.onPageChange();
    if (this.isRecording) {
      // Flush current events before page change
      this.flushEvents();
    }
  }

  // Cleanup on page unload
  public cleanup(): void {
    this.disposed = true;
    this.stopRecording();
    if (this.ownsPageCapture) this.pageCapture.cleanup();
  }
}
