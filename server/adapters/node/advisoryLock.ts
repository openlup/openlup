// Per-job advisory lock for the Node scheduler (Platform Portability, W4, invariant #2).
//
// On Vercel exactly one cron timer fires per schedule. On a self-hosted Node bundle the SAME
// process image can run on MULTIPLE instances (horizontal scale, blue/green overlap, a stray
// second pod) — each with its own node-cron timer. Without coordination, every instance would
// fire the same job at the same minute => double-run (double emails, double DHL polls, double
// dispatch). `pg_try_advisory_lock` gives us a cluster-wide, connection-scoped mutex keyed per job:
// only the instance that ACQUIRES the lock runs the job body; the rest skip and release nothing
// (try-lock returns false without blocking). The lock is released after the job body finishes.
//
// Injectable: the adapter depends on the AdvisoryLock interface, not on `pg` directly, so tests
// run without a database and a non-Supabase bundle can supply its own pg-backed implementation.

/** A cluster-wide, per-job mutex. Returns true iff THIS caller acquired the lock. */
export interface AdvisoryLock {
  /** Explicit capability marker; staging bridge profiles require a cluster lock. */
  readonly durability?: "cluster" | "process";
  /** Try to acquire the lock for `jobId` without blocking. */
  tryAcquire(jobId: string): Promise<boolean>;
  /** Release a previously-acquired lock for `jobId`. */
  release(jobId: string): Promise<void>;
  /** Release the dedicated session when the host stops; safe to call repeatedly. */
  close(): Promise<void>;
}

/** Minimal pg-query surface (a `pg` Pool/Client satisfies this) — keeps `pg` out of the import graph. */
export interface AdvisoryLockQuerier {
  query<T = unknown>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
  end?(): Promise<void>;
}

/**
 * Deterministic 64-bit-ish key from a jobId for pg_try_advisory_lock(bigint).
 * Postgres advisory locks key on bigint; we hash the job name to a stable signed-32-bit int
 * (the single-arg `pg_try_advisory_lock(key bigint)` accepts it). Stable across processes.
 */
export function advisoryLockKey(jobId: string): number {
  // FNV-1a 32-bit, then coerce to signed 32-bit so it fits a Postgres int safely.
  let hash = 0x811c9dc5;
  for (let i = 0; i < jobId.length; i += 1) {
    hash ^= jobId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash | 0;
}

/**
 * pg-backed advisory lock. Uses `pg_try_advisory_lock` (session-scoped, non-blocking) on acquire
 * and `pg_advisory_unlock` on release. NOTE: session-scoped locks require the same connection for
 * acquire+release, so the supplied querier should be a single dedicated client/connection, not a
 * pool that hands out a different connection per query.
 */
export function createPgAdvisoryLock(
  client: AdvisoryLockQuerier,
  closeClient: () => Promise<void> = () => client.end?.() ?? Promise.resolve(),
): AdvisoryLock {
  let closePromise: Promise<void> | null = null;
  return {
    durability: "cluster",
    async tryAcquire(jobId) {
      const key = advisoryLockKey(jobId);
      const { rows } = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock($1) AS locked",
        [key],
      );
      return rows[0]?.locked === true;
    },
    async release(jobId) {
      const key = advisoryLockKey(jobId);
      await client.query("SELECT pg_advisory_unlock($1)", [key]);
    },
    close() {
      closePromise ??= closeClient();
      return closePromise;
    },
  };
}

/**
 * Build the lock a long-running host should actually use, from the connection string the
 * environment declares. Returns null when no connection string is configured, which leaves the
 * scheduler on its always-granting default — the exact behaviour of a host with a single instance.
 *
 * The connection is opened LAZILY, on the first acquire, and then reused: a session-scoped
 * try-lock must acquire and release on the SAME connection, and a host that never fires a timer
 * must never open one. `pg` stays out of the static import graph (dynamic import), so the default
 * hosted path and typecheck are untouched.
 */
export function createEnvAdvisoryLock(
  env: Record<string, string | undefined>,
  connect: (connectionString: string) => Promise<AdvisoryLockQuerier> = connectDedicatedClient,
): AdvisoryLock | null {
  const connectionString = env.DATABASE_URL?.trim() ?? "";
  if (connectionString === "") return null;
  let pending: Promise<AdvisoryLockQuerier> | null = null;
  let closed = false;
  let closePromise: Promise<void> | null = null;
  const querier: AdvisoryLockQuerier = {
    async query<T = unknown>(text: string, values?: unknown[]): Promise<{ rows: T[] }> {
      if (closed) throw new Error("advisory_lock_closed");
      pending ??= connect(connectionString);
      const client = await pending;
      return client.query<T>(text, values);
    },
  };
  return createPgAdvisoryLock(querier, () => {
    closed = true;
    closePromise ??= pending?.then((client) => client.end?.() ?? undefined) ?? Promise.resolve();
    return closePromise;
  });
}

async function connectDedicatedClient(connectionString: string): Promise<AdvisoryLockQuerier> {
  const pg = await import("pg");
  const ClientCtor = (pg.default?.Client ?? pg.Client) as typeof import("pg").Client;
  const client = new ClientCtor({ connectionString });
  await client.connect();
  return client as unknown as AdvisoryLockQuerier;
}

/** Lock that always grants (single-instance / tests). Never use in multi-instance Node deploys. */
export function createNoopAdvisoryLock(): AdvisoryLock {
  return {
    durability: "process",
    async tryAcquire() {
      return true;
    },
    async release() {
      /* no-op */
    },
    async close() {
      /* no-op */
    },
  };
}
