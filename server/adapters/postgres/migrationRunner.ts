// Public-platform MigrationRunnerPort for the experimental node-postgres bundle.
// The manifest and its exact SQL bytes are validated before a pool is created.
// Applied rows are an exact prefix of that catalog; path, digest or position
// drift is fatal. The private bridge, legacy bootstrap and Supabase history are
// neither selected nor reachable through production defaults.

import type { Pool, PoolClient } from "pg";
import type { MigrationRunnerPort } from "../../../src/domains/platform-runtime/ports.js";
import {
  evaluatePlatformMigrationManifest,
  readPlatformMigrationManifest,
  readPlatformMigrations,
  type AddedMigration,
  type PlatformMigrationManifest,
} from "../../../scripts/platform-migration-manifest.js";
import { readSelectedCatalogProjection, selectedCatalogProjectionPayload } from "./selectedCatalogProjection.js";

export interface PostgresMigrationRunnerEnv {
  connectionString: string;
}

export interface PostgresMigrationRunnerOptions {
  /** Test-only repository root; production is fixed to process.cwd(). */
  root?: string;
  poolFactory?: (env: PostgresMigrationRunnerEnv) => Pool | Promise<Pool>;
  /** Test-only catalog projector seam; production always uses selected-catalog-v2. */
  catalogProjectionPayload?: (client: PoolClient) => Promise<string>;
}

const LEDGER = "public.platform_schema_migrations";
type PlannedMigration = Readonly<{ catalogPath: string; sha256: string; position: number; sql: string }>;
type LoadedPlan = Readonly<{
  manifest: PlatformMigrationManifest;
  migrations: readonly AddedMigration[];
  units: readonly PlannedMigration[];
}>;
type LedgerRow = { catalog_path: unknown; sha256: unknown; position: unknown };
type LedgerExistenceRow = { ledger_exists: unknown };
type AdvisoryUnlockRow = { unlocked: unknown };
const MIGRATION_LOCK_NAME = "openlup:public-platform-migrations:v1";
const ACQUIRE_MIGRATION_LOCK = "SELECT pg_advisory_lock(hashtextextended($1, 0))";
const RELEASE_MIGRATION_LOCK = "SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked";

export function createPostgresMigrationRunner(
  env: PostgresMigrationRunnerEnv,
  options: PostgresMigrationRunnerOptions = {},
): MigrationRunnerPort {
  const root = options.root ?? process.cwd();
  let pool: Pool | null = null;

  async function getPool(): Promise<Pool> {
    if (pool) return pool;
    const factory = options.poolFactory ?? defaultPoolFactory;
    pool = await factory(env);
    return pool;
  }

  return {
    async status(): Promise<{ pending: string[]; applied: string[] }> {
      assertConnectionString(env);
      const plan = loadPlan(root);
      return withMigrationSession(await getPool(), async (client) => {
        const applied = await readAppliedPrefix(client, plan.units);
        if (applied.length === plan.units.length) await assertObjectInventory(client, plan, options);
        return {
          pending: plan.units.slice(applied.length).map((unit) => unit.catalogPath),
          applied: applied.map((unit) => unit.catalogPath),
        };
      });
    },

    async apply(opts?: { dryRun?: boolean }): Promise<{ applied: string[] }> {
      assertConnectionString(env);
      const plan = loadPlan(root);
      return withMigrationSession(await getPool(), async (client) => {
        const already = await readAppliedPrefix(client, plan.units);
        const pending = plan.units.slice(already.length);
        if (opts?.dryRun) {
          if (pending.length === 0) await assertObjectInventory(client, plan, options);
          return { applied: pending.map((unit) => unit.catalogPath) };
        }
        const appliedNow: string[] = [];
        for (const unit of pending) {
          await client.query("BEGIN");
          try {
            await client.query(unit.sql);
            await client.query(
              `INSERT INTO ${LEDGER} (catalog_path, sha256, position) VALUES ($1, $2, $3)`,
              [unit.catalogPath, unit.sha256, unit.position],
            );
            await client.query("COMMIT");
            appliedNow.push(unit.catalogPath);
          } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            throw new Error(`platform migration ${unit.catalogPath} failed: ${errorMessage(error)}`);
          }
        }
        const complete = await readAppliedPrefix(client, plan.units);
        if (complete.length !== plan.units.length) throw new Error("platform migration ledger is incomplete after apply");
        await assertObjectInventory(client, plan, options);
        return { applied: appliedNow };
      });
    },
  };
}

