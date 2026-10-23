import type { RenewalRetryObligation } from "./contracts/dunning.js";
import type { RenewalReadback } from "./contracts/renewal.js";
import { subscriptionRecord, type SubscriptionQueryExecutor } from "./postgresRenewalStore.js";

/** N1 accepts only verified M07 evidence; the host supplies logical-cycle correlation explicitly. */
export interface NativeRetryFailure {
  attemptSequence: number; logicalCycleNumber: number; occurredAt: string;
  failureClass: string; reason: string; externalRef: string | null;
  evidenceKey: string; firstRecordedAt: string;
}
export interface NativeRetryRequest {
  paymentIntentId: string; orderRef: string; amountMinor: number; currency: string;
  idempotencyKey: string; providerIdempotencyKey: string; providerRequestFingerprint: string; paymentMethodRef: string;
}
export interface NativeRetryPositive {
  prepareKey?: string; evidenceKey: string; occurredAt: string; firstRecordedAt: string;
  externalRef: string; amountMinor: number; currency: string; template: string;
}
export interface NativeRetryPreparation {
  execute: boolean; replayed: boolean; obligationId: string; attemptSequence: number;
  cycleId: string; orderId: string; settlementIntentId: string; identityKey: string;
  operationFingerprint: string; snapshot: Record<string, unknown>; request: NativeRetryRequest;
}
export interface NativeRetryRow extends RenewalRetryObligation {
  caseId: string | null; state: "waiting" | "prepared" | "recovered";
}
/** No payment execution is implemented here. A replayed prepare always returns execute=false. */
export function createPostgresRetryStore(executor: SubscriptionQueryExecutor) {
  async function invoke(name: string, values: unknown[]) {
    const result = await executor.query(`SELECT public.${name}(${values.map((_, i) => `$${i + 1}`).join(",")}) AS response`, values);
    return result.rows[0]?.response;
  }
  function row(value: unknown): NativeRetryRow {
    const r = subscriptionRecord(value), snapshot = subscriptionRecord(r.cycle_snapshot);
    if (!["waiting", "prepared", "recovered"].includes(String(r.state))) throw new Error("subscription_retry_state_invalid");
    return { operationId: String(r.renewal_operation_id), subscriptionId: String(r.subscription_id),
      cycleId: String(r.cycle_id), orderId: String(r.order_id), settlementIntentId: String(r.settlement_intent_id),
      logicalCycleNumber: Number(r.logical_cycle_number), nativeRenewalCounter: Number(snapshot.cycleNumber),
      retryAttempt: Number(r.retry_attempt), externalAttemptSequence: Number(r.attempt_sequence),
      nextRetryAt: r.next_retry_at == null ? null : String(r.next_retry_at),
      failureClass: r.failure_class == null ? null : String(r.failure_class),
      failureReason: r.failure_reason == null ? null : String(r.failure_reason), occurredAt: String(r.failed_at),
      identityKey: String(r.identity_key), requestFingerprint: String(r.operation_fingerprint),
      disposition: r.state === "recovered" ? "paid" : r.state === "prepared" || r.next_retry_at != null ? "retry_scheduled" : "payment_failed",
      caseId: r.case_id == null ? null : String(r.case_id), state: r.state as NativeRetryRow["state"] };
  }
  return {
    async read(operationId: string): Promise<NativeRetryRow | null> {
      const value = await invoke("subscription_retry_read", [operationId]); return value == null ? null : row(value);
    },
    async candidates(limit: number, now: string): Promise<NativeRetryRow[]> {
      const value = await invoke("subscription_retry_candidates", [limit, now]);
      if (!Array.isArray(value)) throw new Error("subscription_retry_candidates_invalid");
      return value.map(row);
    },
    async applyFailure(operationId: string, key: string, input: NativeRetryFailure) {
      return row(await invoke("subscription_retry_apply_failure", [operationId, key, input]));
    },
    async openCase(operationId: string, template: string, recoveryPath: string | null) {
      return subscriptionRecord(await invoke("subscription_retry_open_case", [operationId, template, recoveryPath]));
    },
    async authorizeRecovery(operationId: string, tokenId: string, methodRef: string, methodEvidenceRef: string, now: string) {
      return subscriptionRecord(await invoke("subscription_retry_authorize_recovery", [operationId, tokenId, methodRef, methodEvidenceRef, now]));
    },
    async scheduleRecovery(operationId: string, key: string, authorizationId: string, now: string) {
      return subscriptionRecord(await invoke("subscription_retry_schedule_recovery", [operationId, key, authorizationId, now]));
    },
    async prepare(operationId: string, key: string, input: NativeRetryRequest, now: string): Promise<NativeRetryPreparation> {
      return subscriptionRecord(await invoke("subscription_retry_prepare", [operationId, key, input, now])) as unknown as NativeRetryPreparation;
    },
    async recordRecovery(operationId: string, key: string, input: NativeRetryPositive) {
      return row(await invoke("subscription_retry_record_recovery", [operationId, key, input]));
    },
    async noteRowOutcome(operationId: string, key: string, input: Record<string, unknown>) {
      return subscriptionRecord(await invoke("subscription_retry_note_row_outcome", [operationId, key, input]));
    },
  };
}

