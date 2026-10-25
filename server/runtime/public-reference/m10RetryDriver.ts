import { createPostgresRetryStore } from "@openlup/platform/subscriptions";
import type { NativeRetryFailure, NativeRetryPreparation, NativeRetryRow, NativeRetryRequest, SubscriptionQueryExecutor } from "@openlup/platform/subscriptions";
import type { RenewalExecutionRequest, RenewalFrozenSnapshot, RenewalPaymentEvidence, RenewalPaymentRail } from "@openlup/platform/subscriptions/contracts";

export interface M10RetryDriverOptions {
  executor: SubscriptionQueryExecutor;
  withTransaction<T>(work: (db: SubscriptionQueryExecutor) => Promise<T>): Promise<T>;
  decode(snapshot: Record<string, unknown>): RenewalFrozenSnapshot;
  /** Trusted host correlation and frozen mandate, not mutable future terms. */
  readFrozenMandate(snapshot: RenewalFrozenSnapshot): Promise<{ authorized: boolean; authorizationRef: string; paymentMethodRef: string }>;
  retryInput(snapshot: RenewalFrozenSnapshot, row: NativeRetryRow): RenewalExecutionRequest;
  validateInput(input: RenewalExecutionRequest): void;
  payments: {
    execute: RenewalPaymentRail["execute"];
    /** Exact prepared attempt lookup; a settlement's original handle is insufficient. */
    readOutcome(preparation: NativeRetryPreparation, snapshot: RenewalFrozenSnapshot): Promise<RenewalPaymentEvidence>;
  };
  failureTemplate: string; recoveredTemplate: string; recoveryPath: string | null;
  classifyFailure(reason: string): string;
}

