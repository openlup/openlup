import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Pool } from "pg";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import {
  qualifiedAdminPostgresStartupOptions,
  qualifiedPostgresStartupOptions,
  type QualifiedAdminPostgresInstallation,
  type QualifiedPostgresInstallation,
} from "../../server/adapters/postgres/qualifiedInstall.js";
import { closePostgres, dockerAvailable, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "./postgresContainer.js";

export type TemplateProfile = "legacy" | "qualified-v2" | "qualified-admin";
export type PgTemplateBrokerEndpoint = { url: string; token: string };
export type PgTemplateLease = {
  id: string;
  profile: TemplateProfile;
  dbName: string;
  ownerUrl: string;
  migrationUrl: string;
  runtimeUrl: string;
  rolePassword: string;
  release(): Promise<void>;
};

const VALID_PROFILES = new Set<TemplateProfile>(["legacy", "qualified-v2", "qualified-admin"]);
const ROLE_SNAPSHOT_SQL = `SELECT json_build_object(
  'roles', (SELECT coalesce(json_agg(r ORDER BY r.rolname), '[]'::json) FROM (
    SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin, rolreplication, rolbypassrls, rolconfig
    FROM pg_catalog.pg_roles
  ) r),
  'members', (SELECT coalesce(json_agg(m ORDER BY m.role_name, m.member_name, m.grantor_name), '[]'::json) FROM (
    SELECT r.rolname AS role_name, u.rolname AS member_name, g.rolname AS grantor_name,
      a.admin_option, a.inherit_option, a.set_option
    FROM pg_catalog.pg_auth_members a
    JOIN pg_catalog.pg_roles r ON r.oid = a.roleid
    JOIN pg_catalog.pg_roles u ON u.oid = a.member
    JOIN pg_catalog.pg_roles g ON g.oid = a.grantor
  ) m)
)::text AS snapshot`;

function sanitizeLabel(label?: string): string {
  if (!label) return "";
  const cleaned = label.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24);
  return cleaned ? `_${cleaned}` : "";
}

async function readClusterRoleDigest(bootstrap: Pool): Promise<string> {
  const { rows } = await bootstrap.query<{ snapshot: string }>(ROLE_SNAPSHOT_SQL);
  return createHash("sha256").update(rows[0]!.snapshot).digest("hex");
}

function withLogin(baseUrl: string, database: string, username: string, password?: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  url.username = username;
  if (password !== undefined) url.password = password;
  return url.toString();
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    total += buf.length;
    if (total > 16 * 1024) throw new Error("request_body_too_large");
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? JSON.parse(text) as Record<string, unknown> : {};
}

function tokenMatches(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice("Bearer ".length), "utf8");
  const target = Buffer.from(expected, "utf8");
  return supplied.length === target.length && timingSafeEqual(supplied, target);
}

type ClusterState = {
  profile: TemplateProfile;
  container: PostgresContainer;
  bootstrap: Pool;
  rolePassword: string;
  baselineRoleDigest: string;
  ddlChain: Promise<unknown>;
  sequence: number;
};

type LeaseRecord = {
  id: string;
  profile: TemplateProfile;
  dbName: string;
};

export type PgTemplateBroker = {
  url: string;
  token: string;
  activeClusterCount(): number;
  close(): Promise<void>;
};

/**
 * Run-scoped lazy PostgreSQL template broker. Starts zero containers on boot;
 * lazily provisions at most one sealed migrated cluster per requested profile
 * and serves ~90 ms `CREATE DATABASE ... TEMPLATE` clones across Vitest workers.
 */
