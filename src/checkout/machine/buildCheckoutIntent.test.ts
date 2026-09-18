import { describe, expect, it } from "vitest";
import {
  CONFIGURATOR_FIXED_CADENCE_POLICY_VERSION,
  configuratorIntentSchema,
} from "@/domains/commerce/configuratorIntentContracts";
import { COMMERCE_RECOMMENDATION_VERSION } from "@/domains/commerce/recommendationEngine";
import type { CommerceRecommendationSnapshot } from "@/domains/commerce/recommendationContracts";

import { buildCheckoutIntent } from "./buildCheckoutIntent";
import { defaultConfiguratorFormData, type ConfiguratorFormData } from "@/checkout/composer/configuratorFormStore";

/**
 * Line γ seam fixture: the composition vocabulary the composition root supplies in
 * production. Held here as plain data so the machine's tests exercise the seam without
 * importing the vertical's validation module.
 */
const KNOWN_COMPOSITION_SLUGS = ["lamb", "venison", "beef", "turkey", "salmon", "pork"] as const;

/**
 * Opaque fixture literal, carried verbatim so these fixtures stay byte-identical.
 *
 * The checkout machine never reads this field - it copies the recommendation snapshot
 * through untouched - so a platform checkout test must not be pinned to the vertical's
 * energy policy module. The sibling `source` literal beside it is already inlined for the
 * same reason. Line gamma seam: the vertical energy-policy module stays in the overlay.
 */
const FIXTURE_ENERGY_POLICY_VERSION = "commerce.energy_policy.fediaf_2025_dog_mer.v3";

const IDEMPOTENCY_KEY = "checkout:11111111-1111-4111-8111-111111111111";

function completeForm(overrides: Partial<ConfiguratorFormData> = {}): ConfiguratorFormData {
  return {
    ...defaultConfiguratorFormData,
    dogName: "Rex",
    dogBreed: "labrador",
    dogWeightKg: "12",
    dogAge: "adult",
    activityLevel: "high",
    bcs: "overweight",
    hasAllergies: true,
    allergens: ["chicken"],
    flavors: ["lamb", "beef"],
    lengthDays: 21,
    subscription: false,
    firstName: "Anna",
    lastName: "Kowalska",
    email: "anna@example.com",
    phone: "+48123456789",
    street: "Testowa 12",
    postalCode: "00-001",
    city: "Warszawa",
    country: "Polska",
    deliveryMethod: "courier",
    gdprConsent: true,
    termsConsent: true,
    marketingConsent: false,
    paymentMethod: "card",
    recommendationSnapshot: recommendationSnapshot(),
    ...overrides,
  };
}

