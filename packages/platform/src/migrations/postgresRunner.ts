// Public-platform MigrationRunnerPort for the experimental node-postgres bundle.
// The manifest and its exact SQL bytes are validated before a pool is created.
// Applied rows are an exact prefix of that catalog; path, digest or position
// drift is fatal. Only the caller's catalogue is applied; no other migration
// history is selected or reachable through a default.

import type { Pool, PoolClient } from "pg";
import type { MigrationRunnerPort } from "@openlup/core/platform-runtime";

export interface PostgresMigrationRunnerEnv {
  connectionString: string;
}

/** One migration file of the deployment's platform catalogue. */
export type PlatformMigrationFile = { file: string; content: string };
export type PlatformMigrationManifestEntry = { file: string; sha256: string };
/** The validated manifest: a baseline, its ordered forwards and the expected object inventory. */
export type PlatformMigrationManifest = {
  schemaVersion: 1;
  baseline: PlatformMigrationManifestEntry;
  forward: PlatformMigrationManifestEntry[];
  objectInventorySha256: string;
};

/**
 * The deployment's migration catalogue and its validator. `evaluate` returns every refusal for a
 * manifest against the catalogue files and, when given, the live object-inventory payload.
 */
export interface PlatformMigrationSource {
  readMigrations(root: string): { migrations: PlatformMigrationFile[]; errors: string[] };
  readManifest(root: string): unknown | null;
  evaluate(input: {
    manifest: unknown;
    migrations: readonly PlatformMigrationFile[];
    objectInventoryPayload?: string;
  }): string[];
  /**
   * Optional trusted-source observation/refusal after exact-prefix validation, under the
   * migration session lock. Runs once per operation before any pending SQL or dry-run result.
   * The canonical source uses read-only observations; the callback shares the caller's existing
   * database capability and is not a sandbox or a provisioning/per-unit execution hook.
   */
  assertSession?(client: PoolClient, applied: readonly (PlatformMigrationManifestEntry & { position: number })[]): Promise<void>;
}

export interface PostgresMigrationRunnerOptions {
  /** Name of the PostgreSQL advisory lock that serializes migration sessions. */
  lockName: string;
  /** The deployment's migration catalogue. */
  source: PlatformMigrationSource;
  /** Serializes the live object inventory that the manifest's `objectInventorySha256` pins. */
  catalogProjectionPayload: (client: PoolClient) => Promise<string>;
  /** Catalogue root; defaults to process.cwd(). */
  root?: string;
  poolFactory?: (env: PostgresMigrationRunnerEnv) => Pool | Promise<Pool>;
}

