import { z } from "zod";
import type { PostgresPaymentTruthOptions } from "./contracts/truth.js";
import { createPostgresPreparedAttemptPersistencePort, decodeProviderAttempt, type PaymentProviderExecutor } from "./postgresPreparedAttempt.js";

export interface ProviderPaymentIntentInput {
  idempotencyKey: string;
  targetKind: "one_time_order" | "subscription_cycle";
  orderId: string;
  subscriptionId?: string | null;
  subscriptionCycleId?: string | null;
  amountMinor: number;
  currency: string;
  metadata: Record<string, unknown>;
  channelKey: string;
  at: string;
}
export interface ProviderPaymentAttemptInput {
  idempotencyKey: string;
  paymentIntentId: string;
  provider: string;
  providerAttemptId: string | null;
  providerSessionId: string | null;
  attemptStatus: "blocked_preflight" | "sent_to_provider" | "requires_action" | "processing";
  nextActionKind: string | null;
  requestPayload: Record<string, unknown>;
  responsePayload: Record<string, unknown>;
}
export interface ProviderPaymentResultInput {
  idempotencyKey: string;
  paymentIntentId: string;
  paymentEventId: string | null;
  resultStatus: "succeeded" | "failed" | "expired" | "refunded" | "partially_refunded" | "disputed";
  occurredAt: string;
  failureReason: string | null;
  failureClass?: string | null;
  failureClassDecidedBy?: string | null;
}

/** Explicit lifecycle admission; historical native intents are never backfilled. */
export function createPostgresProviderPaymentControlPort(db: PaymentProviderExecutor, options: PostgresPaymentTruthOptions) {
  return {
    ...createPostgresPreparedAttemptPersistencePort(db),
    async createIntent(input: ProviderPaymentIntentInput) {
      const parsed = z.object({ paymentIntent: z.object({ id: z.guid(), paymentId: z.guid(), orderId: z.guid(),
        status: z.string(), amountMinor: z.number().int().positive(), currency: z.string(), replayed: z.boolean() }) }).safeParse(
        (await db.query("SELECT public.payment_provider_intent_create($1,$2,$3::uuid,$4::uuid,$5::uuid,$6::bigint,$7,$8::jsonb,$9,$10::timestamptz) AS response",
          [input.idempotencyKey, input.targetKind, input.orderId, input.subscriptionId ?? null, input.subscriptionCycleId ?? null,
            input.amountMinor, input.currency, JSON.stringify(input.metadata), input.channelKey, input.at])).rows[0]?.response);
      if (!parsed.success) throw new Error("payment_provider_intent_readback_invalid");
      return parsed.data.paymentIntent;
    },
    async recordAttempt(input: ProviderPaymentAttemptInput) {
      return decodeProviderAttempt((await db.query(
        "SELECT public.payment_provider_attempt_record($1,$2::uuid,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb) AS response",
        [input.idempotencyKey, input.paymentIntentId, input.provider, input.providerAttemptId, input.providerSessionId,
          input.attemptStatus, input.nextActionKind, JSON.stringify(input.requestPayload), JSON.stringify(input.responsePayload)],
      )).rows[0]?.response);
    },
    async applyPaymentResult(input: ProviderPaymentResultInput) {
      const parsed = z.object({ paymentResult: z.object({ replayed: z.boolean(), paymentIntentId: z.guid(),
        paymentAttemptId: z.guid(), paymentId: z.guid(), orderId: z.guid(), status: z.string(), kind: z.string() }) }).safeParse(
        (await db.query("SELECT public.payment_provider_result_apply($1,$2::uuid,$3::uuid,$4,$5::timestamptz,$6,$7,$8,$9,$10,$11) AS response",
          [input.idempotencyKey, input.paymentIntentId, input.paymentEventId, input.resultStatus, input.occurredAt,
            input.failureReason, input.failureClass ?? null, input.failureClassDecidedBy ?? null,
            options.dunningTemplateSlug, options.recoveryUrlPath, options.recoveryTemplateSlug])).rows[0]?.response);
      if (!parsed.success) throw new Error("payment_provider_result_readback_invalid");
      return parsed.data.paymentResult;
    },
  };
}
