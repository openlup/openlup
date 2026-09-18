import type {
  OutboxEventRow,
  OutboxMarkFailedStatus,
  OutboxQueueDiagnostics,
  OutboxStore,
} from "../../domains/commerce/outboxDispatchContracts.js";

export interface ManagedOutboxStoreClient {
  rpc(
    functionName: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
  from(table: "outbox_events"): {
    select(columns: "id"): {
      eq(column: "event_type", value: string): {
        in(column: "status", values: readonly string[]): {
          limit(count: 1): PromiseLike<{
            data: Array<{ id: string }> | null;
            error: { code?: string; message?: string } | null;
          }>;
        };
      };
    };
  };
}

export interface ManagedOutboxStoreOptions {
  /** Managed preview-matrix correlation; never crosses the neutral store contract. */
  previewRunId?: string;
}

const CLAIM_BATCH_RPC = "outbox_claim_batch_v3";
const CLAIM_PREVIEW_MATRIX_BATCH_RPC = "outbox_claim_preview_matrix_batch";

const MARK_FAILED_STATUSES: readonly OutboxMarkFailedStatus[] = [
  "failed",
  "discarded",
  "snoozed",
  "missed",
];

function rpcFailure(rpcName: string, error: { code?: string; message?: string }): Error & { code?: string } {
  const failure = new Error(`${rpcName}_failed: ${error.message ?? error.code ?? "unknown"}`) as Error & { code?: string };
  failure.code = error.code;
  return failure;
}

/** Managed adapter for the neutral claim/ack/retry/release action. */
export function createManagedOutboxStore(
  client: ManagedOutboxStoreClient,
  options: ManagedOutboxStoreOptions = {},
): OutboxStore {
  return {
    async hasPendingEventType(eventType): Promise<boolean> {
      const { data, error } = await client
        .from("outbox_events")
        .select("id")
        .eq("event_type", eventType)
        .in("status", ["pending", "failed", "processing"])
        .limit(1);
      if (error) throw new Error(`outbox_pending_event_probe_failed: ${error.message ?? error.code ?? "unknown"}`);
      return Array.isArray(data) && data.length > 0;
    },

    async claimBatch(input): Promise<OutboxEventRow[]> {
      const rpcName = options.previewRunId ? CLAIM_PREVIEW_MATRIX_BATCH_RPC : CLAIM_BATCH_RPC;
      const args = options.previewRunId
        ? {
            p_run_id: options.previewRunId,
            p_event_types: input.eventTypes,
            p_batch_size: input.batchSize,
            p_visibility_seconds: input.visibilitySeconds,
            p_max_attempts: input.maxAttempts,
          }
        : {
            p_event_types: input.eventTypes,
            p_known_event_types: input.knownEventTypes ?? input.eventTypes,
            p_batch_size: input.batchSize,
            p_visibility_seconds: input.visibilitySeconds,
            p_max_attempts: input.maxAttempts,
          };
      const { data, error } = await client.rpc(rpcName, args);
      if (error) throw rpcFailure(rpcName, error);
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

/** Managed-only best-effort queue observation; the portable store intentionally omits it. */
export function createManagedOutboxQueueDiagnostics(
  client: ManagedOutboxStoreClient,
): OutboxQueueDiagnostics {
  return {
    async queueStats(): Promise<Record<string, unknown>> {
      const { data, error } = await client.rpc("outbox_queue_stats", {});
      if (error) throw rpcFailure("outbox_queue_stats", error);
      return data && typeof data === "object" && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : {};
    },
  };
}
