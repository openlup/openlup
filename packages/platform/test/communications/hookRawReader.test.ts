import { createHmac } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createAuthSendEmailHookCandidate } from "../../src/communications/authSendEmailHook.js";
import { MAX_WEBHOOK_BODY_BYTES, readRawBody, WebhookBodyTooLargeError } from "../../src/http/webhookSignature.js";
import type { HttpRequest, HttpResponse } from "../../src/http/types.js";

it.each(["stream precedence", "drained stream", "large stream"] as const)(
  "Auth raw reader: %s", async (scenario) => {
    const raw = scenario === "drained stream" ? "" : scenario === "large stream"
      ? JSON.stringify({ filler: "λ".repeat(MAX_WEBHOOK_BODY_BYTES / 2) }) : '{ "unrecognized": "光" }';
    const denied = vi.fn(() => { throw new Error("payload refusal must precede downstream effects"); });
    const handler = createAuthSendEmailHookCandidate({
      hookSecret: "synthetic-reader-secret", authServiceUrl: "https://identity.example.invalid",
      defaultOrigin: "https://portal.example.invalid", fromEmail: "robot@example.invalid",
      defaultSandboxRecipient: "capture@example.invalid", productionEmailHosts: [], env: {},
      now: () => 1_930_000_010_000, emailBrandForOrigin: denied,
      content: { buildAuthEmailContent: denied }, transport: { providerKind: "synthetic", send: denied },
      persistence: { isTemplateEnabled: denied, recordSend: denied },
    }, { renderEmail: denied, readObservedEnvironment: denied, readHiddenPreviewEnabled: denied });
    const signature = createHmac("sha256", "synthetic-reader-secret")
      .update(`reader-event.1930000010.${raw}`).digest("base64");
    const request = () => ({
      method: "POST", body: '{"fallback":true}',
      headers: { "webhook-id": "reader-event", "webhook-timestamp": "1930000010", "webhook-signature": signature },
      async *[Symbol.asyncIterator]() {
        if (raw) {
          const bytes = Buffer.from(raw);
          yield bytes.subarray(0, 17);
          yield bytes.subarray(17);
        }
      },
    } as unknown as HttpRequest);
    const response = { setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn() };
    await handler(request(), response as unknown as HttpResponse);
    expect(response.status.mock.calls).toEqual([[400]]);
    expect(response.json.mock.calls).toEqual([[{ error: { http_code: 400, message: scenario === "drained stream"
      ? "Invalid JSON payload" : "Missing user email or email_data" } }]]);
    expect(denied).not.toHaveBeenCalled();
    if (scenario === "large stream") {
      expect(MAX_WEBHOOK_BODY_BYTES).toBe(1_048_576);
      expect(Buffer.byteLength(raw)).toBeGreaterThan(MAX_WEBHOOK_BODY_BYTES);
      await expect(readRawBody(request())).rejects.toBeInstanceOf(WebhookBodyTooLargeError);
    } else {
      expect(await readRawBody(request())).toBe(scenario === "drained stream" ? '{"fallback":true}' : raw);
    }
  },
);
