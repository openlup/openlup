import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createPostgresMigrationRunner, type PlatformMigrationSource } from "@openlup/platform/migrations";
import { readSelectedCatalogProjection, readSelectedCatalogRowsForQualifiedInstall, selectedCatalogProjectionPayload } from "../../server/adapters/postgres/selectedCatalogProjection.js";
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
    CREATE FUNCTION migration_read_probe.mark_insert() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
    BEGIN PERFORM migration_read_probe.mark(); RETURN NEW; END $$;
    CREATE FUNCTION migration_read_probe.mark_timestamp() RETURNS pg_catalog.timestamptz LANGUAGE plpgsql VOLATILE AS $$
    BEGIN PERFORM migration_read_probe.mark(); RETURN pg_catalog.statement_timestamp(); END $$;
    CREATE FUNCTION migration_read_probe.mark_position(value pg_catalog.int4) RETURNS pg_catalog.int4 LANGUAGE plpgsql IMMUTABLE AS $$
    BEGIN PERFORM migration_read_probe.mark(); RETURN value; END $$;
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
const ledgerDefinition = migrations[0]!.content.match(/CREATE TABLE public\.platform_schema_migrations \([\s\S]*?\n\);/)?.[0];
if (!ledgerDefinition) throw new Error("canonical baseline ledger definition missing");
const minimalLedgerDefinition = "CREATE TABLE public.platform_schema_migrations (catalog_path pg_catalog.text, sha256 pg_catalog.text, position pg_catalog.int4)";
const hostileLayouts = [
  ["view", `CREATE VIEW public.platform_schema_migrations AS SELECT migration_read_probe.mark() AS catalog_path,
    'synthetic'::pg_catalog.text AS sha256, 0::pg_catalog.int4 AS position`],
  ["domain column", `CREATE DOMAIN public.synthetic_ledger_text AS pg_catalog.text
    CHECK (migration_read_probe.mark() IS NOT NULL);
    CREATE TABLE public.platform_schema_migrations (catalog_path public.synthetic_ledger_text, sha256 pg_catalog.text, position pg_catalog.int4)`],
  ["different unprivileged owner", `${minimalLedgerDefinition}; ALTER TABLE public.platform_schema_migrations OWNER TO synthetic_ledger_owner`],
  ["row policy", `${minimalLedgerDefinition}; ALTER TABLE public.platform_schema_migrations ENABLE ROW LEVEL SECURITY;
    CREATE POLICY synthetic_read ON public.platform_schema_migrations USING (migration_read_probe.mark() IS NOT NULL)`],
  ["rewrite rule", `${minimalLedgerDefinition}; CREATE RULE synthetic_insert AS ON INSERT TO public.platform_schema_migrations
    DO ALSO SELECT migration_read_probe.mark()`],
  ["insert trigger", `${minimalLedgerDefinition}; CREATE TRIGGER synthetic_insert BEFORE INSERT ON public.platform_schema_migrations
    FOR EACH ROW EXECUTE FUNCTION migration_read_probe.mark_insert()`],
  ["extra default", `CREATE TABLE public.platform_schema_migrations
    (catalog_path pg_catalog.text, sha256 pg_catalog.text, position pg_catalog.int4,
      extra pg_catalog.text DEFAULT migration_read_probe.mark())`],
  ["check expression", `${minimalLedgerDefinition}; ALTER TABLE public.platform_schema_migrations
    ADD CONSTRAINT synthetic_check CHECK (migration_read_probe.mark() IS NOT NULL)`],
  ["built-in default", `CREATE TABLE public.platform_schema_migrations
    (catalog_path pg_catalog.text, sha256 pg_catalog.text, position pg_catalog.int4,
      extra pg_catalog.text DEFAULT pg_catalog.set_config('application_name','synthetic-default',false))`],
  ["built-in check", `${minimalLedgerDefinition}; ALTER TABLE public.platform_schema_migrations
    ADD CONSTRAINT platform_schema_migrations_position_check
    CHECK (pg_catalog.set_config('application_name','synthetic-check',false) IS NOT NULL)`],
] as const;

