import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyStripeWebhookSignature } from "./stripe/webhookVerifier.js";
import { verifyTpayWebhookSignature } from "./tpay/webhookVerifier.js";

describe("provider webhook signature verifiers", () => {
  it("verifies Stripe timestamped HMAC signatures", () => {
    const payload = JSON.stringify({ id: "evt_123" });
    const secret = "whsec_test";
    const timestamp = "1812290400";
    const signature = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");

    expect(
      verifyStripeWebhookSignature({
        payload,
        secret,
        signatureHeader: `t=${timestamp},v1=${signature}`,
      }),
    ).toBe(true);
    expect(
      verifyStripeWebhookSignature({
        payload,
        secret,
        signatureHeader: `t=${timestamp},v1=bad`,
      }),
    ).toBe(false);
  });

  it("verifies Tpay webhook HMAC signatures", () => {
    const payload = JSON.stringify({ event_id: "evt_123" });
    const secret = "tpay_secret";
    const signature = createHmac("sha256", secret).update(payload).digest("hex");

    expect(verifyTpayWebhookSignature({ payload, secret, signatureHeader: signature })).toBe(true);
    expect(verifyTpayWebhookSignature({ payload, secret, signatureHeader: "bad" })).toBe(false);
  });
});
