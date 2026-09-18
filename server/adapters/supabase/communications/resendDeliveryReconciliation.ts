import type {
  FrozenSendRow,
  ResendDeliveryReconciliationPort,
} from "../../../domains/communications/resendDeliveryReconciliationWorker.js";

type QueryResult<T> = PromiseLike<{ data: T | null; error: { message?: string } | null }>;

type OrderedEmailSendsQuery = {
  order(
    column: string,
    options?: { ascending?: boolean; nullsFirst?: boolean },
  ): OrderedEmailSendsQuery;
  limit(count: number): QueryResult<Array<Record<string, unknown>>>;
};

type SupabaseLikeClient = {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: unknown): {
        not(column: string, operator: string, value: unknown): {
          is(column: string, value: null): {
            lte(column: string, value: string): {
              order(
                column: string,
                options?: { ascending?: boolean; nullsFirst?: boolean },
              ): OrderedEmailSendsQuery;
            };
          };
        };
      };
    };
    update(patch: Record<string, unknown>): {
      eq(column: string, value: unknown): QueryResult<unknown>;
    };
  };
  rpc(name: string, args: Record<string, unknown>): QueryResult<unknown>;
};

// The RPC owns the webhook-equivalent event, send-status and timeline writes.
// Keeping that transaction boundary in the database also makes poller replays
// safe without a read-before-write event exclusion here.
export function createSupabaseResendDeliveryReconciliationPort(
  client: SupabaseLikeClient,
): ResendDeliveryReconciliationPort {
  return {
    async findFrozenSends({ now, graceMinutes, limit }) {
      const cutoff = new Date(new Date(now).getTime() - graceMinutes * 60 * 1000).toISOString();
      const { data: sends, error } = await client
        .from("email_sends")
        .select("id,resend_id,status,sent_at,poll_last_attempt_at")
        .eq("status", "sent")
        .not("resend_id", "is", null)
        // Skip sends given up as un-pollable (durable 404 abandonment marker) so
        // the doomed backlog stops re-selecting ahead of genuinely current gaps.
        .is("poll_abandoned_at", null)
        .lte("sent_at", cutoff)
        .order("poll_last_attempt_at", { ascending: true, nullsFirst: true })
        .order("sent_at", { ascending: true })
        .limit(limit);
      if (error) throw new Error(`frozen_sends_query: ${error.message ?? "unknown"}`);
      const candidates = (sends ?? []) as Array<{ id: string; resend_id: string; status: string | null }>;
      return candidates
        .map((row): FrozenSendRow => ({ id: row.id, resendId: row.resend_id, status: row.status }));
    },

    async applyPolledEvent({ sendId, resendId, webhookType, eventAt, recipientEmail }) {
      const { error: rpcError } = await client.rpc("communication_update_email_delivery_from_provider", {
        p_email_send_id: sendId,
        p_provider_message_id: resendId,
        p_provider_event_type: webhookType,
        p_event_at: eventAt,
        p_metadata: {
          providerEventId: `poll:${resendId}:${webhookType}`,
          eventMetadata: {
            source: "resend-delivery-reconciliation",
            resend_id: resendId,
            email: recipientEmail,
          },
          source: "resend-delivery-reconciliation",
        },
      });
      if (rpcError) throw new Error(`polled_delivery_rpc: ${rpcError.message ?? "unknown"}`);
    },

    async recordPollAttempt({ sendId, attemptedAt }) {
      const { error } = await client
        .from("email_sends")
        .update({ poll_last_attempt_at: attemptedAt, poll_not_found_count: 0 })
        .eq("id", sendId);
      if (error) throw new Error(`poll_attempt_update: ${error.message ?? "unknown"}`);
    },

    async recordSendNotFound({ sendId, threshold }) {
      const { data, error } = await client.rpc("communication_record_email_poll_not_found", {
        p_send_id: sendId,
        p_threshold: threshold,
      });
      if (error) throw new Error(`poll_not_found_rpc: ${error.message ?? "unknown"}`);
      return { abandoned: data === true };
    },
  };
}
