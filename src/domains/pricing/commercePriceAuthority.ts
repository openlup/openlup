import {
  CommercePriceAuthorityError,
  type CommercePriceAuthorityPort,
  type CommercePriceAuthorityQuery,
  type CommercePriceAuthorityResult,
} from "./ports.js";
import {
  SubscriptionPricePolicyDigestError,
  assertSubscriptionPricePolicyDigest,
  deriveSubscriptionUnitPrice,
} from "./subscriptionPricePolicy.js";
import type { ResolvedPrice } from "./types.js";

export interface TimedAuthorityValue<T> {
  value: T;
  validFrom: string;
  validTo: string | null;
}

export interface CommercePriceAuthorityReadPort {
  listPriceLists(context: Pick<CommercePriceAuthorityQuery, "regionCode" | "currency">): Promise<ReadonlyArray<TimedAuthorityValue<string>>>;
  listExactBaseEntries(input: { variantId: string; priceListId: string }): Promise<ReadonlyArray<TimedAuthorityValue<ResolvedPrice>>>;
  listExactLegacySubscriptionEntries(input: { variantId: string; priceListId: string }): Promise<ReadonlyArray<TimedAuthorityValue<ResolvedPrice>>>;
  listSubscriptionPolicyHistory(context: Pick<CommercePriceAuthorityQuery, "regionCode" | "currency" | "channel"> & { priceListId: string }): Promise<ReadonlyArray<TimedAuthorityValue<unknown>>>;
}

/** Provider-neutral strict money algorithm; adapters own only persistence reads and row mapping. */
export function createCommercePriceAuthorityPort(
  reads: CommercePriceAuthorityReadPort,
): CommercePriceAuthorityPort {
  return {
    async resolvePrice(query): Promise<CommercePriceAuthorityResult> {
      const atTime = query.atTime ?? new Date().toISOString();
      const priceListId = selectUniqueEffectivePriceList(await reads.listPriceLists(query), atTime);

      const baseCandidates = effective(await reads.listExactBaseEntries({
        variantId: query.variantId,
        priceListId,
      }), atTime);
      if (baseCandidates.length === 0) throw new CommercePriceAuthorityError("base_price_not_found");
      if (baseCandidates.length !== 1) throw new CommercePriceAuthorityError("base_price_ambiguous");
      if (baseCandidates[0]!.value.amountKind !== "gross") {
        throw new CommercePriceAuthorityError("base_price_amount_kind_invalid");
      }

      const base = { ...baseCandidates[0]!.value, resolvedAt: atTime };
      if (query.mode === "one_time") return { kind: "one_time", base, unitPriceMinor: base.unitPriceMinor };

      const policyHistory = await reads.listSubscriptionPolicyHistory({
        priceListId: base.priceListId,
        regionCode: query.regionCode,
        currency: query.currency,
        channel: query.channel,
      });
      if (policyHistory.length === 0) {
        const legacyCandidates = effective(await reads.listExactLegacySubscriptionEntries({
          variantId: query.variantId,
          priceListId: base.priceListId,
        }), atTime);
        if (legacyCandidates.length === 0) throw new CommercePriceAuthorityError("legacy_subscription_price_not_found");
        if (legacyCandidates.length !== 1) throw new CommercePriceAuthorityError("legacy_subscription_price_ambiguous");
        const legacyResolved = { ...legacyCandidates[0]!.value, resolvedAt: atTime };
        return { kind: "subscription_legacy", base, unitPriceMinor: legacyResolved.unitPriceMinor, legacyResolved };
      }

      const effectivePolicies = effective(policyHistory, atTime);
      if (effectivePolicies.length === 0) throw new CommercePriceAuthorityError("subscription_price_policy_not_effective");
      if (effectivePolicies.length !== 1) throw new CommercePriceAuthorityError("subscription_price_policy_ambiguous");
      try {
        const policy = await assertSubscriptionPricePolicyDigest(effectivePolicies[0]!.value);
        return {
          kind: "subscription_policy",
          base,
          unitPriceMinor: deriveSubscriptionUnitPrice(base.unitPriceMinor, policy),
          policy,
        };
      } catch (error) {
        throw new CommercePriceAuthorityError(
          error instanceof SubscriptionPricePolicyDigestError
            ? "subscription_price_policy_digest_mismatch"
            : "subscription_price_policy_invalid",
        );
      }
    },
  };
}

/** The current money context requires one list; creation order cannot resolve overlap. */
export function selectUniqueEffectivePriceList(
  priceLists: readonly TimedAuthorityValue<string>[], atTime: string,
): string {
  const candidates = effective(priceLists, atTime);
  if (candidates.length === 0) throw new CommercePriceAuthorityError("active_price_list_not_found");
  if (candidates.length !== 1) throw new CommercePriceAuthorityError("active_price_list_ambiguous");
  return candidates[0]!.value;
}

function effective<T>(values: readonly TimedAuthorityValue<T>[], atTime: string): TimedAuthorityValue<T>[] {
  const atMs = Date.parse(atTime);
  return values.filter(({ validFrom, validTo }) => {
    const fromMs = Date.parse(validFrom);
    const toMs = validTo === null ? null : Date.parse(validTo);
    return Number.isFinite(atMs) && Number.isFinite(fromMs) && fromMs <= atMs && (toMs === null || toMs > atMs);
  });
}