const LEDGER = "public.platform_schema_migrations";
type PlannedMigration = Readonly<{ catalogPath: string; sha256: string; position: number; sql: string }>;
type LoadedPlan = Readonly<{
  manifest: PlatformMigrationManifest;
  migrations: readonly PlatformMigrationFile[];
  units: readonly PlannedMigration[];
}>;
type LedgerRow = { catalog_path: unknown; sha256: unknown; position: unknown };
type LedgerIdentityRow = { ledger_oid: unknown; ledger_safe: unknown };
type AppliedLedger = { oid: string | null; applied: readonly PlannedMigration[] };
type AdvisoryUnlockRow = { unlocked: unknown };
const ACQUIRE_CATALOG_BOUND_MIGRATION_LOCK = "SELECT pg_catalog.pg_advisory_lock(pg_catalog.hashtextextended($1::pg_catalog.text, 0::pg_catalog.int8))";
const RELEASE_CATALOG_BOUND_MIGRATION_LOCK = "SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtextextended($1::pg_catalog.text, 0::pg_catalog.int8)) AS unlocked";
// The expected catalog projection is pinned to the ledger CREATE TABLE in
// db/platform/migrations/00000000000000_platform_baseline.sql. The raw catalog
// expression trees keep operator, function, type and constant identities; only
// source locations and a signed varlena header byte are normalized. PostgreSQL
// 16 and 17 produce this same shape on both amd64 and arm64.
const EXPECTED_LEDGER_CATALOG_SHAPE = {
  "relation": ["r","p",false,"0",false,false,false,false,true,3,"d",false,false,"heap",null],
  "columns": [[1,"catalog_path","25",-1,"100",true,"","",false,false,0,false,"x","",null,null],[2,"sha256","25",-1,"100",true,"","",false,false,0,false,"x","",null,null],[3,"position","23",-1,"0",true,"","",false,false,0,false,"p","",null,null],[4,"executed_at","1184",-1,"0",true,"","",true,false,0,false,"p","",null,null]],
  "defaults": [[4,"{FUNCEXPR :funcid 2648 :funcresulttype 1184 :funcretset false :funcvariadic false :funcformat 0 :funccollid 0 :inputcollid 0 :args <> :location ?}"]],
  "constraints": [["platform_schema_migrations_catalog_path_check","c",false,false,true,false,true,0,[1],"{OPEXPR :opno 641 :opfuncid 1254 :opresulttype 16 :opretset false :opcollid 0 :inputcollid 100 :args ({VAR :varno 1 :varattno 1 :vartype 25 :vartypmod -1 :varcollid 100 :varnullingrels (b) :varlevelsup 0 :varnosyn 1 :varattnosyn 1 :location ?} {CONST :consttype 25 :consttypmod -1 :constcollid 100 :constlen -1 :constbyval false :constisnull false :location ? :constvalue 59 [ 236 0 0 0 94 100 98 47 112 108 97 116 102 111 114 109 47 109 105 103 114 97 116 105 111 110 115 47 91 65 45 90 97 45 122 48 45 57 93 91 65 45 90 97 45 122 48 45 57 95 45 93 42 92 46 115 113 108 36 ]}) :location ?}",null],["platform_schema_migrations_pkey","p",false,false,true,true,true,0,[1],null,"platform_schema_migrations_pkey"],["platform_schema_migrations_position_check","c",false,false,true,false,true,0,[3],"{OPEXPR :opno 525 :opfuncid 150 :opresulttype 16 :opretset false :opcollid 0 :inputcollid 0 :args ({VAR :varno 1 :varattno 3 :vartype 23 :vartypmod -1 :varcollid 0 :varnullingrels (b) :varlevelsup 0 :varnosyn 1 :varattnosyn 3 :location ?} {CONST :consttype 23 :consttypmod -1 :constcollid 0 :constlen 4 :constbyval true :constisnull false :location ? :constvalue 4 [ 0 0 0 0 0 0 0 0 ]}) :location ?}",null],["platform_schema_migrations_position_key","u",false,false,true,true,true,0,[3],null,"platform_schema_migrations_position_key"],["platform_schema_migrations_sha256_check","c",false,false,true,false,true,0,[2],"{OPEXPR :opno 641 :opfuncid 1254 :opresulttype 16 :opretset false :opcollid 0 :inputcollid 100 :args ({VAR :varno 1 :varattno 2 :vartype 25 :vartypmod -1 :varcollid 100 :varnullingrels (b) :varlevelsup 0 :varnosyn 1 :varattnosyn 2 :location ?} {CONST :consttype 25 :consttypmod -1 :constcollid 100 :constlen -1 :constbyval false :constisnull false :location ? :constvalue 18 [ 72 0 0 0 94 91 48 45 57 97 45 102 93 123 54 52 125 36 ]}) :location ?}",null]],
  "indexes": [["platform_schema_migrations_pkey","i","p","btree",null,true,true,false,true,false,true,false,true,true,false,false,1,1,"1","3126","100","0",null,null],["platform_schema_migrations_position_key","i","p","btree",null,true,false,false,true,false,true,false,true,true,false,false,1,1,"3","1978","0","0",null,null]],
  "counts": [0,0,0,0,0,0],
};
const expectedLedgerShapeJson = JSON.stringify(EXPECTED_LEDGER_CATALOG_SHAPE).replaceAll("'", "''");
// All observations use system catalogs and built-in functions/operators before
// the named relation is locked or read. The second observation runs after lock.
const LEDGER_IDENTITY = `SELECT c.oid::pg_catalog.text AS ledger_oid,
  ((owner.rolsuper OR owner.rolname OPERATOR(pg_catalog.=) current_user)
    AND pg_catalog.jsonb_build_object(
      'relation', pg_catalog.jsonb_build_array(c.relkind, c.relpersistence, c.relispartition,
        c.reloftype, c.relrowsecurity, c.relforcerowsecurity, c.relhasrules,
        c.relhastriggers, c.relhasindex, c.relchecks, c.relreplident,
        c.relhassubclass, c.relisshared, am.amname, c.reloptions),
      'columns', (SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
        a.attnum, a.attname, a.atttypid, a.atttypmod, a.attcollation, a.attnotnull,
        a.attgenerated, a.attidentity, a.atthasdef, a.attisdropped, a.attinhcount,
        a.atthasmissing, a.attstorage, a.attcompression, a.attoptions, a.attfdwoptions)
        ORDER BY a.attnum), '[]'::pg_catalog.jsonb)
        FROM pg_catalog.pg_attribute a WHERE a.attrelid OPERATOR(pg_catalog.=) c.oid
          AND a.attnum OPERATOR(pg_catalog.>) 0::pg_catalog.int2),
      'defaults', (SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
        d.adnum, pg_catalog.regexp_replace(d.adbin::pg_catalog.text,
          ':location -?[0-9]+'::pg_catalog.text, ':location ?'::pg_catalog.text, 'g'::pg_catalog.text))
        ORDER BY d.adnum), '[]'::pg_catalog.jsonb)
        FROM pg_catalog.pg_attrdef d WHERE d.adrelid OPERATOR(pg_catalog.=) c.oid),
      'constraints', (SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
        co.conname, co.contype, co.condeferrable, co.condeferred, co.convalidated,
        co.connoinherit, co.conislocal, co.coninhcount, co.conkey,
        CASE WHEN co.conbin IS NULL THEN NULL ELSE pg_catalog.replace(
          pg_catalog.regexp_replace(co.conbin::pg_catalog.text,
            ':location -?[0-9]+'::pg_catalog.text, ':location ?'::pg_catalog.text, 'g'::pg_catalog.text),
          ':constvalue 59 [ -20 0 0 0'::pg_catalog.text,
          ':constvalue 59 [ 236 0 0 0'::pg_catalog.text) END,
        ci.relname) ORDER BY co.conname), '[]'::pg_catalog.jsonb)
        FROM pg_catalog.pg_constraint co
        LEFT JOIN pg_catalog.pg_class ci ON ci.oid OPERATOR(pg_catalog.=) co.conindid
        WHERE co.conrelid OPERATOR(pg_catalog.=) c.oid),
      'indexes', (SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
        ic.relname, ic.relkind, ic.relpersistence, iam.amname, ic.reloptions,
        i.indisunique, i.indisprimary, i.indisexclusion, i.indimmediate,
        i.indisclustered, i.indisvalid, i.indcheckxmin, i.indisready, i.indislive,
        i.indisreplident, i.indnullsnotdistinct, i.indnatts, i.indnkeyatts,
        i.indkey::pg_catalog.text, i.indclass::pg_catalog.text,
        i.indcollation::pg_catalog.text, i.indoption::pg_catalog.text,
        i.indexprs::pg_catalog.text, i.indpred::pg_catalog.text)
        ORDER BY ic.relname), '[]'::pg_catalog.jsonb)
        FROM pg_catalog.pg_index i
        JOIN pg_catalog.pg_class ic ON ic.oid OPERATOR(pg_catalog.=) i.indexrelid
        LEFT JOIN pg_catalog.pg_am iam ON iam.oid OPERATOR(pg_catalog.=) ic.relam
        WHERE i.indrelid OPERATOR(pg_catalog.=) c.oid),
      'counts', pg_catalog.jsonb_build_array(
        (SELECT pg_catalog.count(*) FROM pg_catalog.pg_inherits h
          WHERE h.inhrelid OPERATOR(pg_catalog.=) c.oid),
        (SELECT pg_catalog.count(*) FROM pg_catalog.pg_inherits h
          WHERE h.inhparent OPERATOR(pg_catalog.=) c.oid),
        (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger t
          WHERE t.tgrelid OPERATOR(pg_catalog.=) c.oid),
        (SELECT pg_catalog.count(*) FROM pg_catalog.pg_rewrite r
          WHERE r.ev_class OPERATOR(pg_catalog.=) c.oid),
        (SELECT pg_catalog.count(*) FROM pg_catalog.pg_policy p
          WHERE p.polrelid OPERATOR(pg_catalog.=) c.oid),
        (SELECT pg_catalog.count(*) FROM pg_catalog.pg_statistic_ext s
          WHERE s.stxrelid OPERATOR(pg_catalog.=) c.oid)))
      OPERATOR(pg_catalog.=) '${expectedLedgerShapeJson}'::pg_catalog.jsonb) AS ledger_safe
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid OPERATOR(pg_catalog.=) c.relnamespace
  JOIN pg_catalog.pg_roles owner ON owner.oid OPERATOR(pg_catalog.=) c.relowner
  LEFT JOIN pg_catalog.pg_am am ON am.oid OPERATOR(pg_catalog.=) c.relam
  WHERE n.nspname OPERATOR(pg_catalog.=) 'public'::pg_catalog.name
    AND c.relname OPERATOR(pg_catalog.=) 'platform_schema_migrations'::pg_catalog.name`;

