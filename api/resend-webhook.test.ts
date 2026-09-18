import { Readable } from "node:stream";
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { config, createResendWebhookRouteHandler } from "./resend-webhook.js";

const now = Math.floor(Date.now() / 1000);
const secret = `whsec_${Buffer.from("resend-test-secret").toString("base64")}`;

function response() {
  const res = {
    statusCode: 200,
    headers: new Map<string, unknown>(),
    setHeader(key: string, value: unknown) { this.headers.set(key, value); return this; },
    status(code: number) { this.statusCode = code; return this; },
    json: vi.fn(),
  };
  return res;
}

describe("/api/resend-webhook", () => {
  it("declares a stream-first Vercel binding and verifies the stream bytes", async () => {
    const rawBody = '{ "type": "email.unknown", "data": {} }';
    const id = "evt_raw";
    const timestamp = String(now);
    const signature = createHmac("sha256", Buffer.from(secret.slice(6), "base64"))
      .update(`${id}.${timestamp}.${rawBody}`).digest("base64");
    const recordAttempt = vi.fn().mockResolvedValue(undefined);
    const handler = createResendWebhookRouteHandler({
      webhookSecret: secret,
      createPort: () => ({
        findEmailSendByResendId: vi.fn(),
        applyProviderEvent: vi.fn(),
        recordAttempt,
      }),
    });
    const req = Readable.from([Buffer.from(rawBody)]) as never;
    Object.assign(req, { method: "POST", headers: {
      "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${signature}`,
    }, query: {} });
    const res = response();
    await handler(req, res as never);
    expect(config).toEqual({ api: { bodyParser: false } });
    expect(res.statusCode).toBe(200);
    expect(res.json).toHaveBeenCalledWith({ ignored: true });
    expect(recordAttempt).toHaveBeenCalledWith(expect.objectContaining({ outcome: "unsupported_event" }));
  });
});
