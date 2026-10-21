import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyStripeSignature } from "../../../src/payments/stripe/webhookSignature.js";

const rawBody = '{ "id": "evt_fixture",\n "note": "zażółć" }\n';
const endpointSecret = "fixture";
const timestamp = 1_800_000_000;
function signed(at = timestamp) {
  const digest = createHmac("sha256", endpointSecret).update(`${at}.${rawBody}`).digest("hex");
  return { rawBody, endpointSecret, signatureHeader: `t=${at},v1=${digest}`, now: () => timestamp };
}

describe("A2 Stripe signature characterization", () => {
  it("S1 verifies exact raw UTF-8 bytes", () => {
    expect(verifyStripeSignature(signed())).toBe(true);
    expect(verifyStripeSignature({ ...signed(), rawBody: JSON.stringify(JSON.parse(rawBody)) })).toBe(false);
  });

  it("S2 refuses a changed body under the original signature", () => {
    expect(verifyStripeSignature({ ...signed(), rawBody: rawBody.replace("evt_fixture", "evt_changed") })).toBe(false);
  });

  it("S3 refuses stale and future timestamps outside the inclusive 300 second bound", () => {
    for (const delta of [-301, 301]) expect(verifyStripeSignature(signed(timestamp + delta))).toBe(false);
    for (const delta of [-300, 300]) expect(verifyStripeSignature(signed(timestamp + delta))).toBe(true);
  });
});
