import { describe, expect, it } from "vitest";
import { evidenceToken, failureEvidencePayload, serializeFailureEvidence, type PaymentFailureEvidence } from "./paymentFailureEvidence.js";

const observation: PaymentFailureEvidence = {
  version: 1, source: "readback", disposition: "present", refusalVerified: true,
  providerPaymentId: "pi_example", providerChargeId: "ch_current", code: "card_declined",
  declineCode: "insufficient_funds", adviceCode: "try_again_later", adviceOrigin: "provider",
  method: { kind: "card", recoveryMethodKey: "card", interaction: "new_instrument" },
  methodSource: "provider", operation: "one_time_payment",
};

describe("protected failure evidence serialization", () => {
  it("whitelists fields and excludes nested secrets, free text and unexpected keys", () => {
    const input = { ...observation, message: "payer@example.test", secret: "secret_value",
      method: { ...observation.method!, cardNumber: "4242424242424242" } };
    expect(serializeFailureEvidence(input)).toEqual(observation);
    expect(failureEvidencePayload(input)).toEqual({ failureEvidence: observation });
  });

  it.each(["user@example.test", "declined because account has no funds", "x".repeat(97), "code\n", {}, 105])(
    "rejects unsafe or non-code values %s", (value) => expect(evidenceToken(value)).toBeNull(),
  );

  it("never manufactures evidence for a successful observation without diagnostics", () => {
    expect(failureEvidencePayload(undefined)).toEqual({});
    expect(failureEvidencePayload(null)).toEqual({});
  });
});
