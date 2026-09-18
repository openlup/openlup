import type { CheckoutRecoveryMode } from "../../../../src/domains/commerce/checkoutRecoveryContracts.js";
import {
  type CheckoutRecoveryOwnedOrderContext,
  type CheckoutRecoveryPendingOrder,
  type CheckoutRecoveryStartReadPort,
} from "../../../domains/commerce/checkoutRecoveryStartPort.js";
import { RECOVERY_CONTEXT_SUBSCRIPTION_STATUSES } from "../../../domains/commerce/checkoutRecoverySubscriptionContextPort.js";

/**
 * Resolves the logged-in customer's own recoverable order for a subscription
 * (W5). Ownership is enforced two ways: the client id is resolved through the
 * RLS-scoped customer client (`clients.auth_user_id = userId`), and the order
 * lookup then filters on that client id explicitly — a customer can only ever
 * mint a recovery token for an order they own.
 *
 * Mirrors the readLinkedClient pattern in supabaseCustomerSelfServicePort: the
 * customer (anon+JWT) client resolves identity under RLS; the service client
 * does the data read with an explicit client_id filter.
 */

interface QueryError {
  message?: string;
}

interface RecoveryQuery<T> {
  select(columns: string): RecoveryQuery<T>;
  eq(column: string, value: unknown): RecoveryQuery<T>;
  in(column: string, values: readonly unknown[]): RecoveryQuery<T>;
  order(column: string, options: { ascending: boolean }): RecoveryQuery<T>;
  maybeSingle(): PromiseLike<{ data: T | null; error: QueryError | null }>;
  limit(count: number): PromiseLike<{ data: T[] | null; error: QueryError | null }>;
}

export interface CheckoutRecoveryStartSupabaseClient {
  from<T = Record<string, unknown>>(table: string): RecoveryQuery<T>;
}

type Row = Record<string, unknown>;

export function createSupabaseCheckoutRecoveryStartPort(deps: {
  /** RLS-scoped (anon + customer JWT) client — resolves the owning client id. */
  customerClient: CheckoutRecoveryStartSupabaseClient;
  /** Service-role client — reads the order with an explicit client_id filter. */
  serviceClient: CheckoutRecoveryStartSupabaseClient;
}): CheckoutRecoveryStartReadPort {
  const { customerClient, serviceClient } = deps;

  async function resolveClientId(userId: string): Promise<string | null> {
    const { data: client, error: clientError } = await customerClient
      .from<Row>("clients")
      .select("id")
      .eq("auth_user_id", userId)
      .maybeSingle();
    if (clientError) throw new Error(`clients: ${clientError.message ?? "query failed"}`);
    return client && typeof client.id === "string" ? client.id : null;
  }

  // Default mode for the subscription-panel CTA is a first cycle; the orders-list
  // CTA (one-time / first cycle) defaults to one_time. Row mode stays authoritative.
  async function clientHasLiveOrPendingSubscription(clientId: string): Promise<boolean> {
    const { data, error } = await serviceClient
      .from<Row>("subscriptions")
      .select("id")
      .eq("client_id", clientId)
      .in("status", RECOVERY_CONTEXT_SUBSCRIPTION_STATUSES)
      .limit(1);
    if (error) throw new Error(`subscriptions: ${error.message ?? "query failed"}`);
    return Boolean(data?.[0]?.id);
  }

  function toPendingOrder(
    order: Row,
    fallbackMode: CheckoutRecoveryMode,
    hasLiveOrPendingSubscription: boolean,
  ): CheckoutRecoveryPendingOrder | null {
    const orderId = typeof order.id === "string" ? order.id : null;
    const createdAt = typeof order.created_at === "string" ? order.created_at : null;
    if (!orderId || !createdAt) return null;
    const mode = readMode(order, fallbackMode);
    return {
      orderId,
      createdAt,
      mode,
      subscriptionId: nullableText(order.subscription_id),
      clientHasLiveOrPendingSubscription: hasLiveOrPendingSubscription,
    };
  }

  function toOwnedOrderContext(
    order: Row,
    fallbackMode: CheckoutRecoveryMode,
    hasLiveOrPendingSubscription: boolean,
  ): CheckoutRecoveryOwnedOrderContext | null {
    const orderId = typeof order.id === "string" ? order.id : null;
    if (!orderId) return null;
    return {
      orderId,
      mode: readMode(order, fallbackMode),
      subscriptionId: nullableText(order.subscription_id),
      clientHasLiveOrPendingSubscription: hasLiveOrPendingSubscription,
    };
  }

  function readMode(order: Row, fallbackMode: CheckoutRecoveryMode): CheckoutRecoveryMode {
    return (
      order.mode === "one_time_order"
        ? "one_time_order"
        : order.mode === "subscription_cycle"
          ? "subscription_cycle"
          : fallbackMode
    );
  }

  return {
    async findRecoverableOrder({ userId, subscriptionId }): Promise<CheckoutRecoveryPendingOrder | null> {
      const clientId = await resolveClientId(userId);
      if (!clientId) return null;
      const hasLiveOrPendingSubscription = true;

      const { data, error } = await serviceClient
        .from<Row>("commerce_orders")
        .select("id, created_at, mode, status, subscription_id")
        .eq("subscription_id", subscriptionId)
        .eq("client_id", clientId)
        .eq("status", "pending_payment")
        .order("created_at", { ascending: false })
        .limit(1);
      if (error) throw new Error(`commerce_orders: ${error.message ?? "query failed"}`);
      const order = data?.[0];
      if (!order) return null;
      return toPendingOrder(order, "subscription_cycle", hasLiveOrPendingSubscription);
    },

    async findRecoverableOrderById({ userId, orderId }): Promise<CheckoutRecoveryPendingOrder | null> {
      const clientId = await resolveClientId(userId);
      if (!clientId) return null;
      const hasLiveOrPendingSubscription = await clientHasLiveOrPendingSubscription(clientId);

      const { data, error } = await serviceClient
        .from<Row>("commerce_orders")
        .select("id, created_at, mode, status, subscription_id")
        .eq("id", orderId)
        .eq("client_id", clientId)
        .eq("status", "pending_payment")
        .order("created_at", { ascending: false })
        .limit(1);
      if (error) throw new Error(`commerce_orders: ${error.message ?? "query failed"}`);
      const order = data?.[0];
      if (!order) return null;
      return toPendingOrder(order, "one_time_order", hasLiveOrPendingSubscription);
    },

    async findOwnedOrderContextById({ userId, orderId }): Promise<CheckoutRecoveryOwnedOrderContext | null> {
      const clientId = await resolveClientId(userId);
      if (!clientId) return null;
      const hasLiveOrPendingSubscription = await clientHasLiveOrPendingSubscription(clientId);

      const { data, error } = await serviceClient
        .from<Row>("commerce_orders")
        .select("id, mode, subscription_id")
        .eq("id", orderId)
        .eq("client_id", clientId)
        .order("created_at", { ascending: false })
        .limit(1);
      if (error) throw new Error(`commerce_orders: ${error.message ?? "query failed"}`);
      const order = data?.[0];
      if (!order) return null;
      return toOwnedOrderContext(order, "one_time_order", hasLiveOrPendingSubscription);
    },

    async clientHasLiveOrPendingSubscription({ userId }): Promise<boolean> {
      const clientId = await resolveClientId(userId);
      return clientId ? clientHasLiveOrPendingSubscription(clientId) : false;
    },
  };
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
