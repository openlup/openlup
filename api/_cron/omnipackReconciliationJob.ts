import type { VercelRequest } from "../../server/_lib/types/vercel.js";
import { readAccountingRuntimeConfig } from "../../server/domains/accounting/accountingRuntimeConfig.js";
import { createSupabaseAccountingInvoicePort } from "../../server/adapters/supabase/accountingInvoicePort.js";
import {
  runOmnipackReconciliationWorker,
  type OmnipackReconciliationProvider,
  type OmnipackReconciliationResult,
} from "../../server/domains/fulfillment/omnipackReconciliationWorker.js";
import {
  createSupabaseOmnipackCronGateway,
  type SupabaseOmnipackCronGateway,
  type SupabaseOmnipackCronGatewayOptions,
} from "../../server/runtime/fulfillment/omnipackCronGateway.js";
import { readAccountingLedgerProviderKind } from "../../server/infra/accounting/providerFactory.js";
import {
  createOmnipackClient,
  readOmnipackClientConfig,
} from "../../server/infra/omnipack/client.js";
import { OmnipackProviderError } from "../../server/infra/omnipack/providerError.js";

type Env = Record<string, string | undefined> & {
  CRON_SECRET?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SUPABASE_URL?: string;
  VITE_SUPABASE_URL?: string;
};

export const OMNIPACK_RECONCILIATION_JOB_NAME = "omnipack-reconciliation";
const PAGINATION_METADATA_KEY = "omnipackReconciliationPagination";
const PAGINATION_METADATA_VERSION = 1;

class OmnipackCheckpointReadError extends Error {}

type GatewayFactory = (
  env: Env,
  options: SupabaseOmnipackCronGatewayOptions,
) => SupabaseOmnipackCronGateway | null;

