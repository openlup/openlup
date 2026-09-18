import type { PaymentVerifyReadPort, VerifiableAttemptSnapshot } from "../../../domains/payment/paymentVerifyNowService.js";

/**
 * Read side of the buyer-triggered payment verify-now flow: assemble the
 * intent + order + ACTIVE attempt triple the handler needs to run a provider
 * readback. Reads only — the terminal write goes through the reconciliation
 * apply RPC via the named Supabase payment-reconciliation adapter.
 */

export interface PaymentVerifySupabaseClient {
  from<T = Record<string, unknown>>(table: string): {
    select(columns: string): PaymentVerifySupabaseQuery<T>;
  };
}

interface PaymentVerifySupabaseQuery<T> {
  eq(column: string, value: unknown): PaymentVerifySupabaseQuery<T>;
  maybeSingle(): PromiseLike<{ data: T | null; error: { message?: string } | null }>;
}

interface IntentRow {
  id: string;
  order_id: string;
  status: string;
  active_attempt_id: string | null;
  provider_payment_id: string | null;
}

interface OrderRow {
  id: string;
  client_id: string;
  mode: string;
}

interface AttemptRow {
  id: string;
  payment_id: string;
  status: string;
  provider: string;
  provider_attempt_id: string | null;
  provider_session_id: string | null;
  amount_cents: number;
  currency: string;
  updated_at: string;
}

export function createSupabasePaymentVerifyNowPort(
  client: PaymentVerifySupabaseClient,
): PaymentVerifyReadPort {
  return {
    async readVerifiableAttempt(input): Promise<VerifiableAttemptSnapshot | null> {
      const { data: intent, error: intentError } = await client
        .from<IntentRow>("commerce_payment_intents")
        .select("id, order_id, status, active_attempt_id, provider_payment_id")
        .eq("id", input.paymentIntentId)
        .eq("order_id", input.orderId)
        .maybeSingle();
      if (intentError) throw new Error(`commerce_payment_intents: ${intentError.message ?? "query failed"}`);
      if (!intent || !intent.active_attempt_id) return null;

      const { data: order, error: orderError } = await client
        .from<OrderRow>("commerce_orders")
        .select("id, client_id, mode")
        .eq("id", input.orderId)
        .maybeSingle();
      if (orderError) throw new Error(`commerce_orders: ${orderError.message ?? "query failed"}`);
      if (!order) return null;

      const { data: attempt, error: attemptError } = await client
        .from<AttemptRow>("commerce_payment_attempts")
        .select("id, payment_id, status, provider, provider_attempt_id, provider_session_id, amount_cents, currency, updated_at")
        .eq("id", intent.active_attempt_id)
        .eq("payment_intent_id", intent.id)
        .maybeSingle();
      if (attemptError) throw new Error(`commerce_payment_attempts: ${attemptError.message ?? "query failed"}`);
      if (!attempt) return null;

      return {
        orderId: order.id,
        orderClientId: order.client_id,
        orderMode: order.mode,
        paymentIntentId: intent.id,
        intentStatus: intent.status,
        intentProviderPaymentId: intent.provider_payment_id,
        paymentAttemptId: attempt.id,
        paymentId: attempt.payment_id,
        attemptStatus: attempt.status,
        provider: attempt.provider,
        providerAttemptId: attempt.provider_attempt_id,
        providerSessionId: attempt.provider_session_id,
        amountMinor: attempt.amount_cents,
        currency: attempt.currency,
        localUpdatedAt: attempt.updated_at,
      };
    },
  };
}
