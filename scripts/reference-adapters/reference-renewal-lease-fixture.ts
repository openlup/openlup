import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

type Json = Record<string, unknown>;
type QueryResult = { data?: unknown; error?: { message?: string } | null };
type Query = PromiseLike<QueryResult> & {
  select(columns: string): Query;
  update(values: Json): Query;
  eq(column: string, value: string): Query;
};
type LeaseClient = { from(table: string): Query };
type PsqlRunner = (command: string, args: string[]) => { status: number | null };
type JobRun = { id: string; status: string | null; driver: string | null; trigger_source: string | null; error: string | null };

export const REFERENCE_RENEWAL_JOB_NAME = "subscription-renewal-runtime";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ReferenceRenewalLeaseManifest = {
  version: 1;
  jobName: typeof REFERENCE_RENEWAL_JOB_NAME;
  control: Json;
};

export type ReferenceRenewalLeaseEvidence = {
  jobName: typeof REFERENCE_RENEWAL_JOB_NAME;
  driver: "manual_admin";
  status: "success";
  createdRows: 1;
  deletedRows: 1;
  residualRows: 0;
  controlRestored: true;
};

export async function withReferenceRenewalLeaseFixture<T>(input: {
  client: LeaseClient;
  dbUrl: string;
  manifest: { referenceRenewalLease?: ReferenceRenewalLeaseManifest };
  persistManifest: () => void;
  run: () => Promise<T>;
  afterRun?: () => Promise<void>;
  psql?: string;
  runPsql?: PsqlRunner;
}): Promise<{ value: T; evidence: ReferenceRenewalLeaseEvidence }> {
  const lease = await snapshotLeaseState(input.client);
  input.manifest.referenceRenewalLease = lease;
  input.persistManifest();

  let value: T | undefined;
  let operationFailure: unknown;
  try {
    const enabled = await input.client.from("platform_job_controls").update({ enabled: true }).eq("job_name", REFERENCE_RENEWAL_JOB_NAME);
    if (enabled.error) throw new Error("Reference renewal control enable failed");
    value = await input.run();
    await input.afterRun?.();
  } catch (error) {
    operationFailure = error;
  }

  let evidence: ReferenceRenewalLeaseEvidence | undefined;
  let cleanupFailure: unknown;
  try {
    evidence = await restoreLeaseState(input.client, input.dbUrl, lease, operationFailure === undefined, input.psql, input.runPsql);
    delete input.manifest.referenceRenewalLease;
    input.persistManifest();
  } catch (error) {
    cleanupFailure = error;
  }
  if (operationFailure !== undefined) throw operationFailure;
  if (cleanupFailure !== undefined) throw cleanupFailure;
  return { value: value as T, evidence: evidence as ReferenceRenewalLeaseEvidence };
}

export async function recoverReferenceRenewalLease(
  client: LeaseClient,
  dbUrl: string,
  lease: ReferenceRenewalLeaseManifest,
  options: { psql?: string; runPsql?: PsqlRunner } = {},
): Promise<void> {
  await restoreLeaseState(client, dbUrl, validateLeaseManifest(lease), false, options.psql, options.runPsql);
}

