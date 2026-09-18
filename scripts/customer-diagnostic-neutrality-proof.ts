// Neutrality-axis driver for the customer diagnostic rail (Wave 5, items 1-2).
//
//   node --conditions=core-source --import tsx scripts/openlup/proof-customer-diagnostic-neutrality.ts \
//     [--out <file>] [--falsifier browser-role-grant|ledger-inactive-driver]
//
// It brings up a disposable `postgres:16`, creates a disposable database inside it, applies the
// MANIFEST-BOUND `db/platform/migrations` set through the shipped `createPostgresMigrationRunner`
// (no bootstrap prelude, no Supabase history), runs the thirteen legs through the shipped ports, and
// tears it all down. Precedents: `scripts/platform-job-run-ledger-parity.ts` for the disposable
// database, `db/bootstrap/vanilla-pg/run-migration-replay.ts` for the set being the runner's.
//
// ⛔ A PURE LIBRARY, DELIBERATELY, AND THE RULE IS TEXTUAL. This file is RETAINED by the publication
// delta, and `isDirectExecutionEntrypoint` (`scripts/oss-publication-contract.ts:104-108`) classifies
// a retained file by a regex over its WHOLE contents, comments included: a shebang, an
// argument-vector reference or an import-meta execution guard anywhere here would demand a row in
// the frozen entrypoint catalogue. Argument parsing and the exit code live in the WITHHELD runner
// named above; `readFlag` stays here, tested, taking the argument list as a parameter. The container
// lifecycle is here too — a shell wrapper would be a Git executable with a shebang, and
// PUBLIC_STANDALONE_EXECUTABLES is empty by design. Every import in this proof is retained.
//
// ⚠ THE THROWAWAY INGRESS KEY IS NOT SECRET HANDLING: minted in-process for the container's
// lifetime, it reaches no store, is never printed, and never enters the receipt. `fingerprint`
// redacts the values that ARE recorded — the operator id and the disposable database.
//
// ⛔ The receipt is NOT a `CanaryReceipt`: that type carries `sourceSha`/`targetClasses`/`rollback`
// and no `legs`. This axis proves a database, not a deployment, so it emits its own shape.

import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";

import type { Pool } from "pg";

import { createPostgresMigrationRunner } from "../server/adapters/postgres/migrationRunner.js";
import { closeCustomerDiagnosticRuntimeLanes, resolveCustomerDiagnosticLane }
  from "../server/runtime/observability/customerDiagnosticHistoryBinding.js";
import { CUSTOMER_DIAGNOSTIC_PRUNE_JOB_NAME } from "../server/domains/observability/customerDiagnosticPruneJob.js";
import { runNeutralityLegs, type LegOutcome, type NeutralityContext } from "./customer-diagnostic-neutrality-legs.ts";

const exec = promisify(execFile);
/** The redaction discipline of `scripts/edge-canary/receipt.ts`, reimplemented here because that is a
 *  withheld prefix and this proof is retained: importing it would drag a withheld module into the
 *  published closure for one hash. */
export const fingerprint = (value: string): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;

const PROBE = "customer_diagnostic_neutrality_probe";
const IMAGE = "postgres:16";
const DEFAULT_OUT = "staging-evidence/customer-diagnostic-neutrality.json";
/** Seeded falsifiers: each plants ONE defect and names the leg that must go red. A harness that
 *  cannot be made to fail proves nothing, and both of these caught a real defect here.
 *  `ledger-inactive-driver` backdates its refusal an hour, so leg 13's "latest run" assertion is
 *  untouched and ONLY its anti-masking count can trip. */
