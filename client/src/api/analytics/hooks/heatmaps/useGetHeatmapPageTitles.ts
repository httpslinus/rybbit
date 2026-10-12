import type { HeatmapPage } from "@rybbit/shared";
import { useQueries } from "@tanstack/react-query";
import { buildAnalyticsRequest, fetchAnalytics } from "../../analyticsRequest";
import { useAnalyticsContext } from "../../useAnalyticsQuery";
import type { PagesResponse } from "../useGetPages";

export type TitledHeatmapPage = HeatmapPage & { title?: string };

/** Reuse the Pages report's titles for the sampled paths, scoped to each host. */
export function useGetHeatmapPageTitles(pages: HeatmapPage[], enabled: boolean): TitledHeatmapPage[] {
  const { site, context, hasPeriod } = useAnalyticsContext({ useFilters: false });
  const hosts = [...new Set(pages.map(page => page.hostname))].sort();
  const requests = hosts.map(hostname =>
    buildAnalyticsRequest(
      {
        path: "pages",
        params: {
          group: "page",
          mode: "all",
          sort: "pageviews",
          order: "desc",
          limit: 100,
          page: 1,
          hostname,
          paths: JSON.stringify(
            pages
              .filter(page => page.hostname === hostname)
              .map(page => page.pathname)
              .sort()
          ),
        },
      },
      context
    )
  );
  const results = useQueries({
    queries: requests.map(request => ({
      queryKey: ["pages", site, request.path, request.params, request.body],
      queryFn: () => fetchAnalytics<PagesResponse>(site, request),
      staleTime: 60_000,
      enabled: enabled && !!site && hasPeriod,
    })),
  });
  const titles = new Map<string, string>();
  results.forEach((result, index) => {
    for (const row of result.data?.data ?? []) {
      titles.set(`${hosts[index]}\u0000${row.key}`, row.title);
    }
  });
  return pages.map(page => ({ ...page, title: titles.get(`${page.hostname}\u0000${page.pathname}`) }));
}
