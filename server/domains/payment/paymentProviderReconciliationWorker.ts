import { tryReopenPreparedAbsence } from "./paymentProviderReconciliationAbsenceReopen.js";
import {
  applyResultKey,
  bucket,
  clamp,
  classificationOf,
  evidencePayload,
  observedEvidenceKey,
  preparedAttemptEvidenceKey,
  safeMessage,
  terminalAmountMismatch,
} from "./paymentProviderReconciliationEvidence.js";
import { silenceIsOverdue } from "./paymentAttemptSilenceWindow.js";
import type {
  ClaimedPaymentAttempt,
  PaymentProviderReconciliationPort,
  PaymentProviderReconciliationWorkerInput,
  PaymentProviderReconciliationWorkerResult,
  ProviderReconciliationStatus,
  SilenceWindowLookup,
} from "./paymentProviderReconciliationContracts.js";

export type {
  ClaimedPaymentAttempt,
  PaymentProviderReconciliationPort,
  PaymentProviderReconciliationProvider,
  PaymentProviderReconciliationWorkerInput,
  PaymentProviderReconciliationWorkerResult,
  ProviderReconciliationStatus,
  ProviderReconciliationStatusKind,
  ReconciliationProviderKind,
  SilenceWindowLookup,
} from "./paymentProviderReconciliationContracts.js";

const MAX_ATTEMPTS_PER_RUN = 4;
const DEFAULT_BATCH_SIZE = MAX_ATTEMPTS_PER_RUN;
/**
 * How stale an attempt must be before this worker may claim it. Exported because
 * it is the ceiling on how long a checkout continuation can still be true: past
 * this point the cron owns the attempt. See
 * `server/domains/commerce/checkoutPaymentContinuationCredential.ts`.
 */
export const DEFAULT_STALE_AFTER_SECONDS = 15 * 60;

