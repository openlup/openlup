import { describe, expect, it } from "vitest";
import {
  CONFIGURATOR_INTENT_VERSION,
  CONFIGURATOR_FIXED_CADENCE_POLICY_VERSION,
  configuratorIntentSchema,
} from "./configuratorIntentContracts.js";
import {
  COMMERCE_MIN_AUTO_ORDER_UNITS,
  COMMERCE_MIN_ORDER_UNITS,
} from "./recommendationPolicyDeps.js";

describe("configuratorIntentSchema", () => {
  it("accepts the hidden subscription intent payload for /skomponuj-pakiet", () => {
    const parsed = configuratorIntentSchema.parse(makeIntent());

    expect(parsed.version).toBe(CONFIGURATOR_INTENT_VERSION);
    expect(parsed.mode).toBe("subscription");
    expect(parsed.cadenceDays).toBe(21);
    expect(parsed.sizeConstraint.kind).toBe("feeding_days");
    expect(parsed.selectedVariants[0].sku).toBe("opaque:lamb-launch.v1");
  });

  it("accepts a selected-variant total equal to the canonical 14-unit MOQ", () => {
    const parsed = configuratorIntentSchema.parse(
      makeIntent({
        selectedFlavorSlugs: ["lamb"],
        selectedVariants: [variant("lamb", COMMERCE_MIN_ORDER_UNITS)],
      }),
    );

    expect(parsed.selectedVariants).toHaveLength(1);
    expect(parsed.selectedVariants[0].qty).toBe(COMMERCE_MIN_ORDER_UNITS);
    expect(COMMERCE_MIN_AUTO_ORDER_UNITS).toBe(COMMERCE_MIN_ORDER_UNITS);
  });

  it("rejects a selected-variant total below the canonical MOQ", () => {
    const result = configuratorIntentSchema.safeParse(
      makeIntent({
        selectedFlavorSlugs: ["lamb", "venison"],
        selectedVariants: [variant("lamb", 7), variant("venison", 6)],
      }),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({ path: ["selectedVariants"] }),
      );
    }
  });

  it("retains the positive and 99-unit per-line bounds", () => {
    const accepted = configuratorIntentSchema.safeParse(
      makeIntent({
        selectedFlavorSlugs: ["lamb"],
        selectedVariants: [variant("lamb", 99)],
      }),
    );
    const zero = configuratorIntentSchema.safeParse(
      makeIntent({
        selectedFlavorSlugs: ["lamb", "venison"],
        selectedVariants: [variant("lamb", 0), variant("venison", 14)],
      }),
    );
    const aboveMaximum = configuratorIntentSchema.safeParse(
      makeIntent({
        selectedFlavorSlugs: ["lamb"],
        selectedVariants: [variant("lamb", 100)],
      }),
    );

    expect(accepted.success).toBe(true);
    expect(zero.success).toBe(false);
    expect(aboveMaximum.success).toBe(false);
  });

  it("accepts the server-authored recommendation snapshot on checkout intents", () => {
    const parsed = configuratorIntentSchema.parse(
      makeIntent({ recommendationSnapshot: recommendationSnapshot() }),
    );

    expect(parsed.recommendationSnapshot?.status).toBe("ready_to_buy");
    expect(parsed.recommendationSnapshot?.lines[0].qty).toBe(14);
  });

  it("requires cadence for subscription intents", () => {
    const result = configuratorIntentSchema.safeParse(makeIntent({ cadenceDays: null }));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join("."))).toContain("cadenceDays");
    }
  });

  it("accepts only the three rhythms for newly authored v2 configurator intents", () => {
    for (const cadenceDays of [14, 21, 28]) {
      expect(configuratorIntentSchema.safeParse(makeIntent({ cadenceDays })).success).toBe(true);
    }

    expect(configuratorIntentSchema.safeParse(makeIntent({ cadenceDays: 20 })).success).toBe(false);
    expect(configuratorIntentSchema.safeParse(makeIntent({ cadenceDays: 30 })).success).toBe(false);
  });

  it("keeps legacy v1 cadence readable for in-flight checkout and recovery", () => {
    const result = configuratorIntentSchema.safeParse(makeIntent({
      cadencePolicyVersion: undefined,
      cadenceDays: 30,
    }));

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.version).toBe(CONFIGURATOR_INTENT_VERSION);
      expect(result.data.cadenceDays).toBe(30);
    }
  });

  it("requires daily kcal for feeding-days size constraints", () => {
    const result = configuratorIntentSchema.safeParse(
      makeIntent({
        sizeConstraint: { kind: "feeding_days", value: 21 },
      }),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join("."))).toContain(
        "sizeConstraint.dailyKcalOverride",
      );
    }
  });

  it("rejects selected variants outside the declared flavor set", () => {
    const result = configuratorIntentSchema.safeParse(
      makeIntent({
        selectedFlavorSlugs: ["lamb"],
        selectedVariants: [
          {
            variantId: "variant-venison-400",
            sku: "opaque:venison-launch.v1",
            flavorSlug: "venison",
            qty: 7,
          },
        ],
      }),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join("."))).toContain(
        "selectedVariants.0.flavorSlug",
      );
    }
  });

  it("rejects declared flavors that resolve to no selected variant", () => {
    const result = configuratorIntentSchema.safeParse(
      makeIntent({
        selectedFlavorSlugs: ["lamb", "venison"],
        selectedVariants: [
          {
            variantId: "variant-lamb-400",
            sku: "opaque:lamb-launch.v1",
            flavorSlug: "lamb",
            qty: 7,
          },
        ],
      }),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join("."))).toContain(
        "selectedFlavorSlugs.1",
      );
    }
  });

  it("accepts normalized parcel-locker delivery evidence", () => {
    const parsed = configuratorIntentSchema.parse(makeIntent({
      selectedDelivery: {
        kind: "parcel-locker",
        providerKind: "omnipack",
        providerRef: "WAW01A",
        carrierKind: "inpost",
        carrierCode: "INPOST",
        service: "inpost_locker_standard",
        serviceCode: "INPOST_LOCKER_STANDARD",
        pickupPoint: {
          id: "WAW01A",
          provider: "inpost",
          name: "Paczkomat WAW01A",
          address: { line1: "Prosta 20", postalCode: "00-850", city: "Warszawa", country: "PL" },
        },
      },
    }));

    expect(parsed.selectedDelivery.pickupPoint?.id).toBe("WAW01A");
  });

  it("rejects pickup point evidence on courier delivery", () => {
    const result = configuratorIntentSchema.safeParse(makeIntent({
      selectedDelivery: {
        kind: "courier",
        providerKind: "omnipack",
        providerRef: null,
        carrierKind: "courier",
        carrierCode: "COURIER",
        service: "courier_standard",
        serviceCode: "COURIER_STANDARD",
        pickupPoint: {
          id: "WAW01A",
          provider: "inpost",
          name: "Paczkomat WAW01A",
          address: { line1: "Prosta 20", postalCode: "00-850", city: "Warszawa", country: "PL" },
        },
      },
    }));

    expect(result.success).toBe(false);
  });
});

