import type { ScriptConfig } from "./types.js";

export function pageCaptureSlimDOMOptions(config: ScriptConfig) {
  return (
    config.sessionReplaySlimDOMOptions ?? {
      script: false,
      comment: true,
      headFavicon: true,
      headWhitespace: true,
      headMetaDescKeywords: true,
      headMetaSocial: true,
      headMetaRobots: true,
      headMetaHttpEquiv: true,
      headMetaAuthorship: true,
      headMetaVerification: true,
    }
  );
}

export function pageCapturePrivacyOptions(config: ScriptConfig) {
  return {
    blockClass: config.sessionReplayBlockClass ?? "rr-block",
    blockSelector: config.sessionReplayBlockSelector ?? null,
    maskTextClass: config.sessionReplayMaskTextClass ?? "rr-mask",
    maskTextSelector: config.sessionReplayMaskTextSelectors?.length
      ? config.sessionReplayMaskTextSelectors.join(", ")
      : null,
    maskAllInputs: config.sessionReplayMaskAllInputs ?? true,
    maskInputOptions: config.sessionReplayMaskInputOptions ?? { password: true, email: true },
  };
}