// Each case starts from the exact ledger CREATE TABLE in the canonical baseline
// and changes one catalog-shape dimension. Replacement kinds cannot retain its
// row, but must still be refused by the same metadata-only admission.
const shapeDeviations = [
  ["partition leaf", `CREATE TABLE public.synthetic_partition_parent
    (catalog_path pg_catalog.text NOT NULL, sha256 pg_catalog.text NOT NULL,
      position pg_catalog.int4 NOT NULL, executed_at pg_catalog.timestamptz NOT NULL
        DEFAULT pg_catalog.statement_timestamp())
    PARTITION BY LIST (migration_read_probe.mark_position(position));
    ALTER TABLE public.synthetic_partition_parent ATTACH PARTITION public.platform_schema_migrations
      FOR VALUES IN (0, 1)`],
  ["inheritance parent", `CREATE TABLE public.synthetic_ledger_child () INHERITS (public.platform_schema_migrations)`],
  ["inheritance child", `CREATE TABLE public.synthetic_ledger_parent (position pg_catalog.int4);
    ALTER TABLE public.platform_schema_migrations INHERIT public.synthetic_ledger_parent`],
  ["domain column", `CREATE DOMAIN public.synthetic_ledger_text AS pg_catalog.text;
    ALTER TABLE public.platform_schema_migrations ALTER COLUMN sha256 TYPE public.synthetic_ledger_text`],
  ["function default", `ALTER TABLE public.platform_schema_migrations ALTER COLUMN executed_at
    SET DEFAULT migration_read_probe.mark_timestamp()`],
  ["generated column", `ALTER TABLE public.platform_schema_migrations ADD COLUMN synthetic_generated pg_catalog.int4
    GENERATED ALWAYS AS (migration_read_probe.mark_position(position)) STORED`],
  ["identity column", `ALTER TABLE public.platform_schema_migrations ADD COLUMN synthetic_identity pg_catalog.int4
    GENERATED ALWAYS AS IDENTITY`],
  ["renamed column", `ALTER TABLE public.platform_schema_migrations RENAME COLUMN sha256 TO fingerprint`],
  ["function check", `ALTER TABLE public.platform_schema_migrations
    ADD CONSTRAINT synthetic_check CHECK (migration_read_probe.mark() IS NOT NULL)`],
  ["custom collation", `CREATE COLLATION public.synthetic_collation (provider = libc, locale = 'C');
    ALTER TABLE public.platform_schema_migrations ALTER COLUMN sha256 TYPE pg_catalog.text
      COLLATE public.synthetic_collation`],
  ["insert trigger", `CREATE TRIGGER synthetic_insert BEFORE INSERT ON public.platform_schema_migrations
    FOR EACH ROW EXECUTE FUNCTION migration_read_probe.mark_insert()`],
  ["rewrite rule", `CREATE RULE synthetic_insert AS ON INSERT TO public.platform_schema_migrations
    DO ALSO SELECT migration_read_probe.mark()`],
  ["policy and RLS", `ALTER TABLE public.platform_schema_migrations ENABLE ROW LEVEL SECURITY;
    CREATE POLICY synthetic_read ON public.platform_schema_migrations
      USING (migration_read_probe.mark() IS NOT NULL)`],
  ["expression index", `CREATE INDEX synthetic_expression_index ON public.platform_schema_migrations
    (migration_read_probe.mark_position(position))`],
  ["expression statistics", `CREATE STATISTICS synthetic_expression_stats
    ON (migration_read_probe.mark_position(position)) FROM public.platform_schema_migrations`],
  ["wrong owner", `ALTER TABLE public.platform_schema_migrations OWNER TO synthetic_ledger_owner`],
  ["unlogged", `ALTER TABLE public.platform_schema_migrations SET UNLOGGED`],
  ["view", `DROP TABLE public.platform_schema_migrations;
    CREATE VIEW public.platform_schema_migrations AS SELECT migration_read_probe.mark() AS catalog_path,
      'synthetic'::pg_catalog.text AS sha256, 0::pg_catalog.int4 AS position,
      pg_catalog.statement_timestamp() AS executed_at`],
  ["materialized view", `DROP TABLE public.platform_schema_migrations;
    CREATE MATERIALIZED VIEW public.platform_schema_migrations AS SELECT migration_read_probe.mark() AS catalog_path,
      'synthetic'::pg_catalog.text AS sha256, 0::pg_catalog.int4 AS position,
      pg_catalog.statement_timestamp() AS executed_at WITH NO DATA`],
  ["foreign table", `DROP TABLE public.platform_schema_migrations;
    CREATE EXTENSION IF NOT EXISTS postgres_fdw WITH SCHEMA migration_read_probe;
    DROP SERVER IF EXISTS synthetic_shape_server CASCADE;
    CREATE SERVER synthetic_shape_server FOREIGN DATA WRAPPER postgres_fdw
      OPTIONS (host '127.0.0.1', port '1', dbname 'synthetic');
    CREATE FOREIGN TABLE public.platform_schema_migrations
      (catalog_path pg_catalog.text, sha256 pg_catalog.text, position pg_catalog.int4,
        executed_at pg_catalog.timestamptz) SERVER synthetic_shape_server`],
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
    options: "-c search_path=migration_read_probe,pg_catalog,public -c application_name=m14-preflight" });
}

