import type { AccountingInvoiceIssuePort } from "../../../src/domains/accounting/ports.js";
import { createPostgresPlatformJobRunLedger } from "../../adapters/postgres/platformJobRunLedger.js";
import type { PgQueryExecutor } from "../../adapters/postgres/queryBuilder.js";
import {
  createSupabasePlatformJobRunLedger,
  createPlatformJobManagedClient,
  type PlatformJobSupabaseClient,
  type PlatformJobManagedClientFactory,
} from "../../adapters/supabase/platformJobRunLedger.js";
import type { OmnipackDispatchPort } from "../../domains/fulfillment/omnipackDispatchWorker.js";
import type { OmnipackProductSyncPort } from "../../domains/fulfillment/omnipackProductSyncWorker.js";
import type { OmnipackReconciliationPort } from "../../domains/fulfillment/omnipackReconciliationWorker.js";
import type { OmnipackStockSyncPort } from "../../domains/fulfillment/omnipackStockSyncWorker.js";
import { createSupabaseOmnipackDispatchPort } from "../../adapters/supabase/omnipackDispatchPort.js";
import { createSupabaseOmnipackProductSyncPort } from "../../adapters/supabase/omnipackProductSyncPort.js";
import {
  createSupabaseOmnipackReconciliationPort,
  type OmnipackReconciliationSupabaseClient,
} from "../../adapters/supabase/omnipackReconciliationPort.js";
import { createSupabaseOmnipackStockSyncPort } from "../../adapters/supabase/omnipackStockSyncPort.js";
import { resolveFulfillmentStockSyncBinding } from "./fulfillmentConvergenceBinding.js";
import type {
  PlatformJobInvocation,
  PlatformJobRunLedgerPort,
} from "../../domains/platform/platformJobRunLedger.js";
import { resolveBundleId } from "../../domains/platform-runtime/platformKernel.js";

export type OmnipackCronDriver = "manual_admin" | "node_cron" | "pg_cron" | "vercel_cron" | "worker";

export type SupabaseOmnipackCronEnv = Record<string, string | undefined> & {
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SUPABASE_URL?: string;
  VITE_SUPABASE_URL?: string;
};

export interface SupabaseOmnipackCronPorts {
  dispatch: OmnipackDispatchPort;
  productSync: OmnipackProductSyncPort;
  reconciliation: OmnipackReconciliationPort;
  stockSync: OmnipackStockSyncPort;
}

export interface SupabaseOmnipackCronGatewayOptions {
  reconciliationAccountingEnabled?: boolean;
  accountingPortFactory?: (client: OmnipackReconciliationSupabaseClient) => AccountingInvoiceIssuePort;
  accountingProviderKind?: string;
  stockInventoryClasses?: ReadonlyMap<string, "sellable" | "packaging">;
  /** Test/composition seam; production resolves the ledger from PLATFORM_BUNDLE. */
  jobRunLedger?: PlatformJobRunLedgerPort;
  /** Test seam for the direct database bundle; production lazily opens DATABASE_URL. */
  postgresJobRunExecutor?: PgQueryExecutor;
}

export interface OmnipackCronFinishSummary {
  checked: number;
  updated: number;
  failures: number;
  skipped: boolean;
  reason?: string;
}

export interface OmnipackCronFinishDecision {
  status: "success" | "failed";
  result: OmnipackCronFinishSummary;
  extraMetadata?: Record<string, unknown>;
}

export interface SupabaseOmnipackCronGateway {
  readJobBackstopState?(jobName: string): Promise<{ lastStatus: string | null; lastSuccessAt: string | null } | null>;
  readLatestTerminalRunMetadata(jobName: string): Promise<Record<string, unknown> | null>;
  runJob<TResult>(input: {
    jobName: string;
    driver?: OmnipackCronDriver;
    operation: (ports: SupabaseOmnipackCronPorts) => Promise<TResult>;
    finish: (result: TResult) => OmnipackCronFinishDecision;
  }): Promise<{ acquired: false; reason: string } | { acquired: true; result: TResult }>;
}