async function withMigrationSession<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let locked = false;
  let failed = false;
  let operationFailure: unknown;
  let result!: T;
  try {
    await client.query(ACQUIRE_MIGRATION_LOCK, [MIGRATION_LOCK_NAME]);
    locked = true;
    result = await operation(client);
  } catch (error) {
    failed = true;
    operationFailure = error;
  }

  let unlockFailure: unknown;
  if (locked) {
    try {
      const unlocked = await client.query<AdvisoryUnlockRow>(RELEASE_MIGRATION_LOCK, [MIGRATION_LOCK_NAME]);
      if (unlocked.rows[0]?.unlocked !== true) throw new Error("PostgreSQL did not release the advisory lock");
    } catch (error) {
      unlockFailure = error;
    }
  }
  client.release(unlockFailure !== undefined || (failed && !locked));

  if (failed) {
    if (unlockFailure !== undefined) {
      throw new Error(
        `platform migration operation failed: ${errorMessage(operationFailure)}; advisory lock release failed: ${errorMessage(unlockFailure)}`,
      );
    }
    throw operationFailure;
  }
  if (unlockFailure !== undefined) {
    throw new Error(`platform migration advisory lock release failed: ${errorMessage(unlockFailure)}`);
  }
  return result;
}

function assertConnectionString(env: PostgresMigrationRunnerEnv): void {
  if (env.connectionString.trim() === "") {
    throw new Error("DATABASE_URL is required for node-postgres migrations");
  }
}

function loadPlan(root: string): LoadedPlan {
  const catalog = readPlatformMigrations(root);
  const rawManifest = readPlatformMigrationManifest(root);
  const errors = [...catalog.errors];
  if (rawManifest === null) errors.push("platform migration manifest is missing");
  else errors.push(...evaluatePlatformMigrationManifest({ manifest: rawManifest, migrations: catalog.migrations }));
  if (errors.length > 0) throw new Error(`platform migration catalog rejected: ${errors.join("; ")}`);

  const manifest = rawManifest as PlatformMigrationManifest;
  const byPath = new Map(catalog.migrations.map((migration) => [migration.file, migration.content]));
  const entries = [manifest.baseline, ...manifest.forward];
  const units = entries.map((entry, position) => Object.freeze({
    catalogPath: entry.file,
    sha256: entry.sha256,
    position,
    sql: byPath.get(entry.file)!,
  }));
  return Object.freeze({ manifest, migrations: catalog.migrations, units: Object.freeze(units) });
}

async function readAppliedPrefix(client: PoolClient, units: readonly PlannedMigration[]): Promise<readonly PlannedMigration[]> {
  const exists = await client.query<LedgerExistenceRow>(
    "SELECT to_regclass($1) IS NOT NULL AS ledger_exists",
    [LEDGER],
  );
  if (exists.rows[0]?.ledger_exists !== true) return [];
  const result = await client.query<LedgerRow>(
    `SELECT catalog_path, sha256, position FROM ${LEDGER} ORDER BY position`,
  );
  if (result.rows.length > units.length) throw new Error("platform migration ledger contains an extra row");
  for (let index = 0; index < result.rows.length; index += 1) {
    const row = result.rows[index]!;
    const unit = units[index]!;
    if (row.catalog_path !== unit.catalogPath || row.sha256 !== unit.sha256 || row.position !== unit.position) {
      throw new Error(`platform migration ledger is not the exact manifest prefix at position ${index}`);
    }
  }
  return units.slice(0, result.rows.length);
}

async function assertObjectInventory(
  client: PoolClient,
  plan: LoadedPlan,
  options: PostgresMigrationRunnerOptions,
): Promise<void> {
  const payload = options.catalogProjectionPayload
    ? await options.catalogProjectionPayload(client)
    : await canonicalCatalogProjectionPayload(client);
  const errors = evaluatePlatformMigrationManifest({
    manifest: plan.manifest,
    migrations: plan.migrations,
    objectInventoryPayload: payload,
  });
  if (errors.length > 0) throw new Error(`platform migration inventory rejected: ${errors.join("; ")}`);
}

// The serializer used to arrive through a runtime `import()` of a URL built from
// `import.meta.url`, which meant the shape of its exports could only be checked after
// the pool was already open. It now resolves at compile time, from this directory.
async function canonicalCatalogProjectionPayload(client: PoolClient): Promise<string> {
  return selectedCatalogProjectionPayload(await readSelectedCatalogProjection(client));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function defaultPoolFactory(env: PostgresMigrationRunnerEnv): Promise<Pool> {
  const pg = await import("pg");
  const PoolCtor = (pg.default?.Pool ?? pg.Pool) as typeof import("pg").Pool;
  return new PoolCtor({ connectionString: env.connectionString });
}

export function resolvePostgresMigrationRunnerEnv(
  env: Record<string, string | undefined>,
): PostgresMigrationRunnerEnv {
  return { connectionString: env.DATABASE_URL ?? "" };
}
