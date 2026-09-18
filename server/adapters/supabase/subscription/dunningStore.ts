import type {
  ClaimedDunningNotification,
  DunningStorePort,
} from "../../../domains/subscription/subscriptionDunningDispatchPorts.js";

export interface DunningStoreSupabaseClient {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message?: string; code?: string } | null }>;
}

interface RawRow {
  id?: unknown;
  case_id?: unknown;
  notification_kind?: unknown;
  template_slug?: unknown;
  recipient_ref?: unknown;
  subscription_id?: unknown;
  retry_attempt?: unknown;
  recovery_url_path?: unknown;
  payload?: unknown;
}

function mapRow(raw: RawRow): ClaimedDunningNotification | null {
  if (typeof raw.id !== "string" || typeof raw.recipient_ref !== "string") return null;
  const payload = (raw.payload && typeof raw.payload === "object" ? raw.payload : {}) as Record<
    string,
    unknown
  >;
  const claimToken = typeof payload.claimToken === "string"
    ? payload.claimToken.trim()
    : "";
  if (!claimToken) return null;
  const amountMinor = typeof payload.amountMinor === "number" ? payload.amountMinor : null;
  const currency = typeof payload.currency === "string" ? payload.currency : null;
  // `nextRetryAt` has been written into this payload since the dunning RPC's
  // first version; it was simply never read out. The claim returns the whole
  // row, so both the payload key and the table column are already in hand.
  const nextRetryAt = typeof payload.nextRetryAt === "string" ? payload.nextRetryAt : null;
  return {
    id: raw.id,
    // Projection only: the claim RPC is `RETURNS SETOF
    // subscription_dunning_notifications`, so the case id has always been in the
    // returned row and simply had no reader.
    caseId: typeof raw.case_id === "string" ? raw.case_id : null,
    claimToken,
    notificationKind: typeof raw.notification_kind === "string" ? raw.notification_kind : "payment_failed",
    templateSlug: typeof raw.template_slug === "string" ? raw.template_slug : "",
    clientId: raw.recipient_ref,
    subscriptionId: typeof raw.subscription_id === "string" ? raw.subscription_id : null,
    retryAttempt: typeof raw.retry_attempt === "number" ? raw.retry_attempt : null,
    recoveryUrlPath: typeof raw.recovery_url_path === "string" ? raw.recovery_url_path : null,
    amountMinor,
    currency,
    nextRetryAt,
  };
}

export function createSupabaseSubscriptionDunningStorePort(
  client: DunningStoreSupabaseClient,
): DunningStorePort {
  return {
    async claimBatch(batchSize, leaseSeconds, maxAttempts): Promise<ClaimedDunningNotification[]> {
      const result = await client.rpc("subscription_dunning_claim_batch", {
        p_batch_size: batchSize,
        p_lease_seconds: leaseSeconds,
        p_max_attempts: maxAttempts,
      });
      if (result.error) {
        throw new Error(
          `dunning_claim_failed: ${result.error.message ?? result.error.code ?? "unknown"}`,
        );
      }
      const rows = Array.isArray(result.data) ? (result.data as RawRow[]) : [];
      return rows.map(mapRow).filter((row): row is ClaimedDunningNotification => row !== null);
    },

    async markSent(id, claimToken, deliveryId): Promise<void> {
      const result = await client.rpc("subscription_dunning_mark_sent", {
        p_id: id,
        p_claim_token: claimToken,
        p_delivery_id: deliveryId,
      });
      if (result.error) {
        throw new Error(
          `dunning_mark_sent_failed: ${result.error.message ?? result.error.code ?? "unknown"}`,
        );
      }
      if (result.data !== true) {
        throw new Error("dunning_mark_sent_fenced");
      }
    },

    async markResult(id, claimToken, status, error, rescheduleAt = null): Promise<void> {
      const result = await client.rpc("subscription_dunning_mark_result", {
        p_id: id,
        p_claim_token: claimToken,
        p_status: status,
        p_error: error,
        p_reschedule_at: rescheduleAt,
      });
      if (result.error) {
        throw new Error(
          `dunning_mark_result_failed: ${result.error.message ?? result.error.code ?? "unknown"}`,
        );
      }
      if (result.data !== true) {
        throw new Error("dunning_mark_result_fenced");
      }
    },
  };
}
export const createSubscriptionDunningStorePort = createSupabaseSubscriptionDunningStorePort;
