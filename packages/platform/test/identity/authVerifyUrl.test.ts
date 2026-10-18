import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { HttpRequest, HttpResponse } from "../../src/http/index.js";
import { createCustomerMagicLinkHandler, type CustomerMagicLinkHandlerOptions } from "../../src/identity/customerMagicLinkHandler.js";
import { createAdminMagicLinkHandler, type AdminMagicLinkHandlerOptions } from "../../src/identity/adminMagicLinkHandler.js";
import * as redirect from "../../src/identity/authVerifyUrl.js";

import { buildAuthVerifyUrl } from "../../src/identity/authVerifyUrl.js";

const SERVICE = "https://project.supabase.co";
const REDIRECT = "https://app.example/konto/auth/callback";

describe("buildAuthVerifyUrl", () => {
  it("percent-encodes the first byte of the token so a template cannot split on it", () => {
    const url = buildAuthVerifyUrl(SERVICE, "recovery", "pkce_abc", REDIRECT);

    expect(url.startsWith(`${SERVICE}/auth/v1/verify?token=%70kce_abc&`)).toBe(true);
    expect(url).not.toContain("token=pkce_abc");
  });

  it("escapes the rest of the token and the redirect exactly once", () => {
    const url = buildAuthVerifyUrl(SERVICE, "magiclink", "a b+c", "https://app.example/a?b=c&d=e");

    expect(url).toContain("token=%61%20b%2Bc");
    expect(url).toContain("redirect_to=https%3A%2F%2Fapp.example%2Fa%3Fb%3Dc%26d%3De");
    expect(url).not.toContain("redirect_to=https://");
  });

  it("collapses both email-change action types onto the endpoint's single type", () => {
    for (const actionType of ["email_change_current", "email_change_new"]) {
      expect(buildAuthVerifyUrl(SERVICE, actionType, "t", REDIRECT)).toContain("type=email_change&");
    }
    expect(buildAuthVerifyUrl(SERVICE, "recovery", "t", REDIRECT)).toContain("type=recovery&");
  });

  it("does not double a trailing slash on the auth service origin", () => {
    expect(buildAuthVerifyUrl(`${SERVICE}///`, "signup", "t", REDIRECT).startsWith(`${SERVICE}/auth/v1/verify?`)).toBe(true);
  });

  it("returns an empty token rather than inventing an escape for one", () => {
    expect(buildAuthVerifyUrl(SERVICE, "invite", "", REDIRECT)).toContain("token=&");
  });
});

const PRIMARY = "https://example.com:8443";
const SECONDARY = "https://secondary.example.com";
const HEADERS = {
  host: "host.invalid",
  "x-forwarded-host": "forwarded.invalid",
  "x-forwarded-proto": "http",
  origin: "https://origin.invalid",
  referer: "https://referer.invalid/path",
};
const UNSAFE_PATHS = [
  "https://evil.example.com/path", "//evil.example.com", "\\\\evil.example.com", "/\\evil.example.com",
  "/%2f%2fevil.example.com", "/%2Fevil.example.com", "/%5cevil.example.com",
  "/%252f%252fevil.example.com", "/safe/..//evil.example.com", "/\nevil.example.com",
  "/%0devil.example.com", "relative/path", " https://evil.example.com",
];
const INVALID_ORIGINS = [
  "", "not a url", "//example.com", "javascript:alert(1)", "ftp://example.com",
  "https://example.com/path", "https://example.com?query=1", "https://example.com#fragment",
  "https://user:secret@example.com", "https://example.com\\path", "https:///example.com",
  "https://example.com:invalid", "https://exa mple.com",
];

afterEach(() => vi.restoreAllMocks());

