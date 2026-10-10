import { sanitizeHeatmapSnapshot } from "@rybbit/shared/dist/heatmapSnapshot.js";
import type { HeatmapSnapshotNode } from "@rybbit/shared";
import { snapshot } from "rrweb-snapshot";
import { replayPrivacyOptions, replaySlimDOMOptions } from "./replayPrivacy.js";
import type { ScriptConfig } from "./types.js";

/** One static background, using the same privacy settings as session recording. */
export function captureHeatmapSnapshot(config: ScriptConfig): HeatmapSnapshotNode | null {
  const privacy = replayPrivacyOptions(config);
  const slimDOM = replaySlimDOMOptions(config);
  const node = snapshot(document, {
    blockClass: privacy.blockClass,
    blockSelector: privacy.blockSelector,
    maskTextClass: privacy.maskTextClass,
    maskTextSelector: privacy.maskTextSelector,
    maskAllInputs: privacy.maskAllInputs ? true : privacy.maskInputOptions,
    inlineStylesheet: true,
    inlineImages: false,
    recordCanvas: false,
    slimDOM:
      typeof slimDOM === "object"
        ? { ...slimDOM, script: true, headMetaHttpEquiv: true }
        : slimDOM === true
          ? true
          : { script: true, headMetaHttpEquiv: true },
  });
  return node ? sanitizeHeatmapSnapshot(node) : null;
}

window.rybbitHeatmapSnapshot = { capture: captureHeatmapSnapshot };
