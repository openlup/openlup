import { afterEach, describe, expect, it, vi } from "vitest";
import { sanitizeObservedReason, sanitizeObservedSupportCode, withObservedRoute } from "./route.js";
import type { VercelRequest, VercelResponse } from "../types/vercel.js";
import { APPLICATION_ENVIRONMENT_KEY } from "./environment.js";

describe("withObservedRoute", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs successful route metadata with status, method, duration, request id, and auth kind", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const originalopenlupEnvironment = process.env.openlup_ENVIRONMENT;
    const originalVercelEnvironment = process.env.VERCEL_ENV;
    const originalHostedRuntime = process.env.VERCEL;
    process.env.openlup_ENVIRONMENT = "staging";
    process.env.VERCEL_ENV = "preview";
    process.env.VERCEL = "1";
    const res = createResponse();
    const handler = withObservedRoute(
      { route: "/api/bff/catalog/products", domain: "catalog", surface: "public", risk: "read" },
      (_req, res) => {
        res.status(200).json({ ok: true, data: { count: 1 } });
      },
    );

    try {
      await handler(
        request({
          method: "GET",
          headers: {
            "x-vercel-id": "iad1::abc",
            authorization: "Bearer secret",
            "x-openlup-environment": "production",
          },
        }),
        res,
      );

      const log = parseLog(consoleLog);
      expect(log).toMatchObject({
        level: "info",
        event: "bff_route",
        request_id: "iad1::abc",
        environment: "staging",
        route: "/api/bff/catalog/products",
        method: "GET",
        status: 200,
        domain: "catalog",
        surface: "public",
        risk: "read",
        auth_kind: "bearer",
        outcome: "success",
      });
      expect(log.duration_ms).toEqual(expect.any(Number));
    } finally {
      restoreEnv("openlup_ENVIRONMENT", originalopenlupEnvironment);
      restoreEnv("VERCEL_ENV", originalVercelEnvironment);
      restoreEnv("VERCEL", originalHostedRuntime);
    }
  });

  it("logs the neutral application class on a Node route", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const originalApplicationEnvironment = process.env[APPLICATION_ENVIRONMENT_KEY];
    process.env[APPLICATION_ENVIRONMENT_KEY] = "staging";
    const handler = withObservedRoute(
      { route: "/api/bff/health", domain: "health", surface: "health", risk: "health" },
      (_req, res) => { res.status(200).json({ ok: true }); },
    );

    try {
      await handler(request({ method: "GET" }), createResponse());
      expect(parseLog(consoleLog)).toMatchObject({
        event: "bff_route",
        environment: "staging",
        route: "/api/bff/health",
        status: 200,
      });
    } finally {
      restoreEnv(APPLICATION_ENVIRONMENT_KEY, originalApplicationEnvironment);
    }
  });

  it("prefers caller request ids over Vercel response ids for deterministic correlation", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const handler = withObservedRoute(
      { route: "/api/bff/health", domain: "health", surface: "health", risk: "health" },
      (_req, res) => {
        res.status(200).json({ ok: true });
      },
    );

    await handler(
      request({
        method: "GET",
        headers: {
          "x-request-id": "bff-axiom-canary-req",
          "x-vercel-id": "arn1::iad1::edge-req",
        },
      }),
      createResponse(),
    );

    expect(parseLog(consoleLog)).toMatchObject({
      request_id: "bff-axiom-canary-req",
    });
  });

  it("drops caller PII and an untrusted Vercel carrier on a Node route", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const handler = withObservedRoute(
      { route: "/api/bff/health", domain: "health", surface: "health", risk: "health" },
      (_req, res) => { res.status(200).json({ ok: true }); },
    );

    await handler(request({ headers: {
      "x-request-id": "buyer@example.com token=secret",
      "x-vercel-id": "iad1::safe-platform-id",
    } }), createResponse());

    const rawLog = String(consoleLog.mock.calls[0]?.[0]);
    expect(JSON.parse(rawLog).request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(rawLog).not.toContain("buyer@example.com");
    expect(rawLog).not.toContain("token=secret");
  });

  it("generates a fresh id when neither request header is safe", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const handler = withObservedRoute(
      { route: "/api/bff/health", domain: "health", surface: "health", risk: "health" },
      (_req, res) => { res.status(200).json({ ok: true }); },
    );

    await handler(request({ headers: {
      "x-request-id": "x".repeat(200),
      "x-vercel-id": "bearer.secret.payload",
    } }), createResponse());

    const rawLog = String(consoleLog.mock.calls[0]?.[0]);
    expect(JSON.parse(rawLog).request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(rawLog).not.toContain("bearer.secret.payload");
  });

  it("extracts only safe BFF error metadata from json envelopes", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const originalEnv = process.env.COMMERCE_TEST_FLAG;
    process.env.COMMERCE_TEST_FLAG = "true";
    const res = createResponse();
    const handler = withObservedRoute(
      {
        route: "/api/bff/commerce/test",
        domain: "commerce",
        surface: "public",
        risk: "read",
        featureFlags: ["COMMERCE_TEST_FLAG"],
      },
      (_req, res) => {
        res.status(503).json({
          ok: false,
          error: {
            code: "UPSTREAM_UNAVAILABLE",
            message: "Disabled",
            details: {
              featureFlag: "COMMERCE_DISABLED_FLAG",
              requiredFlags: ["COMMERCE_DEPENDENCY_FLAG"],
              reason: "feature_flag_disabled",
              supportCode: "SUP-123",
              email: "customer@example.com",
              token: "secret-token",
              query: "hash=abc123",
            },
          },
        });
      },
    );

    try {
      await handler(request({ body: { email: "body@example.com" }, query: { token: "url-secret" } }), res);

      const rawLog = String(consoleLog.mock.calls[0]?.[0]);
      const log = JSON.parse(rawLog);
      expect(log).toMatchObject({
        outcome: "error",
        status: 503,
        error_code: "UPSTREAM_UNAVAILABLE",
        reason: "feature_flag_disabled",
        support_code: "SUP-123",
        feature_flag_state: {
          COMMERCE_DEPENDENCY_FLAG: "disabled",
          COMMERCE_DISABLED_FLAG: "disabled",
          COMMERCE_TEST_FLAG: "enabled",
        },
      });
      expect(rawLog).not.toContain("customer@example.com");
      expect(rawLog).not.toContain("body@example.com");
      expect(rawLog).not.toContain("secret-token");
      expect(rawLog).not.toContain("url-secret");
      expect(rawLog).not.toContain("hash=abc123");
    } finally {
      if (originalEnv === undefined) {
        delete process.env.COMMERCE_TEST_FLAG;
      } else {
        process.env.COMMERCE_TEST_FLAG = originalEnv;
      }
    }
  });

  it("logs and rethrows uncaught route errors", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = withObservedRoute(
      { route: "/api/bff/admin/example", domain: "platform", surface: "admin", risk: "read" },
      () => {
        throw new Error("database password leaked");
      },
    );

    await expect(handler(request({ headers: { "x-request-id": "req-1" } }), createResponse()))
      .rejects.toThrow("database password leaked");

    const rawLog = String(consoleError.mock.calls[0]?.[0]);
    const log = JSON.parse(rawLog);
    expect(log).toMatchObject({
      level: "error",
      status: 500,
      outcome: "exception",
    });
    expect(log.request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(rawLog).not.toContain("req-1");
    expect(rawLog).not.toContain("database password leaked");
  });

  it("redacts unsafe reason and support code details before logging", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const handler = withObservedRoute(
      { route: "/api/bff/customers/example", domain: "customers", surface: "customer", risk: "read" },
      (_req, res) => {
        res.status(400).json({
          ok: false,
          error: {
            code: "BAD_REQUEST",
            details: {
              reason: "customer jane@example.com token=secret called +48123456789",
              supportCode: "SUP jane@example.com token=secret",
            },
          },
        });
      },
    );

    await handler(request(), createResponse());

    const rawLog = String(consoleLog.mock.calls[0]?.[0]);
    const log = JSON.parse(rawLog);
    expect(log).toMatchObject({
      reason: "redacted_unsafe_reason",
      support_code: "redacted_unsafe_support_code",
    });
    expect(rawLog).not.toContain("jane@example.com");
    expect(rawLog).not.toContain("token=secret");
    expect(rawLog).not.toContain("+48123456789");
  });

  // `reason` is the same string for both caller-side pricing-policy refusals, so
  // without `policy_reason` on the line no alert can tell "this buyer's browser
  // sent no assignment key" from "this caller declared no capability".
  it("publishes a pricing-policy reason as its own closed-set field", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const handler = withObservedRoute(
      { route: "/api/bff/commerce/quote", domain: "commerce", surface: "hidden", risk: "read" },
      (_req, res) => {
        res.status(400).json({
          ok: false,
          error: {
            code: "BAD_REQUEST",
            details: {
              reason: "pricing_policy_request_invalid",
              stage: "pricing_policy",
              policyReason: "v2_visitor_id_required",
            },
          },
        });
      },
    );

    await handler(request(), createResponse());

    expect(JSON.parse(String(consoleLog.mock.calls[0]?.[0]))).toMatchObject({
      status: 400,
      reason: "pricing_policy_request_invalid",
      policy_reason: "v2_visitor_id_required",
    });
  });

  it("redacts a pricing-policy reason that is not slug-shaped", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const handler = withObservedRoute(
      { route: "/api/bff/commerce/quote", domain: "commerce", surface: "hidden", risk: "read" },
      (_req, res) => {
        res.status(400).json({
          ok: false,
          error: {
            code: "BAD_REQUEST",
            details: { policyReason: "visitor jane@example.com missing" },
          },
        });
      },
    );

    await handler(request(), createResponse());

    const rawLog = String(consoleLog.mock.calls[0]?.[0]);
    expect(JSON.parse(rawLog)).toMatchObject({ policy_reason: "redacted_unsafe_reason" });
    expect(rawLog).not.toContain("jane@example.com");
  });

  it("keeps only slug-like reasons and support-safe codes", () => {
    expect(sanitizeObservedReason("feature_flag_disabled")).toBe("feature_flag_disabled");
    expect(sanitizeObservedReason("provider buyer@example.com failed")).toBe("redacted_unsafe_reason");
    expect(sanitizeObservedSupportCode("SUP-123")).toBe("SUP-123");
    expect(sanitizeObservedSupportCode("SUP-123 buyer@example.com")).toBe("redacted_unsafe_support_code");
  });

  it("observes send, redirect, and handlers that never set status", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const sent = withObservedRoute(
      { route: "/api/bff/send", domain: "test", surface: "public", risk: "read" },
      (_req, res) => {
        res.status(400).send({ ok: false, error: { code: "BAD_REQUEST" } });
      },
    );
    const redirected = withObservedRoute(
      { route: "/api/bff/redirect", domain: "test", surface: "public", risk: "read" },
      (_req, res) => {
        res.redirect(302, "/target");
      },
    );
    const untouched = withObservedRoute(
      { route: "/api/bff/noop", domain: "test", surface: "public", risk: "read" },
      () => undefined,
    );

    await sent(request(), createResponse());
    await redirected(request(), createResponse());
    await untouched(request(), createResponse());

    expect(JSON.parse(String(consoleLog.mock.calls[0]?.[0]))).toMatchObject({
      status: 400,
      error_code: "BAD_REQUEST",
      outcome: "error",
    });
    expect(JSON.parse(String(consoleLog.mock.calls[1]?.[0]))).toMatchObject({
      status: 302,
      outcome: "success",
    });
    expect(JSON.parse(String(consoleLog.mock.calls[2]?.[0]))).toMatchObject({
      status: 200,
      outcome: "success",
    });
  });

  it("does not alter binary, empty, or redirect response shapes", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const binary = createResponse();
    const empty = createResponse();
    const redirect = createResponse();
    const bytes = Buffer.from([1, 2, 3]);

    await withObservedRoute(
      { route: "/api/bff/binary", domain: "test", surface: "public", risk: "read" },
      (_req, res) => { res.status(200).send(bytes); },
    )(request(), binary);
    await withObservedRoute(
      { route: "/api/bff/empty", domain: "test", surface: "public", risk: "read" },
      (_req, res) => { res.status(204).end(); },
    )(request(), empty);
    await withObservedRoute(
      { route: "/api/bff/redirect", domain: "test", surface: "public", risk: "read" },
      (_req, res) => { res.redirect(302, "/target"); },
    )(request(), redirect);

    expect(binary.send).toHaveBeenCalledWith(bytes);
    expect(empty.statusCode).toBe(204);
    expect(redirect.redirect).toHaveBeenCalledWith(302, "/target");
    for (const res of [binary, empty, redirect]) {
      expect(res.setHeader).not.toHaveBeenCalledWith("x-request-id", expect.anything());
    }
  });
});

function request(overrides: Partial<VercelRequest> = {}): VercelRequest {
  return {
    method: "GET",
    headers: {},
    query: {},
    ...overrides,
  } as VercelRequest;
}

function createResponse(): VercelResponse {
  const res = {
    statusCode: 200,
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
    send: vi.fn(),
    redirect: vi.fn(),
    end: vi.fn(),
  } as unknown as VercelResponse;

  vi.mocked(res.status).mockImplementation((code: number) => {
    res.statusCode = code;
    return res;
  });
  vi.mocked(res.json).mockReturnValue(res);
  vi.mocked(res.send).mockReturnValue(res);
  vi.mocked(res.redirect).mockReturnValue(res);
  vi.mocked(res.end).mockReturnValue(res);
  return res;
}

function parseLog(consoleLog: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  return JSON.parse(String(consoleLog.mock.calls[0]?.[0])) as Record<string, unknown>;
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
