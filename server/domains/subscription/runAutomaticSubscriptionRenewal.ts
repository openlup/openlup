import { classifyPaymentFailure } from "@openlup/core/payment";
import { classifyDecline, declineFailureReason } from "../../shared/finalizeDeclinedAttempt.js";
import type {
  AutomaticRenewalDue,
  AutomaticRenewalFailureHandoffPort,
  AutomaticRenewalInventoryPort,
  AutomaticRenewalPaymentRail,
  AutomaticRenewalPaymentRailResolver,
  AutomaticRenewalReadback,
  AutomaticRenewalSettlementPort,
  AutomaticRenewalStorePort,
} from "./automaticRenewalPorts.js";
import {
  automaticRenewalResult,
  handoffRefusal,
  paymentExecutionInput,
  recoverPreparedExternalAttempt,
  refuseRenewalBeforePayment,
  runRenewalBatchRows,
} from "./automaticRenewalExecution.js";

export type AutomaticRenewalRunStatus =
  | "succeeded"
  | "refused"
  | "awaiting_provider"
  | "error"
  | "lease_active"
  | "terminal_replay";

export interface AutomaticRenewalRunResult {
  subscriptionId: string;
  identityKey: string;
  operationId: string;
  status: AutomaticRenewalRunStatus;
  replayed: boolean;
  reason: string | null;
}

export interface AutomaticRenewalRunDeps {
  store: AutomaticRenewalStorePort;
  inventory: AutomaticRenewalInventoryPort;
  settlement: AutomaticRenewalSettlementPort;
  paymentRails: AutomaticRenewalPaymentRailResolver;
  failureHandoff: AutomaticRenewalFailureHandoffPort;
  workerId: string;
  now?: () => string;
}
export async function runAutomaticSubscriptionRenewals(deps: AutomaticRenewalRunDeps, limit = 50): Promise<AutomaticRenewalRunResult[]> {
  const now = (deps.now ?? defaultNow)();
  await deps.inventory.expireReservations({ now, limit: Math.max(limit, 100) });
  const due = await deps.store.listDue(limit, now);
  return runRenewalBatchRows(due, (row) => runOneAutomaticSubscriptionRenewal(deps, row, now));
}

export async function runOneAutomaticSubscriptionRenewal(
  deps: AutomaticRenewalRunDeps,
  due: AutomaticRenewalDue,
  occurredAt = (deps.now ?? defaultNow)(),
): Promise<AutomaticRenewalRunResult> {
  const snapshot = await deps.store.buildCycleSnapshots({
    subscriptionId: due.subscriptionId,
    scheduledAt: due.scheduledAt,
  });
  const claim = await deps.store.claimDue({
    snapshot,
    workerId: deps.workerId,
    now: occurredAt,
  });

  if (claim.state === "succeeded" || claim.state === "refused")
    return automaticRenewalResult(claim, "terminal_replay", claim.terminalReason);
  if (!claim.acquired) return automaticRenewalResult(claim, "lease_active", claim.reason);

  const rail = deps.paymentRails.resolve(snapshot.settlementChannelKey);
  if (!rail) return refuseRenewalBeforePayment({ store: deps.store, operation: claim,
    reason: "settlement_channel_not_configured", occurredAt });

  if (claim.state === "attempt_prepared") return resumePreparedAttempt(deps, claim, rail, occurredAt);

  const mandate = await deps.store.readMandateEvidence({
    subscriptionId: due.subscriptionId,
    scheduledAt: due.scheduledAt,
  });
  if (mandate.authorizationRef !== snapshot.authorizationRef)
    return refuseRenewalBeforePayment({ store: deps.store, operation: claim,
      reason: "authorization_evidence_mismatch", occurredAt });
  const delivery = await deps.store.admitDeliveryAlignment({
    subscriptionId: due.subscriptionId,
    scheduledAt: due.scheduledAt,
  });
  if (!delivery.allowed) {
    return refuseRenewalBeforePayment({
      store: deps.store, operation: claim,
      reason: delivery.reason ?? "delivery_alignment_blocked", occurredAt,
    });
  }

  const reservation = await deps.inventory.reserve({
    operationId: claim.operationId,
    claimToken: claim.claimToken,
    now: occurredAt,
  });
  if (!reservation.reserved) {
    return automaticRenewalResult(claim, "refused", reservation.reason ?? "insufficient_atp");
  }

  const prepared = await deps.settlement.prepareRenewal({
    operationId: claim.operationId,
    claimToken: claim.claimToken,
    now: occurredAt,
  });
  if (prepared.replayed) {
    // A replayed prepare may already have crossed the provider boundary: never
    // issue a second external call without a durable, readable acknowledgement.
    const readback = await deps.store.readRenewal(claim.identityKey);
    if (!readback) throw new Error("subscription_renewal_prepared_readback_missing");
    return resumePreparedAttempt(deps, readback, rail, occurredAt);
  }

  const executionInput = paymentExecutionInput(due, claim, prepared);
  try {
    rail.executionPort.validateInput?.(executionInput);
  } catch {
    await deps.settlement.recordTerminalOutcome({
      operationId: claim.operationId,
      eventKey: `${claim.identityKey}:provider-preflight`,
      operationFingerprint: claim.operationFingerprint,
      outcome: "refused",
      reason: "provider_input_invalid",
      occurredAt,
    });
    return automaticRenewalResult(claim, "refused", "provider_input_invalid");
  }

  let execution: Awaited<ReturnType<AutomaticRenewalPaymentRail["executionPort"]["execute"]>>;
  try {
    execution = await rail.executionPort.execute(executionInput);
  } catch {
    // Timeout/SDK failure may follow an accepted charge: the durable prepared
    // attempt stays non-terminal deliberately and is never charged again.
    return automaticRenewalResult(claim, "awaiting_provider", "provider_execution_indeterminate");
  }

  const externalAttemptRef = execution.providerAttemptId?.trim()
    || execution.providerSessionId?.trim()
    || null;
  if (externalAttemptRef) {
    await deps.settlement.acknowledgeExternalAttempt({
      operationId: claim.operationId,
      operationFingerprint: claim.operationFingerprint,
      externalAttemptRef,
      acknowledgedAt: occurredAt,
    });
  }

  if (execution.providerDecline) {
    const failureReason = declineFailureReason(execution.providerDecline);
    return handoffRefusal(
      deps,
      claim,
      prepared,
      externalAttemptRef,
      failureReason,
      classifyDecline(execution.providerDecline).failureClass,
      occurredAt,
    );
  }
  if (execution.attemptStatus === "requires_action") {
    return handoffRefusal(
      deps,
      claim,
      prepared,
      externalAttemptRef,
      "off_session_sca_required",
      classifyPaymentFailure({ failureReasonKey: "off_session_sca_required" }).failureClass,
      occurredAt,
    );
  }
  if (!externalAttemptRef) {
    return automaticRenewalResult(claim, "awaiting_provider", "provider_attempt_ack_missing");
  }

  return readAndApplyProviderOutcome(deps, claim, prepared, rail, externalAttemptRef, occurredAt);
}

