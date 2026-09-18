import { describe, expect, it } from "vitest";

import {
  createManagedChannelIngestChannelRead,
  createManagedChannelIngestStore,
  type ManagedChannelIngestClient,
} from "./channelIngestStore.js";
import { readChannelOrderFixture } from "../noop_channel/noopChannelConnectorAdapter.js";

type RpcCall = { name: string; args: Record<string, unknown> };

function createClient(
  responses: Record<string, unknown>,
  options: { rpcError?: { code?: string; message?: string }; row?: unknown } = {},
) {
  const calls: RpcCall[] = [];
  const client: ManagedChannelIngestClient = {
    rpc(name, args) {
      calls.push({ name, args });
      return Promise.resolve({
        data: responses[name] ?? null,
        error: options.rpcError ?? null,
      });
    },
    from() {
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: () =>
          Promise.resolve({ data: options.row ?? null, error: options.rpcError ?? null }),
      };
      return query;
    },
  };
  return { client, calls };
}

const ledgerResponse = {
  contractVersion: "channels.ingest.v0",
  ingest: {
    id: "ledger-1",
    status: "received",
    orderId: null,
    clientId: null,
    shippingAddressId: null,
    paymentIntentId: null,
    externalOrderRevision: "r1",
    conflict: null,
    eventReplayed: false,
    replayed: false,
  },
};

