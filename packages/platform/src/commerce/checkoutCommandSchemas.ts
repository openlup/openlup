import { z } from "zod";
import { commerceIdempotencyKeySchema } from "./contractPrimitives.js";

export const CHECKOUT_COMMAND_V1 = "commerce.checkout_command.v1";
export const REFERENCE_CHECKOUT_V1 = "commerce.reference_checkout.v1";

const isoCurrencySchema = z.string().regex(/^[A-Z]{3}$/);

export function createCheckoutCommandSchemas<IntentStatus extends z.ZodType<string>, AttemptStatus extends z.ZodType<string>>(schemas: { sku: z.ZodType<string, string>; paymentIntentStatus: IntentStatus; paymentAttemptStatus: AttemptStatus }) {
const checkoutCommandV1Schema = z
  .object({
    version: z.literal(CHECKOUT_COMMAND_V1),
    idempotencyKey: commerceIdempotencyKeySchema,
    mode: z.enum(["one_time", "subscription"]),
    lines: z.array(z.object({
      sku: schemas.sku,
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



/**
 * The local reference-store BFF accepts only the neutral command. Payment
 * provider selection stays inside trusted server composition.
 */
const referenceCheckoutRequestSchema = z.object({
  command: checkoutCommandV1Schema,
}).strict();

const referenceCheckoutResponseSchema = z.object({
  version: z.literal(REFERENCE_CHECKOUT_V1),
  orderId: z.guid(),
  clientId: z.guid(),
  paymentIntentId: z.guid(),
  paymentAttemptId: z.guid().nullable(),
  paymentStatus: schemas.paymentIntentStatus,
  paymentAttemptStatus: schemas.paymentAttemptStatus.nullable(),
  replayed: z.boolean(),
  total: z.object({
    amountMinor: z.number().int().nonnegative(),
    currency: isoCurrencySchema,
  }).strict(),
}).strict();


return { checkoutCommandV1Schema, referenceCheckoutRequestSchema, referenceCheckoutResponseSchema };
}

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

export type CheckoutCommandV1 = z.output<ReturnType<typeof createCheckoutCommandSchemas>["checkoutCommandV1Schema"]>;
