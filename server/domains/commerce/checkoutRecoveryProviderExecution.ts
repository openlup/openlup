import { buildProviderAttemptIdentity } from "../../../src/lib/providerAttemptIdempotency.js";
import type { CheckoutPaymentExecution } from "../../../src/domains/commerce/paymentExecutionContracts.js";
import type { PaymentExecutionPort } from "../../../src/domains/payment/ports.js";
import type {
  PaymentExecutionProvider,
  PaymentProviderFlow,
} from "../../../src/domains/payment/types.js";
import { tpayTransientInput } from "../../shared/tpayTransientInput.js";
import type { CheckoutRecoveryOrderSnapshot } from "./checkoutRecoveryOrderPort.js";

/**
 * Builds the deterministic provider-execution envelope for an already-existing
 * recovery order. This boundary deliberately owns per-click idempotency and
 * payer fallback; the recovery service remains responsible for durable payment
 * attempt transitions and customer-safe result handling.
 */
export function buildRecoveryProviderExecution(input: {
  order: CheckoutRecoveryOrderSnapshot;
  clientId: string;
  paymentProvider: PaymentExecutionProvider;
  paymentExecution: CheckoutPaymentExecution | undefined;
  idempotencyKey: string;
  providerFlow: PaymentProviderFlow;
  paymentIntentId: string;
  payer?: { email: string; name: string; ip?: string | null; userAgent?: string | null };
}) {
  const executionIdempotencyKey = `${input.idempotencyKey}:payment-execution`;
  const mode = input.order.mode === "subscription_cycle" ? "subscription_cycle" : "one_time";
  const identity = buildProviderAttemptIdentity({
    provider: input.paymentProvider,
    localExecutionIdempotencyKey: executionIdempotencyKey,
    paymentIntentId: input.paymentIntentId,
    amountMinor: input.order.totalMinor,
    currency: input.order.currency,
    mode,
    orderRef: input.order.orderRef,
  });

  const executionInput: Parameters<PaymentExecutionPort["execute"]>[0] = {
    idempotencyKey: executionIdempotencyKey,
    providerIdempotencyKey: identity.providerIdempotencyKey,
    providerRequestFingerprint: identity.providerRequestFingerprint,
    paymentIntentId: input.paymentIntentId,
    amountMinor: input.order.totalMinor,
    currency: input.order.currency,
    mode,
    orderRef: input.order.orderRef,
    orderId: input.order.orderId,
    providerFlow: input.providerFlow,
    clientId: input.clientId,
    saveForFutureUse: input.order.mode === "subscription_cycle",
    returnContext: "public",
    payer: input.payer ?? resolvePayer(input.order),
    transientProviderInput: tpayTransientInput(input.paymentExecution),
  };

  return { executionIdempotencyKey, identity, executionInput };
}

function resolvePayer(order: CheckoutRecoveryOrderSnapshot) {
  if (!order.customerEmail) return undefined;
  return { email: order.customerEmail, name: order.customerName ?? order.customerEmail };
}
