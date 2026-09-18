// Retention runtime for the customer diagnostic history.
//
// It ships beside the ingest binding rather than inside it for two reasons.
// The binding refuses everything when collection is off, and retention must
// drain exactly then; and the binding is already close enough to the 300-line
// cap that this entrypoint would push it over.
//
// No `VercelRequest` reaches this file: the cron route owns the method and
// `CRON_SECRET` gates (`api/_cron/authorizeCron.ts`) and the Node scheduler
// calls the same function in-process with its own invocation source.

import { createCustomerDiagnosticHistoryPort } from "../../adapters/customerDiagnosticHistory.js";
import { PgGatewayClient, type PgQueryExecutor } from "../../adapters/postgres/queryBuilder.js";
import { createPostgresPlatformJobRunLedger } from "../../adapters/postgres/platformJobRunLedger.js";
import {
  claimJobRunV3,
  createSupabasePlatformJobRunLedger,
  finishJobRunV3,
  type PlatformJobSupabaseClient,
} from "../../adapters/supabase/platformJobRunLedger.js";
import {
  CUSTOMER_DIAGNOSTIC_PRUNE_JOB_NAME,
  pruneCustomerDiagnosticHistory,
} from "../../domains/observability/customerDiagnosticPruneJob.js";
import type {
  PlatformJobBackstopState,
  PlatformJobClaim,
  PlatformJobFinishStatus,
  PlatformJobFinishSummary,
  PlatformJobInvocation,
} from "../../domains/platform/platformJobRunLedger.js";
import {
  CustomerDiagnosticConfigurationError,
  readCustomerDiagnosticRetentionDays,
  resolveCustomerDiagnosticLane,
  type CustomerDiagnosticLane,
  type CustomerDiagnosticLaneOptions,
} from "./customerDiagnosticHistoryBinding.js";

export { CUSTOMER_DIAGNOSTIC_PRUNE_JOB_NAME };

type Env = Record<string, string | undefined>;

export const CUSTOMER_DIAGNOSTIC_PRUNE_ROUTE = "/api/cron/customer-diagnostic-prune";
/** The poker's backstop header; named here so the route carries no brand literal. */
export const CUSTOMER_DIAGNOSTIC_PRUNE_BACKSTOP_HEADER = "x-openlup-cron-backstop";
export const CUSTOMER_DIAGNOSTIC_PRUNE_LEASE_SECONDS = 300;
/**
 * The freshness window is the job's own daily period, so a poker ticking every
 * fifteen minutes performs at most one drain a day and every other tick answers
 * `primary_fresh` without claiming a lease.
 */
export const CUSTOMER_DIAGNOSTIC_PRUNE_BACKSTOP_FRESH_MINUTES = 1_440;

/** The lease and attempt surface this job needs, on either lane. */
export interface CustomerDiagnosticPruneLedger {
  claim(invocation: PlatformJobInvocation): Promise<PlatformJobClaim>;
  finish(
    runId: string,
    invocation: PlatformJobInvocation,
    status: PlatformJobFinishStatus,
    summary: PlatformJobFinishSummary,
    extraMetadata?: Record<string, unknown>,
  ): Promise<void>;
  readBackstopState(): Promise<PlatformJobBackstopState | null>;
}

export interface CustomerDiagnosticPruneRuntimeOptions extends CustomerDiagnosticLaneOptions {
  createPort?: typeof createCustomerDiagnosticHistoryPort;
  createLedger?: (lane: CustomerDiagnosticLane, client: unknown, env: Env) => CustomerDiagnosticPruneLedger;
}

/** What `cron-poker.yml` puts in `x-scheduler-source` when a leg declares one. */
export const CUSTOMER_DIAGNOSTIC_PRUNE_POKER_SOURCES: readonly string[] = [
  "github_actions_poker_schedule",
  "github_actions_poker_dispatch",
];

/**
 * Attribution, never authority: an unheaderd POST still executes, but it can
 * only ever be recorded as `unattributed_post` — the repo's convention for a
 * caller that did not identify itself (`subscriptionRenewalInvocation.ts`).
 */
export function resolveCustomerDiagnosticPruneInvocationSource(schedulerSource?: string | null): string {
  const declared = schedulerSource?.trim() ?? "";
  return CUSTOMER_DIAGNOSTIC_PRUNE_POKER_SOURCES.includes(declared) ? "github_poker" : "unattributed_post";
}

