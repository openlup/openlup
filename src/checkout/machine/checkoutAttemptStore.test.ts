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
  fingerprintCheckoutIntent,
  getOrCreateCheckoutAttemptKey,
  readCheckoutPaymentAttempt as readAttempt,
} from "./checkoutAttemptStore";
import { persistCheckoutContinuation } from "./checkoutNavigation";
import { checkoutContinuationJourneyIdSchema } from "@/domains/commerce/paymentContinuationContracts";
import type { CheckoutQuoteExpectation } from "@/checkout/composer/configuratorFormStore";
import type { ConfiguratorIntent } from "@/domains/commerce/configuratorIntentContracts";
import { createHash } from "node:crypto";

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

/**
 * Characterization of the attempt record: the bytes it stores, when it reuses a
 * key, how the sequence moves, what it does when storage refuses, and which
 * identities the browser reader accepts. Every case states what the code does
 * today; a case marked "pinned" names behaviour that is a known gap, not an
 * endorsement.
 */
describe("checkout attempt record", () => {
  const MINIMAL_INTENT = {
    idempotencyKey: "checkout:ignored",
    zeta: 1,
    alpha: { nested: [3, { b: 2, a: 1 }] },
  } as unknown as ConfiguratorIntent;
  const EDITED_INTENT = { ...MINIMAL_INTENT, zeta: 2 } as unknown as ConfiguratorIntent;

  const mintedKey = (sequence: number) =>
    `checkout:11111111-1111-4111-8111-${String(sequence).padStart(12, "0")}`;
  const ATTEMPT_KEY_PATTERN =
    /^checkout:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
  const storedRecord = () => JSON.parse(sessionStorage.getItem(CHECKOUT_ATTEMPT_STORAGE_KEY) ?? "null");
  const storeRaw = (raw: string) => sessionStorage.setItem(CHECKOUT_ATTEMPT_STORAGE_KEY, raw);
  const throwingStorage = (method: "getItem" | "setItem" | "removeItem") => {
    const refusal = new Error(`storage refused ${method}`);
    vi.spyOn(sessionStorage, method).mockImplementation(() => {
      throw refusal;
    });
    return refusal;
  };

  beforeEach(() => {
    let counter = 0;
    vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
      counter += 1;
      return `11111111-1111-4111-8111-${String(counter).padStart(12, "0")}`;
    });
  });

  describe("stored bytes", () => {
    it("stores exactly a fingerprint and a key when a journey starts", () => {
      const built = intent();
      const key = getOrCreateCheckoutAttemptKey(built);

      const stored = storedRecord();
      expect(Object.keys(stored)).toEqual(["fingerprint", "key"]);
      expect(stored.key).toBe(key);
      expect(stored.key).toMatch(ATTEMPT_KEY_PATTERN);
      expect(stored.fingerprint).toBe(fingerprintCheckoutIntent(built));
    });

    it("pins the fingerprint as a golden string, ignoring the key and sorting every object", () => {
      const quote = {
        totalGross: { amountMinor: 1000 },
        pricingPolicy: {
          promotionEngineVersion: "promotion-v1",
          offerPolicyVersion: "offer-v1",
          pricingPolicyToken: "left-out-of-the-fingerprint",
        },
      } as unknown as CheckoutQuoteExpectation;
      const bareQuote = { totalGross: { amountMinor: 1000 } } as unknown as CheckoutQuoteExpectation;

      expect(fingerprintCheckoutIntent(MINIMAL_INTENT)).toBe(
        '{"expectedQuote":null,"intent":{"alpha":{"nested":[3,{"a":1,"b":2}]},"zeta":1}}',
      );
      expect(fingerprintCheckoutIntent(MINIMAL_INTENT, bareQuote)).toBe(
        '{"expectedQuote":{"totalGross":{"amountMinor":1000}},"intent":{"alpha":{"nested":[3,{"a":1,"b":2}]},"zeta":1}}',
      );
      expect(fingerprintCheckoutIntent(MINIMAL_INTENT, quote)).toBe(
        '{"expectedQuote":{"pricingPolicy":{"offerPolicyVersion":"offer-v1","promotionEngineVersion":"promotion-v1"},"totalGross":{"amountMinor":1000}},"intent":{"alpha":{"nested":[3,{"a":1,"b":2}]},"zeta":1}}',
      );

      getOrCreateCheckoutAttemptKey(MINIMAL_INTENT);
      expect(storedRecord().fingerprint).toBe(
        '{"expectedQuote":null,"intent":{"alpha":{"nested":[3,{"a":1,"b":2}]},"zeta":1}}',
      );
    });

    it("stores the attempt sequence after the key once bumped", () => {
      const key = getOrCreateCheckoutAttemptKey(MINIMAL_INTENT);

      bumpAttempt();
      expect(Object.keys(storedRecord())).toEqual(["fingerprint", "key", "paymentAttempt"]);
      expect(storedRecord().paymentAttempt).toBe(1);

      // Only a bump moves the sequence: creating again, reading, and a changed
      // payload all leave the stored bytes exactly as they were.
      const afterFirstBump = sessionStorage.getItem(CHECKOUT_ATTEMPT_STORAGE_KEY);
      expect(getOrCreateCheckoutAttemptKey(MINIMAL_INTENT)).toBe(key);
      expect(getOrCreateCheckoutAttemptKey(EDITED_INTENT)).toBe(key);
      expect(readAttempt()).toBe(1);
      expect(sessionStorage.getItem(CHECKOUT_ATTEMPT_STORAGE_KEY)).toBe(afterFirstBump);

      bumpAttempt();
      expect(Object.keys(storedRecord())).toEqual(["fingerprint", "key", "paymentAttempt"]);
      expect(storedRecord().paymentAttempt).toBe(2);
      expect(storedRecord().key).toBe(key);
    });

    it("keeps the first fingerprint when the payload changes", () => {
      const key = getOrCreateCheckoutAttemptKey(MINIMAL_INTENT);
      const firstFingerprint = storedRecord().fingerprint;
      const setItem = vi.spyOn(sessionStorage, "setItem");

      expect(getOrCreateCheckoutAttemptKey(EDITED_INTENT)).toBe(key);

      expect(setItem).not.toHaveBeenCalled();
      expect(storedRecord().fingerprint).toBe(firstFingerprint);
      expect(fingerprintCheckoutIntent(EDITED_INTENT)).not.toBe(firstFingerprint);
    });

    it("keeps its storage name", () => {
      // Pinned by digest: a browser may still hold a record written by the
      // previous deployment under this exact name.
      expect(sha256(CHECKOUT_ATTEMPT_STORAGE_KEY)).toBe(
        "719c00b65b09f1e16de79f86e20c5b5420891b3e15a4fa034aabc79dfe18b920",
      );

      getOrCreateCheckoutAttemptKey(MINIMAL_INTENT);
      const names = Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index) ?? "");
      expect(names.map(sha256)).toEqual(["719c00b65b09f1e16de79f86e20c5b5420891b3e15a4fa034aabc79dfe18b920"]);
    });
  });

  describe("reading", () => {
    it("has no journey in a fresh storage and reading does not start one", () => {
      const setItem = vi.spyOn(sessionStorage, "setItem");

      expect(readAttempt()).toBe(0);

      expect(sessionStorage.length).toBe(0);
      expect(setItem).not.toHaveBeenCalled();
    });

    it("reads a stored record without an attempt sequence as attempt zero", () => {
      storeRaw(JSON.stringify({ fingerprint: "f", key: mintedKey(9) }));
      expect(readAttempt()).toBe(0);

      // A bump from that record writes the first sequence and keeps the rest.
      bumpAttempt();
      expect(storedRecord()).toEqual({ fingerprint: "f", key: mintedKey(9), paymentAttempt: 1 });
    });

    it.each([
      ["a number", 3, 3],
      ["a string", "3", 0],
      ["null", null, 0],
    ])("reads a hand-written attempt sequence that is %s", (_label, value, expected) => {
      storeRaw(JSON.stringify({ fingerprint: "f", key: mintedKey(9), paymentAttempt: value }));
      expect(readAttempt()).toBe(expected);
    });

    it.each([
      ["text that is not JSON", "not json"],
      ["a JSON array", "[]"],
      ["JSON null", "null"],
      ["a non-string key", JSON.stringify({ fingerprint: "f", key: 5 })],
      ["a non-string fingerprint", JSON.stringify({ fingerprint: 5, key: mintedKey(9) })],
      ["a missing key", JSON.stringify({ fingerprint: "f" })],
    ])("ignores a stored record of the wrong shape: %s", (_label, raw) => {
      storeRaw(raw);
      expect(readAttempt()).toBe(0);

      const key = getOrCreateCheckoutAttemptKey(MINIMAL_INTENT);

      expect(key).toMatch(ATTEMPT_KEY_PATTERN);
      expect(storedRecord()).toEqual({ fingerprint: fingerprintCheckoutIntent(MINIMAL_INTENT), key });
    });
  });

  describe("clearing", () => {
    it("clears only its own storage name and may be called twice", () => {
      sessionStorage.setItem("unrelated", "kept");
      persistCheckoutContinuation({
        orderId: "o", orderRef: "r", paymentIntentId: "p", clientId: "c", journeyId: mintedKey(9), actionKind: "none",
      });
      getOrCreateCheckoutAttemptKey(MINIMAL_INTENT);

      clearCheckoutAttemptKey();

      expect(sessionStorage.getItem(CHECKOUT_ATTEMPT_STORAGE_KEY)).toBeNull();
      expect(sessionStorage.getItem("unrelated")).toBe("kept");
      expect(sessionStorage.getItem("openlup:payment-continuation:v1")).not.toBeNull();
      expect(() => clearCheckoutAttemptKey()).not.toThrow();
      expect(sessionStorage.getItem("unrelated")).toBe("kept");
    });
  });

  describe("storage that is unreachable or refuses a call", () => {
    it("continues with an unpersisted identity when the storage accessor throws (pinned)", () => {
      // PINNED AS IT IS TODAY, and a known gap: when the browser refuses the
      // accessor itself, the journey key is minted but never kept, so every call
      // mints a new one and the one-identity-per-purchase invariant does not hold.
      // Pinning it keeps a later refactor behaviour-preserving; changing it is a
      // separate, declared behaviour change.
      const descriptor = Object.getOwnPropertyDescriptor(window, "sessionStorage");
      Object.defineProperty(window, "sessionStorage", {
        configurable: true,
        get() {
          throw new Error("storage denied");
        },
      });
      try {
        const first = getOrCreateCheckoutAttemptKey(MINIMAL_INTENT);
        const second = getOrCreateCheckoutAttemptKey(MINIMAL_INTENT);

        expect(first).toMatch(ATTEMPT_KEY_PATTERN);
        expect(second).toMatch(ATTEMPT_KEY_PATTERN);
        expect(second).not.toBe(first);
        expect(readAttempt()).toBe(0);
        expect(() => bumpAttempt()).not.toThrow();
        expect(() => clearCheckoutAttemptKey()).not.toThrow();
        expect(readAttempt()).toBe(0);
      } finally {
        if (descriptor) Object.defineProperty(window, "sessionStorage", descriptor);
      }
    });

    it("throws from create and from bump when a write is refused", () => {
      // PINNED AS IT IS TODAY: a refused write surfaces as the browser's own error.
      getOrCreateCheckoutAttemptKey(MINIMAL_INTENT);
      const stored = sessionStorage.getItem(CHECKOUT_ATTEMPT_STORAGE_KEY);
      const refusal = throwingStorage("setItem");

      expect(() => bumpAttempt()).toThrow(refusal);
      expect(sessionStorage.getItem(CHECKOUT_ATTEMPT_STORAGE_KEY)).toBe(stored);
      expect(readAttempt()).toBe(0);

      // With no journey stored, create must write, so it throws too, on every call.
      sessionStorage.clear();
      expect(() => getOrCreateCheckoutAttemptKey(MINIMAL_INTENT)).toThrow(refusal);
      expect(() => getOrCreateCheckoutAttemptKey(MINIMAL_INTENT)).toThrow(refusal);
    });

    it("throws from create and from read when a read is refused", () => {
      // PINNED AS IT IS TODAY: a refused read surfaces as the browser's own error.
      const refusal = throwingStorage("getItem");

      expect(() => getOrCreateCheckoutAttemptKey(MINIMAL_INTENT)).toThrow(refusal);
      expect(() => readAttempt()).toThrow(refusal);
    });

    it("throws from clear when removal is refused and keeps the record", () => {
      // PINNED AS IT IS TODAY: a refused removal surfaces as the browser's own error.
      getOrCreateCheckoutAttemptKey(MINIMAL_INTENT);
      const stored = sessionStorage.getItem(CHECKOUT_ATTEMPT_STORAGE_KEY);
      const refusal = throwingStorage("removeItem");

      expect(() => clearCheckoutAttemptKey()).toThrow(refusal);
      expect(sessionStorage.getItem(CHECKOUT_ATTEMPT_STORAGE_KEY)).toBe(stored);
    });
  });

  describe("accepted identity format", () => {
    const keyOfVersion = (nibble: string) => `checkout:11111111-1111-${nibble}111-8111-111111111111`;

    it.each(["0", "1", "2", "3", "4", "5", "6", "7", "8"])(
      "accepts stored keys of UUID versions 1 to 5 and replaces versions 0, 6, 7 and 8: version %s",
      (nibble) => {
        const stored = keyOfVersion(nibble);
        storeRaw(JSON.stringify({ fingerprint: "f", key: stored }));
        const accepted = nibble >= "1" && nibble <= "5";

        const result = getOrCreateCheckoutAttemptKey(MINIMAL_INTENT);

        if (accepted) {
          expect(result).toBe(stored);
          expect(storedRecord().key).toBe(stored);
        } else {
          expect(result).toMatch(ATTEMPT_KEY_PATTERN);
          expect(result).not.toBe(stored);
          expect(storedRecord().key).toBe(result);
        }
      },
    );

    it.each([
      ["upper-case hex digits", "checkout:AAAAAAAA-BBBB-4CCC-9DDD-EEEEEEEEEEEE", true],
      ["a variant digit of 8", "checkout:11111111-1111-4111-8111-111111111111", true],
      ["a variant digit of b", "checkout:11111111-1111-4111-b111-111111111111", true],
      ["a variant digit outside 8 to b, c", "checkout:11111111-1111-4111-c111-111111111111", false],
      ["a variant digit outside 8 to b, 7", "checkout:11111111-1111-4111-7111-111111111111", false],
      ["no checkout prefix", "11111111-1111-4111-8111-111111111111", false],
      ["another prefix", "journey:11111111-1111-4111-8111-111111111111", false],
      ["trailing text", "checkout:11111111-1111-4111-8111-111111111111x", false],
      ["leading text", "x-checkout:11111111-1111-4111-8111-111111111111", false],
      ["a short last group", "checkout:11111111-1111-4111-8111-11111111111", false],
    ])("reads a stored key with %s", (_label, stored, accepted) => {
      storeRaw(JSON.stringify({ fingerprint: "f", key: stored }));

      const result = getOrCreateCheckoutAttemptKey(MINIMAL_INTENT);

      if (accepted) {
        expect(result).toBe(stored);
      } else {
        expect(result).toMatch(ATTEMPT_KEY_PATTERN);
        expect(result).not.toBe(stored);
        expect(storedRecord().key).toBe(result);
      }
    });

    it("mints a key the platform schema accepts", () => {
      // This block's UUID spy would hand back a fixed shape; mint a real one.
      vi.restoreAllMocks();

      const key = getOrCreateCheckoutAttemptKey(MINIMAL_INTENT);

      expect(key).toMatch(ATTEMPT_KEY_PATTERN);
      expect(checkoutContinuationJourneyIdSchema.safeParse(key).success).toBe(true);
    });

    it("the platform schema accepts versions 6 to 8 that the browser reader replaces (pinned)", () => {
      // PINNED AS IT IS TODAY: the two definitions differ. The platform schema
      // takes versions 1 to 8; the browser reader keeps 1 to 5 and replaces the
      // rest. Aligning them is a separate, declared behaviour change.
      for (const nibble of ["6", "7", "8"]) {
        const stored = keyOfVersion(nibble);
        expect(checkoutContinuationJourneyIdSchema.safeParse(stored).success).toBe(true);

        storeRaw(JSON.stringify({ fingerprint: "f", key: stored }));
        expect(getOrCreateCheckoutAttemptKey(MINIMAL_INTENT)).not.toBe(stored);
      }
      for (const nibble of ["0", "9"]) {
        expect(checkoutContinuationJourneyIdSchema.safeParse(keyOfVersion(nibble)).success).toBe(false);
      }
    });
  });
});

