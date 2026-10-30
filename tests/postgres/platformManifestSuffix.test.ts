import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Pool } from "pg";
import { beforeAll, expect, it } from "vitest";
import { QUALIFIED_OWNER_PATH_FILE, QUALIFIED_RUNTIME_COMPLETION_FILE, selectPlatformMigrationManifest, sha256, type PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { qualifiedPostgresCatalogPayload, qualifiedPostgresStartupOptions, qualifiedAdminPostgresCatalogPayload, qualifiedAdminPostgresStartupOptions, type QualifiedPostgresInstallation, type QualifiedAdminPostgresInstallation } from "../../server/adapters/postgres/qualifiedInstall.js";
import { closePostgres, dockerAvailable, postgresSetupTimeoutMs, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

type Installation = QualifiedPostgresInstallation | QualifiedAdminPostgresInstallation;
const installations: Installation[] = [
  { generation: "qualified-v2", roleMode: "installer-managed", migrationLogin: "postgres", bootstrapLogin: "postgres", runtimeLogin: "suffix_runtime", restoreLogin: "suffix_restore" },
  { generation: "qualified-admin", roleMode: "installer-managed", migrationLogin: "suffix_admin", bootstrapLogin: "postgres", runtimeLogin: "suffix_runtime", restoreLogin: "suffix_restore" },
];
function select(manifest: PlatformMigrationManifest, installation: Installation) {
  return selectPlatformMigrationManifest(manifest, installation.generation, installation.generation === "qualified-v2"
    ? { migrationIsBootstrap: true, hasRestore: true } : { roleMode: installation.roleMode });
}
const lockName = "openlup:public-platform-migrations:v1";
// Frozen from separate reference measurements before fresh/upgrade qualification;
// no target's observed payload may replace this expected inventory.
const extendedInventories = {
  "qualified-v2": "9d8706c0527348772ca8135ed615a09569a30deb24db333908aa3a8b8ce03ce0",
  "qualified-admin": "6a9c813d1b835eb5fd769a6d9850cfc6c8be02038100cbd1e4e291b7ef65627d",
};
const prefixInventories = {
  legacy: "cfe3a8b4fa6216f61b1cdd5f004cb0f7a967bc01d9e18ddacb2efee74742d3b3",
  qualified: {
    bootstrapMigrator: { withRestore: "c4f6bb9daa5882877149a78e13d07594b7e8653c3a3ba39f508477b072548f9b" },
    separateMigrator: { withRestore: "624cc57789e3aaf36d0b61bdad420fc4eb0b63c2a7eb09358e5c18240ec13f82" },
  },
  qualifiedAdmin: {
    installerManaged: "c94d71fd28d5571cda30307bce4c4b48ebe0a3685c76819d8fa3b3efa8fa9ae7",
    operatorProvisioned: "807ea0c9b303c04c4ad3e9892ab16ee7e89acaea8b7641d1cedd4c79949fab7d",
  },
};
const issued = (() => {
  const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")) as PlatformMigrationManifest;
  if (manifest.schemaVersion !== 3) throw new Error("Suffix witness requires all three issued plans");
  for (const [plan, tail] of [
    [manifest, "db/platform/migrations/20261026120000_account_support_operator_authority.sql"],
    [manifest.qualified, QUALIFIED_OWNER_PATH_FILE],
    [manifest.qualifiedAdmin, QUALIFIED_RUNTIME_COMPLETION_FILE],
  ] as const) {
    const index = plan.forward.findIndex(({ file }) => file === tail);
    if (index < 0) throw new Error(`Suffix witness issued tail missing: ${tail}`);
    plan.forward = plan.forward.slice(0, index + 1);
  }
  manifest.objectInventorySha256 = prefixInventories.legacy;
  manifest.qualified.objectInventorySha256 = structuredClone(prefixInventories.qualified);
  manifest.qualifiedAdmin.objectInventorySha256 = structuredClone(prefixInventories.qualifiedAdmin);
  return manifest;
})();
const forward = { file: "db/platform/migrations/20261030120000_shared_suffix_probe.sql", content: `
CREATE FUNCTION public.platform_suffix_probe() RETURNS pg_catalog.int4
  LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS 'SELECT 17';
REVOKE ALL ON FUNCTION public.platform_suffix_probe() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.platform_suffix_probe() TO service_role;
` };

async function fixture(root: string, extended: boolean, installation: Installation) {
  const manifest = structuredClone(issued);
  if (manifest.schemaVersion !== 3) throw new Error("Suffix witness requires all three issued plans");
  if (extended) {
    const entry = { file: forward.file, sha256: sha256(forward.content) };
    for (const plan of [manifest, manifest.qualified, manifest.qualifiedAdmin]) plan.forward.push({ ...entry });
    if (installation.generation === "qualified-v2") manifest.qualified.objectInventorySha256.bootstrapMigrator.withRestore = extendedInventories[installation.generation];
    else manifest.qualifiedAdmin.objectInventorySha256.installerManaged = extendedInventories[installation.generation];
  }
  const files = new Set([manifest.baseline.file, ...manifest.forward.map(({ file }) => file),
    manifest.qualified.baseline.file, ...manifest.qualified.forward.map(({ file }) => file),
    manifest.qualifiedAdmin.baseline.file, ...manifest.qualifiedAdmin.forward.map(({ file }) => file)]);
  await mkdir(join(root, "config"), { recursive: true });
  for (const file of files) {
    const destination = join(root, file);
    await mkdir(dirname(destination), { recursive: true });
    if (file === forward.file) await writeFile(destination, forward.content);
    else await cp(file, destination);
  }
  await writeFile(join(root, "config/platform-migration-manifest.json"), JSON.stringify(manifest));
  return select(manifest, installation);
}

async function inventory(pool: Pool, installation: Installation) {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_catalog.pg_advisory_lock(pg_catalog.hashtextextended($1,0))", [lockName]);
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY");
    await client.query("LOCK TABLE ONLY public.platform_schema_migrations IN ACCESS SHARE MODE");
    return sha256(await (installation.generation === "qualified-v2"
      ? qualifiedPostgresCatalogPayload(client, installation, lockName) : qualifiedAdminPostgresCatalogPayload(client, installation, lockName)));
  } finally {
    await client.query("ROLLBACK");
    await client.query("SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtextextended($1,0))", [lockName]);
    client.release();
  }
}

beforeAll(async () => {
  if (!await dockerAvailable()) throw new Error("Shared suffix proof requires disposable PostgreSQL");
}, postgresSetupTimeoutMs);

for (const selection of installations) for (const upgrade of [false, true]) it(`installs a shared suffix through ${selection.generation} ${upgrade ? "upgrade" : "fresh installation"}`, async () => {
  const extendedInventory = extendedInventories[selection.generation];
  let container: PostgresContainer | undefined;
  const pools: Pool[] = [];
  const root = await mkdtemp(join(tmpdir(), "platform-manifest-suffix-"));
  const pool = (url: string) => { const value = new Pool({ connectionString: url }); pools.push(value); return value; };
  try {
    container = await runPostgresContainer({ name: `platform-suffix-${selection.generation}-${upgrade ? "upgrade" : "fresh"}-${process.pid}`, password: "synthetic-suffix" });
    if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Suffix PostgreSQL unavailable");
    const bootstrap = pool(container.connectionString);
    await bootstrap.query(`CREATE ROLE suffix_runtime LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-suffix';
      CREATE ROLE suffix_restore LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-suffix'`);
    if (selection.generation === "qualified-admin") await bootstrap.query(`CREATE ROLE suffix_admin LOGIN NOINHERIT CREATEROLE NOCREATEDB NOSUPERUSER NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-suffix';
      ALTER DATABASE postgres OWNER TO suffix_admin`);
    const url = new URL(container.connectionString); url.username = selection.migrationLogin;
    const migrationUrl = url.toString();
    url.searchParams.set("options", selection.generation === "qualified-v2" ? qualifiedPostgresStartupOptions(selection) : qualifiedAdminPostgresStartupOptions(selection));
    const migration = pool(url.toString());
    expect((await migration.query("SELECT current_user,session_user,rolsuper FROM pg_catalog.pg_roles WHERE rolname=current_user")).rows)
      .toEqual([{ current_user: selection.migrationLogin, session_user: selection.migrationLogin, rolsuper: selection.generation === "qualified-v2" }]);
    const runner = createPostgresMigrationRunner({ connectionString: migrationUrl }, { root, installation: selection, poolFactory: () => migration });
    const ledger = async () => (await migration.query("SELECT catalog_path,sha256,position,executed_at::pg_catalog.text FROM public.platform_schema_migrations ORDER BY position")).rows;
    const previous = select(issued, selection);
    const prefix = [previous.baseline, ...previous.forward];
    let installedPrefix: Awaited<ReturnType<typeof ledger>> = [];
    if (upgrade) {
      await fixture(root, false, selection);
      expect((await runner.apply()).applied).toEqual(prefix.map(({ file }) => file));
      installedPrefix = await ledger();
      expect(await inventory(migration, selection)).toBe(previous.objectInventorySha256);
    }
    const selected = await fixture(root, true, selection);
    const units = [selected.baseline, ...selected.forward];
    expect((await runner.status()).pending).toEqual((upgrade ? [forward.file] : units.map(({ file }) => file)));
    const applied = await runner.apply().catch(async error => {
      // A wrong reference pin must fail, while exposing the actual production
      // projection for the separately recorded reference measurement.
      if (String(error).includes("object inventory SHA-256 mismatch")) expect(await inventory(migration, selection)).toBe(extendedInventory);
      throw error;
    });
    expect(applied.applied).toEqual(upgrade ? [forward.file] : units.map(({ file }) => file));
    expect(await inventory(migration, selection)).toBe(extendedInventory);
    const installed = await ledger();
    expect(installed.map(({ executed_at: _time, ...row }) => row)).toEqual(units.map((unit, position) => ({ catalog_path: unit.file, sha256: unit.sha256, position })));
    if (upgrade) expect(installed.slice(0, prefix.length)).toEqual(installedPrefix);
    expect(await runner.status()).toEqual({ applied: units.map(({ file }) => file), pending: [] });
    expect(await runner.apply()).toEqual({ applied: [] });
    expect(await ledger()).toEqual(installed);
    const runtimeUrl = new URL(container.connectionString); runtimeUrl.username = selection.runtimeLogin;
    const runtime = pool(runtimeUrl.toString());
    expect((await runtime.query("SELECT current_user,session_user,public.platform_suffix_probe() AS value")).rows)
      .toEqual([{ current_user: selection.runtimeLogin, session_user: selection.runtimeLogin, value: 17 }]);
    expect((await runtime.query("SELECT rolsuper,rolbypassrls FROM pg_catalog.pg_roles WHERE rolname=current_user")).rows)
      .toEqual([{ rolsuper: false, rolbypassrls: false }]);
    for (const role of ["anon", "authenticated"]) {
      const caller = await runtime.connect();
      try {
        await caller.query(`SET ROLE ${role}`);
        await expect(caller.query("SELECT public.platform_suffix_probe()")).rejects.toMatchObject({ code: "42501" });
      } finally { await caller.query("RESET ROLE"); caller.release(); }
    }
  } finally {
    await closePostgres(container, pools, [() => rm(root, { recursive: true, force: true })]);
  }
}, postgresSetupTimeoutMs);
