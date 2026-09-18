import type {
  NewsletterWebhookPort,
  NormalizedNewsletterWebhookEvent,
} from "../../../domains/communications/newsletterWebhookHandler.js";

export interface NewsletterWebhookRpcClient {
  rpc(
    functionName: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
}

export function createSupabaseNewsletterWebhookPort(
  client: NewsletterWebhookRpcClient,
): NewsletterWebhookPort {
  return {
    async recordProviderEvent(input) {
      const { data, error } = await client.rpc("communication_record_provider_event", {
        p_provider_kind: input.providerKind,
        p_provider_event_id: input.providerEventId,
        p_event_type: input.eventType,
        p_email: input.email,
        p_remote_profile_id: input.remoteProfileId,
        p_purpose: input.purpose,
        p_state: input.state,
        p_payload: sanitizePayload(input.rawPayload),
        p_metadata: providerEventMetadata(input),
        p_processing_status: input.processingStatus,
      });
      if (error) throw rpcFailure("communication_record_provider_event", error);
      const record = isRecord(data) ? data : {};
      return {
        providerEventId: readString(record.providerEventId) ?? "",
        contactId: readString(record.contactId),
        inserted: record.inserted === true,
      };
    },

    async recordPermission(input) {
      const { error } = await client.rpc("communication_record_permission_event", {
        p_contact_id: input.contactId,
        p_purpose: input.purpose,
        p_state: input.state,
        p_source: "newsletter_provider_webhook",
        p_source_ref: {
          providerKind: input.providerKind,
          providerEventId: input.providerEventId,
        },
        p_reason: input.reason,
        p_metadata: {
          ...input.metadata,
          actorType: "provider_webhook",
          captureMethod: "newsletter_webhook",
          originProviderKind: input.providerKind,
          originProviderEventId: input.providerEventId,
        },
        p_captured_at: new Date().toISOString(),
        p_create_sync_event: true,
      });
      if (error) throw rpcFailure("communication_record_permission_event", error);
    },

    async markProviderEvent(input) {
      const { error } = await client.rpc("communication_mark_provider_event_processed", {
        p_provider_event_id: input.providerEventId,
        p_processing_status: input.status,
        p_metadata: input.metadata,
      });
      if (error) throw rpcFailure("communication_mark_provider_event_processed", error);
    },
  };
}

function providerEventMetadata(
  input: NormalizedNewsletterWebhookEvent & { processingStatus: "received" | "ignored" },
): Record<string, unknown> {
  return {
    occurredAt: input.occurredAt,
    explicitOptInEvidence: input.explicitOptInEvidence,
    doubleOptInStatus: input.doubleOptInStatus,
    remoteListId: input.remoteListId,
    processingStatus: input.processingStatus,
  };
}

function sanitizePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const sanitized = { ...payload };
  delete sanitized.apiKey;
  delete sanitized.token;
  delete sanitized.secret;
  return sanitized;
}

function rpcFailure(rpcName: string, error: { code?: string; message?: string }): Error {
  return new Error(`${rpcName}_failed: ${error.message ?? error.code ?? "unknown"}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
