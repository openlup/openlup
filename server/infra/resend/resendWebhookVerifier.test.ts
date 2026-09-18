import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { verifyResendWebhookSignature } from "./resendWebhookVerifier.js";

describe("verifyResendWebhookSignature", () => {
  const secret = `whsec_${Buffer.from("resend-test-secret").toString("base64")}`;
  const now = 1_800_000_000;

  function signed(rawBody: string, timestamp = String(now), webhookId = "msg_123") {
    const key = Buffer.from(secret.slice("whsec_".length), "base64");
    const signature = createHmac("sha256", key).update(`${webhookId}.${timestamp}.${rawBody}`).digest("base64");
    return { rawBody, webhookId, timestamp, signature: `v1,${signature}`, secret, now: () => now };
  }

  it("accepts the exact Svix-signed raw body and whsec_ decoded bytes", () => {
    const input = signed('{ "type": "email.delivered" }');
    expect(verifyResendWebhookSignature(input)).toBe(true);
    expect(verifyResendWebhookSignature({ ...input, signature: input.signature.slice(3) })).toBe(true);
  });

  it("rejects byte changes, omitted headers, and replays outside five minutes", () => {
    const input = signed('{ "type": "email.delivered" }');
    expect(verifyResendWebhookSignature({ ...input, rawBody: '{"type":"email.delivered"}' })).toBe(false);
    expect(verifyResendWebhookSignature({ ...input, webhookId: undefined })).toBe(false);
    expect(verifyResendWebhookSignature(signed("{}", String(now - 301)))).toBe(false);
  });

  it("rejects malformed whsec_ material instead of authenticating with an empty key", () => {
    const rawBody = "{}";
    const webhookId = "msg_forged";
    const timestamp = String(now);
    const forged = createHmac("sha256", Buffer.alloc(0))
      .update(`${webhookId}.${timestamp}.${rawBody}`)
      .digest("base64");

    for (const malformedSecret of [
      "whsec_",
      "whsec_%%%",
      "whsec_A",
      "whsec_AAAA==",
      "whsec_YQ=",
    ] as const) {
      expect(verifyResendWebhookSignature({
        rawBody,
        webhookId,
        timestamp,
        signature: `v1,${forged}`,
        secret: malformedSecret,
        now: () => now,
      })).toBe(false);
    }
  });
});