export function createM10RetryDriver(options: M10RetryDriverOptions) {
  const store = createPostgresRetryStore(options.executor);
  async function propagateFailure(operationId: string, key: string, input: NativeRetryFailure) {
    return options.withTransaction(async db => {
      // Serialize with SQL's subscription -> operation order. The receipt/case
      // observation and optional propagation are one transaction.
      await db.query(`SELECT id FROM public.subscriptions WHERE id=(SELECT subscription_id
        FROM public.subscription_renewal_operations WHERE id=$1::uuid) FOR UPDATE`, [operationId]);
      const retry = createPostgresRetryStore(db);
      const prior = await retry.failureProgress(operationId, key);
      const obligation = await retry.applyFailure(operationId, key, input); // validates replay identity
      const progress = await retry.failureProgress(operationId, key);
      if (!progress.caseAdvanced) await retry.openCase(operationId, options.failureTemplate, options.recoveryPath);
      return { obligation, replayed: prior.replayed, caseAdvanced: progress.caseAdvanced };
    });
  }
  async function run(now: string, limit: number) {
    // Filter settled rows BEFORE limiting; they cannot starve unpaid obligations.
    // Prepared attempts and interrupted failure propagation are reconciliation work.
    const rows = (await options.executor.query(`SELECT o.*,op.cycle_snapshot,
      latest.receipt_key AS failure_key,latest.input AS failure_input,
      prep.receipt_key AS prepare_key,prep.result AS preparation
      FROM public.subscription_retry_obligations o
      JOIN public.subscriptions s ON s.id=o.subscription_id AND s.status='active'
      JOIN public.subscription_renewal_operations op ON op.id=o.renewal_operation_id
      JOIN public.subscription_cycles cycle ON cycle.id=o.cycle_id AND cycle.status='payment_pending'
      JOIN public.commerce_settlement_intents intent ON intent.id=o.settlement_intent_id AND intent.status<>'settled'
      LEFT JOIN public.subscription_dunning_cases c ON c.id=o.case_id
      LEFT JOIN LATERAL (SELECT receipt_key,input,result FROM public.subscription_retry_receipts r
        WHERE r.obligation_id=o.id AND r.kind='failure' ORDER BY r.attempt_sequence DESC LIMIT 1) latest ON true
      LEFT JOIN public.subscription_retry_receipts prep ON prep.obligation_id=o.id
        AND prep.kind='prepare' AND prep.attempt_sequence=o.attempt_sequence
      WHERE o.state<>'recovered' AND (o.state='prepared' OR o.next_retry_at<=$1::timestamptz
        OR c.id IS NULL OR c.retry_attempt<(latest.result->>'retry_attempt')::integer)
      ORDER BY o.next_retry_at NULLS FIRST,o.id LIMIT $2::integer`, [now, limit])).rows;
    const results: { operationId: string; status: string }[] = [];
    for (const raw of rows) {
      const operationId = String(raw.renewal_operation_id);
      try {
        if (raw.failure_key && raw.failure_input) await propagateFailure(operationId, String(raw.failure_key), raw.failure_input as NativeRetryFailure);
        const row = await store.read(operationId);
        if (!row || row.state === "recovered") continue;
        const snapshot = options.decode(raw.cycle_snapshot as Record<string, unknown>);
        if (snapshot.cycle.status !== "correlated" || snapshot.cycle.logicalCycleNumber !== row.logicalCycleNumber
          || snapshot.cycle.nativeRenewalCounter !== row.nativeRenewalCounter) throw new Error("subscription_renewal_cycle_correlation_required");
        let prepared: NativeRetryPreparation;
        let prepareKey: string;
        if (row.state === "prepared") {
          if (!raw.preparation || !raw.prepare_key) throw new Error("subscription_retry_prepared_receipt_missing");
          prepared = { ...raw.preparation as NativeRetryPreparation, execute: false, replayed: true };
          prepareKey = String(raw.prepare_key);
        } else {
          if (!row.nextRetryAt || Date.parse(row.nextRetryAt) > Date.parse(now)) continue;
          const mandate = await options.readFrozenMandate(snapshot);
          const input = options.retryInput(snapshot, row);
          const authorizations = (await options.executor.query(`SELECT a.method_ref FROM public.subscription_retry_recovery_authorizations a
            JOIN public.subscription_retry_obligations o ON o.id=a.obligation_id
            WHERE o.renewal_operation_id=$1::uuid AND a.retry_attempt=o.retry_attempt AND a.consumed_at IS NULL`, [operationId])).rows;
          const method = authorizations[0]?.method_ref ?? mandate.paymentMethodRef;
          if (!mandate.authorized || mandate.authorizationRef !== snapshot.authorizationRef || input.paymentMethodRef !== method
            || input.paymentIntentId !== row.settlementIntentId || input.orderRef !== row.orderId
            || input.amountMinor !== snapshot.pricingSnapshot.totalAmountMinor || input.currency !== snapshot.pricingSnapshot.currency) {
            throw new Error("subscription_retry_frozen_mandate_mismatch");
          }
          options.validateInput(input);
          const request: NativeRetryRequest = { paymentIntentId: input.paymentIntentId, orderRef: input.orderRef,
            amountMinor: input.amountMinor, currency: input.currency, idempotencyKey: input.executionIdempotencyKey,
            providerIdempotencyKey: input.externalIdempotencyKey, providerRequestFingerprint: input.requestFingerprint,
            paymentMethodRef: input.paymentMethodRef };
          prepareKey = input.executionIdempotencyKey;
          prepared = await store.prepare(operationId, prepareKey, request, now);
          // A committed prepare is an irreversible execution fence. A replay or
          // uncertain dispatch only reads the exact attempt through the host port.
          if (prepared.execute) await options.payments.execute(input);
        }
        const evidence = await options.payments.readOutcome(prepared, snapshot);
        if (evidence.operationId !== operationId || evidence.requestFingerprint !== row.requestFingerprint
          || !evidence.verifiedEvidenceRef || !evidence.eventKey || !evidence.occurredAt || !evidence.externalAttemptRef
          || !evidence.firstRecordedAt || !evidence.observedAt || evidence.disposition === "ambiguous"
          || (evidence.amountMinor !== null && evidence.amountMinor !== snapshot.pricingSnapshot.totalAmountMinor)
          || (evidence.currency !== null && evidence.currency !== snapshot.pricingSnapshot.currency)) {
          results.push({ operationId, status: "awaiting_provider" }); continue;
        }
        if (evidence.status === "succeeded" && evidence.amountMinor === snapshot.pricingSnapshot.totalAmountMinor
          && evidence.currency === snapshot.pricingSnapshot.currency) {
          await store.recordRecovery(operationId, evidence.eventKey, { prepareKey, evidenceKey: evidence.verifiedEvidenceRef,
            occurredAt: evidence.occurredAt, firstRecordedAt: evidence.firstRecordedAt, externalRef: evidence.externalAttemptRef,
            amountMinor: evidence.amountMinor, currency: evidence.currency, template: options.recoveredTemplate });
          results.push({ operationId, status: "succeeded" });
        } else if (evidence.status === "failed" && evidence.disposition === "observed") {
          await propagateFailure(operationId, evidence.eventKey, { attemptSequence: prepared.attemptSequence,
            logicalCycleNumber: row.logicalCycleNumber, occurredAt: evidence.occurredAt,
            failureClass: options.classifyFailure(evidence.reason ?? "provider_failed"), reason: evidence.reason ?? "provider_failed",
            externalRef: evidence.externalAttemptRef, evidenceKey: evidence.verifiedEvidenceRef, firstRecordedAt: evidence.firstRecordedAt });
          results.push({ operationId, status: "refused" });
        } else results.push({ operationId, status: "awaiting_provider" });
      } catch (error) {
        // Keep each captured obligation available for reconciliation; never pause.
        results.push({ operationId, status: error instanceof Error && error.message === "subscription_retry_frozen_mandate_mismatch"
          ? "frozen_mandate_mismatch" : "error" });
      }
    }
    return results;
  }
  return { run, propagateFailure };
}
