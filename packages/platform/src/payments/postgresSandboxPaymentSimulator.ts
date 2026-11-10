import { nativeInstant } from "./nativeInstant.js";
import { paymentPayloadFingerprint } from "./paymentTruth.js";
import { createPostgresPaymentTruthPort } from "./postgresPaymentTruth.js";
import { createVerifiedPaymentIngress } from "./verifiedIngress.js";
import type { SandboxPaymentAttempt, SandboxPaymentSimulator, SandboxPaymentSimulatorOptions } from "./contracts/sandbox.js";
import type { VerifiedPaymentEvidence } from "./contracts/evidence.js";

interface Executor { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }
function attemptTimes<T extends SandboxPaymentAttempt>(value: T): T {
  return { ...value, dispatchedAt: nativeInstant(value.dispatchedAt),
    methodFacts: { ...value.methodFacts, unattendedChargeAuthorizedAt: nativeInstant(value.methodFacts.unattendedChargeAuthorizedAt) },
    latestObservation: value.latestObservation && { ...value.latestObservation,
      occurredAt: nativeInstant(value.latestObservation.occurredAt), recordedAt: nativeInstant(value.latestObservation.recordedAt) } };
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Server-only no-key simulator. The host authorizes commands; durable observations are its verifier's source. */
export function createPostgresSandboxPaymentSimulator(db: Executor, options: SandboxPaymentSimulatorOptions): SandboxPaymentSimulator {
  const truth = createPostgresPaymentTruthPort(db, options);
  async function call(sql: string, args: unknown[]) { return (await db.query(sql, args)).rows[0]?.response; }
  async function read(input: { settlementIntentId: string; attemptId?: string }) {
    const value = await call("SELECT public.payment_simulator_read_attempt($1::uuid,$2::uuid) AS response", [input.settlementIntentId, input.attemptId ?? null]);
    return value == null ? null : attemptTimes(value as SandboxPaymentAttempt);
  }
  const ingress = createVerifiedPaymentIngress({ provider: "sandbox", verifyPort: {
    async verifyAndNormalize(input) {
      let identity: Record<string, unknown>;
      try { identity = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.rawBody)); }
      catch { return { kind: "refusal", reason: "malformed" }; }
      if (!identity || typeof identity !== "object" || Array.isArray(identity)
        || Object.keys(identity).sort().join(",") !== "attemptId,observationId,settlementIntentId"
        || ![identity.attemptId, identity.observationId, identity.settlementIntentId].every(value => typeof value === "string" && UUID.test(value))) {
        return { kind: "refusal", reason: "malformed" };
      }
      const attempt = await read({ settlementIntentId: String(identity.settlementIntentId), attemptId: String(identity.attemptId) });
      let event = attempt?.latestObservation;
      // Replay the immutable accepted truth even after a later observation/attempt.
      const accepted = (await db.query(`SELECT source_evidence,
        to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at FROM public.payment_truth_events
        WHERE source_event_id=$1 AND settlement_intent_id=$2::uuid AND source_evidence->>'attemptRef'=$3`,
      [`sandbox:${identity.observationId}`, identity.settlementIntentId, identity.attemptId])).rows[0];
      if (accepted) {
        const evidence = accepted.source_evidence as Record<string, string>;
        event = { id: String(identity.observationId), eventKey: "", fingerprint: evidence.payloadFingerprint,
          outcome: evidence.observedStatus as NonNullable<typeof event>["outcome"],
          occurredAt: nativeInstant(evidence.observedAt), recordedAt: nativeInstant(String(accepted.created_at)) };
      }
      if (!attempt || !event || event.id !== identity.observationId) return { kind: "refusal", reason: "malformed" };
      // Money is read from the existing intent, not a simulator request or browser return.
      const money = (await db.query("SELECT amount_minor,currency_code FROM public.commerce_settlement_intents WHERE id=$1::uuid", [attempt.settlementIntentId])).rows[0];
      if (!money) return { kind: "refusal", reason: "malformed" };
      return {
        kind: "money", provider: "sandbox", providerEventId: `sandbox:${event.id}`, fingerprint: event.fingerprint,
        providerOccurredAt: nativeInstant(event.occurredAt), providerPaymentRef: attempt.id, intentRef: attempt.settlementIntentId,
        attemptRef: attempt.id, outcome: event.outcome === "captured" ? "succeeded" : event.outcome === "indeterminate" ? "pending" : "failed",
        money: { amountMinor: Number(money.amount_minor), currency: String(money.currency_code) },
        providerAuditPayload: { sandboxObservation: { ...event } },
      } satisfies VerifiedPaymentEvidence;
    },
  }, paymentControlPort: {
    async ingestPaymentEvent(event) {
      const observed = event.rawPayload.sandboxObservation as SandboxPaymentAttempt["latestObservation"];
      if (!observed || !event.paymentIntentId || !event.paymentAttemptId) throw new Error("payment_simulator_observation_required");
      const outcome = observed.outcome === "expired" ? "refused" : observed.outcome;
      const occurredAt = nativeInstant(observed.occurredAt);
      const evidence = { sourceKind: "accepted_event" as const, sourceReference: observed.id, observedStatus: observed.outcome,
        observedAt: occurredAt, payloadFingerprint: observed.fingerprint, attemptRef: event.paymentAttemptId };
      const result = await truth.ingestEvent({
        sourceEventId: event.providerEventId, idempotencyKey: `sandbox:ingest:${observed.id}`,
        settlementIntentId: event.paymentIntentId, outcome, amountMinor: event.amountMinor!, currency: event.currency!,
        occurredAt,
        failure: outcome === "refused" ? { classification: "unknown_refusal", reason: `sandbox_${observed.outcome}` } : null,
        evidence,
      }).catch((error: unknown) => {
        // Existing ingress ACK vocabulary: durable stale observations cannot ever apply.
        if (error instanceof Error && error.message === "wrong_attempt") throw new Error("payment_control_result_attempt_mismatch");
        throw error;
      });
      return { paymentEventId: result.event.id, paymentIntentId: event.paymentIntentId,
        paymentAttemptId: event.paymentAttemptId, replayed: result.event.replayed, occurredAt };
    },
  } });
  return {
    ingress,
    async beginAttempt(input) {
      if (input.inlineRetry) {
        return attemptTimes(await call(`SELECT public.commerce_checkout_inline_retry_begin($1,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,
          CASE WHEN jsonb_typeof($7::jsonb#>'{methodFacts,unattendedChargeAuthorizedAt}')='string'
            THEN jsonb_set($7::jsonb,'{methodFacts,unattendedChargeAuthorizedAt}',to_jsonb(($7::jsonb#>>'{methodFacts,unattendedChargeAuthorizedAt}')::timestamptz))
            ELSE $7::jsonb END,$8::timestamptz) AS response`,
          [input.idempotencyKey,input.inlineRetry.orderId,input.inlineRetry.clientId,input.settlementIntentId,input.inlineRetry.expectedAttemptId,
            input.requestFingerprint,JSON.stringify({...input.inlineRetry.context,methodFacts:input.methodFacts??{}}),input.at]) as SandboxPaymentAttempt & {replayed:boolean});
      }
      if (input.checkoutRecovery) {
        return attemptTimes(await call(`SELECT public.commerce_checkout_recovery_attempt_begin($1,$2::uuid,$3::uuid,$4::uuid,$5,
          CASE WHEN jsonb_typeof($6::jsonb#>'{methodFacts,unattendedChargeAuthorizedAt}')='string'
            THEN jsonb_set($6::jsonb,'{methodFacts,unattendedChargeAuthorizedAt}',to_jsonb(($6::jsonb#>>'{methodFacts,unattendedChargeAuthorizedAt}')::timestamptz))
            ELSE $6::jsonb END,$7::timestamptz) AS response`,
          [input.idempotencyKey, input.checkoutRecovery.orderId, input.checkoutRecovery.clientId, input.settlementIntentId,
            input.requestFingerprint, JSON.stringify({ recoveryTokenId: input.checkoutRecovery.recoveryTokenId, methodFacts: input.methodFacts ?? {} }), input.at]) as SandboxPaymentAttempt & { replayed: boolean });
      }
      return attemptTimes(await call(`SELECT public.payment_simulator_begin_attempt($1,$2::uuid,$3,
        CASE WHEN jsonb_typeof($4::jsonb->'unattendedChargeAuthorizedAt')='string'
          THEN jsonb_set($4::jsonb,'{unattendedChargeAuthorizedAt}',to_jsonb(($4::jsonb->>'unattendedChargeAuthorizedAt')::timestamptz))
          ELSE $4::jsonb END,$5::timestamptz) AS response`,
        [input.idempotencyKey, input.settlementIntentId, input.requestFingerprint, JSON.stringify(input.methodFacts ?? {}), input.at]) as SandboxPaymentAttempt & { replayed: boolean });
    },
    async recordObservation(input) {
      return await call("SELECT public.payment_simulator_record_observation($1::uuid,$2,$3,$4,$5::timestamptz) AS response",
        [input.attemptId, input.idempotencyKey, paymentPayloadFingerprint({ ...input, occurredAt: nativeInstant(input.occurredAt) }), input.outcome, input.occurredAt]) as { id: string; replayed: boolean };
    },
    readAttempt: read,
  };
}