export interface CustomerDiagnosticPruneRequest {
  env?: Env;
  /** Set by an in-process caller that knows its own identity, e.g. `node_cron`. */
  invocationSource?: string;
  /** `x-scheduler-source`, relayed by the route; only a poker value attributes. */
  schedulerSource?: string | null;
  /** `CUSTOMER_DIAGNOSTIC_PRUNE_BACKSTOP_HEADER`, relayed by the route; `freshness` self-skips. */
  backstopMode?: string | null;
  batchSize?: number;
  maxBatches?: number;
  now?: () => number;
  options?: CustomerDiagnosticPruneRuntimeOptions;
}

export type CustomerDiagnosticPruneResponse = { status: number; body: Record<string, unknown> };

/**
 * Run one retention pass. The ingest flag is deliberately not read here: a
 * closed collection still owes its stored rows a drain.
 */
export async function runCustomerDiagnosticPrune(
  request: CustomerDiagnosticPruneRequest = {},
): Promise<CustomerDiagnosticPruneResponse> {
  const env = request.env ?? process.env;
  const options = request.options ?? {};
  const backstopMode = request.backstopMode?.trim() || null;
  if (backstopMode && backstopMode !== "freshness") {
    return { status: 400, body: { ok: false, error: "invalid_customer_diagnostic_prune_backstop" } };
  }
  if (env.COMMERCE_CUSTOMER_DIAGNOSTIC_PRUNE_ENABLED !== "true") {
    return { status: 200, body: { ok: true, skipped: "mutations_disabled" } };
  }
  const retentionDays = readCustomerDiagnosticRetentionDays(env);
  if (!retentionDays) {
    return { status: 503, body: { ok: false, error: "customer_diagnostic_history_configuration_invalid" } };
  }

  let lane: CustomerDiagnosticLane;
  try {
    lane = resolveCustomerDiagnosticLane(env, options);
  } catch (error) {
    if (error instanceof CustomerDiagnosticConfigurationError) {
      return { status: 503, body: { ok: false, error: error.message } };
    }
    throw error;
  }

  const invocation: PlatformJobInvocation = {
    triggerKind: "worker",
    invocationSource: request.invocationSource?.trim()
      || resolveCustomerDiagnosticPruneInvocationSource(request.schedulerSource),
  };
  const createPort = options.createPort ?? createCustomerDiagnosticHistoryPort;
  const now = request.now ?? (() => Date.now());

  return pruneScope(lane, env, options).run(async ({ client, ledger }) => {
    if (backstopMode === "freshness") {
      const skip = await backstopSkip(ledger, now);
      if (skip) return skip;
    }
    const lease = await ledger.claim(invocation);
    if (!lease.acquired || !lease.runId) {
      return { status: 200, body: { ok: true, skipped: true, reason: lease.reason } };
    }
    try {
      const summary = await pruneCustomerDiagnosticHistory({
        port: createPort(client, retentionDays),
        batchSize: request.batchSize,
        maxBatches: request.maxBatches,
        now,
      });
      await ledger.finish(lease.runId, invocation, "success", {
        checked: summary.batches,
        updated: summary.deleted,
        failures: 0,
        skipped: false,
      }, {
        eventsDeleted: summary.eventsDeleted,
        segmentsDeleted: summary.segmentsDeleted,
        limitsDeleted: summary.limitsDeleted,
        accessDeleted: summary.accessDeleted,
        morePossible: summary.morePossible,
        driver: invocation.invocationSource,
      });
      return { status: 200, body: { ok: true, ...summary } };
    } catch (error) {
      const reason = safeMessage(error);
      await ledger.finish(lease.runId, invocation, "failed", {
        checked: 0, updated: 0, failures: 1, skipped: false, reason,
      }, { driver: invocation.invocationSource });
      return { status: 500, body: { ok: false, error: "customer_diagnostic_prune_failed", reason } };
    }
  });
}

interface PruneScopeContext {
  client: unknown;
  ledger: CustomerDiagnosticPruneLedger;
}

/**
 * One statement, one transaction — on the portable lane the shared lane wraps
 * every callback in a single BEGIN/COMMIT, so a failing prune batch would abort
 * the transaction that also holds the claim: the `failed` finish would raise
 * 25P02 and the claim would roll away, leaving no attempt row at all. Giving the
 * ledger and the port a per-statement executor (the shape
 * `promotionClaimsBinding` already uses) keeps the claim, each batch and the
 * finish independently committed. The managed lane has no such transaction and
 * keeps its single `asService` scope.
 */