async function invocationCount(): Promise<number> {
  // Session advisory locks remain visible after rollback, including READ ONLY.
  return (await admin.query(`SELECT pg_catalog.count(*)::pg_catalog.int4 AS calls FROM pg_catalog.pg_locks
    WHERE locktype OPERATOR(pg_catalog.=) 'advisory'::pg_catalog.text
      AND classid OPERATOR(pg_catalog.=) 0::pg_catalog.oid
      AND objid OPERATOR(pg_catalog.=) 73120491::pg_catalog.oid AND granted`)).rows[0].calls;
}

function fixtureRunner(pool: Pool, withHook: boolean, onAdmission: (client: PoolClient) => void | Promise<void> = () => {},
  projector: (client: PoolClient) => Promise<string> = async () => inventory) {
  return createPostgresMigrationRunner({ connectionString: "owned synthetic pool" }, {
    lockName: "synthetic-ledger-preflight", poolFactory: () => pool,
    catalogProjectionPayload: projector,
    source: source(withHook ? async client => { await onAdmission(client); } : undefined),
  });
}

function operate(runner: ReturnType<typeof fixtureRunner>, method: Method) {
  return method === "status" ? runner.status() : runner.apply({ dryRun: method === "dry-run" });
}

it("admits only the canonical catalog shape across commands and complete qualified inventory", async () => {
  for (const method of [...methods, "qualified-inventory"] as const) {
    for (const [deviation, mutation] of shapeDeviations) {
      await resetLedger(ledgerDefinition);
      const setup = await admin.connect();
      try {
        const prefix = method === "qualified-inventory" ? entries : entries.slice(0, 1);
        for (let position = 0; position < prefix.length; position += 1) {
          await setup.query("INSERT INTO public.platform_schema_migrations (catalog_path,sha256,position) VALUES ($1,$2,$3)",
            [prefix[position]!.file, prefix[position]!.sha256, position]);
        }
        await setup.query(mutation);
        // A setup-time partition check or index build may call the synthetic
        // marker. Clear only this setup session before measuring runner calls.
        await setup.query("SELECT pg_catalog.pg_advisory_unlock_all()");
        if (deviation === "partition leaf" && method !== "qualified-inventory") {
          await setup.query("INSERT INTO public.platform_schema_migrations (catalog_path,sha256,position) VALUES ($1,$2,1)",
            [entries[1]!.file, entries[1]!.sha256]);
          expect(await invocationCount()).toBeGreaterThan(0);
          await setup.query("DELETE FROM public.platform_schema_migrations WHERE position OPERATOR(pg_catalog.=) 1");
          await setup.query("SELECT pg_catalog.pg_advisory_unlock_all()");
        }
      } finally { setup.release(); }
      expect(await invocationCount(), `${deviation} setup`).toBe(0);
      const pool = probePool();
      let admissions = 0, projections = 0;
      try {
        const runner = fixtureRunner(pool, false, () => { admissions += 1; }, async client => {
          projections += 1;
          await qualifiedPostgresCatalogPayload(client, {
            generation: "qualified-v2", roleMode: "installer-managed", migrationLogin: "postgres",
            bootstrapLogin: "postgres", runtimeLogin: "synthetic_runtime",
          }, "synthetic-ledger-preflight");
          return inventory;
        });
        const result = await (method === "qualified-inventory" ? runner.status() : operate(runner, method))
          .then(value => ({ value }), error => ({ error: error.message }));
        expect({ result, invocations: await invocationCount(), admissions, projections }, `${deviation} / ${method}`)
          .toEqual({ result: { error: "platform migration ledger relation is not safe to read" },
            invocations: 0, admissions: 0, projections: 0 });
        expect((await admin.query("SELECT pg_catalog.to_regclass('public.catalog_products') AS pending_relation")).rows)
          .toEqual([{ pending_relation: null }]);
      } finally { await pool.end(); }
    }
  }

  await resetLedger(ledgerDefinition);
  for (let position = 0; position < entries.length; position += 1) {
    await admin.query("INSERT INTO public.platform_schema_migrations (catalog_path,sha256,position) VALUES ($1,$2,$3)",
      [entries[position]!.file, entries[position]!.sha256, position]);
  }
  const pool = probePool();
  let projections = 0;
  try {
    const runner = fixtureRunner(pool, true, () => {}, async client => {
      projections += 1;
      await client.query("SELECT catalog_path,sha256,position FROM ONLY public.platform_schema_migrations ORDER BY position");
      return inventory;
    });
    await expect(runner.status()).resolves.toEqual({ applied: files, pending: [] });
    await expect(runner.apply({ dryRun: true })).resolves.toEqual({ applied: [] });
    await expect(runner.apply()).resolves.toEqual({ applied: [] });
    expect({ projections, invocations: await invocationCount() }).toEqual({ projections: 3, invocations: 0 });
  } finally { await pool.end(); }
});

