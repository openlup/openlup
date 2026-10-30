import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { env as processEnvironment } from "node:process";
import { Pool } from "pg";
import { afterAll, it } from "vitest";
import { selectPlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { captureConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreCapture.js";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { qualifiedAdminPostgresStartupOptions, type QualifiedAdminPostgresInstallation }
  from "../../server/adapters/postgres/qualifiedInstall.js";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer, waitForPostgresTcpReady,
  type PostgresContainer } from "../helpers/postgresContainer.js";
import { managedFirstLeg } from "./m14ManagedCatchup.js";

// The complete H1/H2 portable leg remains in the opt-in executable. This root
// witness uses the same managed first-leg assertions without its Node image.
const selection: QualifiedAdminPostgresInstallation = { generation: "qualified-admin", roleMode: "installer-managed",
  migrationLogin: "transfer_owner", bootstrapLogin: "postgres", runtimeLogin: "transfer_runtime", restoreLogin: "transfer_restore" };
const selected = selectPlatformMigrationManifest(JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")),
  "qualified-admin", { roleMode: "installer-managed" });
const containers: PostgresContainer[] = [], pools: Pool[] = [];
const owner = randomUUID();
async function install(side: string) {
  const container = await runPostgresContainer({ name: `m14-managed-catchup-${side}-${owner}`, password: "synthetic-only" });
  containers.push(container);
  assert(await waitForPostgresTcpReady(container.connectionString));
  const pool = (connectionString: string) => { const db = new Pool({ connectionString }); pools.push(db); return db; };
  const bootstrap = pool(container.connectionString);
  await bootstrap.query(`CREATE ROLE transfer_owner LOGIN NOINHERIT NOSUPERUSER NOCREATEDB CREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-only';
    ALTER DATABASE postgres OWNER TO transfer_owner;
    CREATE ROLE transfer_runtime LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-only';
    CREATE ROLE transfer_restore LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-only'`);
  const url = new URL(container.connectionString); url.username = selection.migrationLogin;
  const migrationUrl = url.toString(); url.searchParams.set("options", qualifiedAdminPostgresStartupOptions(selection));
  const db = pool(url.toString());
  const runner = createPostgresMigrationRunner({ connectionString: migrationUrl }, { installation: selection, poolFactory: () => db });
  assert.deepEqual(await runner.apply(), { applied: [selected.baseline, ...selected.forward].map(unit => unit.file) });
  url.search = ""; url.username = selection.runtimeLogin;
  return { owner: db, runtime: pool(url.toString()), runner };
}
async function captureNative(db: Pool, sourceId: string) {
  const client = await db.connect();
  try {
    await client.query("GRANT platform_acquisition_owner TO transfer_owner WITH ADMIN FALSE, INHERIT TRUE, SET FALSE GRANTED BY transfer_owner");
    return await captureConnectedNativeStore({ sourceId, catalogueId: selected.objectInventorySha256,
      maximumRows: 10000, maximumBytes: 64 * 1024 * 1024,
      source: { async withSnapshot(work) {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        try {
          const result = await work({ query: (sql, values) => client.query(sql, values ? [...values] : undefined) });
          await client.query("COMMIT"); return result;
        } catch (error) { await client.query("ROLLBACK"); throw error; }
      } } });
  } finally {
    await client.query("REVOKE platform_acquisition_owner FROM transfer_owner GRANTED BY transfer_owner");
    client.release();
  }
}

afterAll(async () => closePostgres(containers, pools), postgresTeardownTimeoutMs);
it("catches up managed typed obligations with interrupted copy, source-only history and activation refusal", async () => {
  const result = await managedFirstLeg({ final: await install("final"), installation: selection,
    createPreliminary: () => install("preliminary"), captureNative });
  const scratch = resolve(".context/scratch");
  await mkdir(scratch, { recursive: true });
  const requested = processEnvironment.OPENLUP_M14_JOURNEY_REPORT;
  const path = requested ? resolve(requested) : join(await mkdtemp(join(scratch, "m14-managed-first-leg-")), "report.json");
  if (!path.startsWith(`${scratch}/`)) throw new Error("Journey report must remain in private worktree scratch");
  await writeFile(path, JSON.stringify(result.report, null, 2), { mode: 0o600 });
  console.info(JSON.stringify({ managedJourneyReport: path }));
}, postgresSetupTimeoutMs);