describe("buildCheckoutIntent", () => {
  it("maps a complete form with a server recommendation snapshot to a valid intent", () => {
    const intent = buildCheckoutIntent(completeForm(), { knownCompositionSlugs: KNOWN_COMPOSITION_SLUGS, idempotencyKey: IDEMPOTENCY_KEY });

    expect(intent).not.toBeNull();
    expect(configuratorIntentSchema.safeParse(intent).success).toBe(true);
    expect(intent).toMatchObject({
      cadencePolicyVersion: CONFIGURATOR_FIXED_CADENCE_POLICY_VERSION,
      mode: "one_time",
      cadenceDays: null,
      idempotencyKey: IDEMPOTENCY_KEY,
      address: { country: "PL" },
      petProfile: {
        ageBand: "adult",
        weightKg: 12,
        activityLevel: "high",
        bcs: "overweight",
        allergenSlugs: ["chicken"],
        dailyKcalOverride: 708,
      },
      recommendationSnapshot: { status: "ready_to_buy" },
      paymentMethodIntent: { method: "card", saveForSubscription: false },
      consents: { gdpr: true, terms: true },
      selectedDelivery: {
        kind: "courier",
        deliveryKind: "courier",
        providerKind: "dhl",
        providerRef: null,
        carrierKind: "dhl",
        carrierCode: "DHL",
        service: "dhl_courier_standard",
        serviceCode: "dhl_courier_standard",
        pickupPoint: null,
      },
    });
    expect(intent!.selectedVariants).toEqual([
      { variantId: "variant-lamb-400", sku: "opaque:lamb-launch.v1", flavorSlug: "lamb", qty: 10 },
      { variantId: "variant-beef-400", sku: "opaque:beef-launch.v1", flavorSlug: "beef", qty: 11 },
    ]);
  });

  it("normalizes BLIK without-code UI selection to generic BLIK payment intent", () => {
    const intent = buildCheckoutIntent(
      completeForm({ paymentMethod: "blik_one_click" }),
      { knownCompositionSlugs: KNOWN_COMPOSITION_SLUGS, idempotencyKey: IDEMPOTENCY_KEY },
    );

    expect(intent?.paymentMethodIntent).toEqual({
      method: "blik",
      saveForSubscription: false,
    });
  });

  it("derives selectedFlavorSlugs from the snapshot lines, never the raw selection", () => {
    // The user's selection drifted from the resolved package: they still have a
    // `venison` flavor ticked, but the server recommendation only built lamb+beef
    // lines. The old code sent `selectedFlavorSlugs: data.flavors` (with venison)
    // and `selectedVariants` from the lines (no venison) — which the client schema
    // accepted but the server rejected (400). The intent must instead declare only
    // the flavors backed by an ordered variant.
    const intent = buildCheckoutIntent(
      completeForm({ flavors: ["lamb", "beef", "venison"] }),
      { knownCompositionSlugs: KNOWN_COMPOSITION_SLUGS, idempotencyKey: IDEMPOTENCY_KEY },
    );

    expect(intent).not.toBeNull();
    expect(intent!.selectedFlavorSlugs).toEqual(["lamb", "beef"]);
    expect(configuratorIntentSchema.safeParse(intent).success).toBe(true);
  });

  it("keeps Polish market commerce while allowing an English checkout intent locale", () => {
    const intent = buildCheckoutIntent(completeForm(), { knownCompositionSlugs: KNOWN_COMPOSITION_SLUGS,
      idempotencyKey: IDEMPOTENCY_KEY,
      locale: "en",
    });

    expect(intent).toMatchObject({
      locale: "en",
      address: { country: "PL" },
    });
    expect(configuratorIntentSchema.safeParse(intent).success).toBe(true);
  });

  it("defaults checkout intent locale to Polish", () => {
    const intent = buildCheckoutIntent(completeForm(), { knownCompositionSlugs: KNOWN_COMPOSITION_SLUGS, idempotencyKey: IDEMPOTENCY_KEY });

    expect(intent?.locale).toBe("pl");
  });

  it("returns null when the server recommendation snapshot is missing", () => {
    const intent = buildCheckoutIntent(
      completeForm({ recommendationSnapshot: null }),
      { knownCompositionSlugs: KNOWN_COMPOSITION_SLUGS, idempotencyKey: IDEMPOTENCY_KEY },
    );

    expect(intent).toBeNull();
  });

  it("returns null instead of setting terms=true when terms consent is missing", () => {
    const intent = buildCheckoutIntent(
      completeForm({ termsConsent: false }),
      { knownCompositionSlugs: KNOWN_COMPOSITION_SLUGS, idempotencyKey: IDEMPOTENCY_KEY },
    );

    expect(intent).toBeNull();
  });

  it("returns null for manual review snapshots", () => {
    const intent = buildCheckoutIntent(
      completeForm({
        recommendationSnapshot: {
          ...recommendationSnapshot(),
          status: "manual_review",
          lines: [],
          dailyKcal: null,
          dailyGrams: null,
          feedingDays: null,
          totalWeightG: 0,
        },
      }),
      { idempotencyKey: IDEMPOTENCY_KEY, knownCompositionSlugs: KNOWN_COMPOSITION_SLUGS },
    );

    expect(intent).toBeNull();
  });

  it("fails closed when a calculator line exceeds the checkout contract maximum", () => {
    const oversized = recommendationSnapshot();
    oversized.lines[0].qty = 100;
    const intent = buildCheckoutIntent(
      completeForm({ recommendationSnapshot: oversized }),
      { knownCompositionSlugs: KNOWN_COMPOSITION_SLUGS, idempotencyKey: IDEMPOTENCY_KEY },
    );

    expect(intent).toBeNull();
  });

  it("drops allergens when the form reports no allergies", () => {
    const intent = buildCheckoutIntent(
      completeForm({ hasAllergies: false, allergens: ["beef"] }),
      { knownCompositionSlugs: KNOWN_COMPOSITION_SLUGS, idempotencyKey: IDEMPOTENCY_KEY },
    );

    expect(intent?.petProfile.allergenSlugs).toEqual([]);
  });

  it("fails closed instead of converting a selected subscription to one-time when its contract is disabled", () => {
    const unavailable = buildCheckoutIntent(
      completeForm({ subscription: true }),
      { knownCompositionSlugs: KNOWN_COMPOSITION_SLUGS, idempotencyKey: IDEMPOTENCY_KEY },
    );
    const subscription = buildCheckoutIntent(
      completeForm({ subscription: true, lengthDays: 28 }),
      { knownCompositionSlugs: KNOWN_COMPOSITION_SLUGS, idempotencyKey: IDEMPOTENCY_KEY, subscriptionCheckoutEnabled: true },
    );

    expect(unavailable).toBeNull();
    expect(subscription).toMatchObject({
      mode: "subscription",
      // The explicit plan is unchanged even when package coverage differs.
      cadenceDays: 28,
      paymentMethodIntent: { saveForSubscription: true },
    });
    expect(configuratorIntentSchema.safeParse(subscription).success).toBe(true);
  });

  it("keeps the explicitly selected subscription cadence when package coverage differs", () => {
    const intent = buildCheckoutIntent(
      completeForm({
        subscription: true,
        lengthDays: 14,
        recommendationSnapshot: { ...recommendationSnapshot(), feedingDays: 20.9 },
      }),
      { idempotencyKey: IDEMPOTENCY_KEY, subscriptionCheckoutEnabled: true, knownCompositionSlugs: KNOWN_COMPOSITION_SLUGS },
    );
    expect(intent?.cadenceDays).toBe(14);
    expect(intent?.sizeConstraint).toEqual({ kind: "unit_count", value: 21 });
  });

  it("uses independent quantity overrides for order lines while preserving calculator evidence", () => {
    const baseline = recommendationSnapshot();
    const intent = buildCheckoutIntent(
      completeForm({
        recommendationSnapshot: baseline,
        packageQuantityOverrides: {
          "variant-lamb-400": 7,
          "variant-beef-400": 14,
        },
      }),
      { knownCompositionSlugs: KNOWN_COMPOSITION_SLUGS, idempotencyKey: IDEMPOTENCY_KEY },
    );

    expect(intent?.selectedVariants).toEqual([
      { variantId: "variant-lamb-400", sku: "opaque:lamb-launch.v1", flavorSlug: "lamb", qty: 7 },
      { variantId: "variant-beef-400", sku: "opaque:beef-launch.v1", flavorSlug: "beef", qty: 14 },
    ]);
    expect(intent?.sizeConstraint).toEqual({ kind: "unit_count", value: 21 });
    expect(intent?.recommendationSnapshot?.lines.map((line) => line.qty)).toEqual([10, 11]);
    expect(baseline.lines.map((line) => line.qty)).toEqual([10, 11]);
  });

  it("keeps cadence fixed while quantity overrides change coverage and unit-count intent", () => {
    const intent = buildCheckoutIntent(
      completeForm({
        subscription: true,
        lengthDays: 14,
        packageQuantityOverrides: { "variant-lamb-400": 12 },
      }),
      { knownCompositionSlugs: KNOWN_COMPOSITION_SLUGS, idempotencyKey: IDEMPOTENCY_KEY, subscriptionCheckoutEnabled: true },
    );

    expect(intent).toMatchObject({
      mode: "subscription",
      cadenceDays: 14,
      sizeConstraint: { kind: "unit_count", value: 23 },
    });
    expect(intent?.selectedVariants.map((line) => line.qty)).toEqual([12, 11]);
  });

  it("maps a validated InPost pickup point into selected delivery evidence", () => {
    const intent = buildCheckoutIntent(
      completeForm({
        deliveryMethod: "parcel-locker",
        selectedPickupPoint: {
          id: "WAW01A",
          provider: "inpost",
          name: "Paczkomat WAW01A",
          address: { line1: "Prosta 20", postalCode: "00-850", city: "Warszawa", country: "PL" },
        },
      }),
      { knownCompositionSlugs: KNOWN_COMPOSITION_SLUGS, idempotencyKey: IDEMPOTENCY_KEY, deliverySelectionEnabled: true },
    );

    expect(intent).toMatchObject({
      selectedDelivery: {
        kind: "parcel-locker",
        deliveryKind: "parcel-locker",
        providerKind: "omnipack",
        providerRef: "WAW01A",
        carrierKind: "inpost",
        carrierCode: "INPOST_LOCKER_STANDARD",
        service: "inpost_locker_standard",
        serviceCode: "INPOST_LOCKER_STANDARD",
        pickupPoint: { id: "WAW01A", name: "Paczkomat WAW01A" },
      },
    });
    expect(configuratorIntentSchema.safeParse(intent).success).toBe(true);
  });

  it("maps courier delivery selection into OmniPack DPD routing evidence when enabled", () => {
    const intent = buildCheckoutIntent(
      completeForm({ deliveryMethod: "courier" }),
      { knownCompositionSlugs: KNOWN_COMPOSITION_SLUGS, idempotencyKey: IDEMPOTENCY_KEY, deliverySelectionEnabled: true },
    );

    expect(intent).toMatchObject({
      selectedDelivery: {
        kind: "courier",
        deliveryKind: "courier",
        providerKind: "omnipack",
        providerRef: null,
        carrierKind: "dpd",
        carrierCode: "DPD_COURIER_STANDARD",
        service: "dpd_courier_standard",
        serviceCode: "DPD_COURIER_STANDARD",
        pickupPoint: null,
      },
    });
    expect(configuratorIntentSchema.safeParse(intent).success).toBe(true);
  });

  it("carries the picked carrier tile (DHL via OmniPack) into selected delivery", () => {
    const intent = buildCheckoutIntent(
      completeForm({
        deliveryMethod: "courier",
        selectedDeliveryOption: {
          id: "dhl-dhl_courier_via_omnipack",
          kind: "courier",
          deliveryKind: "courier",
          providerKind: "omnipack",
          carrierKind: "dhl",
          carrierCode: "dhl_courier_via_omnipack",
          service: "dhl_courier_via_omnipack",
          serviceCode: "dhl_courier_via_omnipack",
          label: "Kurier DHL",
          description: "Dostawa pod adres przez OmniPack (DHL).",
          pickupPointRequired: false,
          addressRequired: true,
        },
      }),
      { idempotencyKey: IDEMPOTENCY_KEY, deliverySelectionEnabled: true, knownCompositionSlugs: KNOWN_COMPOSITION_SLUGS },
    );

    expect(intent).toMatchObject({
      selectedDelivery: {
        kind: "courier",
        providerKind: "omnipack",
        carrierKind: "dhl",
        carrierCode: "dhl_courier_via_omnipack",
        serviceCode: "dhl_courier_via_omnipack",
        pickupPoint: null,
      },
    });
    expect(configuratorIntentSchema.safeParse(intent).success).toBe(true);
  });

  it("carries a picked InPost locker tile + pickup point into selected delivery", () => {
    const intent = buildCheckoutIntent(
      completeForm({
        deliveryMethod: "parcel-locker",
        selectedPickupPoint: {
          id: "WAW01A",
          provider: "inpost",
          name: "Paczkomat WAW01A",
          address: { line1: "Prosta 20", postalCode: "00-850", city: "Warszawa", country: "PL" },
        },
        selectedDeliveryOption: {
          id: "inpost-inpost_locker",
          kind: "parcel-locker",
          deliveryKind: "parcel-locker",
          providerKind: "omnipack",
          carrierKind: "inpost",
          carrierCode: "inpost_locker",
          service: "inpost_locker",
          serviceCode: "inpost_locker",
          label: "InPost — punkt odbioru",
          description: "Odbiór w paczkomacie InPost.",
          pickupPointRequired: true,
          addressRequired: false,
        },
      }),
      { knownCompositionSlugs: KNOWN_COMPOSITION_SLUGS, idempotencyKey: IDEMPOTENCY_KEY, deliverySelectionEnabled: true },
    );

    expect(intent).toMatchObject({
      selectedDelivery: {
        kind: "parcel-locker",
        providerKind: "omnipack",
        carrierKind: "inpost",
        serviceCode: "inpost_locker",
        providerRef: "WAW01A",
        pickupPoint: { id: "WAW01A" },
      },
    });
    expect(configuratorIntentSchema.safeParse(intent).success).toBe(true);
  });

  it("returns null for parcel-locker checkout when delivery selection is enabled without a pickup point", () => {
    const intent = buildCheckoutIntent(
      completeForm({ deliveryMethod: "parcel-locker", selectedPickupPoint: null }),
      { knownCompositionSlugs: KNOWN_COMPOSITION_SLUGS, idempotencyKey: IDEMPOTENCY_KEY, deliverySelectionEnabled: true },
    );

    expect(intent).toBeNull();
  });

  it("forces stale parcel-locker form state into DHL courier when DHL-only delivery is enabled", () => {
    const intent = buildCheckoutIntent(
      completeForm({
        deliveryMethod: "parcel-locker",
        selectedPickupPoint: {
          id: "WAW01A",
          provider: "inpost",
          name: "Paczkomat WAW01A",
          address: { line1: "Prosta 20", postalCode: "00-850", city: "Warszawa", country: "PL" },
        },
      }),
      { knownCompositionSlugs: KNOWN_COMPOSITION_SLUGS, idempotencyKey: IDEMPOTENCY_KEY, deliverySelectionEnabled: true, dhlOnlyDeliveryEnabled: true },
    );

    expect(intent?.selectedDelivery).toEqual({
      kind: "courier",
      deliveryKind: "courier",
      providerKind: "dhl",
      providerRef: null,
      carrierKind: "dhl",
      carrierCode: "DHL",
      service: "dhl_courier_standard",
      serviceCode: "dhl_courier_standard",
      pickupPoint: null,
    });
    expect(configuratorIntentSchema.safeParse(intent).success).toBe(true);
  });
});

