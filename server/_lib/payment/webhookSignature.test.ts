import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { VercelRequest } from "../types/vercel.js";
import {
  MAX_WEBHOOK_BODY_BYTES,
  readRawBody,
  STRIPE_TIMESTAMP_TOLERANCE_SECONDS,
  verifyHmacSignature,
  verifyStripeSignature,
  WebhookBodyTooLargeError,
} from "./webhookSignature.js";

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

  it("verifies generic HMAC signatures for Tpay-style callbacks", () => {
    const rawBody = JSON.stringify({ eventId: "tpay_evt", status: "correct" });
    const secret = "tpay-secret";

    expect(verifyHmacSignature({
      rawBody,
      secret,
      signatureHeader: hmac(rawBody, secret),
    })).toBe(true);
    expect(verifyHmacSignature({
      rawBody,
      secret,
      signatureHeader: hmac(`${rawBody} `, secret),
    })).toBe(false);
  });

  it("reads body without requiring parsed JSON, preserving raw webhook evidence", async () => {
    await expect(readRawBody({ body: "{\"ok\":true}" } as VercelRequest)).resolves.toBe("{\"ok\":true}");
    await expect(readRawBody({ body: Buffer.from("raw-buffer") } as VercelRequest)).resolves.toBe("raw-buffer");
  });

  it("reads the request stream before req.body, preserving exact provider bytes", async () => {
    // Stripe signs pretty-printed JSON. @vercel/node parses application/json
    // into req.body and a JSON.stringify round-trip would compact it, breaking
    // HMAC verification. The stream must win over the parsed body.
    const prettyBody = "{\n  \"id\": \"evt_stream\",\n  \"type\": \"payment_intent.succeeded\"\n}";
    const streamingReq = {
      // Parsed (compacted) body the platform would expose — must be ignored.
      body: { id: "evt_stream", type: "payment_intent.succeeded" },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(prettyBody, "utf8");
      },
    } as unknown as VercelRequest;

    await expect(readRawBody(streamingReq)).resolves.toBe(prettyBody);
  });

  it("falls back to req.body when the stream is already drained", async () => {
    const drainedReq = {
      body: "{\"ok\":true}",
      // eslint-disable-next-line require-yield
      async *[Symbol.asyncIterator]() {
        return;
      },
    } as unknown as VercelRequest;

    await expect(readRawBody(drainedReq)).resolves.toBe("{\"ok\":true}");
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

  it("rejects an oversized streamed webhook body before fully buffering it", async () => {
    const oversizedReq = {
      async *[Symbol.asyncIterator]() {
        // Two chunks just over the cap — the second pushes past MAX_WEBHOOK_BODY_BYTES.
        yield Buffer.alloc(MAX_WEBHOOK_BODY_BYTES);
        yield Buffer.from("x");
      },
    } as unknown as VercelRequest;

    await expect(readRawBody(oversizedReq)).rejects.toBeInstanceOf(WebhookBodyTooLargeError);
  });

  it("rejects an oversized already-parsed webhook body", async () => {
    const big = "x".repeat(MAX_WEBHOOK_BODY_BYTES + 1);
    await expect(readRawBody({ body: big } as VercelRequest)).rejects.toBeInstanceOf(
      WebhookBodyTooLargeError,
    );
  });
});

function hmac(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}
