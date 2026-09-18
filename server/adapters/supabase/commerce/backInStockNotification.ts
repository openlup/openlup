import type { BackInStockNotificationPort } from "../../../domains/commerce/outboxBackInStockEmailHandler.js";

type RpcResult = { data: unknown; error: { message?: string } | null };
type RpcRequest = PromiseLike<RpcResult> & {
  abortSignal?: (signal: AbortSignal) => PromiseLike<RpcResult>;
};

interface RpcCapableClient {
  rpc(name: string, args: Record<string, unknown>): RpcRequest;
}

export function createSupabaseBackInStockNotificationPort(client: RpcCapableClient): BackInStockNotificationPort {
  return {
    async markNotified(input) {
      const request = client.rpc("mark_back_in_stock_notification_notified", {
        p_outbox_event_id: input.outboxEventId,
        p_notification_id: input.notificationId,
        p_consent_decision_id: input.consentDecisionId,
      });
      const { data, error } = await resolveRpcRequest(request, input.signal);
      if (error) {
        throw new Error(`mark_back_in_stock_notification_notified_failed: ${error.message ?? "unknown"}`);
      }
      return data === true;
    },

    async closeSuppressed(input) {
      const request = client.rpc("close_back_in_stock_notification", {
        p_outbox_event_id: input.outboxEventId,
        p_notification_id: input.notificationId,
        p_consent_decision_id: input.consentDecisionId,
        p_closed_reason: "consent_blocked",
        p_detail: input.reason,
      });
      const { data, error } = await resolveRpcRequest(request, input.signal);
      if (error) {
        throw new Error(`close_back_in_stock_notification_failed: ${error.message ?? "unknown"}`);
      }
      return data === true;
    },
  };
}

function resolveRpcRequest(request: RpcRequest, signal: AbortSignal): PromiseLike<RpcResult> {
  return typeof request.abortSignal === "function" ? request.abortSignal(signal) : request;
}
