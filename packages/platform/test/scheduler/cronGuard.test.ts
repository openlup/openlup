import { describe, expect, it } from "vitest";
import type { HttpRequest } from "../../src/http/types.js";
import { authorizeCron, bearerToken } from "../../src/scheduler/cronGuard.js";

function req(method: string, authorization?: string): HttpRequest {
  return { method, headers: authorization ? { authorization } : {} } as unknown as HttpRequest;
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

describe("cron credential comparison", () => {
  const denied = { status: 401, body: { ok: false, error: "unauthorized" } };
  const headerRequest = (authorization: string | string[]): HttpRequest =>
    ({ method: "POST", headers: { authorization } }) as HttpRequest;

  it.each(["guard-keY", "guard-ke", "guard-keys"])("refuses the mismatched token %s", (token) => {
    expect(authorizeCron(headerRequest(`Bearer ${token}`), { CRON_SECRET: "guard-key" })).toEqual(denied);
  });

  it.each([
    ["guard-ke\u00e9", "guard-key"],
    ["\u00e9", "x"],
  ])("returns 401 without throwing for a non-ASCII mismatch", (token, secret) => {
    expect(authorizeCron(headerRequest(`Bearer ${token}`), { CRON_SECRET: secret })).toEqual(denied);
  });

  it("checks only the first array header", () => {
    const env = { CRON_SECRET: "guard-key" };
    expect(authorizeCron(headerRequest(["Bearer guard-key", "Bearer other-key"]), env)).toBeNull();
    expect(authorizeCron(headerRequest(["Bearer other-key", "Bearer guard-key"]), env)).toEqual(denied);
    expect(bearerToken(headerRequest(["Bearer guard-key", "Bearer other-key"]))).toBe("guard-key");
  });

  it("accepts lower-case bearer and token whitespace but refuses another scheme", () => {
    const env = { CRON_SECRET: "guard-key" };
    expect(authorizeCron(headerRequest("bearer guard-key"), env)).toBeNull();
    expect(authorizeCron(headerRequest("Bearer   guard-key  "), env)).toBeNull();
    expect(authorizeCron(headerRequest("Basic guard-key"), env)).toEqual(denied);
  });

  it("compares the configured secret as-is and refuses an empty secret", () => {
    expect(authorizeCron(headerRequest("Bearer guard-key"), { CRON_SECRET: "guard-key " })).toEqual(denied);
    expect(authorizeCron(headerRequest("Bearer guard-key"), { CRON_SECRET: "" })).toEqual({
      status: 503, body: { ok: false, error: "cron_secret_required" },
    });
  });
});