async function resumePreparedAttempt(
  deps: AutomaticRenewalRunDeps,
  operation: AutomaticRenewalReadback,
  rail: AutomaticRenewalPaymentRail,
  occurredAt: string,
): Promise<AutomaticRenewalRunResult> {
  if (!operation.cycleId || !operation.orderId || !operation.settlementIntentId) {
    throw new Error("subscription_renewal_prepared_artifacts_missing");
  }
  const externalAttemptRef = await recoverPreparedExternalAttempt({
    operation, rail, settlement: deps.settlement, occurredAt,
  });
  if (!externalAttemptRef) {
    return automaticRenewalResult(operation, "awaiting_provider", "prepared_attempt_ack_missing");
  }
  return readAndApplyProviderOutcome(
    deps,
    operation,
    {
      cycleId: operation.cycleId,
      orderId: operation.orderId,
      settlementIntentId: operation.settlementIntentId,
    },
    rail,
    externalAttemptRef,
    occurredAt,
  );
}

async function readAndApplyProviderOutcome(
  deps: AutomaticRenewalRunDeps,
  operation: AutomaticRenewalReadback,
  prepared: { cycleId: string; orderId: string; settlementIntentId: string },
  rail: AutomaticRenewalPaymentRail,
  externalAttemptRef: string,
  occurredAt: string,
): Promise<AutomaticRenewalRunResult> {
  const observed = await rail.readOutcome({
    externalAttemptRef,
    settlementIntentId: prepared.settlementIntentId,
    orderId: prepared.orderId,
    subscriptionId: operation.subscriptionId,
    amountMinor: operation.cycleSnapshot.totalAmountMinor,
    currency: operation.cycleSnapshot.currency,
  });
  if (observed.amountMinor !== null && observed.amountMinor !== operation.cycleSnapshot.totalAmountMinor) {
    throw new Error("subscription_renewal_provider_amount_mismatch");
  }
  if (observed.currency !== null
    && observed.currency.toUpperCase() !== operation.cycleSnapshot.currency.toUpperCase()) {
    throw new Error("subscription_renewal_provider_currency_mismatch");
  }
  if (observed.status === "pending" || observed.status === "unknown") {
    return automaticRenewalResult(operation, "awaiting_provider", `provider_${observed.status}`);
  }
  const terminalAt = observed.occurredAt ?? occurredAt;
  if (observed.status === "failed") {
    const failureReason = observed.reason ?? "provider_failed";
    return handoffRefusal(
      deps,
      operation,
      prepared,
      externalAttemptRef,
      failureReason,
      classifyPaymentFailure({ failureReasonKey: failureReason }).failureClass,
      terminalAt,
    );
  }
  await deps.settlement.recordTerminalOutcome({
    operationId: operation.operationId,
    eventKey: `${operation.identityKey}:provider-success:${externalAttemptRef}`,
    operationFingerprint: operation.operationFingerprint,
    outcome: "succeeded",
    externalRef: externalAttemptRef,
    occurredAt: terminalAt,
  });
  return automaticRenewalResult(operation, "succeeded", null);
}

function defaultNow(): string { return new Date().toISOString(); }
