import { COHORT_MAX_FILTERS, COHORT_NAME_MAX_LENGTH } from "@rybbit/shared";
import { DateTime } from "luxon";
import { z } from "zod";
import { normalizeHeatmapTimeZone } from "../../../services/heatmaps/heatmapTimeZone.js";
import { segmentFilterSchema } from "../segments/segmentSchema.js";
import { dateRegex } from "../utils/timeWindow.js";

const calendarDate = z
  .string()
  .regex(dateRegex, "Use YYYY-MM-DD")
  .refine(
    value => Number(value.slice(0, 4)) >= 1 && DateTime.fromISO(value, { zone: "UTC" }).toISODate() === value,
    "Invalid calendar date"
  );

const windowFields = {
  startDate: calendarDate,
  endDate: calendarDate,
  timeZone: z
    .string()
    .max(100)
    .transform((value, context) => {
      const timeZone = normalizeHeatmapTimeZone(value);
      if (!timeZone) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid time zone" });
        return z.NEVER;
      }
      return timeZone;
    }),
};

export const cohortWindowSchema = z.object(windowFields).refine(window => window.startDate <= window.endDate, {
  message: "Start date must be on or before end date",
  path: ["endDate"],
});

const cohortFields = {
  name: z.string().trim().min(1, "Cohort name is required").max(COHORT_NAME_MAX_LENGTH),
  ...windowFields,
  filters: z.array(segmentFilterSchema).min(1, "A cohort needs at least one filter").max(COHORT_MAX_FILTERS),
};

export const createCohortSchema = z
  .object(cohortFields)
  .strict()
  .refine(window => window.startDate <= window.endDate, {
    message: "Start date must be on or before end date",
    path: ["endDate"],
  });

export const updateCohortSchema = z
  .object(cohortFields)
  .partial()
  .strict()
  .refine(body => Object.keys(body).length > 0, "At least one cohort field is required")
  .refine(body => !body.startDate || !body.endDate || body.startDate <= body.endDate, {
    message: "Start date must be on or before end date",
    path: ["endDate"],
  });
