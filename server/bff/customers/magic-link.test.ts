import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  APPLICATION_ENVIRONMENT_KEY,
  HOST_ENVIRONMENT_KEY,
  LEGACY_APPLICATION_ENVIRONMENT_KEY,
} from "../../_lib/observability/environment.js";

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
        emailRedirectTo: "https://openlup.test/konto/auth/callback",
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
        emailRedirectTo: "https://openlup.test/account/auth/callback",
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
    expect(callback.origin).toBe("https://openlup.test");
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
        emailRedirectTo: "https://openlup.test/konto/auth/callback",
      },
    });
  });

  it("skips the send (but stays accepted) when no origin resolves to localhost on a deploy", async () => {
    process.env.COMMERCE_V2_W12_CUSTOMER_AUTH_UI = "true";
    process.env.VITE_SUPABASE_URL = "https://example.supabase.co";
    process.env.VITE_SUPABASE_ANON_KEY = "anon-key";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    // No CUSTOMER_AUTH_REDIRECT_ORIGIN, on a deploy (VERCEL set), and the
    // request carries no forwarded host — origin would be localhost.
    const restoreVercel = process.env.VERCEL;
    process.env.VERCEL = "1";
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { default: handler } = await import("./magic-link.js");
    const res = createResponse();

    // `request` carries no x-forwarded-host, so origin can only be localhost.
    await handler(request({ email: "buyer@example.com" }), res);

    expect(mockSignInWithOtp).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true, data: { accepted: true } });

    if (restoreVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = restoreVercel;
  });

  it("uses the forwarded host as origin when no explicit origin is configured", async () => {
    process.env.COMMERCE_V2_W12_CUSTOMER_AUTH_UI = "true";
    process.env.VITE_SUPABASE_URL = "https://example.supabase.co";
    process.env.VITE_SUPABASE_ANON_KEY = "anon-key";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    const { default: handler } = await import("./magic-link.js");
    const res = createResponse();

    const req = {
      method: "POST",
      body: { email: "buyer@example.com" },
      query: {},
      headers: {
        "x-forwarded-for": "198.51.100.1",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "preview.example.app",
      },
    } as unknown as VercelRequest;

    await handler(req, res);

    expect(mockSignInWithOtp).toHaveBeenCalledWith({
      email: "buyer@example.com",
      options: {
        shouldCreateUser: false,
        emailRedirectTo: "https://preview.example.app/konto/auth/callback",
      },
    });
  });

  it("prefers APP_BASE_URL over the customer compatibility origin and request host", async () => {
    enableEnv();
    process.env[APPLICATION_ENVIRONMENT_KEY] = "production";
    process.env.APP_BASE_URL = "https://openlup.test/path/";
    process.env.CUSTOMER_AUTH_REDIRECT_ORIGIN = "https://legacy.example.test";
    const { default: handler } = await import("./magic-link.js");
    const res = createResponse();

    await handler(spoofedRequest(), res);

    expect(mockSignInWithOtp).toHaveBeenCalledWith({
      email: "buyer@example.com",
      options: {
        shouldCreateUser: false,
        emailRedirectTo: "https://openlup.test/konto/auth/callback",
      },
    });
  });

  it("keeps CUSTOMER_AUTH_REDIRECT_ORIGIN as the fallback only when APP_BASE_URL is absent or blank", async () => {
    enableEnv();
    process.env.APP_BASE_URL = "  ";
    process.env.CUSTOMER_AUTH_REDIRECT_ORIGIN = "https://legacy.example.test/";
    const { default: handler } = await import("./magic-link.js");
    const res = createResponse();

    await handler(spoofedRequest(), res);

    expect(mockSignInWithOtp).toHaveBeenCalledWith({
      email: "buyer@example.com",
      options: {
        shouldCreateUser: false,
        emailRedirectTo: "https://legacy.example.test/konto/auth/callback",
      },
    });
  });

  it("refuses an invalid APP_BASE_URL instead of falling through to a compatibility origin or host", async () => {
    enableEnv();
    process.env.APP_BASE_URL = "not a url";
    process.env.CUSTOMER_AUTH_REDIRECT_ORIGIN = "https://legacy.example.test";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { default: handler } = await import("./magic-link.js");
    const res = createResponse();

    await handler(spoofedRequest(), res);

    expect(mockSignInWithOtp).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true, data: { accepted: true } });
    expect(warn).toHaveBeenCalledWith(
      "customer_magic_link_origin",
      expect.stringContaining("invalid_app_base_url"),
    );
  });

  it("fails closed (no send) in production when no configured origin is set", async () => {
    process.env.COMMERCE_V2_W12_CUSTOMER_AUTH_UI = "true";
    process.env.VITE_SUPABASE_URL = "https://example.supabase.co";
    process.env.VITE_SUPABASE_ANON_KEY = "anon-key";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    const restoreVercelEnv = process.env.VERCEL_ENV;
    process.env.VERCEL_ENV = "production";
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { default: handler } = await import("./magic-link.js");
    const res = createResponse();

    const req = {
      method: "POST",
      body: { email: "buyer@example.com" },
      query: {},
      headers: { "x-forwarded-proto": "https", "x-forwarded-host": "spoofed.example.com" },
    } as unknown as VercelRequest;
    await handler(req, res);

    expect(mockSignInWithOtp).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true, data: { accepted: true } });

    if (restoreVercelEnv === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = restoreVercelEnv;
  });

  // The neutral application marker, not the hosting provider's, now decides the
  // backstop. On a bare-Node host this route is unreachable anyway — the
  // hidden-sandbox preview guard already 503s every customer mutation on a
  // runtime with no staging or production hosting marker — so the neutral
  // marker is proven here on a hosted env whose *host* class is preview, and
  // the environment matrix itself is pinned in
  // server/_lib/observability/environment.test.ts.
  it("refuses the spoofable host when the neutral marker declares production", async () => {
    enableEnv({ origin: false });
    hostedAs("preview");
    process.env[APPLICATION_ENVIRONMENT_KEY] = "production";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { default: handler } = await import("./magic-link.js");
    const res = createResponse();

    await handler(spoofedRequest(), res);

    expect(mockSignInWithOtp).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true, data: { accepted: true } });
    expect(warn).toHaveBeenCalledWith(
      "customer_magic_link_origin",
      expect.stringContaining("missing_configured_origin_production"),
    );
  });

  it("refuses the spoofable host on a hosted production deployment", async () => {
    enableEnv({ origin: false });
    hostedAs("production");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { default: handler } = await import("./magic-link.js");
    const res = createResponse();

    await handler(spoofedRequest(), res);

    expect(mockSignInWithOtp).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true, data: { accepted: true } });
    expect(warn).toHaveBeenCalledWith(
      "customer_magic_link_origin",
      expect.stringContaining("missing_configured_origin_production"),
    );
  });

  it("keeps the header fallback on a hosted preview deployment", async () => {
    enableEnv({ origin: false });
    hostedAs("preview");
    const { default: handler } = await import("./magic-link.js");
    const res = createResponse();

    await handler(spoofedRequest(), res);

    expect(mockSignInWithOtp).toHaveBeenCalledWith({
      email: "buyer@example.com",
      options: {
        shouldCreateUser: false,
        emailRedirectTo: "https://spoofed.example.com/konto/auth/callback",
      },
    });
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
});

function enableEnv(options: { origin?: boolean } = {}) {
  process.env.COMMERCE_V2_W12_CUSTOMER_AUTH_UI = "true";
  process.env.VITE_SUPABASE_URL = "https://example.supabase.co";
  process.env.VITE_SUPABASE_ANON_KEY = "anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
  if (options.origin !== false) {
    process.env.APP_BASE_URL = "https://openlup.test";
  }
}

/** Marks the runtime as a hosted deployment of the given host class. */
function hostedAs(hostClass: string) {
  process.env.VERCEL = "1";
  process.env[HOST_ENVIRONMENT_KEY] = hostClass;
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
