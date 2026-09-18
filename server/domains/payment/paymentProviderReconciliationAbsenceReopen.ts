import {
  absenceProbeEvidenceKey,
  absenceReopenKey,
  safeMessage,
} from "./paymentProviderReconciliationEvidence.js";
import type {
  ClaimedPaymentAttempt,
  PaymentProviderReconciliationProvider,
  PaymentProviderReconciliationWorkerInput,
} from "./paymentProviderReconciliationContracts.js";

// Mirrors the RPC's v_min_stranded_age guard (migration 20260711153000). The
// worker pre-checks so an under-age attempt is a silent skip for this pass
// instead of a guaranteed `prepared_attempt_absence_reopen_too_fresh` reject.
const MIN_PREPARED_ABSENCE_REOPEN_AGE_SECONDS = 30 * 60;

/**
 * Auto-reopen a stranded prepared attempt after a GENUINE provider-side
 * absence proof. A purely local "no ack recorded" signal cannot rule out the
 * crash window between executionPort.execute() (provider charged) and
 * finalizeProviderAttempt (refs persisted) — reopening in that window would
 * mint a fresh PSP idempotency key and double-charge. Providers without an
 * absence probe (Tpay) stay operator-manual via the reopen RPC.
 *
 * Returns true when the attempt was reopened for cron retry.
 */
export async function tryReopenPreparedAbsence(
  input: PaymentProviderReconciliationWorkerInput,
  attempt: ClaimedPaymentAttempt,
  now: string,
): Promise<boolean> {
  // Reopen schedules another subscription-cycle charge. One-time prepared
  // attempts remain operator-manual so this path can never create a blind
  // second provider call for them.
  if (attempt.orderMode !== "subscription_cycle" || !attempt.subscriptionCycleId) return false;
  const subscriptionCycleId = attempt.subscriptionCycleId;

  const provider: PaymentProviderReconciliationProvider | undefined = input.providers[attempt.provider];
  // No probe capability (e.g. Tpay: no intent-correlated lookup) → this
  // provider's stranded attempts stay operator-manual; stay silent.
  if (!provider?.findPaymentByLocalIntent) return false;

  const ageMs = Date.parse(now) - Date.parse(attempt.localUpdatedAt);
  if (!Number.isFinite(ageMs) || ageMs < MIN_PREPARED_ABSENCE_REOPEN_AGE_SECONDS * 1000) {
    // Under the RPC's stranded-age guard — the next configured reconciliation pass catches it.
    return false;
  }

  let probe: "found" | "absent";
  try {
    probe = await provider.findPaymentByLocalIntent({ attempt });
  } catch (error) {
    await recordProbeEvidence(input, attempt, now, "absence_probe_failed", {
      probeError: safeMessage(error),
      operatorReviewRequired: true,
    });
    return false;
  }

  if (probe === "found") {
    // Crash-after-charge window: the provider HAS a payment for this intent
    // but our attempt never recorded it. Reopening would double-charge —
    // leave it for operator ref-repair; the stale-attempt readback path takes
    // over once refs are restored.
    await recordProbeEvidence(input, attempt, now, "provider_payment_found_after_prepare", {
      providerAbsenceConfirmed: false,
      operatorReviewRequired: true,
      reopenBlocked: "provider_payment_exists",
    });
    return false;
  }

  try {
    await input.port.reopenPreparedAttemptAfterAbsence({
      idempotencyKey: absenceReopenKey(attempt),
      paymentAttemptId: attempt.paymentAttemptId,
      expectedPaymentIntentId: attempt.paymentIntentId,
      expectedSubscriptionCycleId: subscriptionCycleId,
      operatorRef: "payment-provider-reconciliation@auto",
      absenceCheckedAt: now,
      nextRetryAt: now,
      absenceEvidence: {
        providerAbsenceConfirmed: true,
        source: "payment-provider-reconciliation.auto-reopen.v0",
        basis: `${attempt.provider}_intent_correlated_search_absent`,
        probedAt: now,
      },
    });
    // The RPC records its own 'prepared_attempt_provider_absent' corrected
    // evidence, cancels the attempt, and requeues the cycle — nothing more to
    // write here.
    return true;
  } catch (error) {
    const message = safeMessage(error);
    // The RPC's 22023 precondition rejects (too_fresh, provider_event_exists,
    // terminal reconciliation, state drift since claim, ...) are expected
    // races, not run failures — the attempt stays operator-visible either way.
    await recordProbeEvidence(
      input,
      attempt,
      now,
      message.includes("prepared_attempt_absence_reopen_")
        ? "absence_reopen_precondition_reject"
        : "absence_reopen_failed",
      { reopenError: message, operatorReviewRequired: true },
    );
    return false;
  }
}

function recordProbeEvidence(
  input: PaymentProviderReconciliationWorkerInput,
  attempt: ClaimedPaymentAttempt,
  now: string,
  providerStatus: string,
  extra: Record<string, unknown>,
): Promise<{ replayed: boolean }> {
  return input.port.recordEvidence({
    idempotencyKey: absenceProbeEvidenceKey(attempt, now),
    provider: attempt.provider,
    providerPaymentId: null,
    paymentIntentId: attempt.paymentIntentId,
    paymentAttemptId: attempt.paymentAttemptId,
    localStatus: attempt.attemptStatus,
    providerStatus,
    correctionStatus: "observed",
    checkedAt: now,
    payload: {
      source: "payment-provider-reconciliation.auto-reopen.v0",
      provider: attempt.provider,
      ...extra,
    },
  });
}
