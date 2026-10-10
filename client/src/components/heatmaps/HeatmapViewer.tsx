"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useExtracted } from "next-intl";
import type { HeatmapResponse } from "@rybbit/shared";
import { drawClickHotspots, intensityColor } from "./clickCanvas";
import { fitHeatmap, pageGeometry, scrollReachBands, visibleDocumentTop } from "./geometry";
import { pageSnapshot, prepareSnapshot } from "./snapshot";
import { SnapshotBackground } from "./SnapshotBackground";

export interface HeatmapViewerProps {
  data: HeatmapResponse;
  showBackground: boolean;
  fullscreen?: boolean;
}

export function HeatmapViewer(props: HeatmapViewerProps) {
  const { data } = props;
  const viewKey = `${data.mode}\0${data.selectedPage?.hostname}\0${data.selectedPage?.pathname}\0${data.selectedBucket}`;
  return <HeatmapView key={viewKey} {...props} />;
}

function HeatmapView({ data, showBackground }: HeatmapViewerProps) {
  const t = useExtracted();
  const summaryId = useId();
  const scroller = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const scrollFrame = useRef<number | null>(null);
  const [size, setSize] = useState({ width: 0, height: 600, dpr: 1 });
  const [scrollTop, setScrollTop] = useState(0);
  const [failedBackground, setFailedBackground] = useState<string | null>(null);
  const geometry = useMemo(() => pageGeometry(data), [data]);
  const fit = useMemo(() => fitHeatmap(geometry, size.width), [geometry, size.width]);
  const bands = useMemo(() => scrollReachBands(data.scroll.histogram, data.scroll.totalSessions), [data.scroll]);
  const snapshot = useMemo(() => {
    const source = pageSnapshot(data);
    if (!source) return null;
    try {
      return { ...source, node: prepareSnapshot(source) };
    } catch {
      return null;
    }
  }, [data]);
  const backgroundKey = snapshot ? `${snapshot.source}\0${snapshot.capturedAt}` : null;
  const background = showBackground && !fit.virtual && backgroundKey !== failedBackground ? snapshot : null;
  const backgroundScale = background ? (data.selectedBucket! / background.viewportWidth) * fit.scale : 1;
  const visibleTop = visibleDocumentTop(scrollTop, size.height, fit);

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () => {
      const bounds = element.getBoundingClientRect();
      const next = {
        width: element.clientWidth || bounds.width,
        height: element.clientHeight || bounds.height || 600,
        dpr: window.devicePixelRatio || 1,
      };
      setSize(previous =>
        previous.width === next.width && previous.height === next.height && previous.dpr === next.dpr ? previous : next
      );
    };
    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    };
  }, []);

  useEffect(() => {
    if (data.mode === "click" && canvas.current && size.width > 0) {
      drawClickHotspots(canvas.current, data.points, fit, visibleTop, size.height, size.dpr);
    }
  }, [data.mode, data.points, fit, visibleTop, size.width, size.height, size.dpr]);

  const summary =
    data.mode === "click"
      ? t("{clicks, number} clicks from {sessions, number} sampled sessions.", {
          clicks: data.count,
          sessions: data.sessions,
        })
      : t("Scroll reach from {sessions, number} sampled sessions.", { sessions: data.scroll.totalSessions });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p id={summaryId} className="sr-only" aria-live="polite">
        {summary}
      </p>
      <div
        ref={scroller}
        role="region"
        aria-label={t("Heatmap page")}
        tabIndex={0}
        className="relative min-h-0 flex-1 overflow-auto bg-neutral-100 dark:bg-neutral-950 focus-visible:outline-2 focus-visible:outline-primary"
        onScroll={event => {
          const element = event.currentTarget;
          if (scrollFrame.current !== null) return;
          scrollFrame.current = requestAnimationFrame(() => {
            scrollFrame.current = null;
            setScrollTop(element.scrollTop);
          });
        }}
      >
        <div
          className="relative mx-auto overflow-hidden bg-white dark:bg-neutral-900"
          data-testid="heatmap-scene"
          style={{
            width: fit.width,
            height: fit.sceneHeight,
            backgroundImage: background
              ? undefined
              : "linear-gradient(rgba(128,128,128,.09) 1px, transparent 1px), linear-gradient(90deg, rgba(128,128,128,.09) 1px, transparent 1px)",
            backgroundSize: "32px 32px",
          }}
        >
          {background && (
            <SnapshotBackground
              key={backgroundKey}
              snapshot={background}
              scale={backgroundScale}
              onError={() => setFailedBackground(backgroundKey)}
            />
          )}
          {data.mode === "click" ? (
            <canvas
              ref={canvas}
              role="img"
              aria-label={t("Click intensity")}
              aria-describedby={summaryId}
              className="pointer-events-none absolute left-0"
              style={{ top: scrollTop, width: fit.width, height: Math.min(size.height, fit.sceneHeight) }}
            />
          ) : (
            <div
              className="pointer-events-none absolute inset-0"
              role="img"
              aria-label={t("Scroll reach")}
              aria-describedby={summaryId}
            >
              {bands.map(band => (
                <div
                  key={band.depth}
                  className="absolute w-full border-b border-white/50"
                  data-depth={band.depth}
                  style={{
                    top: `${band.depth - 10}%`,
                    height: "10%",
                    backgroundColor: intensityColor(band.percent / 100, 0.35),
                  }}
                >
                  <span className="absolute bottom-1 right-1 inline-flex gap-2 rounded bg-background/90 px-2 py-1 text-xs text-foreground shadow-sm">
                    <span>{t("{depth, number}% depth", { depth: band.depth })}</span>
                    <span className="border-l border-border pl-2">
                      {t("{reach, number}% reach", { reach: Math.round(band.percent) })}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      {showBackground && !background && (
        <p className="shrink-0 px-2.5 py-1.5 text-xs text-muted-foreground">
          {fit.virtual
            ? t("This page is too long for a page background. Geometry is shown.")
            : t("Page background unavailable. Geometry is shown.")}
        </p>
      )}
      {data.mode === "scroll" && (
        <table className="sr-only">
          <caption>{t("Scroll reach by page depth")}</caption>
          <thead>
            <tr>
              <th>{t("Depth")}</th>
              <th>{t("Sampled sessions")}</th>
              <th>{t("Reach")}</th>
            </tr>
          </thead>
          <tbody>
            {bands.map(band => (
              <tr key={band.depth}>
                <td>{band.depth}%</td>
                <td>{band.reach}</td>
                <td>{Math.round(band.percent)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
