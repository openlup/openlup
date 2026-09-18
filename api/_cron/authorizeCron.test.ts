import { describe, expect, it } from "vitest";
import type { VercelRequest } from "../../server/_lib/types/vercel.js";
import { authorizeCron, bearerToken } from "./authorizeCron.js";

function req(method: string, authorization?: string): VercelRequest {
  return { method, headers: authorization ? { authorization } : {} } as unknown as VercelRequest;
}

describe("authorizeCron", () => {
  it("returns null (authorized) for GET/POST with a matching bearer token", () => {
    const env = { CRON_SECRET: "s3cret" };
    expect(authorizeCron(req("GET", "Bearer s3cret"), env)).toBeNull();
    expect(authorizeCron(req("POST", "Bearer s3cret"), env)).toBeNull();
  });

  it("405s a disallowed method before any secret check", () => {
    expect(authorizeCron(req("DELETE", "Bearer s3cret"), { CRON_SECRET: "s3cret" })).toEqual({
      status: 405,
      body: { ok: false, error: "method_not_allowed" },
    });
  });

  it("503s when CRON_SECRET is not configured", () => {
    expect(authorizeCron(req("POST", "Bearer x"), {})).toEqual({
      status: 503,
      body: { ok: false, error: "cron_secret_required" },
    });
  });

  it("401s on a missing or mismatched bearer token", () => {
    const env = { CRON_SECRET: "s3cret" };
    expect(authorizeCron(req("POST"), env)).toEqual({
      status: 401,
      body: { ok: false, error: "unauthorized" },
    });
    expect(authorizeCron(req("POST", "Bearer nope"), env)).toEqual({
      status: 401,
      body: { ok: false, error: "unauthorized" },
    });
  });
});

describe("bearerToken", () => {
  it("extracts the token from a Bearer header (case-insensitive, trimmed)", () => {
    expect(bearerToken(req("POST", "Bearer abc"))).toBe("abc");
    expect(bearerToken(req("POST", "bearer  spaced  "))).toBe("spaced");
  });

  it("returns null when no usable Authorization header is present", () => {
    expect(bearerToken(req("POST"))).toBeNull();
    expect(bearerToken(req("POST", "Basic abc"))).toBeNull();
  });
});
