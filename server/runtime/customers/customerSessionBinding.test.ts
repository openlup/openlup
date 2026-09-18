import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { resolveCustomerSessionBinding } from "./customerSessionBinding.js";

describe("customer session binding", () => {
  it("issues, delivers in memory and closes without returning the challenge", async () => {
    const close = vi.fn(async () => {});
    const issue = vi.fn(async () => ({ deliverable: true }));
    const deliver = vi.fn(async () => {});
    const resolved = resolveCustomerSessionBinding(env(), {
      issuer: { issue: vi.fn() },
      generateToken: () => "one-time-token",
      now: () => new Date("2026-08-14T08:00:00.000Z"),
      delivery: { deliver },
      createStore: () => ({ issue, redeem: vi.fn(), close }),
    });
    if (!resolved.binding) throw new Error(resolved.error);

    await resolved.binding.requestChallenge(" Customer@Example.invalid ");

    expect(issue).toHaveBeenCalledWith({
      email: "customer@example.invalid",
      tokenHash: createHash("sha256").update("one-time-token").digest("hex"),
      expiresAt: "2026-08-14T08:10:00.000Z",
    });
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ token: "one-time-token" }));
    expect(close).toHaveBeenCalledOnce();
  });

  it("redeems once, signs the DB-derived identity and closes", async () => {
    const close = vi.fn(async () => {});
    const redeem = vi.fn(async () => ({
      principalId: "11111111-1111-4111-8111-111111111111",
      email: "owner@example.invalid",
    }));
    const issue = vi.fn(async () => ({
      accessToken: "signed",
      expiresAt: "2026-08-14T09:00:00.000Z",
    }));
    const resolved = resolveCustomerSessionBinding(env(), {
      issuer: { issue },
      createStore: () => ({ issue: vi.fn(), redeem, close }),
    });
    if (!resolved.binding) throw new Error(resolved.error);

    await expect(resolved.binding.verifyChallenge("challenge")).resolves.toEqual({
      accessToken: "signed",
      expiresAt: "2026-08-14T09:00:00.000Z",
      user: {
        id: "11111111-1111-4111-8111-111111111111",
        email: "owner@example.invalid",
      },
    });
    expect(issue).toHaveBeenCalledWith({
      principalId: "11111111-1111-4111-8111-111111111111",
      email: "owner@example.invalid",
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("fails closed when direct issuer configuration is absent", () => {
    expect(resolveCustomerSessionBinding({ PLATFORM_BUNDLE: "node-postgres", DATABASE_URL: "postgres://db" }))
      .toEqual({ error: "customer_session_issuer_invalid" });
  });
});

function env() {
  return { PLATFORM_BUNDLE: "node-postgres", DATABASE_URL: "postgres://db" };
}
