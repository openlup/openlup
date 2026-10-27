import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { inspectLegacyPostgresInstallRoles } from "@openlup/platform/lifecycle";
import { closePostgres, dockerAvailable, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer,
  waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

let container: PostgresContainer | undefined;
let admin: Pool;
let restricted: Pool;
const request = { migrationLogin: "postgres", runtimeLogin: "postgres", roleMode: "installer-managed" } as const;

beforeAll(async () => {
  if (!await dockerAvailable()) throw new Error("M14 install qualification requires Docker PostgreSQL");
  container = await runPostgresContainer({ name: `m14-install-qualification-${process.pid}`, password: "synthetic-conformance" });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("M14 PostgreSQL unavailable");
  admin = new Pool({ connectionString: container.connectionString });
  await admin.query("CREATE ROLE m14_restricted LOGIN PASSWORD 'synthetic-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS");
  const url = new URL(container.connectionString);
  url.username = "m14_restricted";
  url.password = "synthetic-only";
  restricted = new Pool({ connectionString: url.toString() });
}, postgresSetupTimeoutMs);

afterAll(() => closePostgres(container, [admin, restricted]), postgresTeardownTimeoutMs);

it("observes actual fresh legacy prerequisites and ordinary-login refusals without writes", async () => {
  const before = (await admin.query("SELECT count(*)::int AS count FROM pg_catalog.pg_namespace")).rows[0];
  const readonly = await admin.connect();
  try {
    await readonly.query("BEGIN READ ONLY");
    expect(await inspectLegacyPostgresInstallRoles(readonly, request)).toMatchObject({ rolePrerequisitesMet: true, blockers: [] });
  } finally {
    await readonly.query("ROLLBACK");
    readonly.release();
  }
  const ordinary = await inspectLegacyPostgresInstallRoles(restricted, {
    migrationLogin: "m14_restricted", runtimeLogin: "m14_restricted", roleMode: "installer-managed",
  });
  expect(ordinary).toMatchObject({ currentUser: "m14_restricted", sessionUser: "m14_restricted", rolePrerequisitesMet: false });
  expect(ordinary.blockers).toEqual([{ code: "legacy_bootstrap_requires_superuser" }]);
  const separate = await inspectLegacyPostgresInstallRoles(admin, { ...request, runtimeLogin: "m14_restricted", roleMode: "operator-provisioned" });
  expect(separate.blockers).toEqual([
    { code: "legacy_bootstrap_requires_shared_runtime_login" },
    { code: "legacy_bootstrap_requires_installer_managed_roles" },
  ]);
  expect((await admin.query("SELECT count(*)::int AS count FROM pg_catalog.pg_namespace")).rows[0]).toEqual(before);
});

it("proves immutable acquisition bootstrap refuses an actual restricted login before schema writes", async () => {
  const sql = readFileSync("db/platform/migrations/20260816140000_acquisition_case_foundation.sql", "utf8");
  await expect(restricted.query(sql)).rejects.toMatchObject({ code: "42501", message: "acquisition_role_bootstrap_requires_superuser" });
  expect((await admin.query("SELECT to_regnamespace('acquisition_private') AS schema")).rows[0].schema).toBeNull();
  expect((await admin.query("SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'platform_acquisition_%'")).rows).toEqual([]);
});

it("reports pre-provisioned role flags/graph and proves safe actor-role collision before auth writes", async () => {
  const client = await admin.connect();
  try {
    await client.query("BEGIN");
    await client.query("CREATE ROLE anon NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS");
    await client.query("CREATE ROLE platform_acquisition_owner NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS");
    await client.query("CREATE ROLE platform_acquisition_runtime NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS");
    await client.query("GRANT platform_acquisition_runtime TO m14_restricted WITH ADMIN TRUE, INHERIT TRUE, SET TRUE");
    const report = await inspectLegacyPostgresInstallRoles(client, request);
    expect(report.rolePrerequisitesMet).toBe(false);
    expect(report.blockers).toEqual(["anon", "platform_acquisition_owner", "platform_acquisition_runtime"].map(role => ({ code: "legacy_bootstrap_role_already_exists", role })));
    expect(report.roles).toContainEqual(expect.objectContaining({ name: "platform_acquisition_runtime", bypassRls: true }));
    expect(report.memberships).toContainEqual(expect.objectContaining({ role: "platform_acquisition_runtime", member: "m14_restricted", admin: true, inherit: true, set: true }));
    await client.query("SET LOCAL ROLE m14_restricted");
    const switched = await inspectLegacyPostgresInstallRoles(client, {
      migrationLogin: "m14_restricted", runtimeLogin: "m14_restricted", roleMode: "installer-managed",
    });
    expect(switched).toMatchObject({ currentUser: "m14_restricted", sessionUser: "postgres" });
    expect(switched.blockers).toContainEqual({ code: "migration_login_mismatch" });
    await client.query("RESET ROLE");
    await client.query("SAVEPOINT collision");
    const actor = readFileSync("db/platform/migrations/20260810180001_self_host_actor_auth.sql", "utf8");
    await expect(client.query(actor)).rejects.toMatchObject({ code: "42710" });
    await client.query("ROLLBACK TO SAVEPOINT collision");
    expect((await client.query("SELECT to_regnamespace('auth') AS schema")).rows[0].schema).toBeNull();
    expect((await client.query("SELECT rolname FROM pg_catalog.pg_roles WHERE rolname='authenticated'")).rows).toEqual([]);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});
