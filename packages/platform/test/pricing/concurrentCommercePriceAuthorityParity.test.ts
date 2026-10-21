import { expect, it, vi } from "vitest";
import type { ResolvedPrice } from "@openlup/core/pricing";
import { createConcurrentCommercePriceAuthorityPort, digestSubscriptionPricePolicy, type CommercePriceAuthorityReadPort, type CommercePriceAuthorityQuery, type TimedAuthorityValue } from "../../src/pricing/index.js";
const instant = "2026-07-12T00:00:00Z";
const query: CommercePriceAuthorityQuery = { variantId: "part-p", currency: "XXX", regionCode: "ZZ", channel: "synthetic", mode: "subscription", atTime: instant };
const base: ResolvedPrice = { variantId: query.variantId, mode: "one_time", unitPriceMinor: 2400, amountKind: "gross", matchedMinQty: 1, priceListId: "observed-list", priceEntryId: "entry-p", resolvedAt: instant };
const timed = <T>(value: T): TimedAuthorityValue<T> => ({ value, validFrom: instant, validTo: null });
function reads(delta: Partial<CommercePriceAuthorityReadPort> = {}): CommercePriceAuthorityReadPort {
  return { listPriceLists: async () => [timed("d6000000-0000-4000-8000-000000000031")], listExactBaseEntries: async () => [timed(base)], listExactLegacySubscriptionEntries: async () => [timed({ ...base, mode: "subscription", unitPriceMinor: 2200 })], listSubscriptionPolicyHistory: async () => [], ...delta };
}
it("starts bounded concurrent history and preserves every base refusal over captured history errors", async () => {
  const events: string[] = [];
  let release!: (rows: TimedAuthorityValue<ResolvedPrice>[]) => void;
  const pending = new Promise<TimedAuthorityValue<ResolvedPrice>[]>(resolve => { release = resolve; });
  const failure = new Error("synthetic history failure");
  const authority = createConcurrentCommercePriceAuthorityPort(reads({ listExactBaseEntries: () => { events.push("base:start"); return pending; }, listSubscriptionPolicyHistory: async () => { events.push("history:start"); release([]); throw failure; } }));
  await expect(authority.resolvePrice(query)).rejects.toMatchObject({ code: "base_price_not_found" });
  expect(events).toEqual(["base:start", "history:start"]);
  for (const [rows, code] of [[[], "base_price_not_found"], [[timed(base), timed(base)], "base_price_ambiguous"], [[timed({ ...base, amountKind: "net" })], "base_price_amount_kind_invalid"]] as const) {
    const history = vi.fn(() => { throw failure; });
    await expect(createConcurrentCommercePriceAuthorityPort(reads({ listExactBaseEntries: async () => [...rows] as TimedAuthorityValue<ResolvedPrice>[], listSubscriptionPolicyHistory: history })).resolvePrice(query)).rejects.toMatchObject({ code });
    expect(history).toHaveBeenCalledOnce();
  }
  await expect(createConcurrentCommercePriceAuthorityPort(reads({ listSubscriptionPolicyHistory: async () => { throw failure; } })).resolvePrice(query)).rejects.toBe(failure);
});
it("uses the selected list for history while legacy lookup retains the validated base identity", async () => {
  const history = vi.fn(async () => []);
  const legacy = vi.fn(async () => [timed({ ...base, mode: "subscription" as const, unitPriceMinor: 2200 })]);
  expect(await createConcurrentCommercePriceAuthorityPort(reads({ listSubscriptionPolicyHistory: history, listExactLegacySubscriptionEntries: legacy })).resolvePrice(query)).toMatchObject({ kind: "subscription_legacy", unitPriceMinor: 2200 });
  expect(history).toHaveBeenCalledWith({ priceListId: "d6000000-0000-4000-8000-000000000031", regionCode: "ZZ", currency: "XXX", channel: "synthetic" });
  expect(legacy).toHaveBeenCalledWith({ variantId: "part-p", priceListId: "observed-list" });
});
it("does not schedule history or legacy for one-time requests", async () => {
  const history = vi.fn(async () => { throw new Error("must not read history"); });
  const legacy = vi.fn(async () => []);
  expect(await createConcurrentCommercePriceAuthorityPort(reads({ listSubscriptionPolicyHistory: history, listExactLegacySubscriptionEntries: legacy })).resolvePrice({ ...query, mode: "one_time" })).toEqual({ kind: "one_time", base: { ...base, resolvedAt: instant }, unitPriceMinor: 2400 });
  expect(history).not.toHaveBeenCalled(); expect(legacy).not.toHaveBeenCalled();
});
it("isolates concurrent request history and policy results with no legacy read on recorded history", async () => {
  const policy = { id: "d6000000-0000-4000-8000-000000000032", revisionNo: 1, priceListId: "d6000000-0000-4000-8000-000000000031", regionCode: "ZZ", currency: "XXX", channel: "left", discountBps: 2500, roundingQuantumMinor: 1, roundingRule: "FLOOR_TO_QUANTUM" as const, effectiveFrom: instant, effectiveTo: null };
  const valid = { ...policy, digest: await digestSubscriptionPricePolicy(policy) };
  const calls: string[] = [];
  let release!: (rows: TimedAuthorityValue<unknown>[]) => void;
  const pending = new Promise<TimedAuthorityValue<unknown>[]>(resolve => { release = resolve; });
  const legacy = vi.fn(async () => []);
  const authority = createConcurrentCommercePriceAuthorityPort(reads({ listExactLegacySubscriptionEntries: legacy, listSubscriptionPolicyHistory: async input => { calls.push(input.channel); if (input.channel === "left") return pending; release([timed(valid)]); return [timed({ invalid: true })]; } }));
  const outcomes = await Promise.allSettled([authority.resolvePrice({ ...query, channel: "left" }), authority.resolvePrice({ ...query, channel: "right" })]);
  expect(outcomes[0]).toMatchObject({ status: "fulfilled", value: { kind: "subscription_policy", unitPriceMinor: 1800 } });
  expect(outcomes[1]).toMatchObject({ status: "rejected", reason: { code: "subscription_price_policy_invalid" } });
  expect(calls).toEqual(["left", "right"]); expect(legacy).not.toHaveBeenCalled();
});