it("keeps a temporary name shadow outside the fixed public ledger identity", async () => {
  await resetLedger(ledgerDefinition);
  await admin.query("INSERT INTO public.platform_schema_migrations (catalog_path,sha256,position) VALUES ($1,$2,0)",
    [entries[0]!.file, entries[0]!.sha256]);
  const pool = probePool();
  try {
    await expect(pool.query(`CREATE TEMP TABLE public.platform_schema_migrations
      (catalog_path pg_catalog.text, sha256 pg_catalog.text, position pg_catalog.int4)`))
      .rejects.toThrow(/temporary relation.*non-temporary schema/);
    await pool.query(`CREATE TEMP VIEW platform_schema_migrations AS SELECT
      migration_read_probe.mark() AS catalog_path, 'synthetic'::pg_catalog.text AS sha256,
      0::pg_catalog.int4 AS position`);
    await expect(fixtureRunner(pool, false).status()).resolves.toEqual({
      applied: files.slice(0, 1), pending: files.slice(1),
    });
    expect(await invocationCount()).toBe(0);
  } finally { await pool.end(); }
});

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
        if (layout === "built-in default" || layout === "built-in check") {
          expect((await pool.query("SHOW application_name")).rows).toEqual([{ application_name: "m14-preflight" }]);
        }
        expect((await admin.query("SELECT pg_catalog.to_regclass('public.catalog_products') AS pending_relation")).rows)
          .toEqual([{ pending_relation: null }]);
      } finally { await pool.end(); }
    }
  }
});

