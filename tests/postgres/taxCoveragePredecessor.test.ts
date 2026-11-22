// One conversion pair using the qualified installation and owner-window timing fixture.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { readPlatformMigrationManifest, selectPlatformMigrationManifest,
  type PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { captureConnectedNativeStore, type ConnectedNativeStoreCapture } from "../../server/adapters/postgres/connectedStoreCapture.js";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { qualifiedAdminPostgresStartupOptions, type QualifiedAdminPostgresInstallation } from "../../server/adapters/postgres/qualifiedInstall.js";
import { closePostgres, postgresSetupTimeoutMs, runPostgresContainer, waitForPostgresTcpReady,
  type PostgresContainer } from "../helpers/postgresContainer.js";
import { journeyCensus } from "../helpers/storeJourney.js";

const mode = "installer-managed";
const predecessor = "df322edb554c00ee45e725637ddc431e89204446";
const historicalPin = "02c68db9202830bd08f574130d3a3de19345a4050b8879d3338824b379474195";
const password = randomBytes(24).toString("hex");
const coverageTable = "tax_coverage_revisions";
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type Installed = {
  root: Pool;
  owner: Pool;
  selection: QualifiedAdminPostgresInstallation;
  inventory: string;
  runner(root: string): ReturnType<typeof createPostgresMigrationRunner>;
};

async function install(label: string, rootPath: string, containers: PostgresContainer[], pools: Pool[]): Promise<Installed> {
  const container = await runPostgresContainer({ name: `coverage-upgrade-${label}-${process.pid}`, password });
  containers.push(container);
  expect(await waitForPostgresTcpReady(container.connectionString)).toBe(true);
  const pool = (connectionString: string) => {
    const value = new Pool({ connectionString });
    pools.push(value);
    return value;
  };
  const url = (name: string) => {
    const result = new URL(container.connectionString);
    result.username = name;
    return result;
  };
  const root = pool(container.connectionString);
  const version = Number((await root.query("SHOW server_version_num")).rows[0]!.server_version_num);
  expect(Math.floor(version / 10000)).toBe(16);
  await root.query(`CREATE ROLE neon_superuser NOLOGIN NOINHERIT NOSUPERUSER CREATEROLE CREATEDB NOREPLICATION NOBYPASSRLS;
    CREATE ROLE host_bootstrap LOGIN INHERIT NOSUPERUSER CREATEROLE CREATEDB REPLICATION NOBYPASSRLS VALID UNTIL 'infinity' PASSWORD '${password}';
    GRANT neon_superuser TO host_bootstrap WITH ADMIN TRUE, INHERIT TRUE, SET TRUE;
    REVOKE EXECUTE ON FUNCTION pg_catalog.pg_control_system() FROM PUBLIC;
    CREATE ROLE restore_m LOGIN NOINHERIT NOSUPERUSER CREATEROLE
      NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}';
    CREATE ROLE restore_r LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}';
    CREATE ROLE restore_s LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}';
    ALTER DATABASE postgres OWNER TO restore_m`);
  const binding = { generation: "qualified-admin" as const, migrationLogin: "restore_m", bootstrapLogin: "host_bootstrap",
    runtimeLogin: "restore_r", restoreLogin: "restore_s", trustedControlPlane: { roleNames: ["neon_superuser", "postgres"] } };
  const selection: QualifiedAdminPostgresInstallation = { ...binding, roleMode: mode };
  const ownerUrl = url(selection.migrationLogin);
  ownerUrl.searchParams.set("options", qualifiedAdminPostgresStartupOptions(selection));
  const owner = pool(ownerUrl.toString());
  const plan = selectPlatformMigrationManifest(readPlatformMigrationManifest(rootPath) as PlatformMigrationManifest,
    "qualified-admin", { roleMode: mode });
  const runner = (root: string) => createPostgresMigrationRunner({ connectionString: url(selection.migrationLogin).toString() },
    { installation: selection, root, poolFactory: () => owner });
  const original = runner(rootPath);
  const files = [plan.baseline, ...plan.forward];
  expect(await original.apply()).toEqual({ applied: files.map(unit => unit.file) });
  expect((await original.status()).pending).toEqual([]);
  expect((await owner.query("SELECT catalog_path,sha256,position FROM public.platform_schema_migrations ORDER BY position")).rows)
    .toEqual(files.map((unit, position) => ({ catalog_path: unit.file, sha256: unit.sha256, position })));
  return { root, owner, selection, inventory: plan.objectInventorySha256, runner };
}

