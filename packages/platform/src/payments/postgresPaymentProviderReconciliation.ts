import { z } from "zod";
import type { PaymentProviderExecutor } from "./postgresPreparedAttempt.js";
import type { InteractivePreparedAttemptManualReconciliationPort } from "./contracts/reconciliation.js";
import type { PostgresPaymentTruthOptions } from "./contracts/truth.js";
import { nativeInstant } from "./nativeInstant.js";

const instant = z.union([z.string(), z.date()]).transform(value => nativeInstant(value instanceof Date ? value.toISOString() : value));
const nullableInstant = instant.nullable();
const claim = z.object({ payment_attempt_id: z.guid(), payment_intent_id: z.guid(), payment_id: z.guid(), order_id: z.guid(),
  subscription_id: z.guid().nullable(), subscription_cycle_id: z.guid().nullable(), provider: z.string().min(1),
  provider_payment_id: z.string().nullable(), provider_attempt_id: z.string().nullable(), provider_session_id: z.string().nullable(),
  attempt_status: z.string(), intent_status: z.string(), amount_cents: z.coerce.number().int().positive().safe(), currency: z.string(),
  order_mode: z.enum(["one_time", "subscription_cycle"]), cycle_retry_attempt: z.number().int().nonnegative(),
  cycle_next_retry_at: nullableInstant, local_updated_at: instant }).refine(row => row.order_mode === "one_time"
  ? row.subscription_id === null && row.subscription_cycle_id === null : row.subscription_id !== null && row.subscription_cycle_id !== null);
const paymentResult = z.object({ paymentIntentId: z.guid(), paymentAttemptId: z.guid(), paymentId: z.guid(), orderId: z.guid(),
  status: z.string(), kind: z.string(), replayed: z.boolean() });
const applied = z.object({ paymentReconciliationApply: z.object({ paymentResult, correctionStatus: z.enum(["corrected", "ignored"]),
  replayed: z.boolean(), subscriptionWebhookDunning: z.object({ opened: z.boolean(), replayed: z.boolean(),
    caseId: z.guid().nullable().optional() }).nullable().optional() }) });

