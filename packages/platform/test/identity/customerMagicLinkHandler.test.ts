import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createCustomerMagicLinkHandler } from "../../src/identity/customerMagicLinkHandler.js";
import type { HttpRequest, HttpResponse } from "../../src/http/index.js";

describe("existing-user customer magic links", () => {
  it.each(["sent", "unknown", "threw"] as const)("magic_link_is_existing_user_only with a non-enumerating %s response", async (outcome) => {
    const send = vi.fn(async () => {
      if (outcome === "threw") throw new Error("synthetic_transport_failure");
      return { error: outcome === "unknown" ? { name: "synthetic_unknown_identity" } : null };
    });
    const pad = vi.fn(async () => {});
    const handler = createCustomerMagicLinkHandler({
      enabled: () => true, env: { PLATFORM_BUNDLE: "node-supabase" },
      requestSchema: z.object({ email: z.string().trim().toLowerCase(), locale: z.literal("en") }),
      responseSchema: z.object({ accepted: z.literal(true) }),
      readEnvironment: () => ({ url: "https://auth.example.com", anonKey: "synthetic", serviceRoleKey: "synthetic" }),
      createCustomerClient: () => ({ auth: { signInWithOtp: send } }), createCustomerServiceClient: () => ({}),
      checkAttempt: async () => ({ allowed: true }), extractClientIp: () => "192.0.2.1", padResponseTime: pad,
      redirectOrigins: ["https://example.com"], callbackPath: () => "/account/auth/callback", resolveSession: vi.fn(),
    });
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), setHeader: vi.fn() };
    await handler({ method: "POST", headers: {}, body: { email: " READER@Example.COM ", locale: "en" } } as HttpRequest, res as unknown as HttpResponse);
    expect(send).toHaveBeenCalledExactlyOnceWith({ email: "reader@example.com", options: {
      shouldCreateUser: false, emailRedirectTo: "https://example.com/account/auth/callback",
    } });
    expect(res.status).toHaveBeenCalledExactlyOnceWith(200);
    expect(res.json).toHaveBeenCalledExactlyOnceWith({ ok: true, data: { accepted: true } });
    expect(pad).toHaveBeenCalledWith(expect.any(Number), 400);
  });
});
