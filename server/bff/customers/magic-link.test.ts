import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  APPLICATION_ENVIRONMENT_KEY,
  HOST_ENVIRONMENT_KEY,
  LEGACY_APPLICATION_ENVIRONMENT_KEY,
} from "../../_lib/observability/environment.js";

const unitComposition = vi.hoisted(() => ({ enabled: true }));
vi.mock("#deployment-route-policy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#deployment-route-policy")>();
  return {
    ...actual,
    enforceDeploymentRoutePolicy: (...args: Parameters<typeof actual.enforceDeploymentRoutePolicy>) =>
      unitComposition.enabled || actual.enforceDeploymentRoutePolicy(...args),
  };
});

const { mockCreateClient, mockRpc, mockSignInWithOtp } = vi.hoisted(() => ({
  mockCreateClient: vi.fn(),
  mockRpc: vi.fn(),
  mockSignInWithOtp: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: mockCreateClient,
}));

// Stub the latency floor so the anti-enumeration timing pad never adds real
// wall-clock delay in tests. We assert response shapes here, not timing.
vi.mock("../../_lib/timing.js", () => ({
  padResponseTime: vi.fn().mockResolvedValue(undefined),
}));

const ENV_KEYS = [
  "COMMERCE_V2_W12_CUSTOMER_AUTH_UI",
  "VITE_SUPABASE_URL",
  "SUPABASE_URL",
  "VITE_SUPABASE_ANON_KEY",
  "VITE_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "APP_BASE_URL",
  "CUSTOMER_AUTH_REDIRECT_ORIGIN",
  "VERCEL",
  "VERCEL_URL",
  APPLICATION_ENVIRONMENT_KEY,
  LEGACY_APPLICATION_ENVIRONMENT_KEY,
  HOST_ENVIRONMENT_KEY,
] as const;

type EnvKey = (typeof ENV_KEYS)[number];

