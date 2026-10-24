import { nextRetryAttemptAt } from "@openlup/core/subscription";
import type { RenewalDue, RenewalPaymentRail, RenewalReadback, RenewalSettlementPort, RenewalStorePort } from "./contracts/renewal.js";
import type { AutomaticRenewalPolicy, AutomaticRenewalRunDeps, AutomaticRenewalRunResult, AutomaticRenewalRunStatus } from "./automaticRenewal.js";
export function automaticRenewalResult(operation: RenewalReadback, status: AutomaticRenewalRunStatus, reason: string | null): AutomaticRenewalRunResult {
  return { subscriptionId: operation.subscriptionId, identityKey: operation.identityKey, operationId: operation.operationId, status, replayed: operation.replayed, reason };
}
export async function recoverPreparedExternalAttempt(input: { operation: RenewalReadback; rail: RenewalPaymentRail; settlement: RenewalSettlementPort; occurredAt: string }): Promise<string | null> {
  if (input.operation.externalAttemptRef) return input.operation.externalAttemptRef;
  if (!input.operation.settlementIntentId) return null;
  const externalAttemptRef = await input.rail.findExternalAttempt({ settlementIntentId: input.operation.settlementIntentId });
  if (!externalAttemptRef) return null;
  await input.settlement.acknowledgeExternalAttempt({ operationId: input.operation.operationId, operationFingerprint: input.operation.operationFingerprint, externalAttemptRef, acknowledgedAt: input.occurredAt });
  return externalAttemptRef;
}
export async function runRenewalBatchRows(due: RenewalDue[], run: (row: RenewalDue) => Promise<AutomaticRenewalRunResult>, policy: Pick<AutomaticRenewalPolicy, "identityKey">): Promise<AutomaticRenewalRunResult[]> {
  const results: AutomaticRenewalRunResult[] = [];
  for (const row of due) {
    try { results.push(await run(row)); }
    catch { results.push({ subscriptionId: row.subscriptionId, identityKey: policy.identityKey(row), operationId: "", status: "error", replayed: false, reason: "renewal_processing_failed" }); }
  }
  return results;
}
export async function refuseRenewalBeforePayment(input: { store: RenewalStorePort; operation: RenewalReadback; reason: string; occurredAt: string }): Promise<AutomaticRenewalRunResult> {
  const refused = await input.store.refuseBeforePayment({ operationId: input.operation.operationId, claimToken: input.operation.claimToken, reason: input.reason, occurredAt: input.occurredAt });
  return automaticRenewalResult(refused, "refused", input.reason);
}
const HANDOFF_OPENS_AT_RETRY_ATTEMPT = 1;
export async function handoffRefusal(deps: AutomaticRenewalRunDeps, operation: RenewalReadback, prepared: { cycleId: string; orderId: string; settlementIntentId: string }, externalAttemptRef: string | null, reason: string, failureClass: string, occurredAt: string): Promise<AutomaticRenewalRunResult> {
  await deps.failureHandoff.handoffFailure({
    idempotencyKey: `${operation.identityKey}:failure-handoff`, subscriptionId: operation.subscriptionId,
    clientId: operation.cycleSnapshot.clientId, cycleId: prepared.cycleId, orderId: prepared.orderId,
    paymentIntentId: prepared.settlementIntentId, retryAttempt: HANDOFF_OPENS_AT_RETRY_ATTEMPT,
    failureClass, failureReason: reason,
    nextRetryAt: nextRetryAttemptAt(occurredAt, HANDOFF_OPENS_AT_RETRY_ATTEMPT, undefined, failureClass),
    occurredAt, amountMinor: operation.cycleSnapshot.pricingSnapshot.totalAmountMinor, currency: operation.cycleSnapshot.pricingSnapshot.currency,
  });
  await deps.settlement.recordTerminalOutcome({ operationId: operation.operationId, eventKey: `${operation.identityKey}:provider-refusal`, operationFingerprint: operation.operationFingerprint, outcome: "refused", externalRef: externalAttemptRef, reason, occurredAt });
  return automaticRenewalResult(operation, "refused", reason);
}