describe("strict magic-link redirect resolver", () => {
  it("uses the primary exact scheme, host and port regardless of headers", () => {
    const resolve = redirect.createMagicLinkOriginResolver([PRIMARY, SECONDARY]);
    expect(resolve(request())).toBe(PRIMARY);
    expect(resolve(request({}, {}))).toBe(PRIMARY);
    expect(redirect.createMagicLinkOriginResolver(["http://example.com:8080/"])(request())).toBe("http://example.com:8080");
  });

  it.each(INVALID_ORIGINS)("refuses invalid origin %j even after a valid primary", (origin) => {
    expect(redirect.createMagicLinkOriginResolver([origin])(request())).toBeNull();
    expect(redirect.createMagicLinkOriginResolver([PRIMARY, origin])(request())).toBeNull();
  });

  it("refuses an empty allowlist despite forwarded and host headers", () => {
    expect(redirect.createMagicLinkOriginResolver([])(request())).toBeNull();
  });
});

describe.each(["customer", "admin"] as const)("%s factory strict redirect conformance", (kind) => {
  it("uses the shared resolver by default", async () => {
    const resolve = vi.spyOn(redirect, "createMagicLinkOriginResolver").mockReturnValue(() => PRIMARY);
    const fixture = createFixture(kind, []);
    const res = response();
    await fixture.handler(request(), res);
    expect(resolve).toHaveBeenCalledExactlyOnceWith([]);
    expect(fixture.send).toHaveBeenCalledWith(expect.objectContaining({
      options: { shouldCreateUser: false, emailRedirectTo: `${PRIMARY}/auth/callback` },
    }));
  });

  it("ignores forwarded-host, Host, Origin and Referer when sending", async () => {
    const fixture = createFixture(kind, [PRIMARY, SECONDARY]);
    const res = response();
    await fixture.handler(request(), res);
    expect(fixture.send).toHaveBeenCalledWith({
      email: "reader@example.com",
      options: { shouldCreateUser: false, emailRedirectTo: `${PRIMARY}/auth/callback` },
    });
    expect(fixture.checkAttempt).toHaveBeenCalledOnce();
    expect(fixture.pad).toHaveBeenCalledWith(expect.any(Number), 400);
    expect(res.json).toHaveBeenCalledWith({ ok: true, data: { accepted: true } });
  });

  it.each([undefined, [], ["https://example.com/path"], [PRIMARY, "invalid"]])(
    "refuses missing or invalid configuration %j before any provider call",
    async (origins) => {
      const fixture = createFixture(kind, origins);
      const res = response();
      await fixture.handler(request(), res);
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith({
        ok: false,
        error: {
          code: "UPSTREAM_UNAVAILABLE", message: "Magic link origin is not configured",
          details: { reason: "magic_link_origin_not_configured" },
        },
      });
      for (const effect of [fixture.provider, fixture.checkAttempt, fixture.send]) expect(effect).not.toHaveBeenCalled();
      expect(fixture.pad).toHaveBeenCalledWith(expect.any(Number), 400);
    },
  );

  it("retains an adopter's explicitly injected resolver", async () => {
    const resolveOrigin = vi.fn(() => SECONDARY);
    const fixture = createFixture(kind, [], resolveOrigin);
    const req = request();
    await fixture.handler(req, response());
    expect(resolveOrigin).toHaveBeenCalledExactlyOnceWith(req);
    expect(fixture.send).toHaveBeenCalledWith(expect.objectContaining({
      options: { shouldCreateUser: false, emailRedirectTo: `${SECONDARY}/auth/callback` },
    }));
  });

  it("keeps quota denial non-enumerating with the existing padding", async () => {
    const fixture = createFixture(kind, [PRIMARY]);
    fixture.checkAttempt.mockResolvedValue({ allowed: false, reason: "email_quota" });
    const res = response();
    await fixture.handler(request(), res);
    expect(fixture.send).not.toHaveBeenCalled();
    expect(fixture.pad).toHaveBeenCalledWith(expect.any(Number), 400);
    expect(res.json).toHaveBeenCalledWith({ ok: true, data: { accepted: true } });
  });
});

