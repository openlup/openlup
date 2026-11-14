import { createHash } from "node:crypto";
import type { PaymentFailureClass } from "@openlup/core/payment";
import { createPostgresRetryStore } from "./postgresRetryStore.js";
import { nativeInstant } from "./nativeInstant.js";
import { subscriptionRecord, type NativeRenewalCodec, type SubscriptionQueryExecutor } from "./postgresRenewalStore.js";
import type { RenewalExecutionRequest, RenewalPaymentEvidence, RenewalPaymentRail, RenewalSettlementPort } from "./contracts/renewal.js";
import type { RenewalFailureHandoffPort } from "./contracts/dunning.js";
import type { NativeRetryDriverOptions } from "./nativeRetryDriver.js";
import { replayRenewalAttempt } from "./renewalCycleRefusalMechanism.js";

/** The subscription owner consumes only these injected payment facts. */
export interface ProviderRenewalResultInput {
  idempotencyKey: string; paymentIntentId: string; paymentEventId: string | null;
  resultStatus: "succeeded" | "failed" | "expired" | "refunded" | "partially_refunded" | "disputed";
  occurredAt: string; failureReason: string | null; failureClass?: PaymentFailureClass | null; failureClassDecidedBy?: string | null;
}
// Structural ingress boundary: delivery and complete receipt pass through unchanged.
type ProviderRenewalWebhookIngest = (input: ProviderRenewalWebhook & {
  provider: string; occurredAt: string;
  eventType: "payment.succeeded" | "payment.failed" | "payment.refunded" | "payment.requires_action" | "payment.disputed"
    | "setup.succeeded" | "setup.failed" | "setup.requires_action";
}) => Promise<{ paymentEventId: string; paymentIntentId: string | null; paymentAttemptId: string | null }>;
type ProviderRenewalWebhookControl = {
  ingestPaymentEvent?: ProviderRenewalWebhookIngest;
  applyPaymentResult?(input: ProviderRenewalResultInput): Promise<{ replayed: boolean }>;
};
type ProviderRenewalWebhook = { providerEventId: string; providerPaymentId: string; rawPayload: Record<string, unknown> };
type ProviderRenewalAttempt = { orderId: string; settlementStatus: string; amountMinor: number; currency: string;
  requestPayload: Record<string, unknown>; responsePayload: Record<string, unknown>;
  paymentAttempt: { id: string; paymentId: string; provider: string; status: string; providerAttemptId: string | null; idempotencyKey?: string } };