function makeIntent(overrides: Record<string, unknown> = {}) {
  return {
    version: CONFIGURATOR_INTENT_VERSION,
    cadencePolicyVersion: CONFIGURATOR_FIXED_CADENCE_POLICY_VERSION,
    idempotencyKey: "intent-2026-06-05-rex",
    locale: "pl",
    mode: "subscription",
    cadenceDays: 21,
    sizeConstraint: {
      kind: "feeding_days",
      value: 21,
      dailyKcalOverride: 328,
    },
    petProfile: {
      name: "Rex",
      ageBand: "adult",
      breed: "labrador",
      weightKg: 12,
      activityLevel: "normal",
      bcs: "ideal",
      allergenSlugs: ["chicken"],
      dailyKcalOverride: 328,
    },
    contact: {
      firstName: "Anna",
      lastName: "Kowalska",
      email: "anna@example.com",
      phone: "+48123456789",
    },
    address: {
      street: "Testowa 12",
      postalCode: "00-001",
      city: "Warszawa",
      country: "PL",
    },
    selectedDelivery: {
      kind: "courier",
      providerKind: "dhl",
      providerRef: null,
      carrierKind: "dhl",
      carrierCode: "DHL",
      service: "dhl_courier_standard",
      serviceCode: "dhl_courier_standard",
    },
    selectedFlavorSlugs: ["lamb", "venison"],
    selectedVariants: [
      {
        variantId: "variant-lamb-400",
        sku: "opaque:lamb-launch.v1",
        flavorSlug: "lamb",
        qty: 7,
      },
      {
        variantId: "variant-venison-400",
        sku: "opaque:venison-launch.v1",
        flavorSlug: "venison",
        qty: 7,
      },
    ],
    consents: {
      gdpr: true,
      marketing: false,
      terms: true,
    },
    paymentMethodIntent: {
      method: "card",
      saveForSubscription: true,
    },
    consciousAllergenOverride: false,
    ...overrides,
  };
}

function variant(flavorSlug: "lamb" | "venison", qty: number) {
  return {
    variantId: `variant-${flavorSlug}-400`,
    sku: `opaque:${flavorSlug}-launch.v1`,
    flavorSlug,
    qty,
  };
}

function recommendationSnapshot() {
  return {
    version: "commerce-recommendation.v2",
    status: "ready_to_buy",
    reasonCodes: ["energy_policy_fediaf_2025", "preferred_flavors_used"],
    energy: {
      policyVersion: "commerce.energy_policy.fediaf_2025_adult_dog_mer.v2",
      source: "fediaf_2025_adult_dog_mer",
      ageBand: "adult",
      activityLevel: "normal",
      bcs: "ideal",
      kcalPerKgBodyWeight075: 95,
      dailyKcal: 613,
      dailyGrams: 576,
    },
    dailyKcal: 613,
    dailyGrams: 576,
    totalWeightG: 5600,
    feedingDays: 19.5,
    desiredSizeKind: "feeding_days",
    cadenceDays: 21,
    lines: [{
      variantId: "variant-lamb-400",
      sku: "opaque:lamb-launch.v1",
      slug: "lamb",
      qty: 14,
      netWeightG: 400,
      kcalPerUnit: 492,
      allergenSlugs: ["lamb"],
    }],
    allergenConflicts: [],
    excludedProducts: [],
    allergenOverrideRecorded: false,
  };
}
