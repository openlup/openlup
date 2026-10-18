import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import {
  APPLICATION_ENVIRONMENT_KEY,
  HOST_ENVIRONMENT_KEY,
  LEGACY_APPLICATION_ENVIRONMENT_KEY,
} from "../../../_lib/observability/environment.js";

const unitComposition = vi.hoisted(() => ({ enabled: true }));
vi.mock("#deployment-route-policy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#deployment-route-policy")>();
  return {
    ...actual,
    enforceDeploymentRoutePolicy: (...args: Parameters<typeof actual.enforceDeploymentRoutePolicy>) =>
      unitComposition.enabled || actual.enforceDeploymentRoutePolicy(...args),
  };
});

const {
  mockCreateClient,
  mockEq,
  mockFrom,
  mockMaybeSingle,
  mockRpc,
  mockSelect,
  mockSignInWithOtp,
} = vi.hoisted(() => ({
  mockCreateClient: vi.fn(),
  mockEq: vi.fn(),
  mockFrom: vi.fn(),
  mockMaybeSingle: vi.fn(),
  mockRpc: vi.fn(),
  mockSelect: vi.fn(),
  mockSignInWithOtp: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: mockCreateClient,
}));

vi.mock("../../../_lib/timing.js", () => ({
  padResponseTime: vi.fn().mockResolvedValue(undefined),
}));

const ENV_KEYS = [
  "SUPABASE_URL",
  "VITE_SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "VITE_SUPABASE_ANON_KEY",
  "VITE_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "APP_BASE_URL",
  "SITE_URL",
  "VERCEL",
  "VERCEL_URL",
  APPLICATION_ENVIRONMENT_KEY,
  LEGACY_APPLICATION_ENVIRONMENT_KEY,
  HOST_ENVIRONMENT_KEY,
] as const;

type EnvKey = (typeof ENV_KEYS)[number];

