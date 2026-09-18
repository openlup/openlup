import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkAndRecordAdminMagicLinkAttempt,
  extractClientIp,
} from "./adminMagicLinkRateLimit.js";

describe("checkAndRecordAdminMagicLinkAttempt", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns allowed=true when the RPC accepts the attempt", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { allowed: true, reason: null, attempts_by_ip: 1, attempts_by_email: 1 },
      error: null,
    });

    const result = await checkAndRecordAdminMagicLinkAttempt({
      client: { rpc },
      ip: "1.2.3.4",
      email: "admin@example.com",
    });

    expect(result).toEqual({
      allowed: true,
      reason: undefined,
      attemptsByIp: 1,
      attemptsByEmail: 1,
    });
    expect(rpc).toHaveBeenCalledWith(
      "public_record_admin_magic_link_attempt",
      expect.objectContaining({
        p_window_minutes: 60,
        p_max_per_ip: 5,
        p_max_per_email: 3,
      }),
    );
  });

  it("preserves quota reasons without treating them as infrastructure errors", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { allowed: false, reason: "email_quota", attempts_by_ip: 1, attempts_by_email: 3 },
      error: null,
    });

    const result = await checkAndRecordAdminMagicLinkAttempt({
      client: { rpc },
      ip: "1.2.3.4",
      email: "admin@example.com",
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("email_quota");
  });

  it("maps RPC errors to rpc_error", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const rpc = vi.fn().mockRejectedValue(new Error("network down"));

    const result = await checkAndRecordAdminMagicLinkAttempt({
      client: { rpc },
      ip: "1.2.3.4",
      email: "admin@example.com",
    });

    expect(result).toEqual({
      allowed: false,
      reason: "rpc_error",
      attemptsByIp: 0,
      attemptsByEmail: 0,
    });
  });

  it("hashes IP and email before forwarding to the RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { allowed: true, reason: null, attempts_by_ip: 1, attempts_by_email: 1 },
      error: null,
    });

    await checkAndRecordAdminMagicLinkAttempt({
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
});

describe("extractClientIp", () => {
  it("prefers the first x-forwarded-for hop", () => {
    expect(extractClientIp({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" })).toBe("203.0.113.7");
  });

  it("falls back to unknown when no client IP header is present", () => {
    expect(extractClientIp({})).toBe("unknown");
  });
});
