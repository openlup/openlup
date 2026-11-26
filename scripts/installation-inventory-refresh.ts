// Measures disposable local installations; never reads a deployment connection.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { env as processEnvironment } from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Pool } from "pg";
import { createPostgresMigrationRunner } from "../server/adapters/postgres/migrationRunner.ts";
import { selectPlatformMigrationManifest } from "./platform-migration-manifest.ts";
import { qualifiedPostgresCatalogPayload, qualifiedAdminPostgresCatalogPayload, qualifiedPostgresStartupOptions, qualifiedAdminPostgresStartupOptions,
  type QualifiedPostgresInstallation, type QualifiedAdminPostgresInstallation } from "../server/adapters/postgres/qualifiedInstall.ts";
import { readSelectedCatalogProjection, selectedCatalogProjectionPayload } from "../server/adapters/postgres/selectedCatalogProjection.ts";
import { closePostgres, runPostgresContainer, waitForPostgresTcpReady } from "../tests/helpers/postgresContainer.ts";
import { connectedNativeStoreTables } from "../server/adapters/postgres/connectedStoreCapture.ts";
import { inventoryEnvelope, INVENTORY_PATH } from "./agent-review-derived.mjs";
import { isolatedInventoryFile } from "./agent-review-landing.mjs";
import { isExecutableFile, resolveResourceGateInvocation } from "./resource-gate.mjs";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const INVENTORY_PROFILES = ["legacy", "bootstrap", "separate", "admin-managed", "admin-operator"] as const;
export const DEFAULT_INVENTORY_CONCURRENCY = 3;
export const MAX_INVENTORY_CONCURRENCY = INVENTORY_PROFILES.length;
const profiles = INVENTORY_PROFILES;

export function parseInventoryConcurrency(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_INVENTORY_CONCURRENCY;
  const trimmed = raw.trim();
  if (!/^[1-9]\d*$/u.test(trimmed)) {
    throw new Error("OPENLUP_INVENTORY_CONCURRENCY must be a positive integer between 1 and 5.");
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_INVENTORY_CONCURRENCY) {
    throw new Error("OPENLUP_INVENTORY_CONCURRENCY must be a positive integer between 1 and 5.");
  }
  return value;
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error("concurrency must be a positive integer.");
  }
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let firstError: unknown;
  let hasError = false;
  const slots = Math.min(concurrency, items.length);
  const runWorker = async () => {
    while (!hasError) {
      const index = nextIndex;
      if (index >= items.length) return;
      nextIndex += 1;
      try {
        results[index] = await worker(items[index]!, index);
      } catch (error) {
        if (!hasError) {
          hasError = true;
          firstError = error;
        }
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: slots }, () => runWorker()));
  if (hasError) throw firstError;
  return results;
}

export type ResourceGateInvocation = { command: string; args: string[]; key?: string };

export function resolveInventoryResourceGate(
  cwd: string,
  execPath: string,
  execArgv: readonly string[],
  scriptArgv: readonly string[],
  env: NodeJS.ProcessEnv = processEnvironment,
  checkExecutable: (candidate: string) => boolean = isExecutableFile,
): ResourceGateInvocation | null {
  return resolveResourceGateInvocation({
    cwd,
    profile: "openlup:inventory-refresh",
    lane: "docker-heavy",
    command: execPath,
    args: [...execArgv, ...scriptArgv],
    env,
    checkExecutable,
  });
}

