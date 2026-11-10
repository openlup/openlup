import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { qualifiedPostgresCatalogPayload, qualifiedAdminPostgresCatalogPayload, qualifiedPostgresStartupOptions, qualifiedAdminPostgresStartupOptions,
  type QualifiedPostgresInstallation, type QualifiedAdminPostgresInstallation } from "../../server/adapters/postgres/qualifiedInstall.js";
import { readSelectedCatalogProjection, selectedCatalogProjectionPayload } from "../../server/adapters/postgres/selectedCatalogProjection.js";
import { closePostgres, runPostgresContainer, waitForPostgresTcpReady } from "../helpers/postgresContainer.js";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const inventories = {
  "legacy": "ec9aef09204a3ecbd524694ed6d849b910f164c23549b80bb55e9ed83f9e3570",
  "bootstrap": "2d21bacb9a13484bb3765a098e16b38cf8f68d5214744e8a1460d74baefec30a",
  "separate": "ef6d3bf861b092092c1c5d60d492ef324100d6f3a8d73b92f194c29e0ba6a66f",
  "admin-managed": "bd3529be129c914159f4d8ea734753fe713bdb9c820e0f5e0dc595a60777762a",
  "admin-operator": "dd688244f730d5bf9d4d8827aaa4d67155c6dc160178f96ac76263eef613c432",
} as const;
it.each(["legacy", "bootstrap", "separate", "admin-managed", "admin-operator"] as const)("installs the sized editor on %s with the selected ownership and binding ACLs", async profile => {
  const container = await runPostgresContainer({ name: `sized-install-${profile}-${process.pid}`, password: "synthetic-conformance" });
  const pools: Pool[] = [];
  const pool = (url: string, options?: string) => { const value = new Pool({ connectionString: url, options }); pools.push(value); return value; };
  try {
    if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Sized editor PostgreSQL unavailable");
    const owner = pool(container.connectionString), password = randomUUID(), m = "sized_m", r = "sized_r", s = "sized_s", o = "sized_o";
    const admin = profile.startsWith("admin-"), separate = profile === "separate" || admin, operatorMode = profile === "admin-operator";
    const login = (name: string) => { const url = new URL(container.connectionString); url.username = name; if (name !== "postgres") url.password = password; return url.toString(); };
    if (separate) { await owner.query(`CREATE ROLE ${m} LOGIN ${admin ? "NOINHERIT NOSUPERUSER" : "INHERIT SUPERUSER"} ${admin && !operatorMode ? "CREATEROLE" : "NOCREATEROLE"} NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`); await owner.query(`ALTER DATABASE postgres OWNER TO ${m}`); }
    if (profile !== "legacy") for (const name of [r, s]) await owner.query(`CREATE ROLE ${name} LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
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
      : admin ? operatorMode ? { generation: "qualified-admin", roleMode: "operator-provisioned", bootstrapLogin: "postgres", migrationLogin: m, runtimeLogin: r, restoreLogin: s, operatorLogin: o }
        : { generation: "qualified-admin", roleMode: "installer-managed", bootstrapLogin: "postgres", migrationLogin: m, runtimeLogin: r, restoreLogin: s }
        : { generation: "qualified-v2", roleMode: "installer-managed", bootstrapLogin: "postgres", migrationLogin: separate ? m : "postgres", runtimeLogin: r, restoreLogin: s };
    const migrationUrl = login(installation.generation === "legacy" ? "postgres" : installation.migrationLogin);
    const migrator = pool(migrationUrl, installation.generation === "qualified-v2" ? qualifiedPostgresStartupOptions(installation) : installation.generation === "qualified-admin" ? qualifiedAdminPostgresStartupOptions(installation) : undefined);
    const runner = createPostgresMigrationRunner({ connectionString: migrationUrl }, { installation, poolFactory: () => migrator,
      catalogProjectionPayload: async client => {
        const payload = installation.generation === "qualified-v2" ? await qualifiedPostgresCatalogPayload(client, installation, "openlup:public-platform-migrations:v1")
          : installation.generation === "qualified-admin" ? await qualifiedAdminPostgresCatalogPayload(client, installation, "openlup:public-platform-migrations:v1")
            : selectedCatalogProjectionPayload(await readSelectedCatalogProjection(client));
        expect(hash(payload)).toBe(inventories[profile]);
        mkdirSync(".context/scratch/sized-edit", { recursive: true });
        writeFileSync(`.context/scratch/sized-edit/inventory-${profile}.json`, JSON.stringify({ profile, sha256: hash(payload) })); return payload;
      } });
    await runner.apply(); expect((await runner.apply()).applied).toEqual([]);
    expect((await owner.query("SELECT count(*)::int n FROM public.platform_schema_migrations")).rows[0].n).toBe(profile === "legacy" ? 114 : admin ? 118 : 119);
    for (const [signature, definer, service] of [
      ["public.subscription_sized_edit_context(uuid,uuid,boolean)", true, true],
      ["public.subscription_sized_edit_apply(uuid,uuid,text,uuid,jsonb,timestamptz)", true, true],
      ["public.subscriptions_configured_offer_guard()", false, false], ["public.subscriptions_bind_sized_opt_in_from_edit()", false, false],
    ] as const) {
      expect((await owner.query("SELECT prosecdef,proconfig FROM pg_proc WHERE oid=$1::regprocedure", [signature])).rows).toEqual([{ prosecdef: definer, proconfig: ["search_path=pg_catalog, pg_temp"] }]);
      expect((await owner.query("SELECT EXISTS(SELECT 1 FROM pg_proc p,aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=$1::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE') AS allowed", [signature])).rows[0].allowed).toBe(false);
      for (const role of ["anon", "authenticated", "service_role"]) {
        if (!(await owner.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role])).rowCount) continue;
        expect((await owner.query("SELECT has_function_privilege($1,$2,'EXECUTE') allowed", [role, signature])).rows[0].allowed).toBe(role === "service_role" && service);
      }
    }
    expect((await owner.query("SELECT tgname FROM pg_trigger WHERE tgname IN ('subscriptions_configured_offer_guard','subscription_events_bind_sized_opt_in') ORDER BY tgname")).rows).toEqual([{ tgname: "subscription_events_bind_sized_opt_in" }, { tgname: "subscriptions_configured_offer_guard" }]);
  } finally { await closePostgres(container, pools); }
}, 30_000);
