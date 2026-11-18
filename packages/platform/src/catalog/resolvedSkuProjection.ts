import { z } from "./validation.js";
import {
  CatalogSkuAuthorityError,
  assertPrimaryUnitGtinAuthority,
  neutralSkuEnvelopeV1Schema,
  type NeutralSkuEnvelopeV1,
} from "./foundationSchemas.js";

const uuidSchema = z.guid();
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const currencySchema = z.string().regex(/^[A-Z]{3}$/u);
const moneyMinorSchema = z.number().int().nonnegative();

/**
 * Server-only, read-safe projection. It intentionally composes opaque document
 * references with resolved prices and never selects or exposes document payload.
 */
export const RESOLVED_SKU_PROJECTION_VERSION = "catalog.resolved-sku.v1";

const resolvedSkuProjectionShape = z.object({
  contractVersion: z.literal(RESOLVED_SKU_PROJECTION_VERSION),
  envelope: neutralSkuEnvelopeV1Schema,
  priceContext: z.object({
    priceListId: uuidSchema,
    regionCode: z.string().regex(/^[A-Z]{2,3}$/u),
    currency: currencySchema,
    channel: z.string().trim().min(1).max(64),
    atTime: z.string().datetime({ offset: true }),
  }).strict(),
  pricing: z.object({
    base: z.object({
      priceEntryId: uuidSchema,
      amountMinor: moneyMinorSchema,
    }).strict(),
    subscription: z.object({
      policyRevisionId: uuidSchema,
      policyDigest: digestSchema,
      amountMinor: moneyMinorSchema,
    }).strict().nullable(),
  }).strict(),
}).strict();

export const resolvedSkuProjectionSchema = resolvedSkuProjectionShape.superRefine((projection, context) => {
  try {
    assertPrimaryUnitGtinAuthority(projection.envelope.identifiers);
  } catch (error) {
    if (!(error instanceof CatalogSkuAuthorityError)) throw error;
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["envelope", "identifiers"],
      message: error.code,
    });
  }
  const subscriptionSellable = projection.envelope.sku.sellability.subscription;
  if (subscriptionSellable && projection.pricing.subscription === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["pricing", "subscription"], message: "subscription-sellable SKUs require a subscription price" });
  }
  if (!subscriptionSellable && projection.pricing.subscription !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["pricing", "subscription"], message: "one-time-only SKUs must not carry a subscription price" });
  }
});

export type ResolvedSkuProjection = z.infer<typeof resolvedSkuProjectionSchema>;

/** Row-safe constructor boundary for adapters; it accepts no raw document row/payload. */
export interface ResolvedSkuProjectionInput {
  envelope: NeutralSkuEnvelopeV1;
  priceContext: ResolvedSkuProjection["priceContext"];
  pricing: ResolvedSkuProjection["pricing"];
}

export function buildResolvedSkuProjection(input: ResolvedSkuProjectionInput): ResolvedSkuProjection {
  assertPrimaryUnitGtinAuthority(input.envelope.identifiers);
  return resolvedSkuProjectionSchema.parse({
    contractVersion: RESOLVED_SKU_PROJECTION_VERSION,
    ...input,
  });
}

/** Resolved sale-unit prices paired with exact publication facts. @experimental */
export interface ResolvedSkuProjectionV2 {
  contractVersion: "catalog.resolved-sku.v2";
  envelope: import("./servingRead.js").NeutralSkuEnvelopeV2;
  priceContext: ResolvedSkuProjection["priceContext"];
  pricing: ResolvedSkuProjection["pricing"];
}

/** Compose already-verified publication facts with the caller's price authority. @experimental */
export function buildResolvedSkuProjectionV2(input: Omit<ResolvedSkuProjectionV2, "contractVersion">): ResolvedSkuProjectionV2 {
  assertPrimaryUnitGtinAuthority(input.envelope.identifiers);
  const { envelope, priceContext, pricing } = input;
  // The V1 pricing validator has no quantity policy. Validate the common price
  // context and enforce the same subscription price relationship for V2.
  const parsed = resolvedSkuProjectionShape.pick({ priceContext: true, pricing: true }).parse({ priceContext, pricing });
  if (envelope.sku.sellability.subscription !== (parsed.pricing.subscription !== null)) {
    throw new Error("catalog_resolved_subscription_price_invalid");
  }
  return { contractVersion: "catalog.resolved-sku.v2", envelope, ...parsed };
}