function runGatedChild(invocation: ResourceGateInvocation, cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((complete, fail) => {
    const child = spawn(invocation.command, invocation.args, { cwd, env, stdio: "inherit" });
    const onInt = () => child.kill("SIGINT");
    const onTerm = () => child.kill("SIGTERM");
    process.on("SIGINT", onInt);
    process.on("SIGTERM", onTerm);
    const cleanup = () => {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
    };
    child.once("error", error => { cleanup(); fail(error); });
    child.once("close", (code, signal) => {
      cleanup();
      complete(signal ? (signal === "SIGINT" ? 130 : 143) : (code ?? 1));
    });
  });
}
async function measure(profile: typeof profiles[number]) {
  let measured: string | undefined;
  const container = await runPostgresContainer({ name: `inventory-refresh-${profile}-${process.pid}`, password: randomUUID() });
  const pools: Pool[] = [];
  const pool = (url: string, options?: string) => { const value = new Pool({ connectionString: url, options }); pools.push(value); return value; };
  try {
    if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Sized editor PostgreSQL unavailable");
    const owner = pool(container.connectionString), password = randomUUID(), m = "sized_m", r = "sized_r", s = "sized_s", o = "sized_o";
    const admin = profile.startsWith("admin-"), separate = profile === "separate" || admin, operatorMode = profile === "admin-operator";
    const login = (name: string) => { const url = new URL(container.connectionString); url.username = name; if (name !== "postgres") url.password = password; return url.toString(); };
    if (separate) { await owner.query(`CREATE ROLE ${m} LOGIN ${admin ? "NOINHERIT NOSUPERUSER" : "INHERIT SUPERUSER"} ${admin && !operatorMode ? "CREATEROLE" : "NOCREATEROLE"} NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`); await owner.query(`ALTER DATABASE postgres OWNER TO ${m}`); }
    if (profile !== "legacy") for (const name of [r, s]) await owner.query(`CREATE ROLE ${name} LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
    if (operatorMode) {
      await owner.query(`CREATE ROLE ${o} LOGIN NOINHERIT NOSUPERUSER CREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
      const operator = pool(login(o));
      for (const group of ["anon", "authenticated", "service_role", "platform_acquisition_owner", "platform_acquisition_runtime", "openlup_retained_import_owner"]) {
        await owner.query(`CREATE ROLE ${group} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS`);
        await owner.query(`GRANT ${group} TO ${o} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`);
        await operator.query(`GRANT ${group} TO ${m} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE GRANTED BY ${o}`);
        if (["anon", "authenticated", "service_role", "platform_acquisition_runtime"].includes(group)) await operator.query(`GRANT ${group} TO ${r} WITH ADMIN FALSE, INHERIT ${group === "service_role" ? "TRUE" : "FALSE"}, SET TRUE GRANTED BY ${o}`);
      }
    }
    const installation: { generation: "legacy" } | QualifiedPostgresInstallation | QualifiedAdminPostgresInstallation = profile === "legacy" ? { generation: "legacy" }
      : admin ? operatorMode ? { generation: "qualified-admin", roleMode: "operator-provisioned", bootstrapLogin: "postgres", migrationLogin: m, runtimeLogin: r, restoreLogin: s, operatorLogin: o }
        : { generation: "qualified-admin", roleMode: "installer-managed", bootstrapLogin: "postgres", migrationLogin: m, runtimeLogin: r, restoreLogin: s }
        : { generation: "qualified-v2", roleMode: "installer-managed", bootstrapLogin: "postgres", migrationLogin: separate ? m : "postgres", runtimeLogin: r, restoreLogin: s };
    const migrationUrl = login(installation.generation === "legacy" ? "postgres" : installation.migrationLogin);
    const migrator = pool(migrationUrl, installation.generation === "qualified-v2" ? qualifiedPostgresStartupOptions(installation) : installation.generation === "qualified-admin" ? qualifiedAdminPostgresStartupOptions(installation) : undefined);
    const runner = createPostgresMigrationRunner({ connectionString: migrationUrl }, { installation, poolFactory: () => migrator,
      catalogProjectionPayload: async client => {
        const payload = installation.generation === "qualified-v2" ? await qualifiedPostgresCatalogPayload(client, installation, "openlup:public-platform-migrations:v1")
          : installation.generation === "qualified-admin" ? await qualifiedAdminPostgresCatalogPayload(client, installation, "openlup:public-platform-migrations:v1")
            : selectedCatalogProjectionPayload(await readSelectedCatalogProjection(client));
        measured = hash(payload);
        return payload;
      } });
    // Each migration committed through the production runner before its final
    // inventory assertion. Only that stale measurement is expected during refresh.
    try { await runner.apply(); }
    catch (error) {
      if (!measured || !(error instanceof Error) || error.message !== "platform migration inventory rejected: platform migration manifest: object inventory SHA-256 mismatch") throw error;
    }
    if (!measured) throw new Error("Production projector did not measure the complete installation");
    const ledger = (await owner.query("SELECT catalog_path,sha256 FROM public.platform_schema_migrations ORDER BY position DESC")).rows;
    const manifest = selectPlatformMigrationManifest(JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")), installation.generation,
      installation.generation === "qualified-admin" ? { roleMode: installation.roleMode } : { migrationIsBootstrap: !separate, hasRestore: true });
    const expected = [manifest.baseline, ...manifest.forward].reverse();
    assert.deepEqual(ledger, expected.map(unit => ({ catalog_path: unit.file, sha256: unit.sha256 })));
    if (profile === "separate") {
      const tables = (await owner.query("SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname='public' AND tablename=ANY($1::text[])", [[...connectedNativeStoreTables]])).rows;
      assert.equal(tables.length, connectedNativeStoreTables.length);
    }
    const exactTailCount = ledger.findIndex(unit => unit.catalog_path === "db/platform/migrations/20261109150000_subscription_auto_resume_paid_history.sql");
    assert.ok(exactTailCount >= 0, "Exact-installation tail anchor is missing");
    return { count: ledger.length, exactTailCount, objectInventorySha256: measured, tail: ledger.map(unit => ({ file: unit.catalog_path, sha256: unit.sha256 })) };
  } finally { await closePostgres(container, pools); }
}
export async function refreshInstallationInventory(env: NodeJS.ProcessEnv = processEnvironment, isolated = false): Promise<void> {
  const concurrency = parseInventoryConcurrency(env.OPENLUP_INVENTORY_CONCURRENCY);
  const source = readFileSync(INVENTORY_PATH, "utf8"), envelope = inventoryEnvelope(source);
  const measured = await mapWithConcurrency(profiles, concurrency, profile => measure(profile));
  const current = {
    profiles: Object.fromEntries(profiles.map((profile, index) => [profile, measured[index]!])) as Record<typeof profiles[number], Awaited<ReturnType<typeof measure>>>,
    connectedTableCount: connectedNativeStoreTables.length,
  };
  // Replacing only this value preserves historical bytes, including their formatting.
  const contents = envelope.before + JSON.stringify(current, null, 2).replaceAll("\n", "\n  ") + envelope.after;
  if (isolated) writeFileSync(isolatedInventoryFile(process.cwd()), contents, { flag: "wx", mode: 0o600 });
  else writeFileSync(INVENTORY_PATH, contents);
  console.log(`Measured all five complete PostgreSQL installation inventories (concurrency=${concurrency})`);
}

async function main(): Promise<number> {
  const { values: { isolated } } = parseArgs({ options: { isolated: { type: "boolean" } } });
  if (isolated) isolatedInventoryFile(process.cwd());
  // Validate concurrency before waiting on the host broker so malformed env fails fast.
  parseInventoryConcurrency(processEnvironment.OPENLUP_INVENTORY_CONCURRENCY);
  const gated = resolveInventoryResourceGate(
    process.cwd(),
    process.execPath,
    process.execArgv,
    process.argv.slice(1),
    processEnvironment,
  );
  if (gated) {
    return runGatedChild(gated, process.cwd(), processEnvironment);
  }
  await refreshInstallationInventory(processEnvironment, isolated);
  return 0;
}

function isDirectEntrypoint(argv1: string | undefined): boolean {
  if (!argv1) return false;
  try { return realpathSync(resolve(argv1)) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (isDirectEntrypoint(process.argv[1])) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
