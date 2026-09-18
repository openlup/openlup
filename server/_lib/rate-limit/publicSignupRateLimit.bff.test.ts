import { describe, expect, it, vi } from "vitest";
import { maybeCheckPublicSignupRateLimit } from "./publicSignupRateLimit.js";

describe("maybeCheckPublicSignupRateLimit", () => {
  it("returns null for non-POST requests (no rate-limit consumption)", async () => {
    const rpc = vi.fn();
    const result = await maybeCheckPublicSignupRateLimit({
      client: { rpc },
      endpoint: "waitlist",
      req: { method: "GET", body: { email: "ala@example.com" }, headers: {} },
    });
    expect(result).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("returns null when the body has no email field", async () => {
    const rpc = vi.fn();
    const result = await maybeCheckPublicSignupRateLimit({
      client: { rpc },
      endpoint: "waitlist",
      req: { method: "POST", body: { firstName: "Ala" }, headers: {} },
    });
    expect(result).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("returns null when the email field is an empty string", async () => {
    const rpc = vi.fn();
    const result = await maybeCheckPublicSignupRateLimit({
      client: { rpc },
      endpoint: "waitlist",
      req: { method: "POST", body: { email: "   " }, headers: {} },
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
      req: {
        method: "POST",
        body: { email: "ala@example.com" },
        headers: { "x-forwarded-for": "1.2.3.4" },
      },
    });

    expect(result?.allowed).toBe(true);
    expect(rpc).toHaveBeenCalledWith(
      "public_record_signup_attempt",
      expect.objectContaining({ p_endpoint: "tester_signup" }),
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
      req: {
        method: "POST",
        body: { email: "ala@example.com" },
        headers: {},
      },
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
