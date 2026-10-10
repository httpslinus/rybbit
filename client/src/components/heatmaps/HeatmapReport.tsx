"use client";

import type { HeatmapMode, HeatmapPage, HeatmapWidthBucket } from "@rybbit/shared";
import { ChevronDown, Info, Layers, Maximize2, MousePointer2, PanelLeft, X } from "lucide-react";
import { useExtracted } from "next-intl";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useGetSite } from "@/api/admin/hooks/useSites";
import { useGetHeatmaps } from "@/api/analytics/hooks/heatmaps/useGetHeatmaps";
import { SegmentedControl } from "@/components/interior/segmented-control";
import { AnalysisBar } from "@/components/site/AnalysisBar";
import { NothingFound } from "@/components/NothingFound";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogContentFullScreen, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useHeatmapUrlState } from "@/lib/heatmapUrlState";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { HeatmapViewer } from "./HeatmapViewer";
import { HeatmapLegend } from "./HeatmapLegend";

export function HeatmapReport() {
  const t = useExtracted();
  const routeSite = useParams<{ site: string }>().site;
  const storeSite = useStore(state => state.site);
  const siteReady = !!storeSite && String(storeSite) === routeSite;
  const {
    data: site,
    isLoading: siteLoading,
    error: siteError,
    refetch: refetchSite,
  } = useGetSite(routeSite, {
    enabled: siteReady,
  });
  const time = useStore(state => state.time);
  const {
    mode,
    setMode,
    search,
    setSearch,
    selection,
    setSelection,
    match,
    analyticsEventType,
    excludeBounce,
    cohortId,
  } = useHeatmapUrlState();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [showBackground, setShowBackground] = useState(true);
  const [pageSearch, setPageSearch] = useState(search);
  useEffect(() => {
    const timeout = setTimeout(() => setPageSearch(search), 250);
    return () => clearTimeout(timeout);
  }, [search]);
  const fullscreenTrigger = useRef<HTMLButtonElement>(null);
  const canRead = site?.permissions?.includes("heatmaps:read") === true;
  const boundedWindow = time.mode !== "all-time";
  const enabled = siteReady && canRead && site?.type !== "mobile" && boundedWindow;
  const {
    data: result,
    isLoading,
    error,
    refetch,
  } = useGetHeatmaps({
    mode,
    ...selection,
    match,
    analyticsEventType,
    excludeBounce,
    cohortId,
    enabled,
  });
  const data = enabled ? result : undefined;
  const pageQuery = useGetHeatmaps({
    view: "pages",
    mode,
    search: pageSearch,
    match,
    analyticsEventType,
    excludeBounce,
    cohortId,
    enabled,
  });
  const pageData = enabled ? pageQuery.data : undefined;
  const showHostname =
    new Set([
      ...(pageData?.pages.map(page => page.hostname) ?? []),
      ...(data?.selectedPage ? [data.selectedPage.hostname] : []),
    ]).size > 1;

  // Save the API's initial choice independently for each mode. Selecting a new
  // page clears its width so the most represented observed layout wins again.
  useEffect(() => {
    if (!siteReady || !data?.selectedPage || data.mode !== mode || selection.hostname || selection.pathname) return;
    setSelection({ ...data.selectedPage, ...(data.selectedBucket ? { bucket: data.selectedBucket } : {}) });
  }, [data, siteReady, mode, selection.hostname, selection.pathname, setSelection]);

  const selectPage = (page: HeatmapPage) => {
    setSelection({ hostname: page.hostname, pathname: page.pathname });
    setPickerOpen(false);
  };

  const pages = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-neutral-150 p-2 dark:border-neutral-800">
        <Input
          isSearch
          inputSize="sm"
          type="search"
          aria-label={t("Search pages")}
          placeholder={t("Search pages")}
          value={search}
          onChange={event => setSearch(event.target.value)}
        />
      </div>
      {pageQuery.isLoading || search !== pageSearch ? (
        <div className="space-y-2" aria-hidden="true">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      ) : pageQuery.error && enabled ? (
        <NothingFound
          title={t("Unable to load heatmaps")}
          description={pageQuery.error.message}
          action={<Button onClick={() => void pageQuery.refetch()}>{t("Retry")}</Button>}
        />
      ) : pageData?.pages.length ? (
        <ul aria-label={t("Pages")} className="min-h-0 flex-1 overflow-y-auto">
          {pageData.pages.map(page => (
            <li key={`${page.hostname}\u0000${page.pathname}`}>
              <button
                type="button"
                aria-pressed={
                  data?.selectedPage?.hostname === page.hostname && data.selectedPage?.pathname === page.pathname
                }
                onClick={() => selectPage(page)}
                className={cn(
                  "w-full cursor-pointer border-b border-neutral-150 px-2.5 py-2 text-left transition-colors dark:border-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500",
                  data?.selectedPage?.hostname === page.hostname && data.selectedPage?.pathname === page.pathname
                    ? "bg-neutral-100 dark:bg-neutral-800"
                    : "hover:bg-neutral-50 dark:hover:bg-neutral-900"
                )}
              >
                <span className="block break-all text-sm font-medium">{page.pathname}</span>
                {showHostname && (
                  <span className="block truncate text-xs text-neutral-500 dark:text-neutral-400" title={page.hostname}>
                    {page.hostname}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="py-6 text-center text-sm text-neutral-500 dark:text-neutral-400">
          {search ? t("No matching pages") : t("No pages with samples")}
        </div>
      )}
      {pageData?.truncated.pages && (
        <p className="shrink-0 p-2 text-xs text-neutral-500 dark:text-neutral-400">
          {t("Showing the top {count} pages. Search to find another page.", {
            count: pageData.limits.pages.toLocaleString(),
          })}
        </p>
      )}
    </div>
  );

  const sampleDetails = data?.selectedPage ? (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" aria-label={t("Sample details")} className="gap-1.5">
          {t("Sample details")}
          <ChevronDown className="size-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto max-w-[calc(100vw-1rem)]" aria-label={t("Sample details")}>
        <h3 className="mb-2 text-sm font-medium">{t("Sample details")}</h3>
        <div className="space-y-1 text-xs text-neutral-600 dark:text-neutral-300">
          <p>{t("Sampled sessions: {count}", { count: data.sessions.toLocaleString() })}</p>
          <p>
            {mode === "click"
              ? t("Clicks: {count}", { count: data.count.toLocaleString() })
              : t("Scroll samples: {count}", { count: data.count.toLocaleString() })}
          </p>
          {data.cohort && (
            <p>
              {t("{name}: {members, number} historical visitors ({start}–{end}, {zone})", {
                name: data.cohort.name,
                members: data.cohort.members,
                start: data.cohort.startDate,
                end: data.cohort.endDate,
                zone: data.cohort.timeZone,
              })}
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  ) : null;

  const controls = (
    <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-neutral-150 px-2.5 py-1.5 dark:border-neutral-800">
      {data?.buckets.length ? (
        <Select
          value={data.selectedBucket?.toString() ?? ""}
          onValueChange={value => setSelection({ ...selection, bucket: Number(value) as HeatmapWidthBucket })}
        >
          <SelectTrigger aria-label={t("Viewport width")} className="w-auto min-w-28" size="sm">
            <SelectValue placeholder={t("Viewport width")}>
              {data.selectedBucket ? t("{width} CSS px", { width: data.selectedBucket.toString() }) : undefined}
            </SelectValue>
          </SelectTrigger>
          <SelectContent size="sm" className="max-w-[calc(100vw-1rem)]">
            {data.buckets.map(bucket => (
              <SelectItem key={bucket.width} value={bucket.width.toString()} size="sm">
                <span className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
                  <span className="min-w-20 font-medium">
                    {t("{width} CSS px", { width: bucket.width.toString() })}
                  </span>
                  <span className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-neutral-500 dark:text-neutral-400">
                    <span>{t("{sessions, number} sampled sessions", { sessions: bucket.sessions })}</span>
                    <span>{t("{count, number} samples", { count: bucket.count })}</span>
                  </span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      <label className="flex cursor-pointer items-center gap-2 text-xs">
        <Switch
          aria-label={t("Live background")}
          checked={showBackground && !!data?.background}
          disabled={!data?.background}
          onCheckedChange={setShowBackground}
        />
        {t("Live background")}
      </label>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={t("About live backgrounds")}
              className="inline-flex size-6 items-center justify-center rounded-md text-neutral-500 hover:text-neutral-900 focus-visible:outline-2 focus-visible:outline-primary dark:hover:text-neutral-100"
            >
              <Info className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-72">
            {t(
              "Live backgrounds can differ from the recorded layout, especially fixed headers and full-screen sections. Sign-in and embedding rules may hide the page."
            )}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      {!showBackground && data?.background && (
        <span className="text-xs text-neutral-500 dark:text-neutral-400">{t("Geometry only")}</span>
      )}
      {data?.geometry && (
        <div className="ml-auto flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-xs text-neutral-500 dark:text-neutral-400">
          <HeatmapLegend />
        </div>
      )}
    </div>
  );

  let detail;
  if (!siteReady || siteLoading || (isLoading && canRead && boundedWindow)) {
    detail = (
      <div role="status" aria-label={t("Loading heatmaps")} className="space-y-3 p-4">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-80 w-full" />
      </div>
    );
  } else if (siteError || error) {
    detail = (
      <NothingFound
        title={t("Unable to load heatmaps")}
        description={(siteError ?? error)?.message}
        action={<Button onClick={() => void (siteError ? refetchSite() : refetch())}>{t("Retry")}</Button>}
      />
    );
  } else if (!canRead) {
    detail = <NothingFound title={t("You don't have access to heatmaps for this site.")} />;
  } else if (site?.type === "mobile") {
    detail = <NothingFound title={t("Heatmaps are available for web sites.")} />;
  } else if (!boundedWindow) {
    detail = <NothingFound title={t("Choose a date range to view heatmaps.")} />;
  } else if (!data?.selectedPage) {
    detail = (
      <NothingFound
        icon={<MousePointer2 className="size-9" />}
        title={t("No heatmap samples")}
        description={t("Try another date range or collect more samples.")}
      />
    );
  } else if (!data.geometry || !data.count) {
    detail = (
      <NothingFound
        title={t("No samples for this page")}
        description={t("Try another date range or viewport width.")}
      />
    );
  } else {
    detail = (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {data.truncated.points && (
          <p className="shrink-0 px-2.5 py-1 text-xs text-neutral-500 dark:text-neutral-400">
            {t("Showing the {count} most frequent click points.", { count: data.limits.points.toLocaleString() })}
          </p>
        )}
        <HeatmapViewer data={data} showBackground={showBackground && !!data.background} fullscreen={fullscreen} />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <h1 className="sr-only">{t("Heatmaps")}</h1>
      <AnalysisBar compare={null} className="shrink-0">
        <SegmentedControl<HeatmapMode>
          aria-label={t("Heatmap mode")}
          size="sm"
          value={mode}
          onValueChange={setMode}
          options={[
            {
              value: "click",
              label: (
                <>
                  <MousePointer2 className="size-3.5" />
                  {t("Clicks")}
                </>
              ),
              ariaLabel: t("Clicks"),
            },
            {
              value: "scroll",
              label: (
                <>
                  <Layers className="size-3.5" />
                  {t("Scroll")}
                </>
              ),
              ariaLabel: t("Scroll"),
            },
          ]}
        />
      </AnalysisBar>
      {data?.cohort?.members === 0 && (
        <p role="status" className="text-xs text-neutral-500 dark:text-neutral-400">
          {t("No matching visitors in retained historical analytics. Choose another cohort or historical window.")}
        </p>
      )}
      {site?.type === "web" && site.heatmaps === false && canRead && (
        <Alert className="shrink-0">
          <AlertDescription>
            {t("Collection is off. Enable heatmaps in site settings to collect new samples.")}
          </AlertDescription>
        </Alert>
      )}
      <div className="flex min-h-0 flex-1 gap-3">
        <aside className="hidden w-52 shrink-0 flex-col overflow-hidden rounded-lg border border-neutral-150 bg-white dark:border-neutral-800 dark:bg-neutral-900 md:flex">
          {pages}
        </aside>
        <section
          aria-label={t("Heatmap detail")}
          className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-neutral-150 bg-white dark:border-neutral-800 dark:bg-neutral-900"
        >
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-neutral-150 px-2.5 py-1.5 dark:border-neutral-800">
            <div className="min-w-0 flex-1">
              {data?.selectedPage && (
                <>
                  <h2 className="truncate text-sm font-medium" title={data.selectedPage.pathname}>
                    {data.selectedPage.pathname}
                  </h2>
                  {showHostname && (
                    <p className="truncate text-xs text-neutral-500 dark:text-neutral-400">
                      {data.selectedPage.hostname}
                    </p>
                  )}
                </>
              )}
            </div>
            {sampleDetails}
            <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
              <DialogTrigger asChild>
                <Button size="sm" className="md:hidden">
                  <PanelLeft />
                  {t("Pages")}
                </Button>
              </DialogTrigger>
              <DialogContent className="flex max-h-[85dvh] flex-col" aria-describedby={undefined}>
                <DialogTitle>{t("Pages")}</DialogTitle>
                {pages}
              </DialogContent>
            </Dialog>
            <Button
              ref={fullscreenTrigger}
              size="smIcon"
              variant="ghost"
              aria-label={t("Open fullscreen")}
              disabled={!data?.geometry}
              onClick={() => setFullscreen(true)}
            >
              <Maximize2 />
            </Button>
          </div>
          {controls}
          {!fullscreen && detail}
        </section>
      </div>
      <Dialog open={fullscreen} onOpenChange={setFullscreen}>
        <DialogContentFullScreen
          className="gap-0 overflow-hidden p-0"
          aria-describedby={undefined}
          onCloseAutoFocus={event => {
            event.preventDefault();
            fullscreenTrigger.current?.focus();
          }}
        >
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-neutral-150 px-2.5 py-1.5 dark:border-neutral-800">
            <DialogTitle className="min-w-0 flex-1 truncate text-sm" title={data?.selectedPage?.pathname}>
              {data?.selectedPage?.pathname ?? t("Heatmaps")}
            </DialogTitle>
            {sampleDetails}
            <Button
              size="smIcon"
              variant="ghost"
              aria-label={t("Close fullscreen")}
              onClick={() => setFullscreen(false)}
            >
              <X />
            </Button>
          </div>
          {controls}
          {detail}
        </DialogContentFullScreen>
      </Dialog>
    </div>
  );
}
