import type { PreparedAttemptPrepareInput } from "./contracts/preparedAttempt.js";
import { decodeProviderAttempt, type PaymentProviderExecutor } from "./postgresPreparedAttempt.js";

function continuationStatus(status: string): "processing" | "failed" | "expired" | "paid" {
  return status === "succeeded" ? "paid" : status === "expired" ? "expired"
    : ["failed", "cancelled", "blocked_preflight"].includes(status) ? "failed" : "processing";
}

/** The host supplies recorded provider authority and the enriched request. */
export type ProviderCheckoutMethod = Omit<PreparedAttemptPrepareInput, "idempotencyKey" | "paymentIntentId">;

/** Token admission and preparation commit together, before any provider call. */
export function createPostgresProviderCheckoutRecoveryAttemptPort(db: PaymentProviderExecutor, now: () => Date = () => new Date()) {
  return { async begin(input: { order: { orderId: string; totalMinor: number; currency: string }; clientId: string;
    recoveryTokenId: string; paymentIntentId: string; idempotencyKey: string; method: ProviderCheckoutMethod }) {
    const m = input.method;
    const attempt = decodeProviderAttempt((await db.query(
      "SELECT public.commerce_checkout_recovery_attempt_begin($1,$2::uuid,$3::uuid,$4::uuid,$5,$6::jsonb,$7::timestamptz) AS response",
      [`${input.idempotencyKey}:payment-execution:prepare-attempt`, input.order.orderId, input.clientId, input.paymentIntentId,
        m.providerRequestFingerprint, JSON.stringify({ ...m, recoveryTokenId: input.recoveryTokenId }), now().toISOString()],
    )).rows[0]?.response);
    return { orderId: input.order.orderId, paymentIntentId: input.paymentIntentId, clientId: input.clientId, ...attempt, status: continuationStatus(attempt.status),
      failureReason: null };
  } };
}

/** Exact predecessor admission shares the existing atomic checkout transition. */
export function createPostgresProviderInlineRecoveryAttemptPort(db: PaymentProviderExecutor,
  methodKeyFor: (request: Record<string, unknown>) => string | null, now: () => Date = () => new Date()) {
  return {
    assertExecutionRail(rail: string) {
      if (!rail.trim() || rail === "sandbox") throw new Error("native_prepared_attempt_store_unsupported");
    },
    async readPreviousMethod(input: { orderId: string; paymentIntentId: string; paymentAttemptId: string; executionRail: string }) {
      const value = (await db.query("SELECT public.payment_provider_attempt_read($1::uuid,$2::uuid) AS result", [input.paymentIntentId, input.paymentAttemptId])).rows[0]?.result;
      if (!value || typeof value !== "object") return null;
      const row = value as Record<string, unknown>;
      const a = row.paymentAttempt as Record<string, unknown> | undefined;
      return row.orderId === input.orderId.toLowerCase() && a?.provider === input.executionRail && row.requestPayload && typeof row.requestPayload === "object"
        ? methodKeyFor(row.requestPayload as Record<string, unknown>) : null;
    },
    async begin(input: { method: ProviderCheckoutMethod;
      request: { orderId: string; clientId: string; paymentIntentId: string; expectedPaymentAttemptId: string; retryRequestId: string; executionRail: string; methodKey: string };
      admission: { replayOnly: boolean; purchaseContext: "one_time" | "subscription_initial" | null; previousMethodKey: string | null; actions: readonly string[]; restriction: string | null };
    }) {
      const { request: r, method: m } = input;
      const attempt = decodeProviderAttempt((await db.query(
        "SELECT public.commerce_checkout_inline_retry_begin($1,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7::jsonb,$8::timestamptz) AS response",
        [`checkout-inline-recovery:${r.expectedPaymentAttemptId}:payment-execution:prepare-attempt`, r.orderId, r.clientId,
          r.paymentIntentId, r.expectedPaymentAttemptId, m.providerRequestFingerprint,
          JSON.stringify({ ...input.admission, ...m, executionRail: r.executionRail, retryRequestId: r.retryRequestId,
            requestedMethodKey: r.methodKey, resolvedMethodKey: input.admission.replayOnly ? null : methodKeyFor(m.requestPayload) }), now().toISOString()],
      )).rows[0]?.response);
      return { orderId: r.orderId, paymentIntentId: r.paymentIntentId, clientId: r.clientId, executionRail: r.executionRail,
        ...attempt, status: continuationStatus(attempt.status), failureReason: null };
    },
  };
}
