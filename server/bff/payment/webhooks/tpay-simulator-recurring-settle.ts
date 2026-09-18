import { withObservedRoute } from "../../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../../_lib/bff/response.js";
import { createSupabaseDataGateway } from "../../../adapters/supabase/dataGateway.js";
import { consumeSupabasePaymentMethodDelivery } from "../../../adapters/supabase/payment/paymentMethodLifecycle.js";
import { readSupabaseDataGatewayEnv } from "../../../adapters/supabase/dataGatewayClientFactory.js";
import type { DataGatewayPort } from "../../../../src/domains/platform-runtime/ports.js";
import {
  IDEMPOTENCY_CONFLICT,
  readStuckRecurringAttempts,
  settleSimulatorTransaction,
  type ParsedSimulatorRequest,
  type SimulatorSettlementOutcome,
  type StuckRecurringAttempt,
} from "../../../adapters/supabase/payment/tpaySimulatorSettlement.js";
import { tpaySimulatorWebhookEnabled } from "./tpaySimulatorGate.js";

/**
 * Staging-only stand-in for Tpay's async merchant notification on an OFF-SESSION recurring
 * (BLIK/PAYID) renewal charge. The `subscription-renewal` cron dispatches the charge and the
 * simulator adapter returns `processing` — but, unlike an on-session payment, there is no
 * customer + no simulator panel to POST the settle webhook, so the intent/order dead-ends at
 * `pending_payment` (finding CJ54-1). This sweep finds those stuck simulator recurring
 * attempts and settles each through the SAME settlement core the on-session webhook uses.
 *
 * It ONLY ever settles attempts that are simultaneously: `tpay_sim_`-prefixed (simulator),
 * `providerFlow=recurring_charge` (off-session recurring, never an abandoned on-session BLIK)
 * AND minted by `subscription.renewal.cron.v0`. Combined with the simulator gate
 * (`!tpaySandboxEnabled()`), production — which is not in simulator mode and where real Tpay
 * sends the notification — can never reach this path.
 */
export type { StuckRecurringAttempt };

export interface SweepSummary {
  scanned: number;
  settled: number;
  alreadySettled: number;
  unmatched: number;
  failures: number;
}

export interface SweepDeps {
  readStuck: (gateway: DataGatewayPort) => Promise<StuckRecurringAttempt[]>;
  settle: (gateway: DataGatewayPort, parsed: ParsedSimulatorRequest) => Promise<SimulatorSettlementOutcome>;
}

export async function sweepSimulatorRecurringSettlements(
  gateway: DataGatewayPort,
  deps: SweepDeps,
): Promise<SweepSummary> {
  const attempts = await deps.readStuck(gateway);
  let settled = 0;
  let alreadySettled = 0;
  let unmatched = 0;
  let failures = 0;
  for (const attempt of attempts) {
    try {
      const outcome = await deps.settle(gateway, {
        providerPaymentId: attempt.providerPaymentId,
        resultStatus: "succeeded",
        amountMinor: attempt.amountMinor,
        aliasResult: null,
        clientId: null,
        subscriptionId: null,
        providerMethodRef: null,
      });
      if (outcome.matched) settled += 1;
      else unmatched += 1;
    } catch (error) {
      // A benign re-delivery 23505 means the charge already settled — not a failure.
      if (IDEMPOTENCY_CONFLICT.test(error instanceof Error ? error.message : String(error))) alreadySettled += 1;
      else failures += 1;
    }
  }
  return { scanned: attempts.length, settled, alreadySettled, unmatched, failures };
}

async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
  if (!tpaySimulatorWebhookEnabled()) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Tpay simulator recurring settle is disabled", {
      details: { feature: "payment-webhook", provider: "tpay", reason: "feature_flag_disabled" },
    });
    return;
  }

  const gatewayEnv = readSupabaseDataGatewayEnv();
  if (!gatewayEnv) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Tpay simulator recurring settle is not configured", {
      details: { feature: "payment-webhook", provider: "tpay-simulator" },
    });
    return;
  }

  const gateway = createSupabaseDataGateway(gatewayEnv);
  try {
    const summary = await sweepSimulatorRecurringSettlements(gateway, {
      readStuck: readStuckRecurringAttempts,
      settle: (gateway, parsed) => settleSimulatorTransaction(
        gateway,
        parsed,
        consumeSupabasePaymentMethodDelivery,
      ),
    });
    sendBffSuccess(res, { provider: "tpay", simulator: true, ...summary });
  } catch (error) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Tpay simulator recurring settle failed", {
      details: { provider: "tpay-simulator", reason: (error instanceof Error ? error.message : String(error)).slice(0, 240) },
    });
  }
}

export default withObservedRoute({
  route: "/api/bff/payment/webhooks/tpay-simulator-recurring-settle",
  domain: "payment",
  surface: "webhook",
  risk: "provider",
  featureFlags: [
    "COMMERCE_PROVIDER_PAYMENTS_ENABLED",
    "COMMERCE_PROVIDER_WEBHOOKS_ENABLED",
    "PAYMENTS_TPAY_ENABLED",
    "PAYMENTS_TPAY_SIMULATOR_ENABLED",
  ],
}, handler);
