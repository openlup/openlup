import { createSupabaseDataGateway } from "../../adapters/supabase/dataGateway.js";
import { readSupabaseDataGatewayEnv, type SupabaseDataGatewayEnv } from "../../adapters/supabase/dataGatewayClientFactory.js";
import { createSupabaseAccountingInvoicePort } from "../../adapters/supabase/accountingInvoicePort.js";
import { createPostgresAccountingPaidOrderDocumentPort } from "../../adapters/postgres/accountingPaidOrderDocument.js";
import { createPostgresAccountingTransactionLane, type PostgresAccountingTransactionLane } from "../../adapters/postgres/dataGateway.js";
import type { PgQueryExecutor } from "../../adapters/postgres/queryBuilder.js";
import { createAccountingInvoiceDeliveryPort } from "../../adapters/resend/accountingInvoiceDeliveryPort.js";
import { assertAccountingRuntimeConfigAllowed, readAccountingRuntimeConfig } from "../../domains/accounting/accountingRuntimeConfig.js";
import {
  runAccountingInvoiceDeliveryJob,
  runAccountingInvoiceCorrectionJob,
  runAccountingInvoiceIssueJob,
  runAccountingKsefStatusJob,
  type AccountingJobResult,
} from "../../domains/accounting/accountingJobService.js";
import { claimJobRunV3, finishJobRunV3 } from "../../adapters/supabase/platformJobRunLedger.js";
import { createAccountingProviderFromEnv, readAccountingLedgerProviderKind, readAccountingProviderMode } from "../../infra/accounting/providerFactory.js";
import { createResendTransport } from "../../infra/email/emailTransport.js";
import { resolveResendApiKey } from "../../infra/resend/resendApiKey.js";
import { resolveCronEmailBaseUrl } from "../../../api/_cron/emailBaseUrl.js";
import { APP_FROM_EMAIL } from "../../../src/lib/brand/appBrand.js";
import { createAccountingPaymentProviderReadbackRegistry } from "../paymentProviderReadbackRegistry.js";
import type { DataGatewayPort } from "../../../src/domains/platform-runtime/ports.js";
import type { AccountingPaidOrderInvoiceIssuePort } from "../../../src/domains/accounting/ports.js";
import { resolveBundleId } from "../../domains/platform-runtime/platformKernel.js";
import { bindBundleDataPort } from "../dataBinding.js";

export type AccountingJobKind = "invoice-issue" | "invoice-delivery" | "invoice-correction" | "ksef-status";
export type ActiveAccountingJobKind = Exclude<AccountingJobKind, "ksef-status">;
export type AccountingTriggerKind = "worker" | "scheduler" | "operator";
export type AccountingInvocationContext = { triggerKind: AccountingTriggerKind; invocationSource: string; orderId?: string | null };

export type AccountingRuntimeEnv = Record<string, string | undefined>;
export type AccountingGatewayFactory = (env: SupabaseDataGatewayEnv) => DataGatewayPort;
export type AccountingRuntimeResult = { status: number; body: Record<string, unknown> };

type PaidOrderBindingOptions = {
  bindGateway?: (env: AccountingRuntimeEnv) => Pick<DataGatewayPort, "asService"> | null;
  createManagedPort?: (client: never) => AccountingPaidOrderInvoiceIssuePort;
  createPostgresPort?: (executor: PgQueryExecutor) => AccountingPaidOrderInvoiceIssuePort;
  createPostgresLane?: (connectionString: string) => PostgresAccountingTransactionLane;
  resolveBundle?: typeof resolveBundleId;
};

export type AccountingPaidOrderDocumentBinding = AccountingPaidOrderInvoiceIssuePort & { close(): Promise<void> };

type AccountingRunControl = {
  claim: (client: unknown, jobName: string, context: AccountingInvocationContext) => Promise<{ acquired: boolean; runId: string | null; reason: string }>;
  finish: (client: unknown, jobName: string, runId: string, status: "success" | "failed", result: AccountingJobResult, context: AccountingInvocationContext) => Promise<void>;
};

