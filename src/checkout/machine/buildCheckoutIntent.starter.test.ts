import { describe, expect, it } from "vitest";

import type { CommerceRecommendationSnapshot } from "@/domains/commerce/recommendationContracts";
import { COMMERCE_RECOMMENDATION_VERSION } from "@/domains/commerce/recommendationEngine";
import {
  STARTER_DELIVERY2_DISCOUNT_BPS,
  STARTER_OFFER_CAPABILITY,
  starterTermsFromCoverage,
} from "@/domains/commerce/starterOfferPolicy";

import { buildCheckoutIntent } from "./buildCheckoutIntent";
import { fingerprintCheckoutIntent } from "./checkoutAttemptStore";
import { defaultConfiguratorFormData, type ConfiguratorFormData } from "@/checkout/composer/configuratorFormStore";
import { serializeConfiguratorIntent } from "@/checkout/composer/configuratorDraftCodec";
import { PUBLIC_CONFIGURATOR_DRAFT_SCOPE } from "@/checkout/composer/configuratorDraftStore";

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

function starterSnapshot(cans: number, dailyGrams: number): CommerceRecommendationSnapshot {
  return {
    version: COMMERCE_RECOMMENDATION_VERSION,
    status: "ready_to_buy",
    reasonCodes: ["minimum_order_quantity_applied"],
    energy: {
      policyVersion: FIXTURE_ENERGY_POLICY_VERSION,
      source: "fediaf_2025_adult_dog_mer",
      ageBand: "adult",
      activityLevel: "normal",
      bcs: "ideal",
      kcalPerKgBodyWeight075: 110,
      dailyKcal: 615,
      dailyGrams,
    },
    dailyKcal: 615,
    dailyGrams,
    totalWeightG: cans * 400,
    feedingDays: (cans * 400) / dailyGrams,
    desiredSizeKind: "feeding_days",
    cadenceDays: 28,
    lines: [
      { variantId: "variant-lamb", sku: "sku-lamb", slug: "lamb", qty: Math.ceil(cans / 2), netWeightG: 400, kcalPerUnit: 492, allergenSlugs: [] },
      { variantId: "variant-beef", sku: "sku-beef", slug: "beef", qty: Math.floor(cans / 2), netWeightG: 400, kcalPerUnit: 492, allergenSlugs: [] },
    ],
    allergenConflicts: [],
    excludedProducts: [],
    allergenOverrideRecorded: false,
  } as CommerceRecommendationSnapshot;
}

function form(overrides: Partial<ConfiguratorFormData> = {}): ConfiguratorFormData {
  return {
    ...defaultConfiguratorFormData,
    dogName: "Figa",
    dogBreed: "Kundelek",
    dogWeightKg: "12",
    dogAge: "adult",
    activityLevel: "normal",
    bcs: "ideal",
    flavors: ["lamb", "beef"],
    lengthDays: 28,
    subscription: true,
    firstName: "Anna",
    lastName: "Nowak",
    email: "anna@example.com",
    phone: "500600700",
    street: "Kwiatowa 1",
    postalCode: "00-001",
    city: "Warszawa",
    gdprConsent: true,
    termsConsent: true,
    paymentMethod: "card",
    recommendationSnapshot: starterSnapshot(14, 500),
    // Coverage of the quote the expectation was taken from: 14 cans x 400 g at
    // 500 g/day. The single input every starter term is derived from.
    starterQuoteCoverageDays: 11.2,
    ...overrides,
  };
}

const OPTIONS = {
  idempotencyKey: "checkout:pending",
  locale: "pl" as const,
  subscriptionCheckoutEnabled: true,
  deliverySelectionEnabled: true,
  dhlOnlyDeliveryEnabled: true,
  knownCompositionSlugs: KNOWN_COMPOSITION_SLUGS,
};

