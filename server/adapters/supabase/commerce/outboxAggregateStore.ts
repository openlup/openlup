import type {
  OutboxEventRow,
  OutboxMarkFailedStatus,
  OutboxStore,
} from "../../../domains/commerce/outboxDispatchContracts.js";

export interface OutboxAggregateStoreSupabaseClient {
  rpc(
    functionName: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
}

const CLAIM_AGGREGATE_BATCH_RPC = "outbox_claim_aggregate_batch";

const MARK_FAILED_STATUSES: readonly OutboxMarkFailedStatus[] = [
  "failed",
  "discarded",
  "snoozed",
  "missed",
];

function rpcFailure(rpcName: string, error: { code?: string; message?: string }): Error {
  return new Error(`${rpcName}_failed: ${error.message ?? error.code ?? "unknown"}`);
}

export function createSupabaseOutboxAggregateStorePort(
  client: OutboxAggregateStoreSupabaseClient,
  scope: { aggregateType: string; aggregateId: string },
): OutboxStore {
  return {
    async claimBatch(input): Promise<OutboxEventRow[]> {
      const { data, error } = await client.rpc(CLAIM_AGGREGATE_BATCH_RPC, {
        p_aggregate_type: scope.aggregateType,
        p_aggregate_id: scope.aggregateId,
        p_event_types: input.eventTypes,
        p_batch_size: input.batchSize,
        p_visibility_seconds: input.visibilitySeconds,
        p_max_attempts: input.maxAttempts,
      });
      if (error) throw rpcFailure(CLAIM_AGGREGATE_BATCH_RPC, error);
      return Array.isArray(data) ? (data as OutboxEventRow[]) : [];
    },

    async markProcessed(input): Promise<{ applied: boolean }> {
      const { data, error } = await client.rpc("outbox_mark_processed", {
        p_event_id: input.eventId,
        p_claim_token: input.claimToken,
        p_metadata: input.metadata ?? {},
      });
      if (error) throw rpcFailure("outbox_mark_processed", error);
      return { applied: data === true };
    },

    async markFailed(input): Promise<{ status: OutboxMarkFailedStatus }> {
      const { data, error } = await client.rpc("outbox_mark_failed", {
        p_event_id: input.eventId,
        p_claim_token: input.claimToken,
        p_error: input.error,
        p_outcome: input.outcome,
        p_base_delay_seconds: input.baseDelaySeconds,
        p_max_delay_seconds: input.maxDelaySeconds,
        p_max_attempts: input.maxAttempts,
        p_snooze_seconds: input.snoozeSeconds,
      });
      if (error) throw rpcFailure("outbox_mark_failed", error);
      const status = data as OutboxMarkFailedStatus;
      if (!MARK_FAILED_STATUSES.includes(status)) {
        throw new Error(`outbox_mark_failed_unexpected_status: ${String(data)}`);
      }
      return { status };
    },

    async releaseUnprocessed(items, delaySeconds): Promise<number> {
      if (items.length === 0) return 0;
      const { data, error } = await client.rpc("outbox_release_unprocessed", {
        p_event_ids: items.map((item) => item.eventId),
        p_claim_tokens: items.map((item) => item.claimToken),
        p_delay_seconds: delaySeconds,
      });
      if (error) throw rpcFailure("outbox_release_unprocessed", error);
      return typeof data === "number" ? data : 0;
    },
  };
}
