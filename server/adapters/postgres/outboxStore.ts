import {
  createPostgresOutboxTransactionLane,
  type PostgresDataGatewayEnv,
  type PostgresDataGatewayOptions,
} from "./dataGateway.js";
import type {
  OutboxEventRow,
  OutboxMarkFailedStatus,
  OutboxStore,
} from "../../domains/commerce/outboxDispatchContracts.js";

interface PostgresOutboxStoreClient {
  rpc(
    functionName: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
  query(
    text: string,
    values?: unknown[],
  ): PromiseLike<{ rows: Array<Record<string, unknown>> }>;
}

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

/** Direct-Postgres adapter over the authored, four-operation outbox rail. */
export interface PostgresOutboxStore extends OutboxStore {
  close(): Promise<void>;
}

export function createPostgresOutboxStore(
  env: PostgresDataGatewayEnv,
  options: PostgresDataGatewayOptions = {},
): PostgresOutboxStore {
  const transactions = createPostgresOutboxTransactionLane(env, options);
  const run = <T>(work: (client: PostgresOutboxStoreClient) => Promise<T>): Promise<T> =>
    transactions.run((client) => work(client as PostgresOutboxStoreClient));

  return {
    async hasPendingEventType(eventType): Promise<boolean> {
      return run(async (client) => {
        const { rows } = await client.query(
          `SELECT EXISTS (
             SELECT 1
             FROM outbox_events
             WHERE event_type = $1
               AND status IN ('pending', 'failed', 'processing')
             LIMIT 1
           ) AS present`,
          [eventType],
        );
        return rows[0]?.present === true;
      });
    },

    async claimBatch(input): Promise<OutboxEventRow[]> {
      return run(async (client) => {
        const { data, error } = await client.rpc("outbox_claim_batch", {
          p_event_types: input.eventTypes,
          p_known_event_types: input.knownEventTypes ?? input.eventTypes,
          p_batch_size: input.batchSize,
          p_visibility_seconds: input.visibilitySeconds,
          p_max_attempts: input.maxAttempts,
        });
        if (error) throw rpcFailure("outbox_claim_batch", error);
        return Array.isArray(data) ? (data as OutboxEventRow[]) : [];
      });
    },

    async markProcessed(input): Promise<{ applied: boolean }> {
      return run(async (client) => {
        const { data, error } = await client.rpc("outbox_mark_processed", {
          p_event_id: input.eventId,
          p_claim_token: input.claimToken,
          p_metadata: input.metadata ?? {},
        });
        if (error) throw rpcFailure("outbox_mark_processed", error);
        return { applied: data === true };
      });
    },

    async markFailed(input): Promise<{ status: OutboxMarkFailedStatus }> {
      return run(async (client) => {
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
      });
    },

    async releaseUnprocessed(items, delaySeconds): Promise<number> {
      if (items.length === 0) return 0;
      return run(async (client) => {
        const { data, error } = await client.rpc("outbox_release_unprocessed", {
          p_event_ids: items.map((item) => item.eventId),
          p_claim_tokens: items.map((item) => item.claimToken),
          p_delay_seconds: delaySeconds,
        });
        if (error) throw rpcFailure("outbox_release_unprocessed", error);
        return typeof data === "number" ? data : 0;
      });
    },

    close: () => transactions.close(),
  };
}
