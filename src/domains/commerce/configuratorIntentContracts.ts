import { z } from "../../lib/validation/zod.js";
import { catalogAllergenSlugSchema } from "../catalog/contracts.js";
import {
  commerceProductSlugSchema,
  commerceSkuSchema,
} from "./contracts.js";
import { commerceSizeConstraintSchema } from "./contractPrimitives.js";
import { commerceRecommendationSnapshotSchema } from "./recommendationContracts.js";
import {
  deliveryCarrierKindSchema,
  deliveryKindSchema,
  deliveryProviderKindSchema,
  deliveryServiceSchema,
  pickupPointSchema,
} from "../shipping/contracts.js";
import { acquisitionCapabilitySchema } from "@openlup/platform/pricing/browser";
import { createConfiguratorIntentSchemas, configuratorContactSchema, configuratorAddressCoreSchema, validateConfiguratorIntentCore } from "@openlup/platform/commerce";
import { COMMERCE_MIN_ORDER_UNITS } from "./recommendationPolicyDeps.js";
import { starterOfferIntentSchema } from "./starterOfferContracts.js";

export { CONFIGURATOR_INTENT_VERSION, configuratorModeSchema } from "@openlup/platform/commerce";
export const CONFIGURATOR_FIXED_CADENCE_POLICY_VERSION =
  "commerce.configurator_fixed_cadence_14_21_28.v1";

export const configuratorPetAgeBandSchema = z.enum(["puppy", "young", "adult", "senior"]);
export const configuratorActivityLevelSchema = z.enum(["low", "normal", "high"]);
export const configuratorBcsSchema = z.enum(["thin", "ideal", "overweight"]);

export const configuratorCadenceDaysSchema = z.union([
  z.literal(14),
  z.literal(21),
  z.literal(28),
]);
export const configuratorDeliveryKindSchema = z.enum(["parcel-locker", "courier"]);
export const configuratorPaymentMethodSchema = z.enum(["blik", "card", "transfer"]);
// Open value space — format-validated slugs, not a closed enum (see slugFormat.ts).
export const configuratorAllergenSlugSchema = catalogAllergenSlugSchema;

export const configuratorSizeConstraintSchema = commerceSizeConstraintSchema;