describe("POST /api/bff/admin/platform/magic-link", () => {
  const originalEnv = new Map<EnvKey, string | undefined>();

  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    for (const key of ENV_KEYS) {
      originalEnv.set(key, process.env[key]);
      delete process.env[key];
    }

    mockCreateClient.mockReset();
    mockRpc.mockReset();
    mockFrom.mockReset();
    mockSelect.mockReset();
    mockEq.mockReset();
    mockMaybeSingle.mockReset();
    mockSignInWithOtp.mockReset();

    const membershipQuery = { eq: mockEq, maybeSingle: mockMaybeSingle };
    mockSelect.mockReturnValue(membershipQuery);
    mockEq.mockReturnValue(membershipQuery);
    mockFrom.mockReturnValue({ select: mockSelect });
    mockCreateClient.mockReturnValue({
      rpc: mockRpc,
      from: mockFrom,
      auth: { signInWithOtp: mockSignInWithOtp },
    });
    mockRpc.mockResolvedValue({
      data: { allowed: true, attempts_by_ip: 1, attempts_by_email: 1 },
      error: null,
    });
    mockMaybeSingle.mockResolvedValue({ data: { id: "admin-1", role: "admin" }, error: null });
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

  it("rejects malformed email without creating Supabase clients", async () => {
    enableEnv();
    const { default: handler } = await import("./magic-link.js");
    const res = createResponse();

    await handler(request({ email: "not-an-email" }), res);

    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("fails closed when Supabase service-role env is missing", async () => {
    const { default: handler } = await import("./magic-link.js");
    const res = createResponse();

    await handler(request({ email: "admin@example.com" }), res);

    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it.each([
    ["admin", "admin"],
    ["distributor", "distributor"],
  ])("sends an OTP for an allowlisted %s operator", async (_label, role) => {
    enableEnv();
    mockMaybeSingle.mockResolvedValue({ data: { id: "admin-1", role }, error: null });
    const { default: handler } = await import("./magic-link.js");
    const res = createResponse();

    await handler(request({ email: " Admin@Example.com " }), res);

    expect(mockFrom).toHaveBeenCalledWith("admin_users");
    expect(mockSelect).toHaveBeenCalledWith("id, role");
    expect(mockEq).toHaveBeenCalledWith("email", "admin@example.com");
    expect(mockEq).toHaveBeenCalledWith("membership_state", "active");
    expect(mockSignInWithOtp).toHaveBeenCalledWith({
      email: "admin@example.com",
      options: {
        shouldCreateUser: false,
        emailRedirectTo: "https://example.com/admin/auth/callback",
      },
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true, data: { accepted: true } });
  });

  it("stays accepted but does not send OTP for a non-allowlisted email", async () => {
    enableEnv();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
    const { default: handler } = await import("./magic-link.js");
    const res = createResponse();

    await handler(request({ email: "unknown@example.com" }), res);

    expect(mockSignInWithOtp).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true, data: { accepted: true } });
  });

  it("stays accepted but does not send OTP for a revoked membership", async () => {
    enableEnv();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
    const { default: handler } = await import("./magic-link.js");
    const res = createResponse();

    await handler(request({ email: "revoked@example.com" }), res);

    expect(mockEq).toHaveBeenCalledWith("membership_state", "active");
    expect(mockSignInWithOtp).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it.each([null, "unknown-role"])("stays accepted with padding and quota but sends no OTP for role %s", async (role) => {
    enableEnv();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockMaybeSingle.mockResolvedValue({ data: { id: "admin-1", role }, error: null });
    const { default: handler } = await import("./magic-link.js");
    const res = createResponse();

    await handler(request({ email: "support@example.com" }), res);

    expect(mockSignInWithOtp).not.toHaveBeenCalled();
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith("public_record_admin_magic_link_attempt", expect.objectContaining({ p_email_hash: expect.stringMatching(/^[0-9a-f]{64}$/), p_max_per_ip: 5, p_max_per_email: 3, p_window_minutes: 60 }));
    const { padResponseTime } = await import("../../../_lib/timing.js");
    expect(padResponseTime).toHaveBeenCalledWith(expect.any(Number), 400);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true, data: { accepted: true } });
  });

  it("does not send OTP when the hidden rate limit denies", async () => {
    enableEnv();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockRpc.mockResolvedValue({
      data: { allowed: false, reason: "email_quota", attempts_by_ip: 1, attempts_by_email: 3 },
      error: null,
    });
    const { default: handler } = await import("./magic-link.js");
    const res = createResponse();

    await handler(request({ email: "admin@example.com" }), res);

    expect(mockMaybeSingle).not.toHaveBeenCalled();
    expect(mockSignInWithOtp).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true, data: { accepted: true } });
  });

  it("fails closed with 503 when the rate-limit RPC is unavailable", async () => {
    enableEnv();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockRpc.mockRejectedValue(new Error("network down"));
    const { default: handler } = await import("./magic-link.js");
    const res = createResponse();

    await handler(request({ email: "admin@example.com" }), res);

    expect(mockMaybeSingle).not.toHaveBeenCalled();
    expect(mockSignInWithOtp).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it("keeps a generic accepted response when Supabase Auth refuses the OTP", async () => {
    enableEnv();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockSignInWithOtp.mockResolvedValue({ error: { name: "AuthApiError" } });
    const { default: handler } = await import("./magic-link.js");
    const res = createResponse();

    await handler(request({ email: "admin@example.com" }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true, data: { accepted: true } });
    expect(warn.mock.calls.flat().join(" ")).not.toContain("admin@example.com");
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
    process.env.SITE_URL = "https://legacy.example.com";
    const { default: handler } = await import("./magic-link.js");
    const res = createResponse();
    await handler(spoofedRequest(), res);
    expect(mockSignInWithOtp).toHaveBeenCalledWith({
      email: "admin@example.com",
      options: { shouldCreateUser: false, emailRedirectTo: "https://example.com/admin/auth/callback" },
    });
  });

  it("uses the existing compatibility origin only when APP_BASE_URL is blank", async () => {
    enableEnv();
    process.env.APP_BASE_URL = "  ";
    process.env.SITE_URL = "https://legacy.example.com/";
    const { default: handler } = await import("./magic-link.js");
    const res = createResponse();
    await handler(spoofedRequest(), res);
    expect(mockSignInWithOtp).toHaveBeenCalledWith({
      email: "admin@example.com",
      options: { shouldCreateUser: false, emailRedirectTo: "https://legacy.example.com/admin/auth/callback" },
    });
  });

  it.each(["not a url", "https://example.com/path", "https://user:secret@example.com", "https://example.com?query=1"])(
    "refuses invalid primary configuration %s without compatibility or header fallback",
    async (origin) => {
      enableEnv();
      process.env.APP_BASE_URL = origin;
      process.env.SITE_URL = "https://legacy.example.com";
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
    process.env.SITE_URL = "https://example.com/path";
    const { default: handler } = await import("./magic-link.js");
    const res = createResponse();
    await handler(spoofedRequest(), res);
    expectOriginRefusal(res);
    expect(mockCreateClient).not.toHaveBeenCalled();
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
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_ANON_KEY = "anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
  if (options.origin !== false) {
    process.env.APP_BASE_URL = "https://example.com";
  }
}

function requestWithHeaders(headers: Record<string, string>): VercelRequest {
  return {
    method: "POST",
    body: { email: "admin@example.com" },
    query: {},
    headers,
  } as unknown as VercelRequest;
}

function spoofedRequest() {
  return requestWithHeaders({
    "x-forwarded-for": "198.51.100.1",
    "x-forwarded-proto": "https",
    "x-forwarded-host": "spoofed.example.com",
    host: "host.example.com", origin: "https://origin.example.com", referer: "https://referer.example.com/path",
  });
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
