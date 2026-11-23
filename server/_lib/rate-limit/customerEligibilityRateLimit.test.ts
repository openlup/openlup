import { afterEach, describe, expect, it, vi } from "vitest";
import type { HttpRequest } from "../types/http.js";
import { hashRateLimitKey } from "./publicSignupRateLimit.js";
import {
  checkAndRecordEligibilityLookupAttempt,
  createSupabaseCustomerEligibilityRateLimitPort,
} from "./customerEligibilityRateLimit.js";

afterEach(() => vi.unstubAllEnvs());

describe("customer eligibility rate limit", () => {
  it("allows attempts returned by the durable limiter RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { allowed: true, attempts_by_ip: 1, attempts_by_email: 1 },
      error: null,
    });

    const result = await checkAndRecordEligibilityLookupAttempt({
      client: { rpc },
      ip: "203.0.113.1",
      email: "buyer@example.com",
    });

    expect(result).toEqual({
      allowed: true,
      attemptsByIp: 1,
      attemptsByEmail: 1,
      reason: undefined,
    });
    expect(rpc).toHaveBeenCalledWith(
      "public_record_eligibility_lookup_attempt",
      expect.objectContaining({
        p_window_minutes: 60,
        p_max_per_ip: 60,
        p_max_per_email: 20,
      }),
    );
  });

  it("denies once the per-email quota is reached", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { allowed: false, reason: "email_quota", attempts_by_ip: 5, attempts_by_email: 20 },
      error: null,
    });

    await expect(
      checkAndRecordEligibilityLookupAttempt({
        client: { rpc },
        ip: "203.0.113.1",
        email: "buyer@example.com",
      }),
    ).resolves.toMatchObject({ allowed: false, reason: "email_quota" });
  });

  it("fails closed when the durable limiter is unavailable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "missing function" } });

    await expect(
      checkAndRecordEligibilityLookupAttempt({
        client: { rpc },
        ip: "203.0.113.1",
        email: "buyer@example.com",
      }),
    ).resolves.toMatchObject({ allowed: false, reason: "limiter_unavailable" });
    warn.mockRestore();
  });

  it("keys the port on the socket peer and normalized email", async () => {
    vi.stubEnv("CUSTOMER_DIAGNOSTIC_TRUSTED_PROXY_HOPS", undefined);
    const rpc = vi.fn().mockResolvedValue({
      data: { allowed: true, attempts_by_ip: 1, attempts_by_email: 1 },
      error: null,
    });
    const port = createSupabaseCustomerEligibilityRateLimitPort({ rpc });

    await port.check({
      request: {
        headers: { "x-forwarded-for": "198.51.100.7" },
        socket: { remoteAddress: "192.0.2.10" },
      } as HttpRequest,
      email: "Buyer@Example.com",
    });

    expect(rpc).toHaveBeenCalledExactlyOnceWith("public_record_eligibility_lookup_attempt", expect.objectContaining({
      p_ip_hash: hashRateLimitKey("192.0.2.10"),
      p_email_hash: hashRateLimitKey("buyer@example.com"),
    }));
  });
});
