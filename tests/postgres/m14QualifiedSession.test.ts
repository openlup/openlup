import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { assertQualifiedPostgresSession, type QualifiedPostgresInstallation } from "../../server/adapters/postgres/qualifiedInstall.js";
import { readSelectedCatalogProjection, selectedCatalogProjectionPayload } from "../../server/adapters/postgres/selectedCatalogProjection.js";
import { closePostgres, dockerAvailable, postgresSetupTimeoutMs, postgresTeardownTimeoutMs,
  runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

const selection: QualifiedPostgresInstallation = {
  generation: "qualified-v2", roleMode: "operator-provisioned", migrationLogin: "postgres",
  bootstrapLogin: "postgres", runtimeLogin: "qualified_runtime", restoreLogin: "qualified_restore",
};
const lockName = "synthetic-qualified-session-admission";
const groups = ["anon", "authenticated", "service_role", "platform_acquisition_owner", "platform_acquisition_runtime", "openlup_retained_import_owner"];
let container: PostgresContainer | undefined;
let admin: Pool;
let runtime: Pool;

beforeAll(async () => {
  if (!await dockerAvailable()) throw new Error("Qualified session proof requires Docker PostgreSQL");
  container = await runPostgresContainer({ name: `m14-qualified-session-${process.pid}`, password: "synthetic-conformance" });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Qualified session PostgreSQL unavailable");
  admin = new Pool({ connectionString: container.connectionString });
  for (const name of [selection.runtimeLogin, selection.restoreLogin!]) {
    await admin.query(`CREATE ROLE ${name} LOGIN PASSWORD 'synthetic-only' NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  }
  for (const name of groups) await admin.query(`CREATE ROLE ${name} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  for (const name of ["anon", "authenticated", "service_role", "platform_acquisition_runtime"]) {
    await admin.query(`GRANT ${name} TO qualified_runtime WITH ADMIN FALSE, INHERIT ${name === "service_role" ? "TRUE" : "FALSE"}, SET TRUE`);
  }
  const url = new URL(container.connectionString);
  url.username = selection.runtimeLogin;
  url.password = "synthetic-only";
  runtime = new Pool({ connectionString: url.toString() });
}, postgresSetupTimeoutMs);

afterAll(() => closePostgres(container, [admin, runtime]), postgresTeardownTimeoutMs);

async function admittedSession(operation: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await admin.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [lockName]);
    await client.query("BEGIN");
    await client.query("SELECT set_config('openlup.qualified.runtime_login',$1,true),set_config('openlup.qualified.restore_login',$2,true),set_config('openlup.qualified.role_mode',$3,true)",
      [selection.runtimeLogin, selection.restoreLogin, selection.roleMode]);
    await operation(client);
  } finally {
    await client.query("ROLLBACK");
    await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [lockName]);
    client.release();
  }
}

async function snapshot(client: PoolClient) {
  return {
    catalog: selectedCatalogProjectionPayload(await readSelectedCatalogProjection(client)),
    defaults: (await client.query("SELECT defaclrole,defaclnamespace,defaclobjtype,defaclacl::text FROM pg_default_acl ORDER BY defaclrole,defaclnamespace,defaclobjtype")).rows,
    parameters: (await client.query("SELECT parname,paracl::text FROM pg_parameter_acl ORDER BY parname")).rows,
    database: (await client.query("SELECT datdba,datacl::text FROM pg_database WHERE datname=current_database()")).rows,
    ledger: (await client.query("SELECT to_regclass('public.platform_schema_migrations') AS ledger,to_regclass('public.clients') AS clients")).rows,
  };
}

it("admits the actual restricted, fixed operator-provisioned graph under the held migration lock", async () => {
  await admittedSession(async client => {
    const before = await snapshot(client);
    await assertQualifiedPostgresSession(client, [], selection, lockName);
    expect(await snapshot(client)).toEqual(before);
  });
});

