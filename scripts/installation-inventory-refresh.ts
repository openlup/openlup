// Measures disposable local installations; never reads a deployment connection.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { Pool } from "pg";
import { createPostgresMigrationRunner } from "../server/adapters/postgres/migrationRunner.ts";
import { selectPlatformMigrationManifest } from "./platform-migration-manifest.ts";
import { qualifiedPostgresCatalogPayload, qualifiedAdminPostgresCatalogPayload, qualifiedPostgresStartupOptions, qualifiedAdminPostgresStartupOptions,
  type QualifiedPostgresInstallation, type QualifiedAdminPostgresInstallation } from "../server/adapters/postgres/qualifiedInstall.ts";
import { readSelectedCatalogProjection, selectedCatalogProjectionPayload } from "../server/adapters/postgres/selectedCatalogProjection.ts";
import { closePostgres, runPostgresContainer, waitForPostgresTcpReady } from "../tests/helpers/postgresContainer.ts";
import { connectedNativeStoreTables } from "../server/adapters/postgres/connectedStoreCapture.ts";
import { inventoryEnvelope, INVENTORY_PATH } from "./agent-review-derived.mjs";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const profiles = ["legacy", "bootstrap", "separate", "admin-managed", "admin-operator"] as const;
async function measure(profile: typeof profiles[number]) {
  let measured: string | undefined;
  const container = await runPostgresContainer({ name: `inventory-refresh-${profile}-${process.pid}`, password: randomUUID() });
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
        measured = hash(payload);
        return payload;
      } });
    // Each migration committed through the production runner before its final
    // inventory assertion. Only that stale measurement is expected during refresh.
    try { await runner.apply(); }
    catch (error) {
      if (!measured || !(error instanceof Error) || error.message !== "platform migration inventory rejected: platform migration manifest: object inventory SHA-256 mismatch") throw error;
    }
    if (!measured) throw new Error("Production projector did not measure the complete installation");
    const ledger = (await owner.query("SELECT catalog_path,sha256 FROM public.platform_schema_migrations ORDER BY position DESC")).rows;
    const manifest = selectPlatformMigrationManifest(JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")), installation.generation,
      installation.generation === "qualified-admin" ? { roleMode: installation.roleMode } : { migrationIsBootstrap: !separate, hasRestore: true });
    const expected = [manifest.baseline, ...manifest.forward].reverse();
    assert.deepEqual(ledger, expected.map(unit => ({ catalog_path: unit.file, sha256: unit.sha256 })));
    if (profile === "separate") {
      const tables = (await owner.query("SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname='public' AND tablename=ANY($1::text[])", [[...connectedNativeStoreTables]])).rows;
      assert.equal(tables.length, connectedNativeStoreTables.length);
    }
    const exactTailCount = ledger.findIndex(unit => unit.catalog_path === "db/platform/migrations/20261109150000_subscription_auto_resume_paid_history.sql");
    assert.ok(exactTailCount >= 0, "Exact-installation tail anchor is missing");
    return { count: ledger.length, exactTailCount, objectInventorySha256: measured, tail: ledger.map(unit => ({ file: unit.catalog_path, sha256: unit.sha256 })) };
  } finally { await closePostgres(container, pools); }
}
const source = readFileSync(INVENTORY_PATH, "utf8"), envelope = inventoryEnvelope(source);
const current = { profiles: {} as Record<string, Awaited<ReturnType<typeof measure>>>, connectedTableCount: connectedNativeStoreTables.length };
for (const profile of profiles) current.profiles[profile] = await measure(profile);
// Replacing only this value preserves historical bytes, including their formatting.
writeFileSync(INVENTORY_PATH, envelope.before + JSON.stringify(current, null, 2).replaceAll("\n", "\n  ") + envelope.after);
console.log("Measured all five complete PostgreSQL installation inventories");
