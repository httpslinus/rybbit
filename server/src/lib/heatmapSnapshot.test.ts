import { HEATMAP_MAX_SNAPSHOT_BYTES, sanitizeHeatmapSnapshot, type HeatmapSnapshotNode } from "@rybbit/shared";
import { describe, expect, it } from "vitest";

const element = (
  tagName: string,
  attributes: HeatmapSnapshotNode["attributes"] = {},
  childNodes: HeatmapSnapshotNode[] = []
): HeatmapSnapshotNode => ({ type: 2, id: 2, tagName, attributes, childNodes });
const document = (...childNodes: HeatmapSnapshotNode[]): HeatmapSnapshotNode => ({ type: 0, id: 1, childNodes });

describe("heatmap snapshot sanitization", () => {
  it("retains inline styles, images, masked text and shadow DOM while removing active content", () => {
    const node = sanitizeHeatmapSnapshot(
      document(
        element("html", {}, [
          element("head", {}, [
            element("meta", { "http-equiv": "Content-Security-Policy", content: "frame-ancestors 'none'" }),
            element("meta", { "http-equiv": "refresh", content: "0;url=https://evil.example" }),
            element("style", {}, [{ type: 3, id: 3, textContent: ".card { height: 100vh; }", isStyle: true }]),
          ]),
          element("body", { onload: "alert(1)" }, [
            element("script", { src: "https://evil.example/script.js" }),
            element("iframe", { srcdoc: "<script>alert(1)</script>" }),
            element("object", { data: "https://evil.example" }),
            element("img", { src: "https://example.com/image.jpg", onerror: "alert(1)" }),
            { ...element("div", {}, [{ type: 3, id: 4, textContent: "*****", isShadow: true }]), isShadowHost: true },
          ]),
        ])
      )
    );
    const serialized = JSON.stringify(node);
    expect(serialized).not.toMatch(/frame-ancestors|refresh|alert|evil|srcdoc|onload|onerror/);
    expect(serialized).toContain("https://example.com/image.jpg");
    expect(serialized).toContain("100vh");
    expect(serialized).toContain('"isShadowHost":true');
    expect(serialized).toContain("*****");
  });

  it("removes executable URLs and permits SVG fragment references", () => {
    const node = sanitizeHeatmapSnapshot(
      document(element("a", { href: "javascript:alert(1)" }), element("use", { "xlink:href": "#icon" }))
    );
    expect(node.childNodes?.[0].attributes).toEqual({});
    expect(node.childNodes?.[1].attributes).toEqual({ "xlink:href": "#icon" });
  });

  it("prevents captured audio and video from resuming playback during reconstruction", () => {
    const node = sanitizeHeatmapSnapshot(
      document(
        element("video", {
          autoplay: true,
          rr_mediaState: "played",
          rr_mediaCurrentTime: 12,
          poster: "https://example.com/poster.jpg",
        }),
        element("audio", { AUTOPLAY: "", RR_MEDIASTATE: "played", controls: true })
      )
    );
    expect(node.childNodes?.[0].attributes).toEqual({
      rr_mediaCurrentTime: 12,
      poster: "https://example.com/poster.jpg",
    });
    expect(node.childNodes?.[1].attributes).toEqual({ controls: true });
  });

  it.each([
    null,
    { type: 0, id: 1, childNodes: {} },
    { type: 0, id: 1, childNodes: [{ type: 9, id: 2 }] },
    {
      type: 0,
      id: 1,
      childNodes: [{ type: 2, id: 2, tagName: "img onerror=alert(1)", attributes: {}, childNodes: [] }],
    },
    document(element("div", { style: { dangerous: true } } as unknown as HeatmapSnapshotNode["attributes"])),
  ])("rejects malformed trees %j", invalid => {
    expect(() => sanitizeHeatmapSnapshot(invalid)).toThrow();
  });

  it("bounds tree depth and serialized bytes before rebuilding", () => {
    let nested = element("div");
    for (let i = 0; i < 201; i++) nested = element("div", {}, [nested]);
    expect(() => sanitizeHeatmapSnapshot(document(nested))).toThrow("tree exceeds limits");
    expect(() =>
      sanitizeHeatmapSnapshot(document({ type: 3, id: 2, textContent: "x".repeat(HEATMAP_MAX_SNAPSHOT_BYTES) }))
    ).toThrow("size limit");
  });
});
