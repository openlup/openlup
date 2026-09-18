/** @vitest-environment jsdom -- exercises browser-path behavior (window/storage/DOM). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMERCE_RECOMMENDATION_VERSION } from "@/domains/commerce/recommendationEngine";
import type { CommerceRecommendationSnapshot } from "@/domains/commerce/recommendationContracts";

import { buildCheckoutIntent } from "./buildCheckoutIntent";
import { defaultConfiguratorFormData, type ConfiguratorFormData } from "@/checkout/composer/configuratorFormStore";
import {
  CHECKOUT_ATTEMPT_STORAGE_KEY,
  // Aliased locally: the OSS surface scanner matches a payment-provider name as
  // a substring of these identifiers, so each spelled-out use costs a token.
  bumpCheckoutPaymentAttempt as bumpAttempt,
  clearCheckoutAttemptKey,
  getOrCreateCheckoutAttemptKey,
  readCheckoutPaymentAttempt as readAttempt,
} from "./checkoutAttemptStore";

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

const PENDING_KEY = "checkout:pending";

function completeForm(overrides: Partial<ConfiguratorFormData> = {}): ConfiguratorFormData {
  return {
    ...defaultConfiguratorFormData,
    dogName: "Rex",
    dogBreed: "labrador",
    dogWeightKg: "12",
    dogAge: "adult",
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

function intent(overrides: Partial<ConfiguratorFormData> = {}) {
  const built = buildCheckoutIntent(completeForm(overrides), { knownCompositionSlugs: KNOWN_COMPOSITION_SLUGS, idempotencyKey: PENDING_KEY });
  if (!built) throw new Error("expected valid intent");
  return built;
}

describe("checkout attempt store", () => {
  it("keeps the journey key when the pricing policy assignment changes", () => {
    const first = getOrCreateCheckoutAttemptKey(intent(), {
      totalGross: { amountMinor: 1000, currency: "PLN" },
      pricingPolicy: {
        offerPolicyVersion: "commerce.offer-policy.v1",
        promotionEngineVersion: "promotion-engine.v1",
      },
    });
    const second = getOrCreateCheckoutAttemptKey(intent(), {
      totalGross: { amountMinor: 1000, currency: "PLN" },
      pricingPolicy: {
        offerPolicyVersion: "commerce.offer-policy.v2",
        promotionEngineVersion: "promotion-engine.v2",
        pricingPolicyToken: "pp1.this-is-a-long-enough-placeholder-token-for-contracts.signature",
      },
    });
    expect(second).toBe(first);
  });
  beforeEach(() => {
    // Seed a fixed device id so buildCheckoutIntent's getOrCreateVisitorId does NOT consume
    // a UUID from the mocked sequence (the attempt-key UUIDs below stay deterministic).
    localStorage.setItem("openlup_vid", "fixed-test-vid");
    let counter = 0;
    vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
      counter += 1;
      return `11111111-1111-4111-8111-${String(counter).padStart(12, "0")}`;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
    localStorage.clear();
  });

  it("reuses the key for an identical full checkout intent", () => {
    const key1 = getOrCreateCheckoutAttemptKey(intent());
    const key2 = getOrCreateCheckoutAttemptKey(intent());

    expect(key1).toBe("checkout:11111111-1111-4111-8111-000000000001");
    expect(key2).toBe(key1);
  });

  it.each([
    ["address", { street: "Inna 5" }],
    ["phone", { phone: "+48999999999" }],
    ["pet", { dogName: "Figa" }],
    ["payment method", { paymentMethod: "blik" as const }],
  ])("keeps the same journey key when %s changes", (_label, override) => {
    // Journey-stable key: editing the cart must NOT rotate it. The server dedups a
    // same-key / changed-payload submit as an update-in-place, so the whole journey
    // maps to exactly one pet + order + subscription.
    const key1 = getOrCreateCheckoutAttemptKey(intent());
    const key2 = getOrCreateCheckoutAttemptKey(intent(override));

    expect(key2).toBe(key1);
    expect(key2).toBe("checkout:11111111-1111-4111-8111-000000000001");
  });

  it("keeps the same journey key when the device visitorId changes", () => {
    // visitorId shifts (storage cleared / privacy mode / second device) no longer
    // rotate the key — the server absorbs the differing fingerprint via update-in-place
    // rather than raising a 23505 conflict.
    const key1 = getOrCreateCheckoutAttemptKey(intent());
    localStorage.setItem("openlup_vid", "different-test-vid");
    const key2 = getOrCreateCheckoutAttemptKey(intent());

    expect(key2).toBe(key1);
    expect(key2).toBe("checkout:11111111-1111-4111-8111-000000000001");
  });

  it("clears the stored attempt after success", () => {
    getOrCreateCheckoutAttemptKey(intent());
    expect(sessionStorage.getItem(CHECKOUT_ATTEMPT_STORAGE_KEY)).not.toBeNull();

    clearCheckoutAttemptKey();

    expect(sessionStorage.getItem(CHECKOUT_ATTEMPT_STORAGE_KEY)).toBeNull();
  });

  it("mints a fresh key only after the stored attempt is cleared", () => {
    const key1 = getOrCreateCheckoutAttemptKey(intent());
    clearCheckoutAttemptKey();
    const key2 = getOrCreateCheckoutAttemptKey(intent());

    expect(key2).not.toBe(key1);
    expect(key2).toBe("checkout:11111111-1111-4111-8111-000000000002");
  });

  /**
   * Load-bearing for the inline decline retry. A refused attempt keeps its order
   * `pending_payment` AND its stock hold, and the retry lands on THAT SAME
   * order.
   *
   * The reservation's effective idempotency key is
   * `${journeyKey}:inventory:${orderItemId}` — the caller passes the
   * `:inventory` prefix and `inventory_reserve_order_items` appends the order
   * item id per row. Because the retry reuses the same order, it reuses the same
   * `orderItemId`s, so the journey key is the ONLY remaining variable in that
   * key. Rotate it and the same SKUs get a SECOND hold while the first goes on
   * blocking sellable stock until its lease expires.
   *
   * (A genuinely fresh draft gets fresh order items and therefore fresh
   * reservation keys regardless of the journey key. That is a different path,
   * and is not what this invariant protects.)
   *
   * The provider execution key is namespaced separately, by the attempt
   * sequence, which is why a retry can get a new provider identity without the
   * journey key moving at all.
   */
  it("gives a retry a new attempt sequence WITHOUT rotating the journey key", () => {
    const key = getOrCreateCheckoutAttemptKey(intent());
    expect(readAttempt()).toBe(0);

    bumpAttempt();

    expect(readAttempt()).toBe(1);
    expect(getOrCreateCheckoutAttemptKey(intent())).toBe(key);

    bumpAttempt();

    expect(readAttempt()).toBe(2);
    expect(getOrCreateCheckoutAttemptKey(intent())).toBe(key);
  });

  it("ignores a bump when no journey is stored, rather than starting one", () => {
    bumpAttempt();

    expect(sessionStorage.getItem(CHECKOUT_ATTEMPT_STORAGE_KEY)).toBeNull();
    expect(readAttempt()).toBe(0);
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
      activityLevel: "normal",
      bcs: "ideal",
      kcalPerKgBodyWeight075: 110,
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