import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HttpRequest, HttpResponse } from "../../_lib/types/http.js";

const mock = vi.hoisted(() => ({ otp: vi.fn(), limit: vi.fn(), pad: vi.fn(), getUser: vi.fn(), findByEmail: vi.fn(), createAccount: vi.fn(), assess: vi.fn() }));
vi.mock("../auth/emailTrustBinding.js", () => ({ bindIdentityEmailTrust: () => ({ assess: mock.assess }) }));
vi.mock("../../_lib/customer-domain/auth.js", () => ({
  createCustomerServiceClient: () => ({}),
  createCustomerClient: () => ({ auth: { signInWithOtp: mock.otp, getUser: mock.getUser } }),
}));
vi.mock("@openlup/platform/identity", async importOriginal => ({
  ...await importOriginal<typeof import("@openlup/platform/identity")>(),
  createSupabaseAccountLinkStore: () => ({ isReservedPrincipal: async () => false, findAccountByPrincipalId: async () => null,
    findAccountByEmail: mock.findByEmail, createAccount: mock.createAccount }),
}));
vi.mock("../../_lib/rate-limit/customerMagicLinkRateLimit.js", () => ({
  checkAndRecordCustomerMagicLinkAttempt: mock.limit,
  extractClientIp: () => "127.0.0.1",
}));
vi.mock("../../_lib/timing.js", () => ({ padResponseTime: mock.pad }));

import { createReferenceAccountHandlers } from "./subscriptionAccount.js";
const env = { url: "http://127.0.0.1:54321", anonKey: "anon", serviceRoleKey: "service" };
const origin = "http://127.0.0.1:54330";
const request = { headers: {}, body: { email: "buyer@example.test" } } as HttpRequest;
const response = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn(), setHeader: vi.fn() }) as unknown as HttpResponse;

beforeEach(() => {
  vi.clearAllMocks();
  mock.limit.mockResolvedValue({ allowed: true });
  mock.otp.mockResolvedValue({ error: null });
});

describe("captured sign-in error boundary", () => {
  it.each(["returned", "thrown"])("pads and hides an Auth %s failure instead of claiming acceptance", async (kind) => {
    const privateFailure = new Error("provider-private-detail");
    if (kind === "returned") mock.otp.mockResolvedValue({ error: privateFailure });
    else mock.otp.mockRejectedValue(privateFailure);
    const res = response();
    await createReferenceAccountHandlers(env, origin).requestSignIn(request, res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(mock.pad).toHaveBeenCalledWith(expect.any(Number), 400);
    expect(JSON.stringify(vi.mocked(res.json).mock.calls)).not.toContain("provider-private-detail");
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
  });

  it("keeps quota refusal non-enumerating without sending another message", async () => {
    mock.limit.mockResolvedValue({ allowed: false, reason: "email_quota" });
    const res = response();
    await createReferenceAccountHandlers(env, origin).requestSignIn(request, res);
    expect(mock.otp).not.toHaveBeenCalled();
    expect(mock.pad).toHaveBeenCalledWith(expect.any(Number), 400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true, data: { accepted: true } }));
  });

  it("sends only the server-selected callback and no caller metadata", async () => {
    await createReferenceAccountHandlers(env, origin).requestSignIn(request, response());
    expect(mock.otp).toHaveBeenCalledWith({ email: "buyer@example.test", options: {
      shouldCreateUser: true, emailRedirectTo: `${origin}/account/auth/callback`,
    } });
  });
});

it("accepts compatible locale and account-root fields without changing captured account creation", async () => {
  const res = response();
  await createReferenceAccountHandlers(env, origin).requestSignIn({ ...request, body: { email: " Customer@Example.com ", locale: "pl", returnTo: "/konto" } } as HttpRequest, res);
  expect(mock.otp).toHaveBeenCalledWith({ email: "customer@example.com", options: { shouldCreateUser: true, emailRedirectTo: `${origin}/konto/auth/callback` } });
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true, data: { accepted: true } }));
});
it.each(["https://external.invalid", "/account/auth/callback", "/account/orders"])("refuses an unmounted callback target %s", async (returnTo) => {
  const res = response();
  await createReferenceAccountHandlers(env, origin).requestSignIn({ ...request, body: { email: "customer@example.com", locale: "en", returnTo } } as HttpRequest, res);
  expect(res.status).toHaveBeenCalledWith(400);
  expect(mock.otp).not.toHaveBeenCalled();
});

describe("reference email trust composition", () => {
  it.each(["EMAIL_TRUST_ENVELOPE_REFUSED", "EMAIL_TRUST_SETTINGS_UNAVAILABLE"] as const)("passes required policy and preserves the reference refusal for %s", async code => {
    mock.getUser.mockResolvedValue({ data: { user: { id: "b1000000-0000-4000-8000-000000000003", email: "reference@example.com", email_confirmed_at: "2026-01-01" } }, error: null });
    mock.assess.mockResolvedValue({ trusted: false, code });
    const res = response();
    await createReferenceAccountHandlers(env, origin).reconcile({ method: "POST", headers: { authorization: "Bearer synthetic" } } as HttpRequest, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mock.assess).toHaveBeenCalledOnce();
    expect(mock.findByEmail).not.toHaveBeenCalled();
    expect(mock.createAccount).not.toHaveBeenCalled();
  });
});