/** v3 control-plane adapter: execution authority is trigger kind, never vendor. */
const platformRunControl: AccountingRunControl = {
  claim: (client, jobName, context) => claimJobRunV3(client as never, jobName, context),
  finish: (client, jobName, runId, status, result, context) => finishJobRunV3(
    client as never,
    jobName,
    runId,
    status,
    result,
    { triggerKind: context.triggerKind, invocationSource: context.invocationSource },
  ),
};

export const ACCOUNTING_JOB_NAMES: Record<AccountingJobKind, string> = {
  "invoice-issue": "accounting-invoice-issue",
  "invoice-delivery": "accounting-invoice-delivery",
  "invoice-correction": "accounting-invoice-correction",
  "ksef-status": "accounting-ksef-status",
};

/**
 * Shipped dual-bundle composition for paid-order document request/replay.
 * Provider-specific accounting runtime methods intentionally do not cross it.
 */
export function createAccountingPaidOrderDocumentBinding(
  env: AccountingRuntimeEnv = process.env,
  options: PaidOrderBindingOptions = {},
): AccountingPaidOrderDocumentBinding | null {
  const direct = (options.resolveBundle ?? resolveBundleId)(env) === "node-postgres";
  const createManaged = options.createManagedPort ?? createSupabaseAccountingInvoicePort;
  const createPostgres = options.createPostgresPort ?? createPostgresAccountingPaidOrderDocumentPort;

  if (direct) {
    const connectionString = env.DATABASE_URL?.trim() ?? "";
    if (!connectionString) return null;
    const lane = (options.createPostgresLane ?? ((value) => createPostgresAccountingTransactionLane({ connectionString: value })))(connectionString);
    return {
      requestInvoiceIssueFromPaidOrder: (request) => lane.run((client) =>
        createPostgres(client as PgQueryExecutor).requestInvoiceIssueFromPaidOrder(request)),
      close: lane.close,
    };
  }

  const gateway = (options.bindGateway ?? bindBundleDataPort)(env);
  if (!gateway) return null;

  return {
    requestInvoiceIssueFromPaidOrder: (request) => gateway.asService((client) =>
      createManaged(client as never).requestInvoiceIssueFromPaidOrder(request)),
    close: async () => {},
  };
}

/** Runs exactly one durable accounting obligation through an adapter-neutral seam. */
export async function runAccountingRuntimeOnce({
  kind,
  context,
  env = process.env,
  gatewayFactory = createSupabaseDataGateway,
  runControl = platformRunControl,
}: {
  kind: AccountingJobKind;
  context: AccountingInvocationContext;
  env?: AccountingRuntimeEnv;
  gatewayFactory?: AccountingGatewayFactory;
  runControl?: AccountingRunControl;
}): Promise<AccountingRuntimeResult> {
  // KSeF is intentionally never a worker obligation. Its explicit HTTP/operator
  // route stays disabled until the separate government activation proof exists.
  if (kind === "ksef-status" && context.triggerKind === "worker") {
    return { status: 200, body: { ok: true, skipped: true, reason: "ksef_worker_not_supported" } };
  }

  const gatewayEnv = readSupabaseDataGatewayEnv(env);
  if (!gatewayEnv) return { status: 503, body: { ok: false, error: "supabase_env_required" } };

  return gatewayFactory(gatewayEnv).asService(async (client) => {
    const jobName = ACCOUNTING_JOB_NAMES[kind];
    const lease = await runControl.claim(client, jobName, context);
    if (!lease.acquired || !lease.runId) {
      return { status: 200, body: { ok: true, skipped: true, reason: lease.reason, run_id: lease.runId } };
    }

    let result: AccountingJobResult;
    try {
      result = await executeAccountingJobWithClient({
        kind, env, client, orderId: context.orderId ?? null,
      });
      await runControl.finish(client, jobName, lease.runId, result.ok ? "success" : "failed", result, context);
    } catch (error) {
      result = { ok: false, checked: 0, updated: 0, skipped: false, failures: 1, reason: safeMessage(error) };
      await runControl.finish(client, jobName, lease.runId, "failed", result, context);
    }
    return { status: result.ok ? 200 : 502, body: result as unknown as Record<string, unknown> };
  });
}

