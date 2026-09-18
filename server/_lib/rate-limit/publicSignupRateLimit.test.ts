import { afterEach, describe, expect, it, vi } from "vitest";
import { checkAndRecordSignupAttempt } from "./publicSignupRateLimit.js";

describe("checkAndRecordSignupAttempt", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns allowed=true when the RPC accepts the attempt", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        allowed: true,
        reason: null,
        attempts_by_ip: 1,
        attempts_by_email: 1,
      },
      error: null,
    });

    const result = await checkAndRecordSignupAttempt({
      client: { rpc },
      endpoint: "waitlist",
      ip: "1.2.3.4",
      email: "ala@example.com",
    });

    expect(result).toEqual({
      allowed: true,
      reason: undefined,
      attemptsByIp: 1,
      attemptsByEmail: 1,
    });
    expect(rpc).toHaveBeenCalledWith(
      "public_record_signup_attempt",
      expect.objectContaining({
        p_endpoint: "waitlist",
        p_window_minutes: 60,
        p_max_per_ip: 5,
        p_max_per_email: 3,
      }),
    );
  });

  it("returns allowed=false with ip_quota reason when the RPC blocks on IP", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        allowed: false,
        reason: "ip_quota",
        attempts_by_ip: 5,
        attempts_by_email: 1,
      },
      error: null,
    });

    const result = await checkAndRecordSignupAttempt({
      client: { rpc },
      endpoint: "tester_signup",
      ip: "1.2.3.4",
      email: "ala@example.com",
    });

    expect(result).toEqual({
      allowed: false,
      reason: "ip_quota",
      attemptsByIp: 5,
      attemptsByEmail: 1,
    });
  });

  it("returns allowed=false with email_quota reason when the RPC blocks on email", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        allowed: false,
        reason: "email_quota",
        attempts_by_ip: 1,
        attempts_by_email: 3,
      },
      error: null,
    });

    const result = await checkAndRecordSignupAttempt({
      client: { rpc },
      endpoint: "waitlist",
      ip: "1.2.3.4",
      email: "ala@example.com",
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("email_quota");
  });

  it("accepts an RPC response shaped as a single-row array (Postgres SETOF)", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        {
          allowed: true,
          reason: null,
          attempts_by_ip: 0,
          attempts_by_email: 0,
        },
      ],
      error: null,
    });

    const result = await checkAndRecordSignupAttempt({
      client: { rpc },
      endpoint: "waitlist",
      ip: "1.1.1.1",
      email: "x@y.com",
    });

    expect(result.allowed).toBe(true);
  });

  it("fails closed when the RPC returns an error", async () => {
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { message: "boom" },
    });

    const result = await checkAndRecordSignupAttempt({
      client: { rpc },
      endpoint: "waitlist",
      ip: "1.2.3.4",
      email: "ala@example.com",
    });

    expect(result).toEqual({
      allowed: false,
      reason: "limiter_unavailable",
      attemptsByIp: 0,
      attemptsByEmail: 0,
    });
    expect(consoleSpy).toHaveBeenCalledWith(
      "public_signup_rate_limit_rpc_failed",
      expect.stringContaining("boom"),
    );
  });

  it("fails closed when the RPC returns an empty result set", async () => {
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });

    const result = await checkAndRecordSignupAttempt({
      client: { rpc },
      endpoint: "waitlist",
      ip: "1.2.3.4",
      email: "ala@example.com",
    });

    expect(result).toEqual({
      allowed: false,
      reason: "limiter_unavailable",
      attemptsByIp: 0,
      attemptsByEmail: 0,
    });
    expect(consoleSpy).toHaveBeenCalledWith(
      "public_signup_rate_limit_rpc_empty",
      expect.any(String),
    );
  });

  it("hashes IP and email before forwarding to the RPC (no plaintext leaves the helper)", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        allowed: true,
        reason: null,
        attempts_by_ip: 1,
        attempts_by_email: 1,
      },
      error: null,
    });

    await checkAndRecordSignupAttempt({
      client: { rpc },
      endpoint: "waitlist",
      ip: "9.9.9.9",
      email: "JANE@example.com",
    });

    const args = rpc.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(args.p_ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(args.p_email_hash).toMatch(/^[0-9a-f]{64}$/);
    const serialized = JSON.stringify(args);
    expect(serialized).not.toContain("9.9.9.9");
    expect(serialized).not.toContain("JANE");
    expect(serialized).not.toContain("jane@example.com");
  });

  it("honours overridden window and max parameters", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        allowed: true,
        reason: null,
        attempts_by_ip: 0,
        attempts_by_email: 0,
      },
      error: null,
    });

    await checkAndRecordSignupAttempt({
      client: { rpc },
      endpoint: "waitlist",
      ip: "1.2.3.4",
      email: "ala@example.com",
      windowMinutes: 120,
      maxPerIp: 2,
      maxPerEmail: 1,
    });

    expect(rpc).toHaveBeenCalledWith(
      "public_record_signup_attempt",
      expect.objectContaining({
        p_window_minutes: 120,
        p_max_per_ip: 2,
        p_max_per_email: 1,
      }),
    );
  });

  it("ignores unknown reason strings to keep the API surface tight", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        allowed: false,
        reason: "globally_blocked",
        attempts_by_ip: 99,
        attempts_by_email: 99,
      },
      error: null,
    });

    const result = await checkAndRecordSignupAttempt({
      client: { rpc },
      endpoint: "waitlist",
      ip: "1.2.3.4",
      email: "ala@example.com",
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toBeUndefined();
  });
});