it.each(["anon", "authenticated", "platform_acquisition_runtime"])("refuses database CREATE reachable through SET ROLE %s even without inheritance", async target => {
  await admin.query(`GRANT CREATE ON DATABASE postgres TO ${target}`);
  try {
    expect((await admin.query("SELECT has_database_privilege($1,current_database(),'CREATE') AS runtime,has_database_privilege($2,current_database(),'CREATE') AS target", [selection.runtimeLogin, target])).rows)
      .toEqual([{ runtime: false, target: true }]);
    const client = await runtime.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL ROLE ${target}`);
      await client.query("CREATE SCHEMA synthetic_capability_witness");
      expect((await client.query("SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname='synthetic_capability_witness'")).rows).toEqual([{ owner: target }]);
    } finally { await client.query("ROLLBACK"); client.release(); }
    await admittedSession(async client => {
      const before = await snapshot(client);
      await expect(assertQualifiedPostgresSession(client, [], selection, lockName)).rejects.toThrow("runtime_ddl_or_replication_capability_unsafe");
      expect(await snapshot(client)).toEqual(before);
    });
  } finally { await admin.query(`REVOKE CREATE ON DATABASE postgres FROM ${target}`); }
});

it.each(["anon", "authenticated", "platform_acquisition_runtime"])("refuses critical parameter SET reachable through SET ROLE %s", async target => {
  await admin.query(`GRANT SET ON PARAMETER session_replication_role TO ${target}`);
  try {
    expect((await admin.query("SELECT has_parameter_privilege($1,'session_replication_role','SET') AS runtime,has_parameter_privilege($2,'session_replication_role','SET') AS target", [selection.runtimeLogin, target])).rows)
      .toEqual([{ runtime: false, target: true }]);
    const client = await runtime.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL ROLE ${target}`);
      await client.query("SET LOCAL session_replication_role=replica");
      expect((await client.query("SELECT current_user AS login,current_setting('session_replication_role') AS replication_role")).rows).toEqual([{ login: target, replication_role: "replica" }]);
    } finally { await client.query("ROLLBACK"); client.release(); }
    await admittedSession(async client => {
      const before = await snapshot(client);
      await expect(assertQualifiedPostgresSession(client, [], selection, lockName)).rejects.toThrow("runtime_ddl_or_replication_capability_unsafe");
      expect(await snapshot(client)).toEqual(before);
    });
  } finally { await admin.query(`REVOKE SET ON PARAMETER session_replication_role FROM ${target}`); }
});

it("refuses critical ALTER SYSTEM authority on a SET-reachable role without changing host settings", async () => {
  await admin.query("GRANT ALTER SYSTEM ON PARAMETER session_replication_role TO anon");
  try {
    expect((await admin.query("SELECT has_parameter_privilege('qualified_runtime','session_replication_role','ALTER SYSTEM') AS runtime,has_parameter_privilege('anon','session_replication_role','ALTER SYSTEM') AS target")).rows)
      .toEqual([{ runtime: false, target: true }]);
    await admittedSession(async client => {
      const before = await snapshot(client);
      await expect(assertQualifiedPostgresSession(client, [], selection, lockName)).rejects.toThrow("runtime_ddl_or_replication_capability_unsafe");
      expect(await snapshot(client)).toEqual(before);
    });
  } finally { await admin.query("REVOKE ALTER SYSTEM ON PARAMETER session_replication_role FROM anon"); }
});

it("refuses an empty default ACL omitted by the unchanged legacy projection", async () => {
  await admittedSession(async client => {
    const canonical = selectedCatalogProjectionPayload(await readSelectedCatalogProjection(client));
    await client.query("ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE ALL ON TABLES FROM postgres");
    expect((await client.query("SELECT defaclacl::text AS acl FROM pg_default_acl WHERE defaclrole='postgres'::regrole AND defaclnamespace=0 AND defaclobjtype='r'")).rows)
      .toEqual([{ acl: "{}" }]);
    expect(selectedCatalogProjectionPayload(await readSelectedCatalogProjection(client))).toBe(canonical);
    const before = await snapshot(client);
    await expect(assertQualifiedPostgresSession(client, [], selection, lockName)).rejects.toThrow("qualified_profile_requires_canonical_default_privileges");
    expect(await snapshot(client)).toEqual(before);
  });
});
