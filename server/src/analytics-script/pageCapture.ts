import type { HeatmapSnapshotContext, HeatmapSnapshotNode } from "@rybbit/shared";
import { sanitizeHeatmapSnapshot } from "@rybbit/shared/dist/heatmapSnapshot.js";
import { capturePageContext, PageCaptureGuard } from "./pageCaptureContext.js";
import type { ScriptConfig } from "./types.js";

type StandaloneCapture = { capture: (config: ScriptConfig) => HeatmapSnapshotNode | null };
export type CapturedPage = { node: HeatmapSnapshotNode; context: HeatmapSnapshotContext };
type RecorderCapture = () => unknown;

declare global {
  interface Window {
    rybbitPageCapture?: StandaloneCapture;
    // Cached trackers still use the original global and asset URL.
    rybbitHeatmapSnapshot?: StandaloneCapture;
  }
}

let standaloneLoading: Promise<void> | undefined;
const standaloneCapture = () => window.rybbitPageCapture ?? window.rybbitHeatmapSnapshot;

function loadStandaloneCapture(analyticsHost: string): Promise<void> {
  if (standaloneCapture()) return Promise.resolve();
  if (standaloneLoading) return standaloneLoading;
  standaloneLoading = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    const timer = window.setTimeout(() => {
      script.remove();
      reject(new Error("Page capture timed out"));
    }, 10_000);
    // Preserve the public URL for existing proxies and cached tracker versions.
    script.src = `${analyticsHost}/heatmap-snapshot.js`;
    script.async = true;
    script.onload = () => {
      window.clearTimeout(timer);
      if (standaloneCapture()) resolve();
      else reject(new Error("Page capture did not initialize"));
    };
    script.onerror = () => {
      window.clearTimeout(timer);
      script.remove();
      reject(new Error("Failed to load page capture"));
    };
    document.head.appendChild(script);
  }).finally(() => {
    standaloneLoading = undefined;
  });
  return standaloneLoading;
}

/** One capture policy and provider selection for recording and heatmap backgrounds. */
export class PageCapture {
  private readonly guard: PageCaptureGuard;
  private initialized = false;
  private recorderCapture?: RecorderCapture;

  constructor(
    private readonly config: ScriptConfig,
    pageAlreadyClicked = false
  ) {
    this.guard = new PageCaptureGuard(config, pageAlreadyClicked);
  }

  initialize(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.guard.initialize();
  }

  canCapture(): boolean {
    return this.initialized && this.guard.canCapture();
  }

  onPageChange(): void {
    this.guard.onPageChange();
  }

  registerRecorder(capture: RecorderCapture): () => void {
    this.recorderCapture = capture;
    return () => {
      if (this.recorderCapture === capture) this.recorderCapture = undefined;
    };
  }

  async capture(isCurrent: () => boolean): Promise<CapturedPage | null> {
    const eligible = () => this.canCapture() && isCurrent();
    if (!eligible()) return null;
    if (this.recorderCapture) {
      try {
        const context = capturePageContext(this.config);
        const node = this.recorderCapture();
        // Sanitize a copy: the recorder must retain its original tree and IDs.
        if (context && node && eligible()) return { context, node: sanitizeHeatmapSnapshot(node) };
      } catch {
        // A failed or unavailable recorder must not prevent standalone capture.
      }
    }
    if (!eligible()) return null;
    await loadStandaloneCapture(this.config.analyticsHost);
    if (!eligible()) return null;
    const context = capturePageContext(this.config);
    if (!context) return null;
    const node = standaloneCapture()?.capture(this.config);
    return node && eligible() ? { context, node } : null;
  }

  cleanup(): void {
    this.initialized = false;
    this.recorderCapture = undefined;
    this.guard.cleanup();
  }
}
