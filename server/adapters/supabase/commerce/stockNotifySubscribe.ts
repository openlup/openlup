import type {
  StockNotifySubscribeInput,
  StockNotifySubscribePort,
} from "../../../domains/commerce/stockNotifySubscribePort.js";

// Service-role adapter for the back-in-stock notify-me BFF. Records explicit
// marketing consent (touch contact -> grant marketing_newsletter permission)
// then upserts the stock-notification subscription, linking the contact. All
// three steps run via SECURITY DEFINER RPCs (the BFF holds the service-role
// key); a consent-record failure is fatal (no consent => no subscribe), but the
// permission/subscribe ordering guarantees we never store a pending alert for an
// email that has not granted marketing consent.

interface RpcError {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}

/**
 * The narrow structural shape this adapter needs. Declaring it here keeps the
 * concrete `@supabase/supabase-js` client type out of `server/domains/**`.
 */
export interface StockNotifySubscribeSupabaseClient {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: RpcError | null }>;
}

function rpcError(label: string, error: RpcError): Error {
  const text = [error.message, error.details, error.hint].filter(Boolean).join(" ");
  return new Error(`${label}_failed: ${text || error.code || "unknown"}`);
}

export function createSupabaseStockNotifySubscribePort(
  client: StockNotifySubscribeSupabaseClient,
): StockNotifySubscribePort {
  return {
    async subscribe({ sku, email }: StockNotifySubscribeInput): Promise<void> {
      const touched = await client.rpc("communication_touch_contact", {
        p_email: email,
        p_metadata: { source: "stock_notify_bff" },
      });
      if (touched.error) throw rpcError("stock_notify_touch_contact", touched.error);
      const contactId = typeof touched.data === "string" ? touched.data : null;

      const recorded = await client.rpc("communication_record_permission_event", {
        p_contact_id: contactId,
        p_purpose: "marketing_newsletter",
        p_state: "granted",
        p_source: "stock_notify_bff",
        p_source_ref: { sku },
        p_reason: "back_in_stock_notify_me_opt_in",
      });
      if (recorded.error) throw rpcError("stock_notify_record_consent", recorded.error);

      const subscribed = await client.rpc("subscribe_product_stock_notification", {
        p_sku: sku,
        p_email: email,
        p_contact_id: contactId,
        p_metadata: { source: "stock_notify_bff" },
      });
      if (subscribed.error) throw rpcError("stock_notify_subscribe", subscribed.error);
    },
  };
}
