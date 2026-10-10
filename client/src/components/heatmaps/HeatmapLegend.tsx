"use client";

import { useExtracted } from "next-intl";

export function HeatmapLegend() {
  const t = useExtracted();
  return (
    <div
      className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
      aria-label={t("Heatmap intensity legend")}
    >
      <span>{t("Low")}</span>
      <div
        className="h-1.5 w-20 rounded-full"
        style={{ background: "linear-gradient(to right, #3b82f6, #22c55e, #facc15, #ef4444)" }}
      />
      <span>{t("High")}</span>
    </div>
  );
}
