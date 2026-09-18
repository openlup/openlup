import { describe, expect, it } from "vitest";

import {
  isTargetPercentageMirror,
  isTechnicalFirstSubscriptionLegacy,
  mapAdminPromotion,
} from "./adminPromotionSemantic.js";
import { readSettlementProfile } from "../../../src/lib/currency/platformCurrency.js";

// The currency the mapper is handed comes from the settlement profile in production, so
// the test asks the same reader rather than restating an answer it could get wrong.
const SETTLEMENT_CURRENCY = readSettlementProfile(process.env).defaultCurrency;

describe("admin promotion semantic mapping", () => {
  it("derives a system-managed target and exact unit price from mirror semantics", () => {
    const result = mapAdminPromotion(legacyTechnical(), mirror(), [{
      variantId: "variant-1",
      sku: "OPENLUP-DOG-BEEF-CAN-400G",
      oneTimeMinor: 1_490,
      subscriptionMinor: 1_340,
      percent: 10,
    }], SETTLEMENT_CURRENCY);

    expect(result).toMatchObject({
      systemManaged: true,
      readOnly: true,
      v2Mirror: { id: "mirror", status: "paused" },
      semanticBenefit: {
        kind: "target_percentage",
        valueBps: 5_000,
        unitTargets: [{ referenceMinor: 1_490, targetMinor: 745 }],
      },
    });
  });

  it("exposes no mirror handle when the mirror row lacks a clean id or status", () => {
    const withoutId = mapAdminPromotion(legacyTechnical(), { ...mirror(), id: undefined }, [], SETTLEMENT_CURRENCY);
    const badStatus = mapAdminPromotion(legacyTechnical(), { ...mirror(), status: "enabled" }, [], SETTLEMENT_CURRENCY);

    expect(withoutId.v2Mirror).toBeNull();
    expect(badStatus.v2Mirror).toBeNull();
    expect(withoutId.readOnly).toBe(true);
  });

  it("recognizes canonical v2 target metadata without consulting a display name", () => {
    expect(isTargetPercentageMirror({ ...mirror(), name: "dowolna nazwa" })).toBe(true);
    expect(isTargetPercentageMirror({ ...mirror(), benefit_value_bps: 10_000 })).toBe(false);
  });

  it("fails closed on the technical legacy shape when the mirror is unavailable", () => {
    const technical = { ...legacyTechnical(), name: "dowolna nazwa" };

    expect(isTechnicalFirstSubscriptionLegacy(technical)).toBe(true);
    expect(mapAdminPromotion(technical, undefined, [], SETTLEMENT_CURRENCY)).toMatchObject({
      systemManaged: true,
      readOnly: true,
      v2Mirror: null,
      semanticBenefit: {
        kind: "unavailable",
        reason: "system_managed_metadata_incomplete",
      },
    });
  });
});

function legacyTechnical() {
  return {
    id: "legacy",
    code: null,
    name: "First Subscription 50%",
    trigger_type: "automatic",
    discount_type: "percentage",
    discount_value: 44.404,
    applies_to_kind: "order_total",
    stacking_rule: "exclusive",
    eligibility: { first_subscription_purchase: true },
    valid_from: "2026-01-01T00:00:00.000Z",
    valid_to: null,
    status: "active",
    region_availability: ["PL"],
    redemption_limit_global: null,
    redemption_limit_per_customer: 1,
    promotion_engine_version: "promotion-engine.v1",
  };
}

function mirror() {
  return {
    id: "mirror",
    status: "paused",
    promotion_engine_version: "promotion-engine.v2",
    benefit_lane: "product",
    benefit_kind: "target_percentage",
    benefit_value_bps: 5_000,
    v2_mirror_of: "legacy",
  };
}