export const FALSIFIERS: Readonly<Record<string, { leg: number; sql: string; note: string }>> = {
  "browser-role-grant": {
    leg: 8, note: "authenticated may EXECUTE the search routine",
    sql: "GRANT EXECUTE ON FUNCTION public.customer_diagnostic_search_v1"
      + "(uuid,timestamptz,timestamptz,uuid,text,text,text,integer,text,integer) TO authenticated",
  },
  "ledger-inactive-driver": {
    leg: 13, note: "a claim refused as inactive_driver sits in the ledger",
    sql: `INSERT INTO public.platform_job_runs (job_name, status, driver, started_at, finished_at, error)
          VALUES ('${CUSTOMER_DIAGNOSTIC_PRUNE_JOB_NAME}', 'skipped', 'worker',
                  now() - interval '1 hour', now() - interval '1 hour', 'inactive_driver')`,
  },
};

export interface NeutralityReceipt {
  schemaVersion: 1;
  legs: LegOutcome[];
  counts: Record<string, number>;
  outcomes: Record<string, string>;
  unknowns: string[];
  generatedAt: string;
}

/** Which provider-owned credentials the legs actually ran with. MEASURED over the composed env —
 *  unlike the module graph, which an ESM process cannot enumerate from the inside (`require.cache`
 *  covers CJS only, so a scan of it would report "none" whatever was loaded: a fake measurement), so
 *  `providerIndependence` below is labelled a declared design fact rather than a reading. */
export function providerEnvKeys(env: Record<string, string | undefined>): string[] {
  return Object.keys(env).filter((key) => /^(?:SUPABASE_|VERCEL_|NEXT_PUBLIC_SUPABASE|POSTGREST_)/.test(key)).sort();
}

export function buildNeutralityReceipt(input: {
  legs: LegOutcome[];
  migrationUnits: number;
  operatorId: string;
  database: string;
  dataLane: string;
  providerEnvKeys: string[];
  generatedAt?: string;
}): NeutralityReceipt {
  const status = (want: string) => input.legs.filter((leg) => leg.status === want).length;
  const failed = status("fail");
  const unknown = status("unknown");
  return {
    schemaVersion: 1,
    legs: input.legs.map((leg) => ({ ...leg })),
    counts: {
      legs: input.legs.length, pass: status("pass"), fail: failed, unknown,
      migrationUnits: input.migrationUnits, providerEnvKeys: input.providerEnvKeys.length,
    },
    outcomes: {
      // A leg this harness could not establish is an unknown, never a pass, and an unknown
      // never produces a green verdict — the fail-closed rule the readiness packet also obeys.
      verdict: failed === 0 && unknown === 0 ? "pass" : "fail",
      bundle: "node-postgres",
      // Measured: the lane the shipped resolver actually chose, and the provider credentials present.
      dataLane: resolveLaneKindLabel(input.dataLane),
      providerEnvKeys: input.providerEnvKeys.length === 0 ? "none" : input.providerEnvKeys.join(", "),
      // Declared, not measured — see `providerEnvKeys` above for why the module graph is not readable.
      providerIndependence: "declared design fact (ADR 003): application-owned core behind ports",
      migrationSource: "db/platform/migrations (manifest-bound)",
      pruneDriver: `${CUSTOMER_DIAGNOSTIC_PRUNE_JOB_NAME} via node_cron, driver=worker`,
      deliveryHealth: "unknown",
      operator: fingerprint(input.operatorId),
      database: fingerprint(input.database),
    },
    unknowns: input.legs.filter((leg) => leg.status === "unknown").map((leg) => `${leg.name}: ${leg.detail}`),
    generatedAt: input.generatedAt ?? new Date().toISOString(),
  };
}

const resolveLaneKindLabel = (kind: string) => `${kind} (measured via resolveCustomerDiagnosticLane)`;

