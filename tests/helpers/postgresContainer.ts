// Shared boot harness for the disposable PostgreSQL containers the
// `tests/postgres/**` suites stand up.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: a readiness predicate must travel the
// same transport as the work it gates.
//
// The official `postgres` image entrypoint does NOT start one server. It starts
// a temporary initialisation server for `initdb`, runs the bootstrap against it
// (creating `POSTGRES_DB` and any `docker-entrypoint-initdb.d` scripts), shuts
// it down, and only then execs the real server. The temporary server is started
// with `listen_addresses=''`, so it is reachable over the container's Unix
// socket and NOT over the published TCP port. Container log, one boot:
//
//   [262] LOG:  listening on Unix socket "/var/run/postgresql/.s.PGSQL.5432"
//   [262] LOG:  database system is ready to accept connections     <- temporary
//   [262] LOG:  received fast shutdown request
//   [262] LOG:  database system is shut down
//   PostgreSQL init process complete; ready for start up.
//   [1]   LOG:  listening on IPv4 address "0.0.0.0", port 5432     <- real
//   [1]   LOG:  database system is ready to accept connections
//
// A `docker exec psql` probe therefore reports READY during the temporary
// server's lifetime, while a host-side pool connecting through the published
// port gets `Connection terminated unexpectedly`. Probing the target database
// instead of `postgres` narrows that window but does not close it: the
// entrypoint creates `POSTGRES_DB` on the temporary server, so the target
// database exists inside the window too.
//
// `waitForPostgresTcpReady` closes the class rather than masking it. The
// temporary server has no TCP listener, so a completed host-side connection is
// itself proof that the real server is up. Load can only make the wait longer;
// it can never make the gate open early. That is the property the previous
// probe lacked, and it is why this is a readiness gate and not a retry: once it
// returns, the caller's own pool gets no retry at all and the first failure of
// any real statement is fatal.

import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { promisify } from "node:util";
import type { Pool } from "pg";
import { imageReference, pullWithRetry, readCiImage, readCiImages, resolvePinnedImage } from "../../scripts/ci-image-pull.mjs";

import { disposableLabelArgs } from "../../scripts/disposable-docker.mjs";

const exec = promisify(execFile);
const defaultPin = readCiImage("test-postgres");
export const defaultPostgresImage = `${defaultPin.repository.replace(/^library\//u, "")}:${defaultPin.tag}@${defaultPin.digest}`;
const pulls = new Map<string, Promise<string>>();
// Cold pinned pulls can take 300s. Leave bounded startup/readiness and schema
// installation time inside the same explicit integration hook as the batch gate.
export const postgresSetupTimeoutMs = 600_000;
export const postgresTeardownTimeoutMs = 45_000;
const dockerTimeoutMs = 30_000;
const poolCloseTimeoutMs = 5_000;

async function docker(args: string[], operation: string, timeout = dockerTimeoutMs) {
  const started = performance.now();
  try {
    return await exec("docker", args, { timeout, killSignal: "SIGKILL" });
  } catch (error) {
    throw Object.assign(new Error(`PostgreSQL Docker ${operation} failed after ${Math.round(performance.now() - started)}ms (limit ${timeout}ms)`), { cause: error });
  }
}

async function removeContainer(name: string, timeout = dockerTimeoutMs) {
  try {
    // PostgreSQL declares an anonymous data volume; remove it with its owned
    // disposable container on every cleanup path. Named volumes are retained.
    await docker(["rm", "-f", "-v", name], `remove ${name}`, timeout);
  } catch (error) {
    // Removing a container that never started (or was already removed) is safe.
    const cause = (error as Error & { cause?: unknown }).cause as { stderr?: string } | undefined;
    if (!/No such container/iu.test(cause?.stderr ?? "")) throw error;
  }
}

type TestPool = Pick<Pool, "end" | "ended">;

