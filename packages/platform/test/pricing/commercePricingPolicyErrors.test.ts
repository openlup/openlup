import { describe, expect, it } from "vitest";
import { CommercePricingPolicyRequestError, PRICING_POLICY_REQUEST_REASONS, mapPricingPolicyFailure } from "../../src/pricing/index.js";

describe("commerce pricing policy errors", () => {
  // ⛔ The second way a caller-side refusal can go dark, and it is not the
  // monitor's end. `policy_reason` is what the monitors key on, and
  // safePricingPolicyReason() collapses anything outside the safe set to
  // "other". A reason that is thrown but never added to SAFE_PRICING_POLICY_REASONS
  // is logged as "other", matches no monitor's filter, and produces exactly the
  // silence this pair of guards exists to prevent - one holds the reason to a
  // monitor, this one holds it to a legible log field.
  it("publishes every caller-side reason verbatim, so a monitor can key on it", () => {
    for (const reason of PRICING_POLICY_REQUEST_REASONS) {
      const mapped = mapPricingPolicyFailure(new CommercePricingPolicyRequestError(reason));

      expect(mapped, `${reason} must map`).not.toBeNull();
      expect(mapped!.code, `${reason} is caller-side`).toBe("BAD_REQUEST");
      expect(mapped!.details.reason).toBe("pricing_policy_request_invalid");
      // Never "other": that is the redaction that would erase the alert key.
      expect(mapped!.details.policyReason, `${reason} was redacted`).toBe(reason);
    }
  });
});