export function localRenewalRunCleanupSql(id: string, control: Json): string {
  if (!UUID_PATTERN.test(id) || control.job_name !== REFERENCE_RENEWAL_JOB_NAME) throw new Error("Reference renewal cleanup requires one exact correlated row");
  const snapshot = JSON.stringify(control).replaceAll("'", "''");
  return [
    "BEGIN;",
    "DO $$ DECLARE",
    `  v_id uuid := '${id}'::uuid;`,
    `  v_snapshot jsonb := '${snapshot}'::jsonb;`,
    "  v_row public.platform_job_controls%ROWTYPE;",
    "BEGIN",
    `  SELECT * INTO v_row FROM public.platform_job_controls WHERE job_name = '${REFERENCE_RENEWAL_JOB_NAME}' FOR UPDATE;`,
    "  IF NOT FOUND OR v_row.last_run_id IS DISTINCT FROM v_id THEN RAISE EXCEPTION 'reference_renewal_control_correlation_lost'; END IF;",
    `  IF NOT EXISTS (SELECT 1 FROM public.platform_job_runs WHERE job_name = '${REFERENCE_RENEWAL_JOB_NAME}' AND id = v_id AND driver = 'manual_admin' AND trigger_source = 'manual_admin') THEN RAISE EXCEPTION 'reference_renewal_job_correlation_lost'; END IF;`,
    "  UPDATE public.platform_job_controls AS target SET",
    "    created_at = source.created_at, updated_at = source.updated_at, enabled = source.enabled, lease_owner = source.lease_owner, lease_token = source.lease_token,",
    "    lease_expires_at = source.lease_expires_at, lease_until = source.lease_until, last_started_at = source.last_started_at, last_finished_at = source.last_finished_at,",
    "    last_success_at = source.last_success_at, last_status = source.last_status, last_run_id = source.last_run_id, metadata = source.metadata,",
    "    active_driver = source.active_driver, allowed_trigger_kinds = source.allowed_trigger_kinds",
    "    FROM jsonb_populate_record(NULL::public.platform_job_controls, v_snapshot) AS source",
    `    WHERE target.job_name = '${REFERENCE_RENEWAL_JOB_NAME}';`,
    `  DELETE FROM public.platform_job_runs WHERE job_name = '${REFERENCE_RENEWAL_JOB_NAME}' AND id = v_id;`,
    `  IF EXISTS (SELECT 1 FROM public.platform_job_runs WHERE job_name = '${REFERENCE_RENEWAL_JOB_NAME}' AND id = v_id) THEN RAISE EXCEPTION 'reference_renewal_job_row_remains'; END IF;`,
    `  IF NOT EXISTS (SELECT 1 FROM public.platform_job_controls WHERE job_name = '${REFERENCE_RENEWAL_JOB_NAME}' AND to_jsonb(platform_job_controls) = v_snapshot) THEN RAISE EXCEPTION 'reference_renewal_control_not_restored'; END IF;`,
    "END $$;",
    "COMMIT;",
  ].join("\n");
}

async function snapshotLeaseState(client: LeaseClient): Promise<ReferenceRenewalLeaseManifest> {
  const control = await readControl(client);
  assertIdleControl(control);
  return { version: 1, jobName: REFERENCE_RENEWAL_JOB_NAME, control };
}

async function restoreLeaseState(
  client: LeaseClient,
  dbUrl: string,
  lease: ReferenceRenewalLeaseManifest,
  expectSuccess: boolean,
  psql?: string,
  runPsql?: PsqlRunner,
): Promise<ReferenceRenewalLeaseEvidence> {
  validateLoopbackDatabaseUrl(dbUrl);
  const valid = validateLeaseManifest(lease);
  const current = await readControl(client);
  const previousRunId = lastRunId(valid.control), candidateId = lastRunId(current);
  if (candidateId === previousRunId) {
    if (expectSuccess) throw new Error("Reference renewal lease emitted no exact run");
    const restored = { ...valid.control }; delete restored.job_name; delete restored.created_at;
    const update = await client.from("platform_job_controls").update(restored).eq("job_name", REFERENCE_RENEWAL_JOB_NAME);
    if (update.error) throw new Error("Reference renewal control restore failed");
    if (stableJson(await readControl(client)) !== stableJson(valid.control)) throw new Error("Reference renewal control restore readback failed");
    return { jobName: REFERENCE_RENEWAL_JOB_NAME, driver: "manual_admin", status: "success", createdRows: 1, deletedRows: 1, residualRows: 0, controlRestored: true };
  }
  if (!candidateId) throw new Error("Reference renewal control lost exact run correlation");
  const candidate = await readRunById(client, candidateId);
  if (!candidate || candidate.driver !== "manual_admin" || candidate.trigger_source !== "manual_admin" || !["running", "success", "failed"].includes(candidate.status ?? "")) throw new Error("Reference renewal run ownership is ambiguous");
  if (expectSuccess && (candidate.status !== "success" || candidate.error !== null)) throw new Error("Reference renewal lease evidence was not one successful manual_admin run");
  runExactPsql(dbUrl, candidateId, valid.control, psql, runPsql);
  if (await readRunById(client, candidateId)) throw new Error("Reference renewal run residual readback failed");
  if (stableJson(await readControl(client)) !== stableJson(valid.control)) throw new Error("Reference renewal control restore readback failed");
  return { jobName: REFERENCE_RENEWAL_JOB_NAME, driver: "manual_admin", status: "success", createdRows: 1, deletedRows: 1, residualRows: 0, controlRestored: true };
}

