"use client";

import type { Cohort, Filter, FilterParameter, Permission } from "@rybbit/shared";
import { DateTime } from "luxon";
import { Check, ChevronDown, Layers, MoreHorizontal, Pencil, Plus, Trash2, X } from "lucide-react";
import { useExtracted } from "next-intl";
import { type ReactNode, useId, useRef, useState } from "react";
import {
  useCreateCohort,
  useDeleteCohort,
  useGetCohorts,
  useUpdateCohort,
} from "@/api/analytics/hooks/heatmaps/useCohorts";
import { getStartAndEndDate } from "@/api/utils";
import { FilterChip } from "@/app/[site]/components/SubHeader/Filters/FilterChip";
import { FilterPicker } from "@/app/[site]/components/SubHeader/Filters/FilterPicker";
import { filterListKeys } from "@/app/[site]/components/SubHeader/Filters/segmentUtils";
import {
  formatDisplayValue,
  operatorNeedsValue,
  useOperatorLabel,
  useParameterLabel,
} from "@/app/[site]/components/SubHeader/Filters/labels";
import { isNumericParameter } from "@/app/[site]/components/SubHeader/Filters/const";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { useGetRegionName } from "@/lib/geo";
import { useStore, useTimezone } from "@/lib/store";
import { cn } from "@/lib/utils";

interface CohortSelectorProps {
  siteId: string | number;
  permissions: readonly Permission[];
  cohortId: number | null;
  onChange: (cohortId: number | null) => void;
  availableFilters: FilterParameter[];
  children: (controls: { tab?: (onClose: () => void) => ReactNode; chip: ReactNode }) => ReactNode;
}

