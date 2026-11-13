import type { CycleRetryCadence } from "@openlup/core/subscription";
import { nativeInstant } from "./nativeInstant.js";
import type { SubscriptionQueryExecutor } from "./postgresRenewalStore.js";
import { createPostgresRetryStore } from "./postgresRetryStore.js";
import type { NativeRetryFailure, NativeRetryPreparation, NativeRetryRow, NativeRetryRequest } from "./postgresRetryStore.js";
import type { RenewalExecutionRequest, RenewalFrozenSnapshot, RenewalPaymentEvidence, RenewalPaymentRail } from "./contracts/renewal.js";

export interface NativeRetryDriverOptions {
  /** Trusted timing only; cannot alter terminating failure classes. */
  retryCadence?: Pick<CycleRetryCadence, "backoffHours">;
  executor: SubscriptionQueryExecutor;
  withTransaction<T>(work: (db: SubscriptionQueryExecutor) => Promise<T>): Promise<T>;
  decode(snapshot: Record<string, unknown>): RenewalFrozenSnapshot;
  /** Trusted host correlation and frozen mandate, not mutable future terms. */
  readFrozenMandate(snapshot: RenewalFrozenSnapshot): Promise<{ authorized: boolean; authorizationRef: string; paymentMethodRef: string }>;
  retryInput(snapshot: RenewalFrozenSnapshot, row: NativeRetryRow): RenewalExecutionRequest;
  validateInput(input: RenewalExecutionRequest): void;
  payments: {
    execute: RenewalPaymentRail["execute"];
    /** Read the payment owner's exact prepared attempt; never settle through purchase ingress. */
    readOutcome(preparation: NativeRetryPreparation, snapshot: RenewalFrozenSnapshot): Promise<RenewalPaymentEvidence & {
      sourceEvidence?: { sourceKind: "accepted_event" | "reconciliation_read"; sourceReference: string;
        observedStatus: string; observedAt: string; payloadFingerprint: string; attemptRef: string };
    }>;
  };
  failureTemplate: string; recoveredTemplate: string; recoveryPath: string | null;
  classifyFailure(reason: string): string;
}

/** Internal value matcher; not re-exported by a package entry. */
export function canonicalUuid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.startsWith("{") && value.endsWith("}") ? value.slice(1, -1) : value;
  if (!/^[\da-f]{4}(?:-?[\da-f]{4}){7}$/i.test(raw)) return null;
  const hex = raw.replaceAll("-", "").toLowerCase();
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}

