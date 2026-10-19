import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyStandardWebhookSignature } from "../../src/communications/standardWebhooks.js";
import { verifyResendWebhookSignature } from "../../src/communications/resendWebhookVerifier.js";

const instant = 1_920_034_567;
const eventId = "synthetic-notice-42";
const document = '{ "notice": "雪と光" }\n';
const material = Buffer.from("neutral-hook-material");
const encoded = material.toString("base64");

function sign(timestamp: string, key: string | Buffer = material): string {
  return createHmac("sha256", key).update([eventId, timestamp, document].join(".")).digest("base64");
}

async function check(secret: string, signature: string, timestamp = String(instant), body = document) {
  return {
    auth: await verifyStandardWebhookSignature({
      headers: { id: eventId, timestamp, signature }, secret, rawBody: body, now: () => instant * 1000,
    }),
    provider: verifyResendWebhookSignature({
      webhookId: eventId, timestamp, signature, secret, rawBody: body, now: () => instant,
    }),
  };
}

describe("independent webhook protocol policies", () => {
  it.each([
    { form: "literal", secret: material.toString(), auth: true, provider: true },
    { form: "base64 padded", secret: `whsec_${encoded}`, auth: true, provider: true },
    { form: "base64 unpadded", secret: `whsec_${encoded.replace(/=+$/, "")}`, auth: true, provider: true },
    { form: "outer whitespace", secret: `\n${material.toString()}\t`, auth: true, provider: false },
    { form: "versioned encoded secret", secret: `v1,whsec_${encoded}`, auth: true, provider: false },
    { form: "versioned literal secret", secret: `v1,${material.toString()}`, auth: true, provider: false },
  ])("key policy: $form", async ({ secret, auth, provider }) => {
    expect(await check(secret, `v1,discarded-member v1,${sign(String(instant))}`)).toEqual({ auth, provider });
  });

  it.each([
    { grammar: "version one", prefix: "v1,", auth: true, provider: true },
    { grammar: "bare member", prefix: "", auth: true, provider: true },
    { grammar: "other version", prefix: "v7,", auth: true, provider: false },
  ])("rotation signature grammar: $grammar", async ({ prefix, auth, provider }) => {
    const digest = sign(String(instant));
    expect(await check(material.toString(), `v1,wrong ${prefix}${digest} v1,also-wrong`)).toEqual({ auth, provider });
    expect(await check(material.toString(), "v1,wrong v1,also-wrong")).toEqual({ auth: false, provider: false });
  });

  it.each([-300, 300, -301, 301])("replay offset %i with Auth milliseconds and provider seconds", async (offset) => {
    const timestamp = String(instant + offset);
    const accepted = offset >= -300 && offset <= 300;
    expect(await check(material.toString(), sign(timestamp), timestamp)).toEqual({ auth: accepted, provider: accepted });
  });

  it("requires the original whitespace and UTF-8 bytes", async () => {
    const signature = `v1,${sign(String(instant))}`;
    expect(verifyResendWebhookSignature({ rawBody: document, webhookId: undefined, timestamp: String(instant), signature, secret: material.toString(), now: () => instant })).toBe(false);
    expect(await check(material.toString(), signature)).toEqual({ auth: true, provider: true });
    expect(await check(material.toString(), signature, String(instant), document.replace(" }", "}")))
      .toEqual({ auth: false, provider: false });
  });

  it.each(["", "whsec_", "whsec_%", "whsec_Q", "whsec_Zh=="])(
    "refuses unusable secret %j even when permissive decoding signs it", async (secret) => {
      const key = secret.startsWith("whsec_") ? Buffer.from(secret.substring(6), "base64") : secret;
      expect(await check(secret, `v1,${sign(String(instant), key)}`)).toEqual({ auth: false, provider: false });
    },
  );
});
