import { afterEach, describe, expect, it, vi } from "vitest";

import {
  checkAndRecordCheckoutAttempt,
  checkoutAttemptIdentity,
  hashCheckoutAttemptIdentity,
} from "./publicCheckoutRateLimit.js";

const JOURNEY = "checkout:journey-123";

function allowedRpc() {
  return vi.fn().mockResolvedValue({
    data: { allowed: true, reason: null, attempts_by_ip: 1, attempts_by_email: 1 },
    error: null,
  });
}

function input(rpc: ReturnType<typeof allowedRpc>, sequence?: number) {
  return {
    client: { rpc },
    ip: "203.0.113.8",
    email: "Buyer@Example.com",
    journeyIdempotencyKey: JOURNEY,
    ...(sequence === undefined ? {} : { paymentAttemptSequence: sequence }),
  };
}

describe("checkAndRecordCheckoutAttempt", () => {
  afterEach(() => vi.restoreAllMocks());

  it("hashes the byte-exact initial attempt identity and never sends raw identities to the RPC", async () => {
    const rpc = allowedRpc();

    await expect(checkAndRecordCheckoutAttempt(input(rpc))).resolves.toEqual({
      allowed: true,
      attemptsByIp: 1,
      attemptsByEmail: 1,
    });

    expect(checkoutAttemptIdentity(JOURNEY)).toBe("checkout:journey-123\0" + "0");
    expect(hashCheckoutAttemptIdentity(JOURNEY)).toBe(
      "0bccd78127ec9c4df3180af60d1a12ab8248645fc290fa8f4cf7c2234df5abe3",
    );
    expect(rpc).toHaveBeenCalledWith("public_record_checkout_attempt", {
      p_ip_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      p_email_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      p_attempt_identity_hash: "0bccd78127ec9c4df3180af60d1a12ab8248645fc290fa8f4cf7c2234df5abe3",
      p_window_minutes: 60,
      p_max_per_ip: 10,
      p_max_per_email: 5,
    });
    const serialized = JSON.stringify(rpc.mock.calls[0]?.[1]);
    expect(serialized).not.toContain(JOURNEY);
    expect(serialized).not.toContain("203.0.113.8");
    expect(serialized).not.toContain("Buyer@Example.com");
  });

  it("treats a terminal retry sequence as a distinct exact attempt identity", async () => {
    const rpc = allowedRpc();

    await checkAndRecordCheckoutAttempt(input(rpc, 1));

    expect(checkoutAttemptIdentity(JOURNEY, 1)).toBe("checkout:journey-123\0" + "1");
    expect(hashCheckoutAttemptIdentity(JOURNEY, 1)).toBe(
      "10bc57207d717a619358d6da0f9edcf411aa2d644ac66f45566397fb03e2efa2",
    );
    expect(rpc.mock.calls[0]?.[1]).toMatchObject({
      p_attempt_identity_hash: "10bc57207d717a619358d6da0f9edcf411aa2d644ac66f45566397fb03e2efa2",
    });
  });

  it("preserves an ordinary quota denial", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { allowed: false, reason: "email_quota", attempts_by_ip: 3, attempts_by_email: 5 },
      error: null,
    });

    await expect(checkAndRecordCheckoutAttempt(input(rpc))).resolves.toEqual({
      allowed: false,
      reason: "email_quota",
      attemptsByIp: 3,
      attemptsByEmail: 5,
    });
  });

  it("fails closed for malformed RPC rows and logs no raw input", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rpc = vi.fn().mockResolvedValue({
      data: { allowed: "yes", reason: null, attempts_by_ip: 1, attempts_by_email: 1 },
      error: null,
    });

    await expect(checkAndRecordCheckoutAttempt(input(rpc))).resolves.toEqual({
      allowed: false,
      reason: "ip_quota",
      attemptsByIp: 0,
      attemptsByEmail: 0,
    });
    expect(warn).toHaveBeenCalledWith("public_checkout_rate_limit_rpc_malformed");
    expect(JSON.stringify(warn.mock.calls)).not.toContain(JOURNEY);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("Buyer@Example.com");
  });

  it("fails closed before the RPC for malformed identity inputs", async () => {
    const rpc = allowedRpc();

    await expect(checkAndRecordCheckoutAttempt({
      ...input(rpc),
      journeyIdempotencyKey: " ",
      paymentAttemptSequence: 51,
    })).resolves.toMatchObject({ allowed: false });
    expect(rpc).not.toHaveBeenCalled();
  });
});
