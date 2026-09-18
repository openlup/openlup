import {
  ExpiredCheckoutRecoveryConflictError,
  type AbandonedCartReminderEnqueuePort,
  type AbandonedCartReminderEnqueueResult,
  type CheckoutRecoveryReminderEnqueuePort,
  type CheckoutRecoveryReminderEnqueueResult,
  type ExpiredCheckoutRecoveryWritePort,
  type OutboxPrunePort,
  type OutboxPruneResult,
} from "../../domains/commerce/checkoutRecoveryOperations.js";

interface RpcError {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}

export interface ExpiredCheckoutRecoveryRpcClient {
  rpc(
    name: "commerce_prepare_expired_checkout_recovery",
    args: {
      p_idempotency_key: string;
      p_source_order_id: string;
      p_replacement_order_id: string;
    },
  ): PromiseLike<{ data: unknown; error: RpcError | null }>;
}

export function createSupabaseExpiredCheckoutRecoveryPort(
  client: ExpiredCheckoutRecoveryRpcClient,
): ExpiredCheckoutRecoveryWritePort {
  return {
    async prepareReplacement(input) {
      const { data, error } = await client.rpc("commerce_prepare_expired_checkout_recovery", {
        p_idempotency_key: input.idempotencyKey,
        p_source_order_id: input.sourceOrderId,
        p_replacement_order_id: input.replacementOrderId,
      });
      if (error) throw mapError(error);
      const row = record(data);
      const replacementOrderId = text(row.replacementOrderId);
      if (!replacementOrderId) throw new Error("expired_checkout_recovery_invalid_response");
      return { replacementOrderId, replayed: row.replayed === true };
    },
  };
}

function mapError(error: RpcError): Error {
  const searchable = [error.message, error.details, error.hint].filter(Boolean).join(" ");
  const match = searchable.match(/commerce_expired_recovery_([a-z0-9_]+)/);
  return match
    ? new ExpiredCheckoutRecoveryConflictError(match[1])
    : new Error("expired_checkout_recovery_rpc_failed");
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

type RpcClient = {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message?: string } | null }>;
};

export function createSupabaseAbandonedCartReminderEnqueuePort(
  client: RpcClient,
): AbandonedCartReminderEnqueuePort {
  return {
    async enqueue(limit: number, runtimeBaseUrl: string): Promise<AbandonedCartReminderEnqueueResult> {
      const { data, error } = await client.rpc("enqueue_abandoned_cart_reminders_from_vercel", {
        p_limit: limit,
        p_runtime_supabase_url: runtimeBaseUrl,
      });
      if (error) throw new Error(error.message ?? "enqueue_abandoned_cart_reminders_from_vercel_failed");
      return readAbandonedCartReminderEnqueueResult(data);
    },
  };
}

function readAbandonedCartReminderEnqueueResult(data: unknown): AbandonedCartReminderEnqueueResult {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    const skipped = typeof record.skipped === "string" ? record.skipped : undefined;
    return {
      enqueued1h: typeof record.enqueued_1h === "number" ? record.enqueued_1h : 0,
      enqueued24h: typeof record.enqueued_24h === "number" ? record.enqueued_24h : 0,
      enqueued72h: typeof record.enqueued_72h === "number" ? record.enqueued_72h : 0,
      ...(skipped ? { skipped } : {}),
    };
  }
  return { enqueued1h: 0, enqueued24h: 0, enqueued72h: 0 };
}

export function createSupabaseCheckoutRecoveryReminderEnqueuePort(
  client: RpcClient,
): CheckoutRecoveryReminderEnqueuePort {
  return {
    async enqueue(limit: number): Promise<CheckoutRecoveryReminderEnqueueResult> {
      const { data, error } = await client.rpc("enqueue_checkout_recovery_reminders", { p_limit: limit });
      if (error) throw new Error(error.message ?? "enqueue_checkout_recovery_reminders_failed");
      return readCheckoutRecoveryReminderEnqueueResult(data);
    },
  };
}

function readCheckoutRecoveryReminderEnqueueResult(data: unknown): CheckoutRecoveryReminderEnqueueResult {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    return {
      enqueued1h: numberValue(record.enqueued_1h),
      enqueued20h: numberValue(record.enqueued_20h),
    };
  }
  return { enqueued1h: 0, enqueued20h: 0 };
}

export type EmailDeliveriesPruneResult = {
  staleDeleted: number;
  orphanDeleted: number;
};

export type EmailDeliveriesPruneOutcome =
  | { ok: true; result: EmailDeliveriesPruneResult }
  | { ok: false; message: string };

export function createSupabaseOutboxPrunePort(client: RpcClient) {
  return {
    async pruneOutbox(limit: number): Promise<OutboxPruneResult> {
      const { data, error } = await client.rpc("outbox_prune", { p_limit: limit });
      if (error) throw new Error(error.message ?? "outbox_prune_failed");
      return readPruneResult(data);
    },
    async pruneDeliveries(limit: number): Promise<EmailDeliveriesPruneOutcome> {
      const { data, error } = await client.rpc("communication_email_deliveries_prune", { p_limit: limit });
      if (error) return { ok: false, message: error.message ?? "unknown" };
      return { ok: true, result: readDeliveriesPruneResult(data) };
    },
  } satisfies OutboxPrunePort & {
    pruneDeliveries(limit: number): Promise<EmailDeliveriesPruneOutcome>;
  };
}

function readPruneResult(data: unknown): OutboxPruneResult {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { compacted: 0, processed: 0, discarded: 0 };
  }
  const row = data as Record<string, unknown>;
  return {
    compacted: numberValue(row.compacted),
    processed: numberValue(row.processed),
    discarded: numberValue(row.discarded),
  };
}

function readDeliveriesPruneResult(data: unknown): EmailDeliveriesPruneResult {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { staleDeleted: 0, orphanDeleted: 0 };
  }
  const row = data as Record<string, unknown>;
  return {
    staleDeleted: numberValue(row.stale_deleted),
    orphanDeleted: numberValue(row.orphan_deleted),
  };
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