export function CohortSelector({
  siteId,
  permissions,
  cohortId,
  onChange,
  availableFilters,
  children,
}: CohortSelectorProps) {
  const t = useExtracted();
  const canRead = permissions.includes("cohorts:read");
  const canWrite = permissions.includes("cohorts:write");
  const canManage = permissions.includes("cohorts:manage");
  const { data: cohorts = [], isLoading, error, refetch } = useGetCohorts(siteId, { enabled: canRead });
  const [editor, setEditor] = useState<Cohort | "new" | null>(null);
  const selected = cohorts.find(cohort => cohort.cohortId === cohortId);
  const getParameterLabel = useParameterLabel();
  const getOperatorLabel = useOperatorLabel();
  const { getRegionName } = useGetRegionName();
  const canEdit = (cohort: Cohort) => cohort.canEdit && (canWrite || canManage);
  const editorAllowed = canRead && (editor === "new" ? canWrite : editor !== null && canEdit(editor));
  const chip =
    canRead && cohortId !== null ? (
      <ButtonGroup>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="secondary" size="sm" className="max-w-[calc(100vw-3rem)] gap-1.5 px-2 py-1.5">
              <Layers className="size-4 shrink-0 text-neutral-500 dark:text-neutral-400" />
              <span className="truncate font-medium">
                {selected?.name ?? (isLoading ? t("Cohort") : t("Cohort unavailable"))}
              </span>
              <ChevronDown className="size-3 shrink-0 text-neutral-500 dark:text-neutral-400" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-80 max-w-[calc(100vw-1rem)] p-0">
            {selected ? (
              <>
                <div className="border-b border-neutral-200 px-3 py-2 dark:border-neutral-700">
                  <h3 className="truncate text-sm font-medium">{selected.name}</h3>
                  <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                    {selected.startDate}–{selected.endDate} ({selected.timeZone})
                  </p>
                </div>
                <div className="px-3 py-2">
                  <div className="mb-1.5 text-[11px] uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
                    {t("Historical filters")}
                  </div>
                  <ul className="flex flex-col gap-1 text-xs text-neutral-700 dark:text-neutral-200">
                    {selected.filters.map((filter, index) => (
                      <li key={index} className="flex min-w-0 items-center gap-1.5">
                        <span>{getParameterLabel(filter.parameter)}</span>
                        <span className="text-neutral-500 dark:text-neutral-400">
                          {getOperatorLabel(filter.type, isNumericParameter(filter.parameter))}
                        </span>
                        {operatorNeedsValue(filter.type) && (
                          <span className="truncate font-medium">{formatDisplayValue(filter, getRegionName)}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              </>
            ) : isLoading ? (
              <Skeleton className="m-3 h-8" />
            ) : error ? (
              <div role="alert" className="flex items-center justify-between gap-2 p-3 text-sm">
                {t("Unable to load cohorts")}
                <Button size="sm" variant="ghost" onClick={() => void refetch()}>
                  {t("Retry")}
                </Button>
              </div>
            ) : (
              <p className="p-3 text-sm">{t("Cohort unavailable")}</p>
            )}
            <div className="flex items-center justify-between border-t border-neutral-200 p-2 dark:border-neutral-700">
              {selected && canEdit(selected) && (
                <Button size="sm" variant="ghost" onClick={() => setEditor(selected)}>
                  <Pencil />
                  {t("Edit cohort")}
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => onChange(null)}>
                {t("Remove")}
              </Button>
            </div>
          </PopoverContent>
        </Popover>
        <Button
          variant="secondary"
          size="sm"
          className="px-1.5 text-neutral-500 dark:text-neutral-400"
          onClick={() => onChange(null)}
          aria-label={t("Clear cohort")}
        >
          <X size={14} strokeWidth={2.5} />
        </Button>
      </ButtonGroup>
    ) : null;
  const tab = canRead
    ? (onClose: () => void) => {
        const openEditor = (next: Cohort | "new") => {
          onClose();
          setEditor(next);
        };
        return (
          <div>
            {isLoading ? (
              <div className="flex flex-col gap-2 p-3">
                <Skeleton className="h-8" />
                <Skeleton className="h-8" />
              </div>
            ) : error ? (
              <div role="alert" className="flex items-center justify-between gap-2 p-3 text-sm">
                {t("Unable to load cohorts")}
                <Button size="sm" variant="ghost" onClick={() => void refetch()}>
                  {t("Retry")}
                </Button>
              </div>
            ) : cohorts.length ? (
              <Command>
                <CommandInput placeholder={t("Search cohorts")} />
                <CommandList>
                  <CommandEmpty>{t("No results")}</CommandEmpty>
                  <CommandGroup>
                    {cohorts.map(cohort => (
                      <CommandItem
                        key={cohort.cohortId}
                        value={`${cohort.name} ${cohort.cohortId}`}
                        onSelect={() => {
                          onChange(cohort.cohortId === cohortId ? null : cohort.cohortId);
                          onClose();
                        }}
                        className={cn(
                          "cursor-pointer gap-2 py-2",
                          cohort.cohortId === cohortId && "bg-neutral-100 dark:bg-neutral-750"
                        )}
                      >
                        <Layers className="size-4 shrink-0 text-neutral-500 dark:text-neutral-400" />
                        <span className="min-w-0 flex-1 truncate">{cohort.name}</span>
                        <Check className={cn("size-4 shrink-0", cohort.cohortId !== cohortId && "invisible")} />
                        {canEdit(cohort) && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <button
                                type="button"
                                aria-label={t("Cohort actions")}
                                onClick={event => event.stopPropagation()}
                                onKeyDown={event => event.stopPropagation()}
                                className="-mr-1 rounded p-0.5 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
                              >
                                <MoreHorizontal className="size-4" />
                              </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent
                              align="end"
                              onClick={event => event.stopPropagation()}
                              onKeyDown={event => event.stopPropagation()}
                            >
                              <DropdownMenuItem onClick={() => openEditor(cohort)}>
                                <Pencil className="mr-2 size-4" />
                                {t("Edit cohort")}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            ) : (
              <div className="flex flex-col items-center gap-1.5 px-4 py-6">
                <Layers className="size-6 text-neutral-400 dark:text-neutral-500" />
                <p className="text-sm font-medium">{t("No cohorts yet")}</p>
              </div>
            )}
            {canWrite && (
              <div className="border-t border-neutral-200 p-2 dark:border-neutral-700">
                <Button size="sm" variant="outline" className="w-full gap-1.5" onClick={() => openEditor("new")}>
                  <Plus />
                  {t("New cohort")}
                </Button>
              </div>
            )}
          </div>
        );
      }
    : undefined;

  return (
    <>
      {children({ tab, chip })}
      <Dialog open={editorAllowed} onOpenChange={open => !open && setEditor(null)}>
        <DialogContent className="flex max-h-[90dvh] flex-col overflow-y-auto sm:max-w-xl">
          <DialogTitle>{editor === "new" ? t("New cohort") : t("Edit cohort")}</DialogTitle>
          <DialogDescription>
            {t("Members are visitors matching these filters within retained historical analytics.")}
          </DialogDescription>
          {editorAllowed && editor !== null && (
            <CohortForm
              siteId={siteId}
              cohort={editor === "new" ? undefined : editor}
              availableFilters={availableFilters}
              onSaved={id => {
                onChange(id);
                setEditor(null);
              }}
              onDeleted={() => {
                if (editor !== "new" && editor.cohortId === cohortId) onChange(null);
                setEditor(null);
              }}
              onCancel={() => setEditor(null)}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function CohortForm({
  siteId,
  cohort,
  availableFilters,
  onSaved,
  onDeleted,
  onCancel,
}: {
  siteId: string | number;
  cohort?: Cohort;
  availableFilters: FilterParameter[];
  onSaved: (cohortId: number) => void;
  onDeleted: () => void;
  onCancel: () => void;
}) {
  const t = useExtracted();
  const id = useId();
  const currentFilters = useStore(state => state.filters);
  const currentTime = useStore(state => state.time);
  const currentZone = useTimezone();
  const range = getStartAndEndDate(currentTime, currentZone);
  const today = DateTime.now().setZone(currentZone);
  const start = range.startDate
    ? DateTime.fromISO(range.startDate, { zone: currentZone })
    : currentTime.mode === "past-minutes"
      ? today.minus({ minutes: currentTime.pastMinutesStart })
      : today;
  const [name, setName] = useState(cohort?.name ?? "");
  const [startDate, setStartDate] = useState(cohort?.startDate ?? start.toISODate() ?? "");
  const [endDate, setEndDate] = useState(
    cohort?.endDate ?? (range.endDate ? DateTime.fromISO(range.endDate).toISODate() : today.toISODate()) ?? ""
  );
  const [timeZone, setTimeZone] = useState(cohort?.timeZone ?? currentZone);
  const [filters, setFilters] = useState<Filter[]>(() => structuredClone(cohort?.filters ?? currentFilters));
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerParameter, setPickerParameter] = useState<FilterParameter | null>(null);
  const pendingRef = useRef<() => Filter | null>(() => null);
  const create = useCreateCohort();
  const update = useUpdateCohort();
  const remove = useDeleteCohort();
  const pending = create.isPending || update.isPending || remove.isPending;
  const filterKeys = filterListKeys(filters);

  const addFilter = (filter: Filter) => {
    const index = filters.findIndex(item => item.parameter === filter.parameter && item.type === filter.type);
    setFilters(previous =>
      index < 0 ? [...previous, filter] : previous.map((item, position) => (position === index ? filter : item))
    );
  };
  const pickerChanged = (open: boolean) => {
    if (!open) {
      const filter = pendingRef.current();
      if (filter) addFilter(filter);
      pendingRef.current = () => null;
      setPickerParameter(null);
    }
    setPickerOpen(open);
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!name.trim()) return setError(t("Give the cohort a name."));
    if (!filters.length) return setError(t("Add at least one filter."));
    if (filters.length > 20) return setError(t("Use at most {count, number} filters.", { count: 20 }));
    const validDate = (date: string) =>
      /^\d{4}-\d{2}-\d{2}$/.test(date) && DateTime.fromISO(date, { zone: "UTC" }).toISODate() === date;
    if (!validDate(startDate) || !validDate(endDate) || endDate < startDate)
      return setError(t("Choose a valid historical date range."));
    try {
      new Intl.DateTimeFormat("en", { timeZone: timeZone.trim() }).format();
    } catch {
      return setError(t("Enter a valid IANA timezone."));
    }
    const body = { name: name.trim(), startDate, endDate, timeZone: timeZone.trim(), filters };
    try {
      const saved = cohort
        ? await update.mutateAsync({ siteId, cohortId: cohort.cohortId, body })
        : await create.mutateAsync({ siteId, body });
      onSaved(saved.cohortId);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("Unable to save cohort"));
    }
  };
  const deleteDefinition = async () => {
    if (!cohort) return;
    setError(null);
    try {
      await remove.mutateAsync({ siteId, cohortId: cohort.cohortId });
      onDeleted();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("Unable to delete cohort"));
    }
  };

  return (
    <form onSubmit={save} className="flex flex-col gap-4">
      <div className="space-y-2">
        <Label htmlFor={`${id}-name`}>{t("Name")}</Label>
        <Input id={`${id}-name`} value={name} onChange={event => setName(event.target.value)} maxLength={80} required />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label htmlFor={`${id}-start`}>{t("Historical start date")}</Label>
          <Input
            id={`${id}-start`}
            type="date"
            value={startDate}
            onChange={event => setStartDate(event.target.value)}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${id}-end`}>{t("Historical end date")}</Label>
          <Input
            id={`${id}-end`}
            type="date"
            value={endDate}
            onChange={event => setEndDate(event.target.value)}
            required
          />
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${id}-zone`}>{t("Timezone")}</Label>
        <Input id={`${id}-zone`} value={timeZone} onChange={event => setTimeZone(event.target.value)} required />
      </div>
      <div className="space-y-2">
        <Label>{t("Historical filters")}</Label>
        <div className="flex flex-wrap gap-2">
          {filters.map((filter, index) => (
            <FilterChip
              key={filterKeys[index]}
              filter={filter}
              availableFilters={availableFilters}
              modal
              onUpdate={next =>
                setFilters(previous => previous.map((item, position) => (position === index ? next : item)))
              }
              onRemove={() => setFilters(previous => previous.filter((_, position) => position !== index))}
            />
          ))}
          <Popover open={pickerOpen} onOpenChange={pickerChanged} modal>
            <PopoverTrigger asChild>
              <Button type="button" size="sm" variant="outline" disabled={filters.length >= 20}>
                <Plus />
                {t("Add filter")}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-72 p-0" align="start">
              <FilterPicker
                availableFilters={availableFilters}
                onCommit={addFilter}
                onClose={() => setPickerOpen(false)}
                pendingRef={pendingRef}
                parameter={pickerParameter}
                setParameter={setPickerParameter}
              />
            </PopoverContent>
          </Popover>
        </div>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">{t("Every historical filter must match.")}</p>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <DialogFooter className="flex-wrap gap-2 sm:justify-between">
        <div>
          {cohort?.canEdit && (
            <Button
              type="button"
              variant="ghost"
              className="text-red-600 dark:text-red-400"
              disabled={pending}
              onClick={() => void deleteDefinition()}
            >
              <Trash2 />
              {t("Delete cohort")}
            </Button>
          )}
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="secondary" disabled={pending} onClick={onCancel}>
            {t("Cancel")}
          </Button>
          <Button type="submit" variant="success" loading={pending} loadingLabel={t("Saving...")}>
            {cohort ? t("Save changes") : t("Save cohort")}
          </Button>
        </div>
      </DialogFooter>
    </form>
  );
}
