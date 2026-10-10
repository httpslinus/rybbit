"use client";

import { FilterParameter, Segment } from "@rybbit/shared";
import { useExtracted } from "next-intl";
import { type ReactNode, useState } from "react";
import { useGetSegments } from "../../../../../api/analytics/hooks/useSegments";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../../../components/ui/tooltip";
import { removeFilter, updateFilter, useStore } from "../../../../../lib/store";
import { FilterChip } from "./FilterChip";
import { SegmentChip } from "./SegmentChip";
import { SegmentDialog } from "./SegmentDialog";
import { filterListKeys, partitionFilters } from "./segmentUtils";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export interface FilterMatching {
  value: "all" | "any";
  onChange: (value: "all" | "any") => void;
}

export function Filters({
  availableFilters,
  matching,
  children,
}: {
  availableFilters?: FilterParameter[];
  matching?: FilterMatching;
  children?: ReactNode;
}) {
  const t = useExtracted();
  const { filters, segmentId, site } = useStore();
  const { data: segments } = useGetSegments(site, { enabled: segmentId !== null });
  const [editing, setEditing] = useState<Segment | null>(null);

  const segment = segmentId === null ? undefined : segments?.find(s => s.segmentId === segmentId);
  const { adHoc, intact } = partitionFilters(filters, segment);
  const keys = filterListKeys(adHoc);
  const activeAdHocCount = adHoc.filter(
    filter => !availableFilters || availableFilters.includes(filter.parameter)
  ).length;
  const unresolvedSegment = segmentId !== null && !segment;
  const showMatching = matching && (matching.value === "any" || (!unresolvedSegment && activeAdHocCount >= 2));
  const matchingTrigger = (
    <SelectTrigger aria-label={t("Match added filters")} className="w-auto" size="sm">
      <SelectValue />
    </SelectTrigger>
  );
  const matchingSelect = showMatching && (
    <Select value={matching.value} onValueChange={value => matching.onChange(value as "all" | "any")}>
      {matching.value === "any" && segment ? (
        <Tooltip>
          <TooltipTrigger asChild>{matchingTrigger}</TooltipTrigger>
          <TooltipContent>{t("The saved segment must also match.")}</TooltipContent>
        </Tooltip>
      ) : (
        matchingTrigger
      )}
      <SelectContent size="sm">
        <SelectItem value="all" size="sm">
          {t("Match all")}
        </SelectItem>
        <SelectItem value="any" size="sm">
          {t("Match any")}
        </SelectItem>
      </SelectContent>
    </Select>
  );

  return (
    <div className="flex flex-wrap items-center gap-1 sm:gap-2">
      {segment && <SegmentChip segment={segment} intact={intact} onEdit={setEditing} />}
      {matchingSelect}
      {adHoc.map((filter, position) => {
        const disabled = availableFilters && !availableFilters.includes(filter.parameter);
        const index = filters.indexOf(filter);
        const key = keys[position];

        const pill = (
          <FilterChip
            filter={filter}
            availableFilters={availableFilters}
            disabled={disabled}
            onUpdate={next => updateFilter(next, index)}
            onRemove={() => removeFilter(filter)}
          />
        );

        if (disabled) {
          return (
            <Tooltip key={key}>
              <TooltipTrigger asChild>{pill}</TooltipTrigger>
              <TooltipContent>
                <p>{t("Filter not active for this page")}</p>
              </TooltipContent>
            </Tooltip>
          );
        }
        return <div key={key}>{pill}</div>;
      })}
      {children}
      <SegmentDialog
        open={editing !== null}
        onOpenChange={open => !open && setEditing(null)}
        siteId={site}
        segment={editing ?? undefined}
        availableFilters={availableFilters}
      />
    </div>
  );
}