export function createPostgresMigrationRunner(
  env: PostgresMigrationRunnerEnv,
  options: PostgresMigrationRunnerOptions,
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
      const plan = loadPlan(root, options.source);
      return withMigrationSession(await getPool(), options.lockName, async (client) => {
        const assertSession = options.source.assertSession;
        const { applied } = await readAppliedPrefix(client, plan.units, assertSession ? async (applied) => {
          await assertSession(client, applied.map((unit) => ({ file: unit.catalogPath, sha256: unit.sha256, position: unit.position })));
        } : undefined);
        if (applied.length === plan.units.length) await assertObjectInventory(client, plan, options);
        return {
          pending: plan.units.slice(applied.length).map((unit) => unit.catalogPath),
          applied: applied.map((unit) => unit.catalogPath),
        };
      });
    },

    async apply(opts?: { dryRun?: boolean }): Promise<{ applied: string[] }> {
      assertConnectionString(env);
      const plan = loadPlan(root, options.source);
      return withMigrationSession(await getPool(), options.lockName, async (client) => {
        const assertSession = options.source.assertSession;
        const initial = await readAppliedPrefix(client, plan.units, assertSession ? async (applied) => {
          await assertSession(client, applied.map((unit) => ({ file: unit.catalogPath, sha256: unit.sha256, position: unit.position })));
        } : undefined);
        const pending = plan.units.slice(initial.applied.length);
        if (opts?.dryRun) {
          if (pending.length === 0) await assertObjectInventory(client, plan, options);
          return { applied: pending.map((unit) => unit.catalogPath) };
        }
        const appliedNow: string[] = [];
        let expectedOid = initial.oid;
        for (const unit of pending) {
          await client.query("BEGIN");
          try {
            if (expectedOid !== null) {
              // LOCK is the first statement: under stronger caller defaults,
              // the catalog snapshot must begin after any competing DDL settles.
              await client.query(`LOCK TABLE ONLY ${LEDGER} IN SHARE ROW EXCLUSIVE MODE`);
              const beforeSql = await readLockedPrefix(client, plan.units, "SHARE ROW EXCLUSIVE");
              if (beforeSql.oid !== expectedOid || beforeSql.applied.length !== unit.position) {
                throw new Error("platform migration ledger changed before write");
              }
            }
            await client.query(unit.sql);
            // The baseline creates its ledger; later units retain the lock
            // through this post-SQL recheck, insert and COMMIT.
            const beforeWrite = await readLockedPrefix(client, plan.units, "SHARE ROW EXCLUSIVE");
            if (beforeWrite.oid === null || (expectedOid !== null && beforeWrite.oid !== expectedOid)
              || beforeWrite.applied.length !== unit.position) {
              throw new Error("platform migration ledger changed before write");
            }
            expectedOid = beforeWrite.oid;
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
        await assertObjectInventory(client, plan, options);
        return { applied: appliedNow };
      });
    },
  };
}