/** Close every test-owned pool/store, then attempt every container removal. */
export async function closePostgres(
  container: PostgresContainer | (PostgresContainer | null | undefined)[] | null | undefined,
  pool?: TestPool | (TestPool | null | undefined)[] | null,
  additionalClosers: (() => Promise<unknown>)[] = [],
) {
  const failures: unknown[] = [];
  const closers = [...additionalClosers];
  for (const value of Array.isArray(pool) ? pool : [pool]) {
    if (value && !value.ended) closers.push(() => value.end());
  }
  // Start every close before waiting: one failed store must not bypass another
  // pool, and one stalled store must not add another five seconds per pool.
  const closing = closers.map(close => Promise.resolve().then(close).catch(error => { failures.push(error); }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const started = performance.now();
  try {
    await Promise.race([
      Promise.all(closing),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`PostgreSQL pool/store shutdown exceeded ${poolCloseTimeoutMs}ms`)), poolCloseTimeoutMs);
      }),
    ]);
  } catch (error) {
    failures.push(error);
  } finally {
    clearTimeout(timer);
    console.info(`PostgreSQL pools.close ms=${Math.round(performance.now() - started)}`);
  }
  const removing = performance.now();
  try {
    await Promise.all((Array.isArray(container) ? container : [container]).map(async value => {
      try { await value?.remove(); } catch (error) { failures.push(error); }
    }));
  } finally { console.info(`PostgreSQL containers.remove ms=${Math.round(performance.now() - removing)}`); }
  if (failures.length) throw Object.assign(new Error("PostgreSQL cleanup failed"), { errors: [...failures] });
}

async function pinnedImage(reference: string, explicit: boolean): Promise<string | undefined> {
  const pin = readCiImages().find(image => [
    `${image.repository.replace(/^library\//u, "")}:${image.tag}@${image.digest}`,
    `${image.repository}:${image.tag}@${image.digest}`,
    ...image.sources.flatMap(source => [`${source}@${image.digest}`, imageReference(image, source)]),
  ].includes(reference));
  if (!pin) return undefined;
  let pending = pulls.get(reference);
  if (!pending) {
    pending = (explicit ? resolvePinnedImage(pin, reference) : pullWithRetry(pin)).catch(error => { pulls.delete(reference); throw error; });
    pulls.set(reference, pending);
  }
  return pending;
}

export type PostgresReadyOptions = {
  /** Total attempts before giving up. */
  attempts?: number;
  /** Delay between attempts, in milliseconds. */
  intervalMs?: number;
  /** Wall-clock budget including connection, query and retry waits. */
  timeoutMs?: number;
};

/**
 * Reserve a loopback TCP port by binding port 0 and releasing it.
 *
 * The port is only a hint: nothing holds it between the release here and the
 * bind inside `runPostgresContainer`, so two concurrent suites can be handed
 * the same number. `runPostgresContainer` retries on the resulting bind
 * conflict rather than pretending the reservation is exclusive.
 */
export async function reservePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => rejectPort(new Error("could not allocate a PostgreSQL port")));
        return;
      }
      const { port } = address;
      server.close(() => resolvePort(port));
    });
  });
}

/** True when a local Docker daemon answers. Suites skip loudly when it does not. */
export async function dockerAvailable(): Promise<boolean> {
  try {
    await docker(["version", "--format", "{{.Server.Version}}"], "version", 5_000);
    return true;
  } catch {
    return false;
  }
}

export type PostgresContainerSpec = {
  /** Container name. Callers scope it to the process so siblings cannot collide. */
  name: string;
  password: string;
  /** Passed as POSTGRES_DB. Omit to leave the cluster with only `postgres`. */
  database?: string;
  image?: string;
  /** Extra fixture selectors; ownership labels are always supplied by the helper. */
  labels?: Record<string, string>;
};

export type PostgresContainer = {
  port: number;
  /** Connection string for `database`, or for `postgres` when none was named. */
  connectionString: string;
  /** Connection string for an arbitrary database on the same cluster. */
  connectionStringFor: (database: string) => string;
  remove: () => Promise<void>;
};

/**
 * Start a disposable PostgreSQL container on a free loopback port.
 *
 * Retries only the port bind conflict described on `reservePort`, and only that
 * one: every other `docker run` failure retains its cause and operation, so a broken
 * image, a full disk or a dead daemon still fails the suite immediately.
 */
