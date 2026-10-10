import type { HeatmapResponse } from "@rybbit/shared";
import { useStore } from "@/lib/store";
import { heatmapDescriptor, type HeatmapSelection } from "../../endpoints/heatmaps";
import { useAnalyticsQuery } from "../../useAnalyticsQuery";

export function useGetHeatmaps(options: HeatmapSelection & { enabled?: boolean } = {}) {
  const segmentId = useStore(state => state.segmentId);
  const time = useStore(state => state.time);
  return useAnalyticsQuery<HeatmapResponse>({
    key: options.view === "pages" ? "heatmap-pages" : "heatmaps",
    ...heatmapDescriptor({ ...options, segmentId: options.segmentId === undefined ? segmentId : options.segmentId }),
    placeholder: false,
    enabled: (options.enabled ?? true) && time.mode !== "all-time",
  });
}
