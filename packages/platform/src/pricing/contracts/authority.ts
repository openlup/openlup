import type { ResolvedPrice } from "@openlup/core/pricing";
import type { SubscriptionPricePolicyRevision } from "./policy.js";

/** Exact settlement context for a current quote price; tiers and open-mode fallbacks are excluded. */
export interface CommercePriceAuthorityQuery {
  variantId: string;
  mode: "one_time" | "subscription";
  regionCode: string;
  currency: string;
  channel: string;
  atTime?: string;
}

export interface CommerceBasePriceObservation {
  /** The sole active/effective `one_time`, `min_qty=1` entry. */
  base: ResolvedPrice;
  unitPriceMinor: number;
}

export type CommercePriceAuthorityResult =
  | (CommerceBasePriceObservation & { kind: "one_time" })
  | (CommerceBasePriceObservation & {
      kind: "subscription_policy";
      policy: SubscriptionPricePolicyRevision;
    })
  | (CommerceBasePriceObservation & {
      /** Explicit compatibility observation allowed only before this context has policy history. */
      kind: "subscription_legacy";
      legacyResolved: ResolvedPrice;
    });

export type CommercePriceAuthorityRefusal =
  | "active_price_list_not_found"
  | "active_price_list_ambiguous"
  | "base_price_not_found"
  | "base_price_ambiguous"
  | "base_price_amount_kind_invalid"
  | "legacy_subscription_price_not_found"
  | "legacy_subscription_price_ambiguous"
  | "subscription_price_policy_not_effective"
  | "subscription_price_policy_ambiguous"
  | "subscription_price_policy_invalid"
  | "subscription_price_policy_digest_mismatch";