export async function runPaymentProviderReconciliationWorker(
  input: PaymentProviderReconciliationWorkerInput,
): Promise<PaymentProviderReconciliationWorkerResult> {
  const now = input.now ?? new Date().toISOString();
  const staleAfterSeconds = clamp(input.staleAfterSeconds ?? DEFAULT_STALE_AFTER_SECONDS, 60, 86_400);
  // Provider reads and optional prepared-absence probes are sequential and may
  // each consume the 10s PSP timeout. Keep the whole run below Vercel's 60s
  // ceiling even when a caller supplies an oversized batch.
  const batchSize = clamp(input.batchSize ?? DEFAULT_BATCH_SIZE, 1, MAX_ATTEMPTS_PER_RUN);
  const claimKey = input.claimKey ?? `payment-provider-reconciliation:${bucket(now)}`;
  const result: PaymentProviderReconciliationWorkerResult = {
    ok: true,
    checked: 0,
    corrected: 0,
    succeeded: 0,
    failed: 0,
    pending: 0,
    unknown: 0,
    ignored: 0,
    dunningOpened: 0,
    replayed: 0,
    providerCalls: 0,
    preparedWithoutProviderAck: 0,
    preparedAttemptsReopened: 0,
    manualReview: 0,
    silenceOverdue: 0,
    amountCurrencyMismatches: 0,
    failures: 0,
    skipped: false,
  };

  // Prepared attempts can remain operator-manual indefinitely. Bound their
  // share so they can never consume a whole worker batch and starve provider
  // readback for finalized attempts. A batch of one intentionally prioritizes
  // provider readback; normal scheduled runs use the larger default batch.
  const preparedLimit = Math.floor(batchSize / 2);
  const preparedAttempts = preparedLimit > 0
    ? await input.port.claimPreparedAttempts({
      now,
      staleAfterSeconds,
      limit: preparedLimit,
      claimKey: `${claimKey}:prepared`,
    })
    : [];
  for (const attempt of preparedAttempts) {
    const providerStatus: ProviderReconciliationStatus = {
      status: "unknown",
      providerStatus: "prepared_without_provider_ack",
      occurredAt: null,
      failureReason: "prepared_without_provider_ack",
      amountMinor: null,
      currency: null,
      rawPayload: {
        source: "payment-provider-reconciliation.prepared-watchdog.v0",
        provider: attempt.provider,
        providerCallPlanned: true,
        providerAcknowledged: false,
      },
    };
    const evidence = await input.port.recordEvidence({
      idempotencyKey: preparedAttemptEvidenceKey(attempt, now),
      provider: attempt.provider,
      providerPaymentId: null,
      paymentIntentId: attempt.paymentIntentId,
      paymentAttemptId: attempt.paymentAttemptId,
      localStatus: attempt.attemptStatus,
      providerStatus: providerStatus.providerStatus,
      correctionStatus: "failed",
      checkedAt: now,
      payload: evidencePayload(attempt, providerStatus, {
        applied: false,
        operatorReviewRequired: true,
      }),
    });
    if (evidence.replayed) result.replayed += 1;
    result.preparedWithoutProviderAck += 1;
    result.failures += 1;
    result.ok = false;
    result.reason = result.reason ?? "prepared_without_provider_ack";

    // Auto-reopen after a GENUINE provider-side absence proof. A purely local
    // "no ack recorded" signal cannot rule out the crash window between
    // executionPort.execute() (provider charged) and finalizeProviderAttempt
    // (refs persisted) — reopening in that window would mint a fresh PSP
    // idempotency key and double-charge. Providers without an absence probe
    // (Tpay) stay operator-manual via the reopen RPC.
    if (input.autoReopenPreparedAbsence) {
      const reopened = await tryReopenPreparedAbsence(input, attempt, now);
      if (reopened) result.preparedAttemptsReopened += 1;
    }
  }

  const remainingLimit = batchSize - preparedAttempts.length;
  const attempts = remainingLimit > 0
    ? await input.port.claimStaleAttempts({
      now,
      staleAfterSeconds,
      limit: remainingLimit,
      claimKey,
    })
    : [];
  result.checked = preparedAttempts.length + attempts.length;

  for (const attempt of attempts) {
    const provider = input.providers[attempt.provider];
    if (!provider) {
      await recordNonTerminalEvidence(input.port, attempt, now, {
        status: "unknown",
        providerStatus: "provider_not_configured",
        occurredAt: null,
        failureReason: "provider_not_configured",
        amountMinor: null,
        currency: null,
        rawPayload: { provider: attempt.provider, source: "payment-provider-reconciliation.v0" },
      }, "failed");
      result.unknown += 1;
      result.failures += 1;
      result.ok = false;
      result.reason = result.reason ?? `${attempt.provider}_provider_not_configured`;
      continue;
    }

    let providerStatus: ProviderReconciliationStatus;
    try {
      if (!attempt.providerPaymentId) {
        throw new Error("provider_payment_id_missing");
      }
      result.providerCalls += 1;
      providerStatus = await provider.readPayment({
        providerPaymentId: attempt.providerPaymentId,
        attempt,
      });
    } catch (error) {
      providerStatus = {
        status: "unknown",
        providerStatus: "provider_read_failed",
        occurredAt: null,
        failureReason: safeMessage(error),
        amountMinor: null,
        currency: null,
        rawPayload: {
          provider: attempt.provider,
          providerPaymentId: attempt.providerPaymentId,
          readError: safeMessage(error),
        },
      };
      await recordNonTerminalEvidence(input.port, attempt, now, providerStatus, "failed");
      result.unknown += 1;
      result.failures += 1;
      result.ok = false;
      result.reason = result.reason ?? safeMessage(error);
      continue;
    }

    if (providerStatus.status === "pending" || providerStatus.status === "unknown") {
      // Polling cannot separate "still running" from "stuck" - both answer
      // non-terminally forever - so ask the rail how long its own silence stays
      // normal and surface the attempt past that. NOT a terminal decision:
      // elapsed time says nothing about whether money moved.
      const overdue = silenceIsOverdue(input.capabilities, attempt, now);
      await recordNonTerminalEvidence(input.port, attempt, now, providerStatus, "observed", overdue);
      if (providerStatus.status === "pending") result.pending += 1;
      else result.unknown += 1;
      if (overdue) {
        result.silenceOverdue += 1;
        result.manualReview += 1;
      }
      continue;
    }

    const mismatch = terminalAmountMismatch(attempt, providerStatus);
    if (mismatch) {
      await recordNonTerminalEvidence(input.port, attempt, now, {
        ...providerStatus,
        failureReason: mismatch,
        rawPayload: { ...providerStatus.rawPayload, reconciliationMismatch: mismatch },
      }, "failed");
      result.manualReview += 1;
      result.amountCurrencyMismatches += 1;
      continue;
    }

    const occurredAt = providerStatus.occurredAt ?? now;
    const resultStatus = providerStatus.status;
    try {
      const applied = await input.port.applyTerminalResult({
        idempotencyKey: applyResultKey(attempt, resultStatus),
        expectedOrderId: attempt.orderId,
        expectedPaymentIntentId: attempt.paymentIntentId,
        expectedPaymentAttemptId: attempt.paymentAttemptId,
        expectedPaymentId: attempt.paymentId,
        provider: attempt.provider,
        providerPaymentId: attempt.providerPaymentId,
        localStatus: attempt.attemptStatus,
        providerStatus: providerStatus.providerStatus,
        resultStatus,
        occurredAt,
        failureReason: resultStatus === "failed"
          ? providerStatus.failureReason ?? `provider_reconciliation_${providerStatus.providerStatus}`
          : null,
        ...classificationOf(resultStatus, providerStatus),
        checkedAt: now,
        payload: evidencePayload(attempt, providerStatus, { applied: true, resultStatus }),
      });
      if (applied.replayed) result.replayed += 1;

      if (applied.correctionStatus === "ignored") {
        result.ignored += 1;
        continue;
      }

      result.corrected += applied.replayed ? 0 : 1;
      if (resultStatus === "succeeded") result.succeeded += 1;
      else result.failed += 1;
      if (applied.subscriptionWebhookDunning?.opened && !applied.subscriptionWebhookDunning.replayed) {
        result.dunningOpened += 1;
      }
    } catch (error) {
      await recordNonTerminalEvidence(input.port, attempt, now, {
        ...providerStatus,
        failureReason: safeMessage(error),
        rawPayload: { ...providerStatus.rawPayload, applyResultError: safeMessage(error) },
      }, "failed");
      result.failures += 1;
      result.ok = false;
      result.reason = result.reason ?? safeMessage(error);
    }
  }

  return result;
}

function recordNonTerminalEvidence(
  port: PaymentProviderReconciliationPort,
  attempt: ClaimedPaymentAttempt,
  checkedAt: string,
  providerStatus: ProviderReconciliationStatus,
  correctionStatus: "observed" | "failed",
  silenceOverdue = false,
): Promise<{ replayed: boolean }> {
  return port.recordEvidence({
    idempotencyKey: observedEvidenceKey(attempt, providerStatus.status, correctionStatus, checkedAt),
    provider: attempt.provider,
    providerPaymentId: attempt.providerPaymentId,
    paymentIntentId: attempt.paymentIntentId,
    paymentAttemptId: attempt.paymentAttemptId,
    localStatus: attempt.attemptStatus,
    providerStatus: providerStatus.providerStatus,
    correctionStatus,
    checkedAt,
    payload: evidencePayload(attempt, providerStatus, { applied: false, silenceOverdue }),
  });
}
