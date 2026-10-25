import { z } from "zod";
import { CART_STATUSES, CHECKOUT_STATUSES, ORDER_DRAFT_STATUSES, ORDER_STATUSES, PAYMENT_STATUSES } from "./contracts/state.js";

export const cartStatusSchema = z.enum(CART_STATUSES);
export const checkoutStatusSchema = z.enum(CHECKOUT_STATUSES);
export const orderDraftStatusSchema = z.enum(ORDER_DRAFT_STATUSES);
export const orderStatusSchema = z.enum(ORDER_STATUSES);
export const paymentStatusSchema = z.enum(PAYMENT_STATUSES);
export const commerceIdempotencyKeySchema = z
  .string()
  .trim()
  .min(8)
  .max(120)
  .regex(/^[a-zA-Z0-9._:-]+$/);


/** Hosts add their own sizing kinds and profile fields. */
export const commerceSizeConstraintCoreSchema = z.object({
  kind: z.enum(["unit_count", "total_weight_g"]),
  value: z.number().int().positive(),
}).strict();

/** Opaque offer tokens are transported, never interpreted by commerce. */
export const commerceOfferVersionSchema = z.string().max(40).regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/);
export const commerceMinimumUnitsSchema = z.number().int().min(1).max(99);

/** Client asks do not establish trusted checkout admission. */
export function commerceMinimumUnits(input: { minimumUnits?: number | null }, defaultMinimumUnits: number): number {
  return input.minimumUnits ?? defaultMinimumUnits;
}
