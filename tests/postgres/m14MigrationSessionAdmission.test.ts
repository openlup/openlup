import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createPostgresMigrationRunner, type PlatformMigrationSource } from "@openlup/platform/migrations";
import { readSelectedCatalogProjection, selectedCatalogProjectionPayload } from "../../server/adapters/postgres/selectedCatalogProjection.js";
import { qualifiedPostgresCatalogPayload } from "../../server/adapters/postgres/qualifiedInstall.js";
import { closePostgres, dockerAvailable, postgresSetupTimeoutMs, postgresTeardownTimeoutMs,
  runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

const files = ["db/platform/migrations/00000000000000_platform_baseline.sql", "db/platform/migrations/20260807140000_read_parity_catalog.sql"];
const migrations = files.map(file => ({ file, content: readFileSync(file, "utf8") }));
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const entries = migrations.map(({ file, content }) => ({ file, sha256: digest(content) }));
const inventory = "session-admission-only fixture; no qualified inventory claim";
const manifest = { schemaVersion: 1, baseline: entries[0], forward: entries.slice(1), objectInventorySha256: digest(inventory) };
let container: PostgresContainer | undefined;
let admin: Pool;
let second: Pool;

beforeAll(async () => {
  if (!await dockerAvailable()) throw new Error("Migration session admission proof requires Docker PostgreSQL");
  container = await runPostgresContainer({ name: `m14-session-admission-${process.pid}`, password: "synthetic-conformance" });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Migration session admission PostgreSQL unavailable");
  admin = new Pool({ connectionString: container.connectionString });
  await admin.query("CREATE ROLE qualified_second_migrator LOGIN SUPERUSER PASSWORD 'synthetic-only'");
  await admin.query("CREATE ROLE synthetic_ledger_owner NOLOGIN");
  await admin.query(`CREATE SCHEMA migration_read_probe;
    CREATE FUNCTION migration_read_probe.mark() RETURNS pg_catalog.text LANGUAGE plpgsql VOLATILE AS $$
    BEGIN PERFORM pg_catalog.pg_advisory_lock(73120491::pg_catalog.int8); RETURN 'synthetic'; END $$;
    CREATE FUNCTION migration_read_probe.hashtextextended(pg_catalog.text, pg_catalog.int4)
      RETURNS pg_catalog.int8 LANGUAGE plpgsql VOLATILE AS $$
    BEGIN PERFORM migration_read_probe.mark(); RETURN 0; END $$;
    CREATE FUNCTION migration_read_probe.oid_equal(a pg_catalog.oid, b pg_catalog.oid)
      RETURNS pg_catalog.bool LANGUAGE plpgsql VOLATILE AS $$
    BEGIN PERFORM migration_read_probe.mark(); RETURN a OPERATOR(pg_catalog.=) b; END $$;
    CREATE OPERATOR migration_read_probe.= (LEFTARG=pg_catalog.oid, RIGHTARG=pg_catalog.oid,
      FUNCTION=migration_read_probe.oid_equal)`);
  const url = new URL(container.connectionString);
  url.username = "qualified_second_migrator";
  url.password = "synthetic-only";
  second = new Pool({ connectionString: url.toString() });
}, postgresSetupTimeoutMs);

afterAll(() => closePostgres(container, [admin, second]), postgresTeardownTimeoutMs);

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function source(assertSession: PlatformMigrationSource["assertSession"]): PlatformMigrationSource {
  return {
    readMigrations: () => ({ migrations, errors: [] }), readManifest: () => manifest,
    evaluate: input => input.objectInventoryPayload !== undefined && digest(input.objectInventoryPayload) !== manifest.objectInventorySha256 ? ["inventory mismatch"] : [],
    assertSession,
  };
}

it("refuses a second owner under the actual lock after a first installer committed an interrupted prefix", async () => {
  const firstAdmission = signal(), letFirstProceed = signal(), secondAdmission = signal(), letSecondRefuse = signal();
  const lockName = "synthetic-migration-session-admission";
  const firstPool = {
    async connect() {
      const client = await admin.connect();
      return {
        query(text: string, values?: unknown[]) {
          if (text === migrations[1]!.content) throw new Error("synthetic interruption before unchanged forward");
          return client.query(text, values);
        },
        release: client.release.bind(client),
      };
    },
  } as unknown as Pool;
  const first = createPostgresMigrationRunner({ connectionString: container!.connectionString }, {
    lockName, poolFactory: () => firstPool, catalogProjectionPayload: async () => inventory,
    source: source(async (_client, applied) => {
      expect(applied).toEqual([]);
      firstAdmission.resolve();
      await letFirstProceed.promise;
    }),
  });
  const other = createPostgresMigrationRunner({ connectionString: "synthetic second pool binding" }, {
    lockName, poolFactory: () => second, catalogProjectionPayload: async () => inventory,
    source: source(async (client, applied) => {
      const row = (await client.query("SELECT current_user AS login,pg_get_userbyid(c.relowner) AS owner FROM pg_class c WHERE c.oid='public.platform_schema_migrations'::regclass")).rows[0];
      expect(applied).toEqual([{ ...entries[0], position: 0 }]);
      expect(row).toEqual({ login: "qualified_second_migrator", owner: "postgres" });
      secondAdmission.resolve();
      await letSecondRefuse.promise;
      if (row.login !== row.owner) throw new Error("migration login differs from installed owner");
    }),
  });
  // Both actual logins observe the same pre-role prefix before the first makes effects.
  expect((await second.query("SELECT to_regclass('public.platform_schema_migrations') AS ledger")).rows).toEqual([{ ledger: null }]);
  const firstResult = first.apply().catch(error => error);
  let secondResult: ReturnType<typeof other.apply> | undefined;
  try {
    await Promise.race([firstAdmission.promise, firstResult.then(result => { throw result; })]);
    secondResult = other.apply().catch(error => error);
    try {
      await expect.poll(async () => (await admin.query("SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE usename='qualified_second_migrator' AND wait_event='advisory'")).rows[0].waiting, { timeout: 10_000 }).toBe(1);
    } finally {
      letFirstProceed.resolve();
    }
    expect(await firstResult).toMatchObject({ message: expect.stringContaining("synthetic interruption") });
    await Promise.race([secondAdmission.promise, secondResult.then(result => { throw result; })]);
    const snapshot = async (client: PoolClient) => ({
      catalog: selectedCatalogProjectionPayload(await readSelectedCatalogProjection(client)),
      ledger: (await client.query("SELECT catalog_path,sha256,position,executed_at::text FROM public.platform_schema_migrations ORDER BY position")).rows,
    });
    const observer = await admin.connect();
    try {
      const before = await snapshot(observer);
      letSecondRefuse.resolve();
      expect(await secondResult).toMatchObject({ message: "migration login differs from installed owner" });
      expect(await snapshot(observer)).toEqual(before);
      expect((await observer.query("SELECT to_regclass('public.catalog_products') AS unchanged_tail")).rows).toEqual([{ unchanged_tail: null }]);
      expect((await observer.query("SELECT count(*)::int AS locks FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database())")).rows).toEqual([{ locks: 0 }]);
    } finally {
      observer.release();
    }
  } finally {
    letFirstProceed.resolve();
    letSecondRefuse.resolve();
    await Promise.allSettled(secondResult ? [firstResult, secondResult] : [firstResult]);
  }
}, 20_000);

const methods = ["status", "dry-run", "apply"] as const;
type Method = typeof methods[number];
const ledgerDefinition = "CREATE TABLE public.platform_schema_migrations (catalog_path pg_catalog.text, sha256 pg_catalog.text, position pg_catalog.int4)";
const hostileLayouts = [
  ["view", `CREATE VIEW public.platform_schema_migrations AS SELECT migration_read_probe.mark() AS catalog_path,
    'synthetic'::pg_catalog.text AS sha256, 0::pg_catalog.int4 AS position`],
  ["domain column", `CREATE DOMAIN public.synthetic_ledger_text AS pg_catalog.text
    CHECK (migration_read_probe.mark() IS NOT NULL);
    CREATE TABLE public.platform_schema_migrations (catalog_path public.synthetic_ledger_text, sha256 pg_catalog.text, position pg_catalog.int4)`],
  ["different unprivileged owner", `${ledgerDefinition}; ALTER TABLE public.platform_schema_migrations OWNER TO synthetic_ledger_owner`],
  ["row policy", `${ledgerDefinition}; ALTER TABLE public.platform_schema_migrations ENABLE ROW LEVEL SECURITY;
    CREATE POLICY synthetic_read ON public.platform_schema_migrations USING (migration_read_probe.mark() IS NOT NULL)`],
  ["rewrite rule", `${ledgerDefinition}; CREATE RULE synthetic_insert AS ON INSERT TO public.platform_schema_migrations
    DO ALSO SELECT migration_read_probe.mark()`],
] as const;

async function resetLedger(sql: string): Promise<void> {
  await admin.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  await admin.query(sql);
}

async function attachForeignLedgerChild(): Promise<void> {
  await admin.query(`CREATE EXTENSION IF NOT EXISTS postgres_fdw;
    CREATE SERVER synthetic_unreachable_child FOREIGN DATA WRAPPER postgres_fdw
      OPTIONS (host '127.0.0.1', port '1', dbname 'synthetic');
    CREATE USER MAPPING FOR CURRENT_USER SERVER synthetic_unreachable_child OPTIONS (user 'synthetic');
    CREATE FOREIGN TABLE public.synthetic_foreign_ledger_child () INHERITS (public.platform_schema_migrations)
      SERVER synthetic_unreachable_child OPTIONS (table_name 'synthetic')`);
}

function probePool(): Pool {
  return new Pool({ connectionString: container!.connectionString, max: 1,
    options: "-c search_path=migration_read_probe,pg_catalog,public" });
}

async function invocationCount(): Promise<number> {
  // Session advisory locks remain visible after rollback, including READ ONLY.
  return (await admin.query(`SELECT pg_catalog.count(*)::pg_catalog.int4 AS calls FROM pg_catalog.pg_locks
    WHERE locktype OPERATOR(pg_catalog.=) 'advisory'::pg_catalog.text
      AND classid OPERATOR(pg_catalog.=) 0::pg_catalog.oid
      AND objid OPERATOR(pg_catalog.=) 73120491::pg_catalog.oid AND granted`)).rows[0].calls;
}

function fixtureRunner(pool: Pool, withHook: boolean, onAdmission = () => {},
  projector: (client: PoolClient) => Promise<string> = async () => inventory) {
  return createPostgresMigrationRunner({ connectionString: "owned synthetic pool" }, {
    lockName: "synthetic-ledger-preflight", poolFactory: () => pool,
    catalogProjectionPayload: projector,
    source: source(withHook ? async () => { onAdmission(); } : undefined),
  });
}

function operate(runner: ReturnType<typeof fixtureRunner>, method: Method) {
  return method === "status" ? runner.status() : runner.apply({ dryRun: method === "dry-run" });
}

it.each(methods)("refuses unsafe ledger layouts before %s reads with zero probe invocations", async method => {
  for (const withHook of [false, true]) {
    for (const [layout, sql] of hostileLayouts) {
      await resetLedger(sql);
      const pool = probePool();
      let admissions = 0;
      try {
        const result = await operate(fixtureRunner(pool, withHook, () => { admissions += 1; }), method)
          .then(value => ({ value }), error => ({ error: error.message }));
        expect({ result, invocations: await invocationCount(), admissions }, layout).toEqual({
          result: { error: "platform migration ledger relation is not safe to read" }, invocations: 0, admissions: 0,
        });
        expect((await admin.query("SELECT pg_catalog.to_regclass('public.catalog_products') AS pending_relation")).rows)
          .toEqual([{ pending_relation: null }]);
      } finally { await pool.end(); }
    }
  }
});

it.each(methods)("protects complete-ledger inventory projection during %s with zero probe invocations", async method => {
  await resetLedger(ledgerDefinition);
  for (let position = 0; position < entries.length; position += 1) {
    await admin.query("INSERT INTO public.platform_schema_migrations VALUES ($1,$2,$3)", [entries[position]!.file, entries[position]!.sha256, position]);
  }
  await attachForeignLedgerChild();
  const pool = probePool();
  let protectedProjection = false;
  try {
    const runner = fixtureRunner(pool, true, () => {}, async client => {
      protectedProjection = (await client.query(`SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_locks
        WHERE pid OPERATOR(pg_catalog.=) pg_catalog.pg_backend_pid()
          AND relation OPERATOR(pg_catalog.=) pg_catalog.to_regclass('public.platform_schema_migrations')
          AND mode OPERATOR(pg_catalog.=) 'AccessShareLock'::pg_catalog.text AND granted) AS held`)).rows[0].held;
      // An independent DDL session can replace an unprotected name. Do not wait
      // on a protected relation; the separate lock-hold witness proves exclusion.
      if (!protectedProjection) await admin.query(`DROP TABLE public.platform_schema_migrations CASCADE; ${hostileLayouts[0][1]}`);
      // Exercise the real qualified projector's ledger read. This intentionally
      // incomplete host fixture then retains its existing search-path refusal;
      // full qualified-install compatibility has its separate production proof.
      await expect(qualifiedPostgresCatalogPayload(client, {
        generation: "qualified-v2", roleMode: "installer-managed", migrationLogin: "postgres",
        bootstrapLogin: "postgres", runtimeLogin: "synthetic_runtime",
      }, "synthetic-ledger-preflight")).rejects.toThrow("qualified_profile_requires_canonical_search_path");
      return inventory;
    });
    const result = await operate(runner, method);
    expect({ protectedProjection, invocations: await invocationCount() }).toEqual({ protectedProjection: true, invocations: 0 });
    expect(result).toEqual(method === "status" ? { applied: files, pending: [] } : { applied: [] });
  } finally {
    await pool.end();
    await admin.query("DROP FOREIGN TABLE IF EXISTS public.synthetic_foreign_ledger_child; DROP SERVER synthetic_unreachable_child CASCADE");
  }
});

it.each(methods)("rechecks the locked ledger identity before %s after concurrent name replacement", async method => {
  for (const replacement of [hostileLayouts[0][1], ledgerDefinition]) {
    await resetLedger(ledgerDefinition);
    const pool = probePool();
    let observations = 0;
    const racingPool = {
      async connect() {
        const client = await pool.connect();
        return {
          async query(sql: string, values?: unknown[]) {
            const result = await client.query(sql, values);
            if (sql.startsWith("SELECT c.oid::pg_catalog.text AS ledger_oid,") && ++observations === 1) {
              await admin.query(`DROP TABLE public.platform_schema_migrations; ${replacement}`);
            }
            return result;
          },
          release: client.release.bind(client),
        };
      },
    } as unknown as Pool;
    try {
      await expect(operate(fixtureRunner(racingPool, true), method))
        .rejects.toThrow("platform migration ledger relation changed before read");
      expect(await invocationCount()).toBe(0);
    } finally { await pool.end(); }
  }
});

it.each([false, true])("reads only the genuine ledger, excluding ordinary and foreign children (hook=%s)", async withHook => {
  await resetLedger(`${ledgerDefinition}; CREATE TABLE public.synthetic_ledger_child () INHERITS (public.platform_schema_migrations);
    INSERT INTO public.synthetic_ledger_child VALUES ('synthetic-extra', 'synthetic-extra', 100)`);
  await admin.query("INSERT INTO public.platform_schema_migrations VALUES ($1,$2,0)", [entries[0]!.file, entries[0]!.sha256]);
  await attachForeignLedgerChild();
  const pool = probePool();
  try {
    const runner = fixtureRunner(pool, withHook);
    await expect(runner.status()).resolves.toEqual({ applied: files.slice(0, 1), pending: files.slice(1) });
    await expect(runner.apply({ dryRun: true })).resolves.toEqual({ applied: files.slice(1) });
    expect(await invocationCount()).toBe(0);
  } finally {
    await pool.end();
    await admin.query("DROP FOREIGN TABLE public.synthetic_foreign_ledger_child; DROP SERVER synthetic_unreachable_child CASCADE");
  }
});

it.each([false, true])("preserves bootstrap-owned ledger reads for a distinct migration login (hook=%s)", async withHook => {
  await resetLedger(ledgerDefinition);
  await admin.query("INSERT INTO public.platform_schema_migrations VALUES ($1,$2,0)", [entries[0]!.file, entries[0]!.sha256]);
  const runner = fixtureRunner(second, withHook);
  await expect(runner.status()).resolves.toEqual({ applied: files.slice(0, 1), pending: files.slice(1) });
  await expect(runner.apply({ dryRun: true })).resolves.toEqual({ applied: files.slice(1) });
  expect(await invocationCount()).toBe(0);
});

it("holds the admitted ledger relation lock until its rows have been read", async () => {
  await resetLedger(ledgerDefinition);
  await admin.query("INSERT INTO public.platform_schema_migrations VALUES ($1,$2,0)", [entries[0]!.file, entries[0]!.sha256]);
  const oid = (await admin.query("SELECT 'public.platform_schema_migrations'::pg_catalog.regclass::pg_catalog.oid AS oid")).rows[0].oid;
  const beforeRead = signal(), allowRead = signal();
  const pool = probePool();
  const gatedPool = {
    async connect() {
      const client = await pool.connect();
      return {
        async query(sql: string, values?: unknown[]) {
          if (sql.startsWith("SELECT catalog_path, sha256, position FROM ONLY")) {
            beforeRead.resolve();
            await allowRead.promise;
          }
          return client.query(sql, values);
        },
        release: client.release.bind(client),
      };
    },
  } as unknown as Pool;
  const result = fixtureRunner(gatedPool, false).status();
  let replacement: Promise<unknown> | undefined;
  try {
    await Promise.race([beforeRead.promise, result.then(() => { throw new Error("ledger read did not reach its gate"); })]);
    replacement = admin.query(`DROP TABLE public.platform_schema_migrations; ${hostileLayouts[0][1]}`);
    await expect.poll(async () => (await admin.query(`SELECT pg_catalog.count(*)::pg_catalog.int4 AS waiting
      FROM pg_catalog.pg_locks WHERE relation OPERATOR(pg_catalog.=) $1::pg_catalog.oid
        AND mode OPERATOR(pg_catalog.=) 'AccessExclusiveLock'::pg_catalog.text AND NOT granted`, [oid])).rows[0].waiting,
    { timeout: 10_000 }).toBe(1);
    allowRead.resolve();
    await expect(result).resolves.toEqual({ applied: files.slice(0, 1), pending: files.slice(1) });
    await replacement;
    expect(await invocationCount()).toBe(0);
  } finally {
    allowRead.resolve();
    await Promise.allSettled(replacement ? [result, replacement] : [result]);
    await pool.end();
  }
});
