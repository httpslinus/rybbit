import type { FeatureName, FeatureRuntime, TrackerFeature } from "./featureTypes.js";
import type { ScriptConfig } from "./types.js";
import { getTrackedPathname } from "./url.js";

const downloads = new Map<string, Promise<void>>();

export function sampleRecording(rate: number | undefined): boolean {
  if (rate === undefined || rate >= 100) return true;
  if (rate <= 0) return false;
  try {
    const key = "rybbit-replay-sampled";
    const stored = sessionStorage.getItem(key);
    if (stored !== null) return stored === "1";
    const result = Math.random() * 100 < rate;
    sessionStorage.setItem(key, result ? "1" : "0");
    return result;
  } catch {
    return Math.random() * 100 < rate;
  }
}

/** Feature implementations, buffers and transports stay out of the core bundle. */
export class FeatureLoader {
  private instance?: TrackerFeature;
  private loading?: Promise<void>;
  private disposed = false;
  private wanted = true;
  private pageKey: string;

  constructor(
    private name: FeatureName,
    private config: ScriptConfig,
    private userId: string,
    private runtime: FeatureRuntime
  ) {
    this.pageKey = this.currentPageKey();
    if (name === "heatmaps") window.addEventListener("click", this.onClick, { capture: true, passive: true });
  }

  private currentPageKey(): string {
    const url = new URL(window.location.href);
    return `${url.hostname}\0${getTrackedPathname(url, this.config.trackUrlFragments).split("?")[0]}`;
  }

  private onClick = (event: MouseEvent): void => {
    this.onPageChange();
    if (event.isTrusted && event.button === 0) this.runtime.pageAlreadyClicked = true;
  };

  initialize(): Promise<void> {
    if (!this.loading)
      this.loading = this.load().catch(error => {
        this.loading = undefined;
        throw error;
      });
    return this.loading;
  }

  private async load(): Promise<void> {
    try {
      if (!window.rybbitModules?.[this.name]) {
        const url = `${this.config.analyticsHost}/${this.name}.js`;
        let download = downloads.get(url);
        if (!download) {
          download = new Promise<void>((resolve, reject) => {
            const script = document.createElement("script");
            const timer = window.setTimeout(() => {
              script.remove();
              reject(new Error(`Timed out loading ${this.name}`));
            }, 10_000);
            const finish = (error?: Error) => {
              window.clearTimeout(timer);
              if (error) {
                script.remove();
                reject(error);
              } else resolve();
            };
            script.src = url;
            script.async = true;
            script.onload = () => finish();
            script.onerror = () => finish(new Error(`Failed to load ${this.name}`));
            document.head.appendChild(script);
          }).finally(() => downloads.delete(url));
          downloads.set(url, download);
        }
        await download;
      }
      if (this.disposed) return;
      const module = window.rybbitModules?.[this.name];
      if (!module) throw new Error(`${this.name} did not initialize`);
      this.onPageChange();
      this.instance = module.create(this.config, this.userId, this.runtime);
      if (this.wanted) await this.instance.initialize();
    } catch (error) {
      this.instance?.cleanup();
      this.instance = undefined;
      throw error;
    } finally {
      if (this.instance || this.disposed) window.removeEventListener("click", this.onClick, true);
    }
  }

  updateUserId(userId: string): void {
    this.userId = userId;
    this.instance?.updateUserId(userId);
  }

  onPageChange(): void {
    const key = this.currentPageKey();
    if (key !== this.pageKey) {
      this.pageKey = key;
      if (this.name === "heatmaps") this.runtime.pageAlreadyClicked = false;
    }
    this.instance?.onPageChange();
  }

  startRecording(): void {
    if (this.disposed) return;
    this.wanted = true;
    if (this.instance) this.instance.startRecording?.();
    else void this.initialize().catch(error => console.error(error));
  }

  stopRecording(): void {
    this.wanted = false;
    this.instance?.stopRecording?.();
  }
  isActive(): boolean {
    return this.instance?.isActive?.() ?? false;
  }
  flushForExit(): void {
    this.instance?.flushForExit();
  }
  cleanup(): void {
    this.disposed = true;
    window.removeEventListener("click", this.onClick, true);
    this.instance?.cleanup();
  }
}
