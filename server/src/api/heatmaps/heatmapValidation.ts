import { z } from "zod";
import { sanitizeHeatmapSnapshot } from "@rybbit/shared";

const uint32Dimension = z.number().finite().int().positive().max(0xffffffff);
const viewportDimension = z.number().finite().int().positive().max(65535);
const coordinate = z.number().finite().nonnegative();
const boundedId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\u0000-\u001f\u007f]+$/);

const geometry = {
  timestamp: z.number().finite().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  pageVisitId: boundedId,
  hostname: z
    .string()
    .min(1)
    .max(253)
    .toLowerCase()
    .refine(hostname => {
      try {
        return new URL(`https://${hostname}`).hostname === hostname;
      } catch {
        return false;
      }
    }, "Invalid captured hostname"),
  // Mask patterns may be regex strings rather than slash-prefixed paths.
  pathname: z
    .string()
    .min(1)
    .max(2048)
    .regex(/^[^\u0000-\u001f\u007f]+$/),
  viewportWidth: viewportDimension,
  viewportHeight: viewportDimension,
  documentWidth: uint32Dimension,
  documentHeight: uint32Dimension,
};

export const heatmapEventSchema = z
  .discriminatedUnion("type", [
    z
      .object({
        ...geometry,
        type: z.literal("click"),
        clientX: coordinate,
        clientY: coordinate,
        pageX: coordinate,
        pageY: coordinate,
      })
      .strict(),
    z
      .object({
        ...geometry,
        type: z.literal("scroll"),
        maxDepth: z.number().finite().min(0).max(100),
      })
      .strict(),
  ])
  .superRefine((event, context) => {
    if (event.documentWidth < event.viewportWidth || event.documentHeight < event.viewportHeight) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Document dimensions cannot be smaller than the viewport",
      });
    }
    if (
      event.type === "click" &&
      (event.clientX > event.viewportWidth ||
        event.clientY > event.viewportHeight ||
        event.pageX > event.documentWidth ||
        event.pageY > event.documentHeight ||
        event.pageX < event.clientX ||
        event.pageY < event.clientY)
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Click coordinates exceed captured geometry" });
    }
  });

export const recordHeatmapsSchema = z
  .object({
    batchId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[^\u0000-\u001f\u007f]+$/),
    events: z.array(heatmapEventSchema).min(1).max(100),
    userId: z.string().max(256).trim().optional(),
    anonymousId: z.string().max(256).trim().min(1).optional(),
  })
  .strict();

export const heatmapSnapshotContextSchema = z
  .object({
    hostname: geometry.hostname,
    pathname: geometry.pathname,
    viewportWidth: viewportDimension,
    viewportHeight: viewportDimension,
    documentWidth: uint32Dimension,
    documentHeight: uint32Dimension,
  })
  .strict()
  .refine(
    context => context.documentWidth >= context.viewportWidth && context.documentHeight >= context.viewportHeight,
    "Document dimensions cannot be smaller than the viewport"
  );

export const recordHeatmapSnapshotSchema = z
  .object({
    ...geometry,
    key: z.string().regex(/^heatmap-snapshot:\d+:[a-f0-9]{64}$/),
    token: z.string().uuid(),
    node: z.unknown().transform((node, context) => {
      try {
        return sanitizeHeatmapSnapshot(node);
      } catch {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid or oversized heatmap snapshot" });
        return z.NEVER;
      }
    }),
  })
  .strict()
  .refine(
    context => context.documentWidth >= context.viewportWidth && context.documentHeight >= context.viewportHeight,
    "Document dimensions cannot be smaller than the viewport"
  );
