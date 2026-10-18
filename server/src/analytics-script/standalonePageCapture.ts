import { sanitizeHeatmapSnapshot } from "@rybbit/shared/dist/heatmapSnapshot.js";
import type { HeatmapSnapshotNode } from "@rybbit/shared";
import { snapshot } from "rrweb-snapshot";
import { pageCapturePrivacyOptions, pageCaptureSlimDOMOptions } from "./pageCapturePrivacy.js";
import type { ScriptConfig } from "./types.js";

/** Capture page state when no active session recorder can provide it. */
export function capturePage(config: ScriptConfig): HeatmapSnapshotNode | null {
  const privacy = pageCapturePrivacyOptions(config);
  const slimDOM = pageCaptureSlimDOMOptions(config);
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

window.rybbitPageCapture = { capture: capturePage };
// Keep previously cached trackers compatible with the renamed capture API.
window.rybbitHeatmapSnapshot = window.rybbitPageCapture;
