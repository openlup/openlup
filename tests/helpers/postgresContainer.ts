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

const exec = promisify(execFile);

export type PostgresReadyOptions = {
  /** Total attempts before giving up. */
  attempts?: number;
  /** Delay between attempts, in milliseconds. */
  intervalMs?: number;
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
    await exec("docker", ["version", "--format", "{{.Server.Version}}"]);
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
 * one: every other `docker run` failure is rethrown unchanged, so a broken
 * image, a full disk or a dead daemon still fails the suite immediately.
 */
export async function runPostgresContainer(spec: PostgresContainerSpec): Promise<PostgresContainer> {
  const image = spec.image ?? "postgres:16";
  let lastError: unknown;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await exec("docker", ["rm", "-f", spec.name]).catch(() => {});
    const port = await reservePort();
    const args = [
      "run", "-d", "--name", spec.name,
      "-e", `POSTGRES_PASSWORD=${spec.password}`,
      ...(spec.database ? ["-e", `POSTGRES_DB=${spec.database}`] : []),
      "-p", `127.0.0.1:${port}:5432`,
      image,
    ];
    try {
      await exec("docker", args);
    } catch (error) {
      lastError = error;
      await exec("docker", ["rm", "-f", spec.name]).catch(() => {});
      const message = error instanceof Error ? error.message : String(error);
      if (!/port is already allocated|Bind .* failed|address already in use/i.test(message)) throw error;
      continue;
    }

    const base = `postgres://postgres:${spec.password}@127.0.0.1:${port}`;
    const connectionStringFor = (database: string) => `${base}/${database}`;
    return {
      port,
      connectionString: connectionStringFor(spec.database ?? "postgres"),
      connectionStringFor,
      remove: async () => {
        await exec("docker", ["rm", "-f", spec.name]).catch(() => {});
      },
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
 * The default budget is deliberately close to the one it replaces rather than
 * larger: the probes it supersedes polled 40 times at one second plus the cost
 * of a `docker exec` each, and an attempt here fails fast while nothing is
 * listening. This wave is not buying reliability with a longer wait; the wait
 * is a consequence of gating on the right thing.
 */
export async function waitForPostgresTcpReady(
  connectionString: string,
  options: PostgresReadyOptions = {},
): Promise<boolean> {
  const attempts = options.attempts ?? 60;
  const intervalMs = options.intervalMs ?? 1_000;
  const pg = await import("pg");
  const PoolCtor = (pg.default?.Pool ?? pg.Pool) as typeof import("pg").Pool;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    // A fresh pool per attempt: a pool that failed to connect must not be
    // reused, and a pool left open would outlive the probe.
    const probe: Pool = new PoolCtor({ connectionString, connectionTimeoutMillis: 5_000 });
    // A pool is an EventEmitter: an "error" it emits while the server is still
    // coming up would be an unhandled event and take the whole worker down.
    // Swallowing it here is safe because this pool exists only to ask "yet?".
    probe.on("error", () => {});
    try {
      const client = await probe.connect();
      try {
        await client.query("SELECT 1");
      } finally {
        client.release();
      }
      return true;
    } catch {
      // Not ready: no TCP listener yet, the temporary server is shutting down,
      // or the real server is still replaying. Any of these is a "wait", never
      // a masked failure of the caller's work.
    } finally {
      await probe.end().catch(() => {});
    }
    await new Promise((wake) => setTimeout(wake, intervalMs));
  }
  return false;
}