export interface ProviderRenewalPaymentPorts {
  provider: string; mode: "live" | "test";
  control: {
    createIntent(input: { idempotencyKey: string; targetKind: "subscription_cycle"; orderId: string; subscriptionId: string;
      subscriptionCycleId: string; amountMinor: number; currency: string; metadata: Record<string, unknown>; channelKey: string; at: string }): Promise<{ id: string }>;
    applyPaymentResult(input: ProviderRenewalResultInput): Promise<{ replayed: boolean }>;
  };
  controlFor(executor: SubscriptionQueryExecutor): ProviderRenewalPaymentPorts["control"];
  readAttempt(intentId: string, attemptId?: string | null): Promise<ProviderRenewalAttempt | null>;
  execute(input: { attemptRef: string; intentRef: string; fingerprint: string; providerIdempotencyKey: string;
    money: { amountMinor: number; currency: string }; mode: "live" | "test"; purpose: "renewal-unattended";
    orderRef: string; clientId: string; customerRef?: string; storedMethod: { reference: string; mandate: { recurringModel: string | null } } }): Promise<{
      attempt: { paymentAttemptId: string }; execution: {
        outcome: { kind: "attempt"; status: string } | { kind: "decline"; refusal: { code: PaymentFailureClass } };
        dispatch: { kind: "dispatched"; providerPaymentRef: string } | { kind: "unknown" | "notDispatched" };
        persistence?: { declineReason?: string };
      };
    }>;
  adapter: { readbackPort: { readPayment(input: { identity: { provider: string; intentRef: string; attemptRef: string; providerPaymentRef: string };
    expectedMoney: { amountMinor: number; currency: string }; purpose: "recovery" }): Promise<
      { kind: "succeeded" | "failed" | "pending"; observedMoney: { amountMinor: number; currency: string }; providerOccurredAt: string | null }
      | { kind: "unknown" | "unsupported" | "absent" }> } };
  reconciliation: {
    recordEvidence(input: { idempotencyKey: string; provider: string; providerPaymentId: string | null; paymentIntentId: string;
      paymentAttemptId: string; localStatus: string; providerStatus: string; correctionStatus: "observed"; checkedAt: string;
      payload: Record<string, unknown> }): Promise<{ reconciliationId?: string }>;
    applyTerminalResult(input: { idempotencyKey: string; expectedOrderId: string; expectedPaymentIntentId: string;
      expectedPaymentAttemptId: string; expectedPaymentId: string; provider: string; providerPaymentId: string; localStatus: string;
      providerStatus: string; resultStatus: "succeeded" | "failed"; occurredAt: string; failureReason: string | null; checkedAt: string;
      payload: Record<string, unknown> }): Promise<unknown>;
  };
}
export interface PostgresProviderRenewalBinding {
  rail: RenewalPaymentRail;
  paymentRails: { resolve(channelKey: string): RenewalPaymentRail | null };
  lifecycle: { failureHandoff: RenewalFailureHandoffPort; settlement: RenewalSettlementPort };
  retryPayments: NativeRetryDriverOptions["payments"];
  composeWebhook<C extends ProviderRenewalWebhookControl>(event: ProviderRenewalWebhook, control: C): Omit<C, "applyPaymentResult"> & { applyPaymentResult: NonNullable<ProviderRenewalWebhookControl["applyPaymentResult"]> };
}