it.each(methods)("protects complete-ledger inventory projection during %s with zero probe invocations", async method => {
  await resetLedger(ledgerDefinition);
  for (let position = 0; position < entries.length; position += 1) {
    await admin.query("INSERT INTO public.platform_schema_migrations (catalog_path,sha256,position) VALUES ($1,$2,$3)", [entries[position]!.file, entries[position]!.sha256, position]);
  }
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

it("rechecks the same ledger under the migration transaction before a pending insert", async () => {
  for (const [layout, replacement] of [...hostileLayouts.filter(([name]) => name === "view" || name === "insert trigger"),
    ["safe replacement", ledgerDefinition] as const]) {
    await resetLedger(ledgerDefinition);
    await admin.query("INSERT INTO public.platform_schema_migrations (catalog_path,sha256,position) VALUES ($1,$2,0)", [entries[0]!.file, entries[0]!.sha256]);
    const pool = probePool();
    const replacingPool = {
      async connect() {
        const client = await pool.connect();
        return {
          async query(sql: string, values?: unknown[]) {
            const result = await client.query(sql, values);
            if (sql === "COMMIT") {
              await admin.query(`DROP TABLE public.platform_schema_migrations; ${replacement}`);
            }
            return result;
          },
          release: client.release.bind(client),
        };
      },
    } as unknown as Pool;
    try {
      await expect(fixtureRunner(replacingPool, true).apply(), layout)
        .rejects.toThrow(layout === "safe replacement" ? "platform migration ledger changed before write"
          : "platform migration ledger relation is not safe to read");
      expect(await invocationCount()).toBe(0);
      expect((await admin.query("SELECT pg_catalog.to_regclass('public.catalog_products') AS pending_relation")).rows)
        .toEqual([{ pending_relation: null }]);
    } finally { await pool.end(); }
  }
});

it.each(["repeatable read", "serializable"])("preserves a pending unit's configured %s isolation", async isolation => {
  await resetLedger(ledgerDefinition);
  await admin.query("INSERT INTO public.platform_schema_migrations (catalog_path,sha256,position) VALUES ($1,$2,0)",
    [entries[0]!.file, entries[0]!.sha256]);
  const forward = { file: "db/platform/migrations/20261029000000_synthetic_isolation.sql",
    content: "SHOW transaction_isolation" };
  const forwardEntry = { file: forward.file, sha256: digest(forward.content) };
  const isolatedSource: PlatformMigrationSource = {
    ...source(undefined),
    readMigrations: () => ({ migrations: [migrations[0]!, forward], errors: [] }),
    readManifest: () => ({ ...manifest, forward: [forwardEntry] }),
  };
  const pool = new Pool({ connectionString: container!.connectionString, max: 1 });
  let observed: string | undefined;
  const observingPool = {
    async connect() {
      const client = await pool.connect();
      return {
        async query(sql: string, values?: unknown[]) {
          const result = await client.query(sql, values);
          if (sql === forward.content) observed = result.rows[0]?.transaction_isolation;
          return result;
        },
        release: client.release.bind(client),
      };
    },
  } as unknown as Pool;
  try {
    await pool.query(`SET default_transaction_isolation TO '${isolation}'`);
    const runner = createPostgresMigrationRunner({ connectionString: "owned synthetic pool" }, {
      lockName: "synthetic-ledger-isolation", poolFactory: () => observingPool, source: isolatedSource,
      catalogProjectionPayload: async () => inventory,
    });
    await expect(runner.apply()).resolves.toEqual({ applied: [forward.file] });
    expect(observed).toBe(isolation);
    expect(await invocationCount()).toBe(0);
  } finally { await pool.end(); }
});

it("sees a ledger replacement committed while the pending unit waits for its first lock", async () => {
  await resetLedger(ledgerDefinition);
  await admin.query("INSERT INTO public.platform_schema_migrations (catalog_path,sha256,position) VALUES ($1,$2,0)",
    [entries[0]!.file, entries[0]!.sha256]);
  const blocker = await admin.connect();
  const pool = new Pool({ connectionString: container!.connectionString, max: 1 });
  const lockAttempted = signal();
  let armed = false, lockCompleted = false, postLockCatalogRead = false;
  const racingPool = {
    async connect() {
      const client = await pool.connect();
      return {
        async query(sql: string, values?: unknown[]) {
          if (sql === "COMMIT" && !armed) {
            const result = await client.query(sql);
            await blocker.query("BEGIN");
            await blocker.query("LOCK TABLE ONLY public.platform_schema_migrations IN ACCESS EXCLUSIVE MODE");
            armed = true;
            return result;
          }
          if (sql === "LOCK TABLE ONLY public.platform_schema_migrations IN SHARE ROW EXCLUSIVE MODE" && !lockCompleted) {
            lockAttempted.resolve();
            const result = await client.query(sql);
            lockCompleted = true;
            return result;
          }
          if (lockCompleted && sql.startsWith("SELECT c.oid::pg_catalog.text AS ledger_oid,")) postLockCatalogRead = true;
          return client.query(sql, values);
        },
        release: client.release.bind(client),
      };
    },
  } as unknown as Pool;
  const result = fixtureRunner(racingPool, false).apply().catch(error => error);
  try {
    await Promise.race([lockAttempted.promise, result.then(error => { throw error; })]);
    await expect.poll(async () => (await admin.query(`SELECT pg_catalog.count(*)::pg_catalog.int4 AS waiting
      FROM pg_catalog.pg_locks WHERE mode OPERATOR(pg_catalog.=) 'ShareRowExclusiveLock'::pg_catalog.text
        AND NOT granted`)).rows[0].waiting, { timeout: 3_000 }).toBeGreaterThan(0);
    await blocker.query(`ALTER TABLE public.platform_schema_migrations RENAME TO synthetic_old_ledger;
      CREATE VIEW public.platform_schema_migrations AS SELECT
        'synthetic'::pg_catalog.text AS catalog_path, 'synthetic'::pg_catalog.text AS sha256,
        0::pg_catalog.int4 AS position`);
    await blocker.query("COMMIT");
    expect(await result).toMatchObject({ message: expect.stringContaining("not safe to read") });
    expect(postLockCatalogRead).toBe(true);
    expect(await invocationCount()).toBe(0);
  } finally {
    await blocker.query("ROLLBACK").catch(() => {});
    blocker.release();
    await Promise.allSettled([result]);
    await pool.end();
  }
});

it("refuses a changed applied prefix before a pending migration commits", async () => {
  await resetLedger(ledgerDefinition);
  await admin.query("INSERT INTO public.platform_schema_migrations (catalog_path,sha256,position) VALUES ($1,$2,0)", [entries[0]!.file, entries[0]!.sha256]);
  const pool = probePool();
  const changingPool = {
    async connect() {
      const client = await pool.connect();
      return {
        async query(sql: string, values?: unknown[]) {
          const result = await client.query(sql, values);
          if (sql === "COMMIT") await admin.query("DELETE FROM public.platform_schema_migrations");
          return result;
        },
        release: client.release.bind(client),
      };
    },
  } as unknown as Pool;
  try {
    await expect(fixtureRunner(changingPool, true).apply()).rejects.toThrow("platform migration ledger changed before write");
    expect(await invocationCount()).toBe(0);
    expect((await admin.query("SELECT pg_catalog.to_regclass('public.catalog_products') AS pending_relation")).rows)
      .toEqual([{ pending_relation: null }]);
  } finally { await pool.end(); }
});

it("holds the pending write lock against a concurrent trigger change", async () => {
  await resetLedger(ledgerDefinition);
  await admin.query("INSERT INTO public.platform_schema_migrations (catalog_path,sha256,position) VALUES ($1,$2,0)", [entries[0]!.file, entries[0]!.sha256]);
  const oid = (await admin.query("SELECT 'public.platform_schema_migrations'::pg_catalog.regclass::pg_catalog.oid AS oid")).rows[0].oid;
  const beforeInsert = signal(), allowInsert = signal();
  const pool = probePool();
  let ledgerReads = 0;
  const gatedPool = {
    async connect() {
      const client = await pool.connect();
      return {
        async query(sql: string, values?: unknown[]) {
          if (sql.startsWith("SELECT catalog_path, sha256, position FROM ONLY") && ++ledgerReads === 2) {
            beforeInsert.resolve();
            await allowInsert.promise;
          }
          return client.query(sql, values);
        },
        release: client.release.bind(client),
      };
    },
  } as unknown as Pool;
  const ddlPool = new Pool({ connectionString: container!.connectionString, max: 1, options: "-c statement_timeout=5000" });
  const result = fixtureRunner(gatedPool, true).apply();
  try {
    await Promise.race([beforeInsert.promise, result.then(() => { throw new Error("pending write did not reach its gate"); })]);
    const addTrigger = ddlPool.query(`CREATE TRIGGER synthetic_insert BEFORE INSERT ON public.platform_schema_migrations
      FOR EACH ROW EXECUTE FUNCTION migration_read_probe.mark_insert()`);
    await expect.poll(async () => (await admin.query(`SELECT pg_catalog.count(*)::pg_catalog.int4 AS waiting
      FROM pg_catalog.pg_locks WHERE relation OPERATOR(pg_catalog.=) $1::pg_catalog.oid
        AND mode OPERATOR(pg_catalog.=) 'ShareRowExclusiveLock'::pg_catalog.text AND NOT granted`, [oid])).rows[0].waiting,
    { timeout: 3_000 }).toBe(1);
    await expect(addTrigger).rejects.toMatchObject({ code: "57014" });
    allowInsert.resolve();
    await expect(result).resolves.toEqual({ applied: files.slice(1) });
    expect(await invocationCount()).toBe(0);
  } finally {
    allowInsert.resolve();
    await Promise.allSettled([result]);
    await Promise.all([pool.end(), ddlPool.end()]);
  }
});

it("keeps ledger DDL blocked until the pending unit commits", async () => {
  await resetLedger(ledgerDefinition);
  await admin.query("INSERT INTO public.platform_schema_migrations (catalog_path,sha256,position) VALUES ($1,$2,0)",
    [entries[0]!.file, entries[0]!.sha256]);
  const oid = (await admin.query("SELECT 'public.platform_schema_migrations'::pg_catalog.regclass::pg_catalog.oid AS oid")).rows[0].oid;
  const beforeInsert = signal(), allowInsert = signal();
  const pool = probePool();
  const ddlPool = new Pool({ connectionString: container!.connectionString, max: 1 });
  let inserted = false, committed = false, ddlCompleted = false;
  let ddl: Promise<unknown> | undefined;
  const gatedPool = {
    async connect() {
      const client = await pool.connect();
      return {
        async query(sql: string, values?: unknown[]) {
          if (sql.startsWith("INSERT INTO public.platform_schema_migrations")) {
            beforeInsert.resolve();
            await allowInsert.promise;
            inserted = true;
          }
          const result = await client.query(sql, values);
          if (sql === "COMMIT" && inserted) {
            committed = true;
            await ddl;
          }
          return result;
        },
        release: client.release.bind(client),
      };
    },
  } as unknown as Pool;
  const result = fixtureRunner(gatedPool, false).apply().catch(error => error);
  try {
    await Promise.race([beforeInsert.promise, result.then(error => { throw error; })]);
    ddl = ddlPool.query("ALTER TABLE public.platform_schema_migrations ADD COLUMN synthetic_after_commit pg_catalog.text")
      .then(value => { ddlCompleted = true; return value; });
    await expect.poll(async () => (await admin.query(`SELECT pg_catalog.count(*)::pg_catalog.int4 AS waiting
      FROM pg_catalog.pg_locks WHERE relation OPERATOR(pg_catalog.=) $1::pg_catalog.oid
        AND mode OPERATOR(pg_catalog.=) 'AccessExclusiveLock'::pg_catalog.text AND NOT granted`, [oid])).rows[0].waiting,
    { timeout: 3_000 }).toBe(1);
    expect({ committed, ddlCompleted }).toEqual({ committed: false, ddlCompleted: false });
    allowInsert.resolve();
    expect(await result).toMatchObject({ message: expect.stringContaining("not safe to read") });
    expect({ committed, ddlCompleted }).toEqual({ committed: true, ddlCompleted: true });
    expect((await admin.query("SELECT pg_catalog.count(*)::pg_catalog.int4 AS count FROM public.platform_schema_migrations")).rows)
      .toEqual([{ count: 2 }]);
    expect(await invocationCount()).toBe(0);
  } finally {
    allowInsert.resolve();
    await Promise.allSettled([result, ...(ddl ? [ddl] : [])]);
    await Promise.all([pool.end(), ddlPool.end()]);
  }
});

it.each([false, true])("refuses a ledger with ordinary and foreign inheritance children (hook=%s)", async withHook => {
  await resetLedger(`${ledgerDefinition}; CREATE TABLE public.synthetic_ledger_child () INHERITS (public.platform_schema_migrations)`);
  await admin.query("INSERT INTO public.platform_schema_migrations (catalog_path,sha256,position) VALUES ($1,$2,0)", [entries[0]!.file, entries[0]!.sha256]);
  await attachForeignLedgerChild();
  const pool = probePool();
  try {
    const runner = fixtureRunner(pool, withHook);
    await expect(runner.status()).rejects.toThrow("platform migration ledger relation is not safe to read");
    await expect(runner.apply({ dryRun: true })).rejects.toThrow("platform migration ledger relation is not safe to read");
    expect(await invocationCount()).toBe(0);
  } finally {
    await pool.end();
    await admin.query("DROP FOREIGN TABLE public.synthetic_foreign_ledger_child; DROP SERVER synthetic_unreachable_child CASCADE");
  }
});

it.each([false, true])("preserves bootstrap-owned ledger reads for a distinct migration login (hook=%s)", async withHook => {
  await resetLedger(ledgerDefinition);
  await admin.query("INSERT INTO public.platform_schema_migrations (catalog_path,sha256,position) VALUES ($1,$2,0)", [entries[0]!.file, entries[0]!.sha256]);
  const runner = fixtureRunner(second, withHook);
  await expect(runner.status()).resolves.toEqual({ applied: files.slice(0, 1), pending: files.slice(1) });
  await expect(runner.apply({ dryRun: true })).resolves.toEqual({ applied: files.slice(1) });
  expect(await invocationCount()).toBe(0);
});

it("holds the admitted ledger relation lock until its rows have been read", async () => {
  await resetLedger(ledgerDefinition);
  await admin.query("INSERT INTO public.platform_schema_migrations (catalog_path,sha256,position) VALUES ($1,$2,0)", [entries[0]!.file, entries[0]!.sha256]);
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

it("holds the admitted ledger lock through the qualified session catalog read", async () => {
  await resetLedger(ledgerDefinition);
  await admin.query("INSERT INTO public.platform_schema_migrations (catalog_path,sha256,position) VALUES ($1,$2,0)",
    [entries[0]!.file, entries[0]!.sha256]);
  const oid = (await admin.query("SELECT 'public.platform_schema_migrations'::pg_catalog.regclass::pg_catalog.oid AS oid")).rows[0].oid;
  const inSession = signal(), allowCatalogRead = signal();
  const pool = probePool();
  const result = fixtureRunner(pool, true, async client => {
    inSession.resolve();
    await allowCatalogRead.promise;
    const rows = await readSelectedCatalogRowsForQualifiedInstall(client);
    expect(rows.some(row => row.kind === "relation" && row.schema === "public"
      && row.name === "platform_schema_migrations")).toBe(true);
  }).status();
  let replacement: Promise<unknown> | undefined;
  try {
    await Promise.race([inSession.promise, result.then(() => { throw new Error("qualified catalog read did not reach its gate"); })]);
    replacement = admin.query(`DROP TABLE public.platform_schema_migrations; ${hostileLayouts[0][1]}`);
    await expect.poll(async () => (await admin.query(`SELECT pg_catalog.count(*)::pg_catalog.int4 AS waiting
      FROM pg_catalog.pg_locks WHERE relation OPERATOR(pg_catalog.=) $1::pg_catalog.oid
        AND mode OPERATOR(pg_catalog.=) 'AccessExclusiveLock'::pg_catalog.text AND NOT granted`, [oid])).rows[0].waiting,
    { timeout: 10_000 }).toBe(1);
    allowCatalogRead.resolve();
    await expect(result).resolves.toEqual({ applied: files.slice(0, 1), pending: files.slice(1) });
    await replacement;
    expect(await invocationCount()).toBe(0);
  } finally {
    allowCatalogRead.resolve();
    await Promise.allSettled(replacement ? [result, replacement] : [result]);
    await pool.end();
  }
});