export function readFlag(argv: readonly string[], name: string): string | undefined {
  const prefixed = argv.find((entry) => entry.startsWith(`--${name}=`));
  if (prefixed) return prefixed.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/** `docker exec … pg_isready` is the portable probe — never a macOS-local `/opt/homebrew/.../pg_isready`,
 *  which would fail the `lane: "tooling"` ubuntu runner. It can still report READY during the image
 *  entrypoint's temporary socket-only server, so `connectWhenReady` closes that window host-side. */
async function startProbeContainer(name: string): Promise<string> {
  await exec("docker", ["run", "--detach", "--rm", "--name", name, "-e", "POSTGRES_PASSWORD=postgres",
    "-e", "POSTGRES_DB=platform", "-p", "127.0.0.1::5432", IMAGE]);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { await exec("docker", ["exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "platform"]); break; }
    catch { await pause(1_000); }
  }
  const { stdout } = await exec("docker", ["port", name, "5432/tcp"]);
  const port = stdout.trim().split("\n")[0]?.split(":").pop()?.trim();
  if (!port) throw new Error("docker published no port for the probe container");
  return `postgres://postgres:postgres@127.0.0.1:${port}/platform`;
}

const removeContainer = (name: string) => exec("docker", ["rm", "-f", "-v", name]).then(() => undefined, () => undefined);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A freshly booted container can accept a socket before it accepts a session; retry, briefly. */
async function connectWhenReady(client: { connect(): Promise<unknown> }, attempts = 30): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await client.connect();
      return;
    } catch (error) {
      if (attempt >= attempts) throw error;
      await pause(1_000);
    }
  }
}

/** ⚠ A PROOF THE CALLER ASKED FOR MUST NOT PASS WHEN DOCKER CANNOT SERVE IT. The vanilla-pg replay
 *  spike exits 0 there, right for a spike and wrong for a gate; the focused-proof lane owns skipping,
 *  so this refuses and the runner turns the refusal into its own exit code. */
export class DockerUnavailableError extends Error {
  constructor() { super("docker is required for this row-bearing proof and is not serving requests"); }
}
async function adminUrlForRun(container: string | null, databaseUrl?: string): Promise<string> {
  if (!container) return databaseUrl ?? requireEnv("DATABASE_URL");
  try {
    await exec("docker", ["info"]);
  } catch {
    throw new DockerUnavailableError();
  }
  return startProbeContainer(container);
}

/** Seed the disposable database, run the legs on one dedicated connection, build the receipt. */
async function proveOn(probeUrl: string, pool: Pool, units: number, falsifier?: string): Promise<NeutralityReceipt> {
  const client = await pool.connect();
  const operatorId = randomUUID();
  try {
    // Flipping the seeded control row IS part of the proof: Wave 4 made ingest fail closed unless
    // the drain is enabled, and the portable migration ships the row disabled.
    const enabled = await client.query(
      "UPDATE public.platform_job_controls SET enabled = true WHERE job_name = $1",
      [CUSTOMER_DIAGNOSTIC_PRUNE_JOB_NAME]);
    if (enabled.rowCount !== 1) throw new Error("the portable chain seeded no prune control row to enable");
    await client.query(
      "INSERT INTO public.platform_communication_operators (principal_id, active) VALUES ($1, true)", [operatorId]);
    if (falsifier !== undefined) {
      const planted = FALSIFIERS[falsifier]!;
      await client.query(planted.sql);
      process.stdout.write(`[neutrality] falsifier planted (leg ${planted.leg}): ${planted.note}\n`);
    }
    const env = composeEnv(probeUrl);
    const context: NeutralityContext = { env, query: (text, values) => client.query(text, values), operatorId };
    return buildNeutralityReceipt({
      legs: await runNeutralityLegs(context), migrationUnits: units, operatorId, database: probeUrl,
      dataLane: resolveCustomerDiagnosticLane(env).kind, providerEnvKeys: providerEnvKeys(env),
    });
  } finally {
    await closeCustomerDiagnosticRuntimeLanes();
    client.release();
  }
}