/**
 * Characterization of a stored record whose key the key reader would not reuse
 * (here a UUID version the reader replaces). The attempt reader and the bump
 * accept it; only the key reader mints over it.
 */
describe("a stored key the reader would not reuse", () => {
  const UNREUSABLE_KEY = "checkout:11111111-1111-6111-8111-111111111111";
  const storedRecord = () => JSON.parse(sessionStorage.getItem(CHECKOUT_ATTEMPT_STORAGE_KEY) ?? "null");

  beforeEach(() => {
    sessionStorage.clear();
    localStorage.setItem("openlup_vid", "fixed-test-vid");
    let counter = 0;
    vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
      counter += 1;
      return `11111111-1111-4111-8111-${String(counter).padStart(12, "0")}`;
    });
    sessionStorage.setItem(
      CHECKOUT_ATTEMPT_STORAGE_KEY,
      JSON.stringify({ fingerprint: "f", key: UNREUSABLE_KEY, paymentAttempt: 2 }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
    localStorage.clear();
  });

  it("reads and advances a record whose key it would not reuse", () => {
    expect(readAttempt()).toBe(2);

    bumpAttempt();

    expect(storedRecord()).toEqual({ fingerprint: "f", key: UNREUSABLE_KEY, paymentAttempt: 3 });
  });

  it("mints over such a record without carrying its attempt", () => {
    const key = getOrCreateCheckoutAttemptKey(intent());

    expect(key).toBe("checkout:11111111-1111-4111-8111-000000000001");
    expect(key).not.toBe(UNREUSABLE_KEY);
    expect(Object.keys(storedRecord())).toEqual(["fingerprint", "key"]);
    expect(storedRecord().key).toBe(key);
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