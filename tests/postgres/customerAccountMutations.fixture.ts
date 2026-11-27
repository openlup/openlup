import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Pool } from "pg";
import { readPlatformMigrationManifest, selectPlatformMigrationManifest, type PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { qualifiedPostgresCatalogPayload, qualifiedAdminPostgresCatalogPayload, qualifiedPostgresStartupOptions, qualifiedAdminPostgresStartupOptions, type QualifiedPostgresInstallation, type QualifiedAdminPostgresInstallation } from "../../server/adapters/postgres/qualifiedInstall.js";
import { readSelectedCatalogProjection, selectedCatalogProjectionPayload } from "../../server/adapters/postgres/selectedCatalogProjection.js";
import { hasPgTemplateBroker, tryLeaseTemplateDatabase, type PgTemplateLease, type TemplateProfile } from "../helpers/pgTemplateBroker.js";
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

export type AccountMutationsInstallation =
  | { generation: "legacy" }
  | QualifiedPostgresInstallation
  | QualifiedAdminPostgresInstallation;

export interface AccountMutationsStore {
  owner: Pool;
  migrator: Pool;
  installation: AccountMutationsInstallation;
  runtime: Pool;
  runner: ReturnType<typeof createPostgresMigrationRunner>;
  readonly inventory: string;
  close: () => Promise<void>;
}

export interface AccountMutationsTemplate {
  readonly installation: AccountMutationsInstallation;
  readonly inventory: string;
  clone: (label?: string) => Promise<AccountMutationsStore>;
  close: () => Promise<void>;
}

const CLUSTER_ROLE_SNAPSHOT_SQL = `SELECT json_build_object(
  'roles', (SELECT coalesce(json_agg(r ORDER BY r.rolname), '[]'::json) FROM (
    SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin, rolreplication, rolbypassrls, rolconfig
    FROM pg_catalog.pg_roles
  ) r),
  'members', (SELECT coalesce(json_agg(m ORDER BY m.role_name, m.member_name, m.grantor_name), '[]'::json) FROM (
    SELECT r.rolname AS role_name, u.rolname AS member_name, g.rolname AS grantor_name,
      a.admin_option, a.inherit_option, a.set_option
    FROM pg_catalog.pg_auth_members a
    JOIN pg_catalog.pg_roles r ON r.oid = a.roleid
    JOIN pg_catalog.pg_roles u ON u.oid = a.member
    JOIN pg_catalog.pg_roles g ON g.oid = a.grantor
  ) m)
)::text AS snapshot`;

function loginUrlFor(baseConnectionString: string, name: string, password: string): string {
  const url = new URL(baseConnectionString);
  url.username = name;
  if (name !== "postgres") url.password = password;
  return url.toString();
}

function migrationStartupOptions(installation: AccountMutationsInstallation): string | undefined {
  if (installation.generation === "qualified-v2") return qualifiedPostgresStartupOptions(installation);
  if (installation.generation === "qualified-admin") return qualifiedAdminPostgresStartupOptions(installation);
  return undefined;
}

export function createInventoryRunner(
  migrationUrl: string,
  migrator: Pool,
  installation: AccountMutationsInstallation,
  onInventory: (sha256: string) => void,
  sourceRoot?: string,
) {
  return createPostgresMigrationRunner({ connectionString: migrationUrl }, {
    root: sourceRoot,
    installation,
    poolFactory: () => migrator,
    catalogProjectionPayload: async client => {
      const payload = installation.generation === "qualified-v2"
        ? await qualifiedPostgresCatalogPayload(client, installation, "openlup:public-platform-migrations:v1")
        : installation.generation === "qualified-admin"
          ? await qualifiedAdminPostgresCatalogPayload(client, installation, "openlup:public-platform-migrations:v1")
          : selectedCatalogProjectionPayload(await readSelectedCatalogProjection(client));
      onInventory(createHash("sha256").update(payload).digest("hex"));
      return payload;
    },
  });
}

async function provisionAccountMutationsRoles(
  owner: Pool,
  connectionString: string,
  profile: AccountProfile,
  password: string,
  targetDatabase: "postgres" | "template_migrated",
): Promise<{ installation: AccountMutationsInstallation; dbOwner: string; runtimeLogin: string }> {
  const m = "account_m", r = "account_r", s = "account_s", o = "account_o";
  const admin = profile.startsWith("admin-"), separate = profile === "separate" || admin, operatorMode = profile === "admin-operator";
  const dbOwner = separate ? m : "postgres";
  if (separate) {
    await owner.query(`CREATE ROLE ${m} LOGIN ${admin ? "NOINHERIT NOSUPERUSER" : "INHERIT SUPERUSER"} ${admin && !operatorMode ? "CREATEROLE" : "NOCREATEROLE"} NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
    if (targetDatabase === "postgres") await owner.query(`ALTER DATABASE postgres OWNER TO ${m}`);
  }
  if (targetDatabase !== "postgres") {
    await owner.query(`CREATE DATABASE "${targetDatabase}" OWNER ${dbOwner}`);
  }
  if (profile !== "legacy") {
    for (const name of [r, s]) {
      await owner.query(`CREATE ROLE ${name} LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
    }
  }
  if (operatorMode) {
    await owner.query(`CREATE ROLE ${o} LOGIN NOINHERIT NOSUPERUSER CREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
    const operator = new Pool({ connectionString: loginUrlFor(connectionString, o, password) });
    try {
      for (const group of ["anon", "authenticated", "service_role", "platform_acquisition_owner", "platform_acquisition_runtime", "openlup_retained_import_owner"]) {
        await owner.query(`CREATE ROLE ${group} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS`);
        await owner.query(`GRANT ${group} TO ${o} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`);
        await operator.query(`GRANT ${group} TO ${m} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE GRANTED BY ${o}`);
        if (["anon", "authenticated", "service_role", "platform_acquisition_runtime"].includes(group)) {
          await operator.query(`GRANT ${group} TO ${r} WITH ADMIN FALSE, INHERIT ${group === "service_role" ? "TRUE" : "FALSE"}, SET TRUE GRANTED BY ${o}`);
        }
      }
    } finally {
      await operator.end();
    }
  }
  const installation: AccountMutationsInstallation = profile === "legacy" ? { generation: "legacy" }
    : admin ? operatorMode ? { generation: "qualified-admin", roleMode: "operator-provisioned", bootstrapLogin: "postgres", migrationLogin: m, runtimeLogin: r, restoreLogin: s, operatorLogin: o }
      : { generation: "qualified-admin", roleMode: "installer-managed", bootstrapLogin: "postgres", migrationLogin: m, runtimeLogin: r, restoreLogin: s }
    : { generation: "qualified-v2", roleMode: "installer-managed", bootstrapLogin: "postgres", migrationLogin: separate ? m : "postgres", runtimeLogin: r, restoreLogin: s };
  return { installation, dbOwner, runtimeLogin: r };
}

async function readClusterRoleDigest(bootstrap: Pool): Promise<string> {
  const { rows } = await bootstrap.query<{ snapshot: string }>(CLUSTER_ROLE_SNAPSHOT_SQL);
  return createHash("sha256").update(rows[0]!.snapshot).digest("hex");
}

function sanitizeCloneSuffix(label?: string): string {
  if (!label) return "";
  const cleaned = label.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32);
  return cleaned ? `_${cleaned}` : "";
}

async function endPoolsSafely(targetPools: Pool[]): Promise<void> {
  const unique = [...new Set(targetPools)];
  for (const value of unique) value.on("error", () => {});
  await Promise.all(unique.map(value => value.ended ? Promise.resolve() : value.end()));
}

// Only non-admin profiles share the run-scoped broker: qualified-admin capture/restore
// helpers temporarily GRANT/REVOKE platform_acquisition_owner cluster-wide, so admin-*
// suites keep per-suite isolated containers.
const ACCOUNT_BROKER_PROFILES: Partial<Record<AccountProfile, TemplateProfile>> = {
  legacy: "legacy",
  bootstrap: "qualified-v2",
  separate: "qualified-v2-separate",
};

function brokerInstallationFor(profile: AccountProfile, lease?: Pick<PgTemplateLease, "migrationLogin" | "runtimeLogin" | "restoreLogin">): AccountMutationsInstallation {
  if (profile === "legacy") return { generation: "legacy" };
  if (profile === "separate") {
    return {
      generation: "qualified-v2",
      roleMode: "installer-managed",
      bootstrapLogin: "postgres",
      migrationLogin: lease?.migrationLogin ?? "transfer_owner",
      runtimeLogin: lease?.runtimeLogin ?? "transfer_runtime",
      restoreLogin: lease?.restoreLogin ?? "transfer_restore",
    };
  }
  return {
    generation: "qualified-v2",
    roleMode: "installer-managed",
    bootstrapLogin: "postgres",
    migrationLogin: lease?.migrationLogin ?? "postgres",
    runtimeLogin: lease?.runtimeLogin ?? "lifecycle_r",
    restoreLogin: lease?.restoreLogin ?? "lifecycle_s",
  };
}

function brokerInventoryFor(profile: AccountProfile): string {
  const manifest = readPlatformMigrationManifest(process.cwd()) as PlatformMigrationManifest | null;
  if (!manifest) throw new Error("Expected platform migration manifest for broker profile");
  const selected = profile === "legacy"
    ? selectPlatformMigrationManifest(manifest, "legacy")
    : selectPlatformMigrationManifest(manifest, "qualified-v2", {
      migrationIsBootstrap: profile === "bootstrap",
      hasRestore: true,
    });
  return selected.objectInventorySha256;
}

function openBrokerBackedStore(
  profile: AccountProfile,
  lease: PgTemplateLease,
  upgradeRoot?: string,
): { store: AccountMutationsStore; pools: Pool[]; closed: () => boolean } {
  const installation = brokerInstallationFor(profile, lease);
  const pools: Pool[] = [];
  const openPool = (url: string, options?: string) => {
    const value = new Pool({ connectionString: url, options });
    pools.push(value);
    return value;
  };
  const owner = openPool(lease.ownerUrl);
  const migrator = openPool(lease.migrationUrl, migrationStartupOptions(installation));
  const runtime = profile === "legacy" ? owner : openPool(lease.runtimeUrl);
  let inventory = lease.inventory || brokerInventoryFor(profile);
  const runner = createInventoryRunner(lease.migrationUrl, migrator, installation, sha256 => { inventory = sha256; }, upgradeRoot);
  let isClosed = false;
  return {
    pools,
    closed: () => isClosed,
    store: {
      owner,
      migrator,
      installation,
      runtime,
      runner,
      get inventory() { return inventory; },
      close: async () => {
        if (isClosed) return;
        isClosed = true;
        try {
          await endPoolsSafely(pools);
        } finally {
          await lease.release();
        }
      },
    },
  };
}

/** The existing account-consent installation matrix, also used to measure complete-inventory pins. */
export async function installAccountMutations(
  profile: AccountProfile,
  measure = false,
  label = "source",
  root?: string,
  upgradeRoot?: string,
  options?: { isolatedCluster?: boolean; legacyServiceRole?: boolean },
): Promise<AccountMutationsStore> {
  const brokerProfile = !measure && !root && !upgradeRoot && !options?.isolatedCluster && !options?.legacyServiceRole
    ? ACCOUNT_BROKER_PROFILES[profile] : undefined;
  if (brokerProfile) {
    const lease = await tryLeaseTemplateDatabase(brokerProfile, label);
    if (lease) return openBrokerBackedStore(profile, lease, upgradeRoot).store;
  }
  const container = await runPostgresContainer({ name: `account-mutations-${profile}-${label}-${process.pid}`, password: "synthetic-conformance" });
  const pools: Pool[] = [];
  const pool = (url: string, options?: string) => { const value = new Pool({ connectionString: url, options }); pools.push(value); return value; };
  try {
    if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("account_mutations_postgres_unavailable");
    const owner = pool(container.connectionString), password = randomUUID();
    if (profile === "legacy" && options?.legacyServiceRole) await owner.query("CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS");
    const { installation, runtimeLogin } = await provisionAccountMutationsRoles(owner, container.connectionString, profile, password, "postgres");
    const migrationUrl = loginUrlFor(container.connectionString, installation.generation === "legacy" ? "postgres" : installation.migrationLogin, password);
    const migrator = pool(migrationUrl, migrationStartupOptions(installation));
    let inventory = "";
    const runnerAt = (sourceRoot?: string) => createInventoryRunner(migrationUrl, migrator, installation, sha256 => { inventory = sha256; }, sourceRoot);
    try { await runnerAt(root).apply(); }
    catch (error) { if (!measure || !inventory || !(error instanceof Error) || !error.message.includes("object inventory SHA-256 mismatch")) throw error; }
    return { owner, migrator, installation, runtime: profile === "legacy" ? owner : pool(loginUrlFor(container.connectionString, runtimeLogin, password)), runner: runnerAt(upgradeRoot),
      get inventory() { return inventory; }, close: () => closePostgres(container, pools) };
  } catch (error) { await closePostgres(container, pools); throw error; }
}

/**
 * Migrate one disposable PostgreSQL database per profile into a sealed template
 * database and clone isolated per-test/per-role databases in ~100 ms.
 * Callers must keep cluster-wide role grants balanced and avoid concurrent
 * `qualified-admin` capture/restore across sibling clones of one template
 * (those helpers temporarily GRANT/REVOKE `platform_acquisition_owner`
 * cluster-wide). `close()` verifies the `pg_roles`/`pg_auth_members` digest
 * matches the post-migration baseline and bounds every open clone pool through
 * `closePostgres`.
 */
export async function createAccountMutationsTemplate(
  profile: AccountProfile,
  label = "template",
  root?: string,
  upgradeRoot?: string,
  options?: { isolatedCluster?: boolean },
): Promise<AccountMutationsTemplate> {
  const brokerProfile = !root && !upgradeRoot && !options?.isolatedCluster ? ACCOUNT_BROKER_PROFILES[profile] : undefined;
  if (brokerProfile && await hasPgTemplateBroker()) {
    const installation = brokerInstallationFor(profile);
    const inventory = brokerInventoryFor(profile);
    const activeEntries = new Set<{ lease: PgTemplateLease; pools: Pool[]; closed: boolean }>();
    let templateClosed = false;
    let closePromise: Promise<void> | undefined;
    return {
      installation,
      get inventory() { return inventory; },
      async clone(cloneLabel?: string): Promise<AccountMutationsStore> {
        if (templateClosed) throw new Error("account_mutations_template_closed");
        const lease = await tryLeaseTemplateDatabase(brokerProfile, cloneLabel ?? label);
        if (!lease) throw new Error("account_mutations_broker_unavailable");
        if (templateClosed) {
          await lease.release().catch(() => {});
          throw new Error("account_mutations_template_closed");
        }
        const opened = openBrokerBackedStore(profile, lease, upgradeRoot);
        const record = { lease, pools: opened.pools, closed: false };
        activeEntries.add(record);
        const rawClose = opened.store.close;
        return {
          ...opened.store,
          get inventory() { return opened.store.inventory; },
          close: async () => {
            if (record.closed) return;
            record.closed = true;
            activeEntries.delete(record);
            await rawClose();
          },
        };
      },
      close: () => {
        if (closePromise) return closePromise;
        templateClosed = true;
        closePromise = (async () => {
          const openEntries = [...activeEntries];
          activeEntries.clear();
          const allPools: Pool[] = [];
          for (const entry of openEntries) {
            entry.closed = true;
            allPools.push(...entry.pools);
          }
          let releaseFailure: unknown;
          try {
            await endPoolsSafely(allPools);
          } finally {
            const settled = await Promise.allSettled(openEntries.map(entry => entry.lease.release()));
            const failed = settled.find((item): item is PromiseRejectedResult => item.status === "rejected");
            if (failed) releaseFailure = failed.reason;
          }
          if (releaseFailure !== undefined) throw releaseFailure;
        })();
        return closePromise;
      },
    };
  }
  const container = await runPostgresContainer({ name: `account-mutations-tpl-${profile}-${label}-${process.pid}`, password: "synthetic-conformance" });
  const bootstrap = new Pool({ connectionString: container.connectionString });
  const activeClones = new Set<{ dbName: string; pools: Pool[]; closed: boolean }>();
  let templateClosed = false;
  let closePromise: Promise<void> | undefined;
  try {
    if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("account_mutations_postgres_unavailable");
    const password = randomUUID();
    const { installation, dbOwner, runtimeLogin } = await provisionAccountMutationsRoles(bootstrap, container.connectionString, profile, password, "template_migrated");
    const templateConn = container.connectionStringFor("template_migrated");
    const migrationLogin = installation.generation === "legacy" ? "postgres" : installation.migrationLogin;
    const templateMigrationUrl = loginUrlFor(templateConn, migrationLogin, password);
    const templateMigrator = new Pool({ connectionString: templateMigrationUrl, options: migrationStartupOptions(installation) });
    let inventory = "";
    try {
      await createInventoryRunner(templateMigrationUrl, templateMigrator, installation, sha256 => { inventory = sha256; }, root).apply();
    } finally {
      await endPoolsSafely([templateMigrator]);
    }
    await bootstrap.query("ALTER DATABASE template_migrated IS_TEMPLATE = true");
    await bootstrap.query("ALTER DATABASE template_migrated ALLOW_CONNECTIONS = false");
    const baselineRoleDigest = await readClusterRoleDigest(bootstrap);
    let sequence = 0;
    let ddlChain: Promise<unknown> = Promise.resolve();
    const enqueueDdl = <T>(work: () => Promise<T>): Promise<T> => {
      const next = ddlChain.then(work, work);
      ddlChain = next.then(() => undefined, () => undefined);
      return next;
    };
    return {
      installation,
      get inventory() { return inventory; },
      clone(cloneLabel?: string): Promise<AccountMutationsStore> {
        return enqueueDdl(async (): Promise<AccountMutationsStore> => {
          if (templateClosed) throw new Error("account_mutations_template_closed");
          const dbName = `account_${++sequence}${sanitizeCloneSuffix(cloneLabel)}`;
          await bootstrap.query(`CREATE DATABASE "${dbName}" TEMPLATE template_migrated OWNER ${dbOwner}`);
          const cloneConn = container.connectionStringFor(dbName);
          const clonePools: Pool[] = [];
          const openPool = (url: string, options?: string) => {
            const value = new Pool({ connectionString: url, options });
            clonePools.push(value);
            return value;
          };
          const owner = openPool(cloneConn);
          const cloneMigrationUrl = loginUrlFor(cloneConn, migrationLogin, password);
          const migrator = openPool(cloneMigrationUrl, migrationStartupOptions(installation));
          const runtime = profile === "legacy" ? owner : openPool(loginUrlFor(cloneConn, runtimeLogin, password));
          let cloneInventory = inventory;
          const runner = createInventoryRunner(cloneMigrationUrl, migrator, installation, sha256 => { cloneInventory = sha256; }, upgradeRoot);
          const record = { dbName, pools: clonePools, closed: false };
          activeClones.add(record);
          return {
            owner,
            migrator,
            installation,
            runtime,
            runner,
            get inventory() { return cloneInventory; },
            close: async () => {
              if (record.closed) return;
              record.closed = true;
              activeClones.delete(record);
              try {
                await endPoolsSafely(record.pools);
              } finally {
                await enqueueDdl(async () => {
                  if (!templateClosed && !bootstrap.ended) {
                    await bootstrap.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
                  }
                });
              }
            },
          };
        });
      },
      close: () => {
        if (closePromise) return closePromise;
        templateClosed = true;
        closePromise = (async () => {
          await ddlChain;
          const remainingPools: Pool[] = [bootstrap];
          let roleMismatchError: Error | undefined;
          try {
            const openClones = [...activeClones];
            activeClones.clear();
            for (const entry of openClones) {
              entry.closed = true;
              for (const value of entry.pools) {
                value.on("error", () => {});
                remainingPools.push(value);
              }
            }
            const finalRoleDigest = await readClusterRoleDigest(bootstrap);
            if (finalRoleDigest !== baselineRoleDigest) {
              roleMismatchError = new Error("account_mutations_template_cluster_role_mutation_leaked");
            }
          } finally {
            await closePostgres(container, [...new Set(remainingPools)]);
          }
          if (roleMismatchError) throw roleMismatchError;
        })();
        return closePromise;
      },
    };
  } catch (error) {
    await closePostgres(container, [bootstrap]);
    throw error;
  }
}
