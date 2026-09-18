import { z } from "../../lib/validation/zod.js";
import {
  commerceIdempotencyKeySchema,
  commerceProductSlugSchema,
  commerceSkuSchema,
} from "./contractPrimitives.js";

export const CHECKOUT_RESUME_CONTRACT_VERSION = "commerce.checkout_resume.v1";

export const checkoutResumeTokenSchema = z
  .string()
  .trim()
  .min(43)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

export const checkoutResumeSectionIdSchema = z.enum([
  "start",
  "pet_profile",
  "product_selection",
  "cadence",
  "account",
  "shipping",
  "billing",
  "payment",
  "review",
]);

export const checkoutResumeRedactedFieldSchema = z.enum([
  "pet_identity",
  "contact",
  "shipping_address",
  "billing_address",
  "delivery_notes",
  "courier_instructions",
  "payment_provider",
  "payment_secret",
  "raw_form_payload",
]);

export const checkoutResumeModeSchema = z.enum(["one_time", "subscription"]);

const checkoutResumeCompletionSchema = z
  .object({
    petProfile: z.boolean().default(false),
    productSelection: z.boolean().default(false),
    cadence: z.boolean().default(false),
    account: z.boolean().default(false),
    shipping: z.boolean().default(false),
    billing: z.boolean().default(false),
    payment: z.boolean().default(false),
    review: z.boolean().default(false),
  })
  .strict();

export const checkoutResumeDraftStateSchema = z
  .object({
    version: z.literal(CHECKOUT_RESUME_CONTRACT_VERSION),
    mode: checkoutResumeModeSchema.nullable().default(null),
    cadenceDays: z.number().int().positive().max(120).nullable().default(null),
    cart: z
      .object({
        items: z
          .array(
            z
              .object({
                sku: commerceSkuSchema,
                productSlug: commerceProductSlugSchema.nullable().default(null),
                variantId: z.string().trim().min(1).max(120).nullable().default(null),
                quantity: z.number().int().positive().max(99),
              })
              .strict(),
          )
          .max(50)
          .default([]),
      })
      .strict()
      .default({ items: [] }),
    completion: checkoutResumeCompletionSchema.default({
      petProfile: false,
      productSelection: false,
      cadence: false,
      account: false,
      shipping: false,
      billing: false,
      payment: false,
      review: false,
    }),
    redactedFields: z.array(checkoutResumeRedactedFieldSchema).max(20).default([]),
  })
  .strict()
  .superRefine((state, ctx) => {
    if (state.mode !== "subscription" && state.cadenceDays !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "cadenceDays can only be set for subscription resume state",
        path: ["cadenceDays"],
      });
    }

    const piiPath = findForbiddenResumeStatePath(state);
    if (piiPath) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "checkout resume draft state cannot include raw PII, address or payment fields",
        path: piiPath,
      });
    }
  });

export const checkoutResumeUpsertRequestSchema = z
  .object({
    resumeToken: checkoutResumeTokenSchema.optional(),
    idempotencyKey: commerceIdempotencyKeySchema.optional(),
    lastSectionId: checkoutResumeSectionIdSchema,
    draftState: checkoutResumeDraftStateSchema,
    ttlMinutes: z.number().int().positive().max(10_080).default(120),
  })
  .strict();

export const checkoutResumeReadRequestSchema = z
  .object({
    resumeToken: checkoutResumeTokenSchema,
  })
  .strict();

export const checkoutResumeDraftSchema = z
  .object({
    id: z.guid(),
    contractVersion: z.literal(CHECKOUT_RESUME_CONTRACT_VERSION),
    lastSectionId: checkoutResumeSectionIdSchema,
    draftState: checkoutResumeDraftStateSchema,
    expiresAt: z.string().datetime({ offset: true }),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    replayed: z.boolean(),
  })
  .strict();

export const checkoutResumeUpsertResponseSchema = z
  .object({
    contractVersion: z.literal(CHECKOUT_RESUME_CONTRACT_VERSION),
    resumeToken: checkoutResumeTokenSchema,
    draft: checkoutResumeDraftSchema,
  })
  .strict();

export const checkoutResumeReadResponseSchema = z
  .object({
    contractVersion: z.literal(CHECKOUT_RESUME_CONTRACT_VERSION),
    draft: checkoutResumeDraftSchema,
  })
  .strict();

export type CheckoutResumeToken = z.infer<typeof checkoutResumeTokenSchema>;
export type CheckoutResumeSectionId = z.infer<typeof checkoutResumeSectionIdSchema>;
export type CheckoutResumeDraftState = z.infer<typeof checkoutResumeDraftStateSchema>;
export type CheckoutResumeUpsertRequest = z.infer<typeof checkoutResumeUpsertRequestSchema>;
export type CheckoutResumeReadRequest = z.infer<typeof checkoutResumeReadRequestSchema>;
export type CheckoutResumeDraft = z.infer<typeof checkoutResumeDraftSchema>;
export type CheckoutResumeUpsertResponse = z.infer<typeof checkoutResumeUpsertResponseSchema>;
export type CheckoutResumeReadResponse = z.infer<typeof checkoutResumeReadResponseSchema>;

const FORBIDDEN_RESUME_STATE_KEYS = new Set([
  "name",
  "firstName",
  "lastName",
  "email",
  "phone",
  "street",
  "postalCode",
  "city",
  "address",
  "shippingAddress",
  "billingAddress",
  "deliveryNotes",
  "courierInstructions",
  "providerPayload",
  "pspReference",
  "paymentProvider",
  "blik",
  "card",
  "rawFormPayload",
]);

function findForbiddenResumeStatePath(
  value: unknown,
  path: (string | number)[] = [],
): (string | number)[] | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const result = findForbiddenResumeStatePath(item, [...path, index]);
      if (result) return result;
    }
    return null;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    if (FORBIDDEN_RESUME_STATE_KEYS.has(key)) return [...path, key];
    const result = findForbiddenResumeStatePath(nestedValue, [...path, key]);
    if (result) return result;
  }

  return null;
}
