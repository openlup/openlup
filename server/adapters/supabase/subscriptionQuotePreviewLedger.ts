import type { SupabaseClient } from "@supabase/supabase-js";

interface RecordSubscriptionQuotePreviewInput {
  userId: string;
  subscriptionId: string;
  action: string;
  quoteHash: string;
  templateVersion: number;
  quoteExpiresAt: string;
  requestPayload: unknown;
  quoteSnapshot: Record<string, unknown>;
  totals: Record<string, unknown>;
}

export async function recordSubscriptionQuotePreview(
  serviceClient: SupabaseClient,
  input: RecordSubscriptionQuotePreviewInput,
): Promise<void> {
  const { error } = await serviceClient.rpc("customer_self_service_record_subscription_quote_preview", {
    p_auth_user_id: input.userId,
    p_subscription_id: input.subscriptionId,
    p_action: input.action,
    p_quote_hash: input.quoteHash,
    p_template_version: input.templateVersion,
    p_quote_expires_at: input.quoteExpiresAt,
    p_request_payload: input.requestPayload,
    p_quote_snapshot: input.quoteSnapshot,
    p_totals: input.totals,
    p_metadata: {
      source: "customer_subscription_preview",
      contractVersion: "customer.subscription_quote_preview.v1",
    },
  });
  if (error) throw error;
}
