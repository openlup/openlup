import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Pool } from "pg";
import { readPlatformMigrationManifest, type PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { qualifiedPostgresCatalogPayload, qualifiedAdminPostgresCatalogPayload, qualifiedPostgresStartupOptions, qualifiedAdminPostgresStartupOptions, type QualifiedPostgresInstallation, type QualifiedAdminPostgresInstallation } from "../../server/adapters/postgres/qualifiedInstall.js";
import { readSelectedCatalogProjection, selectedCatalogProjectionPayload } from "../../server/adapters/postgres/selectedCatalogProjection.js";
import { closePostgres, runPostgresContainer, waitForPostgresTcpReady } from "../helpers/postgresContainer.js";
export type AccountProfile = "legacy" | "bootstrap" | "separate" | "admin-managed" | "admin-operator";
export const subscriptionProfilesPredecessor = {
  legacy: "37eaad4927661af8b5edc939ce9c8132af7892ed1bb1473c2fc5707c3f3b4e13",
  bootstrap: "c6fea6b7fe85a7963f952994c34e1dfbca87045952e3dadbbf947c4b89aab5f6",
  separate: "d0a803fd96d5fe048179cff18181c437ede56daa3a8dc14b2ee0a62381753619",
  "admin-managed": "412caa25526d6ba70bb5bb761d5bed2336e7307811a879658295819ad5ab15f5",
  "admin-operator": "d413c04713b9fb5f5f9d8f01dc66c68c67d131f6cc94bcbf12becef47abd4f42",
} satisfies Record<AccountProfile, string>;

export const acquisitionSearchPathPredecessor = {
  legacy: "82568ad14720d9c74a8368924eaba4f4eaa0de4d7831c7b68518a3c12cc86509",
  bootstrap: "cffdddea783d1cdbc1460c6a9d6caf5bad4a94096eacd38938bdb6b6b28bc256",
  separate: "d7a7452c78bc5d1b3fc3920d483a2465f8a64caf2198238d9e8e494f52e168c5",
  "admin-managed": "beaa7e249a4a9966f48a6fe9a99c48900a7b228cc22e2178bdd42df5a56fc474",
  "admin-operator": "5c43ca0f133bffc0d3e2eebf826c1932272a0309b45add51d21cfa97d430d673",
} satisfies Record<AccountProfile, string>;

export async function installBeforeAcquisitionSearchPathPin(profile: AccountProfile, label: string,
  predecessor: "subscription-profiles" | "search-path-pin" = "search-path-pin") {
  const manifest = readPlatformMigrationManifest(process.cwd()) as PlatformMigrationManifest | null;
  if (manifest?.schemaVersion !== 3) throw new Error("Expected the complete platform migration catalogue");
  const pins = predecessor === "subscription-profiles" ? subscriptionProfilesPredecessor : acquisitionSearchPathPredecessor;
  const suffix = predecessor === "subscription-profiles" ? "_subscription_profiles.sql" : "_acquisition_definer_search_path_pin.sql";
  manifest.objectInventorySha256 = pins.legacy;
  manifest.qualified.objectInventorySha256 = {
    bootstrapMigrator: { withRestore: pins.bootstrap },
    separateMigrator: { withRestore: pins.separate },
  };
  manifest.qualifiedAdmin.objectInventorySha256 = {
    installerManaged: pins["admin-managed"],
    operatorProvisioned: pins["admin-operator"],
  };
  const root = mkdtempSync(join(tmpdir(), "acquisition-search-path-prefix-"));
  try {
    for (const plan of [manifest, manifest.qualified, manifest.qualifiedAdmin]) {
      const position = plan.forward.findIndex(unit => unit.file.endsWith(suffix));
      if (position < 0) throw new Error(`Missing predecessor boundary ${suffix}`);
      plan.forward = plan.forward.slice(0, position);
      for (const unit of [plan.baseline, ...plan.forward]) {
        const target = join(root, unit.file);
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(unit.file, target);
      }
    }
    mkdirSync(join(root, "config"));
    writeFileSync(join(root, "config/platform-migration-manifest.json"), JSON.stringify(manifest));
    return await installAccountMutations(profile, false, label, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The existing account-consent installation matrix, also used to measure complete-inventory pins. */
export async function installAccountMutations(profile: AccountProfile, measure = false, label = "source", root?: string) {
  const container = await runPostgresContainer({ name: `account-mutations-${profile}-${label}-${process.pid}`, password: "synthetic-conformance" });
  const pools: Pool[] = [];
  const pool = (url: string, options?: string) => { const value = new Pool({ connectionString: url, options }); pools.push(value); return value; };
  try {
    if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("account_mutations_postgres_unavailable");
    const owner = pool(container.connectionString), password = randomUUID();
    const m = "account_m", r = "account_r", s = "account_s", o = "account_o";
    const admin = profile.startsWith("admin-"), separate = profile === "separate" || admin, operatorMode = profile === "admin-operator";
    const login = (name: string) => { const url = new URL(container.connectionString); url.username = name; if (name !== "postgres") url.password = password; return url.toString(); };
    if (separate) {
      await owner.query(`CREATE ROLE ${m} LOGIN ${admin ? "NOINHERIT NOSUPERUSER" : "INHERIT SUPERUSER"} ${admin && !operatorMode ? "CREATEROLE" : "NOCREATEROLE"} NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
      await owner.query(`ALTER DATABASE postgres OWNER TO ${m}`);
    }
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
    let inventory = "";
    const runnerAt = (sourceRoot?: string) => createPostgresMigrationRunner({ connectionString: migrationUrl }, { root: sourceRoot, installation, poolFactory: () => migrator, catalogProjectionPayload: async client => {
      const payload = installation.generation === "qualified-v2" ? await qualifiedPostgresCatalogPayload(client, installation, "openlup:public-platform-migrations:v1")
        : installation.generation === "qualified-admin" ? await qualifiedAdminPostgresCatalogPayload(client, installation, "openlup:public-platform-migrations:v1") : selectedCatalogProjectionPayload(await readSelectedCatalogProjection(client));
      inventory = createHash("sha256").update(payload).digest("hex"); return payload;
    } });
    try { await runnerAt(root).apply(); }
    catch (error) { if (!measure || !inventory || !(error instanceof Error) || !error.message.includes("object inventory SHA-256 mismatch")) throw error; }
    return { owner, migrator, installation, runtime: profile === "legacy" ? owner : pool(login(r)), runner: runnerAt(),
      get inventory() { return inventory; }, close: () => closePostgres(container, pools) };
  } catch (error) { await closePostgres(container, pools); throw error; }
}