function pruneScope(
  lane: CustomerDiagnosticLane,
  env: Env,
  options: CustomerDiagnosticPruneRuntimeOptions,
): { run<T>(body: (context: PruneScopeContext) => Promise<T>): Promise<T> } {
  const createLedger = options.createLedger ?? createPruneLedger;
  if (lane.kind === "postgres") {
    const executor: PgQueryExecutor = {
      query: (text, values) => lane.run((client) => (client as PgQueryExecutor).query(text, values)),
    };
    const context: PruneScopeContext = {
      client: new PgGatewayClient(executor),
      ledger: createLedger(lane, executor, env),
    };
    return { run: (body) => body(context) };
  }
  return {
    run: (body) => lane.run((client) => body({ client, ledger: createLedger(lane, client, env) })),
  };
}

/**
 * The poker's freshness backstop: answer before claiming anything when the
 * primary drain already succeeded inside the window. A failing read refuses
 * rather than running, under a fixed code — the adapter's own message (on the
 * managed lane the OmniPack-named `omnipack_cron_backstop_read_failed`, on the
 * portable lane a driver error) stays out of the HTTP body and is recorded in
 * the runbook instead.
 */
async function backstopSkip(
  ledger: CustomerDiagnosticPruneLedger,
  now: () => number,
): Promise<CustomerDiagnosticPruneResponse | null> {
  let state: PlatformJobBackstopState | null;
  try {
    state = await ledger.readBackstopState();
  } catch {
    return { status: 503, body: { ok: false, error: "customer_diagnostic_prune_backstop_unavailable" } };
  }
  if (!primaryIsFresh(state, now())) return null;
  return {
    status: 200,
    body: { ok: true, skipped: true, reason: "primary_fresh", lastSuccessAt: state!.lastSuccessAt },
  };
}

function primaryIsFresh(state: PlatformJobBackstopState | null, nowMs: number): boolean {
  if (!state?.lastSuccessAt || state.lastStatus === "failed") return false;
  const lastSuccessMs = Date.parse(state.lastSuccessAt);
  if (!Number.isFinite(lastSuccessMs)) return false;
  return nowMs - lastSuccessMs <= CUSTOMER_DIAGNOSTIC_PRUNE_BACKSTOP_FRESH_MINUTES * 60_000;
}

/**
 * The managed claim and finish go through the v3 FREE functions on purpose:
 * the ledger object's own methods coerce `invocationSource` back into a driver
 * name, and `github_poker` is not one, so they would refuse the claim with
 * `platform_job_invalid_invocation`. The ledger object is still constructed for
 * `readJobBackstopState`, which exists only there and is a plain
 * `platform_job_controls` select that never reaches that coercion.
 */
function createPruneLedger(
  lane: CustomerDiagnosticLane,
  client: unknown,
  env: Env,
): CustomerDiagnosticPruneLedger {
  if (lane.kind === "postgres") {
    const ledger = createPostgresPlatformJobRunLedger(client as PgQueryExecutor, env);
    return {
      claim: (invocation) => ledger.claimJobRun(
        CUSTOMER_DIAGNOSTIC_PRUNE_JOB_NAME, invocation, CUSTOMER_DIAGNOSTIC_PRUNE_LEASE_SECONDS,
      ),
      finish: async (runId, invocation, status, summary, extraMetadata) => {
        await ledger.finishJobRun(
          CUSTOMER_DIAGNOSTIC_PRUNE_JOB_NAME, runId, invocation, status, summary, extraMetadata,
        );
      },
      readBackstopState: () => ledger.readJobBackstopState(CUSTOMER_DIAGNOSTIC_PRUNE_JOB_NAME),
    };
  }
  const managed = client as PlatformJobSupabaseClient;
  return {
    claim: (invocation) => claimJobRunV3(
      managed, CUSTOMER_DIAGNOSTIC_PRUNE_JOB_NAME, invocation, CUSTOMER_DIAGNOSTIC_PRUNE_LEASE_SECONDS,
    ),
    finish: (runId, _invocation, status, summary, extraMetadata) => finishJobRunV3(
      managed, CUSTOMER_DIAGNOSTIC_PRUNE_JOB_NAME, runId, status, summary, extraMetadata,
    ),
    readBackstopState: () => createSupabasePlatformJobRunLedger(managed, env)
      .readJobBackstopState(CUSTOMER_DIAGNOSTIC_PRUNE_JOB_NAME),
  };
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 240);
}