function recommendationSnapshot(): CommerceRecommendationSnapshot {
  return {
    version: COMMERCE_RECOMMENDATION_VERSION,
    status: "ready_to_buy",
    reasonCodes: ["energy_policy_fediaf_2025", "preferred_flavors_used"],
    energy: {
      policyVersion: FIXTURE_ENERGY_POLICY_VERSION,
      source: "fediaf_2025_adult_dog_mer",
      ageBand: "adult",
      activityLevel: "high",
      bcs: "overweight",
      kcalPerKgBodyWeight075: 127.5,
      dailyKcal: 708,
      dailyGrams: 576,
    },
    dailyKcal: 708,
    dailyGrams: 576,
    totalWeightG: 8400,
    feedingDays: 20.5,
    desiredSizeKind: "feeding_days",
    cadenceDays: 21,
    lines: [
      {
        variantId: "variant-lamb-400",
        sku: "opaque:lamb-launch.v1",
        slug: "lamb",
        qty: 10,
        netWeightG: 400,
        kcalPerUnit: 492,
        allergenSlugs: ["lamb"],
      },
      {
        variantId: "variant-beef-400",
        sku: "opaque:beef-launch.v1",
        slug: "beef",
        qty: 11,
        netWeightG: 400,
        kcalPerUnit: 492,
        allergenSlugs: ["beef"],
      },
    ],
    allergenConflicts: [],
    excludedProducts: [],
    allergenOverrideRecorded: false,
  };
}
