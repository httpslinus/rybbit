"use client";

import { HeatmapReport } from "@/components/heatmaps/HeatmapReport";
import { HeatmapSubHeader } from "@/components/heatmaps/HeatmapSubHeader";
import { useSetPageTitle } from "@/hooks/useSetPageTitle";
import { useStore } from "@/lib/store";
import { useHeatmapUrlState } from "@/lib/heatmapUrlState";
import { useParams } from "next/navigation";

export default function HeatmapsPage() {
  const site = useStore(state => state.site);
  const routeSite = useParams<{ site: string }>().site;
  const heatmap = useHeatmapUrlState();
  useSetPageTitle("Heatmaps");

  if (!site || String(site) !== routeSite) return null;

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-[2000px] flex-1 flex-col gap-3 p-2 md:p-4">
      <div className="shrink-0">
        <HeatmapSubHeader state={heatmap} />
      </div>
      <HeatmapReport key={routeSite} />
    </div>
  );
}
