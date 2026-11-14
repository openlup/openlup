import { nativeInstant } from "./nativeInstant.js";
import type { RenewalExecutionRequest, RenewalPaymentEvidence, RenewalPaymentRail } from "./contracts/renewal.js";
import type { AutomaticRenewalPolicy } from "./automaticRenewal.js";
import type { SubscriptionQueryExecutor } from "./postgresRenewalStore.js";

export type SandboxRenewalScenario = "succeeded" | "declined" | "ambiguous";
/** No provider, key, network or real mandate. The existing native operation is
 * the dispatch fence; the existing outcome ledger stores sandbox observations. */
export function createPostgresSandboxRenewalRail(executor: SubscriptionQueryExecutor, options: {
  scenario: SandboxRenewalScenario; now?: () => string;
}): RenewalPaymentRail & {
  observe(input: { operationId: string; fingerprint: string; externalAttemptRef: string;
    outcome: "succeeded" | "refused"; occurredAt: string }): Promise<void>;
} {
  const now = options.now ?? (() => new Date().toISOString());
  async function operation(settlementIntentId: string) {
    const row = (await executor.query(`SELECT op.*,si.id AS intent_id,si.order_id,si.amount_minor,si.currency_code,
      CASE WHEN public.subscription_method_uses_recorded_refs(s.id) THEN public.subscription_method_health_read(s.id)->>'provider_method_ref' ELSE m.method_ref END AS method_ref,
      CASE WHEN public.subscription_method_uses_recorded_refs(s.id) THEN public.subscription_method_health_read(s.id)->>'health_state' ELSE m.health_state END AS health_state,
      CASE WHEN public.subscription_method_uses_recorded_refs(s.id) THEN public.subscription_method_chargeable_unattended(s.id,now()) ELSE m.health_state='healthy' END AS method_authorized,s.client_id FROM public.subscription_renewal_operations op
      JOIN public.commerce_settlement_intents si ON si.renewal_operation_id=op.id
      JOIN public.subscriptions s ON s.id=op.subscription_id
      JOIN public.subscription_method_states m ON m.subscription_id=s.id
      WHERE si.id=$1::uuid AND op.cycle_snapshot->>'settlementChannelKey'='sandbox'`, [settlementIntentId])).rows[0];
    if (!row) throw new Error("subscription_sandbox_operation_missing");
    return row;
  }
  const rail = {
    async observe(input: { operationId: string; fingerprint: string; externalAttemptRef: string;
      outcome: "succeeded" | "refused"; occurredAt: string }) {
      await executor.query("SELECT public.subscription_record_sandbox_renewal_observation($1::uuid,$2::text,$3::text,$4::text,$5::timestamptz)",
        [input.operationId, input.fingerprint, input.externalAttemptRef, input.outcome, input.occurredAt]);
    },
    async execute(input: RenewalExecutionRequest) {
      const op = await operation(input.paymentIntentId);
      if (input.mode !== "subscription" || input.flow !== "off_session" || input.recurringModel !== "sandbox"
        || input.requestFingerprint !== op.operation_fingerprint || input.cycleIdempotencyKey !== op.identity_key
        || input.executionIdempotencyKey !== `${op.identity_key}:initial` || input.externalIdempotencyKey !== `${op.identity_key}:sandbox`
        || input.orderId !== op.order_id || input.orderRef !== op.order_id || input.clientId !== op.client_id
        || input.amountMinor !== Number(op.amount_minor) || input.currency !== op.currency_code) throw new Error("subscription_sandbox_request_mismatch");
      // A stale method is known before the simulated dispatch, so it is an
      // explicit refusal rather than an indeterminate, permanently open attempt.
      if (!op.external_attempt_ref && (input.paymentMethodRef !== op.method_ref || op.method_authorized !== true)) return {
        status: "failed" as const, externalAttemptRef: null,
        failure: { reason: "sandbox_method_unavailable", failureClass: "payment_method_unavailable" },
      };
      const prefix = `sandbox-renewal:${String(op.id)}:${options.scenario}:`;
      let externalAttemptRef = typeof op.external_attempt_ref === "string" ? op.external_attempt_ref : null;
      if (externalAttemptRef && !externalAttemptRef.startsWith(prefix)) throw new Error("subscription_sandbox_scenario_conflict");
      if (!externalAttemptRef) {
        externalAttemptRef = `${prefix}${nativeInstant(now())}`;
        await executor.query("SELECT public.commerce_acknowledge_subscription_renewal_attempt($1::uuid,$2::text,$3::text,$4::timestamptz)",
          [op.id, op.operation_fingerprint, externalAttemptRef, now()]);
      }
      // A replay never synthesizes another observation, even if a process died
      // between ACK and observation. The host can explicitly record late truth.
      if (!op.external_attempt_ref && options.scenario !== "ambiguous") await rail.observe({
        operationId: String(op.id), fingerprint: String(op.operation_fingerprint), externalAttemptRef,
        outcome: options.scenario === "succeeded" ? "succeeded" : "refused", occurredAt: now(),
      });
      return { status: "pending" as const, externalAttemptRef };
    },
    async findExternalAttempt(input: { settlementIntentId: string }) {
      const op = await operation(input.settlementIntentId);
      return typeof op.external_attempt_ref === "string" ? op.external_attempt_ref : null;
    },
    async readOutcome(input: { externalAttemptRef: string; settlementIntentId: string; orderId: string;
      subscriptionId: string; amountMinor: number; currency: string }): Promise<RenewalPaymentEvidence> {
      const op = await operation(input.settlementIntentId);
      if (op.external_attempt_ref !== input.externalAttemptRef || op.order_id !== input.orderId || op.subscription_id !== input.subscriptionId
        || Number(op.amount_minor) !== input.amountMinor || op.currency_code !== input.currency) throw new Error("subscription_sandbox_readback_mismatch");
      const event = (await executor.query(`SELECT *,
        to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at,
        to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
        FROM public.subscription_renewal_outcomes
        WHERE renewal_operation_id=$1::uuid AND event_key=$2::text`, [op.id, `sandbox-observation:${String(op.id)}`])).rows[0];
      if (event && (event.operation_fingerprint !== op.operation_fingerprint || event.external_ref !== input.externalAttemptRef)) throw new Error("subscription_sandbox_observation_mismatch");
      return { status: event ? event.outcome === "succeeded" ? "succeeded" : "failed" : "unknown",
        disposition: event ? "observed" : "ambiguous", operationId: String(op.id),
        eventKey: event ? String(event.event_key) : `sandbox-observation:${String(op.id)}`,
        requestFingerprint: String(op.operation_fingerprint), verifiedEvidenceRef: event ? `sandbox:${String(event.id)}` : "",
        externalAttemptRef: input.externalAttemptRef, occurredAt: event ? String(event.occurred_at) : null,
        observedAt: event ? String(event.created_at) : nativeInstant(now()), firstRecordedAt: event ? String(event.created_at) : nativeInstant(now()),
        amountMinor: input.amountMinor, currency: input.currency, reason: event?.outcome === "refused" ? "sandbox_declined" : null };
    },
  };
  return rail;
}

