import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HeatmapResponse, HeatmapSnapshot } from "@rybbit/shared";
import { HeatmapViewer } from "./HeatmapViewer";

vi.mock("next-intl", () => ({
  useExtracted:
    () =>
    (message: string, values: Record<string, unknown> = {}) =>
      message.replace(/\{(\w+)(?:, number)?\}/g, (_, key) => String(values[key])),
}));

function snapshot(overrides: Partial<HeatmapSnapshot> = {}): HeatmapSnapshot {
  return {
    source: "replay",
    capturedAt: "2026-10-11T10:00:00Z",
    hostname: "example.com",
    pathname: "/page",
    viewportWidth: 1366,
    viewportHeight: 900,
    documentWidth: 1366,
    documentHeight: 1900,
    node: {
      type: 0,
      id: 1,
      childNodes: [
        { type: 1, id: 2, name: "html", publicId: "", systemId: "" },
        {
          type: 2,
          id: 3,
          tagName: "html",
          attributes: {},
          childNodes: [
            {
              type: 2,
              id: 4,
              tagName: "head",
              attributes: {},
              childNodes: [
                {
                  type: 2,
                  id: 5,
                  tagName: "style",
                  attributes: {},
                  childNodes: [{ type: 3, id: 6, textContent: ".hero{height:100vh;width:100vw}" }],
                },
              ],
            },
            {
              type: 2,
              id: 7,
              tagName: "body",
              attributes: {},
              childNodes: [
                {
                  type: 2,
                  id: 8,
                  tagName: "div",
                  attributes: { class: "hero" },
                  childNodes: [{ type: 3, id: 9, textContent: "Masked ******" }],
                },
              ],
            },
          ],
        },
      ],
    },
    ...overrides,
  };
}

function data(overrides: Partial<HeatmapResponse> = {}): HeatmapResponse {
  return {
    mode: "click",
    pages: [{ hostname: "example.com", pathname: "/page", count: 42, sessions: 3 }],
    buckets: [{ width: 1440, count: 42, sessions: 3 }],
    selectedBucket: 1440,
    selectedPage: { hostname: "example.com", pathname: "/page" },
    points: [
      {
        x: 720,
        y: 300,
        viewportWidth: 1440,
        viewportHeight: 900,
        documentWidth: 1440,
        documentHeight: 2000,
        count: 42,
      },
    ],
    scroll: {
      histogram: [
        { depth: 10, reach: 3, count: 0 },
        { depth: 50, reach: 2, count: 1 },
        { depth: 100, reach: 1, count: 1 },
      ],
      totalSessions: 3,
    },
    geometry: { viewportWidth: 1440, viewportHeight: 900, documentWidth: 1440, documentHeight: 2000 },
    background: { url: "https://example.com/page", width: 1440, height: 2000, snapshot: snapshot() },
    count: 42,
    sessions: 3,
    truncated: { pages: false, points: false },
    limits: { pages: 100, points: 5000 },
    ...overrides,
  };
}

let draw: ReturnType<typeof vi.fn>;
let disconnect: ReturnType<typeof vi.fn>;

