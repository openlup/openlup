import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createPostgresMigrationRunner, type PlatformMigrationSource } from "@openlup/platform/migrations";
import { readSelectedCatalogProjection, selectedCatalogProjectionPayload } from "../../server/adapters/postgres/selectedCatalogProjection.js";
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

function source(assertSession: NonNullable<PlatformMigrationSource["assertSession"]>): PlatformMigrationSource {
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
