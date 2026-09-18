import {
  createPostgresCheckoutRecoveryOperations,
} from "../../adapters/postgres/checkoutRecoveryOperations.js";
import {
  createPostgresCheckoutRecoveryOperationsTransactionLane,
  type PostgresCheckoutRecoveryOperationsTransactionLane,
} from "../../adapters/postgres/dataGateway.js";
import { createPostgresPlatformJobRunLedger } from "../../adapters/postgres/platformJobRunLedger.js";
import type { PgQueryExecutor } from "../../adapters/postgres/queryBuilder.js";
import { createSupabaseDataGateway as createManagedDataGateway } from "../../adapters/supabase/dataGateway.js";
import {
  readSupabaseDataGatewayEnv as readManagedDataGatewayEnv,
  type SupabaseDataGatewayEnv as ManagedDataGatewayEnv,
} from "../../adapters/supabase/dataGatewayClientFactory.js";
import {
  createSupabaseAbandonedCartReminderEnqueuePort,
  createSupabaseCheckoutRecoveryReminderEnqueuePort,
  createSupabaseOutboxPrunePort,
  type EmailDeliveriesPruneOutcome,
} from "../../adapters/supabase/checkoutRecoveryOperations.js";
import type {
  AbandonedCartReminderEnqueuePort,
  CheckoutRecoveryReminderEnqueuePort,
  OutboxPrunePort,
  ReminderDeliveryAuthorizationPort,
} from "../../domains/commerce/checkoutRecoveryOperations.js";
import { getBundleDescriptor, resolveBundleId } from "../../domains/platform-runtime/platformKernel.js";
import type {
  PlatformJobFinishStatus,
  PlatformJobFinishSummary,
  PlatformJobInvocation,
  PlatformJobRunLedgerPort,
} from "../../domains/platform/platformJobRunLedger.js";

type Env = Record<string, string | undefined>;
type ManagedGateway = { asService<T>(work: (client: unknown) => Promise<T>): Promise<T> };
export type CheckoutRecoveryOperationsGatewayFactory = (env: ManagedDataGatewayEnv) => ManagedGateway;
type LaneFactory = (options: { connectionString: string }) => PostgresCheckoutRecoveryOperationsTransactionLane;

export interface CheckoutRecoveryOperationsBindingOptions {
  gatewayFactory?: CheckoutRecoveryOperationsGatewayFactory;
  createLane?: LaneFactory;
}

export interface CheckoutRecoveryOperationsContext {
  readonly bundleId: string;
  readonly abandonedReminders: AbandonedCartReminderEnqueuePort;
  readonly recoveryReminders: CheckoutRecoveryReminderEnqueuePort;
  readonly outboxPrune: OutboxPrunePort;
  readonly deliveryAuthorization?: ReminderDeliveryAuthorizationPort;
  readonly deliveryPrune?: { pruneDeliveries(limit: number): Promise<EmailDeliveriesPruneOutcome> };
  readonly runtimeBaseUrl: string;
  readonly managedClient?: unknown;
  readonly jobRunLedger?: PlatformJobRunLedgerPort;
}

export interface CheckoutRecoveryOperationsBinding {
  run<T>(work: (context: CheckoutRecoveryOperationsContext) => Promise<T>): Promise<T>;
}

export type CheckoutRecoveryOperationsBindingResolution =
  | { binding: CheckoutRecoveryOperationsBinding; error?: undefined }
  | { binding?: undefined; error: string };

export function resolveCheckoutRecoveryOperationsBinding(
  env: Env = process.env,
  options: CheckoutRecoveryOperationsBindingOptions = {},
): CheckoutRecoveryOperationsBindingResolution {
  const bundleId = resolveBundleId(env);
  if (getBundleDescriptor(bundleId).capabilities.data === "postgres") {
    const connectionString = env.DATABASE_URL?.trim() ?? "";
    if (!connectionString) return { error: "database_url_required" };
    return {
      binding: {
        async run(work) {
          const lane = (options.createLane ?? createPostgresCheckoutRecoveryOperationsTransactionLane)({
            connectionString,
          });
          const executor = laneExecutor(lane);
          const operations = createPostgresCheckoutRecoveryOperations(executor);
          try {
            return await work({
              bundleId,
              abandonedReminders: operations.abandonedReminderPort,
              recoveryReminders: operations.checkoutRecoveryReminderPort,
              outboxPrune: operations.outboxPrunePort,
              deliveryAuthorization: operations.deliveryAuthorizationPort,
              runtimeBaseUrl: "",
              jobRunLedger: createPostgresPlatformJobRunLedger(executor, env),
            });
          } finally {
            await lane.close();
          }
        },
      },
    };
  }

  const gatewayEnv = readManagedDataGatewayEnv(env);
  if (!gatewayEnv) return { error: "supabase_env_required" };
  return {
    binding: {
      run: (work) => (options.gatewayFactory ?? createManagedDataGateway)(gatewayEnv).asService((client) => {
        const outboxPrune = createSupabaseOutboxPrunePort(client as never);
        return work({
          bundleId,
          abandonedReminders: createSupabaseAbandonedCartReminderEnqueuePort(client as never),
          recoveryReminders: createSupabaseCheckoutRecoveryReminderEnqueuePort(client as never),
          outboxPrune,
          deliveryPrune: outboxPrune,
          runtimeBaseUrl: gatewayEnv.url,
          managedClient: client,
        });
      }),
    },
  };
}

function laneExecutor(lane: PostgresCheckoutRecoveryOperationsTransactionLane): PgQueryExecutor {
  return { query: (text, values) => lane.run((client) => (client as PgQueryExecutor).query(text, values)) };
}

type ManagedClaim = (
  client: never,
  jobName: string,
  driver: "vercel_cron",
  leaseSeconds: number,
) => Promise<{ acquired: boolean; runId: string | null; reason: string }>;

type ManagedFinish = (
  client: never,
  jobName: string,
  runId: string,
  status: PlatformJobFinishStatus,
  summary: PlatformJobFinishSummary,
  metadata?: Record<string, unknown>,
) => Promise<unknown>;

export function claimCheckoutRecoveryOperationsRun(
  context: CheckoutRecoveryOperationsContext,
  jobName: string,
  invocation: PlatformJobInvocation,
  leaseSeconds: number,
  managedClaim?: ManagedClaim,
) {
  if (context.jobRunLedger) {
    return context.jobRunLedger.claimJobRun(jobName, invocation, leaseSeconds);
  }
  if (!context.managedClient || !managedClaim) throw new Error("checkout_recovery_job_ledger_missing");
  return managedClaim(context.managedClient as never, jobName, "vercel_cron", leaseSeconds);
}

export async function finishCheckoutRecoveryOperationsRun(
  context: CheckoutRecoveryOperationsContext,
  jobName: string,
  runId: string,
  invocation: PlatformJobInvocation,
  status: PlatformJobFinishStatus,
  summary: PlatformJobFinishSummary,
  metadata: Record<string, unknown>,
  managedFinish?: ManagedFinish,
): Promise<void> {
  if (context.jobRunLedger) {
    await context.jobRunLedger.finishJobRun(jobName, runId, invocation, status, summary, metadata);
    return;
  }
  if (!context.managedClient || !managedFinish) throw new Error("checkout_recovery_job_ledger_missing");
  await managedFinish(context.managedClient as never, jobName, runId, status, summary, metadata);
}
