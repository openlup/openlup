import {
  createPostgresChannelIngestTransactionLane,
  type PostgresDataGatewayEnv,
  type PostgresDataGatewayOptions,
} from "./dataGateway.js";
import type {
  ChannelIngestBuyer,
  ChannelIngestLedger,
  ChannelIngestOrder,
  ChannelIngestStatus,
  ChannelIngestStorePort,
  ChannelQuarantineReason,
  ChannelQuarantineRecord,
} from "../../../src/domains/channels/channelIngestStorePort.js";

// Direct-Postgres adapter over the channel-ingest boundaries the PUBLIC PLATFORM CHAIN actually
// authors. It is real for the three it has and honest about the two it does not.
//
// THE SCOPE IS MEASURED, NOT CHOSEN. The platform chain has no `addresses`, no
// `customer_external_refs`, no `inbound_provider_events` and no payment control plane; its money
// model is the settlement-intent rail. So `channel_ingest_upsert_buyer` and
// `commerce_create_channel_order` have no relations to be written against there and are not in that
// chain. Rather than pretend, the two methods below raise a named, catchable error that says which
// capability is missing and where. An adapter that silently returned a fabricated id would push the
// discovery of this gap all the way to a customer's order.

export class ChannelIngestCapabilityUnavailableError extends Error {
  readonly capability: string;

  constructor(capability: string) {
    super(
      `channel_ingest_capability_unavailable: ${capability} is not authored in the platform ` +
        "migration catalogue (no identity, address or payment-control rail exists there)",
    );
    this.name = "ChannelIngestCapabilityUnavailableError";
    this.capability = capability;
  }
}

interface PostgresChannelIngestClient {
  rpc(
    functionName: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
}

export interface PostgresChannelIngestStore extends ChannelIngestStorePort {
  close(): Promise<void>;
}

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
    // Always null on this chain: the ledger there carries neither column (departure 2 of the
    // platform forward). Reported as absent rather than as a value that was never stored.
    shippingAddressId: nullableString(ingest.shippingAddressId),
    paymentIntentId: nullableString(ingest.paymentIntentId),
    externalOrderRevision: nullableString(ingest.externalOrderRevision),
    conflict: ingest.conflict === "revision_conflict" ? "revision_conflict" : null,
    eventReplayed: ingest.eventReplayed === true,
    replayed: ingest.replayed === true,
  };
}

export function createPostgresChannelIngestStore(
  env: PostgresDataGatewayEnv,
  options: PostgresDataGatewayOptions = {},
): PostgresChannelIngestStore {
  const transactions = createPostgresChannelIngestTransactionLane(env, options);
  const call = (name: string, args: Record<string, unknown>): Promise<unknown> =>
    transactions.run(async (gateway) => {
      const client = gateway as PostgresChannelIngestClient;
      const { data, error } = await client.rpc(name, args);
      if (error) throw rpcFailure(name, error);
      return data;
    });

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

    upsertBuyer(): Promise<ChannelIngestBuyer> {
      return Promise.reject(new ChannelIngestCapabilityUnavailableError("channel_ingest_upsert_buyer"));
    },

    createChannelOrder(): Promise<ChannelIngestOrder> {
      return Promise.reject(
        new ChannelIngestCapabilityUnavailableError("commerce_create_channel_order"),
      );
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

    close: () => transactions.close(),
  };
}
