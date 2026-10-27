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

it("keeps hostile search-path role observation read-only and authoritative", async () => {
  const client = await restricted.connect();
  try {
    await admin.query(`
      CREATE SCHEMA m14_role_probe_shadow;
      CREATE TABLE m14_role_probe_shadow.calls (kind pg_catalog.text NOT NULL);
      GRANT USAGE ON SCHEMA m14_role_probe_shadow TO m14_restricted;
      GRANT SELECT, INSERT ON m14_role_probe_shadow.calls TO m14_restricted;
      CREATE FUNCTION m14_role_probe_shadow.note(label pg_catalog.text)
        RETURNS pg_catalog.bool LANGUAGE plpgsql VOLATILE AS $$
        BEGIN INSERT INTO m14_role_probe_shadow.calls VALUES (label); RETURN true; END $$;
      CREATE DOMAIN m14_role_probe_shadow.text AS pg_catalog.text
        CHECK (m14_role_probe_shadow.note('text-cast'));
      CREATE DOMAIN m14_role_probe_shadow.jsonb AS pg_catalog.jsonb
        CHECK (m14_role_probe_shadow.note('jsonb-cast'));
      CREATE FUNCTION m14_role_probe_shadow.current_database()
        RETURNS pg_catalog.name LANGUAGE plpgsql VOLATILE AS $$
        BEGIN
          PERFORM m14_role_probe_shadow.note('current_database');
          RETURN pg_catalog.current_database();
        END $$;
      CREATE FUNCTION m14_role_probe_shadow.jsonb_accumulate(state pg_catalog.jsonb, value pg_catalog.jsonb)
        RETURNS pg_catalog.jsonb LANGUAGE plpgsql VOLATILE AS $$
        BEGIN
          PERFORM m14_role_probe_shadow.note('jsonb_agg');
          RETURN state OPERATOR(pg_catalog.||) pg_catalog.jsonb_build_array(
            value OPERATOR(pg_catalog.||) pg_catalog.jsonb_build_object('superuser', true));
        END $$;
      CREATE AGGREGATE m14_role_probe_shadow.jsonb_agg(pg_catalog.jsonb)
        (SFUNC = m14_role_probe_shadow.jsonb_accumulate, STYPE = pg_catalog.jsonb, INITCOND = '[]');
      CREATE FUNCTION m14_role_probe_shadow.name_eq_text(a pg_catalog.name, b pg_catalog.text)
        RETURNS pg_catalog.bool LANGUAGE plpgsql VOLATILE AS $$
        BEGIN
          PERFORM m14_role_probe_shadow.note('name-text-equality');
          RETURN a OPERATOR(pg_catalog.=) b;
        END $$;
      CREATE OPERATOR m14_role_probe_shadow.=
        (LEFTARG = pg_catalog.name, RIGHTARG = pg_catalog.text, FUNCTION = m14_role_probe_shadow.name_eq_text);
      CREATE FUNCTION m14_role_probe_shadow.name_eq_name(a pg_catalog.name, b pg_catalog.name)
        RETURNS pg_catalog.bool LANGUAGE plpgsql VOLATILE AS $$
        BEGIN
          PERFORM m14_role_probe_shadow.note('name-name-equality');
          RETURN a OPERATOR(pg_catalog.=) b;
        END $$;
      CREATE OPERATOR m14_role_probe_shadow.=
        (LEFTARG = pg_catalog.name, RIGHTARG = pg_catalog.name, FUNCTION = m14_role_probe_shadow.name_eq_name);
      CREATE FUNCTION m14_role_probe_shadow.oid_eq(a pg_catalog.oid, b pg_catalog.oid)
        RETURNS pg_catalog.bool LANGUAGE plpgsql VOLATILE AS $$
        BEGIN
          PERFORM m14_role_probe_shadow.note('oid-equality');
          RETURN a OPERATOR(pg_catalog.=) b;
        END $$;
      CREATE OPERATOR m14_role_probe_shadow.=
        (LEFTARG = pg_catalog.oid, RIGHTARG = pg_catalog.oid, FUNCTION = m14_role_probe_shadow.oid_eq);
    `);
    const database = (await client.query("SELECT pg_catalog.current_database() AS database")).rows[0].database;
    await client.query("BEGIN READ WRITE");
    await client.query("SET LOCAL search_path TO m14_role_probe_shadow, pg_catalog");
    const report = await inspectLegacyPostgresInstallRoles(client, {
      migrationLogin: "m14_restricted", runtimeLogin: "m14_restricted", roleMode: "installer-managed",
    });
    const calls = (await client.query(`SELECT kind, pg_catalog.count(*)::pg_catalog.int4 AS calls
      FROM m14_role_probe_shadow.calls GROUP BY kind ORDER BY kind`)).rows;
    expect({ report, calls }).toMatchObject({
      report: {
        database, currentUser: "m14_restricted", sessionUser: "m14_restricted",
        rolePrerequisitesMet: false, blockers: [{ code: "legacy_bootstrap_requires_superuser" }],
        roles: [expect.objectContaining({ name: "m14_restricted", login: true, superuser: false })],
      },
      calls: [],
    });
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await admin.query("DROP SCHEMA IF EXISTS m14_role_probe_shadow CASCADE");
  }
});