async function proveDatabase(adminUrl: string, falsifier?: string): Promise<NeutralityReceipt> {
  const pg = await import("pg");
  const admin = new URL(adminUrl);
  admin.pathname = "/postgres";
  const probe = new URL(admin);
  probe.pathname = `/${PROBE}`;
  const probeUrl = probe.toString();
  const control = new pg.default.Client({ connectionString: admin.toString() });
  await connectWhenReady(control);
  try {
    await control.query(`DROP DATABASE IF EXISTS ${PROBE}`);
    await control.query(`CREATE DATABASE ${PROBE}`);
    const pool = new pg.default.Pool({ connectionString: probeUrl });
    try {
      const applied = await createPostgresMigrationRunner({ connectionString: probeUrl },
        { poolFactory: () => pool }).apply();
      process.stdout.write(`[neutrality] applied ${applied.applied.length} platform migration unit(s)\n`);
      return await proveOn(probeUrl, pool, applied.applied.length, falsifier);
    } finally {
      await pool.end();
    }
  } finally {
    await control.query(`DROP DATABASE IF EXISTS ${PROBE}`).catch(() => {});
    await control.end();
  }
}

export interface RunProofOptions {
  /** One of `FALSIFIERS`; plants a defect, and the leg it names must go red. */
  falsifier?: string;
  /** Admin connection to use instead of the disposable container this run would otherwise own. */
  databaseUrl?: string;
  /** Receipt destination; defaults to `DEFAULT_OUT`. */
  out?: string;
  log?: (line: string) => void;
}

/**
 * The whole proof: container, disposable database, thirteen legs, receipt on disk. Returns the
 * receipt; the caller owns the exit code, because this file may not be an execution entrypoint.
 */
export async function runProof(options: RunProofOptions = {}): Promise<NeutralityReceipt> {
  const out = options.out ?? DEFAULT_OUT;
  const log = options.log ?? ((line: string) => { process.stdout.write(`${line}\n`); });
  if (options.falsifier !== undefined && !(options.falsifier in FALSIFIERS)) throw new Error(
    `unknown falsifier "${options.falsifier}"; known: ${Object.keys(FALSIFIERS).join(", ")}`);
  // A supplied admin URL is honoured; otherwise this run owns its own container.
  const external = options.databaseUrl?.trim() || process.env.DATABASE_URL?.trim();
  const container = external ? null : `customer-diagnostic-neutrality-${process.pid}`;
  if (container) for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => { void removeContainer(container).then(() => process.exit(130)); });
  }
  let receipt: NeutralityReceipt;
  try {
    receipt = await proveDatabase(await adminUrlForRun(container, external), options.falsifier);
  } finally {
    if (container) await removeContainer(container);
  }

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(receipt, null, 2)}\n`);
  for (const leg of receipt.legs) log(`[neutrality] ${String(leg.id).padStart(2, "0")} ${leg.status.toUpperCase().padEnd(7)} ${leg.name}: ${leg.detail}`);
  log(`[neutrality] receipt -> ${out}`);
  log(receipt.outcomes.verdict === "pass"
    ? `[neutrality] OK — ${receipt.counts.pass}/${receipt.counts.legs} legs row-bearing on vanilla PostgreSQL`
    : `[neutrality] FAILED — ${receipt.counts.fail} leg(s) failed and ${receipt.counts.unknown} unknown`);
  return receipt;
}

/** One env for every leg; the ingress key lives here and nowhere else. */
export function composeEnv(connectionString: string): Record<string, string | undefined> {
  return {
    PLATFORM_BUNDLE: "node-postgres",
    DATABASE_URL: connectionString,
    APP_BASE_URL: "https://customer-diagnostic-neutrality.local",
    COMMERCE_CUSTOMER_DIAGNOSTIC_HISTORY_ENABLED: "true",
    VITE_COMMERCE_CUSTOMER_DIAGNOSTIC_HISTORY_ENABLED: "true",
    COMMERCE_CUSTOMER_DIAGNOSTIC_PRUNE_ENABLED: "true",
    CUSTOMER_DIAGNOSTIC_RETENTION_DAYS: "14",
    CUSTOMER_DIAGNOSTIC_INGRESS_KEY: randomBytes(32).toString("hex"),
  };
}
