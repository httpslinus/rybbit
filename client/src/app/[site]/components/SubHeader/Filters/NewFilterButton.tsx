"use client";

import { Filter, FilterParameter, Segment } from "@rybbit/shared";
import { ListFilterPlus } from "lucide-react";
import { useExtracted } from "next-intl";
import { type ReactNode, useRef, useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../../../../components/ui/basic-tabs";
import { Button } from "../../../../../components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../../../../../components/ui/popover";
import { useCanOnSite } from "../../../../../hooks/usePermissions";
import { addFilter, useStore } from "../../../../../lib/store";
import { FilterPicker } from "./FilterPicker";
import { SegmentDialog } from "./SegmentDialog";
import { SegmentsTab } from "./SegmentsTab";

type Tab = "filters" | "segments" | "report";
type DialogState = { segment?: Segment; initialFilters?: Filter[] } | null;

export interface AdditionalFilterTab {
  label: ReactNode;
  content: (onClose: () => void) => ReactNode;
}

/**
 * The shared filter picker and saved segments. Reports can supply local
 * options and another saved-group tab without adding idle toolbar controls.
 */
export function NewFilterButton({
  availableFilters,
  filterOptions,
  additionalTab,
}: {
  availableFilters?: FilterParameter[];
  filterOptions?: ReactNode;
  additionalTab?: AdditionalFilterTab;
}) {
  const t = useExtracted();
  const { site, privateKey, filters } = useStore();
  const canWriteSegments = useCanOnSite("segments:write", site);

  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("filters");
  const [parameter, setParameter] = useState<FilterParameter | null>(null);
  const pendingRef = useRef<() => Filter | null>(() => null);
  const [dialog, setDialog] = useState<DialogState>(null);

  // Public viewers get no permissions from the server; the private-link view
  // is read-only by design even for members.
  const canWrite = !privateKey && canWriteSegments;

  const resetPicker = () => {
    pendingRef.current = () => null;
    setParameter(null);
  };

  const handleOpenChange = (isOpen: boolean) => {
    if (!isOpen) {
      const pending = pendingRef.current();
      if (pending) addFilter(pending);
      resetPicker();
    }
    setOpen(isOpen);
  };

  // Closing from an action that already did its work must not commit a
  // half-built filter left behind on the Filters tab.
  const closePopover = () => {
    resetPicker();
    setOpen(false);
  };

  const selectTab = (next: Tab) => {
    if (next !== tab) resetPicker();
    setTab(next);
  };

  const openDialog = (state: NonNullable<DialogState>) => {
    closePopover();
    setDialog(state);
  };

  return (
    <>
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <Button size="sm" variant="outline" className="gap-1.5">
            <ListFilterPlus className="w-4 h-4" />
            {t("Filter")}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-72 max-w-[calc(100vw-1rem)] p-0" align="start">
          <Tabs
            value={tab === "report" && !additionalTab ? "filters" : tab}
            onValueChange={value => selectTab(value as Tab)}
          >
            {/* Full-width underline tabs; -mb-px lays the underline over the list's hairline. */}
            <TabsList className="flex h-auto w-full space-x-0 border-b border-neutral-200 dark:border-neutral-700">
              <TabsTrigger value="filters" className="-mb-px flex-1 py-2 text-xs">
                {t("Filters")}
              </TabsTrigger>
              <TabsTrigger value="segments" className="-mb-px flex-1 py-2 text-xs">
                {t("Segments")}
              </TabsTrigger>
              {additionalTab && (
                <TabsTrigger value="report" className="-mb-px flex-1 py-2 text-xs">
                  {additionalTab.label}
                </TabsTrigger>
              )}
            </TabsList>
            <TabsContent value="filters" className="mt-0">
              {parameter === null && filterOptions}
              <FilterPicker
                availableFilters={availableFilters}
                onCommit={addFilter}
                onClose={closePopover}
                pendingRef={pendingRef}
                parameter={parameter}
                setParameter={setParameter}
              />
            </TabsContent>
            {additionalTab && (
              <TabsContent value="report" className="mt-0">
                {additionalTab.content(() => setOpen(false))}
              </TabsContent>
            )}
            <TabsContent value="segments" className="mt-0">
              <SegmentsTab
                siteId={site}
                canWrite={canWrite}
                onNew={() => openDialog({})}
                onSaveCurrent={() => openDialog({ initialFilters: filters })}
                onEdit={segment => openDialog({ segment })}
                onApplied={closePopover}
              />
            </TabsContent>
          </Tabs>
        </PopoverContent>
      </Popover>
      <SegmentDialog
        open={dialog !== null}
        onOpenChange={isOpen => !isOpen && setDialog(null)}
        siteId={site}
        segment={dialog?.segment}
        initialFilters={dialog?.initialFilters}
        availableFilters={availableFilters}
      />
    </>
  );
}