export async function runOmnipackReconciliationCron(
  req: VercelRequest,
  env: Env = process.env,
  gatewayFactory: GatewayFactory = createDefaultGateway,
  providerFactory: (env: Env) => OmnipackReconciliationProvider | null = createProviderClient,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (req.method !== "GET" && req.method !== "POST") {
    return { status: 405, body: { ok: false, error: "method_not_allowed" } };
  }
  if (!env.CRON_SECRET) return { status: 500, body: { ok: false, error: "cron_secret_not_configured" } };
  if (bearerToken(req) !== env.CRON_SECRET) return { status: 401, body: { ok: false, error: "unauthorized" } };

  if (env.COMMERCE_OMNIPACK_RECONCILIATION_ENABLED !== "true") {
    return {
      status: 200,
      body: { ok: true, skipped: true, reason: "omnipack_reconciliation_disabled", checked: 0, updated: 0, failures: 0 },
    };
  }

  // Honour the scheduler driver so the DB-native pg_cron bridge (which forwards with
  // `x-openlup-scheduler-driver: pg_cron`) can claim the lease when
  // platform_job_controls.active_driver='pg_cron'. Without this the gateway would
  // always claim as 'vercel_cron' and a pg_cron-owned job would skip as
  // inactive_driver — the exact reason reconciliation went stale on preview (Vercel
  // cron does not fire), stranding paid holds. Validated before provider/gateway
  // construction (pure request validation); mirrors omnipack-stock-sync.
  const driverResult = readReconciliationDriver(req, env);
  if (driverResult.ok === false) return { status: driverResult.status, body: driverResult.body };

  const provider = providerFactory(env);
  if (!provider) {
    return { status: 503, body: { ok: false, error: "omnipack_provider_not_configured" } };
  }

  const accountingConfig = readAccountingRuntimeConfig(env);
  const gateway = gatewayFactory(env, {
    reconciliationAccountingEnabled: accountingConfig.requestEnabled && accountingConfig.issueTrigger === "handoff",
    accountingPortFactory: (client) => createSupabaseAccountingInvoicePort(client),
    accountingProviderKind: readAccountingLedgerProviderKind(env),
  });
  if (!gateway) {
    return { status: 500, body: { ok: false, error: "supabase_service_role_not_configured" } };
  }

  const batchSize = readOmnipackReconciliationBatchSize(env);
  let page = 0;
  try {
    const run = await gateway.runJob({
      jobName: OMNIPACK_RECONCILIATION_JOB_NAME,
      driver: driverResult.driver,
      operation: async ({ reconciliation }) => {
        try {
          const metadata = await gateway.readLatestTerminalRunMetadata(OMNIPACK_RECONCILIATION_JOB_NAME);
          page = readOmnipackReconciliationPage(metadata, batchSize);
        } catch {
          throw new OmnipackCheckpointReadError();
        }
        return runSafely(async () =>
          runOmnipackReconciliationWorker({ port: reconciliation, provider, batchSize, page })
        );
      },
      finish: (result) => ({
        status: result.ok ? "success" : "failed",
        result: {
          checked: result.checked,
          updated: result.updated,
          trackingRefs: result.trackingRefs,
          stateConflicts: result.stateConflicts,
          invoiceIssueFailures: result.invoiceIssueFailures,
          invoiceIssueRefused: result.invoiceIssueRefused,
          invoiceIssueRefusals: result.invoiceIssueRefusals,
          failures: result.failures,
          offTrackSkips: result.offTrackSkips,
          skipped: result.skipped,
          reason: result.reason,
        },
        extraMetadata: {
          stateConflicts: result.stateConflicts,
          invoiceIssueFailures: result.invoiceIssueFailures,
          invoiceIssueRefused: result.invoiceIssueRefused,
          invoiceIssueRefusals: result.invoiceIssueRefusals,
          // extraMetadata is the only persisted surface: the ledger adapter spreads
          // it into p_metadata and there is no `result` column
          // (server/adapters/supabase/platformJobRunLedger.ts:234-252).
          trackingRefs: result.trackingRefs,
          offTrackSkips: result.offTrackSkips,
          [PAGINATION_METADATA_KEY]: omnipackReconciliationPaginationMetadata(page, batchSize, result),
        },
      }),
    });
    if (run.acquired === false) {
      return { status: 200, body: { ok: true, skipped: true, reason: run.reason } };
    }

    const result = run.result;
    return {
      status: result.ok ? 200 : 502,
      body: result as unknown as Record<string, unknown>,
    };
  } catch (error) {
    if (error instanceof OmnipackCheckpointReadError) {
      return { status: 502, body: { ok: false, error: "omnipack_reconciliation_checkpoint_read_failed" } };
    }
    throw error;
  }
}