export function createSupabaseOmnipackCronGateway(
  env: SupabaseOmnipackCronEnv,
  clientFactory: PlatformJobManagedClientFactory = createPlatformJobManagedClient,
  options: SupabaseOmnipackCronGatewayOptions = {},
): SupabaseOmnipackCronGateway | null {
  if (resolveBundleId(env) === "node-postgres") {
    return createDirectOmnipackCronGateway(env, options);
  }
  const supabaseUrl = env.SUPABASE_URL ?? env.VITE_SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) return null;

  const client = clientFactory(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const typedClient = client as never;
  const jobRunLedger = options.jobRunLedger
    ?? bindPlatformJobRunLedger(env, client as unknown as PlatformJobSupabaseClient, options.postgresJobRunExecutor);
  if (!jobRunLedger) return null;
  const reconciliationAccountingPort = options.reconciliationAccountingEnabled && options.accountingPortFactory
    ? options.accountingPortFactory(client as unknown as OmnipackReconciliationSupabaseClient)
    : undefined;
  // C-D5 neutralizes only the job-control rail. These four provider-operation
  // ports deliberately retain their characterized managed implementation.
  const ports: SupabaseOmnipackCronPorts = {
    dispatch: createSupabaseOmnipackDispatchPort(typedClient),
    productSync: createSupabaseOmnipackProductSyncPort(typedClient),
    reconciliation: createSupabaseOmnipackReconciliationPort(typedClient, {
      accountingPort: reconciliationAccountingPort,
      accountingProviderKind: options.accountingProviderKind,
    }),
    stockSync: createSupabaseOmnipackStockSyncPort(typedClient, {
      inventoryClasses: options.stockInventoryClasses,
    }),
  };

  return {
    async readJobBackstopState(jobName) {
      return jobRunLedger.readJobBackstopState(jobName);
    },
    async readLatestTerminalRunMetadata(jobName) {
      return jobRunLedger.readLatestTerminalRunMetadata(jobName);
    },
    async runJob(input) {
      const driver = input.driver ?? defaultPlatformJobDriver(env);
      const invocation = platformJobInvocation(driver);
      const lease = await jobRunLedger.claimJobRun(input.jobName, invocation);
      if (!lease.acquired || !lease.runId) {
        return { acquired: false, reason: lease.reason };
      }

      const result = await input.operation(ports);
      const finish = input.finish(result);
      await jobRunLedger.finishJobRun(
        input.jobName,
        lease.runId,
        invocation,
        finish.status,
        finish.result,
        finish.extraMetadata,
      );
      return { acquired: true, result };
    },
  };
}

