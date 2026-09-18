import type { VercelRequest, VercelResponse } from "../../server/_lib/types/vercel.js";
import { createSupabaseDataGateway } from "../../server/adapters/supabase/dataGateway.js";
import {
  readSupabaseDataGatewayEnv,
  type SupabaseDataGatewayEnv,
} from "../../server/adapters/supabase/dataGatewayClientFactory.js";
import {
  runPaymentProviderReconciliationWorker,
} from "../../server/domains/payment/paymentProviderReconciliationWorker.js";
import { createSupabasePaymentProviderReconciliationPort } from "../../server/adapters/supabase/payment/paymentProviderReconciliation.js";
import { createSupabasePaidActivationGapPort } from "../../server/adapters/supabase/payment/paidActivationGap.js";
import { createSupabaseAccountingControlPort } from "../../server/adapters/supabase/accounting/accountingControl.js";
import {
  syncStripePayoutSettlements,
  type StripePayoutSettlementReader,
} from "../../server/domains/accounting/stripePayoutSettlementSync.js";
import { paymentProviderCapabilityRegistry } from "../../server/adapters/paymentProviderCapabilityRegistry.js";
import {
  createPaymentProviderReadbackRegistry,
  createStripePayoutSettlementReader,
  type PaymentProviderReadbackRegistry,
} from "../../server/runtime/paymentProviderReadbackRegistry.js";
import { resolveSubscriptionActivationBinding } from "../../server/runtime/customers/subscriptionActivationBinding.js";
import { resolveBundleId } from "../../server/domains/platform-runtime/platformKernel.js";
import type { DataGatewayPort } from "../../src/domains/platform-runtime/ports.js";
import { claimJobRun, finishJobRun } from "../_cron/platformJobRunner.js";

export const config = { maxDuration: 60 };

const JOB_NAME = "payment-provider-reconciliation";
const DRIVER = "vercel_cron";
const LEASE_SECONDS = 15 * 60;

type Env = Record<string, string | undefined> & {
  CRON_SECRET?: string;
  COMMERCE_PSP_OBSERVABILITY_ENABLED?: string;
  COMMERCE_PSP_PREPARED_ABSENCE_AUTO_REOPEN_ENABLED?: string;
  STRIPE_PROVIDER_ENABLED?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_LIVE_CONFIRMED?: string;
  PAYMENTS_TPAY_ENABLED?: string;
  PAYMENTS_TPAY_SANDBOX_ENABLED?: string;
  PAYMENTS_TPAY_SIMULATOR_ENABLED?: string;
  PAYMENTS_TPAY_VERIFIED_TEST_MODE_ENABLED?: string;
  TPAY_VERIFIED_TEST_MODE_CONFIRMED?: string;
  TPAY_API_BASE_URL?: string;
  TPAY_CLIENT_ID?: string;
  TPAY_CLIENT_SECRET?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SUPABASE_URL?: string;
  VITE_SUPABASE_URL?: string;
};

type GatewayFactory = (env: SupabaseDataGatewayEnv) => DataGatewayPort;
type ProviderRegistry = PaymentProviderReadbackRegistry;
type SettlementReaderFactory = (env: Env) => StripePayoutSettlementReader | null;
type ActivationBindingResolver = typeof resolveSubscriptionActivationBinding;

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const result = await runPaymentProviderReconciliationCron(req);
  if (result.headers?.allow) res.setHeader("Allow", result.headers.allow);
  res.status(result.status).json(result.body);
}