export function readOmnipackReconciliationBatchSize(env: Record<string, string | undefined>): number {
  const parsed = Number.parseInt(env.COMMERCE_OMNIPACK_RECONCILIATION_BATCH_LIMIT ?? "50", 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 50;
  return Math.min(parsed, 100);
}

export function readOmnipackReconciliationPage(metadata: unknown, pageSize: number): number {
  if (!isRecord(metadata)) return 0;
  const checkpoint = metadata[PAGINATION_METADATA_KEY];
  if (
    !isRecord(checkpoint)
    || checkpoint.version !== PAGINATION_METADATA_VERSION
    || checkpoint.pageSize !== pageSize
    || !isPage(checkpoint.page)
    || !isPage(checkpoint.nextPage)
    || !isValidPageTransition(checkpoint.page, checkpoint.nextPage)
  ) return 0;
  return checkpoint.nextPage;
}

export function omnipackReconciliationPaginationMetadata(
  page: number,
  pageSize: number,
  result: Pick<OmnipackReconciliationResult, "checked" | "ok">,
): { version: number; page: number; pageSize: number; nextPage: number } {
  // Advance on a full page, reset otherwise - independent of `ok`. A failed run
  // still returns 502 and still writes ledger `failed`; it just stops rewriting
  // the checkpoint to its own page, which is what starved two of three pages for
  // 21+ hours on 2026-09-09 (and, through the acceptance ack, on 2026-07-17).
  // This is already the canon scripts/checkpoint2-fulfillment-evidence.ts:126-129
  // computes and compares against, with no reference to `ok`. Every write in the
  // rail is idempotent by key, so a genuinely transient item-level failure is
  // retried a cycle later instead of immediately.
  const nextPage = result.checked === pageSize
    ? page < Number.MAX_SAFE_INTEGER ? page + 1 : 0
    : 0;
  return { version: PAGINATION_METADATA_VERSION, page, pageSize, nextPage };
}

function createProviderClient(env: Env): OmnipackReconciliationProvider | null {
  const config = readOmnipackClientConfig(env);
  return config ? createOmnipackClient(config) : null;
}

async function runSafely(operation: () => Promise<OmnipackReconciliationResult>): Promise<OmnipackReconciliationResult> {
  try {
    return await operation();
  } catch (error) {
    if (isPageExhausted(error)) {
      return emptyReconciliationResult({ ok: true, reason: "page_exhausted" });
    }
    return {
      ...emptyReconciliationResult({ ok: false, failures: 1 }),
      reason: safeMessage(error),
    };
  }
}

function emptyReconciliationResult(
  overrides: Partial<OmnipackReconciliationResult>,
): OmnipackReconciliationResult {
  return {
    ok: true,
    checked: 0,
    updated: 0,
    trackingRefs: 0,
    quarantined: 0,
    stateConflicts: 0,
    exceptions: 0,
    stale: 0,
    offTrackSkips: 0,
    replayed: 0,
    failures: 0,
    invoiceIssueFailures: 0,
    invoiceIssueRefused: 0,
    invoiceIssueRefusals: [],
    providerCalls: 0,
    readBacks: 0,
    skipped: false,
    ...overrides,
  };
}

function isPageExhausted(error: unknown): boolean {
  if (!(error instanceof OmnipackProviderError) || error.status !== 400) return false;
  return error.code === "ERR_PAGE_MUST_BE_LESS_THAN_TOTAL_PAGES";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPage(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isValidPageTransition(page: number, nextPage: number): boolean {
  return nextPage === 0 || nextPage === page || (page < Number.MAX_SAFE_INTEGER && nextPage === page + 1);
}

function createDefaultGateway(
  env: Env,
  options: SupabaseOmnipackCronGatewayOptions,
): SupabaseOmnipackCronGateway | null {
  return createSupabaseOmnipackCronGateway(env, undefined, options);
}

function bearerToken(req: VercelRequest): string | null {
  const auth = req.headers.authorization;
  const header = Array.isArray(auth) ? auth[0] : auth;
  return header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? null;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function isStagingOmnipackRuntime(env: Env): boolean {
  return env.HIDDEN_SANDBOX_PREVIEW_ENABLED === "true" ||
    env.openlup_ENVIRONMENT === "staging" ||
    env.STAGING_SUPABASE_PROJECT_REF === "abcdefghijklmnopqrst" ||
    env.HIDDEN_SANDBOX_SUPABASE_PROJECT_REF === "abcdefghijklmnopqrst";
}

// Resolve the scheduler driver from the request, mirroring readOmnipackSyncDriver.
// pg_cron and the portable worker are staging-only so production can never be
// driven off a non-Vercel rail by an unexpected header.
function readReconciliationDriver(
  req: VercelRequest,
  env: Env,
): { ok: true; driver?: "vercel_cron" | "pg_cron" | "worker" } | { ok: false; status: number; body: Record<string, unknown> } {
  const requested = firstHeader(req.headers["x-openlup-scheduler-driver"]) ??
    env.OMNIPACK_RECONCILIATION_DRIVER;
  if (requested !== undefined && requested !== "vercel_cron" && requested !== "pg_cron" && requested !== "worker") {
    return { ok: false, status: 400, body: { ok: false, error: "invalid_omnipack_reconciliation_driver" } };
  }
  if ((requested === "pg_cron" || requested === "worker") && !isStagingOmnipackRuntime(env)) {
    return {
      ok: false,
      status: 403,
      body: { ok: false, error: `${requested}_driver_requires_staging` },
    };
  }
  return { ok: true, driver: requested as "vercel_cron" | "pg_cron" | "worker" | undefined };
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 180);
}