export async function runPostgresContainer(spec: PostgresContainerSpec): Promise<PostgresContainer> {
  const requested = spec.image ?? defaultPostgresImage;
  const pulled = await pinnedImage(requested, spec.image !== undefined);
  const image = pulled ?? requested;
  // Port-conflict retries share one startup budget; they cannot multiply the
  // owning fixture's deadline by the number of attempts. Failed-start cleanup
  // still gets its own removal budget before this function rejects.
  const deadline = performance.now() + 60_000;
  const remaining = () => {
    const ms = Math.floor(deadline - performance.now());
    if (ms <= 0) throw new Error(`PostgreSQL startup deadline exceeded for ${spec.name} (60000ms)`);
    return Math.min(dockerTimeoutMs, ms);
  };
  let lastError: unknown;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await removeContainer(spec.name, remaining());
    const port = await reservePort();
    const args = [
      "run", "-d", "--name", spec.name,
      ...Object.entries(spec.labels ?? {}).filter(([key]) => !key.startsWith("dev.disposable")).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
      ...disposableLabelArgs(),
      // Cover the image's VOLUME before create: even a SIGKILL between create
      // and start cannot allocate an anonymous PostgreSQL data volume. This is
      // disposable test data, like the existing installed-consumer fixtures.
      "--tmpfs", "/var/lib/postgresql/data",
      ...(pulled ? ["--pull=never"] : []),
      "-e", `POSTGRES_PASSWORD=${spec.password}`,
      ...(spec.database ? ["-e", `POSTGRES_DB=${spec.database}`] : []),
      "-p", `127.0.0.1:${port}:5432`,
      image,
    ];
    try {
      await docker(args, `start ${spec.name}`, remaining());
    } catch (error) {
      lastError = error;
      try { await removeContainer(spec.name); }
      catch (cleanup) { throw Object.assign(new Error(`PostgreSQL start and cleanup failed for ${spec.name}`), { errors: [error, cleanup] }); }
      const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : error;
      const message = cause instanceof Error ? cause.message : String(cause);
      if (!/port is already allocated|Bind .* failed|address already in use/i.test(message)) throw error;
      continue;
    }

    const base = `postgres://postgres:${spec.password}@127.0.0.1:${port}`;
    const connectionStringFor = (database: string) => `${base}/${database}`;
    return {
      port,
      connectionString: connectionStringFor(spec.database ?? "postgres"),
      connectionStringFor,
      remove: () => removeContainer(spec.name),
    };
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`could not start ${spec.name}: ${String(lastError)}`);
}

/**
 * Block until the real server accepts a connection over the published TCP port.
 *
 * This is the gate, not a retry around the work. It opens a throwaway pool,
 * completes a connection and a trivial statement, and disposes of it. The pool
 * the caller goes on to use is built afterwards and is never retried here.
 *
 * Returns false when the deadline passes, so callers keep their existing
 * "skip loudly rather than pretend" behaviour instead of failing obscurely.
 *
 * The wall-clock budget also covers a listener that accepts TCP but never
 * answers a query. Discard each probe client before closing its throwaway pool.
 */
export async function waitForPostgresTcpReady(
  connectionString: string,
  options: PostgresReadyOptions = {},
): Promise<boolean> {
  const attempts = options.attempts ?? 60;
  const intervalMs = options.intervalMs ?? 1_000;
  const deadline = performance.now() + (options.timeoutMs ?? 60_000);
  const pg = await import("pg");
  const PoolCtor = (pg.default?.Pool ?? pg.Pool) as typeof import("pg").Pool;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    // A fresh pool per attempt: a pool that failed to connect must not be
    // reused, and a pool left open would outlive the probe.
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    // Split the remaining budget so both connection and query fit this attempt.
    const phaseTimeout = Math.max(1, Math.floor(Math.min(5_000, remaining / 2)));
    const probe: Pool = new PoolCtor({ connectionString, connectionTimeoutMillis: phaseTimeout, query_timeout: phaseTimeout });
    // A pool is an EventEmitter: an "error" it emits while the server is still
    // coming up would be an unhandled event and take the whole worker down.
    // Swallowing it here is safe because this pool exists only to ask "yet?".
    probe.on("error", () => {});
    try {
      const client = await probe.connect();
      try {
        await client.query("SELECT 1");
      } finally {
        client.release(true);
      }
      return performance.now() < deadline;
    } catch {
      // Not ready: no TCP listener yet, the temporary server is shutting down,
      // or the real server is still replaying. Any of these is a "wait", never
      // a masked failure of the caller's work.
    } finally {
      await probe.end().catch(() => {});
    }
    if (attempt + 1 < attempts) {
      const wait = Math.min(intervalMs, deadline - performance.now());
      if (wait > 0) await new Promise((wake) => setTimeout(wake, wait));
    }
  }
  return false;
}
