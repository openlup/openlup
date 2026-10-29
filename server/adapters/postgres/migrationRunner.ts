// Reference-application binding: this path keeps its importers while the implementation lives in
// @openlup/platform. It binds this application's migration lock name, its platform migration
// catalogue (scripts/platform-migration-manifest.ts) and its selected-catalog projection.

import type { PoolClient } from "pg";
import type { MigrationRunnerPort } from "@openlup/core/platform-runtime";
import {
  createPostgresMigrationRunner as createPlatformMigrationRunner,
  type PlatformMigrationSource,
  type PostgresMigrationRunnerEnv,
  type PostgresMigrationRunnerOptions as PlatformMigrationRunnerOptions,
} from "@openlup/platform/migrations";
import {
  evaluatePlatformMigrationManifest,
  evaluateSelectedPlatformMigrationManifest,
  readPlatformMigrationManifest,
  readPlatformMigrations,
  selectPlatformMigrationManifest,
  type PlatformMigrationGeneration,
  type PlatformMigrationManifest,
} from "../../../scripts/platform-migration-manifest.js";
import { readSelectedCatalogProjection, selectedCatalogProjectionPayload } from "./selectedCatalogProjection.js";
import { assertQualifiedPostgresSelection, assertQualifiedPostgresSession, qualifiedPostgresCatalogPayload,
  qualifiedPostgresStartupOptions, assertQualifiedAdminPostgresSelection, assertQualifiedAdminPostgresSession,
  qualifiedAdminPostgresCatalogPayload, qualifiedAdminPostgresStartupOptions,
  type QualifiedPostgresInstallation, type QualifiedAdminPostgresInstallation } from "./qualifiedInstall.js";

export { resolvePostgresMigrationRunnerEnv, type PostgresMigrationRunnerEnv } from "@openlup/platform/migrations";

const MIGRATION_LOCK_NAME = "openlup:public-platform-migrations:v1";

type Installation = { generation: "legacy" } | QualifiedPostgresInstallation | QualifiedAdminPostgresInstallation;

function platformMigrationSource(installation: Installation): PlatformMigrationSource {
  const generation: PlatformMigrationGeneration = installation.generation;
  const read = (root: string) => {
    const catalog = readPlatformMigrations(root);
    const raw = readPlatformMigrationManifest(root);
    const errors = [...catalog.errors, ...(raw === null ? ["platform migration manifest is missing"] : evaluatePlatformMigrationManifest({ manifest: raw, migrations: catalog.migrations }))];
    if (errors.length) return { migrations: [], errors, manifest: null };
    const manifest = selectPlatformMigrationManifest(raw as PlatformMigrationManifest, generation, installation.generation === "qualified-v2"
      ? { migrationIsBootstrap: installation.migrationLogin === installation.bootstrapLogin, hasRestore: installation.restoreLogin !== undefined }
      : installation.generation === "qualified-admin" ? { roleMode: installation.roleMode } : undefined);
    const selected = new Set([manifest.baseline.file, ...manifest.forward.map(({ file }) => file)]);
    return { migrations: catalog.migrations.filter(({ file }) => selected.has(file)), errors, manifest };
  };
  return {
    readMigrations: root => read(root),
    readManifest: root => read(root).manifest,
    evaluate: input => evaluateSelectedPlatformMigrationManifest(input, generation),
    assertSession: installation.generation === "qualified-v2"
      ? (client: PoolClient, applied: readonly { file: string; sha256: string; position: number }[]) => assertQualifiedPostgresSession(client, applied, installation, MIGRATION_LOCK_NAME)
      : installation.generation === "qualified-admin"
        ? (client: PoolClient, applied: readonly { file: string; sha256: string; position: number }[]) => assertQualifiedAdminPostgresSession(client, applied, installation, MIGRATION_LOCK_NAME)
        : undefined,
  };
}

export interface PostgresMigrationRunnerOptions {
  /** Test-only repository root; production is fixed to process.cwd(). */
  root?: string;
  poolFactory?: PlatformMigrationRunnerOptions["poolFactory"];
  /** Legacy is unchanged by default; qualified fresh installation is an explicit selection. */
  installation?: Installation;
  /** Test-only catalog projector seam; production uses the selected generation's canonical payload. */
  catalogProjectionPayload?: (client: PoolClient) => Promise<string>;
}

async function canonicalCatalogProjectionPayload(client: PoolClient): Promise<string> {
  return selectedCatalogProjectionPayload(await readSelectedCatalogProjection(client));
}

export function createPostgresMigrationRunner(
  env: PostgresMigrationRunnerEnv,
  options: PostgresMigrationRunnerOptions = {},
): MigrationRunnerPort {
  const installation: Installation = options.installation === undefined ? { generation: "legacy" } : options.installation;
  if (!installation || typeof installation !== "object" || Array.isArray(installation)) throw new Error("invalid platform migration generation selection");
  if (installation.generation !== "legacy" && installation.generation !== "qualified-v2" && installation.generation !== "qualified-admin") throw new Error("unknown platform migration generation");
  if (installation.generation === "legacy" && Object.keys(installation).some(key => key !== "generation")) throw new Error("legacy migrations refuse qualified installation fields");
  if (installation.generation === "qualified-v2") assertQualifiedPostgresSelection(installation);
  if (installation.generation === "qualified-admin") assertQualifiedAdminPostgresSelection(installation);
  return createPlatformMigrationRunner(env, {
    lockName: MIGRATION_LOCK_NAME,
    source: platformMigrationSource(installation),
    catalogProjectionPayload: options.catalogProjectionPayload ?? (installation.generation === "legacy"
      ? canonicalCatalogProjectionPayload : installation.generation === "qualified-v2"
        ? client => qualifiedPostgresCatalogPayload(client, installation, MIGRATION_LOCK_NAME)
        : client => qualifiedAdminPostgresCatalogPayload(client, installation, MIGRATION_LOCK_NAME)),
    root: options.root,
    poolFactory: options.poolFactory ?? (installation.generation !== "legacy" ? async binding => {
      let url: URL;
      try { url = new URL(binding.connectionString); } catch { throw new Error("qualified migrations require a PostgreSQL connection URL"); }
      if (!["postgres:", "postgresql:"].includes(url.protocol) || url.searchParams.has("options")) throw new Error("qualified migrations refuse arbitrary connection startup options");
      url.searchParams.set("options", installation.generation === "qualified-v2"
        ? qualifiedPostgresStartupOptions(installation) : qualifiedAdminPostgresStartupOptions(installation));
      const pg = await import("pg");
      const PoolCtor = pg.default?.Pool ?? pg.Pool;
      return new PoolCtor({ connectionString: url.toString() });
    } : undefined),
  });
}
