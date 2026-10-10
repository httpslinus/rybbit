import { describe, expect, it } from "vitest";
import { buildHeatmapBackground } from "./heatmapBackground.js";

const base = { configuredDomain: "example.com", hostname: "example.com", pathname: "/docs", width: 375, height: 2000 };

describe("heatmap backgrounds", () => {
  it("uses only the configured host or its observed subdomains", () => {
    expect(buildHeatmapBackground(base)).toEqual({ url: "https://example.com/docs", width: 375, height: 2000 });
    expect(buildHeatmapBackground({ ...base, hostname: "www.example.com" })?.url).toBe("https://www.example.com/docs");
    expect(buildHeatmapBackground({ ...base, hostname: "example.com.evil.test" })).toBeNull();
    expect(buildHeatmapBackground({ ...base, hostname: "other.test" })).toBeNull();
  });

  it("keeps explicit local HTTP scheme and port and encodes masked segments", () => {
    expect(
      buildHeatmapBackground({
        ...base,
        configuredDomain: "http://localhost:18084",
        hostname: "localhost",
        pathname: "/user/*",
      })?.url
    ).toBe("http://localhost:18084/user/%2A");
    expect(buildHeatmapBackground({ ...base, configuredDomain: "example.com:8443" })?.url).toBe(
      "https://example.com:8443/docs"
    );
  });

  it.each([
    "//evil.test/path",
    "/\\evil.test",
    "/../admin",
    "/%2e%2e/admin",
    "/%2f%2fevil.test",
    "/%5cevil.test",
    "/page?token=secret",
    "/page#secret",
    "/page%3Ftoken=secret",
    "/page%00",
    "/bad%",
  ])("rejects unsafe path %s", pathname => {
    expect(buildHeatmapBackground({ ...base, pathname })).toBeNull();
  });

  it.each([
    "javascript:alert(1)",
    "ftp://example.com",
    "//example.com",
    "https://user:password@example.com",
    "https://example.com\\evil",
  ])("rejects unsafe configured domain %s", configuredDomain => {
    expect(buildHeatmapBackground({ ...base, configuredDomain })).toBeNull();
  });

  it("rejects nonfinite dimensions and malformed observed hosts", () => {
    expect(buildHeatmapBackground({ ...base, width: NaN })).toBeNull();
    expect(buildHeatmapBackground({ ...base, height: Infinity })).toBeNull();
    expect(buildHeatmapBackground({ ...base, width: 0 })).toBeNull();
    expect(buildHeatmapBackground({ ...base, hostname: "user@example.com" })).toBeNull();
    expect(buildHeatmapBackground({ ...base, hostname: "example.com:80" })).toBeNull();
  });
});
