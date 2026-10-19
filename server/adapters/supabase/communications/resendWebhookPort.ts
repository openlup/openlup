import type {
  ResendWebhookAttempt,
  ResendWebhookPort,
  ResendWebhookProviderEvent,
} from "../../../domains/communications/resendWebhookHandler.js";

export interface ResendWebhookSupabaseClient {
  from: (table: string) => unknown;
  rpc?: (name: string, params: Record<string, unknown>) => Promise<{ data: unknown; error?: unknown }>;
}

/** Supabase implementation of the narrow Resend webhook persistence contract. */
export function createSupabaseResendWebhookPort(client: ResendWebhookSupabaseClient): ResendWebhookPort {
  return {
    async findEmailSendByResendId(resendId) {
      const query = client.from("email_sends") as {
        select: (columns: string) => {
          eq: (column: string, value: string) => {
            maybeSingle: () => Promise<{ data: { id: string } | null; error?: unknown }>;
          };
        };
      };
      const { data, error } = await query.select("id").eq("resend_id", resendId).maybeSingle();
      if (error) throw new Error("email_send_lookup_failed");
      return data;
    },

    async applyProviderEvent(event: ResendWebhookProviderEvent) {
      if (typeof client.rpc !== "function") throw new Error("delivery_event_rpc_unavailable");
      const result = await client.rpc("communication_update_email_delivery_from_provider", {
        p_email_send_id: event.emailSendId,
        p_provider_message_id: event.resendId,
        p_provider_event_type: event.resendEventType,
        p_event_at: event.eventAt,
        p_metadata: event.metadata,
      });
      if (result.error) throw new Error("delivery_event_rpc_failed");
    },

    async recordAttempt(attempt: ResendWebhookAttempt) {
      try {
        const query = client.from("email_webhook_attempts") as {
          insert?: (payload: Record<string, unknown>) => Promise<unknown>;
        };
        if (typeof query.insert !== "function") return;
        await query.insert({
          resend_webhook_id: attempt.resendWebhookId,
          resend_event_type: attempt.resendEventType,
          resend_email_id: attempt.resendEmailId,
          outcome: attempt.outcome,
          http_status: attempt.httpStatus,
          error: attempt.error?.slice(0, 500) ?? null,
          metadata: attempt.metadata ?? null,
        });
      } catch {
        // Delivery-attempt telemetry is intentionally best effort: it cannot
        // turn a successfully converged provider event into a failed delivery.
      }
    },
  };
}
