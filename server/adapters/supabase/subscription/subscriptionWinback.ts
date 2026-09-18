import type {
  DueWinbackSubscription,
  SubscriptionWinbackPort,
} from "../../../domains/subscription/subscriberRetention.js";

interface RpcCapableClient {
  rpc<T = unknown>(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: T | null; error: { message?: string } | null }>;
  from(table: string): {
    insert(row: Record<string, unknown>): PromiseLike<{ error: { code?: string; message?: string } | null }>;
  };
}

interface WinbackRow {
  subscription_id: unknown;
  client_id: unknown;
  ended_at: unknown;
  pet_id: unknown;
}

const WINBACK_EVENT_TYPE = "subscription.winback.email_sent";
const UNIQUE_VIOLATION = "23505";

export function createSupabaseSubscriptionWinbackPort(client: RpcCapableClient): SubscriptionWinbackPort {
  return {
    async listDueForWinback(limit): Promise<DueWinbackSubscription[]> {
      const { data, error } = await client.rpc<WinbackRow[]>("subscription_list_due_for_winback", {
        p_limit: limit,
      });
      if (error) {
        throw new Error(error.message ?? "subscription_list_due_for_winback failed");
      }
      const rows = Array.isArray(data) ? data : [];
      return rows.map(mapWinbackRow).filter((row): row is DueWinbackSubscription => row !== null);
    },

    async recordMessageAccepted(subscriptionId, endedAt): Promise<"recorded" | "deduped"> {
      const cancellationKey = endedAt ?? "unknown-ended-at";
      const insert = await client.from("subscription_events").insert({
        subscription_id: subscriptionId,
        event_type: WINBACK_EVENT_TYPE,
        idempotency_key: `winback:${subscriptionId}:${cancellationKey}`,
        payload: { channel: "email", source: "subscription-winback", endedAt },
      });
      if (insert.error) {
        if (insert.error.code === UNIQUE_VIOLATION) {
          return "deduped";
        }
        throw new Error(insert.error.message ?? "subscription_winback_event_insert_failed");
      }
      return "recorded";
    },
  };
}

function mapWinbackRow(row: WinbackRow): DueWinbackSubscription | null {
  if (typeof row.subscription_id !== "string" || typeof row.client_id !== "string") {
    return null;
  }
  return {
    subscriptionId: row.subscription_id,
    clientId: row.client_id,
    endedAt: typeof row.ended_at === "string" ? row.ended_at : null,
    subjectReference: typeof row.pet_id === "string" ? row.pet_id : null,
  };
}