describe("buildCheckoutIntent — starter offer", () => {
  it("emits nothing at all on the standard path (deep-equal to the pre-starter intent)", () => {
    const standard = buildCheckoutIntent(form(), OPTIONS);
    expect(standard).not.toBeNull();
    expect(standard).not.toHaveProperty("starterOffer");
    expect(Object.keys(standard!)).not.toContain("starterOffer");
  });

  it("leaves the checkout-attempt fingerprint of a standard order byte-identical", () => {
    // The attempt fingerprint is a stable stringify of the whole intent. An
    // additive field that is ABSENT on the standard path must not perturb it, or
    // every stored in-flight attempt would look like a different journey.
    const expectation = { totalGross: { amountMinor: 18_774, currency: "PLN" as const } };
    const fingerprint = fingerprintCheckoutIntent(buildCheckoutIntent(form(), OPTIONS)!, expectation);
    expect(fingerprint).not.toContain("starterOffer");
    expect(fingerprint).toBe(
      fingerprintCheckoutIntent(buildCheckoutIntent(form(), OPTIONS)!, expectation),
    );
    // ...and the starter path DOES change it, because it is a different order.
    expect(
      fingerprintCheckoutIntent(buildCheckoutIntent(form({ offerMode: "starter" }), OPTIONS)!, expectation),
    ).not.toBe(fingerprint);
  });

  it("declares terms recomputed from the effective package, matching the guard's own arithmetic", () => {
    const intent = buildCheckoutIntent(form({ offerMode: "starter" }), OPTIONS);
    expect(intent!.starterOffer).toEqual({
      capability: STARTER_OFFER_CAPABILITY,
      delivery2DiscountBps: STARTER_DELIVERY2_DISCOUNT_BPS,
      // 14 cans × 400 g ÷ 500 g/day = 11.2 → 11 days.
      intervalDays: 11,
      // 500 g/day < 800 ⇒ monthly; 500 × 28 ÷ 400 = 35 cans.
      steady: { cadenceDays: 28, cans: 35 },
    });
    // Contract-legal: the top-level cadence stays the steady value.
    expect(intent!.cadenceDays).toBe(28);
  });

  it("lengthens the interval when the customer adds cans on the summary step", () => {
    const withOverrides = form({
      offerMode: "starter",
      // Baseline is 7 lamb + 7 beef; the customer takes lamb to 9 → 16 cans.
      packageQuantityOverrides: { "variant-lamb": 9 },
      // Re-quoted basket ⇒ re-measured coverage: 16 x 400 / 500.
      starterQuoteCoverageDays: 12.8,
    });
    const intent = buildCheckoutIntent(withOverrides, OPTIONS);
    // 16 × 400 ÷ 500 = 12.8 → 13 days, computed from the EFFECTIVE basket.
    expect(intent!.starterOffer?.intervalDays).toBe(13);
    expect(intent!.sizeConstraint.value).toBe(16);
    // The steady plan is a property of the ration, not of the acquisition basket.
    expect(intent!.starterOffer?.steady).toEqual({ cadenceDays: 28, cans: 35 });
  });

  // P1-A regression. Before this wave the client derived the ration from the
  // snapshot's integer `dailyGrams` while the guard derived it from the quote's
  // 1-decimal `feedingCoverageDays`. At dailyKcal=199 / totalKcal=5264 the two
  // land either side of a .5 boundary — client 26, guard 27 — and because a
  // re-quote changes neither operand, the rejection repeats forever.
  it("agrees with the guard on the .5-boundary case that used to loop forever", () => {
    // 14 cans x 376 = 5264 energy units; 5264 / 199 = 26.4523, rounded by the quote
    // port's `roundCoverage` to 26.5.
    const coverageDays = Math.round((5264 / 199) * 10) / 10;
    expect(coverageDays).toBe(26.5);

    const snapshot = {
      ...starterSnapshot(14, 212),
      dailyKcal: 199,
      lines: starterSnapshot(14, 212).lines.map((line) => ({ ...line, kcalPerUnit: 376 })),
    } as CommerceRecommendationSnapshot;

    const declared = buildCheckoutIntent(
      form({ offerMode: "starter", recommendationSnapshot: snapshot, starterQuoteCoverageDays: coverageDays }),
      OPTIONS,
    )!.starterOffer!;

    // The guard's own recomputation, from its own two operands.
    const guardTerms = starterTermsFromCoverage(14, coverageDays)!;
    expect(declared.intervalDays).toBe(guardTerms.intervalDays);
    expect(declared.steady).toEqual({
      cadenceDays: guardTerms.cadenceDays,
      cans: guardTerms.steadyCans,
    });

    // And it is genuinely the boundary: the retired snapshot-derived formula
    // still answers 26 here, which is what made the loop reachable.
    expect(guardTerms.intervalDays).toBe(27);
    expect(Math.round((14 * 400) / snapshot.dailyGrams!)).toBe(26);
  });

  it("agrees with the guard across the whole ration sweep", () => {
    // Property-ish: every plausible ration, both derivations, one assertion. The
    // client and the guard call the SAME function on the SAME operands, so this
    // pins that no caller re-introduces a private formula.
    for (const dailyKcal of [199, 240, 320, 480, 615, 780, 900, 1_150, 1_400, 1_800]) {
      for (const cans of [14, 16, 21, 28, 40]) {
        const totalKcal = cans * 376;
        const coverageDays = Math.round((totalKcal / dailyKcal) * 10) / 10;
        const snapshot = {
          ...starterSnapshot(cans, Math.round((dailyKcal * cans * 400) / totalKcal)),
          dailyKcal,
        } as CommerceRecommendationSnapshot;
        const intent = buildCheckoutIntent(
          form({ offerMode: "starter", recommendationSnapshot: snapshot, starterQuoteCoverageDays: coverageDays }),
          OPTIONS,
        );
        const guardTerms = starterTermsFromCoverage(cans, coverageDays);
        if (guardTerms === null) {
          expect(intent, `ration ${dailyKcal}/${cans} cans must fail closed`).toBeNull();
          continue;
        }
        expect(intent!.starterOffer, `ration ${dailyKcal}/${cans} cans`).toEqual({
          capability: STARTER_OFFER_CAPABILITY,
          delivery2DiscountBps: STARTER_DELIVERY2_DISCOUNT_BPS,
          intervalDays: guardTerms.intervalDays,
          steady: { cadenceDays: guardTerms.cadenceDays, cans: guardTerms.steadyCans },
        });
      }
    }
  });

  it("switches the steady plan to fortnightly for a big eater", () => {
    const intent = buildCheckoutIntent(
      // 14 x 400 / 900 g/day = 6.2 days of coverage.
      form({ offerMode: "starter", recommendationSnapshot: starterSnapshot(14, 900), starterQuoteCoverageDays: 6.2 }),
      OPTIONS,
    );
    // 900 g/day ≥ 800 ⇒ fortnightly; 900 × 14 ÷ 400 = 31.5 → 32 cans.
    expect(intent!.starterOffer?.steady).toEqual({ cadenceDays: 14, cans: 32 });
    // 14 × 400 ÷ 900 = 6.2 → clamped up to the 7-day floor.
    expect(intent!.starterOffer?.intervalDays).toBe(7);
  });

  it("refuses to build an order at all when the offer cannot be expressed", () => {
    // Coverage unknown ⇒ no ration ⇒ no interval ⇒ no offer. Placing the SAME
    // order without the marker would charge the acquisition price and owe a
    // delivery-2 discount that nothing would remember to give.
    const intent = buildCheckoutIntent(
      form({ offerMode: "starter", starterQuoteCoverageDays: null }),
      OPTIONS,
    );
    expect(intent).toBeNull();
  });
});

describe("configuratorDraftCodec — offerMode exclusion", () => {
  it("never serializes offerMode into a persisted draft", () => {
    const serialized = serializeConfiguratorIntent(
      form({ offerMode: "starter" }),
      PUBLIC_CONFIGURATOR_DRAFT_SCOPE,
    );
    expect(serialized).not.toHaveProperty("offerMode");
    expect(JSON.stringify(serialized)).not.toContain("offerMode");
    expect(JSON.stringify(serialized)).not.toContain("starter");
  });
});
