import type { HeatmapSnapshotContext } from "@rybbit/shared";
import type { reserveKeepalive } from "./keepalive.js";
import type { ScriptConfig } from "./types.js";

/** Optional capabilities shared by independent features in this tracker instance. */
export interface PageCaptureBridge {
  context?: () => HeatmapSnapshotContext | null;
  capture?: () => Promise<boolean>;
}

export interface FeatureRuntime {
  capture: PageCaptureBridge;
  reserveKeepalive: typeof reserveKeepalive;
  pageAlreadyClicked: boolean;
}

export interface TrackerFeature {
  initialize(): void | Promise<void>;
  updateUserId(userId: string): void;
  onPageChange(): void;
  flushForExit(): void;
  cleanup(): void;
  startRecording?(): void;
  stopRecording?(): void;
  isActive?(): boolean;
}

export type FeatureName = "heatmaps" | "recording";
export type FeatureModule = { create(config: ScriptConfig, userId: string, runtime: FeatureRuntime): TrackerFeature };

declare global {
  interface Window {
    rybbitModules?: Partial<Record<FeatureName, FeatureModule>>;
  }
}
