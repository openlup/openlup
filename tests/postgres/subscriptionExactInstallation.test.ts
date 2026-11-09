import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { qualifiedPostgresCatalogPayload, qualifiedAdminPostgresCatalogPayload, qualifiedPostgresStartupOptions, qualifiedAdminPostgresStartupOptions, type QualifiedPostgresInstallation, type QualifiedAdminPostgresInstallation } from "../../server/adapters/postgres/qualifiedInstall.js";
import { readSelectedCatalogProjection, selectedCatalogProjectionPayload } from "../../server/adapters/postgres/selectedCatalogProjection.js";
import { closePostgres, runPostgresContainer, waitForPostgresTcpReady } from "../helpers/postgresContainer.js";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
it.each(["legacy", "bootstrap", "separate", "admin-managed", "admin-operator"] as const)("installs the exact editor on %s with service-only execution and immutable prefixes", async profile => {
  const container = await runPostgresContainer({ name: `exact-install-${profile}-${process.pid}`, password: "synthetic-conformance" });
  const pools: Pool[] = [];
  const pool = (url: string, options?: string) => { const value = new Pool({ connectionString: url, options }); pools.push(value); return value; };
  try {
    if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Exact editor PostgreSQL unavailable");
    const owner = pool(container.connectionString), password = randomUUID();
    const m = "exact_m", r = "exact_r", s = "exact_s", o = "exact_o";
    const admin = profile.startsWith("admin-"), separate = profile === "separate" || admin;
    const operatorMode = profile === "admin-operator";
    const login = (name: string) => { const url = new URL(container.connectionString); url.username = name; if (name !== "postgres") url.password = password; return url.toString(); };
    if (separate) {
      await owner.query(`CREATE ROLE ${m} LOGIN ${admin ? "NOINHERIT NOSUPERUSER" : "INHERIT SUPERUSER"} ${admin && !operatorMode ? "CREATEROLE" : "NOCREATEROLE"} NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
      await owner.query(`ALTER DATABASE postgres OWNER TO ${m}`);
    }
    if (profile !== "legacy") {
      for (const name of [r, s]) await owner.query(`CREATE ROLE ${name} LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
    }
    if (operatorMode) {
      await owner.query(`CREATE ROLE ${o} LOGIN NOINHERIT NOSUPERUSER CREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
      const operator = pool(login(o));
      for (const group of ["anon", "authenticated", "service_role", "platform_acquisition_owner", "platform_acquisition_runtime", "openlup_retained_import_owner"]) {
        await owner.query(`CREATE ROLE ${group} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS`);
        await owner.query(`GRANT ${group} TO ${o} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`);
        await operator.query(`GRANT ${group} TO ${m} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE GRANTED BY ${o}`);
        if (["anon", "authenticated", "service_role", "platform_acquisition_runtime"].includes(group)) await operator.query(`GRANT ${group} TO ${r} WITH ADMIN FALSE, INHERIT ${group === "service_role" ? "TRUE" : "FALSE"}, SET TRUE GRANTED BY ${o}`);
      }
    }
    const installation: { generation: "legacy" } | QualifiedPostgresInstallation | QualifiedAdminPostgresInstallation = profile === "legacy" ? { generation: "legacy" }
      : admin ? operatorMode
        ? { generation: "qualified-admin", roleMode: "operator-provisioned", bootstrapLogin: "postgres", migrationLogin: m, runtimeLogin: r, restoreLogin: s, operatorLogin: o }
        : { generation: "qualified-admin", roleMode: "installer-managed", bootstrapLogin: "postgres", migrationLogin: m, runtimeLogin: r, restoreLogin: s }
      : { generation: "qualified-v2", roleMode: "installer-managed", bootstrapLogin: "postgres", migrationLogin: separate ? m : "postgres", runtimeLogin: r, restoreLogin: s };
    const migrationUrl = login(installation.generation === "legacy" ? "postgres" : installation.migrationLogin);
    const migrator = pool(migrationUrl, installation.generation === "qualified-v2" ? qualifiedPostgresStartupOptions(installation) : installation.generation === "qualified-admin" ? qualifiedAdminPostgresStartupOptions(installation) : undefined);
    const runner = createPostgresMigrationRunner({ connectionString: migrationUrl }, { installation, poolFactory: () => migrator,
      catalogProjectionPayload: async client => {
        const payload = installation.generation === "qualified-v2" ? await qualifiedPostgresCatalogPayload(client, installation, "openlup:public-platform-migrations:v1")
          : installation.generation === "qualified-admin" ? await qualifiedAdminPostgresCatalogPayload(client, installation, "openlup:public-platform-migrations:v1")
          : selectedCatalogProjectionPayload(await readSelectedCatalogProjection(client));
        // Measure the complete selected catalogue, including ACLs and restricted ownership.
        mkdirSync(".context/scratch/exact-edit", { recursive: true });
        writeFileSync(`.context/scratch/exact-edit/inventory-${profile}.json`, JSON.stringify({ profile, sha256: hash(payload) }));
        return payload;
      } });
    await runner.apply();
    expect((await runner.apply()).applied).toEqual([]);
    const expected = profile === "legacy" ? 109 : admin ? 113 : 114;
    expect((await owner.query("SELECT count(*)::int AS n FROM public.platform_schema_migrations")).rows[0].n).toBe(expected);
    expect((await owner.query("SELECT catalog_path FROM public.platform_schema_migrations ORDER BY position DESC LIMIT 1")).rows)
      .toEqual([{ catalog_path: "db/platform/migrations/20261110100000_checkout_recovery_waves.sql" }]);
    const signature = "public.subscription_line_edit_apply(uuid,uuid,text,uuid,text,jsonb,timestamptz)";
    expect((await owner.query("SELECT prosecdef,proconfig FROM pg_proc WHERE oid=$1::regprocedure", [signature])).rows)
      .toEqual([{ prosecdef: true, proconfig: ["search_path=pg_catalog, pg_temp"] }]);
    expect((await owner.query("SELECT EXISTS(SELECT 1 FROM pg_proc p,aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=$1::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE') AS allowed", [signature])).rows)
      .toEqual([{ allowed: false }]);
    for (const role of ["anon", "authenticated", "service_role"]) {
      if (!(await owner.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role])).rowCount) continue;
      expect((await owner.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed", [role, signature])).rows)
        .toEqual([{ allowed: role === "service_role" }]);
    }
  } finally { await closePostgres(container, pools); }
}, 30_000);
