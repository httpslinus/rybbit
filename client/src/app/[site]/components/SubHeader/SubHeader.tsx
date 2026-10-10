"use client";
import { Button } from "@/components/ui/button";
import { canGoBack, canGoForward, goBack, goForward, useStore } from "@/lib/store";
import { FilterParameter } from "@rybbit/shared";
import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Filters, type FilterMatching } from "./Filters/Filters";

import { DateSelector } from "../../../../components/DateSelector/DateSelector";
import { MobileSidebar } from "../Sidebar/MobileSidebar";
import { NewFilterButton, type AdditionalFilterTab } from "./Filters/NewFilterButton";
import { LiveUserCount } from "./LiveUserCount";
import { ShareExportButton } from "./ShareExportButton";

export function SubHeader({
  availableFilters,
  matching,
  filterOptions,
  additionalTab,
  activeFilters,
}: {
  availableFilters?: FilterParameter[];
  matching?: FilterMatching;
  filterOptions?: ReactNode;
  additionalTab?: AdditionalFilterTab;
  activeFilters?: ReactNode;
}) {
  const { time, setTime } = useStore();

  return (
    <div>
      <div className="flex gap-2 justify-between">
        <div className="flex items-center gap-2">
          <MobileSidebar />
          <div className="hidden md:block">
            <NewFilterButton
              availableFilters={availableFilters}
              filterOptions={filterOptions}
              additionalTab={additionalTab}
            />
          </div>
        </div>
        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1 sm:gap-2">
          <LiveUserCount />
          <ShareExportButton />
          <DateSelector time={time} setTime={setTime} />
          <div className="flex items-center">
            <Button
              variant="secondary"
              size="icon"
              onClick={goBack}
              disabled={!canGoBack(time)}
              className="rounded-r-none h-8 w-8"
            >
              <ChevronLeft />
            </Button>
            <Button
              variant="secondary"
              size="icon"
              onClick={goForward}
              disabled={!canGoForward(time)}
              className="rounded-l-none -ml-px h-8 w-8"
            >
              <ChevronRight />
            </Button>
          </div>
        </div>
      </div>
      <div>
        <div className="md:hidden mt-3">
          <NewFilterButton
            availableFilters={availableFilters}
            filterOptions={filterOptions}
            additionalTab={additionalTab}
          />
        </div>
        <div className="mt-2">
          <Filters availableFilters={availableFilters} matching={matching}>
            {activeFilters}
          </Filters>
        </div>
      </div>
    </div>
  );
}
