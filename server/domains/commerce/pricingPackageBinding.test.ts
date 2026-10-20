import { describe, expect, it } from "vitest";
import * as pricing from "@openlup/platform/pricing";
import * as contracts from "@openlup/platform/pricing/contracts";
import * as reference from "./commercePricingPolicy.js";
import { pricingPolicyRequestSchema, pricingPolicySnapshotSchema } from "../../../src/domains/commerce/offerPolicyContracts.js";

describe("reference pricing package binding", () => {
  it("preserves refusal identity and the browser policy schema binding", () => {
    expect(reference.CommercePricingPolicyRequestError).toBe(pricing.CommercePricingPolicyRequestError);
    expect(reference.CommercePricingPolicyUnavailableError).toBe(pricing.CommercePricingPolicyUnavailableError);
    expect(reference.mapPricingPolicyFailure).toBe(pricing.mapPricingPolicyFailure);
    const failure = new reference.CommercePricingPolicyUnavailableError("private diagnostic");
    expect(pricing.mapPricingPolicyFailure(failure)?.details.policyReason).toBe("other");
    expect(pricing.mapPricingPolicyFailure(new Error("unrelated"))).toBeNull();
    const request = { capability: contracts.OFFER_POLICY_V2_CAPABILITY, token: "x".repeat(32) };
    expect(pricingPolicyRequestSchema.parse(request)).toEqual(pricing.pricingPolicyRequestSchema.parse(request));
    const snapshot = { offerPolicyVersion: contracts.OFFER_POLICY_V2, promotionEngineVersion: contracts.PROMOTION_ENGINE_V2 };
    expect(pricingPolicySnapshotSchema.parse(snapshot)).toEqual(pricing.pricingPolicySnapshotSchema.parse(snapshot));
    const mismatched = { ...snapshot, promotionEngineVersion: contracts.PROMOTION_ENGINE_V1 };
    expect(pricingPolicySnapshotSchema.safeParse(mismatched).success).toBe(false);
    expect(pricing.pricingPolicySnapshotSchema.safeParse(mismatched).success).toBe(false);
  });
});
