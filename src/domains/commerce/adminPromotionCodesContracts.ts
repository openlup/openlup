import { z } from "../../lib/validation/zod.js";

import { COMMERCE_CONTRACT_VERSION } from "./types.js";

export const PROMOTION_CODE_STATUSES = ["draft", "active", "paused", "archived"] as const;
export const PROMOTION_CODE_EFFECTIVE_STATUSES = [
  "active",
  "draft",
  "paused",
  "scheduled",
  "expired",
  "archived",
] as const;
export const PROMOTION_CODE_STATUS_FILTERS = [
  ...PROMOTION_CODE_EFFECTIVE_STATUSES,
  "expired_or_archived",
] as const;
export const PROMOTION_CODE_SCOPES = ["one_time", "subscription_initial"] as const;

const nullablePositiveInteger = z.number().int().positive().nullable();
const maximumPromotionFixedMinor = 2_147_483_647;
const optionalDateTime = z.string().datetime({ offset: true }).nullable();
const scopesSchema = z
  .array(z.enum(PROMOTION_CODE_SCOPES))
  .min(1)
  .max(2)
  .refine((scopes) => new Set(scopes).size === scopes.length, {
    message: "Purchase scopes must be unique",
  });

const productTargetBenefitSchema = z.union([
  z.object({ lane: z.literal("product"), kind: z.literal("target_percentage"), valueBps: z.number().int().min(1).max(9_999) }).strict(),
  z.object({ lane: z.literal("product"), kind: z.literal("fixed_amount"), valueMinor: z.number().int().positive().max(maximumPromotionFixedMinor) }).strict(),
]);
const shippingBenefitSchema = z.union([
  z.object({ lane: z.literal("shipping"), kind: z.literal("percentage"), valueBps: z.number().int().min(1).max(9_999) }).strict(),
  z.object({ lane: z.literal("shipping"), kind: z.literal("fixed_amount"), valueMinor: z.number().int().positive().max(maximumPromotionFixedMinor) }).strict(),
  z.object({ lane: z.literal("shipping"), kind: z.literal("free_shipping") }).strict(),
]);
export const promotionCodeBenefitSchema = z.union([
  productTargetBenefitSchema,
  shippingBenefitSchema,
  z.object({ lane: z.literal("product"), kind: z.literal("percentage"), valueBps: z.number().int().min(0) }).strict(),
  z.object({ lane: z.literal("shipping"), kind: z.literal("percentage"), valueBps: z.number().int().min(0) }).strict(),
  z.object({ lane: z.literal("product"), kind: z.literal("fixed_amount"), valueMinor: z.number().int().nonnegative() }).strict(),
  z.object({ lane: z.literal("shipping"), kind: z.literal("fixed_amount"), valueMinor: z.number().int().nonnegative() }).strict(),
  z.object({
    lane: z.enum(["product", "shipping"]),
    kind: z.enum(["percentage", "fixed_amount"]),
    validationState: z.literal("unsupported_legacy_value"),
  }).strict(),
]);
const createBenefitSchema = z.union([productTargetBenefitSchema, shippingBenefitSchema]);

const benefitsSchema = z
  .array(promotionCodeBenefitSchema)
  .min(1)
  .max(2)
  .refine((benefits) => new Set(benefits.map((benefit) => benefit.lane)).size === benefits.length, {
    message: "Only one benefit per adjustment lane is allowed",
  });
const createBenefitsSchema = z
  .array(createBenefitSchema)
  .min(1)
  .max(2)
  .refine((benefits) => new Set(benefits.map((benefit) => benefit.lane)).size === benefits.length, {
    message: "Only one benefit per adjustment lane is allowed",
  });

export const promotionCodePreviewContextSchema = z
  .object({
    referenceProductMinor: z.number().int().positive(),
    oneTimeProductMinor: z.number().int().positive(),
    subscriptionProductMinor: z.number().int().positive(),
    shippingMinor: z.number().int().nonnegative(),
  })
  .strict()
  .refine((value) => value.oneTimeProductMinor <= value.referenceProductMinor, {
    message: "One-time product price cannot exceed the reference price",
  })
  .refine((value) => value.subscriptionProductMinor <= value.referenceProductMinor, {
    message: "Subscription product price cannot exceed the reference price",
  });

export const promotionCodePreviewRequestSchema = z
  .object({
    benefits: benefitsSchema,
    scopes: scopesSchema,
    promotionEngineVersion: z.enum(["promotion-engine.v1", "promotion-engine.v2"]).default("promotion-engine.v2"),
    minimumReferenceMinor: z.number().int().nonnegative().default(0),
    context: promotionCodePreviewContextSchema,
  })
  .strict();

export const promotionCodePreviewResultSchema = z.object({
  scope: z.enum(PROMOTION_CODE_SCOPES),
  productPayableMinor: z.number().int().nonnegative(),
  shippingPayableMinor: z.number().int().nonnegative(),
  effectiveProductDiscountBps: z.number().int().min(0).max(10_000),
  winner: z.enum(["code", "automatic"]),
  floorApplied: z.boolean(),
  adjustments: z.array(
    z.object({
      lane: z.enum(["product", "shipping"]),
      kind: z.enum(["target_percentage", "percentage", "fixed_amount", "free_shipping"]),
      amountOffMinor: z.number().int().nonnegative(),
      beforeMinor: z.number().int().nonnegative(),
      afterMinor: z.number().int().nonnegative(),
    }),
  ),
});

export const promotionCodePreviewResponseSchema = z.object({
  contractVersion: z.literal(COMMERCE_CONTRACT_VERSION),
  promotionEngineVersion: z.enum(["promotion-engine.v1", "promotion-engine.v2"]),
  previewProof: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  results: z.array(promotionCodePreviewResultSchema).length(2),
});

