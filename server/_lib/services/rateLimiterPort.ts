// RateLimiterPort (Platform Portability, W4.5 — externalize in-memory hot-path state).
//
// `rateLimiter.service.ts` historically kept a module-level `Map<ip, bucket>`. On Vercel every
// invocation is its own short-lived process, so an in-memory map is exactly right (and the cheapest
// possible thing). On a long-running, horizontally-scaled Node bundle the SAME map is wrong twice:
//   1. it leaks — buckets for stale IPs are only ever overwritten on a *repeat* hit, never evicted,
//      so a long-lived process accumulates one entry per distinct IP forever;
//   2. it is per-instance — each Node replica counts independently, so the effective limit is
//      MAX_REQUESTS * instanceCount, not MAX_REQUESTS (no cross-instance fairness).
//
// This port factors the decision logic behind a small interface with two adapters:
//   - createInMemoryRateLimiter(): byte-for-byte the original Vercel behavior PLUS lazy eviction of
//     expired buckets on each check (the leak fix is invisible to callers — an expired bucket was
//     already treated as "fresh window"). This stays the DEFAULT so process.ts is unchanged.
//   - createPgRateLimiter(): a Postgres-backed adapter for multi-instance node-* fairness. It
//     atomically upserts+increments a shared counter row so two replicas share one window. The
//     backing TABLE is created by W6's db:bootstrap (NOT shipped here — W4.5 adds no migration).
//
// The default singleton + the exported `rateLimiter` shim live in rateLimiter.service.ts so its
// import path and signature stay identical (the process.ts golden-master must be byte-identical).

const WINDOW_MS = 60_000;
const MAX_REQUESTS = 10;

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSec: number;
}

export interface RateLimiterPort {
  check(ip: string, now?: number): RateLimitDecision | Promise<RateLimitDecision>;
}

export interface RateLimiterConfig {
  windowMs?: number;
  maxRequests?: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Default in-memory adapter. Preserves the original semantics EXACTLY (first hit opens a window;
 * a hit at/after resetAt opens a fresh window; the (maxRequests+1)th hit in a live window is
 * denied with a retry-after). Adds lazy eviction: an expired bucket is removed rather than left to
 * accumulate — observationally identical to the old code (an expired bucket was always re-opened),
 * but bounded on a long-lived process.
 */
export function createInMemoryRateLimiter(config: RateLimiterConfig = {}): RateLimiterPort {
  const windowMs = config.windowMs ?? WINDOW_MS;
  const maxRequests = config.maxRequests ?? MAX_REQUESTS;
  const buckets = new Map<string, Bucket>();

  return {
    check(ip: string, now: number = Date.now()): RateLimitDecision {
      const b = buckets.get(ip);
      if (!b || now >= b.resetAt) {
        buckets.set(ip, { count: 1, resetAt: now + windowMs });
        return { allowed: true, retryAfterSec: 0 };
      }
      if (b.count >= maxRequests) {
        return { allowed: false, retryAfterSec: Math.ceil((b.resetAt - now) / 1000) };
      }
      b.count += 1;
      return { allowed: true, retryAfterSec: 0 };
    },
  };
}

/** Minimal pg-query surface (a `pg` Pool/Client satisfies this) — keeps `pg` out of the import graph. */
export interface RateLimiterQuerier {
  query<T = unknown>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

export interface PgRateLimiterOptions {
  client: RateLimiterQuerier;
  config?: RateLimiterConfig;
  /**
   * Shared table name (created by W6 db:bootstrap). Columns: ip text PK, count int, reset_at
   * timestamptz. Defaults to `rate_limit_buckets`.
   */
  table?: string;
}

/**
 * Postgres-backed adapter for multi-instance node-* fairness. A single SQL statement atomically
 * (a) starts a fresh window when no live row exists, or (b) increments the shared counter, and
 * RETURNS the post-state so the decision is computed from the cluster-wide count — two replicas
 * sharing the same store see one combined limit. The window is expressed in milliseconds via
 * make_interval so it matches the in-memory adapter exactly.
 *
 * Schema (NOT created here — belongs to W6):
 *   CREATE TABLE rate_limit_buckets (ip text PRIMARY KEY, count int NOT NULL, reset_at timestamptz NOT NULL);
 */
export function createPgRateLimiter(options: PgRateLimiterOptions): RateLimiterPort {
  const windowMs = options.config?.windowMs ?? WINDOW_MS;
  const maxRequests = options.config?.maxRequests ?? MAX_REQUESTS;
  // Table name is a trusted constant (not user input); interpolated because identifiers can't be
  // parameterized. Default and any caller-supplied value are developer-controlled.
  const table = options.table ?? "rate_limit_buckets";

  return {
    async check(ip: string, now: number = Date.now()): Promise<RateLimitDecision> {
      const nowIso = new Date(now).toISOString();
      const resetIso = new Date(now + windowMs).toISOString();
      const sql = `
        INSERT INTO ${table} AS b (ip, count, reset_at)
        VALUES ($1, 1, $3::timestamptz)
        ON CONFLICT (ip) DO UPDATE SET
          count = CASE WHEN b.reset_at <= $2::timestamptz THEN 1 ELSE b.count + 1 END,
          reset_at = CASE WHEN b.reset_at <= $2::timestamptz THEN $3::timestamptz ELSE b.reset_at END
        RETURNING count, reset_at
      `;
      const { rows } = await options.client.query<{ count: number; reset_at: string | Date }>(
        sql,
        [ip, nowIso, resetIso],
      );
      const row = rows[0];
      if (!row) return { allowed: true, retryAfterSec: 0 };
      const count = Number(row.count);
      const resetAt = new Date(row.reset_at).getTime();
      if (count > maxRequests) {
        return { allowed: false, retryAfterSec: Math.max(0, Math.ceil((resetAt - now) / 1000)) };
      }
      return { allowed: true, retryAfterSec: 0 };
    },
  };
}