describe("POST /api/bff/customers/magic-link", () => {
  const originalEnv = new Map<EnvKey, string | undefined>();

  beforeEach(() => {
    vi.resetModules();
    mockCreateClient.mockReset();
    mockRpc.mockReset();
    mockSignInWithOtp.mockReset();
    for (const key of ENV_KEYS) {
      originalEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    mockCreateClient.mockImplementation((_url: string, key: string) => (
      key === "service-role-key"
        ? { rpc: mockRpc }
        : { auth: { signInWithOtp: mockSignInWithOtp } }
    ));
    mockRpc.mockResolvedValue({
      data: { allowed: true, attempts_by_ip: 1, attempts_by_email: 1 },
      error: null,
    });
    mockSignInWithOtp.mockResolvedValue({ error: null });
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = originalEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    originalEnv.clear();
  });

  it("fails closed before creating a client when the feature flag is off", async () => {
    const { default: handler } = await import("./magic-link.js");
    const res = createResponse();

    await handler(request({ email: "buyer@example.com" }), res);

    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it("rejects malformed email without creating a client", async () => {
    enableEnv();
    const { default: handler } = await import("./magic-link.js");
    const res = createResponse();

    await handler(request({ email: "not-an-email" }), res);

    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("uses a service client only for the limiter and an anonymous client only for OTP", async () => {
    enableEnv();
    const { default: handler } = await import("./magic-link.js");
    const res = createResponse();

    await handler(request({ email: "buyer@example.com" }), res);

    expect(mockCreateClient).toHaveBeenNthCalledWith(1, "https://example.supabase.co", "anon-key", {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: {} },
    });
    expect(mockCreateClient).toHaveBeenNthCalledWith(2, "https://example.supabase.co", "service-role-key", {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    expect(mockRpc).toHaveBeenNthCalledWith(1, "public_record_customer_magic_link_attempt", {
      p_ip_hash: "7f60d869b36f6e64c0c99395754c14658bc62173eadceb489ea008ddfe76398d",
      p_email_hash: "6a6c26195c3682faa816966af789717c3bfa834eee6c599d667d2b3429c27cfd",
      p_window_minutes: 60,
      p_max_per_ip: 5,
      p_max_per_email: 3,
    });
    expect(mockRpc).toHaveBeenNthCalledWith(2, "public_count_customer_magic_link_attempts_global", {
      p_window_minutes: 60,
    });
    expect(mockSignInWithOtp).toHaveBeenCalledOnce();
  });

  it("fails closed before creating either client when service-role configuration is missing", async () => {
    enableEnv();
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const { default: handler } = await import("./magic-link.js");
    const res = createResponse();

    await handler(request({ email: "buyer@example.com" }), res);

    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockSignInWithOtp).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: "UPSTREAM_UNAVAILABLE" }),
      }),
    );
  });

  it("sends a generic accepted response for valid email even when Supabase Auth errors", async () => {
    enableEnv();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    mockSignInWithOtp.mockResolvedValue({ error: { name: "AuthApiError" } });
    const { default: handler } = await import("./magic-link.js");
    const res = createResponse();

    await handler(request({ email: " Buyer@Example.com " }), res);

    expect(mockSignInWithOtp).toHaveBeenCalledWith({
      email: "buyer@example.com",
      options: {
        shouldCreateUser: false,
        emailRedirectTo: "https://example.com/konto/auth/callback",
      },
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true, data: { accepted: true } });
    expect(info).toHaveBeenCalledWith(
      "customer_magic_link_outcome",
      JSON.stringify({ outcome: "auth_error", code: "AuthApiError", locale: "pl" }),
    );
    expect(info.mock.calls.flat().join(" ")).not.toContain("buyer@example.com");
  });

  it("uses the allowlisted English customer callback when locale is en", async () => {
    enableEnv();
    const { default: handler } = await import("./magic-link.js");
    const res = createResponse();

    await handler(request({ email: "buyer@example.com", locale: "en" }), res);

    expect(mockSignInWithOtp).toHaveBeenCalledWith({
      email: "buyer@example.com",
      options: {
        shouldCreateUser: false,
        emailRedirectTo: "https://example.com/account/auth/callback",
      },
    });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("carries a validated account return target through the callback URL", async () => {
    enableEnv();
    const { default: handler } = await import("./magic-link.js");
    const res = createResponse();

    await handler(request({
      email: "buyer@example.com",
      returnTo: "/konto/zamowienie/status?orderId=abc#payment",
    }), res);

    const call = mockSignInWithOtp.mock.calls[0]?.[0];
    const callback = new URL(call.options.emailRedirectTo);
    expect(callback.origin).toBe("https://example.com");
    expect(callback.pathname).toBe("/konto/auth/callback");
    expect(callback.searchParams.get("returnTo")).toBe(
      "/konto/zamowienie/status?orderId=abc#payment",
    );
  });

  it("rejects an external or account-prefix lookalike return target before auth work", async () => {
    enableEnv();
    const { default: handler } = await import("./magic-link.js");

    for (const returnTo of ["https://evil.test/konto", "/accountant"]) {
      const res = createResponse();
      await handler(request({ email: "buyer@example.com", returnTo }), res);
      expect(res.status).toHaveBeenCalledWith(400);
    }

    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockSignInWithOtp).not.toHaveBeenCalled();
  });

  it("falls back to the Polish customer callback when locale is omitted", async () => {
    enableEnv();
    const { default: handler } = await import("./magic-link.js");
    const res = createResponse();

    await handler(request({ email: "buyer@example.com" }), res);

    expect(mockSignInWithOtp).toHaveBeenCalledWith({
      email: "buyer@example.com",
      options: {
        shouldCreateUser: false,
        emailRedirectTo: "https://example.com/konto/auth/callback",
      },
    });
  });

  it.each(["development", "preview", "staging", "production"])(
    "refuses missing origin configuration before provider work in %s",
    async (environment) => {
      enableEnv({ origin: false });
      process.env[APPLICATION_ENVIRONMENT_KEY] = environment;
      const { default: handler } = await import("./magic-link.js");
      const res = createResponse();
      await handler(spoofedRequest(), res);
      expectOriginRefusal(res);
      expect(mockCreateClient).not.toHaveBeenCalled();
      expect(mockRpc).not.toHaveBeenCalled();
      expect(mockSignInWithOtp).not.toHaveBeenCalled();
    },
  );

  it("prefers the configured primary origin over the compatibility origin and every host header", async () => {
    enableEnv();
    process.env.CUSTOMER_AUTH_REDIRECT_ORIGIN = "https://legacy.example.com";
    const { default: handler } = await import("./magic-link.js");
    const res = createResponse();
    await handler(spoofedRequest(), res);
    expect(mockSignInWithOtp).toHaveBeenCalledWith({
      email: "buyer@example.com",
      options: { shouldCreateUser: false, emailRedirectTo: "https://example.com/konto/auth/callback" },
    });
  });

  it("uses the existing compatibility origin only when APP_BASE_URL is blank", async () => {
    enableEnv();
    process.env.APP_BASE_URL = "  ";
    process.env.CUSTOMER_AUTH_REDIRECT_ORIGIN = "https://legacy.example.com/";
    const { default: handler } = await import("./magic-link.js");
    const res = createResponse();
    await handler(spoofedRequest(), res);
    expect(mockSignInWithOtp).toHaveBeenCalledWith({
      email: "buyer@example.com",
      options: { shouldCreateUser: false, emailRedirectTo: "https://legacy.example.com/konto/auth/callback" },
    });
  });

  it.each(["not a url", "https://example.com/path", "https://user:secret@example.com", "https://example.com?query=1"])(
    "refuses invalid primary configuration %s without compatibility or header fallback",
    async (origin) => {
      enableEnv();
      process.env.APP_BASE_URL = origin;
      process.env.CUSTOMER_AUTH_REDIRECT_ORIGIN = "https://legacy.example.com";
      const { default: handler } = await import("./magic-link.js");
      const res = createResponse();
      await handler(spoofedRequest(), res);
      expectOriginRefusal(res);
      expect(mockCreateClient).not.toHaveBeenCalled();
      expect(mockSignInWithOtp).not.toHaveBeenCalled();
    },
  );

  it("refuses an invalid compatibility origin", async () => {
    enableEnv({ origin: false });
    process.env.CUSTOMER_AUTH_REDIRECT_ORIGIN = "https://example.com/path";
    const { default: handler } = await import("./magic-link.js");
    const res = createResponse();
    await handler(spoofedRequest(), res);
    expectOriginRefusal(res);
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("does not send Supabase OTP when the hidden rate limit denies", async () => {
    enableEnv();
    mockRpc.mockResolvedValue({
      data: { allowed: false, reason: "email_quota", attempts_by_ip: 1, attempts_by_email: 3 },
      error: null,
    });
    const { default: handler } = await import("./magic-link.js");
    const res = createResponse();

    await handler(request({ email: "buyer@example.com" }), res);

    expect(mockSignInWithOtp).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true, data: { accepted: true } });
  });

  it("does not send Supabase OTP when the global tenant cap denies, but stays accepted", async () => {
    enableEnv();
    mockRpc
      .mockResolvedValueOnce({
        data: { allowed: true, attempts_by_ip: 1, attempts_by_email: 1 },
        error: null,
      })
      .mockResolvedValueOnce({ data: 501, error: null });
    const { default: handler } = await import("./magic-link.js");
    const res = createResponse();

    await handler(request({ email: "buyer@example.com" }), res);

    expect(mockSignInWithOtp).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true, data: { accepted: true } });
  });

  it("fails closed with a 503 when the rate-limit RPC is unavailable", async () => {
    enableEnv();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockRpc.mockRejectedValue(new Error("network down"));
    const { default: handler } = await import("./magic-link.js");
    const res = createResponse();

    await handler(request({ email: "buyer@example.com" }), res);

    expect(mockSignInWithOtp).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: "UPSTREAM_UNAVAILABLE" }),
      }),
    );
  });
  it("public default refuses before constructing clients, consuming limits or sending OTP", async () => {
    unitComposition.enabled = false;
    enableEnv();
    try {
      const { default: handler } = await import("./magic-link.js");
      const res = createResponse();
      await handler(request({ email: "synthetic@example.test" }), res);
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ details: expect.objectContaining({ reason: "adopter_policy_required" }) }) }));
      for (const effect of [mockCreateClient, mockRpc, mockSignInWithOtp]) expect(effect).not.toHaveBeenCalled();
    } finally {
      unitComposition.enabled = true;
    }
  });

});

