import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  createPostgresCustomerSessionBinding,
  resolveCustomerSessionBinding,
} from "../../src/identity/customerSessionBinding.js";

describe("customer session binding", () => {
  it("reuses one lazy store across requestChallenge and verifyChallenge and closes once on binding.close()", async () => {
    const close = vi.fn(async () => {});
    const issue = vi.fn(async () => ({ deliverable: true }));
    const redeem = vi.fn(async () => ({
      principalId: "11111111-1111-4111-8111-111111111111",
      email: "customer@example.invalid",
    }));
    const deliver = vi.fn(async () => {});
    const sign = vi.fn(async () => ({
      accessToken: "signed",
      expiresAt: "2030-08-14T09:00:00.000Z",
    }));
    const createStore = vi.fn(() => ({ issue, redeem, close }));
    const resolved = resolveCustomerSessionBinding(env(), {
      issuer: { issue: sign },
      generateToken: () => "one-time-token",
      now: () => new Date("2030-08-14T08:00:00.000Z"),
      delivery: { deliver },
      createStore,
    });
    if (!resolved.binding) throw new Error(resolved.error);

    await resolved.binding.requestChallenge(" Customer@Example.invalid ");
    await expect(resolved.binding.verifyChallenge("one-time-token")).resolves.toEqual({
      accessToken: "signed",
      expiresAt: "2030-08-14T09:00:00.000Z",
      user: {
        id: "11111111-1111-4111-8111-111111111111",
        email: "customer@example.invalid",
      },
    });

    expect(issue).toHaveBeenCalledWith({
      email: "customer@example.invalid",
      tokenHash: createHash("sha256").update("one-time-token").digest("hex"),
      expiresAt: "2030-08-14T08:10:00.000Z",
    });
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ token: "one-time-token" }));
    expect(sign).toHaveBeenCalledWith({
      principalId: "11111111-1111-4111-8111-111111111111",
      email: "customer@example.invalid",
    });
    expect(createStore).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();

    await Promise.all([resolved.binding.close?.(), resolved.binding.close?.()]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("supports env-free createPostgresCustomerSessionBinding with borrowed store, borrowed pool and owned pool", async () => {
    const borrowedStore = {
      issue: vi.fn(async () => ({ deliverable: true })),
      redeem: vi.fn(async () => null),
    };
    const deliver = vi.fn(async () => {});
    const withStore = createPostgresCustomerSessionBinding({
      store: borrowedStore,
      issuer: { issue: vi.fn() },
      delivery: { deliver },
      generateToken: () => "tok-1",
      now: () => new Date("2030-08-14T08:00:00.000Z"),
    });
    await withStore.requestChallenge("a@example.invalid");
    await withStore.verifyChallenge("tok-1");
    await withStore.close();
    expect(borrowedStore.issue).toHaveBeenCalledTimes(1);
    expect(borrowedStore.redeem).toHaveBeenCalledTimes(1);

    const end = vi.fn(async () => {});
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("customer_identity_challenge_issue")) return { rows: [{ result: { deliverable: true } }] };
      return { rows: [] };
    });
    const borrowedPool = {
      connect: vi.fn(async () => ({ query, release: vi.fn() })),
      end,
    } as unknown as Pool;
    const withPool = createPostgresCustomerSessionBinding({
      pool: borrowedPool,
      issuer: { issue: vi.fn() },
      delivery: { deliver: vi.fn(async () => {}) },
    });
    await withPool.requestChallenge("b@example.invalid");
    await withPool.requestChallenge("c@example.invalid");
    await withPool.close();
    expect(end).not.toHaveBeenCalled();

    const ownedEnd = vi.fn(async () => {});
    const poolFactory = vi.fn(() => ({
      connect: vi.fn(async () => ({ query, release: vi.fn() })),
      end: ownedEnd,
    }) as unknown as Pool);
    const withUrl = createPostgresCustomerSessionBinding({
      connectionString: "postgres://db",
      poolFactory,
      issuer: { issue: vi.fn() },
      delivery: { deliver: vi.fn(async () => {}) },
    });
    await withUrl.requestChallenge("d@example.invalid");
    await withUrl.requestChallenge("e@example.invalid");
    expect(poolFactory).toHaveBeenCalledTimes(1);
    await Promise.all([withUrl.close(), withUrl.close()]);
    expect(ownedEnd).toHaveBeenCalledTimes(1);

    const belowMinTtl = 300 - 1;
    expect(() => createPostgresCustomerSessionBinding({
      store: borrowedStore,
      issuer: { issue: vi.fn() },
      challengeTtlSeconds: belowMinTtl,
    })).toThrow("customer identity ttl invalid");
    expect(() => createPostgresCustomerSessionBinding({
      connectionString: "  ",
      issuer: { issue: vi.fn() },
    })).toThrow("database_url_required");
  });

  it("fails closed when direct issuer configuration is absent", () => {
    expect(resolveCustomerSessionBinding({ PLATFORM_BUNDLE: "node-postgres", DATABASE_URL: "postgres://db" }))
      .toEqual({ error: "customer_session_issuer_invalid" });
  });
});

function env() {
  return { PLATFORM_BUNDLE: "node-postgres", DATABASE_URL: "postgres://db" };
}
