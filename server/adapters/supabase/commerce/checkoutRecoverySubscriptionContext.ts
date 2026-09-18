import {
  RECOVERY_CONTEXT_SUBSCRIPTION_STATUSES,
  type CheckoutRecoverySubscriptionContextPort,
} from "../../../domains/commerce/checkoutRecoverySubscriptionContextPort.js";

interface QueryError {
  message?: string;
}

interface SubscriptionContextQuery<T> {
  select(columns: string): SubscriptionContextQuery<T>;
  eq(column: string, value: unknown): SubscriptionContextQuery<T>;
  in(column: string, values: readonly unknown[]): SubscriptionContextQuery<T>;
  limit(count: number): PromiseLike<{ data: T[] | null; error: QueryError | null }>;
}

export interface CheckoutRecoverySubscriptionContextSupabaseClient {
  from<T = Record<string, unknown>>(table: string): SubscriptionContextQuery<T>;
}

type Row = Record<string, unknown>;

export function createSupabaseCheckoutRecoverySubscriptionContextPort(
  client: CheckoutRecoverySubscriptionContextSupabaseClient,
): CheckoutRecoverySubscriptionContextPort {
  return {
    async clientHasLiveOrPendingSubscription({ clientId }): Promise<boolean> {
      if (!clientId) return false;
      const { data, error } = await client
        .from<Row>("subscriptions")
        .select("id")
        .eq("client_id", clientId)
        .in("status", RECOVERY_CONTEXT_SUBSCRIPTION_STATUSES)
        .limit(1);
      if (error) throw new Error(`subscriptions: ${error.message ?? "query failed"}`);
      return Boolean(data?.[0]?.id);
    },
  };
}