/** Provider reads run outside SQL; application and evidence commit atomically. */
export function createPostgresPaymentProviderReconciliationPort(
  db: PaymentProviderExecutor, options: PostgresPaymentTruthOptions,
): InteractivePreparedAttemptManualReconciliationPort {
  async function claims(name: "stale" | "prepared", input: { now: string; staleAfterSeconds: number; limit: number; claimKey: string }) {
    const rows = (await db.query(`SELECT * FROM public.commerce_payment_reconciliation_claim_${name}_attempts($1::timestamptz,$2::integer,$3::integer,$4)`,
      [input.now, input.staleAfterSeconds, input.limit, input.claimKey])).rows;
    const parsed = z.array(claim).safeParse(rows);
    if (!parsed.success) throw new Error("payment_reconciliation_claim_readback_invalid");
    return parsed.data.map(row => ({ paymentAttemptId: row.payment_attempt_id, paymentIntentId: row.payment_intent_id,
      paymentId: row.payment_id, orderId: row.order_id, subscriptionId: row.subscription_id, subscriptionCycleId: row.subscription_cycle_id,
      provider: row.provider, providerPaymentId: row.provider_payment_id, providerAttemptId: row.provider_attempt_id,
      providerSessionId: row.provider_session_id, attemptStatus: row.attempt_status, intentStatus: row.intent_status,
      amountMinor: row.amount_cents, currency: row.currency, orderMode: row.order_mode, cycleRetryAttempt: row.cycle_retry_attempt,
      cycleNextRetryAt: row.cycle_next_retry_at, localUpdatedAt: row.local_updated_at }));
  }
  return {
    claimPreparedAttempts: input => claims("prepared", input),
    claimStaleAttempts: input => claims("stale", input),
    async recordEvidence(input) {
      const parsed = z.object({ paymentReconciliation: z.object({ id: z.guid() }) }).safeParse((await db.query(
        "SELECT public.commerce_payment_control_record_reconciliation($1,$2,$3,$4::uuid,$5::uuid,$6,$7,$8,$9::timestamptz,$10::jsonb) AS response",
        [input.idempotencyKey, input.provider, input.providerPaymentId, input.paymentIntentId, input.paymentAttemptId,
          input.localStatus, input.providerStatus, input.correctionStatus, input.checkedAt, JSON.stringify(input.payload)],
      )).rows[0]?.response);
      if (!parsed.success) throw new Error("payment_reconciliation_evidence_readback_invalid");
      return { replayed: false };
    },
    async applyTerminalResult(input) {
      const parsed = applied.safeParse((await db.query(
        "SELECT public.commerce_payment_control_apply_reconciliation_result($1,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8,$9,$10,$11::timestamptz,$12,$13::timestamptz,$14::jsonb,$15,$16,$17,$18,$19) AS response",
        [input.idempotencyKey, input.expectedOrderId, input.expectedPaymentIntentId, input.expectedPaymentAttemptId,
          input.expectedPaymentId, input.provider, input.providerPaymentId, input.localStatus, input.providerStatus, input.resultStatus,
          input.occurredAt, input.failureReason, input.checkedAt, JSON.stringify(input.payload), input.failureClassification?.failureClass ?? null,
          input.failureClassification?.decidedBy ?? null, options.dunningTemplateSlug, options.recoveryUrlPath, options.recoveryTemplateSlug],
      )).rows[0]?.response);
      if (!parsed.success) throw new Error("payment_reconciliation_apply_readback_invalid");
      const body = parsed.data.paymentReconciliationApply;
      return { ...body, subscriptionWebhookDunning: body.subscriptionWebhookDunning
        ? { ...body.subscriptionWebhookDunning, caseId: body.subscriptionWebhookDunning.caseId ?? null } : null };
    },
    async reopenPreparedAttemptAfterAbsence(input) {
      const parsed = z.object({ preparedAttemptReopen: z.object({ replayed: z.boolean() }) }).safeParse((await db.query(
        "SELECT public.commerce_payment_control_reopen_prepared_attempt_after_absence($1,$2::uuid,$3::uuid,$4::uuid,$5,$6::timestamptz,$7::timestamptz,$8::jsonb) AS response",
        [input.idempotencyKey, input.paymentAttemptId, input.expectedPaymentIntentId, input.expectedSubscriptionCycleId,
          input.operatorRef, input.absenceCheckedAt, input.nextRetryAt, JSON.stringify(input.absenceEvidence)],
      )).rows[0]?.response);
      if (!parsed.success) throw new Error("payment_reconciliation_reopen_readback_invalid");
      return parsed.data.preparedAttemptReopen;
    },
    async reopenInteractivePreparedAttemptAfterAbsence(input) {
      const parsed = z.object({ interactivePreparedAttemptReopen: z.object({ paymentAttemptId: z.guid(), paymentIntentId: z.guid(),
        paymentAttemptStatus: z.literal("failed"), paymentIntentStatus: z.literal("failed"), replayed: z.boolean() }) }).safeParse((await db.query(
        "SELECT public.commerce_payment_control_reopen_interactive_prepared_attempt($1,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7,$8,$9,$10,$11,$12::timestamptz,$13::jsonb) AS response",
        [input.idempotencyKey, input.paymentAttemptId, input.expectedPaymentIntentId, input.expectedOrderId, input.expectedSubscriptionId,
          input.expectedSubscriptionCycleId, "manual_provider_absence", "provider_absence_confirmed", "operator_reconciliation",
          input.absenceEvidence.evidenceCode, input.operatorRef, input.absenceCheckedAt, JSON.stringify(input.absenceEvidence)],
      )).rows[0]?.response);
      if (!parsed.success) throw new Error("payment_reconciliation_interactive_reopen_readback_invalid");
      return parsed.data.interactivePreparedAttemptReopen;
    },
  };
}
