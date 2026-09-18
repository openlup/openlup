import type {
  AdminChannelOpsReadPort,
  ChannelOpsIngestRow,
  ChannelOpsOrderContext,
} from "../../domains/channels/adminChannelOpsHandler.js";

// Three reads, no writes, and no way to ask this client for one.
//
// The count is asked for as a COUNT, not as rows discarded afterwards: a channel whose drawer has
// grown to thousands is exactly the channel an operator opens this panel for, and fetching those
// rows to throw them away would make the panel slowest precisely when it matters most.

export interface ChannelOpsQueryClient {
  from(table: string): ChannelOpsQuery;
}

export interface ChannelOpsQuery {
  select(columns: string, options?: { count?: "exact"; head?: boolean }): ChannelOpsQuery;
  eq(column: string, value: unknown): ChannelOpsQuery;
  order(column: string, options?: { ascending?: boolean }): ChannelOpsQuery;
  limit(count: number): ChannelOpsQuery;
  maybeSingle(): PromiseLike<{ data: unknown; error: { message?: string } | null }>;
  then<TResult1 = ChannelOpsResult, TResult2 = never>(
    onfulfilled?: ((value: ChannelOpsResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2>;
}

export interface ChannelOpsResult {
  data: unknown;
  error: { message?: string } | null;
  count?: number | null;
}

function fail(what: string, error: { message?: string } | null): Error {
  return new Error(`channel_ops_${what}_failed: ${error?.message ?? "unknown"}`);
}

function row(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function createSupabaseChannelOpsReadPort(
  client: ChannelOpsQueryClient,
): AdminChannelOpsReadPort {
  return {
    async readOrderChannel(orderId): Promise<ChannelOpsOrderContext | null> {
      const { data, error } = await client
        .from("commerce_orders")
        .select("source_channel_id, sales_channels!commerce_orders_source_channel_id_fkey(slug, display_name, status)")
        .eq("id", orderId)
        .maybeSingle();
      if (error) throw fail("order_channel", error);
      const order = row(data);
      const channelId = text(order?.source_channel_id);
      if (!channelId) return null;
      // The embed can be absent even when the id is present, if the channel row was removed. That
      // is reported as "no channel" rather than as a half-filled record, for the same reason the
      // ingest store reports an absent embed rather than guessing a slug.
      const channel = row(order?.sales_channels);
      const slug = text(channel?.slug);
      if (!slug) return null;
      return {
        channelId,
        slug,
        displayName: text(channel?.display_name) ?? slug,
        status: text(channel?.status) ?? "unknown",
      };
    },

    async readOrderIngest(orderId): Promise<ChannelOpsIngestRow | null> {
      const { data, error } = await client
        .from("channel_order_ingests")
        .select("id, status, external_order_ref, external_order_revision, last_error, updated_at")
        .eq("order_id", orderId)
        .maybeSingle();
      if (error) throw fail("order_ingest", error);
      const ingest = row(data);
      const ledgerId = text(ingest?.id);
      if (!ledgerId) return null;
      return {
        ledgerId,
        status: text(ingest?.status) ?? "unknown",
        externalOrderRef: text(ingest?.external_order_ref) ?? "",
        externalOrderRevision: text(ingest?.external_order_revision),
        lastError: text(ingest?.last_error),
        updatedAt: text(ingest?.updated_at) ?? "",
      };
    },

    async countOpenQuarantine(channelId): Promise<number> {
      const result = await client
        .from("sales_channel_quarantine")
        .select("id", { count: "exact", head: true })
        .eq("channel_id", channelId)
        .eq("status", "open");
      if (result.error) throw fail("quarantine_count", result.error);
      return result.count ?? 0;
    },
  };
}