/** Host supplies current method identity from readMethod; all original money,
 * identities and authorization remain the frozen operation's own facts. */
export function createSandboxRenewalPolicy(methodRef: string): AutomaticRenewalPolicy {
  return {
    identityKey: due => `subscription:${due.subscriptionId}:cycle:${nativeInstant(due.scheduledAt).replace(/(?:\.(\d*))?Z$/, (_, fraction = "") => `.${fraction.padEnd(3, "0").slice(0, 3)}Z`)}`,
    classifyFailure: () => "temporary",
    validateInput(input) {
      if (!input.paymentMethodRef || input.recurringModel !== "sandbox") throw new Error("subscription_sandbox_method_required");
    },
    executionInput(_due, operation, prepared) {
      const snapshot = operation.cycleSnapshot;
      if (snapshot.cycle.status !== "correlated") throw new Error("subscription_renewal_cycle_correlation_required");
      return { cycleIdempotencyKey: operation.identityKey, executionIdempotencyKey: `${operation.identityKey}:initial`,
        externalIdempotencyKey: `${operation.identityKey}:sandbox`, requestFingerprint: operation.operationFingerprint,
        paymentIntentId: prepared.settlementIntentId, orderRef: prepared.orderId, orderId: prepared.orderId,
        amountMinor: snapshot.pricingSnapshot.totalAmountMinor, currency: snapshot.pricingSnapshot.currency,
        mode: "subscription", flow: "off_session", clientId: snapshot.clientId, customerRef: snapshot.payerAccountRef,
        paymentMethodRef: methodRef, recurringModel: "sandbox", payer: null };
    },
  };
}
