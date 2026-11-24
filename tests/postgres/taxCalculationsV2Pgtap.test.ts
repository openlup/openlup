import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { createTaxCalculationPrivacyContributor } from "@openlup/platform/identity";
import { afterAll, beforeAll, expect, it } from "vitest";
import { runManagedCompatPostgres } from "../helpers/managedCompatPostgres.js";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { qualifiedAdminPostgresStartupOptions, qualifiedPostgresStartupOptions, type QualifiedAdminPostgresInstallation,
  type QualifiedPostgresInstallation } from "../../server/adapters/postgres/qualifiedInstall.js";
import { storeJourneyResources } from "../helpers/storeJourney.js";

const forward = "db/platform/migrations/20261125170000_tax_calculations.sql";
const claimSeal = "db/platform/migrations/20261126540000_tax_calculation_claim_seal.sql";
const script = "tests/postgres/fixtures/taxCalculationsV2/replayed.sql";
const resources = storeJourneyResources();
let container: PostgresContainer | undefined, pool: Pool;
beforeAll(async () => {
  container = await runManagedCompatPostgres({ name: `tax-calculations-pgtap-${process.pid}`, password: "synthetic-conformance" });
  pool = new Pool({ connectionString: container.connectionString.replace("postgres://postgres:", "postgres://supabase_admin:") });
  const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8"));
  await pool.query("DROP SCHEMA auth CASCADE; DROP OWNED BY anon,authenticated,service_role CASCADE; DROP ROLE anon,authenticated,service_role;     CREATE ROLE service_role; CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions");
  const client = await pool.connect();
  try {
    // The later search-path forward also pins a routine this forward creates, so it stays out of this replay.
    for (const unit of [manifest.baseline, ...manifest.forward]) {
      if (unit.file !== forward && unit.file !== claimSeal && !/_function_search_path_pg_temp\.sql$/u.test(unit.file)) await client.query(readFileSync(unit.file, "utf8"));
    }
  } finally { client.release(); }
}, postgresSetupTimeoutMs);
afterAll(async () => { await Promise.all([closePostgres(container, pool), resources.close()]); }, postgresTeardownTimeoutMs);

const otherAcl = (relation: string) => `SELECT CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS role,
    a.privilege_type AS privilege,pg_get_userbyid(a.grantor) AS grantor,a.is_grantable AS grantable
  FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
  WHERE c.oid='${relation}'::regclass AND a.grantee<>c.relowner
  ORDER BY role,privilege,grantor,grantable`;

