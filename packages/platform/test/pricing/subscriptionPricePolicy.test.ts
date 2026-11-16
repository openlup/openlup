import { describe, expect, it } from "vitest";
import {
  SUBSCRIPTION_PRICE_POLICY_DEFAULT_DISCOUNT_BPS,
  SUBSCRIPTION_PRICE_POLICY_DEFAULT_QUANTUM_MINOR,
  SubscriptionPricePolicyDigestError,
  assertSubscriptionPricePolicyDigest,
  canonicalSubscriptionPricePolicyTuple,
  deriveSubscriptionUnitPrice,
  digestSubscriptionPricePolicy,
  subscriptionPricePolicyCanonicalInputSchema,
  subscriptionPricePolicyRevisionSchema,
} from "../../src/pricing/index.js";

function policy() {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    revisionNo: 1,
    priceListId: "22222222-2222-4222-8222-222222222222",
    regionCode: "ZZ",
    currency: "XXX",
    channel: "D2C",
    effectiveFrom: "2026-08-27T00:00:00.000Z",
    effectiveTo: null,
    digest: "a".repeat(64),
    discountBps: SUBSCRIPTION_PRICE_POLICY_DEFAULT_DISCOUNT_BPS,
    roundingQuantumMinor: SUBSCRIPTION_PRICE_POLICY_DEFAULT_QUANTUM_MINOR,
    roundingRule: "FLOOR_TO_QUANTUM" as const,
  };
}

function canonicalPolicyInput() {
  const { digest: _digest, ...input } = policy();
  return input;
}

describe("subscription price policy", () => {
  it("derives the approved 10% price with floor-to-quantum rounding without a policy row", () => {
    expect(deriveSubscriptionUnitPrice(1490, policy())).toBe(1340);
  });

  it("accepts other versioned discount configurations while retaining exact integer semantics", () => {
    expect(deriveSubscriptionUnitPrice(1499, { discountBps: 500, roundingQuantumMinor: 10, roundingRule: "FLOOR_TO_QUANTUM" })).toBe(1420);
  });

  it("uses BigInt arithmetic at the safe-integer boundary and refuses unsafe input", () => {
    const expected = Number(((BigInt(Number.MAX_SAFE_INTEGER) * 9_000n) / 10_000n / 10n) * 10n);
    expect(deriveSubscriptionUnitPrice(Number.MAX_SAFE_INTEGER, policy())).toBe(expected);
    expect(() => deriveSubscriptionUnitPrice(Number.MAX_SAFE_INTEGER + 1, policy())).toThrow(RangeError);
    expect(subscriptionPricePolicyCanonicalInputSchema.safeParse({ ...canonicalPolicyInput(), roundingQuantumMinor: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
  });

  it("rejects malformed effective intervals and invalid policy numbers", () => {
    expect(subscriptionPricePolicyRevisionSchema.safeParse({ ...policy(), effectiveTo: "2026-08-26T23:59:59.000Z" }).success).toBe(false);
    expect(subscriptionPricePolicyRevisionSchema.safeParse({ ...policy(), discountBps: 10_001 }).success).toBe(false);
    expect(() => deriveSubscriptionUnitPrice(-1, policy())).toThrow(RangeError);
  });

  it("hashes canonical input without a placeholder digest and excludes a validated persisted digest", async () => {
    const first = await digestSubscriptionPricePolicy(canonicalPolicyInput());
    const reordered = { roundingRule: "FLOOR_TO_QUANTUM" as const, ...canonicalPolicyInput() };
    const second = await digestSubscriptionPricePolicy(reordered);
    const changedPersistedDigest = { ...policy(), digest: "c".repeat(64) };

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
    expect(canonicalSubscriptionPricePolicyTuple(policy())).toBe(canonicalSubscriptionPricePolicyTuple(changedPersistedDigest));
    expect(canonicalSubscriptionPricePolicyTuple(policy())).toContain('"discountBps":1000');
    expect(() => canonicalSubscriptionPricePolicyTuple({ ...canonicalPolicyInput(), digest: "not-a-digest" } as never)).toThrow();
  });

  it("parses a revision before verifying its stored digest against canonical UTF-8 bytes", async () => {
    const digest = await digestSubscriptionPricePolicy(canonicalPolicyInput());
    const revision = { ...canonicalPolicyInput(), digest };

    await expect(assertSubscriptionPricePolicyDigest(revision)).resolves.toEqual(revision);
    await expect(assertSubscriptionPricePolicyDigest({ ...revision, digest: "a".repeat(64) })).rejects.toMatchObject({
      name: SubscriptionPricePolicyDigestError.name,
      code: "subscription_price_policy_digest_mismatch",
    });
    await expect(assertSubscriptionPricePolicyDigest({ ...revision, digest: "not-a-digest" })).rejects.toThrow();
  });
  it("policy_close_preserves_original_digest", async () => {
    const original = { ...canonicalPolicyInput(), digest: await digestSubscriptionPricePolicy(canonicalPolicyInput()) };
    const closed = { ...original, effectiveTo: "2026-09-01T00:00:00.000Z", closedFromOpen: true };
    expect(await assertSubscriptionPricePolicyDigest(closed)).toEqual(closed);
    expect(canonicalSubscriptionPricePolicyTuple(closed)).toBe(canonicalSubscriptionPricePolicyTuple(original));
    expect(await digestSubscriptionPricePolicy(closed)).toBe(original.digest);
    await expect(assertSubscriptionPricePolicyDigest({ ...closed, closedFromOpen: false }))
      .rejects.toMatchObject({ code: "subscription_price_policy_original_tuple_unverified" });
    const finite = { ...canonicalPolicyInput(), effectiveTo: closed.effectiveTo };
    await expect(assertSubscriptionPricePolicyDigest({ ...finite, digest: await digestSubscriptionPricePolicy(finite) }))
      .resolves.toEqual({ ...finite, digest: await digestSubscriptionPricePolicy(finite) });
  });

  it.each([
    { id: "33333333-3333-4333-8333-333333333333" }, { revisionNo: 2 },
    { priceListId: "33333333-3333-4333-8333-333333333333" }, { regionCode: "YY" },
    { currency: "YYY" }, { channel: "OTHER" }, { effectiveFrom: "2026-08-28T00:00:00.000Z" },
    { discountBps: 999 }, { roundingQuantumMinor: 1 }, { digest: "b".repeat(64) },
  ])("refuses a tampered original tuple after close: %j", async change => {
    const digest = await digestSubscriptionPricePolicy(canonicalPolicyInput());
    await expect(assertSubscriptionPricePolicyDigest({ ...policy(), digest, effectiveTo: "2026-09-01T00:00:00.000Z", closedFromOpen: true, ...change }))
      .rejects.toMatchObject({ code: "subscription_price_policy_digest_mismatch" });
  });

  it.each([null, "2026-08-27T00:00:00.000Z", "2026-08-26T00:00:00.000Z", "invalid"])(
    "refuses a malformed close window: %s", async effectiveTo => {
      const digest = await digestSubscriptionPricePolicy(canonicalPolicyInput());
      await expect(assertSubscriptionPricePolicyDigest({ ...policy(), digest, effectiveTo, closedFromOpen: true })).rejects.toThrow();
    });
});
