import { createHmac } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createAuthSendEmailHookCandidate } from "../../src/communications/authSendEmailHook.js";
import { createAuthEmailTransport, createGuardedEmailTransport } from "../../src/communications/emailEgress.js";
import { createInMemoryEmailTransport } from "../../src/communications/emailTransport.js";
import type { HttpRequest, HttpResponse } from "../../src/http/types.js";

afterEach(() => vi.restoreAllMocks());
it.each(["raw", "blocked", "capture", "disabled"])("signed Auth hook keeps render/control/send/persistence order: %s", async (scenario) => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const effects: string[] = [];
  const capture = createInMemoryEmailTransport();
  const send = vi.fn(async () => { effects.push("network"); throw new Error("must not send"); });
  const transport = scenario === "raw" ? { providerKind: "in-memory", send } : scenario === "blocked"
    ? createAuthEmailTransport(createGuardedEmailTransport({ providerKind: "synthetic", policy: () => {
      effects.push("policy"); return { mode: "blocked", reason: "test_block" };
    }, send })) : createAuthEmailTransport(capture);
  const recordSend = vi.fn(async () => { effects.push("persist"); });
  const handler = createAuthSendEmailHookCandidate({
    transport, hookSecret: "synthetic-auth-secret", authServiceUrl: "https://identity.example.invalid",
    defaultOrigin: "https://portal.example.invalid", fromEmail: "sender@example.invalid",
    defaultSandboxRecipient: "capture@example.invalid", productionEmailHosts: [], env: {},
    now: () => 1_930_000_010_000, emailBrandForOrigin: () => ({} as never),
    content: { buildAuthEmailContent: () => { effects.push("content"); return { locale: "en", subject: "Auth notice", preheader: "Notice", blocks: [] }; } },
    persistence: { isTemplateEnabled: async () => { effects.push("control"); return scenario !== "disabled"; }, recordSend },
  }, { renderEmail: () => { effects.push("render"); return { subject: "Auth notice", html: "<p>Notice</p>", text: "Notice" }; },
    readObservedEnvironment: () => "production", readHiddenPreviewEnabled: () => false });
  const raw = JSON.stringify({ user: { email: "reader@example.invalid" }, email_data: { email_action_type: "magiclink", token_hash: "synthetic-hash", redirect_to: "https://portal.example.invalid/account" } });
  const signature = createHmac("sha256", "synthetic-auth-secret").update(`auth-event.1930000010.${raw}`).digest("base64");
  const request = { method: "POST", headers: { "webhook-id": "auth-event", "webhook-timestamp": "1930000010", "webhook-signature": signature },
    async *[Symbol.asyncIterator]() { yield Buffer.from(raw); } } as unknown as HttpRequest;
  const response = { setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn() };
  await handler(request, response as unknown as HttpResponse);
  expect(effects).toEqual(["content", "render", "control", ...(scenario === "blocked" ? ["policy"] : []), "persist"]);
  expect(send).not.toHaveBeenCalled();
  expect(capture.sent).toHaveLength(scenario === "capture" ? 1 : 0);
  expect(recordSend).toHaveBeenCalledWith(expect.objectContaining({ outcome: expect.objectContaining({
    ok: scenario === "capture" || scenario === "disabled",
    messageId: scenario === "capture" ? "in-memory-1" : null,
    skipReason: scenario === "disabled" ? "admin_disabled" : null,
  }) }));
});