function createDirectOmnipackCronGateway(
  env: SupabaseOmnipackCronEnv,
  options: SupabaseOmnipackCronGatewayOptions,
): SupabaseOmnipackCronGateway | null {
  const executor = options.postgresJobRunExecutor ?? bundleJobRunExecutor(env);
  if (!executor) return null;
  const jobRunLedger = options.jobRunLedger ?? createPostgresPlatformJobRunLedger(executor, env);
  let stockBinding: ReturnType<typeof resolveFulfillmentStockSyncBinding>["binding"];
  const withStock = async <T>(work: (port: OmnipackStockSyncPort) => Promise<T>): Promise<T> => {
    if (!stockBinding) {
      const resolved = resolveFulfillmentStockSyncBinding(env, {
        inventoryClasses: options.stockInventoryClasses,
      });
      if (!resolved.binding) throw new Error(resolved.error);
      stockBinding = resolved.binding;
    }
    return work(stockBinding);
  };
  const stockSync: OmnipackStockSyncPort = {
    readCursor: () => withStock((port) => port.readCursor()),
    readLocalInventoryStock: () => withStock((port) => port.readLocalInventoryStock()),
    readSkuInventoryClasses: (skus) => withStock((port) => port.readSkuInventoryClasses(skus)),
    readActiveReservations: (skus, at) => withStock((port) => port.readActiveReservations(skus, at)),
    recordCursor: (input) => withStock((port) => port.recordCursor(input)),
    recordStockSnapshot: (input) => withStock((port) => port.recordStockSnapshot(input)),
    recordProviderStockCurrent: (input) => withStock((port) => port.recordProviderStockCurrent(input)),
    recordLowStockEvidence: (input) => withStock((port) => port.recordLowStockEvidence(input)),
    resolveLowStockEvidence: (input) => withStock((port) => port.resolveLowStockEvidence(input)),
  };
  const unavailable = <T extends object>(capability: string): T => new Proxy({} as T, {
    get: () => async () => { throw new Error(`${capability}_unavailable_for_direct_bundle`); },
  });
  const ports: SupabaseOmnipackCronPorts = {
    dispatch: unavailable("omnipack_dispatch"),
    productSync: unavailable("omnipack_product_sync"),
    reconciliation: unavailable("omnipack_reconciliation"),
    stockSync,
  };
  return {
    readJobBackstopState: (jobName) => jobRunLedger.readJobBackstopState(jobName),
    readLatestTerminalRunMetadata: (jobName) => jobRunLedger.readLatestTerminalRunMetadata(jobName),
    async runJob(input) {
      const driver = input.driver ?? defaultPlatformJobDriver(env);
      const invocation = platformJobInvocation(driver);
      try {
        const lease = await jobRunLedger.claimJobRun(input.jobName, invocation);
        if (!lease.acquired || !lease.runId) return { acquired: false, reason: lease.reason };
        const result = await input.operation(ports);
        const finish = input.finish(result);
        await jobRunLedger.finishJobRun(
          input.jobName, lease.runId, invocation, finish.status,
          finish.result, finish.extraMetadata,
        );
        return { acquired: true, result };
      } finally {
        await stockBinding?.close();
      }
    },
  };
}

export function platformJobInvocation(driver: OmnipackCronDriver): PlatformJobInvocation {
  switch (driver) {
    case "manual_admin": return { triggerKind: "operator", invocationSource: driver };
    case "pg_cron":
    case "node_cron":
    case "vercel_cron": return { triggerKind: "scheduler", invocationSource: driver };
    case "worker": return { triggerKind: "worker", invocationSource: driver };
  }
}

export function defaultPlatformJobDriver(
  env: SupabaseOmnipackCronEnv,
): OmnipackCronDriver {
  return resolveBundleId(env) === "node-postgres"
    ? "node_cron"
    : "vercel_cron";
}

/** Neutral proof/runtime seam for the managed job ledger; provider details stay in its adapter. */
export function createJobRunLedgerForManagedClient(
  client: PlatformJobSupabaseClient,
  env: Record<string, string | undefined> = process.env,
): PlatformJobRunLedgerPort {
  return createSupabasePlatformJobRunLedger(client, env);
}

let pooledJobRunExecutor: { key: string; executor: PgQueryExecutor } | null = null;

function bindPlatformJobRunLedger(
  env: SupabaseOmnipackCronEnv,
  managedClient: PlatformJobSupabaseClient,
  injectedPostgresExecutor?: PgQueryExecutor,
): PlatformJobRunLedgerPort | null {
  if (resolveBundleId(env) !== "node-postgres") {
    return createJobRunLedgerForManagedClient(managedClient, env);
  }
  const executor = injectedPostgresExecutor ?? bundleJobRunExecutor(env);
  return executor ? createPostgresPlatformJobRunLedger(executor, env) : null;
}

function bundleJobRunExecutor(env: SupabaseOmnipackCronEnv): PgQueryExecutor | null {
  const connectionString = env.DATABASE_URL?.trim();
  if (!connectionString) return null;
  if (pooledJobRunExecutor?.key === connectionString) return pooledJobRunExecutor.executor;
  const pool = (async () => {
    const pg = await import("pg");
    const PoolCtor = (pg.default?.Pool ?? pg.Pool) as typeof import("pg").Pool;
    return new PoolCtor({ connectionString });
  })();
  const executor: PgQueryExecutor = {
    async query(text, values) {
      return (await pool).query(text, values);
    },
  };
  pooledJobRunExecutor = { key: connectionString, executor };
  return executor;
}
