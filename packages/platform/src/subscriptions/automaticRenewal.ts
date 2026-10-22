import type { RenewalDue, RenewalExecutionRequest, RenewalFrozenSnapshot, RenewalPaymentRail, RenewalPreparedSettlement, RenewalReadback, RenewalReservationResult, RenewalSettlementPort, RenewalStorePort } from "./contracts/renewal.js";
import type { RenewalFailureHandoffPort } from "./contracts/dunning.js";
import { automaticRenewalResult, handoffRefusal, recoverPreparedExternalAttempt, refuseRenewalBeforePayment, runRenewalBatchRows } from "./automaticRenewalExecution.js";
import { readAndApplyProviderOutcome } from "./paymentOutcomes.js";
export type AutomaticRenewalRunStatus = "succeeded" | "refused" | "deferred" | "awaiting_provider" | "error" | "lease_active" | "terminal_replay";
export interface AutomaticRenewalRunResult {
  subscriptionId: string; identityKey: string; operationId: string;
  status: AutomaticRenewalRunStatus; replayed: boolean; reason: string | null; caseRef?: string;
}
export interface AutomaticRenewalPolicy {
  executionInput(due: RenewalDue, operation: RenewalReadback, prepared: Pick<RenewalPreparedSettlement, "orderId" | "settlementIntentId">): RenewalExecutionRequest;
  validateInput(input: RenewalExecutionRequest): void;
  classifyFailure(reason: string): string;
  identityKey(due: RenewalDue): string;
}
export interface AutomaticRenewalRunDeps {
  store: RenewalStorePort;
  inventory: {
    expireReservations(input: { now: string; limit?: number }): Promise<number>;
    reserve(input: { operationId: string; claimToken: string; now: string }): Promise<RenewalReservationResult>;
  };
  settlement: RenewalSettlementPort;
  paymentRails: { resolve(channelKey: string): RenewalPaymentRail | null };
  failureHandoff: RenewalFailureHandoffPort;
  policy: AutomaticRenewalPolicy;
  workerId: string; now?: () => string;
}
export async function runAutomaticSubscriptionRenewals(deps: AutomaticRenewalRunDeps, limit = 50): Promise<AutomaticRenewalRunResult[]> {
  const now = (deps.now ?? defaultNow)();
  await deps.inventory.expireReservations({ now, limit: Math.max(limit, 100) });
  const due = await deps.store.listDue(limit, now);
  return runRenewalBatchRows(due, row => runOneAutomaticSubscriptionRenewal(deps, row, now), deps.policy);
}
export async function runOneAutomaticSubscriptionRenewal(deps: AutomaticRenewalRunDeps, due: RenewalDue, occurredAt = (deps.now ?? defaultNow)()): Promise<AutomaticRenewalRunResult> {
  const schedule = { subscriptionId: due.subscriptionId, scheduledAt: due.scheduledAt, scheduledInstant: due.scheduledInstant };
  const snapshot = await deps.store.buildCycleSnapshots(schedule);
  const claim = await deps.store.claimDue({ snapshot, workerId: deps.workerId, now: occurredAt });
  if (claim.state === "succeeded" || claim.state === "refused") return automaticRenewalResult(claim, "terminal_replay", claim.terminalReason);
  if (!claim.acquired) return automaticRenewalResult(claim, "lease_active", claim.reason);
  const rail = deps.paymentRails.resolve(snapshot.settlementChannelKey);
  if (!rail) return refuseRenewalBeforePayment({ store: deps.store, operation: claim, reason: "settlement_channel_not_configured", occurredAt });
  if (claim.state === "attempt_prepared") return resumePreparedAttempt(deps, claim, rail, occurredAt);
  const mandate = await deps.store.readMandateEvidence(schedule);
  if (!mandate.authorized || mandate.authorizationRef !== snapshot.authorizationRef) return refuseRenewalBeforePayment({ store: deps.store, operation: claim, reason: "authorization_evidence_mismatch", occurredAt });
  const delivery = await deps.store.admitDeliveryAlignment({ ...schedule, occurredAt });
  if (!delivery.allowed) {
    if (delivery.deferred) return { ...automaticRenewalResult(claim, "deferred", delivery.reason), ...(delivery.caseRef ? { caseRef: delivery.caseRef } : {}) };
    return refuseRenewalBeforePayment({ store: deps.store, operation: claim, reason: delivery.reason, occurredAt });
  }
  const reservation = await deps.inventory.reserve({ operationId: claim.operationId, claimToken: claim.claimToken, now: occurredAt });
  if (!reservation.reserved) return automaticRenewalResult(claim, "refused", reservation.reason ?? "insufficient_atp");
  const prepared = await deps.settlement.prepareRenewal({ operationId: claim.operationId, claimToken: claim.claimToken, now: occurredAt });
  if (prepared.replayed) {
    const readback = await deps.store.readRenewal(claim.identityKey);
    if (!readback) throw new Error("subscription_renewal_prepared_readback_missing");
    return resumePreparedAttempt(deps, readback, rail, occurredAt);
  }
  const executionInput = deps.policy.executionInput(due, claim, prepared);
  try { deps.policy.validateInput(executionInput); }
  catch {
    await deps.settlement.recordTerminalOutcome({ operationId: claim.operationId, eventKey: `${claim.identityKey}:provider-preflight`, operationFingerprint: claim.operationFingerprint, outcome: "refused", reason: "provider_input_invalid", occurredAt });
    return automaticRenewalResult(claim, "refused", "provider_input_invalid");
  }
  let execution: Awaited<ReturnType<RenewalPaymentRail["execute"]>>;
  try { execution = await rail.execute(executionInput); }
  catch { return automaticRenewalResult(claim, "awaiting_provider", "provider_execution_indeterminate"); }
  const externalAttemptRef = execution.externalAttemptRef?.trim() || null;
  if (externalAttemptRef) await deps.settlement.acknowledgeExternalAttempt({ operationId: claim.operationId, operationFingerprint: claim.operationFingerprint, externalAttemptRef, acknowledgedAt: occurredAt });
  if (execution.status === "failed" || execution.status === "requires_action") {
    const reason = execution.failure?.reason ?? (execution.status === "requires_action" ? "off_session_sca_required" : "provider_failed");
    return handoffRefusal(deps, claim, prepared, externalAttemptRef, reason, execution.failure?.failureClass ?? deps.policy.classifyFailure(reason), occurredAt);
  }
  if (!externalAttemptRef) return automaticRenewalResult(claim, "awaiting_provider", "provider_attempt_ack_missing");
  return readAndApplyProviderOutcome(deps, claim, prepared, rail, externalAttemptRef, occurredAt);
}
async function resumePreparedAttempt(deps: AutomaticRenewalRunDeps, operation: RenewalReadback, rail: RenewalPaymentRail, occurredAt: string): Promise<AutomaticRenewalRunResult> {
  if (!operation.cycleId || !operation.orderId || !operation.settlementIntentId) throw new Error("subscription_renewal_prepared_artifacts_missing");
  const externalAttemptRef = await recoverPreparedExternalAttempt({ operation, rail, settlement: deps.settlement, occurredAt });
  if (!externalAttemptRef) return automaticRenewalResult(operation, "awaiting_provider", "prepared_attempt_ack_missing");
  return readAndApplyProviderOutcome(deps, operation, { cycleId: operation.cycleId, orderId: operation.orderId, settlementIntentId: operation.settlementIntentId }, rail, externalAttemptRef, occurredAt);
}
function defaultNow(): string { return new Date().toISOString(); }
/** No implicit +1: ambiguous history must be resolved by the host before opening a repair case. */
export function correlatedLogicalCycle(snapshot: RenewalFrozenSnapshot): number {
  if (snapshot.cycle.status !== "correlated") throw new Error("subscription_renewal_cycle_correlation_required");
  return snapshot.cycle.logicalCycleNumber;
}
