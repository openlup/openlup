import type {
  PaymentStatusReadPort,
  PaymentStatusSnapshot,
} from "../../../domains/commerce/commercePaymentStatusHandler.js";
import { deriveSubscriptionActivationStatus } from "../../../../src/domains/payment/contracts.js";

export interface PaymentStatusSupabaseClient {
  from<T = Record<string, unknown>>(table: string): {
    select(columns: string): PaymentStatusSupabaseQuery<T>;
  };
}

interface PaymentStatusSupabaseQuery<T> {
  eq(column: string, value: unknown): PaymentStatusSupabaseQuery<T>;
  maybeSingle(): PromiseLike<{ data: T | null; error: RpcError | null }>;
}

interface RpcError {
  message?: string;
}

interface IntentRow {
  id: string;
  order_id: string;
  status: string;
  active_attempt_id: string | null;
  provider_payment_id: string | null;
  updated_at: string;
  failure_reason: string | null;
}

interface AttemptRow {
  id: string;
  payment_intent_id: string;
  status: string;
  provider: string;
  provider_attempt_id: string | null;
  provider_session_id: string | null;
  failure_reason: string | null;
}

interface OrderRow {
  id: string;
  client_id: string;
  status: string;
  mode: string;
  subscription_id: string | null;
}

interface SubscriptionRow { id: string; status: string }
interface PaidActivationGapRow { payment_intent_id: string; paid_at: string }

export function createSupabasePaymentStatusPort(
  client: PaymentStatusSupabaseClient,
): PaymentStatusReadPort {
  return {
    async getPaymentStatus(input): Promise<PaymentStatusSnapshot | null> {
      const { data: intent, error: intentError } = await client
        .from<IntentRow>("commerce_payment_intents")
        .select("id, order_id, status, active_attempt_id, provider_payment_id, updated_at, failure_reason")
        .eq("id", input.paymentIntentId)
        .eq("order_id", input.orderId)
        .maybeSingle();
      if (intentError) throw new Error(`commerce_payment_intents: ${intentError.message ?? "query failed"}`);
      if (!intent) return null;

      const { data: order, error: orderError } = await client
        .from<OrderRow>("commerce_orders")
        .select("id, client_id, status, mode, subscription_id")
        .eq("id", input.orderId)
        .maybeSingle();
      if (orderError) throw new Error(`commerce_orders: ${orderError.message ?? "query failed"}`);
      if (!order) return null;

      const [attempt, subscription, paidActivationGap] = await Promise.all([
        intent.active_attempt_id ? readAttempt(client, intent.active_attempt_id, intent.id) : null,
        order.subscription_id ? readSubscription(client, order.subscription_id) : null,
        order.subscription_id ? readPaidActivationGap(client, intent.id) : null,
      ]);

      return {
        orderId: order.id,
        orderStatus: order.status,
        clientId: order.client_id,
        paymentIntentId: intent.id,
        intentStatus: intent.status as PaymentStatusSnapshot["intentStatus"],
        paymentAttemptId: attempt?.id ?? null,
        attemptStatus: (attempt?.status as PaymentStatusSnapshot["attemptStatus"]) ?? null,
        provider: attempt?.provider ?? null,
        // An active pointer excludes the legacy aggregate fallback: it can still
        // carry an earlier attempt's identity while the current call is prepared.
        providerPaymentId: intent.active_attempt_id
          ? nonEmptyId(attempt?.provider_attempt_id) ?? nonEmptyId(attempt?.provider_session_id)
          : nonEmptyId(intent.provider_payment_id),
        updatedAt: intent.updated_at,
        // Attempt first: the intent's reason is the older, coarser one.
        failureReason: attempt?.failure_reason ?? intent.failure_reason ?? null,
        subscriptionId: order.subscription_id,
        subscriptionActivationStatus: deriveSubscriptionActivationStatus({
          orderMode: order.mode,
          orderStatus: order.status,
          intentStatus: intent.status,
          subscriptionStatus: subscription?.status ?? null,
          paidAt: paidActivationGap?.paid_at ?? null,
          hasExactGap: Boolean(paidActivationGap),
        }),
      };
    },
  };
}

async function readPaidActivationGap(
  client: PaymentStatusSupabaseClient,
  paymentIntentId: string,
): Promise<PaidActivationGapRow | null> {
  const { data, error } = await client
    .from<PaidActivationGapRow>("subscription_paid_activation_gaps")
    .select("payment_intent_id,paid_at")
    .eq("payment_intent_id", paymentIntentId)
    .maybeSingle();
  if (error) throw new Error(`subscription_paid_activation_gaps: ${error.message ?? "query failed"}`);
  return data;
}

async function readSubscription(
  client: PaymentStatusSupabaseClient,
  subscriptionId: string,
): Promise<SubscriptionRow | null> {
  const { data, error } = await client
    .from<SubscriptionRow>("subscriptions")
    .select("id,status")
    .eq("id", subscriptionId)
    .maybeSingle();
  if (error) throw new Error(`subscriptions: ${error.message ?? "query failed"}`);
  return data;
}

async function readAttempt(
  client: PaymentStatusSupabaseClient,
  attemptId: string,
  paymentIntentId: string,
): Promise<AttemptRow | null> {
  const { data, error } = await client
    .from<AttemptRow>("commerce_payment_attempts")
    .select("id, payment_intent_id, status, provider, provider_attempt_id, provider_session_id, failure_reason")
    .eq("id", attemptId)
    .eq("payment_intent_id", paymentIntentId)
    .maybeSingle();
  if (error) throw new Error(`commerce_payment_attempts: ${error.message ?? "query failed"}`);
  return data?.id === attemptId && data.payment_intent_id === paymentIntentId ? data : null;
}

function nonEmptyId(value: string | null | undefined): string | null {
  return value?.trim() || null;
}
