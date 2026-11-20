import {
  createDefaultRenewalPreflightPolicy,
  recordRenewalPreflightBlock,
} from "@openlup/platform/subscriptions";
import type { PaymentControlRuntimePort } from "../../../src/domains/commerce/ports.js";
import { buildProviderAttemptIdentity } from "../../../src/lib/providerAttemptIdempotency.js";
import type {
  DueSubscription,
  SubscriptionRenewalPersistencePort,
  SubscriptionRenewalChargeResult,
} from "./chargeSubscriptionCycleOffSession.js";
import {
  renewalFailurePolicy,
  type CycleChargeFailurePropagationPort,
} from "./propagateSubscriptionCycleChargeFailure.js";
import type { SubscriptionPaymentMethodPreflightReason } from "../../../src/domains/subscription/paymentMethodLifecycle.js";
import { acceptedCycleCurrency } from "./subscriptionCycleOrderTotals.js";

export interface RenewalPreflightBlockDeps {
  persistence: SubscriptionRenewalPersistencePort;
  chargeFailurePropagation: CycleChargeFailurePropagationPort;
  paymentPort: PaymentControlRuntimePort;
  now?: () => string;
}

const OPERATOR_CONFIG_PREFLIGHT_REASONS = new Set<string>([
  "stripe_provider_not_configured",
  "tpay_provider_not_configured",
  "subscription_provider_not_supported",
] satisfies SubscriptionPaymentMethodPreflightReason[]);
const PAYMENT_METHOD_INTEGRITY_PREFLIGHT_REASONS = new Set<string>([
  "payment_method_cross_client",
  "payment_method_unhandled_status",
] satisfies SubscriptionPaymentMethodPreflightReason[]);

export function isOperatorConfigPreflightReason(reason: string): boolean {
  return OPERATOR_CONFIG_PREFLIGHT_REASONS.has(reason);
}

export function isPaymentMethodIntegrityPreflightReason(reason: string): boolean {
  return PAYMENT_METHOD_INTEGRITY_PREFLIGHT_REASONS.has(reason);
}

export function isOperatorOnlyPreflightReason(reason: string): boolean {
  return isOperatorConfigPreflightReason(reason) || isPaymentMethodIntegrityPreflightReason(reason);
}

type PreflightIntentInput = Parameters<PaymentControlRuntimePort["createIntent"]>[0];
type PreflightIntentResult = Awaited<ReturnType<PaymentControlRuntimePort["createIntent"]>>;

const preflightPolicy = createDefaultRenewalPreflightPolicy<
  DueSubscription,
  PreflightIntentInput,
  PreflightIntentResult
>({
  isOperatorOnly: isOperatorOnlyPreflightReason,
  logOperatorBlock: (fields) =>
    console.warn("[subscription-renewal] operator-only preflight block; skipping customer dunning", fields),
  intentInput: (due, cycleKey, snapshots, cycleOrder, totalGrossMinor, reason) => ({
    idempotencyKey: `${cycleKey}:payment-intent`,
    targetKind: "subscription_cycle",
    orderId: cycleOrder.orderUuid,
    subscriptionId: due.subscriptionId,
    subscriptionCycleId: cycleOrder.cycleId,
    amountMinor: totalGrossMinor,
    currency: acceptedCycleCurrency(due.currency),
    metadata: {
      source: "subscription.renewal.preflight.v0",
      runtimeIdempotencyKey: cycleKey,
      cycleNumber: snapshots.cycleNumber,
      scheduledAt: due.nextCycleAt,
      preflightBlockReason: reason,
    },
  }),
  identity: (due, executionKey, intent, cycleOrder, totalGrossMinor) =>
    buildProviderAttemptIdentity({
      provider: due.providerKind?.trim() || "unknown",
      localExecutionIdempotencyKey: executionKey,
      paymentIntentId: intent.paymentIntentId,
      amountMinor: totalGrossMinor,
      currency: due.currency,
      mode: "subscription_cycle",
      orderRef: cycleOrder.orderRef,
    }),
  failure: renewalFailurePolicy,
});

export async function recordSubscriptionRenewalPreflightBlock(
  deps: RenewalPreflightBlockDeps,
  due: DueSubscription,
  reason: string,
): Promise<SubscriptionRenewalChargeResult> {
  return recordRenewalPreflightBlock(deps, due, reason, preflightPolicy);
}
