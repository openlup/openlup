import {
  configuratorIntentSchema,
  CONFIGURATOR_FIXED_CADENCE_POLICY_VERSION,
  CONFIGURATOR_INTENT_VERSION,
  type ConfiguratorIntent,
} from "@/domains/commerce/configuratorIntentContracts";

import type { StarterOfferIntent } from "@/domains/commerce/starterOfferContracts";
import {
  STARTER_DELIVERY2_DISCOUNT_BPS,
  STARTER_OFFER_CAPABILITY,
  starterTermsFromCoverage,
} from "@/domains/commerce/starterOfferPolicy";

import type { DeliveryOption, PickupPoint } from "@/domains/shipping/deliverySelectionContracts";
import type { ConfiguratorFormData } from "@/checkout/composer/configuratorFormStore";
import { isCheckoutableRecommendation } from "./recommendationGate";
import { resolveConfiguratorPackageQuantities } from "@/checkout/composer/configuratorPackageQuantities";
import { getOrCreateVisitorId } from "./visitorId";

/**
 * Build the public one-time or subscription checkout intent from the
 * configurator form.
 *
 * Variant IDs and SKUs come from the commerce-BFF recommendation. Quantities
 * use validated customer overrides while the original snapshot remains audit
 * evidence.
 *
 * Returns `null` when the form cannot produce a schema-valid intent or the
 * selected subscription contract is gated off. Callers surface that state and
 * must not reinterpret it as a different purchase mode.
 */
