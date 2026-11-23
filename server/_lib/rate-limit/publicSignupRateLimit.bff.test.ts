import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HttpRequest } from "../types/http.js";
import { hashRateLimitKey, maybeCheckPublicSignupRateLimit } from "./publicSignupRateLimit.js";

function request(method: string, body: unknown): HttpRequest {
  return {
    method, body, headers: { "x-forwarded-for": "203.0.113.8" },
    socket: { remoteAddress: "192.0.2.10" },
  } as unknown as HttpRequest;
}

describe("maybeCheckPublicSignupRateLimit", () => {
  beforeEach(() => vi.stubEnv("CUSTOMER_DIAGNOSTIC_TRUSTED_PROXY_HOPS", undefined));
  afterEach(() => vi.unstubAllEnvs());

  it("returns null for non-POST requests (no rate-limit consumption)", async () => {
    const rpc = vi.fn();
    const result = await maybeCheckPublicSignupRateLimit({
      client: { rpc },
      endpoint: "waitlist",
      req: request("GET", { email: "ala@example.com" }),
    });
    expect(result).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("returns null when the body has no email field", async () => {
    const rpc = vi.fn();
    const result = await maybeCheckPublicSignupRateLimit({
      client: { rpc },
      endpoint: "waitlist",
      req: request("POST", { firstName: "Ala" }),
    });
    expect(result).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("returns null when the email field is an empty string", async () => {
    const rpc = vi.fn();
    const result = await maybeCheckPublicSignupRateLimit({
      client: { rpc },
      endpoint: "waitlist",
      req: request("POST", { email: "   " }),
    });
    expect(result).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("delegates to the RPC for valid POST + email + IP", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        allowed: true,
        reason: null,
        attempts_by_ip: 1,
        attempts_by_email: 1,
      },
      error: null,
    });

    const result = await maybeCheckPublicSignupRateLimit({
      client: { rpc },
      endpoint: "tester_signup",
      req: request("POST", { email: "ala@example.com" }),
    });

    expect(result?.allowed).toBe(true);
    expect(rpc).toHaveBeenCalledWith(
      "public_record_signup_attempt",
      expect.objectContaining({ p_endpoint: "tester_signup", p_ip_hash: hashRateLimitKey("192.0.2.10") }),
    );
  });

  it("forwards override knobs to the underlying check", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        allowed: true,
        reason: null,
        attempts_by_ip: 0,
        attempts_by_email: 0,
      },
      error: null,
    });

    await maybeCheckPublicSignupRateLimit({
      client: { rpc },
      endpoint: "waitlist",
      req: request("POST", { email: "ala@example.com" }),
      windowMinutes: 5,
      maxPerIp: 1,
      maxPerEmail: 1,
    });

    expect(rpc).toHaveBeenCalledWith(
      "public_record_signup_attempt",
      expect.objectContaining({
        p_window_minutes: 5,
        p_max_per_ip: 1,
        p_max_per_email: 1,
      }),
    );
  });
});