function enableEnv(options: { origin?: boolean } = {}) {
  process.env.COMMERCE_V2_W12_CUSTOMER_AUTH_UI = "true";
  process.env.VITE_SUPABASE_URL = "https://example.supabase.co";
  process.env.VITE_SUPABASE_ANON_KEY = "anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
  if (options.origin !== false) {
    process.env.APP_BASE_URL = "https://example.com";
  }
}


function spoofedRequest() {
  return {
    method: "POST",
    body: { email: "buyer@example.com" },
    query: {},
    headers: {
      "x-forwarded-for": "198.51.100.1",
      "x-forwarded-proto": "https",
      "x-forwarded-host": "spoofed.example.com",
      host: "host.example.com", origin: "https://origin.example.com", referer: "https://referer.example.com/path",
    },
  } as unknown as VercelRequest;
}

function request(body: unknown): VercelRequest {
  return {
    method: "POST",
    body,
    query: {},
    headers: { "x-forwarded-for": "198.51.100.1" },
  } as unknown as VercelRequest;
}


function createResponse(): VercelResponse {
  const res = {
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as VercelResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}

function expectOriginRefusal(res: VercelResponse) {
  expect(res.status).toHaveBeenCalledWith(503);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
    ok: false,
    error: expect.objectContaining({
      code: "UPSTREAM_UNAVAILABLE",
      details: { reason: "magic_link_origin_not_configured" },
    }),
  }));
}
