import type { VercelRequest } from "../../server/_lib/types/vercel.js";
import {
  runOmnipackStockSyncWorker,
  type OmnipackStockSyncProvider,
  type OmnipackStockSyncResult,
} from "../../server/domains/fulfillment/omnipackStockSyncWorker.js";
import {
  createSupabaseOmnipackCronGateway,
  type SupabaseOmnipackCronGateway,
  type SupabaseOmnipackCronGatewayOptions,
} from "../../server/runtime/fulfillment/omnipackCronGateway.js";
import {
  createOmnipackClient,
  readOmnipackClientConfig,
} from "../../server/infra/omnipack/client.js";
import {
  OmnipackProviderError,
  sanitizeOmnipackProviderError,
  type SanitizedOmnipackProviderError,
} from "../../server/infra/omnipack/providerError.js";
import { loadOmnipackMerchantDictionary } from "../../server/infra/omnipack/loadMerchantDictionary.js";
import { KNOWN_OMNIPACK_PACKAGING_SKUS } from "../../server/infra/omnipack/merchantDictionaryStock.js";

type Env = Record<string, string | undefined> & {
  CRON_SECRET?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SUPABASE_URL?: string;
  VITE_SUPABASE_URL?: string;
};

export const OMNIPACK_STOCK_SYNC_JOB_NAME = "omnipack-stock-sync";
export const OMNIPACK_STOCK_SYNC_BACKSTOP_FRESH_MINUTES = 75;

type OmnipackStockSyncCronResult = OmnipackStockSyncResult & {
  providerError?: SanitizedOmnipackProviderError;
};

type GatewayFactory = (
  env: Env,
  options: SupabaseOmnipackCronGatewayOptions,
) => SupabaseOmnipackCronGateway | null;

