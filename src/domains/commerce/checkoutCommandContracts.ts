import { z } from "../../lib/validation/zod.js";
import { commerceIdempotencyKeySchema, commerceSkuSchema } from "./contracts.js";
import { PAYMENT_ATTEMPT_STATUSES, PAYMENT_INTENT_STATUSES } from "../payment/types.js";

export const CHECKOUT_COMMAND_V1 = "commerce.checkout_command.v1";
export const REFERENCE_CHECKOUT_V1 = "commerce.reference_checkout.v1";

const isoCurrencySchema = z.string().regex(/^[A-Z]{3}$/);

export const checkoutCommandV1Schema = z
  .object({
    version: z.literal(CHECKOUT_COMMAND_V1),
    idempotencyKey: commerceIdempotencyKeySchema,
    mode: z.enum(["one_time", "subscription"]),
    lines: z.array(z.object({
      sku: commerceSkuSchema,
      quantity: z.number().int().positive().max(99),
    }).strict()).min(1).max(50),
    customer: z.object({
      firstName: z.string().trim().min(1).max(80),
      lastName: z.string().trim().min(1).max(80),
      email: z.string().trim().email().max(160),
      phone: z.string().trim().min(6).max(32),
    }).strict(),
    shippingAddress: z.object({
      street: z.string().trim().min(3).max(160),
      postalCode: z.string().trim().min(3).max(16),
      city: z.string().trim().min(2).max(120),
      country: z.string().trim().regex(/^[A-Z]{2}$/),
    }).strict(),
    currency: isoCurrencySchema,
    cadenceDays: z.number().int().positive().max(120).optional(),
  })
  .strict()
  .superRefine((command, ctx) => {
    if (command.mode === "subscription" && command.cadenceDays === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "subscription checkout command requires cadenceDays",
        path: ["cadenceDays"],
      });
    }
    if (command.mode === "one_time" && command.cadenceDays !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "one-time checkout command does not accept cadenceDays",
        path: ["cadenceDays"],
      });
    }
  });

export type CheckoutCommandV1 = z.infer<typeof checkoutCommandV1Schema>;

/**
 * The local reference-store BFF accepts only the neutral command. Payment
 * provider selection stays inside trusted server composition.
 */
export const referenceCheckoutRequestSchema = z.object({
  command: checkoutCommandV1Schema,
}).strict();

export const referenceCheckoutResponseSchema = z.object({
  version: z.literal(REFERENCE_CHECKOUT_V1),
  orderId: z.guid(),
  clientId: z.guid(),
  paymentIntentId: z.guid(),
  paymentAttemptId: z.guid().nullable(),
  paymentStatus: z.enum(PAYMENT_INTENT_STATUSES),
  paymentAttemptStatus: z.enum(PAYMENT_ATTEMPT_STATUSES).nullable(),
  replayed: z.boolean(),
  total: z.object({
    amountMinor: z.number().int().nonnegative(),
    currency: isoCurrencySchema,
  }).strict(),
}).strict();

export type ReferenceCheckoutRequest = z.infer<typeof referenceCheckoutRequestSchema>;
export type ReferenceCheckoutResponse = z.infer<typeof referenceCheckoutResponseSchema>;

/**
 * The persistence result deliberately carries only IDs already owned by the
 * composed persistence adapter. A subject is optional for a generic checkout.
 */
export interface CheckoutCommandPersistenceResult {
  idempotencyKey: string;
  clientId: string;
  subjectId: string | null;
  shippingAddressId: string;
  replayed: boolean;
}
