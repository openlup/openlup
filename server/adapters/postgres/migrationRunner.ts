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
  readPlatformMigrationManifest,
  readPlatformMigrations,
} from "../../../scripts/platform-migration-manifest.js";
import { readSelectedCatalogProjection, selectedCatalogProjectionPayload } from "./selectedCatalogProjection.js";

export { resolvePostgresMigrationRunnerEnv, type PostgresMigrationRunnerEnv } from "@openlup/platform/migrations";

const MIGRATION_LOCK_NAME = "openlup:public-platform-migrations:v1";

const PLATFORM_MIGRATION_SOURCE: PlatformMigrationSource = {
  readMigrations: readPlatformMigrations,
  readManifest: readPlatformMigrationManifest,
  evaluate: evaluatePlatformMigrationManifest,
};

export interface PostgresMigrationRunnerOptions {
  /** Test-only repository root; production is fixed to process.cwd(). */
  root?: string;
  poolFactory?: PlatformMigrationRunnerOptions["poolFactory"];
  /** Test-only catalog projector seam; production always uses selected-catalog-v2. */
  catalogProjectionPayload?: (client: PoolClient) => Promise<string>;
}

async function canonicalCatalogProjectionPayload(client: PoolClient): Promise<string> {
  return selectedCatalogProjectionPayload(await readSelectedCatalogProjection(client));
}

export function createPostgresMigrationRunner(
  env: PostgresMigrationRunnerEnv,
  options: PostgresMigrationRunnerOptions = {},
): MigrationRunnerPort {
  return createPlatformMigrationRunner(env, {
    lockName: MIGRATION_LOCK_NAME,
    source: PLATFORM_MIGRATION_SOURCE,
    catalogProjectionPayload: options.catalogProjectionPayload ?? canonicalCatalogProjectionPayload,
    root: options.root,
    poolFactory: options.poolFactory,
  });
}