async function capture(installed: Installed, sourceId: string, captureGraph = captureConnectedNativeStore) {
  const client = await installed.owner.connect();
  try {
    await client.query("GRANT platform_acquisition_owner TO restore_m WITH ADMIN FALSE, INHERIT TRUE, SET FALSE GRANTED BY restore_m");
    try {
      return await captureGraph({ sourceId, catalogueId: installed.inventory, maximumRows: 10000,
        maximumBytes: 64 * 1024 * 1024, source: { async withSnapshot(work) {
          await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
          try {
            const result = await work({ query: (sql, values) => client.query(sql, values ? [...values] : undefined) });
            await client.query("COMMIT");
            return result;
          } catch (error) { await client.query("ROLLBACK"); throw error; }
        } } });
    } finally {
      await client.query("REVOKE platform_acquisition_owner FROM restore_m GRANTED BY restore_m");
    }
  } finally { client.release(); }
}

it("restores the real predecessor coverage shape exactly as an in-place upgrade", async () => {
  const containers: PostgresContainer[] = [], pools: Pool[] = [];
  const root = process.cwd(), scratch = join(root, ".context", "scratch");
  await mkdir(scratch, { recursive: true });
  const historicalRoot = await mkdtemp(join(scratch, "coverage-predecessor-"));
  try {
    const historicalCapture = "server/adapters/postgres/connectedStoreCapture.ts";
    const archive = execFileSync("git", ["archive", predecessor, "config/platform-migration-manifest.json",
      "db/platform/migrations", historicalCapture], { maxBuffer: 32 * 1024 * 1024 });
    execFileSync("tar", ["-xf", "-", "-C", historicalRoot], { input: archive });
    const moduleUrl = pathToFileURL(join(historicalRoot, historicalCapture)).href;
    const { captureConnectedNativeStore: oldCapture } = await import(/* @vite-ignore */ moduleUrl) as
      { captureConnectedNativeStore: typeof captureConnectedNativeStore };

    const source = await install("source", historicalRoot, containers, pools);
    expect(source.inventory).toBe(historicalPin);
    await source.owner.query("INSERT INTO public.clients(email,lifecycle_stage) VALUES('retained@example.invalid','lead')");
    const oldPacket = await capture(source, "historical-coverage", oldCapture);
    expect(oldPacket.owned.some(table => table.table === coverageTable)).toBe(false);
    expect(oldPacket.compatible.tables.find(table => table.table === "clients")?.rows).toHaveLength(1);

    const convertedTarget = await install("converted", root, containers, pools);
    const convertedPristine = await capture(convertedTarget, "converted-pristine");
    const restore = (target: Installed, packet: ConnectedNativeStoreCapture, freshTarget: ConnectedNativeStoreCapture) =>
      restoreConnectedNativeStore({ owner: target.owner, installation: target.selection, packet, freshTarget });
    expect(await restore(convertedTarget, oldPacket, convertedPristine)).toMatchObject({ replayed: false });
    expect(await restore(convertedTarget, oldPacket, convertedPristine)).toMatchObject({ replayed: true });

    const upgrade = source.runner(root), migration = "db/platform/migrations/20261124235000_tax_coverage_revisions.sql";
    expect((await upgrade.status()).pending).toEqual([migration]);
    expect(await upgrade.apply()).toEqual({ applied: [migration] });
    expect((await upgrade.status()).pending).toEqual([]);
    source.inventory = convertedTarget.inventory;
    const upgradedPacket = await capture(source, "upgraded-coverage");
    expect(upgradedPacket.owned.find(table => table.table === coverageTable)?.rows).toEqual([]);
    const upgradedTarget = await install("upgraded", root, containers, pools);
    const upgradedPristine = await capture(upgradedTarget, "upgraded-pristine");
    const { sha256: _outer, ...body } = upgradedPacket;
    const { sha256: _inner, ...compatible } = body.compatible;
    const unknown = { ...compatible, catalogueId: "a".repeat(64) };
    const invalid = { ...body, compatible: { ...unknown, sha256: digest(unknown) } };
    await expect(restore(upgradedTarget, { ...invalid, sha256: digest(invalid) }, upgradedPristine))
      .rejects.toMatchObject({ code: "schema_conflict" });
    expect(await restore(upgradedTarget, upgradedPacket, upgradedPristine)).toMatchObject({ replayed: false });
    expect(await restore(upgradedTarget, upgradedPacket, upgradedPristine)).toMatchObject({ replayed: true });
    const converted = await journeyCensus(convertedTarget.root), upgraded = await journeyCensus(upgradedTarget.root);
    expect(converted).toEqual(upgraded);
    expect(upgraded[coverageTable]).toEqual([]);
  } finally {
    try { await closePostgres(containers, pools); }
    finally { await rm(historicalRoot, { recursive: true, force: true }); }
  }
}, postgresSetupTimeoutMs);