export async function startPgTemplateBroker(): Promise<PgTemplateBroker> {
  const token = randomBytes(32).toString("hex");
  const clusterPromises = new Map<TemplateProfile, Promise<ClusterState>>();
  const readyClusters = new Map<TemplateProfile, ClusterState>();
  const leases = new Map<string, LeaseRecord>();
  let closed = false;

  const enqueueDdl = <T>(cluster: ClusterState, work: () => Promise<T>): Promise<T> => {
    const next = cluster.ddlChain.then(work, work);
    cluster.ddlChain = next.then(() => undefined, () => undefined);
    return next;
  };

  const ensureCluster = (profile: TemplateProfile): Promise<ClusterState> => {
    if (closed) return Promise.reject(new Error("pg_template_broker_closed"));
    const existing = clusterPromises.get(profile);
    if (existing) return existing;
    const starting = (async (): Promise<ClusterState> => {
      if (!await dockerAvailable()) throw new Error("PostgreSQL template broker requires Docker PostgreSQL");
      const container = await runPostgresContainer({
        name: `pg-tpl-${profile}-${process.pid}-${randomBytes(3).toString("hex")}`,
        password: "synthetic-conformance",
        tmpfsSizeMb: 768,
      });
      const pools: Pool[] = [];
      let bootstrap: Pool | undefined;
      try {
        if (!await waitForPostgresTcpReady(container.connectionString)) {
          throw new Error(`PostgreSQL template cluster unavailable (${profile})`);
        }
        bootstrap = new Pool({ connectionString: container.connectionString });
        pools.push(bootstrap);
        const rolePassword = randomBytes(16).toString("hex");
        const m = "lifecycle_m", r = "lifecycle_r", s = "lifecycle_s";
        if (profile === "qualified-admin") {
          await bootstrap.query(`CREATE ROLE ${m} LOGIN NOINHERIT NOSUPERUSER CREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${rolePassword}'`);
        }
        if (profile !== "legacy") {
          for (const name of [r, s]) {
            await bootstrap.query(`CREATE ROLE ${name} LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${rolePassword}'`);
          }
        }
        if (profile === "qualified-admin") {
          await bootstrap.query(`CREATE DATABASE template_migrated OWNER ${m}`);
        } else {
          await bootstrap.query("CREATE DATABASE template_migrated");
        }
        const installation: { generation: "legacy" } | QualifiedPostgresInstallation | QualifiedAdminPostgresInstallation =
          profile === "legacy"
            ? { generation: "legacy" }
            : {
              generation: profile,
              roleMode: "installer-managed",
              bootstrapLogin: "postgres",
              migrationLogin: profile === "qualified-admin" ? m : "postgres",
              runtimeLogin: r,
              restoreLogin: s,
            };
        const migrationLogin = installation.generation === "legacy" ? "postgres" : installation.migrationLogin;
        const templateUrl = withLogin(
          container.connectionString,
          "template_migrated",
          migrationLogin,
          migrationLogin === "postgres" ? undefined : rolePassword,
        );
        const startupOptions = installation.generation === "qualified-v2"
          ? qualifiedPostgresStartupOptions(installation)
          : installation.generation === "qualified-admin"
            ? qualifiedAdminPostgresStartupOptions(installation)
            : undefined;
        const migrationPool = new Pool({
          connectionString: templateUrl,
          options: startupOptions ? `${startupOptions} -c timezone=UTC` : "-c timezone=UTC",
        });
        try {
          const runner = createPostgresMigrationRunner(
            { connectionString: templateUrl },
            { root: process.cwd(), installation, poolFactory: () => migrationPool },
          );
          await runner.apply();
        } finally {
          migrationPool.on("error", () => {});
          await migrationPool.end();
        }
        await bootstrap.query("ALTER DATABASE template_migrated IS_TEMPLATE = true");
        await bootstrap.query("ALTER DATABASE template_migrated ALLOW_CONNECTIONS = false");
        const baselineRoleDigest = await readClusterRoleDigest(bootstrap);
        const state: ClusterState = {
          profile,
          container,
          bootstrap,
          rolePassword,
          baselineRoleDigest,
          ddlChain: Promise.resolve(),
          sequence: 0,
        };
        readyClusters.set(profile, state);
        return state;
      } catch (error) {
        clusterPromises.delete(profile);
        await closePostgres(container, pools);
        throw error;
      }
    })();
    clusterPromises.set(profile, starting);
    return starting;
  };

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const send = (status: number, body: Record<string, unknown>) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(body));
    };
    if (!tokenMatches(req.headers.authorization, token)) {
      send(401, { error: "unauthorized" });
      return;
    }
    try {
      if (req.method === "POST" && req.url === "/clone") {
        const body = await readJsonBody(req);
        const profile = body.profile as TemplateProfile;
        if (!VALID_PROFILES.has(profile)) {
          send(400, { error: "invalid_profile" });
          return;
        }
        const label = typeof body.label === "string" ? body.label : undefined;
        const cluster = await ensureCluster(profile);
        const leased = await enqueueDdl(cluster, async () => {
          if (closed) throw new Error("pg_template_broker_closed");
          const dbName = `cl_${++cluster.sequence}${sanitizeLabel(label)}`;
          const ownerClause = profile === "qualified-admin" ? " OWNER lifecycle_m" : "";
          await cluster.bootstrap.query(`CREATE DATABASE "${dbName}" TEMPLATE template_migrated${ownerClause}`);
          // Rotate acquisition_private.installation_key as bootstrap superuser so every clone
          // has an independent installation key (works even when lifecycle_m is NOSUPERUSER).
          const cloneBootstrapUrl = withLogin(cluster.container.connectionString, dbName, "postgres");
          const cloneBootstrap = new Pool({ connectionString: cloneBootstrapUrl });
          try {
            const hasKey = (await cloneBootstrap.query<{ exists: boolean }>(
              "SELECT to_regclass('acquisition_private.installation_key') IS NOT NULL AS exists",
            )).rows[0]?.exists;
            if (hasKey) {
              await cloneBootstrap.query(`UPDATE acquisition_private.installation_key
                SET key_bytes = pg_catalog.decode(pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '') || pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', ''), 'hex'),
                    created_at = pg_catalog.clock_timestamp()
                WHERE singleton`);
            }
          } finally {
            cloneBootstrap.on("error", () => {});
            await cloneBootstrap.end();
          }
          const id = randomBytes(12).toString("hex");
          leases.set(id, { id, profile, dbName });
          const ownerUrl = cloneBootstrapUrl;
          const migrationUrl = profile === "qualified-admin"
            ? withLogin(cluster.container.connectionString, dbName, "lifecycle_m", cluster.rolePassword)
            : ownerUrl;
          const runtimeUrl = profile === "legacy"
            ? ownerUrl
            : withLogin(cluster.container.connectionString, dbName, "lifecycle_r", cluster.rolePassword);
          return { id, profile, dbName, ownerUrl, migrationUrl, runtimeUrl, rolePassword: cluster.rolePassword };
        });
        send(200, leased);
        return;
      }
      if (req.method === "POST" && req.url === "/release") {
        const body = await readJsonBody(req);
        const id = typeof body.id === "string" ? body.id : "";
        const lease = leases.get(id);
        if (!lease) {
          send(200, { released: false });
          return;
        }
        leases.delete(id);
        const cluster = readyClusters.get(lease.profile);
        if (!cluster) {
          send(200, { released: false });
          return;
        }
        const roleDigestOk = await enqueueDdl(cluster, async () => {
          // Wait briefly for closed pg-pool backends to finish exiting before dropping,
          // avoiding gratuitous SIGTERM / 57P01 races on half-closed sockets.
          const drainDeadline = Date.now() + 500;
          let activeBackends = 1;
          while (Date.now() < drainDeadline) {
            const { rows } = await cluster.bootstrap.query<{ active: number }>(
              "SELECT count(*)::int AS active FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
              [lease.dbName],
            );
            activeBackends = rows[0]?.active ?? 0;
            if (activeBackends === 0) break;
            await new Promise((wake) => setTimeout(wake, 10));
          }
          if (activeBackends === 0) {
            try {
              await cluster.bootstrap.query(`DROP DATABASE IF EXISTS "${lease.dbName}"`);
            } catch (dropError) {
              if ((dropError as { code?: string })?.code !== "55006") throw dropError;
              await cluster.bootstrap.query(`DROP DATABASE IF EXISTS "${lease.dbName}" WITH (FORCE)`);
            }
          } else {
            await cluster.bootstrap.query(`DROP DATABASE IF EXISTS "${lease.dbName}" WITH (FORCE)`);
          }
          const currentDigest = await readClusterRoleDigest(cluster.bootstrap);
          return currentDigest === cluster.baselineRoleDigest;
        });
        if (!roleDigestOk) {
          send(409, { error: "cluster_role_mutation_detected", profile: lease.profile, dbName: lease.dbName });
          return;
        }
        send(200, { released: true });
        return;
      }
      send(404, { error: "not_found" });
    } catch (error) {
      send(500, { error: error instanceof Error ? error.message : String(error) });
    }
  };

  const server: Server = createServer((req, res) => {
    void handleRequest(req, res);
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", rejectListen);
      resolveListen();
    });
  });
  server.unref();
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("pg_template_broker_address_unavailable");
  }
  const url = `http://127.0.0.1:${address.port}`;

  return {
    url,
    token,
    activeClusterCount: () => readyClusters.size,
    async close() {
      if (closed) return;
      closed = true;
      await new Promise<void>((done) => server.close(() => done()));
      const settled = await Promise.allSettled([...clusterPromises.values()]);
      const clusters = settled
        .filter((item): item is PromiseFulfilledResult<ClusterState> => item.status === "fulfilled")
        .map((item) => item.value);
      await Promise.allSettled(clusters.map((cluster) => cluster.ddlChain));
      const containers = clusters.map((cluster) => cluster.container);
      const pools = clusters.map((cluster) => cluster.bootstrap);
      for (const value of pools) value.on("error", () => {});
      readyClusters.clear();
      clusterPromises.clear();
      leases.clear();
      if (containers.length || pools.length) {
        await closePostgres(containers, pools);
      }
    },
  };
}

