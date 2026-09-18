import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import {
  APPLICATION_ENVIRONMENT_KEY,
  HOST_ENVIRONMENT_KEY,
  LEGACY_APPLICATION_ENVIRONMENT_KEY,
} from "../../../_lib/observability/environment.js";

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
    ["legacy null", null],
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
        emailRedirectTo: "https://openlup.test/admin/auth/callback",
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

  it("stays accepted but does not send OTP for a non-eligible admin role", async () => {
    enableEnv();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockMaybeSingle.mockResolvedValue({ data: { id: "admin-1", role: "support" }, error: null });
    const { default: handler } = await import("./magic-link.js");
    const res = createResponse();

    await handler(request({ email: "support@example.com" }), res);

    expect(mockSignInWithOtp).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
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

  it("uses the forwarded host when no explicit app origin is configured", async () => {
    enableEnv({ origin: false });
    const { default: handler } = await import("./magic-link.js");
    const res = createResponse();

    await handler({
      method: "POST",
      body: { email: "admin@example.com" },
      query: {},
      headers: {
        "x-forwarded-for": "198.51.100.1",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "preview.example.app",
      },
    } as unknown as VercelRequest, res);

    expect(mockSignInWithOtp).toHaveBeenCalledWith({
      email: "admin@example.com",
      options: {
        shouldCreateUser: false,
        emailRedirectTo: "https://preview.example.app/admin/auth/callback",
      },
    });
  });

  it("prefers APP_BASE_URL over SITE_URL and the request host", async () => {
    enableEnv();
    process.env[APPLICATION_ENVIRONMENT_KEY] = "production";
    process.env.APP_BASE_URL = "https://openlup.test/path/";
    process.env.SITE_URL = "https://legacy.example.test";
    const { default: handler } = await import("./magic-link.js");
    const res = createResponse();

    await handler(spoofedRequest(), res);

    expect(mockSignInWithOtp).toHaveBeenCalledWith({
      email: "admin@example.com",
      options: {
        shouldCreateUser: false,
        emailRedirectTo: "https://openlup.test/admin/auth/callback",
      },
    });
  });

  it("keeps SITE_URL as the fallback when APP_BASE_URL is blank", async () => {
    enableEnv({ origin: false });
    process.env.APP_BASE_URL = "  ";
    process.env.SITE_URL = "https://legacy.example.test/path";
    const { default: handler } = await import("./magic-link.js");
    const res = createResponse();

    await handler(spoofedRequest(), res);

    expect(mockSignInWithOtp).toHaveBeenCalledWith({
      email: "admin@example.com",
      options: {
        shouldCreateUser: false,
        emailRedirectTo: "https://legacy.example.test/admin/auth/callback",
      },
    });
  });

  it("refuses an invalid APP_BASE_URL instead of falling through to SITE_URL or the request host", async () => {
    enableEnv();
    process.env.APP_BASE_URL = "not a url";
    process.env.SITE_URL = "https://legacy.example.test";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { default: handler } = await import("./magic-link.js");
    const res = createResponse();

    await handler(spoofedRequest(), res);

    expect(mockSignInWithOtp).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true, data: { accepted: true } });
    expect(warn).toHaveBeenCalledWith(
      "admin_magic_link_origin",
      expect.stringContaining("invalid_app_base_url"),
    );
  });

  // This route is not behind the hidden-sandbox preview guard, so it is the one
  // magic-link surface a bare-Node deployment can actually reach — and the one
  // where the old hosting-marker gate silently dropped both the refusal and its
  // warning. The environment classification itself is pinned exhaustively in
  // server/_lib/observability/environment.test.ts.
  it.each([
    ["an unlabelled runtime", {}, "missing_explicit_origin_unknown_env"],
    ["a neutral production marker", { [APPLICATION_ENVIRONMENT_KEY]: "production" }, "missing_configured_origin_production"],
    ["an unrecognized environment value", { [APPLICATION_ENVIRONMENT_KEY]: "produkcja" }, "missing_explicit_origin_unknown_env"],
  ])("refuses the spoofable forwarded host on a bare-Node host with %s", async (_label, env, outcome) => {
    enableEnv({ origin: false });
    Object.assign(process.env, env);

    await withoutNodeEnv(async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { default: handler } = await import("./magic-link.js");
      const res = createResponse();

      await handler(spoofedRequest(), res);

      expect(mockSignInWithOtp).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ ok: true, data: { accepted: true } });
      expect(warn).toHaveBeenCalledWith(
        "admin_magic_link_origin",
        expect.stringContaining(outcome),
      );
    });
  });

  it("refuses a loopback origin on a bare-Node host when nothing declares a local runtime", async () => {
    enableEnv({ origin: false });

    await withoutNodeEnv(async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const { default: handler } = await import("./magic-link.js");
      const res = createResponse();

      await handler(requestWithHeaders({ "x-forwarded-for": "198.51.100.1", host: "localhost:3000" }), res);

      expect(mockSignInWithOtp).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
    });
  });

  // A bare hosting flag with no environment class: not production, not
  // unlabelled (the test rig marker is present), but still a deployment — so a
  // loopback origin must not be mailed. This is the branch of
  // deployedRuntimeAssumed that no environment class can reach.
  it("treats a bare hosting flag as a deployment and refuses a loopback origin", async () => {
    enableEnv({ origin: false });
    process.env.VERCEL = "1";
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { default: handler } = await import("./magic-link.js");
    const res = createResponse();

    await handler(requestWithHeaders({ "x-forwarded-for": "198.51.100.1", host: "127.0.0.1:3000" }), res);

    expect(mockSignInWithOtp).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("keeps the localhost origin on an explicit local rig", async () => {
    enableEnv({ origin: false });
    process.env.LOCAL_BFF = "1";

    await withoutNodeEnv(async () => {
      const { default: handler } = await import("./magic-link.js");
      const res = createResponse();

      await handler(requestWithHeaders({
        "x-forwarded-for": "198.51.100.1",
        "x-forwarded-proto": "http",
        host: "localhost:3000",
      }), res);

      expect(mockSignInWithOtp).toHaveBeenCalledWith({
        email: "admin@example.com",
        options: {
          shouldCreateUser: false,
          emailRedirectTo: "http://localhost:3000/admin/auth/callback",
        },
      });
    });

    delete process.env.LOCAL_BFF;
  });

  it.each(["preview", "development"])("keeps the forwarded-host fallback on a hosted %s deployment", async (hostClass) => {
    enableEnv({ origin: false });
    hostedAs(hostClass);
    const { default: handler } = await import("./magic-link.js");
    const res = createResponse();

    await handler(spoofedRequest(), res);

    expect(mockSignInWithOtp).toHaveBeenCalledWith({
      email: "admin@example.com",
      options: {
        shouldCreateUser: false,
        emailRedirectTo: "https://spoofed.example/admin/auth/callback",
      },
    });
  });

  it("keeps the forwarded-host fallback on a declared staging deployment", async () => {
    enableEnv({ origin: false });
    hostedAs("preview");
    process.env[APPLICATION_ENVIRONMENT_KEY] = "staging";
    const { default: handler } = await import("./magic-link.js");
    const res = createResponse();

    await handler(spoofedRequest(), res);

    expect(mockSignInWithOtp).toHaveBeenCalledWith({
      email: "admin@example.com",
      options: {
        shouldCreateUser: false,
        emailRedirectTo: "https://spoofed.example/admin/auth/callback",
      },
    });
  });

  it("refuses the spoofable host on a hosted production deployment", async () => {
    enableEnv({ origin: false });
    process.env.VERCEL_ENV = "production";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { default: handler } = await import("./magic-link.js");
    const res = createResponse();

    await handler({
      method: "POST",
      body: { email: "admin@example.com" },
      query: {},
      headers: {
        "x-forwarded-for": "198.51.100.1",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "spoofed.example",
      },
    } as unknown as VercelRequest, res);

    expect(mockSignInWithOtp).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true, data: { accepted: true } });
    expect(warn).toHaveBeenCalledWith(
      "admin_magic_link_origin",
      expect.stringContaining("missing_configured_origin_production"),
    );
  });
});

function enableEnv(options: { origin?: boolean } = {}) {
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_ANON_KEY = "anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
  if (options.origin !== false) {
    process.env.APP_BASE_URL = "https://openlup.test";
  }
}

/**
 * Vitest always runs with `NODE_ENV=test`, one of the two explicit local markers
 * the origin seam honours. A bare-Node deployment carries neither, so the
 * fail-closed cases drop it for the duration of the assertion.
 */
async function withoutNodeEnv(run: () => Promise<void>): Promise<void> {
  const original = process.env.NODE_ENV;
  delete process.env.NODE_ENV;
  try {
    await run();
  } finally {
    if (original === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = original;
  }
}

/** Marks the runtime as a hosted deployment of the given host class. */
function hostedAs(hostClass: string) {
  process.env.VERCEL = "1";
  process.env[HOST_ENVIRONMENT_KEY] = hostClass;
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
    "x-forwarded-host": "spoofed.example",
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
