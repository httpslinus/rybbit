"use client";

import { X } from "lucide-react";
import { useExtracted } from "next-intl";
import { useId } from "react";
import { useGetSite } from "@/api/admin/hooks/useSites";
import { SubHeader } from "@/app/[site]/components/SubHeader/SubHeader";
import { Button } from "@/components/ui/button";
import { ButtonGroup, ButtonGroupText } from "@/components/ui/button-group";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SESSION_PAGE_FILTERS } from "@/lib/filterGroups";
import type { useHeatmapUrlState } from "@/lib/heatmapUrlState";
import { useStore } from "@/lib/store";
import { CohortSelector } from "./CohortSelector";

export function HeatmapSubHeader({ state }: { state: ReturnType<typeof useHeatmapUrlState> }) {
  const t = useExtracted();
  const siteId = useStore(state => state.site);
  const { data: site } = useGetSite();
  const {
    match,
    setMatch,
    analyticsEventType,
    setAnalyticsEventType,
    excludeBounce,
    setExcludeBounce,
    cohortId,
    setCohortId,
  } = state;
  const eventTypeId = useId();
  const bounceId = useId();
  const enabled = site?.permissions?.includes("heatmaps:read") && site.type !== "mobile";

  const eventTypeSelect = (id?: string) => (
    <Select
      value={analyticsEventType ?? "any"}
      onValueChange={value =>
        setAnalyticsEventType(value === "any" ? undefined : (value as "pageview" | "custom_event"))
      }
    >
      <SelectTrigger
        id={id}
        aria-label={t("Analytics event type")}
        size="sm"
        className={id ? "w-auto min-w-36" : "w-auto min-w-0 bg-neutral-100 dark:bg-neutral-800"}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent size="sm">
        <SelectItem value="any" size="sm">
          {t("Any event type")}
        </SelectItem>
        <SelectItem value="pageview" size="sm">
          {t("Pageviews")}
        </SelectItem>
        <SelectItem value="custom_event" size="sm">
          {t("Custom events")}
        </SelectItem>
      </SelectContent>
    </Select>
  );
  const options = enabled ? (
    <div className="space-y-3 border-b border-neutral-200 p-3 dark:border-neutral-700">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={eventTypeId} className="text-xs">
          {t("Event type")}
        </Label>
        {eventTypeSelect(eventTypeId)}
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id={bounceId} checked={excludeBounce} onCheckedChange={value => setExcludeBounce(value === true)} />
        <Label htmlFor={bounceId} className="cursor-pointer text-xs">
          {t("Exclude bounced sessions")}
        </Label>
      </div>
    </div>
  ) : undefined;

  return (
    <CohortSelector
      key={siteId}
      siteId={siteId}
      permissions={enabled ? (site?.permissions ?? []) : []}
      cohortId={cohortId}
      onChange={setCohortId}
      availableFilters={SESSION_PAGE_FILTERS}
    >
      {({ tab, chip }) => (
        <SubHeader
          availableFilters={SESSION_PAGE_FILTERS}
          matching={{ value: match, onChange: setMatch }}
          filterOptions={options}
          additionalTab={tab ? { label: t("Cohorts"), content: tab } : undefined}
          activeFilters={
            enabled ? (
              <>
                {analyticsEventType && (
                  <ButtonGroup className="max-w-full">
                    <ButtonGroupText className="shrink-0 whitespace-nowrap px-2 text-sm">
                      {t("Event type")}
                    </ButtonGroupText>
                    {eventTypeSelect()}
                    <Button
                      size="sm"
                      variant="secondary"
                      className="shrink-0 px-1.5 text-neutral-500 dark:text-neutral-400"
                      aria-label={t("Remove event type filter")}
                      onClick={() => setAnalyticsEventType(undefined)}
                    >
                      <X size={14} strokeWidth={2.5} />
                    </Button>
                  </ButtonGroup>
                )}
                {excludeBounce && (
                  <ButtonGroup>
                    <ButtonGroupText className="px-2 text-sm">{t("Exclude bounced sessions")}</ButtonGroupText>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="px-1.5 text-neutral-500 dark:text-neutral-400"
                      aria-label={t("Remove bounce filter")}
                      onClick={() => setExcludeBounce(false)}
                    >
                      <X size={14} strokeWidth={2.5} />
                    </Button>
                  </ButtonGroup>
                )}
                {chip}
              </>
            ) : undefined
          }
        />
      )}
    </CohortSelector>
  );
}
