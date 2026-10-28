import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  readSelectedCatalogProjection,
  selectedCatalogProjectionPayload,
} from "../../server/adapters/postgres/selectedCatalogProjection.js";
import {
  closePostgres,
  dockerAvailable,
  postgresSetupTimeoutMs,
  postgresTeardownTimeoutMs,
  runPostgresContainer,
  waitForPostgresTcpReady,
  type PostgresContainer,
} from "../helpers/postgresContainer.js";

const qualifiedSql = readFileSync("db/platform/migrations/q2_00000000000000_platform_baseline.sql", "utf8");
const legacySql = readFileSync("db/platform/migrations/00000000000000_platform_baseline.sql", "utf8");
let container: PostgresContainer | undefined;
let admin: Pool;
let restricted: Pool;

beforeAll(async () => {
  if (!await dockerAvailable()) throw new Error("Qualified baseline proof requires Docker PostgreSQL");
  container = await runPostgresContainer({ name: `m14-qualified-baseline-${process.pid}`, password: "synthetic-conformance" });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Qualified baseline PostgreSQL unavailable");
  admin = new Pool({ connectionString: container.connectionString });
  await admin.query("CREATE ROLE qualified_restricted LOGIN PASSWORD 'synthetic-only' NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS");
  const url = new URL(container.connectionString);
  url.username = "qualified_restricted";
  url.password = "synthetic-only";
  restricted = new Pool({ connectionString: url.toString() });
}, postgresSetupTimeoutMs);

afterAll(() => closePostgres(container, [admin, restricted]), postgresTeardownTimeoutMs);

async function inRolledBackTransaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await admin.connect();
  try {
    await client.query("BEGIN");
    return await operation(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

it("creates the same kernel schema as the issued baseline without relabelling its identity", async () => {
  const legacy = await inRolledBackTransaction(async client => {
    await client.query(legacySql);
    return selectedCatalogProjectionPayload(await readSelectedCatalogProjection(client));
  });
  await inRolledBackTransaction(async client => {
    await client.query(qualifiedSql);
    expect(selectedCatalogProjectionPayload(await readSelectedCatalogProjection(client))).toBe(legacy);
    const row = { path: "db/platform/migrations/q2_00000000000000_platform_baseline.sql", digest: "a".repeat(64) };
    await client.query("INSERT INTO public.platform_schema_migrations(catalog_path,sha256,position) VALUES($1,$2,0)", [row.path, row.digest]);
    expect((await client.query("SELECT catalog_path,sha256,position FROM public.platform_schema_migrations")).rows)
      .toEqual([{ catalog_path: row.path, sha256: row.digest, position: 0 }]);
  });
});

it("refuses an actual ordinary login and a switched superuser session before creating schema", async () => {
  await expect(restricted.query(qualifiedSql)).rejects.toMatchObject({ code: "42501", message: "qualified_install_requires_superuser_login" });
  await inRolledBackTransaction(async client => {
    await client.query("SET LOCAL ROLE qualified_restricted");
    await expect(client.query(qualifiedSql)).rejects.toMatchObject({ code: "42501", message: "qualified_install_requires_superuser_login" });
  });
  expect((await admin.query("SELECT to_regclass('public.clients') AS clients,to_regclass('public.platform_schema_migrations') AS ledger")).rows)
    .toEqual([{ clients: null, ledger: null }]);
});

it.each([
  ["existing empty ledger", "CREATE TABLE public.platform_schema_migrations(catalog_path text)", "public.platform_schema_migrations"],
  ["existing public table", "CREATE TABLE public.unrelated(id integer)", "public.unrelated"],
  ["existing user schema", "CREATE SCHEMA auth", null],
  ["existing extension", "CREATE EXTENSION pg_trgm", null],
] as const)("refuses %s before changing the kernel", async (_label, setup, retainedRelation) => {
  await inRolledBackTransaction(async client => {
    await client.query(setup);
    await client.query("SAVEPOINT before_baseline");
    await expect(client.query(qualifiedSql)).rejects.toMatchObject({ code: "42501", message: "qualified_install_requires_empty_database" });
    await client.query("ROLLBACK TO SAVEPOINT before_baseline");
    expect((await client.query("SELECT to_regclass('public.clients') AS clients")).rows).toEqual([{ clients: null }]);
    if (retainedRelation) expect((await client.query("SELECT to_regclass($1) IS NOT NULL AS retained", [retainedRelation])).rows).toEqual([{ retained: true }]);
  });
});