export async function leaseFromEndpoint(
  endpoint: PgTemplateBrokerEndpoint,
  profile: TemplateProfile,
  label?: string,
): Promise<PgTemplateLease> {
  const response = await fetch(`${endpoint.url}/clone`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${endpoint.token}`,
    },
    body: JSON.stringify({ profile, label }),
  });
  const payload = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`pg_template_broker_clone_failed (${response.status}): ${String(payload.error ?? "unknown")}`);
  }
  const id = String(payload.id);
  let released = false;
  return {
    id,
    profile,
    dbName: String(payload.dbName),
    ownerUrl: String(payload.ownerUrl),
    migrationUrl: String(payload.migrationUrl),
    runtimeUrl: String(payload.runtimeUrl),
    rolePassword: String(payload.rolePassword),
    async release() {
      if (released) return;
      released = true;
      const releaseResponse = await fetch(`${endpoint.url}/release`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${endpoint.token}`,
        },
        body: JSON.stringify({ id }),
      });
      if (!releaseResponse.ok) {
        const errBody = await releaseResponse.json().catch(() => ({})) as Record<string, unknown>;
        throw new Error(`pg_template_broker_release_failed (${releaseResponse.status}): ${String(errBody.error ?? "unknown")}`);
      }
    },
  };
}

/** Attempt to lease a cloned database from the Vitest run-scoped broker, or return null outside Vitest. */
export async function tryLeaseTemplateDatabase(profile: TemplateProfile, label?: string): Promise<PgTemplateLease | null> {
  let endpoint: PgTemplateBrokerEndpoint | undefined;
  try {
    const vitest = await import("vitest");
    endpoint = vitest.inject("pgTemplateBroker");
  } catch {
    return null;
  }
  if (!endpoint?.url || !endpoint?.token) return null;
  return leaseFromEndpoint(endpoint, profile, label);
}