export interface NativeRetryLifecycleBinding {
  executor: SubscriptionQueryExecutor;
  withTransaction<T>(work: (executor: SubscriptionQueryExecutor) => Promise<T>): Promise<T>;
  /** M07's existing transaction-bound native port; never a provider execution port. */
  settlement(executor: SubscriptionQueryExecutor): import("./contracts/renewal.js").RenewalSettlementPort;
  correlate(snapshot: Record<string, unknown>, nativeRenewalCounter: number): import("./contracts/renewal.js").RenewalCycleCorrelation;
  failureTemplate: string;
  recoveryPath: string | null;
}
/** Initial handoff opens only the existing donor-keyed case. Terminal outcome and
 * N1 bookkeeping then commit together, so a crash cannot strand that schedule.
 * Subsequent retry attempts use applyFailure/openCase separately, as before. */
export function createPostgresRetryLifecycleBinding(options: NativeRetryLifecycleBinding): {
  failureHandoff: import("./contracts/dunning.js").RenewalFailureHandoffPort;
  settlement: import("./contracts/renewal.js").RenewalSettlementPort;
} {
  const base = options.settlement(options.executor);
  return {
    failureHandoff: {
      async handoffFailure(input) {
        const result = await options.executor.query(`SELECT public.dunning_lifecycle_open_case(
          $1::text,$2::uuid,$3::uuid,$4::uuid,$5::integer,$6::timestamptz,$7::text,$8::text,
          $9::timestamptz,$10::bigint,$11::text,$12::text,$13::text) AS response`,
        [input.idempotencyKey, input.subscriptionId, input.cycleId, input.clientId, input.retryAttempt,
          input.nextRetryAt, input.failureClass, input.failureReason, input.occurredAt, input.amountMinor,
          input.currency, options.failureTemplate, options.recoveryPath]);
        const row = subscriptionRecord(result.rows[0]?.response);
        return { caseId: String(row.caseId), replayed: row.replayed === true };
      },
    },
    settlement: {
      prepareRenewal(input) { return base.prepareRenewal(input); },
      acknowledgeExternalAttempt(input) { return base.acknowledgeExternalAttempt(input); },
      async recordTerminalOutcome(input) {
        if (input.outcome !== "refused") return base.recordTerminalOutcome(input);
        return options.withTransaction(async executor => {
          // Own subscription -> operation, the order used by the retry lifecycle.
          await executor.query(`SELECT id FROM public.subscriptions WHERE id=(SELECT subscription_id
            FROM public.subscription_renewal_operations WHERE id=$1::uuid) FOR UPDATE`, [input.operationId]);
          const result = await executor.query(`SELECT op.cycle_snapshot,op.cycle_number,c.id AS case_id,
            c.failure_class,c.failure_reason,c.next_retry_at::text AS next_retry_at,c.opened_at::text AS occurred_at,
            receipt.input AS initial_failure,
            public.subscription_renewal_operation_response(op,false,true,'terminal_replay') AS terminal_response,
            terminal.id IS NOT NULL AND (terminal.reason IS DISTINCT FROM NULLIF(btrim($3::text),'')
              OR terminal.occurred_at IS DISTINCT FROM $4::timestamptz
              OR terminal.external_ref IS DISTINCT FROM $5::text
              OR terminal.operation_fingerprint IS DISTINCT FROM $6::text
              OR op.operation_fingerprint IS DISTINCT FROM $6::text
              OR ($5::text IS NOT NULL AND op.external_attempt_ref IS DISTINCT FROM $5::text)
              OR terminal.outcome <> 'refused') AS conflicting_terminal
            FROM public.subscription_renewal_operations op
            JOIN public.subscription_cycles cycle ON cycle.renewal_operation_id=op.id
            JOIN public.subscription_dunning_cases c ON c.cycle_id=cycle.id
              AND c.idempotency_key=op.identity_key||':failure-handoff'
            LEFT JOIN public.subscription_retry_obligations obligation ON obligation.renewal_operation_id=op.id
            LEFT JOIN public.subscription_retry_receipts receipt ON receipt.obligation_id=obligation.id
              AND receipt.receipt_key=$2::text AND receipt.kind='failure' AND receipt.attempt_sequence=0
            LEFT JOIN public.subscription_renewal_outcomes terminal ON terminal.renewal_operation_id=op.id
              AND terminal.event_key=$2::text
            WHERE op.id=$1::uuid`, [input.operationId, input.eventKey, input.reason ?? null, input.occurredAt,
              input.externalRef ?? null, input.operationFingerprint]);
          const handoff = result.rows[0];
          // Provider-input preflight refusals never opened a customer case.
          if (!handoff) return options.settlement(executor).recordTerminalOutcome(input);
          if (handoff.conflicting_terminal) throw new Error("subscription_retry_replay_conflict");
          // The immutable receipt ends replay before any settlement, rebinding
          // or case propagation. The projection may describe a later attempt.
          if (handoff.initial_failure != null) {
            return subscriptionRecord(handoff.terminal_response) as unknown as RenewalReadback;
          }
          const correlation = options.correlate(subscriptionRecord(handoff.cycle_snapshot), Number(handoff.cycle_number));
          if (correlation.status !== "correlated") throw new Error("subscription_renewal_cycle_correlation_required");
          const recorded = await options.settlement(executor).recordTerminalOutcome(input);
          const retry = createPostgresRetryStore(executor);
          await retry.applyFailure(input.operationId, input.eventKey, {
            attemptSequence: 0, logicalCycleNumber: correlation.logicalCycleNumber,
            occurredAt: String(handoff.occurred_at),
            failureClass: String(handoff.failure_class),
            reason: String(handoff.failure_reason), externalRef: input.externalRef ?? null,
            evidenceKey: input.eventKey, firstRecordedAt: String(handoff.occurred_at),
          });
          // The original handoff owns cadence, including a deliberate null.
          const linked = await executor.query(`UPDATE public.subscription_retry_obligations SET case_id=$2::uuid,
            next_retry_at=CASE WHEN attempt_sequence=0 AND retry_attempt=1 AND state='waiting'
              THEN $3::timestamptz ELSE next_retry_at END
            WHERE renewal_operation_id=$1::uuid AND (case_id IS NULL OR case_id=$2::uuid) RETURNING case_id`,
          [input.operationId, handoff.case_id, handoff.next_retry_at]);
          if (linked.rows.length !== 1) throw new Error("subscription_retry_initial_case_conflict");
          await retry.openCase(input.operationId, options.failureTemplate, options.recoveryPath);
          return recorded;
        });
      },
    },
  };
}