/** Authenticated staging proof path; deliberately has no production or global-job authority. */
/**
 * Portable scheduler entrypoint. Hosts call this directly (never by looping
 * back through an HTTP route), while the run-control adapter keeps the durable
 * lease shared with the worker.
 */
export function runAccountingScheduledJob(
  kind: ActiveAccountingJobKind,
  {
    env = process.env,
    invocationSource,
    gatewayFactory,
  }: {
    env?: AccountingRuntimeEnv;
    invocationSource: string;
    gatewayFactory?: AccountingGatewayFactory;
  },
): Promise<AccountingRuntimeResult> {
  return runAccountingRuntimeOnce({
    kind,
    env,
    gatewayFactory,
    context: { triggerKind: "scheduler", invocationSource },
  });
}

async function executeAccountingJob(
  kind: AccountingJobKind,
  input: Parameters<typeof runAccountingInvoiceIssueJob>[0] & {
    deliveryPort: Parameters<typeof runAccountingInvoiceDeliveryJob>[0]["deliveryPort"];
    expectedProviderKind: string;
  },
): Promise<AccountingJobResult> {
  if (kind === "invoice-issue") return runAccountingInvoiceIssueJob(input);
  if (kind === "invoice-delivery") return runAccountingInvoiceDeliveryJob(input);
  if (kind === "invoice-correction") return runAccountingInvoiceCorrectionJob(input);
  return runAccountingKsefStatusJob(input);
}

async function executeAccountingJobWithClient({
  kind,
  env,
  client,
  orderId,
}: {
  kind: AccountingJobKind;
  env: AccountingRuntimeEnv;
  client: unknown;
  orderId: string | null;
}): Promise<AccountingJobResult> {
  const config = readAccountingRuntimeConfig(env);
  assertAccountingRuntimeConfigAllowed(env, config);
  const port = createSupabaseAccountingInvoicePort(client as never);
  const provider = createAccountingProviderFromEnv(env);
  const deliveryPort = kind === "invoice-delivery" && config.providerEmailEnabled && provider
    ? createInvoiceDeliveryPort({ env, client })
    : null;
  const paymentProviders = kind === "invoice-issue" && config.createEnabled && provider
    ? createAccountingPaymentProviderReadbackRegistry(env)
    : {};
  let result = await executeAccountingJob(kind, {
    port,
    provider,
    deliveryPort,
    expectedProviderKind: readAccountingLedgerProviderKind(env),
    config,
    env,
    orderId,
    paymentProviders,
  });
  const providerMode = readAccountingProviderMode(env);
  if (providerMode) result = { ...result, reason: result.reason ?? `provider_mode_${providerMode}` };
  return result;
}

function createInvoiceDeliveryPort({
  env,
  client,
}: {
  env: AccountingRuntimeEnv;
  client: unknown;
}) {
  const { apiKey } = resolveResendApiKey(env);
  if (!apiKey) throw new Error("resend_api_key_required");
  const emailBaseUrl = resolveCronEmailBaseUrl(env);
  if (emailBaseUrl.ok === false) throw new Error(emailBaseUrl.error);
  return createAccountingInvoiceDeliveryPort({
    client: client as never,
    transport: createResendTransport({ apiKey, env }),
    fromEmail: env.FROM_EMAIL ?? APP_FROM_EMAIL,
    baseUrl: emailBaseUrl.baseUrl,
  });
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 180);
}
