import type { HeatmapSnapshotContext, HeatmapSnapshotNode } from "@rybbit/shared";
import { sanitizeHeatmapSnapshot } from "@rybbit/shared/dist/heatmapSnapshot.js";
import { capturePageContext, PageCaptureGuard } from "./pageCaptureContext.js";
import type { ScriptConfig } from "./types.js";
import type { PageCaptureBridge } from "./featureTypes.js";

type StandaloneCapture = { capture: (config: ScriptConfig) => HeatmapSnapshotNode | null };
export type CapturedPage = { context: HeatmapSnapshotContext } & (
  | { source: "replay" }
  | { source: "standalone"; node: HeatmapSnapshotNode }
);

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
    // The server also serves this asset under the legacy heatmap-snapshot URL.
    script.src = `${analyticsHost}/page-capture.js`;
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
  private contextProvider = () => (this.canCapture() ? capturePageContext(this.config) : null);

  constructor(
    private readonly config: ScriptConfig,
    pageAlreadyClicked = false,
    private readonly bridge: PageCaptureBridge = {}
  ) {
    this.guard = new PageCaptureGuard(config, pageAlreadyClicked);
  }

  initialize(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.guard.initialize();
    this.bridge.context = this.contextProvider;
  }

  canCapture(): boolean {
    return this.initialized && this.guard.canCapture();
  }

  onPageChange(): void {
    this.guard.onPageChange();
  }

  async capture(isCurrent: () => boolean): Promise<CapturedPage | null> {
    const eligible = () => this.canCapture() && isCurrent();
    if (!eligible()) return null;
    if (this.bridge.capture) {
      try {
        const context = capturePageContext(this.config);
        const recorded = await this.bridge.capture();
        if (context && recorded && eligible()) return { context, source: "replay" };
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
    return node && eligible() ? { context, source: "standalone", node: sanitizeHeatmapSnapshot(node) } : null;
  }

  cleanup(): void {
    this.initialized = false;
    if (this.bridge.context === this.contextProvider) delete this.bridge.context;
    this.guard.cleanup();
  }
}
