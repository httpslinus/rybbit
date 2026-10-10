import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureHeatmapSnapshot } from "./heatmapSnapshot.js";
import type { ScriptConfig } from "./types.js";

const config = {
  sessionReplayMaskTextSelectors: [],
} as unknown as ScriptConfig;

describe("static heatmap snapshot privacy", () => {
  beforeEach(() => {
    document.head.innerHTML =
      '<style>.button { color: red; }</style><meta http-equiv="refresh" content="0;url=https://example.com">';
    document.body.innerHTML = `
      <div class="rr-block">blocked-secret</div>
      <div class="rr-mask">masked-secret</div>
      <input type="text" value="text-secret">
      <input type="password" value="password-secret">
      <input type="email" value="email-secret@example.com">
      <script>window.secret = "script-secret";</script>
      <!-- comment-secret -->
      <button class="button">Public button</button>
    `;
  });

  afterEach(() => {
    document.head.innerHTML = "";
    document.body.innerHTML = "";
    delete window.rybbitHeatmapSnapshot;
  });

  it("uses replay defaults to block private DOM, mask text and all inputs, and retain styles", () => {
    const node = captureHeatmapSnapshot(config);
    const serialized = JSON.stringify(node);
    expect(node?.type).toBe(0);
    expect(serialized).not.toMatch(
      /blocked-secret|masked-secret|text-secret|password-secret|email-secret|script-secret|comment-secret/
    );
    expect(serialized).toContain("Public button");
    expect(serialized).toContain("color: red");
    expect(serialized).not.toMatch(/http-equiv|\"tagName\":\"script\"/);
  });

  it("honors configured replay selectors and input policy without starting a recorder", () => {
    document.body.innerHTML = `
      <div class="custom-block">custom-block-secret</div>
      <div class="custom-mask">custom-mask-secret</div>
      <div data-sensitive>selector-secret</div>
      <input type="text" value="permitted-text">
      <input type="email" value="email-secret@example.com">
    `;
    const node = captureHeatmapSnapshot({
      ...config,
      sessionReplayBlockSelector: ".custom-block",
      sessionReplayMaskTextClass: "custom-mask",
      sessionReplayMaskTextSelectors: ["[data-sensitive]"],
      sessionReplayMaskAllInputs: false,
      sessionReplayMaskInputOptions: { password: true, email: true },
    });
    const serialized = JSON.stringify(node);
    expect(serialized).not.toMatch(/custom-block-secret|custom-mask-secret|selector-secret|email-secret/);
    expect(serialized).toContain("permitted-text");
    expect(document.querySelector('script[src*="replay.js"]')).toBeNull();
  });
});