export async function runPaymentProviderReconciliationCron(
  req: VercelRequest,
  env: Env = process.env,
  gatewayFactory: GatewayFactory = createSupabaseDataGateway,
  providerFactory: (env: Env) => ProviderRegistry = createPaymentProviderReadbackRegistry,
  settlementReaderFactory: SettlementReaderFactory = createStripePayoutSettlementReader,
  activationBindingResolver: ActivationBindingResolver = resolveSubscriptionActivationBinding,
): Promise<{ status: number; body: Record<string, unknown>; headers?: { allow?: string } }> {
  if (req.method !== "POST" && req.method !== "GET") {
    return { status: 405, headers: { allow: "GET, POST" }, body: { ok: false, error: "method_not_allowed" } };
  }

  if (!env.CRON_SECRET) {
    return { status: 503, body: { ok: false, error: "cron_secret_required" } };
  }
  if (req.headers.authorization !== `Bearer ${env.CRON_SECRET}`) {
    return { status: 401, body: { ok: false, error: "unauthorized" } };
  }

  if (env.COMMERCE_PSP_OBSERVABILITY_ENABLED !== "true") {
    return {
      status: 200,
      body: { ok: true, skipped: true, reason: "psp_observability_disabled", checked: 0, corrected: 0, failures: 0 },
    };
  }

  // The direct bundle has no hosted PSP control plane to reconcile. Its money
  // rail already carries captured settlement truth, so this production cron is
  // the honest adopter for the remaining activation gap: it asks the named
  // binding to derive the fingerprint from that stored settlement and repair
  // only already-paid provisional activations. The bundle decision stays above
  // every Supabase environment read and provider-registry construction.
  if (resolveBundleId(env) === "node-postgres") {
    const binding = activationBindingResolver(env);
    if (!binding) {
      return { status: 503, body: { ok: false, error: "subscription_activation_binding_missing" } };
    }
    try {
      const paidActivationGaps = await binding.run((activation) =>
        activation.reconcilePaidActivationGaps(),
      );
      const ok = paidActivationGaps.overdue === 0;
      return {
        status: ok ? 200 : 502,
        body: {
          ok,
          checked: paidActivationGaps.repaired + paidActivationGaps.overdue,
          corrected: paidActivationGaps.repaired,
          failures: paidActivationGaps.overdue,
          paidActivationGaps,
          providerCalls: 0,
          reason: "direct_captured_activation_reconciliation",
        },
      };
    } catch (error) {
      const reason = safeMessage(error);
      console.error("[cron/payment-provider-reconciliation] direct activation failed", { reason });
      return { status: 500, body: { ok: false, error: "subscription_activation_reconciliation_failed", reason } };
    }
  }

  const gatewayEnv = readSupabaseDataGatewayEnv(env);
  if (!gatewayEnv) {
    return { status: 503, body: { ok: false, error: "supabase_env_missing" } };
  }

  let providers: ProviderRegistry;
  let stripeSettlementReader: StripePayoutSettlementReader | null;
  try {
    providers = providerFactory(env);
    stripeSettlementReader = settlementReaderFactory(env);
  } catch (error) {
    return { status: 503, body: { ok: false, error: "provider_registry_failed", reason: safeMessage(error) } };
  }

  return gatewayFactory(gatewayEnv).asService(async (client) => {
    const lease = await claimJobRun(client as never, JOB_NAME, DRIVER, LEASE_SECONDS);
    if (!lease.acquired || !lease.runId) {
      return { status: 200, body: { ok: true, skipped: true, reason: lease.reason } };
    }

    try {
      const result = await runPaymentProviderReconciliationWorker({
        port: createSupabasePaymentProviderReconciliationPort(client as never),
        providers,
        claimKey: `${JOB_NAME}:${lease.runId}`,
        // Each rail declares how long its own silence stays normal; the worker
        // reads that rather than branching on which provider it is talking to.
        capabilities: paymentProviderCapabilityRegistry,
        autoReopenPreparedAbsence: env.COMMERCE_PSP_PREPARED_ABSENCE_AUTO_REOPEN_ENABLED === "true",
      });
      // Existing leased reconciliation is also the bounded scanner for the
      // paid-without-mandate gap. This RPC is intentionally not best-effort:
      // hiding an outbox/scanner failure would strand paid subscriptions.
      const paidActivationGaps = await createSupabasePaidActivationGapPort(client as never)
        .reconcile();
      let stripeSettlement: Record<string, unknown> = {
        checked: 0, recorded: 0, replayed: 0, skipped: true, reason: "stripe_settlement_import_unsupported",
      };
      if (stripeSettlementReader) {
        try {
          stripeSettlement = await syncStripePayoutSettlements({
            reader: stripeSettlementReader,
            accountingPort: createSupabaseAccountingControlPort(client as never),
          });
        } catch (error) {
          stripeSettlement = { checked: 0, recorded: 0, replayed: 0, failed: true, reason: safeMessage(error) };
        }
      }
      await finishJobRun(client as never, JOB_NAME, lease.runId, result.ok ? "success" : "failed", {
        checked: result.checked,
        updated: result.corrected,
        failures: result.failures,
        skipped: result.skipped,
        reason: result.reason,
      }, {
        driver: DRIVER,
        succeeded: result.succeeded,
        failed: result.failed,
        pending: result.pending,
        unknown: result.unknown,
        ignored: result.ignored,
        dunningOpened: result.dunningOpened,
        providerCalls: result.providerCalls,
        preparedWithoutProviderAck: result.preparedWithoutProviderAck,
        preparedAttemptsReopened: result.preparedAttemptsReopened,
        manualReview: result.manualReview,
        silenceOverdue: result.silenceOverdue,
        amountCurrencyMismatches: result.amountCurrencyMismatches,
        paidActivationGaps,
        stripeSettlement,
      });
      return {
        status: result.ok ? 200 : 502,
        body: { ...result, paidActivationGaps, stripeSettlement } as unknown as Record<string, unknown>,
      };
    } catch (error) {
      const reason = safeMessage(error);
      console.error("[cron/payment-provider-reconciliation] unexpected error", { reason });
      await finishJobRun(client as never, JOB_NAME, lease.runId, "failed", {
        checked: 0,
        updated: 0,
        failures: 1,
        skipped: false,
        reason,
      }, { driver: DRIVER });
      return { status: 500, body: { ok: false, error: "payment_provider_reconciliation_failed", reason } };
    }
  });
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 240);
}
