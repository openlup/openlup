import type {
  ChannelIngestBuyer,
  ChannelIngestChannelReadPort,
  ChannelIngestChannelRecord,
  ChannelIngestLedger,
  ChannelIngestOrder,
  ChannelIngestStatus,
  ChannelIngestStorePort,
  ChannelQuarantineReason,
  ChannelQuarantineRecord,
} from "../../../src/domains/channels/channelIngestStorePort.js";

// Managed adapter over the five authored channel-ingest transaction boundaries. It maps the saga's
// vocabulary onto RPC arguments and back, and does nothing else: every decision, every refusal and
// every idempotency rule lives in the SQL, where a second caller cannot bypass it.

export interface ManagedChannelIngestClient {
  rpc(
    functionName: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
  from(table: string): ManagedChannelQuery;
}

export interface ManagedChannelQuery {
  select(columns: string): ManagedChannelQuery;
  eq(column: string, value: unknown): ManagedChannelQuery;
  maybeSingle(): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
}

const CHANNEL_COLUMNS =
  "id, connection_id, slug, status, currency, settlement_provider_kind, buyer_comms_owner, " +
  "delivery_selection, sales_channel_connections(connector_provider_kind)";

function rpcFailure(
  rpcName: string,
  error: { code?: string; message?: string },
): Error & { code?: string } {
  const failure = new Error(
    `${rpcName}_failed: ${error.message ?? error.code ?? "unknown"}`,
  ) as Error & { code?: string };
  failure.code = error.code;
  return failure;
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`channel_ingest_response_invalid: ${path}`);
  }
  return value as Record<string, unknown>;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function requiredString(value: unknown, path: string): string {
  const parsed = nullableString(value);
  if (!parsed) throw new Error(`channel_ingest_response_invalid: ${path}`);
  return parsed;
}

function mapLedger(data: unknown): ChannelIngestLedger {
  const ingest = record(record(data, "ledger").ingest, "ledger.ingest");
  return {
    id: requiredString(ingest.id, "ledger.ingest.id"),
    status: requiredString(ingest.status, "ledger.ingest.status") as ChannelIngestStatus,
    orderId: nullableString(ingest.orderId),
    clientId: nullableString(ingest.clientId),
    shippingAddressId: nullableString(ingest.shippingAddressId),
    paymentIntentId: nullableString(ingest.paymentIntentId),
    externalOrderRevision: nullableString(ingest.externalOrderRevision),
    conflict: ingest.conflict === "revision_conflict" ? "revision_conflict" : null,
    eventReplayed: ingest.eventReplayed === true,
    replayed: ingest.replayed === true,
  };
}

