import { describe, expect, it, vi } from "vitest";

import { createCommercePriceAuthorityPort, type CommercePriceAuthorityReadPort, type TimedAuthorityValue } from "./commercePriceAuthority.js";
import { type CommercePriceAuthorityQuery } from "./ports.js";
import { digestSubscriptionPricePolicy } from "./subscriptionPricePolicy.js";
import type { ResolvedPrice } from "./types.js";

const LIST_ID = "00000000-0000-4000-8000-000000000001";
const NOW = "2026-09-09T10:00:00.000Z";
const BEFORE = "2026-09-09T09:59:59.999Z";
const AFTER = "2026-09-09T10:00:00.001Z";
const QUERY: CommercePriceAuthorityQuery = {
  variantId: "variant-a", mode: "subscription", regionCode: "AA", currency: "XXX", channel: "D2C", atTime: NOW,
};

const BASE: ResolvedPrice = {
  variantId: QUERY.variantId, mode: "one_time", matchedMinQty: 1, unitPriceMinor: 1_490,
  amountKind: "gross", priceListId: LIST_ID, priceEntryId: "base-entry", resolvedAt: BEFORE,
};

function timed<T>(value: T, validFrom = BEFORE, validTo: string | null = null): TimedAuthorityValue<T> {
  return { value, validFrom, validTo };
}

function reads(overrides: Partial<CommercePriceAuthorityReadPort> = {}): CommercePriceAuthorityReadPort {
  return {
    listPriceLists: async () => [timed(LIST_ID)],
    listExactBaseEntries: async () => [timed(BASE)],
    listExactLegacySubscriptionEntries: async () => [timed({ ...BASE, mode: "subscription", unitPriceMinor: 1_400 })],
    listSubscriptionPolicyHistory: async () => [],
    ...overrides,
  };
}

async function policy(validFrom = BEFORE, validTo: string | null = null) {
  const canonical = {
    id: "00000000-0000-4000-8000-000000000002", revisionNo: 1,
    priceListId: LIST_ID, regionCode: QUERY.regionCode, currency: QUERY.currency, channel: QUERY.channel,
    discountBps: 1_000, roundingQuantumMinor: 10, roundingRule: "FLOOR_TO_QUANTUM" as const,
    effectiveFrom: validFrom, effectiveTo: validTo,
  };
  return timed({ ...canonical, digest: await digestSubscriptionPricePolicy(canonical) }, validFrom, validTo);
}

describe("strict commerce price authority", () => {
  it.each([
    ["future", timed("other-list", AFTER)],
    ["expired", timed("other-list", BEFORE, NOW)],
  ])("selects the current list with a %s list present", async (_name, otherList) => {
    const listExactBaseEntries = vi.fn(async () => [timed(BASE)]);
    const authority = createCommercePriceAuthorityPort(reads({
      listPriceLists: async () => [otherList, timed(LIST_ID, NOW)], listExactBaseEntries,
    }));
    await expect(authority.resolvePrice({ ...QUERY, mode: "one_time" })).resolves.toMatchObject({
      kind: "one_time", unitPriceMinor: 1_490, base: { priceListId: LIST_ID, resolvedAt: NOW },
    });
    expect(listExactBaseEntries).toHaveBeenCalledWith({ variantId: QUERY.variantId, priceListId: LIST_ID });
  });

  it.each([
    ["no list", [], "active_price_list_not_found"],
    ["future list", [timed(LIST_ID, AFTER)], "active_price_list_not_found"],
    ["expired list", [timed(LIST_ID, BEFORE, NOW)], "active_price_list_not_found"],
    ["overlap", [timed(LIST_ID), timed("other-list", NOW)], "active_price_list_ambiguous"],
  ])("refuses %s before resolving entries", async (_name, priceLists, code) => {
    const listExactBaseEntries = vi.fn(async () => [timed(BASE)]);
    const authority = createCommercePriceAuthorityPort(reads({ listPriceLists: async () => priceLists, listExactBaseEntries }));
    await expect(authority.resolvePrice(QUERY)).rejects.toMatchObject({ code });
    expect(listExactBaseEntries).not.toHaveBeenCalled();
  });

  it("accepts adjacent lists and policies at their inclusive start and exclusive end", async () => {
    const authority = createCommercePriceAuthorityPort(reads({
      listPriceLists: async () => [timed("expired-list", BEFORE, NOW), timed(LIST_ID, NOW)],
      listExactBaseEntries: async () => [timed(BASE, NOW)],
      listSubscriptionPolicyHistory: async () => [await policy(BEFORE, NOW), await policy(NOW)],
    }));
    await expect(authority.resolvePrice(QUERY)).resolves.toMatchObject({
      kind: "subscription_policy", unitPriceMinor: 1_340, base: { resolvedAt: NOW },
    });
  });

  it.each(["future", "gap"])("refuses %s policy history without reading available legacy prices", async (shape) => {
    const listExactLegacySubscriptionEntries = vi.fn(async () => [timed({ ...BASE, mode: "subscription" as const })]);
    const authority = createCommercePriceAuthorityPort(reads({
      listSubscriptionPolicyHistory: async () => shape === "future"
        ? [await policy(AFTER)] : [await policy(BEFORE, NOW), await policy(AFTER)],
      listExactLegacySubscriptionEntries,
    }));
    await expect(authority.resolvePrice(QUERY)).rejects.toMatchObject({ code: "subscription_price_policy_not_effective" });
    expect(listExactLegacySubscriptionEntries).not.toHaveBeenCalled();
  });

  it("allows the effective stored subscription price only without policy history", async () => {
    const authority = createCommercePriceAuthorityPort(reads());
    await expect(authority.resolvePrice(QUERY)).resolves.toMatchObject({
      kind: "subscription_legacy", unitPriceMinor: 1_400, legacyResolved: { resolvedAt: NOW },
    });
  });

  it("refuses overlapping policies even when a legacy row exists", async () => {
    const authority = createCommercePriceAuthorityPort(reads({
      listSubscriptionPolicyHistory: async () => [await policy(BEFORE), await policy(NOW)],
    }));
    await expect(authority.resolvePrice(QUERY)).rejects.toMatchObject({ code: "subscription_price_policy_ambiguous" });
  });

  it("propagates list read errors unchanged", async () => {
    const failure = new Error("read unavailable");
    const authority = createCommercePriceAuthorityPort(reads({ listPriceLists: async () => { throw failure; } }));
    await expect(authority.resolvePrice(QUERY)).rejects.toBe(failure);
  });
});
