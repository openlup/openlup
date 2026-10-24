import type { RenewalPaymentRail, RenewalReadback } from "./contracts/renewal.js";
import type { AutomaticRenewalRunDeps, AutomaticRenewalRunResult } from "./automaticRenewal.js";
import { automaticRenewalResult, handoffRefusal } from "./automaticRenewalExecution.js";
/** H4: only explicit verified matching M07 evidence may become positive local truth. */
export async function readAndApplyProviderOutcome(deps: AutomaticRenewalRunDeps, operation: RenewalReadback, prepared: { cycleId: string; orderId: string; settlementIntentId: string }, rail: RenewalPaymentRail, externalAttemptRef: string, occurredAt: string): Promise<AutomaticRenewalRunResult> {
  const money = operation.cycleSnapshot.pricingSnapshot;
  const observed = await rail.readOutcome({ externalAttemptRef, settlementIntentId: prepared.settlementIntentId, orderId: prepared.orderId, subscriptionId: operation.subscriptionId, amountMinor: money.totalAmountMinor, currency: money.currency });
  if (observed.amountMinor !== null && observed.amountMinor !== money.totalAmountMinor) throw new Error("subscription_renewal_provider_amount_mismatch");
  if (observed.currency !== null && observed.currency.toUpperCase() !== money.currency.toUpperCase()) throw new Error("subscription_renewal_provider_currency_mismatch");
  if (observed.status !== "succeeded" && observed.status !== "failed") return automaticRenewalResult(operation, "awaiting_provider", `provider_${observed.status}`);
  if (observed.operationId !== operation.operationId || observed.requestFingerprint !== operation.operationFingerprint
    || observed.externalAttemptRef !== externalAttemptRef || !observed.verifiedEvidenceRef || !observed.eventKey
    || !observed.firstRecordedAt || !observed.observedAt) throw new Error("subscription_renewal_verified_evidence_required");
  if (observed.disposition === "ambiguous") return automaticRenewalResult(operation, "awaiting_provider", "provider_ambiguous");
  const terminalAt = observed.occurredAt ?? occurredAt;
  if (observed.status === "failed") {
    const reason = observed.reason ?? "provider_failed";
    return handoffRefusal(deps, operation, prepared, externalAttemptRef, reason, deps.policy.classifyFailure(reason), terminalAt);
  }
  if (observed.amountMinor === null || observed.currency === null || observed.occurredAt === null) return automaticRenewalResult(operation, "awaiting_provider", "provider_positive_evidence_incomplete");
  await deps.settlement.recordTerminalOutcome({ operationId: operation.operationId, eventKey: `${operation.identityKey}:provider-success:${externalAttemptRef}`, operationFingerprint: operation.operationFingerprint, outcome: "succeeded", externalRef: externalAttemptRef, occurredAt: terminalAt });
  return automaticRenewalResult(operation, "succeeded", null);
}
