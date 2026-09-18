import { platformCurrencySchema } from "../../lib/currency/platformCurrency.js";
import { z } from "../../lib/validation/zod.js";
import { catalogProductSlugSchema } from "../catalog/contracts.js";
import {
  CART_STATUSES,
  CHECKOUT_STATUSES,
  ORDER_DRAFT_STATUSES,
  ORDER_STATUSES,
  PAYMENT_STATUSES,
} from "./types.js";

// Alias, not a second definition: one schema object validates currency on every
// commerce contract (src/lib/currency/platformCurrency.ts).
export const commerceCurrencySchema = platformCurrencySchema;
export const commerceTaxCountrySchema = z.string().trim().regex(/^[A-Z]{2}$/);
export const commerceTaxCategorySchema = z.string().trim().regex(/^[a-z][a-z0-9_]*$/);
export const commerceTaxLegalBasisSchema = z.string().trim().min(1).max(200);
export const cartStatusSchema = z.enum(CART_STATUSES);
export const checkoutStatusSchema = z.enum(CHECKOUT_STATUSES);
export const orderDraftStatusSchema = z.enum(ORDER_DRAFT_STATUSES);
export const orderStatusSchema = z.enum(ORDER_STATUSES);
export const paymentStatusSchema = z.enum(PAYMENT_STATUSES);
// Open value space — format-validated slugs, not a closed enum (see slugFormat.ts).
export const commerceProductSlugSchema = catalogProductSlugSchema;

export const commerceIdempotencyKeySchema = z
  .string()
  .trim()
  .min(8)
  .max(120)
  .regex(/^[a-zA-Z0-9._:-]+$/);

export const commerceSkuSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9._:-]+$/);

export const commerceMoneySchema = z.object({
  amountMinor: z.number().int().nonnegative(),
  currency: commerceCurrencySchema,
});

// Single source of truth for the size constraint carried by both the configurator
// intent and the quote request — the two surfaces validate the identical shape and
// refine rule, so they share one schema instead of maintaining byte-identical copies.
export const commerceSizeConstraintSchema = z
  .object({
    kind: z.enum(["unit_count", "total_weight_g", "feeding_days"]),
    value: z.number().int().positive(),
    petId: z.string().trim().min(1).max(120).nullable().optional(),
    dailyKcalOverride: z.number().int().positive().nullable().optional(),
  })
  .strict()
  .superRefine((constraint, ctx) => {
    if (constraint.kind === "feeding_days" && !constraint.dailyKcalOverride) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "feeding_days size constraint requires dailyKcalOverride",
        path: ["dailyKcalOverride"],
      });
    }
  });
