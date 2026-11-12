import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresMigrationRunner } from "@openlup/platform/migrations";
import { imageReference, readCiImage } from "../../scripts/ci-image-pull.mjs";
import {
  closePostgres, defaultPostgresImage, dockerAvailable, postgresSetupTimeoutMs,
  postgresTeardownTimeoutMs, runPostgresContainer, waitForPostgresTcpReady,
  type PostgresContainer,
} from "../helpers/postgresContainer.js";

const postgresImages = [
  { version: "16.15", image: defaultPostgresImage, marker: false },
  { version: "16.16", image: imageReference(readCiImage("test-postgres-16-attver")), marker: true },
  { version: "17.12", image: imageReference(readCiImage("test-postgres-17-attver")), marker: true },
] as const;
const baseline = "db/platform/migrations/00000000000000_platform_baseline.sql";
const ledgerDefinition = readFileSync(baseline, "utf8").match(/CREATE TABLE public\.platform_schema_migrations \([\s\S]*?\n\);/)?.[0];
if (!ledgerDefinition) throw new Error("Canonical migration ledger definition missing");
const migrations = [
  { file: baseline, content: ledgerDefinition },
  { file: "db/platform/migrations/00000000000001_ledger_witness.sql", content: "SELECT 1;" },
];
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const entries = migrations.map(({ file, content }) => ({ file, sha256: digest(content) }));
const inventory = "migration ledger fixture";
const manifest = { schemaVersion: 1, baseline: entries[0], forward: entries.slice(1), objectInventorySha256: digest(inventory) };
const files = entries.map(entry => entry.file);
const exec = promisify(execFile);
const docker = (args: string[]) => exec("docker", args, { timeout: 30_000, killSignal: "SIGKILL" });

function poolFor(container: PostgresContainer) {
  return new Pool({ connectionString: container.connectionString, max: 2,
    connectionTimeoutMillis: 5_000, statement_timeout: 10_000, query_timeout: 12_000 });
}

function runnerFor(pool: Pool) {
  return createPostgresMigrationRunner({ connectionString: "injected local PostgreSQL pool" }, {
    lockName: "migration-ledger-attribute-version", poolFactory: () => pool,
    source: {
      readMigrations: () => ({ migrations, errors: [] }), readManifest: () => manifest,
      evaluate: input => input.objectInventoryPayload !== undefined && digest(input.objectInventoryPayload) !== manifest.objectInventorySha256
        ? ["inventory mismatch"] : [],
    },
    catalogProjectionPayload: async () => inventory,
  });
}

async function assertReplay(pool: Pool) {
  const runner = runnerFor(pool);
  await expect(runner.status()).resolves.toEqual({ applied: files, pending: [] });
  await expect(runner.apply()).resolves.toEqual({ applied: [] });
  expect((await pool.query("SELECT catalog_path, sha256, position FROM public.platform_schema_migrations ORDER BY position")).rows)
    .toEqual(entries.map((entry, position) => ({ catalog_path: entry.file, sha256: entry.sha256, position })));
}

async function assertRefusal(pool: Pool) {
  const runner = runnerFor(pool);
  for (const operation of [() => runner.status(), () => runner.apply({ dryRun: true }), () => runner.apply()]) {
    await expect(operation()).rejects.toThrow("platform migration ledger relation is not safe to read");
  }
}

async function columnOptions(pool: Pool) {
  return (await pool.query(`SELECT attoptions, attfdwoptions FROM pg_catalog.pg_attribute
    WHERE attrelid='public.platform_schema_migrations'::pg_catalog.regclass AND attnum>0 ORDER BY attnum`)).rows;
}

