import { describe, it, expect } from "vitest";
import {
  createInMemoryRateLimiter,
  createPgRateLimiter,
  type RateLimiterQuerier,
} from "./rateLimiterPort.js";

describe("createInMemoryRateLimiter (default Vercel behavior)", () => {
  it("allows the first request and opens a window", () => {
    const limiter = createInMemoryRateLimiter();
    expect(limiter.check("1.2.3.4", 0)).toEqual({ allowed: true, retryAfterSec: 0 });
  });

  it("allows exactly maxRequests then denies the next with a retry-after", () => {
    const limiter = createInMemoryRateLimiter({ maxRequests: 3, windowMs: 60_000 });
    expect(limiter.check("ip", 0)).toMatchObject({ allowed: true });
    expect(limiter.check("ip", 1)).toMatchObject({ allowed: true });
    expect(limiter.check("ip", 2)).toMatchObject({ allowed: true });
    const denied = limiter.check("ip", 3) as { allowed: boolean; retryAfterSec: number };
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSec).toBe(60); // ceil((60000 - 3) / 1000)
  });

  it("opens a fresh window once resetAt is reached", () => {
    const limiter = createInMemoryRateLimiter({ maxRequests: 1, windowMs: 1000 });
    expect(limiter.check("ip", 0)).toMatchObject({ allowed: true });
    expect(limiter.check("ip", 500)).toMatchObject({ allowed: false });
    // At/after resetAt (1000) the window resets.
    expect(limiter.check("ip", 1000)).toMatchObject({ allowed: true, retryAfterSec: 0 });
  });

  it("tracks distinct IPs independently", () => {
    const limiter = createInMemoryRateLimiter({ maxRequests: 1, windowMs: 1000 });
    expect(limiter.check("a", 0)).toMatchObject({ allowed: true });
    expect(limiter.check("b", 0)).toMatchObject({ allowed: true });
    expect(limiter.check("a", 1)).toMatchObject({ allowed: false });
  });
});

/** In-memory fake of the shared rate_limit_buckets table (W6 ships the real one). */
function createFakeRateLimitStore(): RateLimiterQuerier {
  const rows = new Map<string, { count: number; reset_at: number }>();
  return {
    async query<T = unknown>(_text: string, values: unknown[] = []): Promise<{ rows: T[] }> {
      const ip = String(values[0]);
      const nowMs = new Date(String(values[1])).getTime();
      const resetMs = new Date(String(values[2])).getTime();
      const existing = rows.get(ip);
      let next: { count: number; reset_at: number };
      if (!existing || existing.reset_at <= nowMs) {
        next = { count: 1, reset_at: resetMs };
      } else {
        next = { count: existing.count + 1, reset_at: existing.reset_at };
      }
      rows.set(ip, next);
      return {
        rows: [{ count: next.count, reset_at: new Date(next.reset_at).toISOString() }] as T[],
      };
    },
  };
}

describe("createPgRateLimiter (multi-instance fairness)", () => {
  it("enforces a COMBINED limit when two adapter instances share one store", async () => {
    // Simulates two Node replicas pointing at the same Postgres table.
    const store = createFakeRateLimitStore();
    const replicaA = createPgRateLimiter({ client: store, config: { maxRequests: 3, windowMs: 60_000 } });
    const replicaB = createPgRateLimiter({ client: store, config: { maxRequests: 3, windowMs: 60_000 } });

    // 3 allowed total, split across both replicas.
    expect(await replicaA.check("ip", 0)).toMatchObject({ allowed: true }); // count 1
    expect(await replicaB.check("ip", 1)).toMatchObject({ allowed: true }); // count 2
    expect(await replicaA.check("ip", 2)).toMatchObject({ allowed: true }); // count 3

    // The 4th request — on EITHER replica — must be denied (no per-instance multiplication).
    const deniedOnB = (await replicaB.check("ip", 3)) as { allowed: boolean; retryAfterSec: number };
    expect(deniedOnB.allowed).toBe(false);
    expect(deniedOnB.retryAfterSec).toBeGreaterThan(0);
  });

  it("opens a fresh shared window after reset", async () => {
    const store = createFakeRateLimitStore();
    const a = createPgRateLimiter({ client: store, config: { maxRequests: 1, windowMs: 1000 } });
    const b = createPgRateLimiter({ client: store, config: { maxRequests: 1, windowMs: 1000 } });
    expect(await a.check("ip", 0)).toMatchObject({ allowed: true });
    expect(await b.check("ip", 500)).toMatchObject({ allowed: false });
    expect(await a.check("ip", 1000)).toMatchObject({ allowed: true, retryAfterSec: 0 });
  });
});
