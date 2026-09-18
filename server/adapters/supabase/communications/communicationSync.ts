import type { NewsletterSyncEvent } from "../../../../src/domains/communications/ports.js";
import type { CommunicationSyncStore } from "../../../domains/communications/communicationSyncWorker.js";

export interface CommunicationSyncRpcClient {
  rpc(
    functionName: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
}

function rpcFailure(rpcName: string, error: { code?: string; message?: string }): Error {
  return new Error(`${rpcName}_failed: ${error.message ?? error.code ?? "unknown"}`);
}

export function createSupabaseCommunicationSyncStore(
  client: CommunicationSyncRpcClient,
): CommunicationSyncStore {
  return {
    async claimBatch(input): Promise<NewsletterSyncEvent[]> {
      const { data, error } = await client.rpc("communication_claim_sync_outbox", {
        p_provider_kind: input.providerKind,
        p_batch_size: input.batchSize,
        p_visibility_seconds: input.visibilitySeconds,
        p_max_attempts: input.maxAttempts,
      });
      if (error) throw rpcFailure("communication_claim_sync_outbox", error);
      return Array.isArray(data) ? data.map(mapClaimedEvent).filter(isEvent) : [];
    },

    async markSent(input): Promise<boolean> {
      const { data, error } = await client.rpc("communication_mark_sync_outbox_sent", {
        p_outbox_id: input.eventId,
        p_claim_token: input.claimToken,
        p_provider_kind: input.providerKind,
        p_remote_profile_id: input.remoteProfileId ?? null,
        p_response_summary: input.responseSummary ?? {},
      });
      if (error) throw rpcFailure("communication_mark_sync_outbox_sent", error);
      return data === true;
    },

    async markFailed(input): Promise<boolean> {
      const { data, error } = await client.rpc("communication_mark_sync_outbox_failed", {
        p_outbox_id: input.eventId,
        p_claim_token: input.claimToken,
        p_provider_kind: input.providerKind,
        p_error: input.error,
        p_retry: input.retry,
        p_backoff_seconds: input.backoffSeconds,
      });
      if (error) throw rpcFailure("communication_mark_sync_outbox_failed", error);
      return data === true;
    },
  };
}

function mapClaimedEvent(row: unknown): NewsletterSyncEvent | null {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const record = row as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    typeof record.claim_token !== "string" ||
    typeof record.contact_id !== "string" ||
    typeof record.normalized_email !== "string" ||
    typeof record.event_type !== "string" ||
    typeof record.purpose !== "string"
  ) {
    return null;
  }
  return {
    id: record.id,
    claimToken: record.claim_token,
    contactId: record.contact_id,
    normalizedEmail: record.normalized_email,
    eventType: record.event_type as NewsletterSyncEvent["eventType"],
    purpose: record.purpose as NewsletterSyncEvent["purpose"],
    payload: isRecord(record.payload) ? record.payload : {},
    attemptCount: typeof record.attempt_count === "number" ? record.attempt_count : 0,
    originProviderKind: readNullableString(record.origin_provider_kind),
    originProviderEventId: readNullableString(record.origin_provider_event_id),
    remoteProfileId: readNullableString(record.remote_profile_id),
    remoteListId: readNullableString(record.remote_list_id),
  };
}

function isEvent(event: NewsletterSyncEvent | null): event is NewsletterSyncEvent {
  return Boolean(event);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
