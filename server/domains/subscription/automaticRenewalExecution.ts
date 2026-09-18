import type { PaymentExecutionInput } from "../../../src/domains/payment/types.js";
import { buildProviderAttemptIdentity } from "../../../src/lib/providerAttemptIdempotency.js";
import type {
  AutomaticRenewalDue,
  AutomaticRenewalPaymentRail,
  AutomaticRenewalReadback,
  AutomaticRenewalSettlementPort,
  AutomaticRenewalStorePort,
} from "./automaticRenewalPorts.js";
import type {
  AutomaticRenewalRunDeps,
  AutomaticRenewalRunResult,
  AutomaticRenewalRunStatus,
} from "./runAutomaticSubscriptionRenewal.js";
import { nextRetryAttemptAt } from "../../../src/domains/subscription/cycleHardening.js";

export function paymentExecutionInput(
  due: AutomaticRenewalDue,
  operation: AutomaticRenewalReadback,
  prepared: { orderId: string; settlementIntentId: string },
): PaymentExecutionInput {
  const identity = buildProviderAttemptIdentity({
    provider: operation.cycleSnapshot.settlementChannelKey,
    localExecutionIdempotencyKey: `${operation.identityKey}:provider-attempt`,
    paymentIntentId: prepared.settlementIntentId,
    amountMinor: operation.cycleSnapshot.totalAmountMinor,
    currency: operation.cycleSnapshot.currency,
    mode: "subscription_cycle",
    orderRef: prepared.orderId,
  });
  return {
    idempotencyKey: `${operation.identityKey}:provider-attempt`,
    providerIdempotencyKey: identity.providerIdempotencyKey,
    providerRequestFingerprint: operation.operationFingerprint,
    paymentIntentId: prepared.settlementIntentId,
    amountMinor: operation.cycleSnapshot.totalAmountMinor,
    currency: operation.cycleSnapshot.currency,
    mode: "subscription_cycle",
    orderRef: prepared.orderId,
    orderId: prepared.orderId,
    providerFlow: "off_session_payment",
    customerRef: operation.cycleSnapshot.payerAccountRef ?? undefined,
    paymentMethodRef: operation.cycleSnapshot.authorizationRef,
    clientId: due.clientId,
  };
}

export function automaticRenewalResult(
  operation: AutomaticRenewalReadback,
  status: AutomaticRenewalRunStatus,
  reason: string | null,
): AutomaticRenewalRunResult {
  return {
    subscriptionId: operation.subscriptionId,
    identityKey: operation.identityKey,
    operationId: operation.operationId,
    status,
    replayed: operation.replayed,
    reason,
  };
}

export async function recoverPreparedExternalAttempt(input: {
  operation: AutomaticRenewalReadback;
  rail: AutomaticRenewalPaymentRail;
  settlement: AutomaticRenewalSettlementPort;
  occurredAt: string;
}): Promise<string | null> {
  if (input.operation.externalAttemptRef) return input.operation.externalAttemptRef;
  if (!input.operation.settlementIntentId || !input.rail.findExternalAttempt) return null;
  const externalAttemptRef = await input.rail.findExternalAttempt({
    settlementIntentId: input.operation.settlementIntentId,
  });
  if (!externalAttemptRef) return null;
  await input.settlement.acknowledgeExternalAttempt({
    operationId: input.operation.operationId,
    operationFingerprint: input.operation.operationFingerprint,
    externalAttemptRef,
    acknowledgedAt: input.occurredAt,
  });
  return externalAttemptRef;
}

export async function runRenewalBatchRows(
  due: AutomaticRenewalDue[],
  run: (row: AutomaticRenewalDue) => Promise<AutomaticRenewalRunResult>,
): Promise<AutomaticRenewalRunResult[]> {
  const results: AutomaticRenewalRunResult[] = [];
  for (const row of due) {
    try {
      results.push(await run(row));
    } catch {
      results.push({
        subscriptionId: row.subscriptionId,
        identityKey: renewalIdentityKey(row),
        operationId: "", status: "error", replayed: false,
        reason: "renewal_processing_failed",
      });
    }
  }
  return results;
}

function renewalIdentityKey(row: AutomaticRenewalDue): string {
  return `subscription:${row.subscriptionId.trim()}:cycle:${new Date(row.scheduledAt).toISOString()}`;
}

export async function refuseRenewalBeforePayment(input: {
  store: AutomaticRenewalStorePort;
  operation: AutomaticRenewalReadback;
  reason: string;
  occurredAt: string;
}): Promise<AutomaticRenewalRunResult> {
  const refused = await input.store.refuseBeforePayment({
    operationId: input.operation.operationId,
    claimToken: input.operation.claimToken,
    reason: input.reason,
    occurredAt: input.occurredAt,
  });
  return automaticRenewalResult(refused, "refused", input.reason);
}

// A handoff always opens the case, so its refusal is rung one; later rungs
// are advanced by the lifecycle's own failure boundary, never by a handoff.
const HANDOFF_OPENS_AT_RETRY_ATTEMPT = 1;

export async function handoffRefusal(
  deps: AutomaticRenewalRunDeps,
  operation: AutomaticRenewalReadback,
  prepared: { cycleId: string; orderId: string; settlementIntentId: string },
  externalAttemptRef: string | null,
  reason: string,
  failureClass: string,
  occurredAt: string,
): Promise<AutomaticRenewalRunResult> {
  await deps.failureHandoff.handoffFailure({
    idempotencyKey: `${operation.identityKey}:failure-handoff`,
    subscriptionId: operation.subscriptionId,
    clientId: operation.cycleSnapshot.clientId,
    cycleId: prepared.cycleId,
    orderId: prepared.orderId,
    paymentIntentId: prepared.settlementIntentId,
    failureClass,
    failureReason: reason,
    // Decided beside the class, never in the lifecycle adapter: that boundary's
    // contract forbids calculating cadence, and a schedule invented downstream
    // of the classification could outlive a decision to stop retrying.
    nextRetryAt: nextRetryAttemptAt(
      occurredAt,
      HANDOFF_OPENS_AT_RETRY_ATTEMPT,
      undefined,
      failureClass,
    ),
    occurredAt,
    amountMinor: operation.cycleSnapshot.totalAmountMinor,
    currency: operation.cycleSnapshot.currency,
  });
  await deps.settlement.recordTerminalOutcome({
    operationId: operation.operationId,
    eventKey: `${operation.identityKey}:provider-refusal`,
    operationFingerprint: operation.operationFingerprint,
    outcome: "refused",
    externalRef: externalAttemptRef,
    reason,
    occurredAt,
  });
  return automaticRenewalResult(operation, "refused", reason);
}