export function buildCheckoutIntent(
  data: ConfiguratorFormData,
  options: {
    idempotencyKey: string;
    locale?: "pl" | "en";
    subscriptionCheckoutEnabled?: boolean;
    deliverySelectionEnabled?: boolean;
    dhlOnlyDeliveryEnabled?: boolean;
    /**
     * Line γ seam. The composition vocabulary this deployment recognises, supplied by the
     * openlup composition root — the machine never reads what the slugs *mean*, only
     * whether the form carries at least one the vertical still recognises. This is the
     * brief's opaque-envelope shape: dispatch on membership, never on content.
     *
     * ⛔ Required, not defaulted. A default here would silently accept a form whose
     * composition the vertical has stopped recognising.
     */
    knownCompositionSlugs: readonly string[];
  },
): ConfiguratorIntent | null {
  const recognisedComposition = data.flavors.filter((slug) =>
    options.knownCompositionSlugs.includes(slug),
  );
  if (recognisedComposition.length === 0) return null;

  const ageBand = data.dogAge as ConfiguratorIntent["petProfile"]["ageBand"];
  const weightKg = Number(data.dogWeightKg.replace(",", ".").trim());
  if (!Number.isFinite(weightKg) || weightKg <= 0) return null;
  if (!isCheckoutableRecommendation(data.recommendationSnapshot)) return null;

  const baselineRecommendation = data.recommendationSnapshot;
  const recommendation = resolveConfiguratorPackageQuantities(
    baselineRecommendation,
    data.packageQuantityOverrides,
    {
      stockBounded: true,
    },
  ).snapshot;
  if (!isCheckoutableRecommendation(recommendation)) return null;

  const selectedVariants = recommendation.lines.map((line) => ({
    variantId: line.variantId,
    sku: line.sku,
    flavorSlug: line.slug as ConfiguratorIntent["selectedVariants"][number]["flavorSlug"],
    qty: line.qty,
  }));

  // Flavor slugs MUST mirror the variants we are actually ordering, derived from
  // the server-authored lines — never from `data.flavors`. The raw selection can
  // drift from the resolved lines (the auto-flavor effect prunes a newly
  // allergen-blocked flavor, or the package omits a picked flavor), and the
  // intent schema only checks variants ⊆ flavorSlugs, not the reverse, so a slug
  // with no line would pass client validation and be rejected server-side (400).
  const selectedFlavorSlugs = Array.from(
    new Set(selectedVariants.map((variant) => variant.flavorSlug)),
  );

  // Recomputed here, from the EFFECTIVE package, rather than carried from the
  // package step: the customer can still add or remove cans on the summary step,
  // and every extra can lengthens the acquisition interval. Asking for terms
  // derived from a basket that is no longer the basket is the one thing the
  // checkout guard is guaranteed to reject.
  const starterOffer = data.offerMode === "starter"
    ? starterOfferIntentFor(
        selectedVariants.reduce((sum, line) => sum + line.qty, 0),
        data.starterQuoteCoverageDays,
      )
    : null;
  // Fail closed: an unbuildable offer is NOT a licence to place the same order
  // without it. That would charge the acquisition price and mint a subscription
  // with no starter marker — i.e. a customer owed a discounted delivery 2 that
  // nothing in the system remembers to give them.
  if (data.offerMode === "starter" && !starterOffer) return null;

  const allergenSlugs = data.hasAllergies
    ? (data.allergens as ConfiguratorIntent["petProfile"]["allergenSlugs"])
    : [];

  // A release gate may make subscription checkout temporarily unavailable, but
  // it must never reinterpret the customer's explicit subscription choice as a
  // one-time purchase. Fail closed and let the caller surface the unavailable
  // contract instead.
  if (data.subscription && !options.subscriptionCheckoutEnabled) return null;
  const mode = data.subscription ? "subscription" : "one_time";
  const dhlOnly = options.dhlOnlyDeliveryEnabled === true;
  const deliveryMethod = dhlOnly ? "courier" : data.deliveryMethod;
  const selectedPickupPoint = dhlOnly ? null : data.selectedPickupPoint;
  if (options.deliverySelectionEnabled && deliveryMethod === "parcel-locker" && !selectedPickupPoint) {
    return null;
  }
  const selectedDelivery = dhlOnly || !options.deliverySelectionEnabled
    ? {
        kind: "courier" as const,
        deliveryKind: "courier" as const,
        providerKind: "dhl" as const,
        providerRef: null,
        carrierKind: "dhl" as const,
        carrierCode: "DHL",
        service: "dhl_courier_standard" as const,
        serviceCode: "dhl_courier_standard",
        pickupPoint: null,
      }
    // Prefer the carrier tile the customer picked (DPD/DHL/InPost via OmniPack),
    // carrying its exact carrier/service codes from GET /delivery-options. Falls
    // back to the legacy method-based mapping when no tile is selected yet.
    : deliveryFromSelectedOption(data.selectedDeliveryOption, selectedPickupPoint)
      ?? legacyMethodDelivery(deliveryMethod, selectedPickupPoint);
  const candidate = {
    version: CONFIGURATOR_INTENT_VERSION,
    cadencePolicyVersion: CONFIGURATOR_FIXED_CADENCE_POLICY_VERSION,
    idempotencyKey: options.idempotencyKey,
    locale: options.locale ?? "pl",
    mode,
    // Customer quantity overrides never rewrite the explicit cadence.
    cadenceDays: mode === "subscription" ? data.lengthDays : null,
    promoCodes: data.promoCodes,
    visitorId: getOrCreateVisitorId(),
    sizeConstraint: {
      kind: "unit_count" as const,
      value: selectedVariants.reduce((sum, line) => sum + line.qty, 0),
    },
    petProfile: {
      petId: data.accountPetId,
      name: data.dogName.trim(),
      ageBand,
      breed: data.dogBreed.trim(),
      weightKg,
      activityLevel: data.activityLevel as ConfiguratorIntent["petProfile"]["activityLevel"],
      bcs: data.bcs as ConfiguratorIntent["petProfile"]["bcs"],
      allergenSlugs,
      dailyKcalOverride: recommendation.dailyKcal,
    },
    contact: {
      firstName: data.firstName.trim(),
      lastName: data.lastName.trim(),
      email: data.email.trim(),
      phone: data.phone.trim(),
    },
    address: {
      street: data.street.trim(),
      postalCode: data.postalCode.trim(),
      city: data.city.trim(),
      country: "PL" as const,
    },
    selectedDelivery,
    selectedFlavorSlugs,
    selectedVariants,
    // Keep the server-authored calculator result immutable for audit/evidence.
    // Final customer quantities are authoritative in selectedVariants.
    recommendationSnapshot: baselineRecommendation,
    consents: {
      gdpr: data.gdprConsent,
      marketing: data.marketingConsent,
      terms: data.termsConsent,
    },
    paymentMethodIntent: {
      method: paymentMethodIntentKind(data.paymentMethod),
      saveForSubscription: mode === "subscription",
    },
    consciousAllergenOverride: false,
    // Additive and absent on every non-starter order, so the standard intent is
    // deep-equal to the pre-starter one (and its idempotency key byte-identical).
    ...(starterOffer ? { starterOffer } : {}),
  };

  const parsed = configuratorIntentSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/**
 * The acquisition terms this basket ASKS for. Every field is recomputed
 * server-side from the server's own quote and rejected on the smallest
 * disagreement, so this is a request, never a price.
 *
 * `null` whenever the ration or the basket cannot produce a servable offer —
 * the caller must then refuse to build an order at all rather than quietly
 * downgrade it.
 */
function starterOfferIntentFor(
  totalCans: number,
  coverageDays: number | null,
): StarterOfferIntent | null {
  // Same function, same two operands, as `resolveStarterOfferGuard`. The ration
  // is NOT read from the recommendation snapshot: that number is rounded from the
  // client's own energy table and disagrees with the server's measured coverage
  // often enough to move the interval by a day — a mismatch a re-quote cannot
  // resolve, because a retry changes neither operand.
  const terms = starterTermsFromCoverage(totalCans, coverageDays);
  if (terms === null) return null;
  return {
    capability: STARTER_OFFER_CAPABILITY,
    intervalDays: terms.intervalDays,
    delivery2DiscountBps: STARTER_DELIVERY2_DISCOUNT_BPS,
    steady: { cadenceDays: terms.cadenceDays, cans: terms.steadyCans },
  };
}

function paymentMethodIntentKind(method: ConfiguratorFormData["paymentMethod"]) {
  return method === "blik_one_click" ? "blik" : method ?? "card";
}

// Map the carrier tile the customer picked (DPD/DHL/InPost via OmniPack) onto the
// checkout-intent delivery shape, carrying its exact OmniPack carrier/service codes.
function deliveryFromSelectedOption(option: DeliveryOption | null, pickupPoint: PickupPoint | null) {
  if (!option) return null;
  const requiresPickup = option.pickupPointRequired;
  return {
    kind: option.kind,
    deliveryKind: option.deliveryKind ?? option.kind,
    providerKind: option.providerKind,
    providerRef: requiresPickup ? pickupPoint?.id ?? null : null,
    carrierKind: option.carrierKind,
    carrierCode: option.carrierCode,
    service: option.service,
    serviceCode: option.serviceCode,
    pickupPoint: requiresPickup ? pickupPoint : null,
  };
}

// Back-compat mapping for forms that have no carrier tile selected yet (delivery
// selection disabled, or a persisted pre-tiles form): parcel-locker => InPost,
// courier => DPD, both via OmniPack. OmniPack asked for carrierCode to mirror
// serviceCode, so the fallback emits the service code in both fields.
function legacyMethodDelivery(deliveryMethod: ConfiguratorFormData["deliveryMethod"], pickupPoint: PickupPoint | null) {
  if (deliveryMethod === "parcel-locker") {
    return {
      kind: "parcel-locker" as const,
      deliveryKind: "parcel-locker" as const,
      providerKind: "omnipack" as const,
      providerRef: pickupPoint?.id ?? null,
      carrierKind: "inpost" as const,
      carrierCode: "INPOST_LOCKER_STANDARD",
      service: "inpost_locker_standard" as const,
      serviceCode: "INPOST_LOCKER_STANDARD",
      pickupPoint,
    };
  }
  return {
    kind: "courier" as const,
    deliveryKind: "courier" as const,
    providerKind: "omnipack" as const,
    providerRef: null,
    carrierKind: "dpd" as const,
    carrierCode: "DPD_COURIER_STANDARD",
    service: "dpd_courier_standard" as const,
    serviceCode: "DPD_COURIER_STANDARD",
    pickupPoint: null,
  };
}
