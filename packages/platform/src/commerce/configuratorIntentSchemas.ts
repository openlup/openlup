import { z } from "zod";
import { commerceIdempotencyKeySchema, commerceMinimumUnits, commerceMinimumUnitsSchema, commerceOfferVersionSchema } from "./contractPrimitives.js";
export const CONFIGURATOR_INTENT_VERSION = "commerce.configurator_intent.v1";
export const configuratorModeSchema = z.enum(["one_time", "subscription"]);
export const configuratorContactSchema = z.object({
  firstName: z.string().trim().min(1).max(80), lastName: z.string().trim().min(1).max(80),
  email: z.string().trim().email().max(160), phone: z.string().trim().min(6).max(32),
}).strict();
export const configuratorAddressCoreSchema = z.object({
  street: z.string().trim().min(3).max(160), postalCode: z.string().trim().min(3).max(16),
  city: z.string().trim().min(2).max(120), country: z.string().regex(/^[A-Z]{2}$/),
}).strict();
export function createConfiguratorIntentSchemas(skuSchema: z.ZodType<string, string>) {
  const configuratorVariantCoreSchema = z.object({
    variantId: z.string().trim().min(1).max(120),
    sku: skuSchema,
    qty: z.number().int().positive().max(99),
  }).strict();
  const configuratorIntentCoreSchema = z.object({
    version: z.literal(CONFIGURATOR_INTENT_VERSION),
    idempotencyKey: commerceIdempotencyKeySchema,
    mode: configuratorModeSchema,
    cadenceDays: z.number().int().positive().max(120).nullable().default(null),
    promoCodes: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
    visitorId: z.string().trim().min(1).max(120).optional(),
    contact: configuratorContactSchema,
    address: configuratorAddressCoreSchema,
    selectedVariants: z.array(configuratorVariantCoreSchema).min(1).max(50),
    offerVersion: commerceOfferVersionSchema.optional(),
    minimumUnits: commerceMinimumUnitsSchema.optional(),
  }).strict();
  return { configuratorVariantCoreSchema, configuratorIntentCoreSchema };
}

export function validateConfiguratorIntentCore(intent: {
  mode: "one_time" | "subscription"; cadenceDays: number | null; minimumUnits?: number;
  selectedVariants: readonly { qty: number }[];
}, ctx: z.RefinementCtx, defaultMinimumUnits: number): void {
  if (intent.mode === "subscription" && !intent.cadenceDays) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "subscription intent requires cadenceDays", path: ["cadenceDays"] });
  }
  const selectedUnitCount = intent.selectedVariants.reduce((total, variant) => total + variant.qty, 0);
  const minimumUnits = commerceMinimumUnits(intent, defaultMinimumUnits);
  if (selectedUnitCount < minimumUnits) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `selected variants require at least ${minimumUnits} total units`, path: ["selectedVariants"] });
  }
}
