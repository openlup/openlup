import type { SubscriptionQueryExecutor } from "./postgresRenewalStore.js";

export interface PostgresNativeCheckoutSubscriptionPort {
  declareProvisionalActivation(input: {
    idempotencyKey: string;
    orderId: string;
    cadenceDays: number;
    now: string;
  }): Promise<void>;
  readActivationCadenceDays(orderId: string): Promise<number | null>;
  clientHasLiveOrPendingSubscription(clientId: string): Promise<boolean>;
  readTemplateVersion(input: { subscriptionId: string; clientId: string }): Promise<number | null>;
  readCommandReceiptExpectedVersion(input: { actorId: string; idempotencyKey: string }): Promise<number | null>;
}

/**
 * Additive PostgreSQL host port for initial subscription activation and
 * customer-owned subscription reads during native checkout and recovery.
 */
export function createPostgresNativeCheckoutSubscriptionPort(
  executor: SubscriptionQueryExecutor,
): PostgresNativeCheckoutSubscriptionPort {
  return {
    async declareProvisionalActivation(input) {
      await executor.query(
        "SELECT public.subscription_declare_provisional_activation($1,$2::uuid,$3::integer,$4::timestamptz)",
        [input.idempotencyKey, input.orderId, input.cadenceDays, input.now],
      );
    },
    async readActivationCadenceDays(orderId) {
      const row = (await executor.query(
        "SELECT cadence_days FROM public.subscription_activations WHERE order_id=$1",
        [orderId],
      )).rows[0];
      if (!row || row.cadence_days == null) return null;
      return Number(row.cadence_days);
    },
    async clientHasLiveOrPendingSubscription(clientId) {
      const result = await executor.query(
        "SELECT 1 FROM public.subscriptions WHERE client_id=$1 AND status IN ('active','paused','pending_activation') LIMIT 1",
        [clientId],
      );
      return result.rows.length > 0;
    },
    async readTemplateVersion(input) {
      const row = (await executor.query(
        "SELECT template_version FROM public.subscriptions WHERE id=$1 AND client_id=$2",
        [input.subscriptionId, input.clientId],
      )).rows[0];
      if (!row || row.template_version == null) return null;
      return Number(row.template_version);
    },
    async readCommandReceiptExpectedVersion(input) {
      const row = (await executor.query(
        "SELECT command->>'expectedVersion' AS version FROM public.subscription_command_receipts WHERE actor_id=$1 AND idempotency_key=$2",
        [input.actorId, input.idempotencyKey],
      )).rows[0];
      if (!row || row.version == null) return null;
      return Number(row.version);
    },
  };
}
