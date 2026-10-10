import { describe, expect, it } from "vitest";
import { capturedViewportCss } from "./snapshot";

describe("captured viewport styles", () => {
  const viewport = { viewportWidth: 1366, viewportHeight: 900 };

  it("freezes viewport lengths in declarations, calculations and custom properties", () => {
    const css =
      ":root{--hero:100dvh}.hero{height:var(--hero);width:50vw;margin:calc(2.5vmin - 1vh);top:-10svh;font-size:1vmax}";
    expect(capturedViewportCss(css, viewport)).toBe(
      ":root{--hero:900px}.hero{height:var(--hero);width:683px;margin:calc(22.5px - 9px);top:-90px;font-size:13.66px}"
    );
  });

  it("preserves URLs, string literals, selector identifiers and comments", () => {
    const css =
      ".size100vh{content:\"100vh\";background:url(https://example.com/100vh.png);--path:'20vw';height:100vh}/* 50vh */";
    expect(capturedViewportCss(css, viewport)).toBe(
      ".size100vh{content:\"100vh\";background:url(https://example.com/100vh.png);--path:'20vw';height:900px}/* 50vh */"
    );
    expect(capturedViewportCss('a{background:url("https://example.com/(100vh).png");height:1e2VH}', viewport)).toBe(
      'a{background:url("https://example.com/(100vh).png");height:900px}'
    );
  });
});
