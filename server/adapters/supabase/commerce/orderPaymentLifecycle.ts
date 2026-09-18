import type {
  OrderPaymentLifecyclePort,
  OrderPaymentLifecycleState,
} from "../../../domains/commerce/outboxOrderDraftEmailPorts.js";

interface QueryResult {
  data: unknown;
  error: { code?: string; message?: string } | null;
}

interface OrderPaymentLifecycleQueryBuilder extends PromiseLike<QueryResult> {
  select(columns: string): OrderPaymentLifecycleQueryBuilder;
  eq(column: string, value: unknown): OrderPaymentLifecycleQueryBuilder;
  order(column: string, options?: { ascending?: boolean }): OrderPaymentLifecycleQueryBuilder;
  limit(count: number): OrderPaymentLifecycleQueryBuilder;
  maybeSingle(): PromiseLike<QueryResult>;
}

export interface OrderPaymentLifecycleSupabaseClient {
  from(table: string): OrderPaymentLifecycleQueryBuilder;
}

export function createSupabaseOrderPaymentLifecyclePort(
  client: OrderPaymentLifecycleSupabaseClient,
): OrderPaymentLifecyclePort {
  return {
    async read(orderUuid: string, _signal: AbortSignal): Promise<OrderPaymentLifecycleState | null> {
      const orderResult = await client
        .from("commerce_orders")
        .select("status, metadata")
        .eq("id", orderUuid)
        .maybeSingle();
      if (orderResult.error) {
        throw new Error(
          `order_payment_lifecycle_order_read_failed: ${orderResult.error.message ?? orderResult.error.code ?? "unknown"}`,
        );
      }
      const order = orderResult.data as
        { status?: string | null; metadata?: Record<string, unknown> | null } | null;
      if (!order || typeof order.status !== "string" || order.status === "") return null;

      const paymentResult = await client
        .from("commerce_payments")
        .select("status, updated_at")
        .eq("order_id", orderUuid)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (paymentResult.error) {
        throw new Error(
          `order_payment_lifecycle_payment_read_failed: ${paymentResult.error.message ?? paymentResult.error.code ?? "unknown"}`,
        );
      }
      const payment = paymentResult.data as { status?: string | null; updated_at?: string | null } | null;
      const paymentStatus = typeof payment?.status === "string" && payment.status !== "" ? payment.status : null;
      return {
        orderStatus: order.status,
        paymentStatus,
        paymentUpdatedAt: typeof payment?.updated_at === "string" ? payment.updated_at : null,
        hasPayment: payment !== null,
        // The sweep stamps this before it cancels; it is the only thing that
        // separates an abandoned first subscription from any other cancellation.
        subscriptionActivationAbandoned: order.metadata?.subscriptionActivation === "abandoned",
      };
    },
  };
}
