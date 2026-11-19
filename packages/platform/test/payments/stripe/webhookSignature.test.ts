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

  it("verifies rolling multi-v1 headers across secret rotation and fails closed on invalid headers", () => {
    const rawBody = JSON.stringify({ id: "evt_rotate", type: "payment_intent.succeeded" });
    const timestamp = "1800000010";
    const oldSecret = "whsec_old_secret";
    const newSecret = "whsec_new_secret";
    const sigOld = hmac(`${timestamp}.${rawBody}`, oldSecret);
    const sigNew = hmac(`${timestamp}.${rawBody}`, newSecret);
    const bogus = "0".repeat(sigNew.length);

    // Valid signature in FIRST v1 slot (previously overwritten by Object.fromEntries).
    expect(verifyStripeSignature({
      rawBody,
      endpointSecret: newSecret,
      signatureHeader: `t=${timestamp},v1=${sigNew},v1=${bogus}`,
      now: () => 1_800_000_010,
    })).toBe(true);

    // Valid signature in SECOND v1 slot.
    expect(verifyStripeSignature({
      rawBody,
      endpointSecret: newSecret,
      signatureHeader: `t=${timestamp},v1=${bogus},v1=${sigNew}`,
      now: () => 1_800_000_010,
    })).toBe(true);

    // Multi-v1 combined with multi-secret array and whitespace / v0 entries.
    expect(verifyStripeSignature({
      rawBody,
      endpointSecret: [oldSecret, newSecret],
      signatureHeader: `t=${timestamp}, v0=legacy, v1=${sigOld}, v1=${bogus}`,
      now: () => 1_800_000_010,
    })).toBe(true);

    // Multiple invalid v1 signatures (including differing lengths) -> false.
    expect(verifyStripeSignature({
      rawBody,
      endpointSecret: newSecret,
      signatureHeader: `t=${timestamp},v1=deadbeef,v1=${bogus}`,
      now: () => 1_800_000_010,
    })).toBe(false);

    // Conflicting duplicate t= timestamps -> fail closed.
    expect(verifyStripeSignature({
      rawBody,
      endpointSecret: newSecret,
      signatureHeader: `t=${timestamp},t=1800000099,v1=${sigNew}`,
      now: () => 1_800_000_010,
    })).toBe(false);

    // Multi-v1 with stale timestamp -> false.
    expect(verifyStripeSignature({
      rawBody,
      endpointSecret: newSecret,
      signatureHeader: `t=${timestamp},v1=${sigNew},v1=${sigOld}`,
      now: () => 1_800_000_010 + STRIPE_TIMESTAMP_TOLERANCE_SECONDS + 1,
    })).toBe(false);
  });

});
function hmac(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}
