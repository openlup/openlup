import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HttpRequest, HttpResponse } from "../../_lib/types/http.js";

const mock = vi.hoisted(() => ({ otp: vi.fn(), limit: vi.fn(), pad: vi.fn() }));
vi.mock("../../_lib/customer-domain/auth.js", () => ({
  createCustomerServiceClient: () => ({}),
  createCustomerClient: () => ({ auth: { signInWithOtp: mock.otp } }),
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