async function readControl(client: LeaseClient): Promise<Json> {
  const result = await client.from("platform_job_controls").select("*").eq("job_name", REFERENCE_RENEWAL_JOB_NAME);
  const rows = jsonRows(result.data);
  if (result.error || rows.length !== 1 || rows[0]?.job_name !== REFERENCE_RENEWAL_JOB_NAME) throw new Error("Reference renewal control snapshot failed");
  return rows[0]!;
}

async function readRunById(client: LeaseClient, id: string): Promise<JobRun | null> {
  const result = await client.from("platform_job_runs").select("id,status,driver,trigger_source,error").eq("id", id).eq("job_name", REFERENCE_RENEWAL_JOB_NAME);
  const rows = jsonRows(result.data);
  if (result.error || rows.length > 1) throw new Error("Reference renewal exact run readback failed");
  if (!rows.length) return null;
  const row = rows[0]!;
  if (row.id !== id) throw new Error("Reference renewal exact run id mismatch");
  return { id, status: nullableString(row.status), driver: nullableString(row.driver), trigger_source: nullableString(row.trigger_source), error: nullableString(row.error) };
}

function runExactPsql(dbUrl: string, id: string, control: Json, psql?: string, run?: PsqlRunner): void {
  const runner = run ?? ((command, args) => spawnSync(command, args, { stdio: "ignore", env: { PATH: process.env.PATH } }));
  const command = psql ?? localPsql();
  if (runner(command, [dbUrl, "-v", "ON_ERROR_STOP=1", "-q", "-c", localRenewalRunCleanupSql(id, control)]).status !== 0) throw new Error("Reference renewal run cleanup failed");
}

function validateLeaseManifest(lease: ReferenceRenewalLeaseManifest): ReferenceRenewalLeaseManifest {
  if (lease.version !== 1 || lease.jobName !== REFERENCE_RENEWAL_JOB_NAME || !lease.control || lease.control.job_name !== REFERENCE_RENEWAL_JOB_NAME) {
    throw new Error("Invalid reference renewal lease recovery manifest");
  }
  assertIdleControl(lease.control);
  return lease;
}

function assertIdleControl(control: Json): void {
  if (control.enabled !== false || [control.lease_owner, control.lease_token, control.lease_until, control.lease_expires_at].some((value) => value !== null)) throw new Error("Reference renewal fixture requires a disabled idle control");
  lastRunId(control);
}
function lastRunId(control: Json): string | null {
  if (control.last_run_id === null) return null;
  if (typeof control.last_run_id !== "string" || !UUID_PATTERN.test(control.last_run_id)) throw new Error("Reference renewal control has an invalid last run id");
  return control.last_run_id;
}

function validateLoopbackDatabaseUrl(raw: string): void {
  try {
    const url = new URL(raw);
    if ((url.protocol !== "postgres:" && url.protocol !== "postgresql:") || url.search || url.hash || !["127.0.0.1", "::1"].includes(url.hostname.replace(/^\[|\]$/g, "").toLowerCase())) throw new Error();
  } catch {
    throw new Error("Reference renewal lease cleanup requires a loopback database URL");
  }
}

function localPsql(): string {
  const command = [process.env.PSQL, "/opt/homebrew/opt/libpq/bin/psql", "/usr/local/bin/psql", "psql"].filter((value): value is string => Boolean(value)).find((candidate) => candidate === "psql" || existsSync(candidate));
  if (!command) throw new Error("psql is required for reference renewal lease cleanup");
  return command;
}

function jsonRows(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter((row): row is Json => typeof row === "object" && row !== null && !Array.isArray(row)) : [];
}
function nullableString(value: unknown): string | null { return typeof value === "string" ? value : null; }
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Json).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