async function withMigrationSession<T>(
  pool: Pool,
  lockName: string,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let locked = false;
  let failed = false;
  let operationFailure: unknown;
  let result!: T;
  try {
    await client.query(ACQUIRE_CATALOG_BOUND_MIGRATION_LOCK, [lockName]);
    locked = true;
    result = await operation(client);
  } catch (error) {
    failed = true;
    operationFailure = error;
  }

  let unlockFailure: unknown;
  if (locked) {
    try {
      const unlocked = await client.query<AdvisoryUnlockRow>(RELEASE_CATALOG_BOUND_MIGRATION_LOCK, [lockName]);
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

function loadPlan(root: string, source: PlatformMigrationSource): LoadedPlan {
  const catalog = source.readMigrations(root);
  const rawManifest = source.readManifest(root);
  const errors = [...catalog.errors];
  if (rawManifest === null) errors.push("platform migration manifest is missing");
  else errors.push(...source.evaluate({ manifest: rawManifest, migrations: catalog.migrations }));
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

async function readAppliedPrefix(
  client: PoolClient,
  units: readonly PlannedMigration[],
  whileLocked?: (applied: readonly PlannedMigration[]) => Promise<void>,
): Promise<AppliedLedger> {
  // A transaction-scoped relation lock prevents replacement after validation.
  // READ COMMITTED gives the post-lock identity check a fresh catalog snapshot.
  await client.query("BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY");
  try {
    const ledger = await readLockedPrefix(client, units, "ACCESS SHARE");
    if (ledger.oid === null && whileLocked) {
      // There is no relation to lock. End the initial absence observation, then
      // keep the qualified catalog callback on one stable read-only snapshot.
      await client.query("COMMIT");
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      if ((await client.query<LedgerIdentityRow>(LEDGER_IDENTITY)).rows.length !== 0) {
        throw new Error("platform migration ledger changed before read");
      }
    }
    await whileLocked?.(ledger.applied);
    await client.query("COMMIT");
    return ledger;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

async function readLockedPrefix(client: PoolClient, units: readonly PlannedMigration[], mode: "ACCESS SHARE" | "SHARE ROW EXCLUSIVE"): Promise<AppliedLedger> {
  const oid = await lockAdmittedLedger(client, mode);
  if (oid === null) return { oid: null, applied: [] };
  // ONLY excludes inherited or foreign children, which are not ledger storage.
  const result = await client.query<LedgerRow>(
    `SELECT catalog_path, sha256, position FROM ONLY ${LEDGER} ORDER BY position`,
  );
  if (result.rows.length > units.length) throw new Error("platform migration ledger contains an extra row");
  for (let index = 0; index < result.rows.length; index += 1) {
    const row = result.rows[index]!;
    const unit = units[index]!;
    if (row.catalog_path !== unit.catalogPath || row.sha256 !== unit.sha256 || row.position !== unit.position) {
      throw new Error(`platform migration ledger is not the exact manifest prefix at position ${index}`);
    }
  }
  return { oid, applied: units.slice(0, result.rows.length) };
}

async function lockAdmittedLedger(client: PoolClient, mode: "ACCESS SHARE" | "SHARE ROW EXCLUSIVE"): Promise<string | null> {
  const observed = (await client.query<LedgerIdentityRow>(LEDGER_IDENTITY)).rows;
  if (observed.length === 0) return null;
  const identity = observed[0]!;
  if (observed.length !== 1 || typeof identity.ledger_oid !== "string" || identity.ledger_safe !== true) {
    throw new Error("platform migration ledger relation is not safe to read");
  }
  await client.query(`LOCK TABLE ONLY ${LEDGER} IN ${mode} MODE`);
  const locked = (await client.query<LedgerIdentityRow>(LEDGER_IDENTITY)).rows;
  if (locked.length !== 1 || locked[0]!.ledger_oid !== identity.ledger_oid || locked[0]!.ledger_safe !== true) {
    throw new Error("platform migration ledger relation changed before read");
  }
  return identity.ledger_oid;
}

async function assertObjectInventory(
  client: PoolClient,
  plan: LoadedPlan,
  options: PostgresMigrationRunnerOptions,
): Promise<void> {
  // The trusted projector can read the ledger too; retain its validated identity
  // until that complete-catalogue observation has finished.
  await readAppliedPrefix(client, plan.units, async (applied) => {
    if (applied.length !== plan.units.length) throw new Error("platform migration ledger is incomplete after apply");
    const payload = await options.catalogProjectionPayload(client);
    const errors = options.source.evaluate({
      manifest: plan.manifest,
      migrations: plan.migrations,
      objectInventoryPayload: payload,
    });
    if (errors.length > 0) throw new Error(`platform migration inventory rejected: ${errors.join("; ")}`);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function defaultPoolFactory(env: PostgresMigrationRunnerEnv): Promise<Pool> {
  const pg = await import("pg").catch(peerMissing);
  const PoolCtor = (pg.default?.Pool ?? pg.Pool) as typeof import("pg").Pool;
  return new PoolCtor({ connectionString: env.connectionString });
}

export function resolvePostgresMigrationRunnerEnv(
  env: Record<string, string | undefined>,
): PostgresMigrationRunnerEnv {
  return { connectionString: env.DATABASE_URL ?? "" };
}

/** Translate only absence of this optional peer; preserve broken SDKs and other failures. */
function peerMissing(cause: unknown): never {
  if (cause instanceof Error && "code" in cause
    && (cause.code === "ERR_MODULE_NOT_FOUND" || cause.code === "MODULE_NOT_FOUND")
    && /^Cannot find (?:package|module) ['"]pg['"]/.test(cause.message)) {
    throw new Error("OPENLUP_E_PEER_MISSING: pg is required by the Postgres migration runner; install it alongside @openlup/platform", { cause });
  }
  throw cause;
}
