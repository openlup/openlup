export const pricingAndPromotionsDomain = {
  owned: {
    promotionDefinitions: [
      "commerce_promotion_definitions",
    ],
    promotionClaims: [
      "commerce_promotion_claims",
      "commerce_promotion_claim_events",
    ],
    // AUTHORITATIVE policy tuples include their original-end close marker, byte-exactly.
    priceListsAndPolicies: [
      "price_lists",
      "subscription_price_policy_revisions",
      "price_entries",
    ],
    // AUTHORITATIVE installation marking and the separate, audited baseline.
    offerPolicy: [
      "commerce_offer_policy_cohort_marking",
      "commerce_offer_policy_rollout_baselines",
    ],
  },
  restore: {
    // AUTHORITATIVE policy tuples include their original-end close marker, byte-exactly.
    priceListsPoliciesAndPromotions: [
      "price_lists",
      "subscription_price_policy_revisions",
      "price_entries",
      "commerce_promotion_definitions",
    ],
    offerPolicyBaselines: [
      "commerce_offer_policy_rollout_baselines",
    ],
    promotionClaims: [
      "commerce_promotion_claims",
      "commerce_promotion_claim_events",
    ],
  },
  settings: [
    "commerce_offer_policy_cohort_marking",
  ],
  allowedInsertTriggers: {
    price_entries: ["catalog_publication_live_write"],
    // These guards retain final intervals and recompute the same definition digest.
    subscription_price_policy_revisions: ["subscription_price_policy_revisions_00_guard_insert", "subscription_price_policy_revisions_10_prevent_overlap"],
    commerce_promotion_definitions: ["commerce_promotion_definition_fingerprint_trigger"],
    commerce_offer_policy_rollout_baselines: ["commerce_offer_policy_baseline_insert_guard"],
  },
} as const;