export async function runOmnipackStockSyncCron(
  req: VercelRequest,
  env: Env = process.env,
  gatewayFactory: GatewayFactory = createDefaultGateway,
  providerFactory: (env: Env) => OmnipackStockSyncProvider | null = createProviderClient,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (req.method !== "GET" && req.method !== "POST") {
    return { status: 405, body: { ok: false, error: "method_not_allowed" } };
  }
  if (!env.CRON_SECRET) return { status: 500, body: { ok: false, error: "cron_secret_not_configured" } };
  if (bearerToken(req) !== env.CRON_SECRET) return { status: 401, body: { ok: false, error: "unauthorized" } };

  if (env.COMMERCE_OMNIPACK_STOCK_SYNC_ENABLED !== "true") {
    return {
      status: 200,
      body: { ok: true, skipped: true, reason: "omnipack_stock_sync_disabled", checked: 0, updated: 0, failures: 0 },
    };
  }

  // Honour the scheduler driver so the DB-native pg_cron bridge (which forwards
  // with `x-openlup-scheduler-driver: pg_cron`) can claim the lease when
  // platform_job_controls.active_driver='pg_cron'. Without this the gateway would
  // always claim as 'vercel_cron' and a pg_cron-owned job would skip as
  // inactive_driver (breaking the unsinkable stock sync). Validated before
  // provider/gateway construction (pure request validation); mirrors outbox-dispatch.
  const driverResult = readOmnipackSyncDriver(req, env);
  if (driverResult.ok === false) return { status: driverResult.status, body: driverResult.body };

  const backstopMode = firstHeader(req.headers["x-openlup-cron-backstop"]);
  if (backstopMode && backstopMode !== "freshness") {
    return { status: 400, body: { ok: false, error: "invalid_omnipack_stock_sync_backstop" } };
  }
  let provider = backstopMode === "freshness" ? null : providerFactory(env);
  if (backstopMode !== "freshness" && !provider) {
    return { status: 503, body: { ok: false, error: "omnipack_provider_not_configured" } };
  }

  const dictionary = loadOmnipackMerchantDictionary(env).dictionary;
  const stockInventoryClasses = new Map<string, "sellable" | "packaging">(
    KNOWN_OMNIPACK_PACKAGING_SKUS.map((sku) => [sku, "packaging"]),
  );
  for (const { sku, inventoryClass } of dictionary?.stockSkus ?? []) {
    stockInventoryClasses.set(sku, inventoryClass);
  }
  const gateway = gatewayFactory(env, { stockInventoryClasses });
  if (!gateway) {
    return { status: 500, body: { ok: false, error: "supabase_service_role_not_configured" } };
  }
  if (backstopMode === "freshness") {
    if (!gateway.readJobBackstopState) {
      return { status: 500, body: { ok: false, error: "omnipack_stock_sync_backstop_not_supported" } };
    }
    let state: Awaited<ReturnType<NonNullable<typeof gateway.readJobBackstopState>>>;
    try {
      state = await gateway.readJobBackstopState(OMNIPACK_STOCK_SYNC_JOB_NAME);
    } catch {
      return { status: 503, body: { ok: false, error: "omnipack_stock_sync_backstop_read_failed" } };
    }
    if (primaryStockSyncIsFresh(state, new Date())) {
      return {
        status: 200,
        body: { ok: true, skipped: true, reason: "primary_fresh", lastSuccessAt: state!.lastSuccessAt },
      };
    }
  }

  provider ??= providerFactory(env);
  if (!provider) {
    return { status: 503, body: { ok: false, error: "omnipack_provider_not_configured" } };
  }

  const run = await gateway.runJob({
    jobName: OMNIPACK_STOCK_SYNC_JOB_NAME,
    driver: driverResult.driver,
    operation: ({ stockSync }) =>
      runSafely(async () =>
        runOmnipackStockSyncWorker({
          port: stockSync,
          provider,
          movementBatchSize: readOmnipackStockMovementBatchSize(env),
        }), async (reason) => {
          await stockSync.recordCursor({
            status: "failed",
            lastStockSyncedAt: null,
            lastMovementOccurredAt: null,
            cursor: {},
            error: { reason },
          });
        }
      ),
    finish: (result) => ({
      status: result.ok ? "success" : "failed",
      result: {
        checked: result.checked,
        updated: result.updated,
        failures: result.failures,
        skipped: result.skipped,
        reason: result.reason,
      },
      extraMetadata: result.providerError ? {
        providerError: {
          operation: result.providerError.operation,
          status: result.providerError.status,
          code: result.providerError.code,
          retryable: result.providerError.retryable,
          mayHaveSucceeded: result.providerError.mayHaveSucceeded,
        },
      } : undefined,
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
}

export function readOmnipackStockMovementBatchSize(env: Record<string, string | undefined>): number {
  const parsed = Number.parseInt(env.COMMERCE_OMNIPACK_STOCK_MOVEMENT_BATCH_LIMIT ?? "100", 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 100;
  return Math.min(parsed, 250);
}

function createProviderClient(env: Env): OmnipackStockSyncProvider | null {
  const config = readOmnipackClientConfig(env);
  return config ? createOmnipackClient(config) : null;
}

function createDefaultGateway(
  env: Env,
  options: SupabaseOmnipackCronGatewayOptions,
): SupabaseOmnipackCronGateway | null {
  return createSupabaseOmnipackCronGateway(env, undefined, options);
}

async function runSafely(
  operation: () => Promise<OmnipackStockSyncResult>,
  markFailed: (reason: string) => Promise<void>,
): Promise<OmnipackStockSyncCronResult> {
  try {
    return await operation();
  } catch (error) {
    const reason = safeMessage(error);
    const providerError = error instanceof OmnipackProviderError
      ? sanitizeOmnipackProviderError(error)
      : undefined;
    await markFailed(reason).catch(() => undefined);
    return {
      ok: false,
      checked: 0,
      updated: 0,
      mismatches: 0,
      reservationCoverage: 0,
      unclassified: 0,
      lowStock: 0,
      movements: 0,
      replayed: 0,
      failures: 1,
      providerCalls: 0,
      readBacks: 0,
      skipped: false,
      reason,
      ...(providerError ? { providerError } : {}),
      syncRunId: "omnipack-stock-sync:failed-before-run",
      lastMovementOccurredAt: null,
    };
  }
}

function primaryStockSyncIsFresh(
  state: { lastStatus: string | null; lastSuccessAt: string | null } | null,
  now: Date,
): boolean {
  if (!state?.lastSuccessAt || state.lastStatus === "failed") return false;
  const lastSuccessMs = Date.parse(state.lastSuccessAt);
  if (!Number.isFinite(lastSuccessMs)) return false;
  return now.getTime() - lastSuccessMs <= OMNIPACK_STOCK_SYNC_BACKSTOP_FRESH_MINUTES * 60_000;
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

// Resolve the scheduler driver from the request, mirroring readOutboxDispatchDriver.
// pg_cron and the portable worker are staging-only so production can never be
// driven off a non-Vercel rail by an unexpected header.
function readOmnipackSyncDriver(
  req: VercelRequest,
  env: Env,
): { ok: true; driver?: "vercel_cron" | "pg_cron" | "worker" } | { ok: false; status: number; body: Record<string, unknown> } {
  const requested = firstHeader(req.headers["x-openlup-scheduler-driver"]) ??
    env.OMNIPACK_STOCK_SYNC_DRIVER;
  if (requested !== undefined && requested !== "vercel_cron" && requested !== "pg_cron" && requested !== "worker") {
    return { ok: false, status: 400, body: { ok: false, error: "invalid_omnipack_stock_sync_driver" } };
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