describe("customer return paths", () => {
  it.each(UNSAFE_PATHS)("omits unsafe return path %j from the delivered callback", async (returnTo) => {
    const fixture = createFixture("customer", [PRIMARY]);
    await fixture.handler(request({ returnTo }), response());
    expect(fixture.send).toHaveBeenCalledWith({
      email: "reader@example.com",
      options: { shouldCreateUser: false, emailRedirectTo: `${PRIMARY}/auth/callback` },
    });
  });

  it("preserves a same-origin relative path, query and fragment", async () => {
    const fixture = createFixture("customer", [PRIMARY]);
    await fixture.handler(request({ returnTo: "/account/./orders?q=one%20two#payment" }), response());
    const url = new URL(fixture.send.mock.calls[0]![0].options.emailRedirectTo);
    expect(url.origin).toBe(PRIMARY);
    expect(url.searchParams.get("returnTo")).toBe("/account/orders?q=one%20two#payment");
  });

  it("keeps a configured direct session challenge accepted and padded", async () => {
    const fixture = createFixture("customer", [PRIMARY]);
    const requestChallenge = vi.fn(async () => {});
    const resolveSession = vi.fn(() => ({ binding: { requestChallenge, verifyChallenge: vi.fn() } }));
    const handler = createCustomerMagicLinkHandler({
      ...fixture.customerOptions, env: { PLATFORM_BUNDLE: "node-postgres" }, resolveSession,
    });
    const res = response();
    await handler(request(), res);
    expect(requestChallenge).toHaveBeenCalledExactlyOnceWith("reader@example.com");
    expect(fixture.pad).toHaveBeenCalledWith(expect.any(Number), 400);
    expect(res.json).toHaveBeenCalledWith({ ok: true, data: { accepted: true } });
  });

  it("checks configuration before the direct session provider too", async () => {
    const fixture = createFixture("customer", []);
    const resolveSession = vi.fn();
    const handler = createCustomerMagicLinkHandler({
      ...fixture.customerOptions, env: { PLATFORM_BUNDLE: "node-postgres" }, resolveSession,
    });
    const res = response();
    await handler(request(), res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(resolveSession).not.toHaveBeenCalled();
  });
});

function createFixture(kind: "customer" | "admin", redirectOrigins?: readonly string[], resolveOrigin?: (req: HttpRequest) => string | null) {
  const send = vi.fn(async (_input: { email: string; options: { shouldCreateUser: false; emailRedirectTo: string } }) => ({ error: null }));
  const authClient = { auth: { signInWithOtp: send } };
  const rateLimitClient = { rpc: vi.fn() };
  const provider = vi.fn(() => ({
    authClient, rateLimitClient,
    platformPort: { checkAdminMagicLinkEligibility: vi.fn(async () => "eligible") },
  }));
  const checkAttempt = vi.fn(async (): Promise<{ allowed: boolean; reason?: string }> => ({ allowed: true }));
  const pad = vi.fn(async () => {});
  const common = {
    redirectOrigins, resolveOrigin,
    responseSchema: z.object({ accepted: z.literal(true) }),
    readEnvironment: () => ({ url: "https://auth.example.com", anonKey: "synthetic", serviceRoleKey: "synthetic" }),
    checkAttempt, extractClientIp: () => "192.0.2.1", padResponseTime: pad,
  };
  const customerOptions: CustomerMagicLinkHandlerOptions = {
    ...common, enabled: () => true, env: {},
    requestSchema: z.object({ email: z.string(), locale: z.enum(["pl", "en"]).default("en"), returnTo: z.string().optional() }),
    createCustomerClient: () => { provider(); return authClient; },
    createCustomerServiceClient: () => { provider(); return rateLimitClient; },
    callbackPath: () => "/auth/callback", resolveSession: vi.fn(),
  };
  const adminOptions: AdminMagicLinkHandlerOptions = {
    ...common, requestSchema: z.object({ email: z.string() }), createRuntime: provider, callbackPath: "/auth/callback",
  };
  return {
    handler: kind === "customer" ? createCustomerMagicLinkHandler(customerOptions) : createAdminMagicLinkHandler(adminOptions),
    customerOptions, provider, send, checkAttempt, pad,
  };
}

function request(body: Record<string, unknown> = {}, headers: HttpRequest["headers"] = HEADERS): HttpRequest {
  return { method: "POST", headers, query: {}, body: { email: "reader@example.com", ...body } } as unknown as HttpRequest;
}

function response(): HttpResponse {
  const res = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res as unknown as HttpResponse;
}
