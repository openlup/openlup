import type { PoolClient } from "pg";
import type { MigrationRunnerPort } from "@openlup/core/platform-runtime";
import {
  createBoundPostgresMigrationRunner,
  type PlatformMigrationSource,
  type PostgresMigrationRunnerEnv,
  type PostgresMigrationRunnerOptions as PlatformMigrationRunnerOptions,
} from "./postgresRunner.js";
import {
  evaluatePlatformMigrationManifest,
  evaluateSelectedPlatformMigrationManifest,
  selectPlatformMigrationManifest,
  type PlatformMigrationGeneration,
  type PlatformMigrationManifest,
} from "./catalog.js";
import { readSelectedCatalogProjection, selectedCatalogProjectionPayload } from "./selectedCatalogProjection.js";
import { assertQualifiedPostgresSelection, assertQualifiedPostgresSession, qualifiedPostgresCatalogPayload,
  qualifiedPostgresStartupOptions, assertQualifiedAdminPostgresSelection, assertQualifiedAdminPostgresSession,
  qualifiedAdminPostgresCatalogPayload, qualifiedAdminPostgresStartupOptions, assertQualifiedCheckoutOwnerState,
  type QualifiedPostgresInstallation, type QualifiedAdminPostgresInstallation } from "./qualifiedInstall.js";
import { readPackagedPlatformCatalog } from "./packagedCatalog.js";
import { attachPgErrorListener } from "./pgErrorListener.js";

const MIGRATION_LOCK_NAME = "openlup:public-platform-migrations:v1";

export type PlatformPostgresInstallation = { generation: "legacy" } | QualifiedPostgresInstallation | QualifiedAdminPostgresInstallation;

function platformMigrationSource(
  installation: PlatformPostgresInstallation,
  reader?: Pick<PlatformMigrationSource, "readMigrations" | "readManifest">,
): PlatformMigrationSource {
  const generation: PlatformMigrationGeneration = installation.generation;
  let pendingRead: { root: string; manifest: PlatformMigrationManifest | null } | null = null;
  const read = (root: string) => {
    const loaded = reader
      ? { ...reader.readMigrations(root), manifest: reader.readManifest(root) }
      : readPackagedPlatformCatalog();
    const errors = [...loaded.errors, ...(loaded.manifest === null ? ["platform migration manifest is missing"] : evaluatePlatformMigrationManifest({ manifest: loaded.manifest, migrations: loaded.migrations }))];
    if (errors.length) return { migrations: [], errors, manifest: null };
    const manifest = selectPlatformMigrationManifest(loaded.manifest as PlatformMigrationManifest, generation, installation.generation === "qualified-v2"
      ? { migrationIsBootstrap: installation.migrationLogin === installation.bootstrapLogin, hasRestore: installation.restoreLogin !== undefined }
      : installation.generation === "qualified-admin" ? { roleMode: installation.roleMode } : undefined);
    const selected = new Set([manifest.baseline.file, ...manifest.forward.map(({ file }) => file)]);
    return { migrations: loaded.migrations.filter(({ file }) => selected.has(file)), errors, manifest };
  };
  return {
    readMigrations: root => {
      pendingRead = null;
      const loaded = read(root);
      pendingRead = { root, manifest: loaded.manifest };
      return { migrations: loaded.migrations, errors: loaded.errors };
    },
    readManifest: root => {
      if (pendingRead && pendingRead.root === root) {
        const { manifest } = pendingRead;
        pendingRead = null;
        return manifest;
      }
      pendingRead = null;
      return read(root).manifest;
    },
    evaluate: input => evaluateSelectedPlatformMigrationManifest(input, generation),
    assertSession: installation.generation === "qualified-v2"
      ? (client: PoolClient, applied: readonly { file: string; sha256: string; position: number }[]) => assertQualifiedPostgresSession(client, applied, installation, MIGRATION_LOCK_NAME)
      : installation.generation === "qualified-admin"
        ? (client: PoolClient, applied: readonly { file: string; sha256: string; position: number }[]) => assertQualifiedAdminPostgresSession(client, applied, installation, MIGRATION_LOCK_NAME)
        : undefined,
  };
}

