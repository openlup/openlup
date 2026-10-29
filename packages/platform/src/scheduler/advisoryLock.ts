// Per-job advisory lock for the Node scheduler.
//
// On Vercel exactly one cron timer fires per schedule. On a self-hosted Node bundle the SAME
// process image can run on MULTIPLE instances (horizontal scale, blue/green overlap, a stray
// second pod) — each with its own node-cron timer. Without coordination, every instance would
// fire the same job at the same minute => double-run (double emails, double polls, double
// dispatch). `pg_try_advisory_lock` gives us a cluster-wide, connection-scoped mutex keyed per job:
// only the instance that ACQUIRES the lock runs the job body; the rest skip and release nothing
// (try-lock returns false without blocking). The lock is released after the job body finishes.
//
// Injectable: the adapter depends on the AdvisoryLock interface, not on `pg` directly, so tests
// run without a database and a non-Supabase bundle can supply its own pg-backed implementation.

/** A cluster-wide, per-job mutex. Returns true iff THIS caller acquired the lock. */
export interface AdvisoryLock {
  /** Explicit capability marker; a host that must not run a job twice requires a cluster lock. */
  readonly durability?: "cluster" | "process";
  /** Try to acquire the lock for `jobId` without blocking. */
  tryAcquire(jobId: string): Promise<boolean>;
  /** Release a previously-acquired lock for `jobId`. */
  release(jobId: string): Promise<void>;
  /** Release the dedicated session when the host stops; safe to call repeatedly. */
  close(): Promise<void>;
}

/** Minimal query surface; the caller must supply a session-affine client, never Pool.query. */
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
 * pool that hands out a different connection per query. Each grant is checked in a separate
 * statement against the backend PID and pg_locks before protected work is admitted. This detects
 * observed transport violations; it cannot certify a pooler's future routing configuration.
 */
export function createPgAdvisoryLock(
  client: AdvisoryLockQuerier,
  closeClient: () => Promise<void> = () => client.end?.() ?? Promise.resolve(),
): AdvisoryLock {
  let closePromise: Promise<void> | null = null;
  let closed = false;
  let refused = false;
  let sessionPid: number | undefined;
  const affinityError = () => new Error(
    "OPENLUP_E_ADVISORY_SESSION_AFFINITY: session advisory lock ownership is unavailable; use a dedicated direct PostgreSQL connection or a session-mode pooler, never transaction pooling. Drain the host and retire its lock backend before restarting.",
  );
  const checkPid = (pid: number | undefined) => {
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || (sessionPid !== undefined && sessionPid !== pid)) {
      refused = true;
      throw affinityError();
    }
    sessionPid = pid;
  };
  // PostgreSQL grants reentrant session locks. Reserve the actual key locally
  // before querying so pending/held acquisitions, including hash collisions, skip.
  const reserved = new Set<number>();
  return {
    durability: "cluster",
    async tryAcquire(jobId) {
      if (closed) throw new Error("advisory_lock_closed");
      if (refused) throw affinityError();
      const key = advisoryLockKey(jobId);
      if (reserved.has(key)) return false;
      reserved.add(key);
      try {
        const { rows } = await client.query<{ locked: boolean; pid: number }>(
          "SELECT pg_catalog.pg_backend_pid() AS pid, pg_catalog.pg_try_advisory_lock($1::bigint) AS locked",
          [key],
        );
        checkPid(rows[0]?.pid);
        const acquired = rows[0]?.locked === true;
        if (!acquired) {
          reserved.delete(key);
          return false;
        }
        const observation = await client.query<{ pid: number; held: boolean }>(
          `SELECT pg_catalog.pg_backend_pid() AS pid, EXISTS (
            SELECT 1 FROM pg_catalog.pg_locks
            WHERE locktype = 'advisory' AND pid = pg_catalog.pg_backend_pid() AND granted
              AND classid = (($1::bigint >> 32) & 4294967295)::oid
              AND objid = ($1::bigint & 4294967295)::oid AND objsubid = 1
          ) AS held`, [key],
        );
        checkPid(observation.rows[0]?.pid);
        if (observation.rows[0]?.held !== true || refused || closed) throw affinityError();
        return true;
      } catch {
        // An uncertain grant may still own a session lock. Never reenter it or admit more work.
        // Do not close here: other already-admitted jobs must drain before session disposal.
        refused = true;
        throw affinityError();
      }
    },
    async release(jobId) {
      const key = advisoryLockKey(jobId);
      if (!reserved.has(key)) return;
      const { rows } = await client.query<{ pid: number; unlocked: boolean }>(
        `SELECT pg_catalog.pg_backend_pid() AS pid,
          CASE WHEN pg_catalog.pg_backend_pid() = $2::integer
            THEN pg_catalog.pg_advisory_unlock($1::bigint) ELSE false END AS unlocked`,
        [key, sessionPid],
      );
      checkPid(rows[0]?.pid);
      if (rows[0]?.unlocked !== true) {
        refused = true;
        throw affinityError();
      }
      // A failed unlock keeps the reservation: another query on this session
      // could otherwise reenter the still-held PostgreSQL lock.
      reserved.delete(key);
    },
    close() {
      closed = true;
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
  const lock = createPgAdvisoryLock(querier, () => {
    closed = true;
    closePromise ??= pending?.then((client) => client.end?.() ?? undefined) ?? Promise.resolve();
    return closePromise;
  });
  return {
    ...lock,
    async tryAcquire(jobId) {
      // Connection failure precedes every lock statement; preserve its peer or
      // transport error. Only a failed statement can leave an uncertain grant.
      if (!closed) await (pending ??= connect(connectionString));
      return lock.tryAcquire(jobId);
    },
  };
}

async function connectDedicatedClient(connectionString: string): Promise<AdvisoryLockQuerier> {
  const pg = await import("pg").catch(peerMissing);
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

/** Translate only absence of this optional peer; preserve broken SDKs and other failures. */
function peerMissing(cause: unknown): never {
  if (cause instanceof Error && "code" in cause
    && (cause.code === "ERR_MODULE_NOT_FOUND" || cause.code === "MODULE_NOT_FOUND")
    && /^Cannot find (?:package|module) ['"]pg['"]/.test(cause.message)) {
    throw new Error("OPENLUP_E_PEER_MISSING: pg is required by the Postgres scheduler advisory lock; install it alongside @openlup/platform", { cause });
  }
  throw cause;
}