beforeEach(() => {
  draw = vi.fn();
  disconnect = vi.fn();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 600, height: 500 } as DOMRect);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    drawImage: vi.fn(),
    createImageData: vi.fn((width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) })),
    putImageData: draw,
  } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = vi.fn();
      disconnect = disconnect;
    }
  );
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
  vi.stubGlobal("cancelAnimationFrame", (frame: number) => window.clearTimeout(frame));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("HeatmapViewer", () => {
  it("waits for a measured viewport and draws once at its real size", () => {
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({ width: 0, height: 500 } as DOMRect);
    render(<HeatmapViewer data={data()} showBackground={false} />);
    expect(HTMLCanvasElement.prototype.getContext).not.toHaveBeenCalled();
    expect(draw).not.toHaveBeenCalled();
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({ width: 600, height: 500 } as DOMRect);
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    const canvas = screen.getByRole("img", { name: "Click intensity" }) as HTMLCanvasElement;
    expect(canvas.width).toBe(600);
    expect(canvas.height).toBe(500);
    expect(draw).toHaveBeenCalledOnce();
    expect(draw.mock.lastCall![0].data).toHaveLength(600 * 500 * 4);
  });

  it("rebuilds a script-free stored page and aligns its captured viewport with normalized hotspots", () => {
    const { container } = render(<HeatmapViewer data={data()} showBackground />);
    const iframe = container.querySelector("iframe")!;
    expect(iframe.getAttribute("sandbox")).toBe("allow-same-origin");
    expect(iframe.hasAttribute("src")).toBe(false);
    expect(iframe.hasAttribute("srcdoc")).toBe(false);
    expect(iframe.contentDocument!.URL).toBe("about:blank");
    expect(iframe.contentDocument!.body.textContent).toContain("Masked ******");
    expect(iframe.contentDocument!.querySelector(".hero")).toBeTruthy();
    expect(iframe.contentDocument!.querySelector("style")!.textContent).toBe(".hero{height:900px;width:1366px}");
    expect(iframe.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(iframe.style.width).toBe("1366px");
    expect(iframe.style.height).toBe("1900px");
    expect(Number(iframe.style.transform.match(/scale\((.+)\)/)![1])).toBeCloseTo(600 / 1366, 10);
    expect(screen.getByTestId("heatmap-scene").style.width).toBe("600px");
    const bitmap = draw.mock.lastCall![0].data as Uint8ClampedArray;
    expect(Array.from(bitmap.slice((125 * 600 + 300) * 4, (125 * 600 + 300) * 4 + 4))).toEqual([249, 6, 6, 230]);
    expect(screen.getByRole("img", { name: "Click intensity" }).className).toContain("pointer-events-none");
    expect(screen.getByText("42 clicks from 3 sampled sessions.")).toBeTruthy();
  });

  it("keeps overlays and counts when the page background is switched off or unavailable", () => {
    const props = data();
    const { container, rerender } = render(<HeatmapViewer data={props} showBackground={false} />);
    expect(container.querySelector("iframe")).toBeNull();
    expect(screen.getByRole("img", { name: "Click intensity" })).toBeTruthy();
    rerender(<HeatmapViewer data={{ ...props, background: null }} showBackground />);
    expect(screen.getByText("Page background unavailable. Geometry is shown.")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Click intensity" })).toBeTruthy();
  });

  it("keeps the iframe and scroll viewport mounted when the selected detail refreshes", () => {
    const props = data();
    const { container, rerender } = render(<HeatmapViewer data={props} showBackground />);
    const iframe = container.querySelector("iframe");
    const body = iframe!.contentDocument!.body;
    const viewport = screen.getByRole("region", { name: "Heatmap page" });
    viewport.scrollTop = 200;
    rerender(
      <HeatmapViewer
        data={{
          ...props,
          background: structuredClone(props.background),
          count: 43,
          points: [{ ...props.points[0], count: 43 }],
        }}
        showBackground
      />
    );
    expect(container.querySelector("iframe")).toBe(iframe);
    expect(iframe!.contentDocument!.body).toBe(body);
    expect(screen.getByRole("region", { name: "Heatmap page" })).toBe(viewport);
    expect(viewport.scrollTop).toBe(200);
  });

  it("uses geometry for legacy live URLs without a stored snapshot", () => {
    const { container } = render(
      <HeatmapViewer
        data={data({ background: { url: "https://bodybyraventracy.com/", width: 1440, height: 2000 } })}
        showBackground
      />
    );
    expect(container.querySelector("iframe")).toBeNull();
    expect(screen.getByText("Page background unavailable. Geometry is shown.")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Click intensity" })).toBeTruthy();
  });

  it.each([{ pathname: "/another-page" }, { hostname: "other.example.com" }, { viewportWidth: 375 }])(
    "rejects a background from another page or width: %j",
    context => {
      const props = data();
      props.background!.snapshot = snapshot(context);
      const { container } = render(<HeatmapViewer data={props} showBackground />);
      expect(container.querySelector("iframe")).toBeNull();
      expect(screen.getByText("Page background unavailable. Geometry is shown.")).toBeTruthy();
    }
  );

  it("removes scripts, nested frames, navigation meta and event handlers while preserving masked content", () => {
    const props = data();
    const body = props.background!.snapshot!.node.childNodes![1].childNodes![1];
    body.attributes!.onload = "window.parent.heatmapUnsafe = true";
    body.childNodes!.push(
      {
        type: 2,
        id: 10,
        tagName: "script",
        attributes: {},
        childNodes: [{ type: 3, id: 11, textContent: "window.parent.heatmapUnsafe = true" }],
      },
      { type: 2, id: 12, tagName: "iframe", attributes: { src: "https://bodybyraventracy.com/" }, childNodes: [] },
      {
        type: 2,
        id: 13,
        tagName: "meta",
        attributes: { "http-equiv": "refresh", content: "0;url=https://bodybyraventracy.com/" },
        childNodes: [],
      },
      {
        type: 2,
        id: 14,
        tagName: "input",
        attributes: { value: "******", type: "text", onchange: "alert(1)" },
        childNodes: [],
      }
    );
    const { container } = render(<HeatmapViewer data={props} showBackground />);
    const doc = container.querySelector("iframe")!.contentDocument!;
    expect(doc.querySelector("script, iframe, meta[http-equiv], [onload], [onchange]")).toBeNull();
    expect(doc.querySelector("input")!.value).toBe("******");
    expect(doc.body.textContent).toContain("Masked ******");
    expect(body.attributes!.onload).toBeTruthy();
  });

  it("renders all ten scroll bands, the denominator and an accessible cumulative reach table", () => {
    const { container } = render(<HeatmapViewer data={data({ mode: "scroll" })} showBackground={false} />);
    expect(container.querySelectorAll("[data-depth]").length).toBe(10);
    expect(screen.getByText(/100% depth/).parentElement!.textContent).toContain("33% reach");
    expect(screen.getByText("Scroll reach from 3 sampled sessions.")).toBeTruthy();
    const rows = screen.getAllByRole("row");
    expect(rows[5].textContent).toBe("50%267%");
    expect(rows[10].textContent).toBe("100%133%");
  });

  it("redraws the visible slice on keyboard-scrollable page movement", async () => {
    render(<HeatmapViewer data={data({ points: [{ ...data().points[0], y: 1200 }] })} showBackground={false} />);
    const viewport = screen.getByRole("region", { name: "Heatmap page" });
    expect(viewport.tabIndex).toBe(0);
    await act(async () => {
      viewport.scrollTop = 200;
      fireEvent.scroll(viewport);
      await new Promise(resolve => setTimeout(resolve, 5));
    });
    const bitmap = draw.mock.lastCall![0].data as Uint8ClampedArray;
    expect(Array.from(bitmap.slice((300 * 600 + 300) * 4, (300 * 600 + 300) * 4 + 4))).toEqual([249, 6, 6, 230]);
    expect((screen.getByRole("img", { name: "Click intensity" }) as HTMLCanvasElement).style.top).toBe("200px");
  });

  it("bounds bitmap allocation for extreme page lengths and uses geometry-only rendering", () => {
    const { container } = render(
      <HeatmapViewer
        data={data({
          geometry: { viewportWidth: 1440, viewportHeight: 900, documentWidth: 1440, documentHeight: 4_000_000_000 },
        })}
        showBackground
        fullscreen
      />
    );
    const bitmap = screen.getByRole("img", { name: "Click intensity" }) as HTMLCanvasElement;
    expect(bitmap.height).toBeLessThanOrEqual(4096);
    expect(container.querySelector("iframe")).toBeNull();
    expect(screen.getByText("This page is too long for a page background. Geometry is shown.")).toBeTruthy();
    expect(screen.getByTestId("heatmap-scene").style.height).toBe("8000000px");
  });

  it("disconnects resize observation on cleanup", () => {
    const rendered = render(<HeatmapViewer data={data()} showBackground={false} />);
    rendered.unmount();
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
