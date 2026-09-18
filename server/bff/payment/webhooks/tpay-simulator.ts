import { withObservedRoute } from "../../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../../_lib/bff/response.js";
import {
  createSupabaseDataGateway,
} from "../../../adapters/supabase/dataGateway.js";
import { consumeSupabasePaymentMethodDelivery } from "../../../adapters/supabase/payment/paymentMethodLifecycle.js";
import {
  readSupabaseDataGatewayEnv,
  type SupabaseDataGatewayEnv,
} from "../../../adapters/supabase/dataGatewayClientFactory.js";
import type { DataGatewayPort } from "../../../../src/domains/platform-runtime/ports.js";
import {
  IDEMPOTENCY_CONFLICT,
  settleSimulatorTransaction,
  type ParsedSimulatorRequest,
  type SimulatorAliasResult,
  type SimulatorResultStatus,
} from "../../../adapters/supabase/payment/tpaySimulatorSettlement.js";
import { tpaySimulatorWebhookEnabled } from "./tpaySimulatorGate.js";

async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
  if (!tpaySimulatorWebhookEnabled()) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Tpay simulator webhook is disabled", {
      details: { feature: "payment-webhook", provider: "tpay", reason: "feature_flag_disabled" },
    });
    return;
  }

  const env = readEnv();
  if (!env) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Tpay simulator webhook is not configured", {
      details: { feature: "payment-webhook", provider: "tpay-simulator" },
    });
    return;
  }

  const parsed = parseSimulatorRequest(req.body);
  if (!parsed) {
    sendBffError(res, "BAD_REQUEST", "Invalid Tpay simulator webhook payload", {
      details: { provider: "tpay-simulator" },
    });
    return;
  }

  const gateway = createSupabaseDataGateway(env.gatewayEnv);

  // Never surface an uncaught 500 (FUNCTION_INVOCATION_FAILED) — a real provider treats it
  // as retryable forever. Wrap every DB call: conflicts -> 409, anything else -> 503.
  try {
    await processSimulatorWebhook(res, gateway, parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (IDEMPOTENCY_CONFLICT.test(message)) {
      sendBffError(res, "CONFLICT", "Tpay simulator webhook idempotency conflict", {
        details: { provider: "tpay-simulator", providerPaymentId: parsed.providerPaymentId },
      });
      return;
    }
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Tpay simulator webhook processing failed", {
      details: { provider: "tpay-simulator", providerPaymentId: parsed.providerPaymentId },
    });
  }
}

async function processSimulatorWebhook(
  res: VercelResponse,
  gateway: DataGatewayPort,
  parsed: ParsedSimulatorRequest,
): Promise<void> {
  const outcome = await settleSimulatorTransaction(
    gateway,
    parsed,
    consumeSupabasePaymentMethodDelivery,
  );
  if (!outcome.matched) {
    sendBffError(res, "BAD_REQUEST", "Tpay simulator event did not match a payment attempt", {
      details: { provider: "tpay-simulator", providerPaymentId: parsed.providerPaymentId },
    });
    return;
  }

  sendBffSuccess(res, {
    provider: "tpay",
    simulator: true,
    providerPaymentId: parsed.providerPaymentId,
    paymentEventId: outcome.paymentEventId,
    paymentIntentId: outcome.paymentIntentId,
    resultStatus: outcome.resultStatus,
    aliasResult: outcome.aliasResult,
    methodRefReplayed: outcome.methodRefReplayed,
    replayed: outcome.replayed,
  });
}

function readEnv(): { gatewayEnv: SupabaseDataGatewayEnv } | null {
  const gatewayEnv = readSupabaseDataGatewayEnv();
  return gatewayEnv ? { gatewayEnv } : null;
}

function parseSimulatorRequest(body: unknown): ParsedSimulatorRequest | null {
  const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const providerPaymentId = typeof record.providerPaymentId === "string" ? record.providerPaymentId.trim() : "";
  const resultStatus = typeof record.resultStatus === "string" ? record.resultStatus : "";
  const aliasResult = typeof record.aliasResult === "string" ? record.aliasResult : "";
  const clientId = typeof record.clientId === "string" ? record.clientId.trim() : "";
  const subscriptionId = typeof record.subscriptionId === "string" ? record.subscriptionId.trim() : "";
  const providerMethodRef = typeof record.providerMethodRef === "string" ? record.providerMethodRef.trim() : "";
  const amountMinor = typeof record.amountMinor === "number" && Number.isInteger(record.amountMinor)
    ? record.amountMinor
    : null;
  if (!providerPaymentId.startsWith("tpay_sim_")) return null;
  if (!["succeeded", "failed", "expired"].includes(resultStatus)) return null;
  if (aliasResult) {
    if (!["accepted", "rejected"].includes(aliasResult)) return null;
    if (resultStatus !== "succeeded" || !clientId || !providerMethodRef) return null;
  }
  return {
    providerPaymentId,
    resultStatus: resultStatus as SimulatorResultStatus,
    amountMinor,
    aliasResult: aliasResult ? aliasResult as SimulatorAliasResult : null,
    clientId: clientId || null,
    subscriptionId: subscriptionId || null,
    providerMethodRef: providerMethodRef || null,
  };
}

export default withObservedRoute({
  route: "/api/bff/payment/webhooks/tpay-simulator",
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
