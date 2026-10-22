import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { VercelRequest } from "../types/vercel.js";
import {
  MAX_WEBHOOK_BODY_BYTES,
  readRawBody,
  verifyHmacSignature,
  WebhookBodyTooLargeError,
} from "./webhookSignature.js";

describe("payment webhook signature helpers", () => {
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