const { configuratorIntentCoreSchema, configuratorVariantCoreSchema } = createConfiguratorIntentSchemas(commerceSkuSchema);
// Interleave host and core fields in legacy order, including validation issues.
export const configuratorIntentSchema = configuratorIntentCoreSchema
  .pick({ version: true })
  .extend({
    // Additive rollout discriminator. The deployed persistence RPC accepts
    // extra JSON fields but hard-requires intent v1, so this marker lets new
    // writers opt into the fixed rhythms without invalidating in-flight v1
    // payloads that used the former coverage-derived cadence.
    cadencePolicyVersion: z.literal(CONFIGURATOR_FIXED_CADENCE_POLICY_VERSION).optional(),
    idempotencyKey: configuratorIntentCoreSchema.shape.idempotencyKey,
    locale: z.enum(["pl", "en"]).default("pl"),
    mode: configuratorIntentCoreSchema.shape.mode,
    cadenceDays: configuratorIntentCoreSchema.shape.cadenceDays,
    promoCodes: configuratorIntentCoreSchema.shape.promoCodes,
    visitorId: configuratorIntentCoreSchema.shape.visitorId,
    sizeConstraint: configuratorSizeConstraintSchema,
    petProfile: z
      .object({
        // Account order flow only: the existing pet this order is for. When
        // present (and owned by the resolved client), persistence reuses that
        // pet instead of inserting a duplicate. Absent/null in the public flow.
        petId: z.string().trim().min(1).max(120).nullable().optional(),
        name: z.string().trim().min(1).max(80),
        ageBand: configuratorPetAgeBandSchema,
        breed: z.string().trim().min(1).max(120),
        weightKg: z.number().positive().max(120),
        activityLevel: configuratorActivityLevelSchema,
        bcs: configuratorBcsSchema,
        allergenSlugs: z.array(configuratorAllergenSlugSchema).max(20).default([]),
        dailyKcalOverride: z.number().int().positive().nullable().default(null),
      })
      .strict(),
    contact: configuratorContactSchema,
    address: configuratorAddressCoreSchema.extend({ country: z.literal("PL") }),
    selectedDelivery: z
      .object({
        kind: configuratorDeliveryKindSchema,
        deliveryKind: deliveryKindSchema.optional(),
        providerKind: deliveryProviderKindSchema.nullable().optional(),
        providerRef: z.string().trim().min(1).max(120).nullable().default(null),
        carrierKind: deliveryCarrierKindSchema.nullable().optional(),
        carrierCode: z.string().trim().min(1).max(80).nullable().optional(),
        service: deliveryServiceSchema.nullable().optional(),
        serviceCode: z.string().trim().min(1).max(120).nullable().optional(),
        pickupPoint: pickupPointSchema.nullable().optional(),
      })
      .strict()
      .transform((delivery) => ({ ...delivery, deliveryKind: delivery.deliveryKind ?? delivery.kind }))
      .superRefine((delivery, ctx) => {
        if (delivery.pickupPoint && delivery.kind !== "parcel-locker") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "pickupPoint is only valid for parcel-locker delivery",
            path: ["pickupPoint"],
          });
        }
        if (delivery.kind === "parcel-locker" && delivery.pickupPoint && delivery.carrierKind !== "inpost") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "parcel-locker pickupPoint requires inpost carrierKind",
            path: ["carrierKind"],
          });
        }
        if (delivery.providerKind === "omnipack" && (!delivery.carrierCode || !delivery.serviceCode)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "OmniPack delivery requires carrierCode and serviceCode",
            path: ["serviceCode"],
          });
        }
      }),
    selectedFlavorSlugs: z.array(commerceProductSlugSchema).min(1).max(12),
    selectedVariants: z
      .array(
        configuratorVariantCoreSchema.omit({ qty: true })
          .extend({ flavorSlug: commerceProductSlugSchema, qty: configuratorVariantCoreSchema.shape.qty }),
      )
      .min(1)
      .max(50),
    recommendationSnapshot: commerceRecommendationSnapshotSchema.nullable().optional(),
    // Starter-pack acquisition ASK. Entirely untrusted: the checkout guard
    // recomputes every term from the real basket and rejects a mismatch the same
    // way a moved total is rejected. Absent means the ordinary acquisition path.
    starterOffer: starterOfferIntentSchema.optional(),
    acquisitionCapability: acquisitionCapabilitySchema.optional(),
    consents: z
      .object({
        gdpr: z.literal(true),
        marketing: z.boolean().default(false),
        terms: z.literal(true),
      })
      .strict(),
    paymentMethodIntent: z
      .object({
        method: configuratorPaymentMethodSchema,
        saveForSubscription: z.boolean().default(false),
      })
      .strict(),
    consciousAllergenOverride: z.boolean().default(false),
    offerVersion: configuratorIntentCoreSchema.shape.offerVersion,
    minimumUnits: configuratorIntentCoreSchema.shape.minimumUnits,
  })
  .strict()
  .superRefine((intent, ctx) => {
    if (
      intent.cadencePolicyVersion === CONFIGURATOR_FIXED_CADENCE_POLICY_VERSION &&
      intent.cadenceDays != null &&
      !configuratorCadenceDaysSchema.safeParse(intent.cadenceDays).success
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "fixed-cadence configurator intents require a 14, 21 or 28 day cadence",
        path: ["cadenceDays"],
      });
    }

    validateConfiguratorIntentCore(intent, ctx, COMMERCE_MIN_ORDER_UNITS);

    const flavorSlugs = new Set(intent.selectedFlavorSlugs);
    for (const [index, variant] of intent.selectedVariants.entries()) {
      if (!flavorSlugs.has(variant.flavorSlug)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "selected variant flavor must be present in selectedFlavorSlugs",
          path: ["selectedVariants", index, "flavorSlug"],
        });
      }
    }

    // ...and the reverse: every declared flavor must resolve to at least one
    // ordered variant. A flavorSlug with no line is a buyable nothing — the
    // server rejects it as an invalid checkout, so catch the drift here (loud,
    // deterministic) rather than letting it surface as a silent 400.
    const variantFlavorSlugs = new Set(intent.selectedVariants.map((variant) => variant.flavorSlug));
    for (const [index, flavorSlug] of intent.selectedFlavorSlugs.entries()) {
      if (!variantFlavorSlugs.has(flavorSlug)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "selected flavor must resolve to at least one selected variant",
          path: ["selectedFlavorSlugs", index],
        });
      }
    }
  });

export type ConfiguratorIntent = z.infer<typeof configuratorIntentSchema>;
export type ConfiguratorSizeConstraint = z.infer<typeof configuratorSizeConstraintSchema>;
