import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { STRIPE_TIMESTAMP_TOLERANCE_SECONDS, verifyStripeSignature } from "../../../src/payments/stripe/webhookSignature.js";
describe("payment webhook signature helpers", () => {
  it("verifies Stripe signatures over the raw timestamped payload", () => {
    const rawBody = JSON.stringify({ id: "evt_123", type: "payment_intent.succeeded" });
    const timestamp = "1800000000";
    const endpointSecret = "whsec_test";
    const signature = hmac(`${timestamp}.${rawBody}`, endpointSecret);

    expect(verifyStripeSignature({
      rawBody,
      endpointSecret,
      signatureHeader: `t=${timestamp},v1=${signature}`,
      now: () => 1_800_000_000,
    })).toBe(true);
    expect(verifyStripeSignature({
      rawBody: JSON.stringify({ type: "mutated", id: "evt_123" }),
      endpointSecret,
      signatureHeader: `t=${timestamp},v1=${signature}`,
      now: () => 1_800_000_000,
    })).toBe(false);
  });

  it("rejects a valid signature whose timestamp is outside the tolerance window", () => {
    const rawBody = JSON.stringify({ id: "evt_replay", type: "payment_intent.succeeded" });
    const timestamp = "1800000000";
    const endpointSecret = "whsec_test";
    const signature = hmac(`${timestamp}.${rawBody}`, endpointSecret);
    const header = `t=${timestamp},v1=${signature}`;

    // Fresh (within tolerance) -> accepted.
    expect(verifyStripeSignature({
      rawBody, endpointSecret, signatureHeader: header,
      now: () => 1_800_000_000 + STRIPE_TIMESTAMP_TOLERANCE_SECONDS,
    })).toBe(true);
    // Too old (captured-and-replayed) -> rejected even though the HMAC is valid.
    expect(verifyStripeSignature({
      rawBody, endpointSecret, signatureHeader: header,
      now: () => 1_800_000_000 + STRIPE_TIMESTAMP_TOLERANCE_SECONDS + 1,
    })).toBe(false);
    // Too far in the future -> rejected.
    expect(verifyStripeSignature({
      rawBody, endpointSecret, signatureHeader: header,
      now: () => 1_800_000_000 - STRIPE_TIMESTAMP_TOLERANCE_SECONDS - 1,
    })).toBe(false);
    // Non-numeric timestamp -> rejected.
    expect(verifyStripeSignature({
      rawBody, endpointSecret, signatureHeader: `t=abc,v1=${signature}`,
      now: () => 1_800_000_000,
    })).toBe(false);
  });

  it("accepts a Stripe signature signed by any secret in a multi-secret array", () => {
    const rawBody = JSON.stringify({ id: "evt_multi", type: "payment_intent.succeeded" });
    const timestamp = "1800000001";
    const local = "whsec_local_dev";
    const dashboard = "whsec_dashboard_prod";
    const signatureFromLocal = hmac(`${timestamp}.${rawBody}`, local);

    expect(verifyStripeSignature({
      rawBody,
      endpointSecret: [dashboard, local],
      signatureHeader: `t=${timestamp},v1=${signatureFromLocal}`,
      now: () => 1_800_000_001,
    })).toBe(true);

    expect(verifyStripeSignature({
      rawBody,
      endpointSecret: [dashboard],
      signatureHeader: `t=${timestamp},v1=${signatureFromLocal}`,
      now: () => 1_800_000_001,
    })).toBe(false);
  });

  it("rejects Stripe signatures when no secret is configured", () => {
    expect(verifyStripeSignature({
      rawBody: "{}",
      endpointSecret: [],
      signatureHeader: "t=1,v1=ff",
      now: () => 1,
    })).toBe(false);
    expect(verifyStripeSignature({
      rawBody: "{}",
      endpointSecret: "",
      signatureHeader: "t=1,v1=ff",
      now: () => 1,
    })).toBe(false);
  });

});
function hmac(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}