export function createManagedChannelIngestStore(
  client: ManagedChannelIngestClient,
): ChannelIngestStorePort {
  const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    const { data, error } = await client.rpc(name, args);
    if (error) throw rpcFailure(name, error);
    return data;
  };

  return {
    async recordInboundEvent(input): Promise<ChannelIngestLedger> {
      return mapLedger(
        await call("channel_ingest_record_inbound_event", {
          p_channel_id: input.channelId,
          p_external_order_ref: input.externalOrderRef,
          p_external_order_revision: input.externalOrderRevision,
          p_provider_event_id: input.providerEventId,
          p_normalized: input.normalized,
        }),
      );
    },

    async upsertBuyer(input): Promise<ChannelIngestBuyer> {
      const data = await call("channel_ingest_upsert_buyer", {
        p_ledger_id: input.ledgerId,
        p_buyer: input.buyer,
        p_ship_to: input.shipTo,
      });
      const buyer = record(record(data, "buyer").buyer, "buyer.buyer");
      return {
        clientId: requiredString(buyer.clientId, "buyer.clientId"),
        shippingAddressId: requiredString(buyer.shippingAddressId, "buyer.shippingAddressId"),
        clientCreated: buyer.clientCreated === true,
        replayed: buyer.replayed === true,
      };
    },

    async createChannelOrder(input): Promise<ChannelIngestOrder> {
      const data = await call("commerce_create_channel_order", {
        p_idempotency_key: input.idempotencyKey,
        p_ledger_id: input.ledgerId,
        // NULL rather than an empty array when the order carried no bundle line: the boundary reads
        // NULL as "write the wire lines" and an array as "write exactly these", and collapsing the
        // two would turn a SKU-only order into an order with no lines at all.
        p_expanded_lines: input.expandedLines ?? null,
      });
      const created = record(record(data, "order").channelOrder, "order.channelOrder");
      return {
        orderId: requiredString(created.orderId, "order.orderId"),
        orderRef: nullableString(created.orderRef),
        replayed: created.replayed === true,
      };
    },

    async advanceLedger(input): Promise<ChannelIngestLedger> {
      return mapLedger(
        await call("channel_ingest_advance", {
          p_ledger_id: input.ledgerId,
          p_to_status: input.toStatus,
          p_payment_intent_id: input.paymentIntentId ?? null,
          p_last_error: input.lastError ?? null,
        }),
      );
    },

    async quarantine(input): Promise<ChannelQuarantineRecord> {
      const data = await call("channel_ingest_quarantine", {
        p_channel_id: input.channelId,
        p_connection_id: input.connectionId,
        p_provider_event_id: input.providerEventId,
        p_external_order_ref: input.externalOrderRef,
        p_vocabulary: input.vocabulary,
        p_reason: input.reason,
        p_payload: input.payload,
      });
      const row = record(record(data, "quarantine").quarantine, "quarantine.quarantine");
      return {
        id: requiredString(row.id, "quarantine.id"),
        reason: requiredString(row.reason, "quarantine.reason") as ChannelQuarantineReason,
        status: requiredString(row.status, "quarantine.status") as ChannelQuarantineRecord["status"],
        vocabulary: requiredString(row.vocabulary, "quarantine.vocabulary"),
      };
    },
  };
}

/** An object or nothing. An array or a scalar in this column is not a selection. */
function deliverySelectionOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The channel row the saga admits against. Read through the same connection embed the registry
 * already models, so the connector kind travels with the surface instead of being looked up twice.
 */
export function createManagedChannelIngestChannelRead(
  client: ManagedChannelIngestClient,
): ChannelIngestChannelReadPort {
  return {
    async readChannelBySlug(slug): Promise<ChannelIngestChannelRecord | null> {
      const { data, error } = await client
        .from("sales_channels")
        .select(CHANNEL_COLUMNS)
        .eq("slug", slug)
        .maybeSingle();
      if (error) throw rpcFailure("sales_channels_read", error);
      if (!data || typeof data !== "object") return null;

      const row = data as Record<string, unknown>;
      const connection = row.sales_channel_connections;
      const connectorKind =
        connection && typeof connection === "object"
          ? nullableString((connection as Record<string, unknown>).connector_provider_kind)
          : null;

      return {
        id: requiredString(row.id, "channel.id"),
        connectionId: nullableString(row.connection_id),
        slug: requiredString(row.slug, "channel.slug"),
        status: requiredString(row.status, "channel.status"),
        currency: requiredString(row.currency, "channel.currency"),
        // A channel with no connection is a self-owned surface; it has no connector to name.
        connectorProviderKind: connectorKind ?? "",
        settlementProviderKind: requiredString(
          row.settlement_provider_kind,
          "channel.settlement_provider_kind",
        ),
        buyerCommsOwner: requiredString(row.buyer_comms_owner, "channel.buyer_comms_owner"),
        // Passed through unread. Which providers and service codes are valid is application
        // knowledge that changes without a migration, so this adapter proves only that the column
        // held an object; admission decides whether the surface may sell at all without one.
        deliverySelection: deliverySelectionOf(row.delivery_selection),
      };
    },
  };
}
