import type { PaymentIntentStatus } from "../../../../src/domains/payment/types.js";
import type { CheckoutRecoveryPriorPaymentEvidence } from "../../../domains/commerce/checkoutRecoveryOrderPort.js";

interface QueryResult<T> {
  data: T[] | null;
  error: { message?: string } | null;
}

interface Query<T> extends PromiseLike<QueryResult<T>> {
  select(columns: string): Query<T>;
  eq(column: string, value: unknown): Query<T>;
  order(column: string, options: { ascending: boolean }): Query<T>;
  maybeSingle(): PromiseLike<{ data: T | null; error: { message?: string } | null }>;
  limit(count: number): PromiseLike<QueryResult<T>>;
}

export interface CheckoutRecoveryPaymentReadClient {
  from<T = Record<string, unknown>>(table: string): Query<T>;
}

interface IntentRow {
  id: string;
  status: string;
  subscription_cycle_id: string | null;
  active_attempt_id: string | null;
  provider_payment_id: string | null;
  updated_at: string;
}

interface AttemptRow {
  id: string;
  provider: string;
  provider_attempt_id: string | null;
  provider_session_id: string | null;
  idempotency_key: string;
  request_payload: unknown;
}

export async function readLatestCheckoutRecoveryPayment(
  client: CheckoutRecoveryPaymentReadClient,
  orderId: string,
): Promise<{
  id: string;
  status: PaymentIntentStatus;
  subscriptionCycleId: string | null;
  open: boolean;
  priorPaymentEvidence: CheckoutRecoveryPriorPaymentEvidence | null;
} | null> {
  const { data, error } = await client
    .from<IntentRow>("commerce_payment_intents")
    .select("id, status, subscription_cycle_id, active_attempt_id, provider_payment_id, updated_at")
    .eq("order_id", orderId)
    .order("updated_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`commerce_payment_intents: ${error.message ?? "query failed"}`);
  const intent = data?.[0];
  if (!intent) return null;
  const attempt = intent.active_attempt_id
    ? await readAttempt(client, intent.active_attempt_id)
    : null;
  return {
    id: intent.id,
    status: intent.status as PaymentIntentStatus,
    subscriptionCycleId: intent.subscription_cycle_id ?? null,
    open: !TERMINAL_INTENT_STATUSES.has(intent.status),
    priorPaymentEvidence: attempt
      ? {
        paymentIntentId: intent.id,
        paymentAttemptId: attempt.id,
        provider: attempt.provider,
        // Provider session is the canonical API object when present (notably
        // Tpay transactionId); merchant-facing attempt titles such as TR-* are
        // only the final legacy fallback.
        providerPaymentId:
          attempt.provider_session_id
          ?? intent.provider_payment_id
          ?? attempt.provider_attempt_id
          ?? null,
        idempotencyKey: attempt.idempotency_key,
        retryRequestId: nullableText(record(attempt.request_payload).retryRequestId),
      }
      : null,
  };
}

const TERMINAL_INTENT_STATUSES = new Set([
  "succeeded",
  "cancelled",
  "expired",
  "refunded",
  "partially_refunded",
  "disputed",
]);

async function readAttempt(
  client: CheckoutRecoveryPaymentReadClient,
  attemptId: string,
): Promise<AttemptRow | null> {
  const { data, error } = await client
    .from<AttemptRow>("commerce_payment_attempts")
    .select("id, provider, provider_attempt_id, provider_session_id, idempotency_key, request_payload")
    .eq("id", attemptId)
    .maybeSingle();
  if (error) throw new Error(`commerce_payment_attempts: ${error.message ?? "query failed"}`);
  return data;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
