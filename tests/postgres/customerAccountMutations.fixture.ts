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
// The migration test installs this prefix before applying the search-path forward.
const acquisitionSearchPathPredecessor = {
  legacy: "82568ad14720d9c74a8368924eaba4f4eaa0de4d7831c7b68518a3c12cc86509",
  bootstrap: "cffdddea783d1cdbc1460c6a9d6caf5bad4a94096eacd38938bdb6b6b28bc256",
  separate: "d7a7452c78bc5d1b3fc3920d483a2465f8a64caf2198238d9e8e494f52e168c5",
  "admin-managed": "beaa7e249a4a9966f48a6fe9a99c48900a7b228cc22e2178bdd42df5a56fc474",
  "admin-operator": "5c43ca0f133bffc0d3e2eebf826c1932272a0309b45add51d21cfa97d430d673",
} satisfies Record<AccountProfile, string>;

// Measured at the pin, independently of later catalogue entries.
const acquisitionSearchPathInstalled = {
  legacy: "76d05b09b1e4f4cde6466bf40b189d5c7978787042a790b069ce22ea4e296aaa",
  bootstrap: "bede32b6eedb9dba23844ad0cb465a45370b4c4f6140d3262a1e74f9e41fb852",
  separate: "c1dca69226df4c8895d74e095de065a3db8448b4bc0a9bc428854366a950f9d2",
  "admin-managed": "6cfc8b76e07bd297f20cbb6c706799130dcd3795adf404e84811bcd4620e3c03",
  "admin-operator": "f82dd30b6358a73575f018d3e7cc777ee24cff83c7f68e49eee09d56fcd68b1d",
} satisfies Record<AccountProfile, string>;

type CompleteManifest = Extract<PlatformMigrationManifest, { schemaVersion: 3 }>;
type AcquisitionBoundary = "before-pin" | "through-pin";

export function acquisitionSearchPathManifest(current: CompleteManifest, boundary: AcquisitionBoundary): CompleteManifest {
  const manifest = structuredClone(current);
  const pins = boundary === "before-pin" ? acquisitionSearchPathPredecessor : acquisitionSearchPathInstalled;
  const suffix = "_acquisition_definer_search_path_pin.sql";
  manifest.objectInventorySha256 = pins.legacy;
  manifest.qualified.objectInventorySha256 = {
    bootstrapMigrator: { withRestore: pins.bootstrap },
    separateMigrator: { withRestore: pins.separate },
  };
  manifest.qualifiedAdmin.objectInventorySha256 = {
    installerManaged: pins["admin-managed"],
    operatorProvisioned: pins["admin-operator"],
  };
  for (const plan of [manifest, manifest.qualified, manifest.qualifiedAdmin]) {
    const position = plan.forward.findIndex(unit => unit.file.endsWith(suffix));
    if (position < 0) throw new Error(`Missing acquisition fixture boundary ${suffix}`);
    plan.forward = plan.forward.slice(0, boundary === "through-pin" ? position + 1 : position);
  }
  return manifest;
}

function writeAcquisitionRoot(root: string, manifest: CompleteManifest) {
  for (const plan of [manifest, manifest.qualified, manifest.qualifiedAdmin]) {
    for (const unit of [plan.baseline, ...plan.forward]) {
      const target = join(root, unit.file);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(unit.file, target);
    }
  }
  mkdirSync(join(root, "config"));
  writeFileSync(join(root, "config/platform-migration-manifest.json"), JSON.stringify(manifest));
}

export async function installAtAcquisitionSearchPathBoundary(
  profile: AccountProfile, label: string, boundary: AcquisitionBoundary,
  upgradeCatalogue: "through-pin" | "current" = "through-pin",
) {
  const manifest = readPlatformMigrationManifest(process.cwd()) as PlatformMigrationManifest | null;
  if (manifest?.schemaVersion !== 3) throw new Error("Expected the complete platform migration catalogue");
  const scratch = mkdtempSync(join(tmpdir(), "acquisition-search-path-"));
  const removeRoots = () => rmSync(scratch, { recursive: true, force: true });
  try {
    const root = join(scratch, boundary);
    writeAcquisitionRoot(root, acquisitionSearchPathManifest(manifest, boundary));
    let upgradeRoot: string | undefined;
    if (upgradeCatalogue === "through-pin") {
      upgradeRoot = join(scratch, "through-pin");
      if (upgradeRoot !== root) writeAcquisitionRoot(upgradeRoot, acquisitionSearchPathManifest(manifest, "through-pin"));
    }
    const store = await installAccountMutations(profile, false, label, root, upgradeRoot);
    const close = store.close;
    store.close = async () => {
      try { await close(); }
      finally { removeRoots(); }
    };
    return store;
  } catch (error) {
    removeRoots();
    throw error;
  }
}

/** The existing account-consent installation matrix, also used to measure complete-inventory pins. */
export async function installAccountMutations(profile: AccountProfile, measure = false, label = "source", root?: string, upgradeRoot?: string) {
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
    return { owner, migrator, installation, runtime: profile === "legacy" ? owner : pool(login(r)), runner: runnerAt(upgradeRoot),
      get inventory() { return inventory; }, close: () => closePostgres(container, pools) };
  } catch (error) { await closePostgres(container, pools); throw error; }
}
