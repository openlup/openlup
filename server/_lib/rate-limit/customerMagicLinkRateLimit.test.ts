import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkAndRecordCustomerMagicLinkAttempt,
  extractClientIp,
} from "./customerMagicLinkRateLimit.js";

describe("checkAndRecordCustomerMagicLinkAttempt", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns allowed=true when the RPC accepts the attempt", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { allowed: true, reason: null, attempts_by_ip: 1, attempts_by_email: 1 },
      error: null,
    });

    const result = await checkAndRecordCustomerMagicLinkAttempt({
      client: { rpc },
      ip: "1.2.3.4",
      email: "buyer@example.com",
    });

    expect(result).toEqual({
      allowed: true,
      reason: undefined,
      attemptsByIp: 1,
      attemptsByEmail: 1,
    });
    expect(rpc).toHaveBeenCalledWith(
      "public_record_customer_magic_link_attempt",
      expect.objectContaining({
        p_window_minutes: 60,
        p_max_per_ip: 5,
        p_max_per_email: 3,
      }),
    );
  });

  it("denies when the fail-open global cap is exceeded after the existing limiter allows", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({
        data: { allowed: true, reason: null, attempts_by_ip: 1, attempts_by_email: 1 },
        error: null,
      })
      .mockResolvedValueOnce({ data: 501, error: null });

    const result = await checkAndRecordCustomerMagicLinkAttempt({
      client: { rpc },
      ip: "1.2.3.4",
      email: "buyer@example.com",
      maxGlobal: 500,
    });

    expect(result).toEqual({
      allowed: false,
      reason: "global_quota",
      attemptsByIp: 1,
      attemptsByEmail: 1,
      attemptsGlobal: 501,
    });
    expect(rpc).toHaveBeenLastCalledWith("public_count_customer_magic_link_attempts_global", {
      p_window_minutes: 60,
    });
  });

  it("fails open to the existing limiter when the global cap read is unavailable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const rpc = vi.fn()
      .mockResolvedValueOnce({
        data: { allowed: true, reason: null, attempts_by_ip: 1, attempts_by_email: 1 },
        error: null,
      })
      .mockRejectedValueOnce(new Error("global read down"));

    const result = await checkAndRecordCustomerMagicLinkAttempt({
      client: { rpc },
      ip: "1.2.3.4",
      email: "buyer@example.com",
      maxGlobal: 500,
    });

    expect(result).toEqual({
      allowed: true,
      reason: undefined,
      attemptsByIp: 1,
      attemptsByEmail: 1,
    });
  });

  it("preserves the ip_quota reason on a genuine quota denial", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { allowed: false, reason: "ip_quota", attempts_by_ip: 5, attempts_by_email: 1 },
      error: null,
    });

    const result = await checkAndRecordCustomerMagicLinkAttempt({
      client: { rpc },
      ip: "1.2.3.4",
      email: "buyer@example.com",
    });

    expect(result).toEqual({
      allowed: false,
      reason: "ip_quota",
      attemptsByIp: 5,
      attemptsByEmail: 1,
    });
  });

  it("preserves the email_quota reason on a genuine quota denial", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { allowed: false, reason: "email_quota", attempts_by_ip: 1, attempts_by_email: 3 },
      error: null,
    });

    const result = await checkAndRecordCustomerMagicLinkAttempt({
      client: { rpc },
      ip: "1.2.3.4",
      email: "buyer@example.com",
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("email_quota");
  });

  it("maps an RPC throw to reason rpc_error (not a quota reason)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const rpc = vi.fn().mockRejectedValue(new Error("network down"));

    const result = await checkAndRecordCustomerMagicLinkAttempt({
      client: { rpc },
      ip: "1.2.3.4",
      email: "buyer@example.com",
    });

    expect(result).toEqual({
      allowed: false,
      reason: "rpc_error",
      attemptsByIp: 0,
      attemptsByEmail: 0,
    });
  });

  it("maps a structured RPC error response to reason rpc_error", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } });

    const result = await checkAndRecordCustomerMagicLinkAttempt({
      client: { rpc },
      ip: "1.2.3.4",
      email: "buyer@example.com",
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("rpc_error");
  });

  it("maps an empty RPC result set to reason rpc_error", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });

    const result = await checkAndRecordCustomerMagicLinkAttempt({
      client: { rpc },
      ip: "1.2.3.4",
      email: "buyer@example.com",
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("rpc_error");
  });

  it("accepts an RPC response shaped as a single-row array (Postgres SETOF)", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ allowed: true, reason: null, attempts_by_ip: 0, attempts_by_email: 0 }],
      error: null,
    });

    const result = await checkAndRecordCustomerMagicLinkAttempt({
      client: { rpc },
      ip: "1.1.1.1",
      email: "x@y.com",
    });

    expect(result.allowed).toBe(true);
  });

  it("hashes IP and email before forwarding to the RPC (no plaintext leaves the helper)", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { allowed: true, reason: null, attempts_by_ip: 1, attempts_by_email: 1 },
      error: null,
    });

    await checkAndRecordCustomerMagicLinkAttempt({
      client: { rpc },
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

  it("ignores unknown reason strings to keep the API surface tight", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { allowed: false, reason: "globally_blocked", attempts_by_ip: 99, attempts_by_email: 99 },
      error: null,
    });

    const result = await checkAndRecordCustomerMagicLinkAttempt({
      client: { rpc },
      ip: "1.2.3.4",
      email: "buyer@example.com",
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toBeUndefined();
  });
});

describe("extractClientIp", () => {
  it("prefers the first x-forwarded-for hop", () => {
    expect(extractClientIp({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" })).toBe("203.0.113.7");
  });

  it("falls back to unknown when no client IP header is present", () => {
    expect(extractClientIp({})).toBe("unknown");
  });
});