export function createNativeRetryDriver(options: NativeRetryDriverOptions) {
  const store = createPostgresRetryStore(options.executor, options.retryCadence);
  async function propagateFailure(operationId: string, key: string, input: NativeRetryFailure) {
    return options.withTransaction(async db => {
      // Serialize with SQL's subscription -> operation order. The receipt/case
      // observation and optional propagation are one transaction.
      await db.query(`SELECT id FROM public.subscriptions WHERE id=(SELECT subscription_id
        FROM public.subscription_renewal_operations WHERE id=$1::uuid) FOR UPDATE`, [operationId]);
      const retry = createPostgresRetryStore(db, options.retryCadence);
      const recorded = (await db.query(`SELECT r.receipt_key,r.input,
        public.payment_provider_retry_failure_recorded(o.settlement_intent_id,r.receipt_key,
          r.input->>'paymentAttemptId') AS attributed
        FROM public.subscription_retry_obligations o
        JOIN public.subscription_retry_receipts r ON r.obligation_id=o.id AND r.kind='failure'
        WHERE o.renewal_operation_id=$1::uuid AND r.attempt_sequence=$2::integer
          AND r.input ? 'paymentAttemptId'`, [operationId, input.attemptSequence])).rows[0] as { receipt_key: string; input: NativeRetryFailure; attributed: boolean } | undefined;
      if (recorded && (recorded.attributed !== true
        || recorded.input.logicalCycleNumber !== input.logicalCycleNumber
        || recorded.input.evidenceKey !== input.evidenceKey || recorded.input.externalRef !== input.externalRef)) {
        throw new Error("subscription_retry_provider_failure_mismatch");
      }
      // Provider application already owns this rung and financial transition.
      // Replay its immutable input/key; attributed case handoff has another owner.
      const failureKey = recorded ? String(recorded.receipt_key) : key;
      const prior = await retry.failureProgress(operationId, failureKey);
      const obligation = await retry.applyFailure(operationId, failureKey, recorded ? recorded.input : input);
      const progress = await retry.failureProgress(operationId, failureKey);
      if (!recorded && !progress.caseAdvanced) await retry.openCase(operationId, options.failureTemplate, options.recoveryPath);
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
          if (!row.nextRetryAt || nativeInstant(row.nextRetryAt) > nativeInstant(now)) continue;
          const mandate = await options.readFrozenMandate(snapshot);
          const supplied = options.retryInput(snapshot, row);
          const paymentIntentId = canonicalUuid(supplied.paymentIntentId), orderRef = canonicalUuid(supplied.orderRef);
          const input = { ...supplied, paymentIntentId: paymentIntentId ?? supplied.paymentIntentId, orderRef: orderRef ?? supplied.orderRef };
          const authorizations = (await options.executor.query(`SELECT CASE WHEN public.subscription_method_uses_recorded_refs(o.subscription_id)
            THEN public.payment_method_recovery_authority_read(o.method_recovery_authority_id)->>'method_ref'
            ELSE a.method_ref END AS method_ref FROM public.subscription_retry_obligations o
            LEFT JOIN public.subscription_retry_recovery_authorizations a ON a.obligation_id=o.id
              AND a.retry_attempt=o.retry_attempt AND a.consumed_at IS NULL
            WHERE o.renewal_operation_id=$1::uuid`, [operationId])).rows;
          const method = authorizations[0]?.method_ref ?? mandate.paymentMethodRef;
          if (!mandate.authorized || mandate.authorizationRef !== snapshot.authorizationRef || input.paymentMethodRef !== method
            || paymentIntentId !== row.settlementIntentId || orderRef !== row.orderId
            || input.amountMinor !== snapshot.pricingSnapshot.totalAmountMinor || input.currency !== snapshot.pricingSnapshot.currency) {
            throw new Error("subscription_retry_frozen_mandate_mismatch");
          }
          options.validateInput(input);
          const request: NativeRetryRequest = { paymentIntentId, orderRef,
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
          const recovered = await store.recordRecovery(operationId, evidence.eventKey, { ...evidence.sourceEvidence, ...(evidence.sourceEvidence ? { observedAt: nativeInstant(evidence.sourceEvidence.observedAt) } : {}), prepareKey, evidenceKey: evidence.verifiedEvidenceRef,
            occurredAt: nativeInstant(evidence.occurredAt), firstRecordedAt: nativeInstant(evidence.firstRecordedAt), externalRef: evidence.externalAttemptRef,
            amountMinor: evidence.amountMinor, currency: evidence.currency, template: options.recoveredTemplate });
          results.push({ operationId, status: recovered.disposition === "paid" ? "succeeded" : "error" });
        } else if (evidence.status === "failed" && evidence.disposition === "observed") {
          await propagateFailure(operationId, evidence.eventKey, { attemptSequence: prepared.attemptSequence,
            logicalCycleNumber: row.logicalCycleNumber, occurredAt: nativeInstant(evidence.occurredAt),
            failureClass: options.classifyFailure(evidence.reason ?? "provider_failed"), reason: evidence.reason ?? "provider_failed",
            externalRef: evidence.externalAttemptRef, evidenceKey: evidence.verifiedEvidenceRef, firstRecordedAt: nativeInstant(evidence.firstRecordedAt) });
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
