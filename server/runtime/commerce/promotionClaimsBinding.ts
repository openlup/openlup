import {
  createPostgresCommercePromoDataPort,
  createPostgresPromotionClaimSweepPort,
} from "../../adapters/postgres/promotionClaims.js";
import {
  createPostgresPromotionClaimTransactionLane,
  type PostgresPromotionClaimTransactionLane,
} from "../../adapters/postgres/dataGateway.js";
import { createPostgresPlatformJobRunLedger } from "../../adapters/postgres/platformJobRunLedger.js";
import type { PgQueryExecutor } from "../../adapters/postgres/queryBuilder.js";
import { createManagedCommercePromoDataPort as createManagedPromoDataPort } from "../../adapters/supabase/promotionClaims.js";
import { createSupabaseDataGateway as createManagedDataGateway } from "../../adapters/supabase/dataGateway.js";
import {
  readSupabaseDataGatewayEnv as readManagedDataGatewayEnv,
  type SupabaseDataGatewayEnv as ManagedGatewayEnv,
} from "../../adapters/supabase/dataGatewayClientFactory.js";
import { createSupabasePlatformJobRunLedger as createManagedJobRunLedger } from "../../adapters/supabase/platformJobRunLedger.js";
import { createManagedPromotionClaimSweepPort as createManagedSweepPort } from "../../adapters/supabase/promotionClaims.js";
import type { CommercePromoDataPort } from "../../domains/commerce/promoDataPort.js";
import type { PromotionClaimSweepPort } from "../../domains/commerce/promotionClaimSweepPort.js";
import { getBundleDescriptor, resolveBundleId } from "../../domains/platform-runtime/platformKernel.js";
import type { PlatformJobRunLedgerPort } from "../../domains/platform/platformJobRunLedger.js";
import type { PlatformJobInvocation } from "../../domains/platform/platformJobRunLedger.js";

type Env = Record<string, string | undefined>;
type ManagedGateway = { asService<T>(work: (client: unknown) => Promise<T>): Promise<T> };
type GatewayFactory = (env: ManagedGatewayEnv) => ManagedGateway;
type LaneFactory = (options: { connectionString: string }) => PostgresPromotionClaimTransactionLane;

export const PROMOTION_CLAIM_SWEEP_JOB_NAME = "promotion-claim-sweep";
const BATCH_LIMIT = 50;
const CLAIM_LEASE_MINUTES = 15;
const GRACE_MINUTES = 5;

export interface PromotionClaimsContext {
  promoDataPort: CommercePromoDataPort;
  sweepPort: PromotionClaimSweepPort;
  jobRunLedger: PlatformJobRunLedgerPort;
}

export interface PromotionClaimsBinding {
  run<T>(work: (context: PromotionClaimsContext) => Promise<T>): Promise<T>;
}

export type PromotionClaimsBindingResolution =
  | { binding: PromotionClaimsBinding; error?: undefined }
  | { binding?: undefined; error: string };

export function resolvePromotionClaimsBinding(
  env: Env = process.env,
  options: { gatewayFactory?: GatewayFactory; createLane?: LaneFactory } = {},
): PromotionClaimsBindingResolution {
  const bundleId = resolveBundleId(env);
  if (getBundleDescriptor(bundleId).capabilities.data === "postgres") {
    const connectionString = env.DATABASE_URL?.trim() ?? "";
    if (!connectionString) return { error: "database_url_required" };
    return {
      binding: {
        async run(work) {
          const lane = (options.createLane ?? createPostgresPromotionClaimTransactionLane)({ connectionString });
          const executor = laneExecutor(lane);
          try {
            return await work({
              promoDataPort: createPostgresCommercePromoDataPort(executor),
              sweepPort: createPostgresPromotionClaimSweepPort(executor),
              jobRunLedger: createPostgresPlatformJobRunLedger(executor, env),
            });
          } finally {
            await lane.close();
          }
        },
      },
    };
  }

  const managedEnv = readManagedDataGatewayEnv(env);
  if (!managedEnv) return { error: "supabase_env_required" };
  return {
    binding: {
      run: (work) => (options.gatewayFactory ?? createManagedDataGateway)(managedEnv).asService((client) =>
        work({
          promoDataPort: createManagedPromoDataPort(client as never),
          sweepPort: createManagedSweepPort(client as never),
          jobRunLedger: createManagedJobRunLedger(client as never, env),
        })),
    },
  };
}

function laneExecutor(lane: PostgresPromotionClaimTransactionLane): PgQueryExecutor {
  return {
    query: (text, values) => lane.run((client) => (client as PgQueryExecutor).query(text, values)),
  };
}

export async function runPromotionClaimSweepOnce(input: {
  env?: Env;
  invocation: PlatformJobInvocation;
  now?: () => string;
  resolveBinding?: (env: Env) => PromotionClaimsBindingResolution;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const env = input.env ?? process.env;
  if (env.COMMERCE_PROMOTION_CLAIM_SWEEP_ENABLED !== "true") {
    return {
      status: 200,
      body: { ok: true, skipped: "sweep_disabled", checked: 0, cancelled: 0, skippedCount: 0 },
    };
  }
  const resolution = (input.resolveBinding ?? resolvePromotionClaimsBinding)(env);
  if (!resolution.binding) {
    return { status: 503, body: { ok: false, error: resolution.error ?? "promotion_claim_binding_missing" } };
  }
  return resolution.binding.run(async ({ sweepPort, jobRunLedger }) => {
    const lease = await jobRunLedger.claimJobRun(
      PROMOTION_CLAIM_SWEEP_JOB_NAME, input.invocation, 5 * 60,
    );
    if (!lease.acquired || !lease.runId) {
      return { status: 200, body: { ok: true, skipped: true, reason: lease.reason } };
    }
    try {
      const counts = await sweepPort.sweep({
        now: (input.now ?? (() => new Date().toISOString()))(),
        limit: BATCH_LIMIT,
        claimLeaseMinutes: CLAIM_LEASE_MINUTES,
        graceMinutes: GRACE_MINUTES,
      });
      await jobRunLedger.finishJobRun(
        PROMOTION_CLAIM_SWEEP_JOB_NAME, lease.runId, input.invocation, "success",
        { checked: counts.checked, updated: counts.cancelled, failures: 0, skipped: false },
        { driver: input.invocation.invocationSource, skippedUnsafe: counts.skipped },
      );
      return { status: 200, body: { ok: true, ...counts } };
    } catch (error) {
      const reason = (error instanceof Error ? error.message : String(error)).slice(0, 240);
      await jobRunLedger.finishJobRun(
        PROMOTION_CLAIM_SWEEP_JOB_NAME, lease.runId, input.invocation, "failed",
        { checked: 0, updated: 0, failures: 1, skipped: false, reason },
        { driver: input.invocation.invocationSource },
      );
      return { status: 500, body: { ok: false, error: "rpc_failed" } };
    }
  });
}
