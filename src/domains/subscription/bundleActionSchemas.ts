import { z } from "../../lib/validation/zod.js";

const uuidSchema = z.guid();

export const subscriptionCoreBundleLineSchema = z.object({
  variantId: uuidSchema,
  qty: z.number().int().positive().max(99),
  isAddon: z.literal(false).default(false),
}).strict();

export const subscriptionAddonBundleLineSchema = z.object({
  variantId: uuidSchema,
  qty: z.number().int().positive().max(99),
  isAddon: z.literal(true).default(true),
}).strict();

export const compositionConstraintSchema = z
  .record(z.string(), z.unknown())
  .superRefine((constraint, ctx) => {
    if ("version" in constraint || "data" in constraint) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "compositionConstraint must use the flat pre-envelope shape before Wave 13",
      });
    }
  });

export const compositionResizeLeverSchema = z
  .object({
    kind: z.string().trim().min(1).max(80),
    value: z.unknown().optional(),
  })
  .strict();
