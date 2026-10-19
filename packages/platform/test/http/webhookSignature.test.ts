import { createHmac } from "node:crypto";
import { Readable } from "node:stream";
import { expect, it } from "vitest";
import { MAX_WEBHOOK_BODY_BYTES, readRawBody, timingSafeStringEqual, verifyHmacSignature, WebhookBodyTooLargeError } from "../../src/http/webhookSignature.js";
import type { HttpRequest } from "../../src/http/types.js";

it("reads the stream before the parsed body and preserves signed whitespace and UTF-8 bytes", async () => {
  const raw = ' { "value": "ż" }\n';
  const req = Readable.from([Buffer.from(raw)]);
  Object.defineProperty(req, "body", { get(): never { throw new Error("body getter must stay unread"); } });
  expect(await readRawBody(req as HttpRequest)).toBe(raw);
  const signatureHeader = createHmac("sha256", "synthetic-key").update(raw).digest("hex");
  expect(verifyHmacSignature({ rawBody: raw, signatureHeader, secret: "synthetic-key" })).toBe(true);
  expect(verifyHmacSignature({ rawBody: raw.trim(), signatureHeader, secret: "synthetic-key" })).toBe(false);
});
it("retains empty-stream and non-stream fallback dialects and the inclusive byte cap", async () => {
  for (const body of ["a", Buffer.from("a"), { value: 1 }, undefined]) {
    const expected = body === undefined ? "" : typeof body === "object" && !Buffer.isBuffer(body) ? JSON.stringify(body) : "a";
    expect(await readRawBody({ body } as HttpRequest)).toBe(expected);
    expect(await readRawBody(Object.assign(Readable.from([]), { body }) as HttpRequest)).toBe(expected);
  }
  expect((await readRawBody({ body: "a".repeat(MAX_WEBHOOK_BODY_BYTES) } as HttpRequest)).length).toBe(MAX_WEBHOOK_BODY_BYTES);
});
it("refuses oversized streams and fallback bodies with the existing error bytes", async () => {
  const body = "a".repeat(MAX_WEBHOOK_BODY_BYTES + 1);
  for (const req of [Readable.from([body]), { body }, { body: Buffer.from(body) }, { body: { body } }]) {
    await expect(readRawBody(req as HttpRequest)).rejects.toThrow(WebhookBodyTooLargeError);
    await expect(readRawBody(req instanceof Readable ? Readable.from([body]) as HttpRequest : req as HttpRequest)).rejects.toThrow("Webhook body exceeds maximum size");
  }
});
it("keeps the generic hex HMAC dialect distinct and fails closed on missing or unequal secrets", () => {
  const signature = createHmac("sha256", "synthetic-key").update("body").digest("hex");
  for (const signatureHeader of [undefined, "", `sha256=${signature}`, signature.toUpperCase(), signature.slice(1)]) {
    expect(verifyHmacSignature({ rawBody: "body", signatureHeader, secret: "synthetic-key" })).toBe(false);
  }
  expect(verifyHmacSignature({ rawBody: "body", signatureHeader: signature, secret: "" })).toBe(false);
  expect(timingSafeStringEqual("", "")).toBe(true);
  expect(timingSafeStringEqual("ż", "z")).toBe(false);
});
