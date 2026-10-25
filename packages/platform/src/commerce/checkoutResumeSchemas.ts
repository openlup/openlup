import { z } from "zod";
import { commerceIdempotencyKeySchema } from "./contractPrimitives.js";
export const CHECKOUT_RESUME_CONTRACT_VERSION = "commerce.checkout_resume.v1";
export const checkoutResumeTokenSchema = z.string().trim().min(43).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const checkoutResumeModeSchema = z.enum(["one_time", "subscription"]);
export const checkoutResumeCompletionCoreSchema = z
  .object({
    productSelection: z.boolean().default(false),
    cadence: z.boolean().default(false),
    account: z.boolean().default(false),
    shipping: z.boolean().default(false),
    billing: z.boolean().default(false),
    payment: z.boolean().default(false),
    review: z.boolean().default(false),
  })
  .strict();


export function createCheckoutResumeSchemas<Section extends z.ZodType<string>, Redacted extends z.ZodType<string>, Completion extends z.ZodType>(input: {
  sectionSchema: Section; redactedFieldSchema: Redacted; completionSchema: Completion;
  productSlugSchema: z.ZodType<string, string>; skuSchema: z.ZodType<string, string>;
  additionalForbiddenKeys?: readonly string[];
}) {
  const checkoutResumeSectionIdSchema = input.sectionSchema;
  const checkoutResumeRedactedFieldSchema = input.redactedFieldSchema;
  const commerceProductSlugSchema = input.productSlugSchema;
  const commerceSkuSchema = input.skuSchema;
  const forbiddenKeys = new Set([...FORBIDDEN_RESUME_STATE_KEYS, ...(input.additionalForbiddenKeys ?? [])]);
  const checkoutResumeDraftStateSchema = z
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
      completion: input.completionSchema,
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

      const piiPath = findForbiddenResumeStatePath(state, [], forbiddenKeys);
      if (piiPath) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "checkout resume draft state cannot include raw PII, address or payment fields",
          path: piiPath,
        });
      }
    });

  const checkoutResumeUpsertRequestSchema = z
    .object({
      resumeToken: checkoutResumeTokenSchema.optional(),
      idempotencyKey: commerceIdempotencyKeySchema.optional(),
      lastSectionId: checkoutResumeSectionIdSchema,
      draftState: checkoutResumeDraftStateSchema,
      ttlMinutes: z.number().int().positive().max(10_080).default(120),
    })
    .strict();

  const checkoutResumeReadRequestSchema = z
    .object({
      resumeToken: checkoutResumeTokenSchema,
    })
    .strict();

  const checkoutResumeDraftSchema = z
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

  const checkoutResumeUpsertResponseSchema = z
    .object({
      contractVersion: z.literal(CHECKOUT_RESUME_CONTRACT_VERSION),
      resumeToken: checkoutResumeTokenSchema,
      draft: checkoutResumeDraftSchema,
    })
    .strict();

  const checkoutResumeReadResponseSchema = z
    .object({
      contractVersion: z.literal(CHECKOUT_RESUME_CONTRACT_VERSION),
      draft: checkoutResumeDraftSchema,
    })
    .strict();

  return { checkoutResumeDraftStateSchema, checkoutResumeUpsertRequestSchema, checkoutResumeReadRequestSchema, checkoutResumeDraftSchema, checkoutResumeUpsertResponseSchema, checkoutResumeReadResponseSchema };
}

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
  "card",
  "rawFormPayload",
]);

function findForbiddenResumeStatePath(
  value: unknown,
  path: (string | number)[] = [],
  forbiddenKeys: ReadonlySet<string> = FORBIDDEN_RESUME_STATE_KEYS,
): (string | number)[] | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const result = findForbiddenResumeStatePath(item, [...path, index], forbiddenKeys);
      if (result) return result;
    }
    return null;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    if (forbiddenKeys.has(key)) return [...path, key];
    const result = findForbiddenResumeStatePath(nestedValue, [...path, key], forbiddenKeys);
    if (result) return result;
  }

  return null;
}
