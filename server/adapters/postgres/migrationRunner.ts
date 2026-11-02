// Keep the reference application's repository catalogue and default generation unchanged.
import { createPlatformPostgresMigrationRunner, type PlatformPostgresMigrationRunnerOptions,
  type PostgresMigrationRunnerEnv } from "@openlup/platform/migrations";
import { readPlatformMigrationManifest, readPlatformMigrations } from "../../../scripts/platform-migration-manifest.js";
export { resolvePostgresMigrationRunnerEnv, type PostgresMigrationRunnerEnv } from "@openlup/platform/migrations";
export type PostgresMigrationRunnerOptions = Omit<PlatformPostgresMigrationRunnerOptions, "catalog" | "installation"> & { installation?: PlatformPostgresMigrationRunnerOptions["installation"] };
export function createPostgresMigrationRunner(env: PostgresMigrationRunnerEnv, options: PostgresMigrationRunnerOptions = {}) {
  // Preserve inherited options, null refusal and the original order of guarded reads.
  return createPlatformPostgresMigrationRunner(env, {
    get installation() { return options.installation === undefined ? { generation: "legacy" as const } : options.installation; },
    get catalogProjectionPayload() { return options.catalogProjectionPayload; },
    get root() { return options.root; },
    get poolFactory() { return options.poolFactory; },
    catalog: { readMigrations: readPlatformMigrations, readManifest: readPlatformMigrationManifest } });
}