export const promotionCodeCreateRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).nullable().default(null),
    code: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("automatic") }).strict(),
      z.object({ kind: z.literal("manual"), value: z.string().trim().min(3).max(64).regex(/^[A-Za-z0-9_-]+$/) }).strict(),
    ]),
    benefits: createBenefitsSchema,
    scopes: scopesSchema,
    validFrom: z.string().datetime({ offset: true }),
    validTo: optionalDateTime,
    minimumReferenceMinor: z.number().int().nonnegative().default(0),
    redemptionLimitGlobal: nullablePositiveInteger.default(null),
    redemptionLimitPerCustomer: nullablePositiveInteger.default(null),
    status: z.enum(["draft", "active"]).default("draft"),
    previewContext: promotionCodePreviewContextSchema.optional(),
    previewProof: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),
    idempotencyKey: z.string().uuid(),
  })
  .strict()
  .refine((value) => value.validTo === null || Date.parse(value.validTo) > Date.parse(value.validFrom), {
    message: "validTo must be after validFrom",
  })
  .refine(
    (value) => value.status !== "active" || Boolean(value.previewContext && value.previewProof),
    { message: "Active codes require a successful backend preview" },
  );

export const promotionCodeCreateResponseSchema = z.object({
  contractVersion: z.literal(COMMERCE_CONTRACT_VERSION),
  id: z.string().uuid(),
  code: z.string().min(3).max(64),
  status: z.enum(PROMOTION_CODE_STATUSES),
  revision: z.number().int().positive(),
  idempotent: z.boolean(),
});

export const promotionCodeUpdateRequestSchema = z
  .object({
    id: z.string().uuid(),
    expectedRevision: z.number().int().positive(),
    updates: z
      .object({
        status: z.enum(PROMOTION_CODE_STATUSES).optional(),
        validFrom: z.string().datetime({ offset: true }).optional(),
        validTo: optionalDateTime.optional(),
        redemptionLimitGlobal: nullablePositiveInteger.optional(),
        redemptionLimitPerCustomer: nullablePositiveInteger.optional(),
      })
      .strict()
      .refine((updates) => Object.values(updates).some((value) => value !== undefined), {
        message: "At least one field is required",
      }),
    previewContext: promotionCodePreviewContextSchema.optional(),
    previewProof: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),
    idempotencyKey: z.string().uuid(),
  })
  .strict()
  ;

export const promotionCodeUpdateResponseSchema = z.object({
  contractVersion: z.literal(COMMERCE_CONTRACT_VERSION),
  id: z.string().uuid(),
  status: z.enum(PROMOTION_CODE_STATUSES),
  revision: z.number().int().positive(),
  idempotent: z.boolean(),
});

export const promotionCodesListRequestSchema = z
  .object({
    q: z.string().trim().min(1).max(80).optional(),
    status: z.enum([...PROMOTION_CODE_STATUS_FILTERS, "all"]).default("active"),
    scope: z.enum([...PROMOTION_CODE_SCOPES, "both", "shipping", "all"]).default("all"),
    cursor: z.string().max(500).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

export const promotionCodeSummarySchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  benefits: benefitsSchema,
  promotionEngineVersion: z.enum(["promotion-engine.v1", "promotion-engine.v2"]),
  scopes: scopesSchema,
  status: z.enum(PROMOTION_CODE_STATUSES),
  effectiveStatus: z.enum(PROMOTION_CODE_EFFECTIVE_STATUSES),
  validFrom: z.string(),
  validTo: z.string().nullable(),
  minimumReferenceMinor: z.number().int().nonnegative(),
  redemptionLimitGlobal: z.number().int().positive().nullable(),
  redemptionLimitPerCustomer: z.number().int().positive().nullable(),
  redeemedCount: z.number().int().nonnegative(),
  reservedCount: z.number().int().nonnegative(),
  remainingCount: z.number().int().nonnegative().nullable(),
  createdAt: z.string(),
  revision: z.number().int().positive(),
});

export const promotionCodesListResponseSchema = z.object({
  contractVersion: z.literal(COMMERCE_CONTRACT_VERSION),
  codes: z.array(promotionCodeSummarySchema),
  nextCursor: z.string().nullable(),
  capabilities: z.object({
    mutationsEnabled: z.boolean(),
  }).strict(),
  legacyCompatibility: z.object({
    ready: z.boolean(),
    unprojectedCount: z.number().int().nonnegative(),
    collisionGroupCount: z.number().int().nonnegative(),
  }).strict(),
});

export type PromotionCodeBenefit = z.infer<typeof promotionCodeBenefitSchema>;
export type PromotionCodePreviewRequest = z.infer<typeof promotionCodePreviewRequestSchema>;
export type PromotionCodePreviewResponse = z.infer<typeof promotionCodePreviewResponseSchema>;
export type PromotionCodeCreateRequest = z.infer<typeof promotionCodeCreateRequestSchema>;
export type PromotionCodeCreateResponse = z.infer<typeof promotionCodeCreateResponseSchema>;
export type PromotionCodeUpdateRequest = z.infer<typeof promotionCodeUpdateRequestSchema>;
export type PromotionCodeUpdateResponse = z.infer<typeof promotionCodeUpdateResponseSchema>;
export type PromotionCodesListRequest = z.infer<typeof promotionCodesListRequestSchema>;
export type PromotionCodeSummary = z.infer<typeof promotionCodeSummarySchema>;
export type PromotionCodesListResponse = z.infer<typeof promotionCodesListResponseSchema>;