describe("managed channel ingest store", () => {
  it("maps the record boundary onto its rpc arguments", async () => {
    const { client, calls } = createClient({ channel_ingest_record_inbound_event: ledgerResponse });
    const order = readChannelOrderFixture("order-well-formed.json");

    const ledger = await createManagedChannelIngestStore(client).recordInboundEvent({
      channelId: "ca-1",
      externalOrderRef: order.externalOrderRef,
      externalOrderRevision: "r1",
      providerEventId: order.providerEventId,
      normalized: order,
    });

    expect(calls[0]).toEqual({
      name: "channel_ingest_record_inbound_event",
      args: {
        p_channel_id: "ca-1",
        p_external_order_ref: order.externalOrderRef,
        p_external_order_revision: "r1",
        p_provider_event_id: order.providerEventId,
        p_normalized: order,
      },
    });
    expect(ledger.id).toBe("ledger-1");
    expect(ledger.conflict).toBeNull();
  });

  it("surfaces a revision conflict as a field rather than as a throw", async () => {
    const conflicted = {
      ...ledgerResponse,
      ingest: { ...ledgerResponse.ingest, conflict: "revision_conflict", status: "done" },
    };
    const { client } = createClient({ channel_ingest_record_inbound_event: conflicted });

    const ledger = await createManagedChannelIngestStore(client).recordInboundEvent({
      channelId: "ca-1",
      externalOrderRef: "EXT-1",
      externalOrderRevision: "r2",
      providerEventId: "evt-1",
      normalized: readChannelOrderFixture("order-well-formed.json"),
    });

    expect(ledger.conflict).toBe("revision_conflict");
  });

  it("hands a resolved bundle expansion to the order boundary verbatim", async () => {
    const { client, calls } = createClient({
      commerce_create_channel_order: {
        channelOrder: { orderId: "order-1", orderRef: "ORD-1", replayed: false },
      },
    });
    const expandedLines = [
      {
        externalLineRef: "L1",
        externalOfferRef: "OFFER-1",
        skuCode: "SKU-A",
        quantity: 3,
        unitGrossMinor: 834,
        lineGrossMinor: 2501,
        lineDiscountMinor: 51,
        vatRateBps: 500,
        bundleCode: "starter",
        bundleQty: 3,
      },
    ];

    await createManagedChannelIngestStore(client).createChannelOrder({
      idempotencyKey: "ch:ca-1:ord:EXT-1:order",
      ledgerId: "ledger-1",
      expandedLines,
    });

    expect(calls[0].args.p_expanded_lines).toEqual(expandedLines);
  });

  it("passes the idempotency key and ledger id to the order boundary", async () => {
    const { client, calls } = createClient({
      commerce_create_channel_order: {
        channelOrder: { orderId: "order-1", orderRef: "ORD-1", replayed: false },
      },
    });

    const created = await createManagedChannelIngestStore(client).createChannelOrder({
      idempotencyKey: "ch:ca-1:ord:EXT-1:order",
      ledgerId: "ledger-1",
    });

    expect(calls[0].args).toEqual({
      p_idempotency_key: "ch:ca-1:ord:EXT-1:order",
      p_ledger_id: "ledger-1",
      // NULL, not an empty array. The boundary reads NULL as "write the wire lines"; an array is
      // "write exactly these", and an empty one would be an order with no lines at all.
      p_expanded_lines: null,
    });
    expect(created).toEqual({ orderId: "order-1", orderRef: "ORD-1", replayed: false });
  });

  it("sends explicit nulls rather than omitting the optional advance arguments", async () => {
    const { client, calls } = createClient({ channel_ingest_advance: ledgerResponse });

    await createManagedChannelIngestStore(client).advanceLedger({
      ledgerId: "ledger-1",
      toStatus: "reserved",
    });

    expect(calls[0].args).toEqual({
      p_ledger_id: "ledger-1",
      p_to_status: "reserved",
      p_payment_intent_id: null,
      p_last_error: null,
    });
  });

  it("maps the quarantine boundary and keeps the wire token verbatim", async () => {
    const { client, calls } = createClient({
      channel_ingest_quarantine: {
        quarantine: {
          id: "q-1",
          reason: "unmapped_vocabulary",
          status: "open",
          vocabulary: "AWAITING_SELLER_ACTION",
        },
      },
    });

    const row = await createManagedChannelIngestStore(client).quarantine({
      channelId: "ca-1",
      connectionId: "c-1",
      providerEventId: "evt-1",
      externalOrderRef: "EXT-1",
      vocabulary: "AWAITING_SELLER_ACTION",
      reason: "unmapped_vocabulary",
      payload: { raw: true },
    });

    expect(calls[0].args.p_vocabulary).toBe("AWAITING_SELLER_ACTION");
    expect(row.vocabulary).toBe("AWAITING_SELLER_ACTION");
  });

  it("raises a named failure carrying the sqlstate when an rpc refuses", async () => {
    const { client } = createClient({}, { rpcError: { code: "22023", message: "channel_order_vat_unresolvable" } });

    await expect(
      createManagedChannelIngestStore(client).advanceLedger({
        ledgerId: "ledger-1",
        toStatus: "done",
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("channel_ingest_advance_failed"),
      code: "22023",
    });
  });

  it("refuses a response that is missing the fields the saga depends on", async () => {
    const { client } = createClient({ channel_ingest_advance: { ingest: { status: "done" } } });

    await expect(
      createManagedChannelIngestStore(client).advanceLedger({
        ledgerId: "ledger-1",
        toStatus: "done",
      }),
    ).rejects.toThrow(/channel_ingest_response_invalid/);
  });
});

describe("managed channel read", () => {
  it("lifts the connector kind out of the connection embed", async () => {
    const { client } = createClient(
      {},
      {
        row: {
          id: "ca-1",
          connection_id: "c-1",
          slug: "sim-market",
          status: "active",
          currency: "EUR",
          settlement_provider_kind: "channel_settlement",
          buyer_comms_owner: "channel",
          delivery_selection: { providerKind: "simulator", kind: "courier" },
          sales_channel_connections: { connector_provider_kind: "noop_channel" },
        },
      },
    );

    const channel = await createManagedChannelIngestChannelRead(client).readChannelBySlug("sim-market");

    expect(channel).toEqual({
      id: "ca-1",
      connectionId: "c-1",
      slug: "sim-market",
      status: "active",
      currency: "EUR",
      connectorProviderKind: "noop_channel",
      settlementProviderKind: "channel_settlement",
      buyerCommsOwner: "channel",
      // Carried verbatim. This adapter proves only that the column held an object; which providers
      // and service codes are valid is application knowledge that changes without a migration.
      deliverySelection: { providerKind: "simulator", kind: "courier" },
    });
  });

  // A column that has never been written reads as SQL NULL, and a surface that has not declared a
  // selection must arrive at admission as "has not declared" rather than as an empty object that
  // would sail past a truthiness check and reserve against nobody's stock.
  it("reads an undeclared delivery selection as nothing, not as an empty object", async () => {
    const { client } = createClient(
      {},
      {
        row: {
          id: "ca-3",
          connection_id: "c-1",
          slug: "sim-market",
          status: "active",
          currency: "EUR",
          settlement_provider_kind: "channel_settlement",
          buyer_comms_owner: "channel",
          delivery_selection: null,
          sales_channel_connections: { connector_provider_kind: "noop_channel" },
        },
      },
    );

    const channel = await createManagedChannelIngestChannelRead(client).readChannelBySlug("sim-market");

    expect(channel?.deliverySelection).toBeNull();
  });

  it("reports a self-owned surface as having no connector rather than inventing one", async () => {
    const { client } = createClient(
      {},
      {
        row: {
          id: "ca-2",
          connection_id: null,
          slug: "storefront",
          status: "active",
          currency: "EUR",
          settlement_provider_kind: "channel_settlement",
          buyer_comms_owner: "platform",
          sales_channel_connections: null,
        },
      },
    );

    const channel = await createManagedChannelIngestChannelRead(client).readChannelBySlug("storefront");

    expect(channel).toMatchObject({ connectionId: null, connectorProviderKind: "" });
  });

  it("returns null for an unregistered slug", async () => {
    const { client } = createClient({});

    expect(await createManagedChannelIngestChannelRead(client).readChannelBySlug("nope")).toBeNull();
  });
});