export interface PlatformPostgresMigrationRunnerOptions {
  /** Defaults to the complete catalogue shipped in this package. */
  catalog?: Pick<PlatformMigrationSource, "readMigrations" | "readManifest">;
  /** Root passed to an explicitly supplied catalogue reader; packaged SQL is module-relative. */
  root?: string;
  poolFactory?: PlatformMigrationRunnerOptions["poolFactory"];
  /** Optional sink for idle pg.Pool `'error'` events; defaults to a non-throwing stderr logger. */
  onPoolError?: PlatformMigrationRunnerOptions["onPoolError"];
  /** Explicit history selection; installed histories cannot be switched in place. */
  installation: PlatformPostgresInstallation;
  /** Test-only catalog projector seam; production uses the selected generation's canonical payload. */
  catalogProjectionPayload?: (client: PoolClient) => Promise<string>;
}

async function canonicalCatalogProjectionPayload(client: PoolClient): Promise<string> {
  return selectedCatalogProjectionPayload(await readSelectedCatalogProjection(client));
}

export function createPlatformPostgresMigrationRunner(
  env: PostgresMigrationRunnerEnv,
  options: PlatformPostgresMigrationRunnerOptions,
): MigrationRunnerPort {
  const { status, apply } = configuredPlatformMigrationRunner(env, options);
  return { status, apply };
}

/**
 * @experimental Verify and apply the recorded checkout-owner grant in the installed catalogue.
 * The host excludes role and local DDL or ACL administration for the operation.
 */
export function applyPlatformCheckoutOwnerGrant(
  env: PostgresMigrationRunnerEnv,
  installation: QualifiedPostgresInstallation | QualifiedAdminPostgresInstallation,
): Promise<{ state: "granted" }> {
  return configuredPlatformMigrationRunner(env, { installation }).applyCheckoutOwnerGrant();
}

function configuredPlatformMigrationRunner(env: PostgresMigrationRunnerEnv, options: PlatformPostgresMigrationRunnerOptions) {
  const installation = options?.installation;
  if (installation === undefined) throw new Error("platform migration installation is required");
  if (!installation || typeof installation !== "object" || Array.isArray(installation)) throw new Error("invalid platform migration generation selection");
  if (installation.generation !== "legacy" && installation.generation !== "qualified-v2" && installation.generation !== "qualified-admin") throw new Error("unknown platform migration generation");
  if (installation.generation === "legacy" && Object.keys(installation).some(key => key !== "generation")) throw new Error("legacy migrations refuse qualified installation fields");
  if (installation.generation === "qualified-v2") assertQualifiedPostgresSelection(installation);
  if (installation.generation === "qualified-admin") assertQualifiedAdminPostgresSelection(installation);
  return createBoundPostgresMigrationRunner(env, {
    lockName: MIGRATION_LOCK_NAME,
    source: platformMigrationSource(installation, options.catalog),
    catalogProjectionPayload: options.catalogProjectionPayload ?? (installation.generation === "legacy"
      ? canonicalCatalogProjectionPayload : installation.generation === "qualified-v2"
        ? client => qualifiedPostgresCatalogPayload(client, installation, MIGRATION_LOCK_NAME)
        : client => qualifiedAdminPostgresCatalogPayload(client, installation, MIGRATION_LOCK_NAME)),
    root: options.root,
    onPoolError: options.onPoolError,
    poolFactory: options.poolFactory ?? (installation.generation !== "legacy" ? async binding => {
      let url: URL;
      try { url = new URL(binding.connectionString); } catch { throw new Error("qualified migrations require a PostgreSQL connection URL"); }
      if (!["postgres:", "postgresql:"].includes(url.protocol) || url.searchParams.has("options")) throw new Error("qualified migrations refuse arbitrary connection startup options");
      url.searchParams.set("options", installation.generation === "qualified-v2"
        ? qualifiedPostgresStartupOptions(installation) : qualifiedAdminPostgresStartupOptions(installation));
      const pg = await import("pg");
      const PoolCtor = pg.default?.Pool ?? pg.Pool;
      return attachPgErrorListener(new PoolCtor({ connectionString: url.toString() }), "platform-migration-runner", options.onPoolError);
    } : undefined),
  }, installation.generation === "legacy" ? undefined : (client, applied, requirement) =>
    assertQualifiedCheckoutOwnerState(client, applied, installation, MIGRATION_LOCK_NAME, requirement));
}