/** Provider selection and existing native lifecycle owners, never another scheduler. */
export function createPostgresProviderRenewalBinding(input: {
  enabled?: boolean;
  channelKey: string;
  executor: SubscriptionQueryExecutor;
  withTransaction<T>(work: (db: SubscriptionQueryExecutor) => Promise<T>): Promise<T>;
  paymentRail: ProviderRenewalPaymentPorts;
  codec: NativeRenewalCodec;
  settlement(db: SubscriptionQueryExecutor): RenewalSettlementPort;
  truth: { dunningTemplateSlug: string; recoveryUrlPath: string; recoveryTemplateSlug: string };
  /** Exact local-intent lookup; zero matches never proves provider absence. */
  search(input: { localIntentId: string; limit: 2 }): Promise<readonly string[]>;
  now(): string;
}): PostgresProviderRenewalBinding {
  const { executor: db, paymentRail: payments } = input;
  if (!input.channelKey.trim() || input.channelKey === "sandbox") throw new Error("subscription_provider_channel_required");
  const base = input.settlement(db);
  async function operation(intent: string) {
    const row = (await db.query(`SELECT op.*,i.order_id,i.amount_minor,i.currency_code,i.status AS settlement_status,
      o.subscription_cycle_id,s.client_id FROM public.commerce_settlement_intents i
      JOIN public.subscription_renewal_operations op ON op.id=i.renewal_operation_id
      JOIN public.commerce_orders o ON o.id=i.order_id JOIN public.subscriptions s ON s.id=op.subscription_id
      WHERE i.id=$1::uuid`, [intent])).rows[0];
    if (!row) throw new Error("subscription_renewal_prepared_artifacts_missing");
    const frozen = input.codec.decode(subscriptionRecord(row.cycle_snapshot));
    const cycle = frozen.cycle;
    if (cycle.status !== "correlated") throw new Error("subscription_renewal_cycle_correlation_required");
    if (frozen.settlementChannelKey !== input.channelKey) throw new Error("settlement_channel_not_configured");
    return { row, frozen, cycle };
  }
  async function handoff(intent: string, attempt: string) {
    const failure = (await db.query(`SELECT r.input FROM public.subscription_retry_receipts r
      JOIN public.subscription_retry_obligations o ON o.id=r.obligation_id
      WHERE o.settlement_intent_id=$1::uuid AND r.kind='failure' AND r.input->>'paymentAttemptId'=$2
      ORDER BY r.id LIMIT 1`, [intent, attempt])).rows[0];
    if (!failure) throw new Error("subscription_dunning_failed_attempt_unattributed");
    const facts = subscriptionRecord(failure.input);
    const result = subscriptionRecord((await db.query(`SELECT public.payment_reconciliation_open_dunning_from_failed_result(
      $1,$2::uuid,NULL,$3,$4::timestamptz,$5,$6::uuid,$7,$8) AS response`,
    [`provider-attempt:${attempt}:dunning`, intent, facts.reason, facts.occurredAt, facts.failureClass, attempt,
      input.truth.dunningTemplateSlug, input.truth.recoveryUrlPath])).rows[0]?.response);
    const body = subscriptionRecord(result.subscriptionWebhookDunning);
    return { caseId: body.caseId == null ? null : String(body.caseId), replayed: body.replayed === true };
  }
  const rail: RenewalPaymentRail = {
    async execute(request: RenewalExecutionRequest) {
      if (input.enabled !== true) throw new Error("settlement_channel_not_configured");
      const { row, frozen } = await operation(request.paymentIntentId);
      if (request.orderId !== row.order_id || request.orderRef !== row.order_id || request.clientId !== row.client_id
        || request.cycleIdempotencyKey !== row.identity_key || request.requestFingerprint !== row.operation_fingerprint
        || request.amountMinor !== Number(row.amount_minor) || request.currency !== row.currency_code
        || request.mode !== "subscription" || request.flow !== "off_session") throw new Error("subscription_renewal_provider_request_mismatch");
      const authority = (await db.query(`SELECT public.subscription_method_has_recorded_ref($1::uuid) AS recorded,
        public.subscription_method_chargeable_unattended($1::uuid,now()) AS chargeable,
        public.subscription_method_health_read($1::uuid) AS current,
        public.payment_method_ref_read($2,$3) AS addressed`, [row.subscription_id, payments.provider, request.paymentMethodRef])).rows[0];
      // Original renewals with no recorded ref retain their existing authority.
      // Once any ref exists, validate the addressed ref, not merely a healthy replacement.
      if (authority?.recorded === true) {
        const method = authority.addressed == null ? null : subscriptionRecord(authority.addressed);
        const current = authority.current == null ? null : subscriptionRecord(authority.current);
        if (!method) throw new Error("missing_provider_method_ref");
        if (method.client_id !== row.client_id) throw new Error("payment_method_cross_client");
        if (method.status === "inactive" || method.status === "revoked") throw new Error("payment_method_revoked");
        if (method.status === "pending_verification") throw new Error("payment_method_requires_action");
        if (method.active !== true) throw new Error("missing_provider_method_ref");
        if (method.status !== "active" || method.subscription_id !== row.subscription_id || authority.chargeable !== true
          || current?.payment_method_ref_id !== method.id || current?.provider_kind !== payments.provider
          || method.provider_customer_ref !== (request.customerRef ?? null)) throw new Error("payment_method_invalid");
      }
      const admitted = await payments.control.createIntent({ idempotencyKey: `${String(row.identity_key)}:provider-intent`,
        targetKind: "subscription_cycle", orderId: request.orderId, subscriptionId: String(row.subscription_id),
        subscriptionCycleId: String(row.subscription_cycle_id), amountMinor: request.amountMinor, currency: request.currency,
        metadata: {}, channelKey: input.channelKey, at: frozen.scheduledAt });
      if (admitted.id !== request.paymentIntentId) throw new Error("subscription_renewal_provider_intent_mismatch");
      const result = await payments.execute({ attemptRef: request.executionIdempotencyKey, intentRef: request.paymentIntentId,
        fingerprint: request.requestFingerprint, providerIdempotencyKey: request.externalIdempotencyKey,
        money: { amountMinor: request.amountMinor, currency: request.currency }, mode: payments.mode, purpose: "renewal-unattended",
        orderRef: request.orderRef, clientId: request.clientId, customerRef: request.customerRef ?? undefined,
        storedMethod: { reference: request.paymentMethodRef, mandate: { recurringModel: request.recurringModel } } });
      const { execution, attempt } = result;
      const remote = execution.dispatch.kind === "dispatched" ? execution.dispatch.providerPaymentRef : null;
      // A nullable remote decline handle stays nullable. The native attempt UUID
      // supplies local correlation, never authority to execute that remote object.
      if (row.state === "attempt_prepared") await base.acknowledgeExternalAttempt({ operationId: String(row.id), operationFingerprint: String(row.operation_fingerprint),
        externalAttemptRef: remote ?? attempt.paymentAttemptId, acknowledgedAt: input.now() });
      const failure: { reason: string; failureClass: PaymentFailureClass } | null = execution.outcome.kind === "decline"
        ? { reason: execution.persistence?.declineReason ?? "provider_declined", failureClass: execution.outcome.refusal.code }
        : execution.outcome.status === "requires_action" ? { reason: "off_session_sca_required", failureClass: "sca_required" } : null;
      if (failure) {
        await payments.control.applyPaymentResult({ idempotencyKey: `${request.executionIdempotencyKey}:result`,
          paymentIntentId: request.paymentIntentId, paymentEventId: null, resultStatus: "failed", occurredAt: input.now(),
          failureReason: failure.reason, failureClass: failure.failureClass, failureClassDecidedBy: "execution" });
        await handoff(request.paymentIntentId, attempt.paymentAttemptId);
      }
      return { status: failure ? "failed" : "pending", externalAttemptRef: remote, ...(failure ? { failure } : {}) };
    },
    async findExternalAttempt({ settlementIntentId }) {
      if (input.enabled !== true) return null;
      await operation(settlementIntentId);
      const attempt = await payments.readAttempt(settlementIntentId);
      if (!attempt) return null;
      if (attempt.paymentAttempt.provider !== payments.provider) throw new Error("subscription_renewal_provider_attempt_conflict");
      if (attempt.paymentAttempt.providerAttemptId) return attempt.paymentAttempt.providerAttemptId;
      const found = await input.search({ localIntentId: settlementIntentId, limit: 2 });
      if (found.length > 1) throw new Error("subscription_renewal_provider_attempt_conflict");
      return found[0] ?? null;
    },
    async readOutcome(request) {
      const { row } = await operation(request.settlementIntentId);
      if (row.order_id !== request.orderId || row.subscription_id !== request.subscriptionId
        || Number(row.amount_minor) !== request.amountMinor || row.currency_code !== request.currency) {
        throw new Error("subscription_renewal_provider_readback_mismatch");
      }
      return observe(request.settlementIntentId, request.externalAttemptRef, false);
    },
  };
  async function observe(intent: string, remote: string | null, retry: boolean): Promise<RenewalPaymentEvidence> {
    const { row, frozen, cycle } = await operation(intent), attempt = await payments.readAttempt(intent);
    if (!attempt || attempt.paymentAttempt.provider !== payments.provider) throw new Error("payment_control_result_active_attempt_not_found");
    const a = attempt.paymentAttempt, checkedAt = nativeInstant(input.now());
    const empty: RenewalPaymentEvidence = { operationId: String(row.id), requestFingerprint: String(row.operation_fingerprint),
      status: "unknown", disposition: "ambiguous", eventKey: "", verifiedEvidenceRef: "", externalAttemptRef: remote,
      occurredAt: null, observedAt: checkedAt, firstRecordedAt: checkedAt, amountMinor: null, currency: null, reason: null };
    if (a.status === "requires_action") {
      if (remote && a.providerAttemptId && a.providerAttemptId !== remote) throw new Error("subscription_renewal_provider_attempt_conflict");
      const executionKey = a.idempotencyKey, providerKey = attempt.requestPayload.providerIdempotencyKey;
      const fingerprint = attempt.requestPayload.providerRequestFingerprint;
      if (!executionKey || typeof providerKey !== "string" || typeof fingerprint !== "string") throw new Error("payment_provider_attempt_readback_invalid");
      const method = attempt.requestPayload.storedMethod;
      const methodRef = method && typeof method === "object" ? subscriptionRecord(method).reference : null;
      await replayRenewalAttempt({ now: input.now, chargeFailurePropagation: {
        async recordBlockedPreflightAttempt() { throw new Error("subscription_renewal_provider_result_required"); },
        async readDurableAttemptInstant(request) {
          if (request.attemptIdempotencyKey !== executionKey) throw new Error("payment_provider_attempt_readback_invalid");
          const history = subscriptionRecord((await db.query("SELECT public.commerce_checkout_payment_guidance_snapshot($1::uuid,$2::uuid,NULL::uuid) AS response",
            [row.order_id, intent])).rows[0]?.response);
          const attempts = history.attempts as { id: string; createdAt: string }[];
          const at = attempts?.find(value => value.id === a.id)?.createdAt;
          return at ? nativeInstant(at) : null;
        },
        async applyFailedResult(failure) {
          const result = await payments.control.applyPaymentResult({ idempotencyKey: failure.idempotencyKey,
            paymentIntentId: intent, paymentEventId: null, resultStatus: "failed", occurredAt: failure.occurredAt,
            failureReason: failure.failureReason, failureClass: "sca_required", failureClassDecidedBy: failure.failureClassification.decidedBy });
          return { replayed: result.replayed, paymentAttemptId: a.id };
        },
        async readCycleRetryState() {
          const obligation = await createPostgresRetryStore(db).read(String(row.id));
          return { rowPresent: obligation !== null, retryAttempt: obligation?.retryAttempt ?? null, nextRetryAt: obligation?.nextRetryAt ?? null };
        },
        async openDunningCase() { return { status: "opened", caseId: (await handoff(intent, a.id)).caseId }; },
      } }, { subscriptionId: String(row.subscription_id), nextCycleAt: frozen.scheduledAt,
        providerKind: payments.provider, providerMethodRef: typeof methodRef === "string" ? methodRef : null }, {
        cycleId: String(row.subscription_cycle_id), cycleNumber: cycle.logicalCycleNumber,
        orderId: String(row.order_id), paymentIntentId: intent, executionIdempotencyKey: executionKey,
        providerIdempotencyKey: providerKey, providerRequestFingerprint: fingerprint, providerKind: payments.provider,
      }, "requires_action", { scaReason: "off_session_sca_required", defaultNow: input.now, unacknowledgedReason: status => `provider_attempt_${status}`,
        failure: { resolveClassification: () => ({ failureClass: "sca_required", decidedBy: "execution" }),
          recordKey: key => `${key}:blocked`, applyKey: key => `${key}:result`, dunningKey: key => `${key}:dunning`,
          preparedSuffix: "", blockedSuffix: "", dunningFailureKey: "subscription_dunning_failed_attempt_unattributed",
          // Native ports require a recorded rung and throw named refusals;
          // they do not produce the hosted logger-only outcomes.
          logBelowRetry: () => undefined, logRejected: () => undefined, logUnavailable: () => undefined } });
      return observe(intent, remote, retry);
    }
    if (a.status === "failed") {
      const receipt = (await db.query(`SELECT r.receipt_key,r.input FROM public.subscription_retry_receipts r
        JOIN public.subscription_retry_obligations o ON o.id=r.obligation_id WHERE o.renewal_operation_id=$1::uuid
        AND r.kind='failure' AND r.input->>'paymentAttemptId'=$2 ORDER BY r.id LIMIT 1`, [row.id, a.id])).rows[0];
      if (!receipt) return empty;
      const facts = subscriptionRecord(receipt.input);
      await handoff(intent, a.id);
      return { ...empty, status: "failed", disposition: "observed", eventKey: String(receipt.receipt_key),
        verifiedEvidenceRef: String(facts.evidenceKey), externalAttemptRef: facts.externalRef == null ? null : String(facts.externalRef),
        occurredAt: String(facts.occurredAt), firstRecordedAt: String(facts.firstRecordedAt), reason: String(facts.reason),
        amountMinor: attempt.amountMinor, currency: attempt.currency };
    }
    if (!remote) return empty;
    if (a.providerAttemptId && a.providerAttemptId !== remote) throw new Error("subscription_renewal_provider_attempt_conflict");
    const observed = await payments.adapter.readbackPort.readPayment({ identity: { provider: payments.provider,
      intentRef: intent, attemptRef: a.id, providerPaymentRef: remote },
    expectedMoney: { amountMinor: attempt.amountMinor, currency: attempt.currency }, purpose: "recovery" });
    if (!["succeeded", "failed", "pending"].includes(observed.kind) || !("observedMoney" in observed)) return empty;
    if (observed.observedMoney.amountMinor !== attempt.amountMinor || observed.observedMoney.currency !== attempt.currency) throw new Error("subscription_renewal_provider_money_mismatch");
    // A provider time remains nullable. Neither the clock nor checkedAt repairs it.
    const occurredAt = observed.providerOccurredAt ? nativeInstant(observed.providerOccurredAt) : null;
    const payload = { observedMoney: observed.observedMoney, providerOccurredAt: occurredAt };
    const key = `provider-read:${a.id}:${createHash("sha256").update(JSON.stringify({ checkedAt, ...payload, status: observed.kind })).digest("hex")}`;
    const recorded = await payments.reconciliation.recordEvidence({ idempotencyKey: key, provider: payments.provider,
      providerPaymentId: remote, paymentIntentId: intent, paymentAttemptId: a.id, localStatus: a.status,
      providerStatus: observed.kind, correctionStatus: "observed", checkedAt, payload });
    if (!recorded.reconciliationId) throw new Error("payment_reconciliation_evidence_readback_invalid");
    if (!occurredAt) return { ...empty, status: observed.kind, verifiedEvidenceRef: recorded.reconciliationId,
      eventKey: key, amountMinor: observed.observedMoney.amountMinor, currency: observed.observedMoney.currency };
    if ((!retry || observed.kind === "failed") && observed.kind !== "pending") await payments.reconciliation.applyTerminalResult({
      idempotencyKey: `${key}:apply`, expectedOrderId: String(row.order_id), expectedPaymentIntentId: intent,
      expectedPaymentAttemptId: a.id, expectedPaymentId: a.paymentId, provider: payments.provider, providerPaymentId: remote,
      localStatus: a.status, providerStatus: observed.kind, resultStatus: observed.kind, occurredAt,
      failureReason: observed.kind === "failed" ? "provider_failed" : null, checkedAt, payload });
    if (retry && observed.kind === "failed") return observe(intent, remote, true);
    return { ...empty, status: observed.kind, disposition: "observed", eventKey: `${key}:recovery`,
      verifiedEvidenceRef: recorded.reconciliationId, occurredAt, amountMinor: observed.observedMoney.amountMinor,
      currency: observed.observedMoney.currency, reason: observed.kind === "failed" ? "provider_failed" : null };
  }
  const lifecycle: { failureHandoff: RenewalFailureHandoffPort; settlement: RenewalSettlementPort } = {
    failureHandoff: { async handoffFailure(request) {
      const a = await payments.readAttempt(request.paymentIntentId);
      if (!a) throw new Error("payment_control_result_active_attempt_not_found");
      return handoff(request.paymentIntentId, a.paymentAttempt.id);
    } },
    settlement: { prepareRenewal: base.prepareRenewal,
      async acknowledgeExternalAttempt(request) {
        const row = (await db.query("SELECT * FROM public.subscription_renewal_operations WHERE id=$1::uuid", [request.operationId])).rows[0];
        // The payment owner may already have terminalized the operation. Only
        // the exact previously committed ACK can be projected as a replay.
        if (row && ["refused", "succeeded"].includes(String(row.state))
          && row.operation_fingerprint === request.operationFingerprint && row.external_attempt_ref === request.externalAttemptRef.trim()) {
          return input.codec.readback(subscriptionRecord((await db.query("SELECT public.subscription_read_renewal($1) AS response", [row.identity_key])).rows[0]?.response));
        }
        return base.acknowledgeExternalAttempt(request);
      },
      async recordTerminalOutcome(request) {
        const intent = (await db.query("SELECT id FROM public.commerce_settlement_intents WHERE renewal_operation_id=$1::uuid", [request.operationId])).rows[0];
        const attempt = intent && await payments.readAttempt(String(intent.id));
        if (!attempt) return base.recordTerminalOutcome(request);
        const correlated = await operation(String(intent.id));
        if (request.operationFingerprint !== correlated.row.operation_fingerprint) throw new Error("commerce_renewal_outcome_fingerprint_conflict");
        if ((request.outcome === "succeeded" && attempt.settlementStatus !== "settled")
          || (request.outcome === "refused" && attempt.paymentAttempt.status !== "failed")) throw new Error("subscription_renewal_provider_result_required");
        if (request.outcome === "succeeded") {
          const truth = (await db.query(`SELECT ingest_idempotency_key,occurred_at::text AS occurred_at FROM public.payment_truth_events
            WHERE settlement_intent_id=$1::uuid AND outcome='captured' AND state='settled'
            AND source_evidence->>'attemptRef'=$2 ORDER BY created_at,id LIMIT 1`, [intent.id, attempt.paymentAttempt.id])).rows[0];
          if (!truth) throw new Error("subscription_renewal_provider_result_required");
          // Reuse the payment owner's settlement key; only the native cycle,
          // stock and counter bookkeeping remains. No second money transition.
          return base.recordTerminalOutcome({ ...request, eventKey: String(truth.ingest_idempotency_key), occurredAt: String(truth.occurred_at) });
        }
        return input.codec.readback(subscriptionRecord((await db.query("SELECT public.subscription_read_renewal($1) AS response",
          [correlated.row.identity_key])).rows[0]?.response));
      } },
  };
  const retryPayments: NativeRetryDriverOptions["payments"] = {
    execute: rail.execute,
    async readOutcome(prepared) {
      const a = await payments.readAttempt(prepared.settlementIntentId);
      return observe(prepared.settlementIntentId, a?.paymentAttempt.providerAttemptId ?? null, true);
    },
  };
  function composeWebhook<C extends ProviderRenewalWebhookControl>(event: ProviderRenewalWebhook, control: C): Omit<C, "applyPaymentResult"> & { applyPaymentResult: NonNullable<ProviderRenewalWebhookControl["applyPaymentResult"]> } {
    let ingested: Awaited<ReturnType<ProviderRenewalWebhookIngest>> | undefined;
    return { ...control, ...(control.ingestPaymentEvent ? { async ingestPaymentEvent(delivery: Parameters<ProviderRenewalWebhookIngest>[0]) {
      ingested = await control.ingestPaymentEvent!(delivery);
      return ingested;
    } } : {}), async applyPaymentResult(request) {
      const op = (await db.query(`SELECT op.*,i.order_id FROM public.commerce_settlement_intents i
        JOIN public.subscription_renewal_operations op ON op.id=i.renewal_operation_id WHERE i.id=$1::uuid`, [request.paymentIntentId])).rows[0];
      if (request.resultStatus !== "succeeded" || !op) return control.applyPaymentResult!(request);
      if (!ingested || ingested.paymentEventId !== request.paymentEventId || ingested.paymentIntentId !== request.paymentIntentId) {
        throw new Error("payment_event_receipt_unavailable");
      }
      // Ingest owns immutable event attribution. A later finalized matching
      // handle cannot resolve its null link. Let the result owner refuse it
      // before attempt-specific bookkeeping and let ingress ACK that refusal.
      if (ingested.paymentAttemptId === null) return control.applyPaymentResult!(request);
      const attempt = await payments.readAttempt(request.paymentIntentId, null);
      if (!attempt || ingested.paymentAttemptId !== attempt.paymentAttempt.id) return control.applyPaymentResult!(request);
      const a = attempt.paymentAttempt;
      const receipt = subscriptionRecord((await db.query("SELECT public.commerce_checkout_payment_guidance_snapshot($1::uuid,$2::uuid,NULL::uuid) AS response",
        [op.order_id, request.paymentIntentId])).rows[0]?.response);
      if (receipt.historyComplete !== true) throw new Error("payment_event_receipt_unavailable");
      const history = receipt.attempts as { id: string; evidence: Record<string, unknown>[] }[];
      const durable = history?.find(row => row.id === a.id)?.evidence.find(value =>
        subscriptionRecord(value.openlupEvidence).providerEventId === event.providerEventId);
      const firstRecordedAt = durable && subscriptionRecord(durable.openlupReceipt).recordedAt;
      if (typeof firstRecordedAt !== "string") throw new Error("payment_event_receipt_unavailable");
      return input.withTransaction(async tx => {
        const retry = createPostgresRetryStore(tx), obligation = await retry.read(String(op.id));
        if (obligation && obligation.state !== "recovered") {
          // The retry store owns positive truth before the provider status is
          // projected. Both commit together with one settlement and recovery.
          const preparation = (await tx.query(`SELECT r.receipt_key FROM public.subscription_retry_receipts r
            JOIN public.subscription_retry_obligations o ON o.id=r.obligation_id WHERE o.renewal_operation_id=$1::uuid
            AND r.kind='prepare' AND r.attempt_sequence=o.attempt_sequence`, [op.id])).rows[0];
          if (obligation.state === "prepared" && !preparation) throw new Error("subscription_retry_prepared_receipt_missing");
          const normalized = subscriptionRecord(durable!.openlupEvidence);
          const sourceEvidence = { sourceKind: "accepted_event", sourceReference: request.paymentEventId, observedStatus: "succeeded",
            observedAt: nativeInstant(request.occurredAt), payloadFingerprint: normalized.fingerprint, attemptRef: a.id };
          await retry.recordRecovery(String(op.id), `${request.idempotencyKey}:truth`, {
            ...sourceEvidence,
            ...(preparation ? { prepareKey: String(preparation.receipt_key) } : {}), evidenceKey: `provider:${request.paymentEventId}`,
            occurredAt: nativeInstant(request.occurredAt), firstRecordedAt: nativeInstant(firstRecordedAt),
            externalRef: event.providerPaymentId, amountMinor: attempt.amountMinor, currency: attempt.currency, template: input.truth.recoveryTemplateSlug,
          });
        }
        const applied = await payments.controlFor(tx).applyPaymentResult(request);
        if (!obligation && op.state === "attempt_prepared") await input.settlement(tx).recordTerminalOutcome({
          operationId: String(op.id), operationFingerprint: String(op.operation_fingerprint), eventKey: `${request.idempotencyKey}:truth`,
          outcome: "succeeded", externalRef: event.providerPaymentId, occurredAt: request.occurredAt });
        return { replayed: applied.replayed };
      });
    } };
  }
  return { rail, paymentRails: { resolve: (channel: string) => input.enabled === true && channel === input.channelKey ? rail : null }, lifecycle, retryPayments, composeWebhook };
}
