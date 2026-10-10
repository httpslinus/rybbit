"use client";

import type { HeatmapSnapshot, HeatmapSnapshotNode } from "@rybbit/shared";
import { useExtracted } from "next-intl";
import { useEffect, useRef } from "react";
import { createCache, createMirror, rebuild } from "rrweb-snapshot";

interface SnapshotBackgroundProps {
  snapshot: HeatmapSnapshot & { node: HeatmapSnapshotNode };
  scale: number;
  onError: () => void;
}

export function SnapshotBackground({ snapshot, scale, onError }: SnapshotBackgroundProps) {
  const t = useExtracted();
  const iframe = useRef<HTMLIFrameElement>(null);
  const builtSnapshot = useRef<string | null>(null);
  const key = `${snapshot.source}\0${snapshot.capturedAt}\0${snapshot.hostname}\0${snapshot.pathname}`;

  useEffect(() => {
    if (builtSnapshot.current === key) return;
    const doc = iframe.current?.contentDocument;
    if (!doc) return;
    try {
      rebuild(snapshot.node as Parameters<typeof rebuild>[0], { doc, cache: createCache(), mirror: createMirror() });
      if (!doc.documentElement || !doc.body) throw new Error("Missing snapshot document");
      const referrer = doc.createElement("meta");
      referrer.name = "referrer";
      referrer.content = "no-referrer";
      doc.head?.prepend(referrer);
      const style = doc.createElement("style");
      style.textContent =
        "html{overflow:hidden!important}*,*::before,*::after{animation-play-state:paused!important;transition:none!important}";
      doc.head?.append(style);
      doc.documentElement.scrollTop = 0;
      doc.documentElement.scrollLeft = 0;
      doc.body.scrollTop = 0;
      doc.body.scrollLeft = 0;
      doc.close();
      builtSnapshot.current = key;
    } catch {
      onError();
    }
  }, [snapshot, key, onError]);

  return (
    <iframe
      ref={iframe}
      title={t("Page background")}
      sandbox="allow-same-origin"
      referrerPolicy="no-referrer"
      tabIndex={-1}
      aria-hidden="true"
      inert
      className="pointer-events-none absolute left-0 top-0 border-0 bg-white"
      style={{
        width: snapshot.viewportWidth,
        height: snapshot.documentHeight,
        transform: `scale(${scale})`,
        transformOrigin: "top left",
      }}
    />
  );
}
