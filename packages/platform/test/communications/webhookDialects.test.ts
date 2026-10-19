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
    resend: verifyResendWebhookSignature({
      webhookId: eventId, timestamp, signature, secret, rawBody: body, now: () => instant,
    }),
  };
}

describe("independent webhook protocol policies", () => {
  it.each([
    { form: "literal", secret: material.toString(), auth: true, resend: true },
    { form: "base64 padded", secret: `whsec_${encoded}`, auth: true, resend: true },
    { form: "base64 unpadded", secret: `whsec_${encoded.replace(/=+$/, "")}`, auth: true, resend: true },
    { form: "outer whitespace", secret: `\n${material.toString()}\t`, auth: true, resend: false },
    { form: "versioned encoded secret", secret: `v1,whsec_${encoded}`, auth: true, resend: false },
    { form: "versioned literal secret", secret: `v1,${material.toString()}`, auth: true, resend: false },
  ])("key policy: $form", async ({ secret, auth, resend }) => {
    expect(await check(secret, `v1,discarded-member v1,${sign(String(instant))}`)).toEqual({ auth, resend });
  });

  it.each([
    { grammar: "version one", prefix: "v1,", auth: true, resend: true },
    { grammar: "bare member", prefix: "", auth: true, resend: true },
    { grammar: "other version", prefix: "v7,", auth: true, resend: false },
  ])("rotation signature grammar: $grammar", async ({ prefix, auth, resend }) => {
    const digest = sign(String(instant));
    expect(await check(material.toString(), `v1,wrong ${prefix}${digest} v1,also-wrong`)).toEqual({ auth, resend });
    expect(await check(material.toString(), "v1,wrong v1,also-wrong")).toEqual({ auth: false, resend: false });
  });

  it.each([-300, 300, -301, 301])("replay offset %i with Auth milliseconds and Resend seconds", async (offset) => {
    const timestamp = String(instant + offset);
    const accepted = offset >= -300 && offset <= 300;
    expect(await check(material.toString(), sign(timestamp), timestamp)).toEqual({ auth: accepted, resend: accepted });
  });

  it("requires the original whitespace and UTF-8 bytes", async () => {
    const signature = `v1,${sign(String(instant))}`;
    expect(await check(material.toString(), signature)).toEqual({ auth: true, resend: true });
    expect(await check(material.toString(), signature, String(instant), document.replace(" }", "}")))
      .toEqual({ auth: false, resend: false });
  });

  it.each(["", "whsec_", "whsec_%", "whsec_Q", "whsec_Zh=="])(
    "refuses unusable secret %j even when permissive decoding signs it", async (secret) => {
      const key = secret.startsWith("whsec_") ? Buffer.from(secret.substring(6), "base64") : secret;
      expect(await check(secret, `v1,${sign(String(instant), key)}`)).toEqual({ auth: false, resend: false });
    },
  );
});