describe.each(postgresImages)("migration ledger on PostgreSQL $version", ({ version, image, marker }) => {
  let container: PostgresContainer | undefined;
  let pool: Pool;
  beforeAll(async () => {
    if (!await dockerAvailable()) throw new Error("Migration ledger witness requires Docker PostgreSQL");
    container = await runPostgresContainer({ name: `ledger-attribute-${version}-${process.pid}`, password: "synthetic-conformance", image });
    if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Migration ledger PostgreSQL unavailable");
    pool = poolFor(container);
    expect((await pool.query("SHOW server_version")).rows[0].server_version.split(" ")[0]).toBe(version);
  }, postgresSetupTimeoutMs);
  afterAll(() => closePostgres(container, pool), postgresTeardownTimeoutMs);
  beforeEach(async () => { await pool.query("DROP TABLE IF EXISTS public.platform_schema_migrations"); }, 15_000);

  it("applies a fresh ledger, then reads and reruns its exact prefix", { timeout: 30_000, retry: 0 }, async () => {
    await expect(runnerFor(pool).apply()).resolves.toEqual({ applied: files });
    expect(await columnOptions(pool)).toEqual(Array.from({ length: 4 }, () => ({
      attoptions: marker ? [expect.stringMatching(/^pg_attver=[0-9]+$/u)] : null, attfdwoptions: null,
    })));
    await assertReplay(pool);
  });

  it("refuses a foreign option, including alongside an existing version marker", { timeout: 30_000, retry: 0 }, async () => {
    await runnerFor(pool).apply();
    const original = (await columnOptions(pool))[1].attoptions;
    await pool.query("ALTER TABLE public.platform_schema_migrations ALTER COLUMN sha256 SET (n_distinct = 1)");
    expect((await columnOptions(pool))[1].attoptions).toEqual([...(original ?? []), "n_distinct=1"]);
    await assertRefusal(pool);
    await pool.query("ALTER TABLE public.platform_schema_migrations ALTER COLUMN sha256 RESET (n_distinct)");
    expect((await columnOptions(pool))[1].attoptions).toEqual(original);
    await assertReplay(pool);
  });

  it("accepts only complete numeric markers and keeps foreign-data options exact", { timeout: 30_000, retry: 0 }, async () => {
    await runnerFor(pool).apply();
    const original = (await columnOptions(pool))[1].attoptions;
    // Superuser catalog fixtures exercise malformed values that column-option DDL refuses.
    for (const options of [["pg_attver=0"], ["pg_attver=12", "pg_attver=34"]]) {
      await pool.query(`UPDATE pg_catalog.pg_attribute SET attoptions=$1::pg_catalog.text[]
        WHERE attrelid='public.platform_schema_migrations'::pg_catalog.regclass AND attname='sha256'`, [options]);
      await assertReplay(pool);
    }
    for (const options of [
      ["pg_attver="], ["pg_attver=-1"], ["pg_attver=1x"], ["pg_attver=1\n"],
      ["PG_ATTVER=1"], ["xpg_attver=1"], [null], ["pg_attver=12", null],
      ["pg_attver=12", "n_distinct=1"], ["pg_attver=12", "pg_attver=invalid"],
    ]) {
      await pool.query(`UPDATE pg_catalog.pg_attribute SET attoptions=$1::pg_catalog.text[]
        WHERE attrelid='public.platform_schema_migrations'::pg_catalog.regclass AND attname='sha256'`, [options]);
      await assertRefusal(pool);
    }
    await pool.query(`UPDATE pg_catalog.pg_attribute SET attoptions=$1::pg_catalog.text[], attfdwoptions=ARRAY['pg_attver=12']
      WHERE attrelid='public.platform_schema_migrations'::pg_catalog.regclass AND attname='sha256'`, [original]);
    await assertRefusal(pool);
    await pool.query(`UPDATE pg_catalog.pg_attribute SET attfdwoptions=NULL
      WHERE attrelid='public.platform_schema_migrations'::pg_catalog.regclass AND attname='sha256'`);
    await assertReplay(pool);
  });
});

it("retains a pre-upgrade ledger across a PostgreSQL 16.15 to 16.16 restart", { timeout: 180_000, retry: 0 }, async () => {
  if (!await dockerAvailable()) throw new Error("Migration ledger upgrade witness requires Docker PostgreSQL");
  const volume = `ledger-attribute-upgrade-${process.pid}-${randomUUID()}`;
  const data = "/var/lib/postgresql/ledger-upgrade";
  const containers: PostgresContainer[] = [];
  const pools: Pool[] = [];
  await docker(["volume", "create", volume]);
  try {
    let before: unknown[] | undefined;
    for (const [index, { version, image }] of postgresImages.slice(0, 2).entries()) {
      const name = `ledger-attribute-upgrade-${index}-${process.pid}`;
      // A separate PGDATA mount persists through both containers; the helper's default data tmpfs is unused.
      const container = await runPostgresContainer({ name, password: "synthetic-conformance", image,
        runOptions: ["--mount", `type=volume,src=${volume},dst=${data}`, "-e", `PGDATA=${data}`] });
      containers.push(container);
      if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Migration ledger upgrade PostgreSQL unavailable");
      const pool = poolFor(container);
      pools.push(pool);
      expect((await pool.query("SHOW server_version")).rows[0].server_version.split(" ")[0]).toBe(version);
      if (index === 0) await expect(runnerFor(pool).apply()).resolves.toEqual({ applied: files });
      expect(await columnOptions(pool)).toEqual(Array.from({ length: 4 }, () => ({ attoptions: null, attfdwoptions: null })));
      const rows = (await pool.query("SELECT * FROM public.platform_schema_migrations ORDER BY position")).rows;
      if (index === 0) before = rows;
      else expect(rows).toEqual(before);
      await assertReplay(pool);
      await pool.end();
      await docker(["stop", "--time", "10", name]);
      await container.remove();
    }
  } finally {
    try { await closePostgres(containers, pools); }
    finally { await docker(["volume", "rm", volume]); }
  }
});