it.each([true, false])("replays storage constraints and function pins with browser and runtime roles present=%s", async optionalRoles => {
  const db = await pool.connect();
  try {
    await db.query("BEGIN; SET LOCAL search_path=public,extensions");
    const contributor = createTaxCalculationPrivacyContributor();
    const subject = { contactId: "00000000-0000-0000-0000-000000000001", principalId: null, identity: {} };
    expect((await contributor.export(db, subject)).data).toEqual([]);
    const assessment = await contributor.assessErasure(db, subject);
    expect(assessment.obligations).toEqual([]);
    await contributor.eraseOrRetain(db, subject, assessment, { principalId: subject.contactId });
    if (!optionalRoles) await db.query("DROP OWNED BY anon,authenticated,service_role CASCADE; DROP ROLE anon,authenticated,service_role");
    await db.query("CREATE TABLE public.tax_calculation_acl_control (id uuid)");
    await db.query("REVOKE ALL ON TABLE public.tax_calculation_acl_control FROM PUBLIC");
    if (optionalRoles) await db.query("REVOKE ALL ON TABLE public.tax_calculation_acl_control FROM anon,authenticated,service_role");
    const defaultAcl = (await db.query(otherAcl("public.tax_calculation_acl_control"))).rows;
    await db.query(readFileSync(forward, "utf8"));
    const projection = async () => (await db.query<{ body: string; acl: string }>(`SELECT
      pg_get_functiondef(oid) AS body,proacl::text AS acl
      FROM pg_proc WHERE oid='public.tax_calculation_terminal_v1(public.tax_calculations)'::regprocedure`)).rows[0]!;
    const previous = await projection();
    await db.query(readFileSync(claimSeal, "utf8"));
    expect(await projection()).toStrictEqual({
      ...previous,
      body: previous.body.replaceAll("Recover the original evidence through the adapter owner.",
        "Request a new quote when the tax service is available."),
    });
    expect((await db.query(otherAcl("public.tax_calculations"))).rows).toStrictEqual(defaultAcl);
    console.info("Managed-image default ACL grantees retained by the replay:", [...new Set(defaultAcl.map(row => row.role))]);
    const fixture = readFileSync(script, "utf8");
    const tap = async () => {
      const response = await db.query(fixture);
      const results = Array.isArray(response) ? response : [response];
      return results.flatMap(result => result.rows.flatMap((row: Record<string, unknown>) =>
        Object.values(row).filter((value): value is string => typeof value === "string")));
    };
    if (optionalRoles) for (const [routine, volatility] of [
      ["frame_v1(text,jsonb)", "VOLATILE"], ["hash_v1(text,jsonb)", "VOLATILE"], ["terminal_v1(public.tax_calculations)", "VOLATILE"],
      ["check_domain_v1(jsonb,jsonb,jsonb,boolean)", "VOLATILE"],
      ["begin_v1(jsonb)", "STABLE"], ["complete_v1(jsonb)", "STABLE"], ["transition_v1(jsonb,boolean)", "STABLE"],
    ]) {
      for (const change of [volatility, "RESET search_path"]) {
        await db.query("SAVEPOINT attributes_mutation");
        await db.query(`ALTER FUNCTION public.tax_calculation_${routine} ${change}`);
        expect((await tap()).filter(line => /^not ok /u.test(line))).toEqual([
          expect.stringContaining("all ten exact routines have the required attribute tuple"),
        ]);
        await db.query("ROLLBACK TO SAVEPOINT attributes_mutation");
      }
    }
    const lines = await tap();
    expect(lines.filter(line => /^(?:not ok|# Looks like)/u.test(line))).toEqual([]);
    expect(lines.filter(line => /^ok \d+/u.test(line))).toHaveLength(12);
    if (optionalRoles) {
      const { rows } = await db.query(`SELECT rolname, count(*) FILTER (WHERE has_function_privilege(r.oid,p.oid,'execute'))::int AS executable
        FROM pg_proc p CROSS JOIN pg_roles r WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'tax_calculation_%'
          AND r.rolname IN ('anon','authenticated','service_role') GROUP BY rolname ORDER BY rolname`);
      expect(rows).toStrictEqual([{ rolname: "anon", executable: 0 }, { rolname: "authenticated", executable: 0 }, { rolname: "service_role", executable: 4 }]);
      await db.query("SAVEPOINT acl_mutation");
      await db.query("GRANT SELECT ON public.tax_calculations TO service_role");
      const access = "SELECT has_table_privilege('service_role','public.tax_calculations','SELECT') AS allowed";
      expect((await db.query(access)).rows).toEqual([{ allowed: true }]);
      await db.query("ROLLBACK TO acl_mutation");
      expect((await db.query(access)).rows).toEqual([{ allowed: false }]);
    }
  } finally { await db.query("ROLLBACK"); db.release(); }
});

async function assertGrants(runtime: Pool, login: string) {
  const { rows } = await runtime.query(`SELECT session_user AS login, current_user AS runtime,
    has_table_privilege(current_user, 'public.tax_calculations', 'SELECT,INSERT,UPDATE,DELETE') AS table_access,
    has_any_column_privilege(current_user, 'public.tax_calculations', 'SELECT,INSERT,UPDATE,REFERENCES') AS column_access,
    ARRAY(SELECT proname::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'tax_calculation_%'
      AND has_function_privilege(current_user, oid, 'EXECUTE') ORDER BY proname) AS routines`);
  expect(rows).toStrictEqual([{ login, runtime: login, table_access: false, column_access: false,
    routines: ["tax_calculation_begin_v1", "tax_calculation_complete_v1", "tax_calculation_erase_v1", "tax_calculation_export_v1"] }]);
  const roleAccess = await runtime.query(`SELECT rolname FROM pg_roles WHERE rolname::text=ANY($1)
    AND (has_table_privilege(oid,'public.tax_calculations','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_any_column_privilege(oid,'public.tax_calculations','SELECT,INSERT,UPDATE,REFERENCES'))`,
  [[login, "anon", "authenticated", "service_role"]]);
  expect(roleAccess.rows).toEqual([]);
  await expect(runtime.query("SELECT * FROM public.tax_calculations")).rejects.toMatchObject({ code: "42501" });
  expect((await runtime.query("SELECT public.tax_calculation_export_v1(gen_random_uuid()) AS result")).rows).toEqual([{ result: [] }]);
}

it("limits the separate qualified runtime login to the two privacy and two evaluation entry points", async () => {
  const native = await resources.installation("tax-grants");
  await assertGrants(native.runtime, "transfer_runtime");
  expect((await native.owner.query(otherAcl("public.tax_calculations"))).rows).toEqual([]);
}, postgresSetupTimeoutMs);

it.each(["bootstrap", "admin-managed", "admin-operator"] as const)("proves effective grants for the mounted %s login", async profile => {
  const password = "synthetic-tax-roles";
  const instance = await runPostgresContainer({ name: `tax-calculation-${profile}-${process.pid}`, password });
  const pools: Pool[] = [];
  const bootstrapLogin = "postgres", runtimeLogin = "tax_runtime", restoreLogin = "tax_restore", operatorLogin = "tax_operator";
  const migrationLogin = profile === "bootstrap" ? bootstrapLogin : "tax_migration";
  const connect = (login: string, options?: string) => {
    const url = new URL(instance.connectionString);
    url.username = login;
    const pool = new Pool({ connectionString: url.href, options });
    pools.push(pool);
    return { pool, connectionString: url.href };
  };
  try {
    expect(await waitForPostgresTcpReady(instance.connectionString)).toBe(true);
    const owner = connect(bootstrapLogin).pool;
    const operator = profile === "admin-operator";
    for (const login of [runtimeLogin, restoreLogin])
      await owner.query(`CREATE ROLE ${login} LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
    if (profile !== "bootstrap") {
      await owner.query(`CREATE ROLE ${migrationLogin} LOGIN NOINHERIT NOSUPERUSER ${operator ? "NOCREATEROLE" : "CREATEROLE"} NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
      await owner.query(`ALTER DATABASE postgres OWNER TO ${migrationLogin}`);
    }
    if (operator) {
      await owner.query(`CREATE ROLE ${operatorLogin} LOGIN NOINHERIT NOSUPERUSER CREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
      const admin = connect(operatorLogin).pool;
      for (const group of ["anon", "authenticated", "service_role", "platform_acquisition_owner", "platform_acquisition_runtime", "openlup_retained_import_owner"]) {
        await owner.query(`CREATE ROLE ${group} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS`);
        await owner.query(`GRANT ${group} TO ${operatorLogin} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`);
        await admin.query(`GRANT ${group} TO ${migrationLogin} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE GRANTED BY ${operatorLogin}`);
        if (["anon", "authenticated", "service_role", "platform_acquisition_runtime"].includes(group))
          await admin.query(`GRANT ${group} TO ${runtimeLogin} WITH ADMIN FALSE, INHERIT ${group === "service_role"}, SET TRUE GRANTED BY ${operatorLogin}`);
      }
    }
    const roles = { bootstrapLogin, migrationLogin, runtimeLogin, restoreLogin };
    const installation: QualifiedPostgresInstallation | QualifiedAdminPostgresInstallation = profile === "bootstrap"
      ? { ...roles, generation: "qualified-v2", roleMode: "installer-managed" }
      : operator ? { ...roles, generation: "qualified-admin", roleMode: "operator-provisioned", operatorLogin }
      : { ...roles, generation: "qualified-admin", roleMode: "installer-managed" };
    const migrator = connect(migrationLogin, installation.generation === "qualified-v2"
      ? qualifiedPostgresStartupOptions(installation) : qualifiedAdminPostgresStartupOptions(installation));
    await createPostgresMigrationRunner({ connectionString: migrator.connectionString }, { installation, poolFactory: () => migrator.pool }).apply();
    await assertGrants(connect(runtimeLogin).pool, runtimeLogin);
    expect((await owner.query(otherAcl("public.tax_calculations"))).rows).toEqual([]);
    expect((await owner.query(`SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid='public.tax_calculations'::regclass`)).rows)
      .toEqual([{ owner: migrationLogin }]);
  } finally { await closePostgres(instance, pools); }
}, postgresSetupTimeoutMs);
