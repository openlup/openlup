import { describe, expect, it, vi } from "vitest";
import {
  createSupabaseOmnipackReconciliationPort,
  type OmnipackReconciliationSupabaseClient,
} from "./omnipackReconciliationPort.js";
import { OmnipackReconciliationWriteError } from "../../domains/fulfillment/omnipackReconciliationError.js";

describe("Supabase OmniPack reconciliation port", () => {
  it("resolves the dispatch ref through the order number (providerOrderId is null in the feed)", async () => {
    const client = fakeClient({
      orderRow: { id: "order-1" },
      dispatchRef: {
        id: "ref-1",
        fulfillment_order_id: "ful-1",
        order_id: "order-1",
        provider_order_id: null,
      },
    });
    const port = createSupabaseOmnipackReconciliationPort(client as unknown as OmnipackReconciliationSupabaseClient);

    await expect(port.findDispatchRef({
      provider: "omnipack",
      providerOrderId: null,
      fulfilmentNumber: "OP/F/000042/VELIPE/2026",
      externalNumber: "PRORES/Z/00002/2026",
      orderNumber: "OPENLUP-9C32E607",
      status: "NEW",
      subStatus: "READY_FOR_EXPORT",
      trackingNumbers: [],
    })).resolves.toEqual({
      dispatchRefId: "ref-1",
      fulfillmentOrderId: "ful-1",
      orderId: "order-1",
      providerOrderId: null,
    });

    // Looked the order up by number, then the dispatch ref by that order id.
    expect(client.calls).toContainEqual(expect.objectContaining({
      table: "commerce_orders",
      filters: expect.objectContaining({ order_number: "OPENLUP-9C32E607" }),
    }));
    expect(client.calls).toContainEqual(expect.objectContaining({
      table: "omnipack_dispatch_refs",
      filters: expect.objectContaining({ provider_kind: "omnipack", order_id: "order-1" }),
    }));
  });

  it("returns null without a dispatch-ref query for orphaned fulfilments (no order match)", async () => {
    const client = fakeClient({ orderRow: null });
    const port = createSupabaseOmnipackReconciliationPort(client as unknown as OmnipackReconciliationSupabaseClient);

    await expect(port.findDispatchRef({
      provider: "omnipack",
      providerOrderId: null,
      fulfilmentNumber: "OP/F/000003/VELIPE/2026",
      externalNumber: null,
      orderNumber: "OPENLUP-PURGED",
      status: "NEW",
      subStatus: "VALIDATION_PENDING",
      trackingNumbers: [],
    })).resolves.toBeNull();

    expect(client.calls).toContainEqual(expect.objectContaining({
      table: "commerce_orders",
      filters: expect.objectContaining({ order_number: "OPENLUP-PURGED" }),
    }));
    expect(client.calls.some((call) => call.table === "omnipack_dispatch_refs")).toBe(false);
  });

  it("reads the local delivery carrier from the parcel-owned contact before legacy sources", async () => {
    const client = fakeClient({
      fulfillmentRow: {
        metadata: {
          selectedDelivery: {
            providerKind: "omnipack",
            carrierKind: "legacy",
            serviceCode: "LEGACY_SERVICE",
          },
        },
        shipping_address_snapshot: {
          deliveryContact: {
            selectedDelivery: {
              providerKind: "omnipack",
              carrierKind: "inpost",
              service: "inpost_locker_standard",
              serviceCode: "INPOST_LOCKER_STANDARD",
            },
          },
        },
        commerce_orders: { metadata: {} },
        addresses: { metadata: { selectedDelivery: { carrierKind: "address" } } },
      },
    });
    const port = createSupabaseOmnipackReconciliationPort(client as unknown as OmnipackReconciliationSupabaseClient);

    await expect(port.readDeliveryCarrier("ful-1")).resolves.toEqual({
      carrierKind: "inpost",
      service: "INPOST_LOCKER_STANDARD",
    });

    expect(client.calls).toContainEqual(expect.objectContaining({
      table: "commerce_fulfillment_orders",
      filters: expect.objectContaining({ id: "ful-1" }),
    }));
  });

  it("does not re-read a legacy carrier when the parcel contact has no valid selection", async () => {
    const client = fakeClient({
      fulfillmentRow: {
        metadata: { selectedDelivery: { carrierKind: "fulfillment" } },
        shipping_address_snapshot: { deliveryContact: { selectedDelivery: null } },
        commerce_orders: { metadata: { selectedDelivery: { carrierKind: "order" } } },
        addresses: { metadata: { selectedDelivery: { carrierKind: "address" } } },
      },
    });
    const port = createSupabaseOmnipackReconciliationPort(client as unknown as OmnipackReconciliationSupabaseClient);

    await expect(port.readDeliveryCarrier("ful-1")).resolves.toBeNull();
  });

  it("returns null delivery carrier when the fulfilment row or selection is missing", async () => {
    const missingRow = createSupabaseOmnipackReconciliationPort(
      fakeClient({ fulfillmentRow: null }) as unknown as OmnipackReconciliationSupabaseClient,
    );
    await expect(missingRow.readDeliveryCarrier("ful-gone")).resolves.toBeNull();

    const noSelection = createSupabaseOmnipackReconciliationPort(
      fakeClient({ fulfillmentRow: { metadata: {}, shipping_address_snapshot: {} } }) as unknown as OmnipackReconciliationSupabaseClient,
    );
    await expect(noSelection.readDeliveryCarrier("ful-1")).resolves.toBeNull();
  });

  it("reads durable handoff time for stale invoice recovery", async () => {
    const client = fakeClient({ fulfillmentRow: { handed_over_at: "2026-07-14T10:00:00+00:00" } });
    const port = createSupabaseOmnipackReconciliationPort(client as unknown as OmnipackReconciliationSupabaseClient);

    await expect(port.readHandedOverAt("ful-1")).resolves.toBe("2026-07-14T10:00:00+00:00");
    expect(client.calls).toContainEqual(expect.objectContaining({
      table: "commerce_fulfillment_orders",
      filters: expect.objectContaining({ id: "ful-1" }),
    }));
  });

  it("upserts tracking refs, reads them back, and records fulfillment tracking events", async () => {
    const client = fakeClient({
      trackingReadBack: {
        order_id: "order-1",
        provider_kind: "omnipack",
        provider_tracking_id: "TRK-1",
        tracking_url: "https://inpost.example/track/TRK-1",
        carrier_kind: "inpost",
        service: "INPOST_PACZKOMAT",
        active: true,
      },
      rpcResult: { replayed: false },
    });
    const port = createSupabaseOmnipackReconciliationPort(client as unknown as OmnipackReconciliationSupabaseClient);

    await expect(port.recordTrackingReference({
      idempotencyKey: "key-1",
      orderId: "order-1",
      fulfillmentOrderId: "ful-1",
      trackingNumber: "TRK-1",
      trackingUrl: "https://inpost.example/track/TRK-1",
      carrierKind: "inpost",
      service: "INPOST_PACZKOMAT",
      status: "in_transit",
      rawEvent: { provider: "omnipack" },
    })).resolves.toEqual({ replayed: false, readBack: true });

    expect(client.calls).toContainEqual(expect.objectContaining({
      table: "shipment_external_refs",
      op: "upsert",
      values: expect.objectContaining({
        order_id: "order-1",
        // The reference names the parcel it belongs to, or an order carrying a replacement
        // cannot say which of its two tracking numbers is the current one.
        fulfillment_order_id: "ful-1",
        provider_kind: "omnipack",
        provider_tracking_id: "TRK-1",
        tracking_url: "https://inpost.example/track/TRK-1",
        carrier_kind: "inpost",
        service: "INPOST_PACZKOMAT",
        active: true,
      }),
    }));
    expect(client.rpc).toHaveBeenCalledWith("commerce_fulfillment_record_tracking_event", expect.objectContaining({
      p_idempotency_key: "key-1",
      p_fulfillment_order_id: "ful-1",
      p_status: "in_transit",
      p_provider_tracking_id: "TRK-1",
    }));
  });

  it("marks the fulfillment handed over before reconciliation tracking events", async () => {
    const client = fakeClient({ rpcResult: { status: "handed_over", replayed: false } });
    const port = createSupabaseOmnipackReconciliationPort(client as unknown as OmnipackReconciliationSupabaseClient);

    await expect(port.markHandedOver({
      idempotencyKey: "handoff-key",
      fulfillmentOrderId: "ful-1",
      suppressDispatched: false,
    })).resolves.toEqual({ status: "handed_over", replayed: false });

    expect(client.rpc).toHaveBeenCalledWith("commerce_fulfillment_mark_handed_over", expect.objectContaining({
      p_idempotency_key: "handoff-key",
      p_fulfillment_order_id: "ful-1",
      p_metadata: { source: "omnipack_reconciliation", suppressShipmentDispatched: false },
    }));
  });

  it("marks provider stock consumed through the finished-picking RPC", async () => {
    const client = fakeClient({ rpcResult: { status: "packed", replayed: false } });
    const port = createSupabaseOmnipackReconciliationPort(client as unknown as OmnipackReconciliationSupabaseClient);

    await expect(port.markProviderStockConsumed({
      idempotencyKey: "picked-key",
      fulfillmentOrderId: "ful-1",
    })).resolves.toEqual({ status: "packed", replayed: false });

    expect(client.rpc).toHaveBeenCalledWith("commerce_fulfillment_mark_provider_stock_consumed", expect.objectContaining({
      p_idempotency_key: "picked-key",
      p_fulfillment_order_id: "ful-1",
      p_metadata: { source: "omnipack_reconciliation", providerEvent: "finished_picking" },
    }));
  });

  it("preserves only a whitelisted provider-stock domain reason", async () => {
    const client = fakeClient({
      rpcError: {
        code: "22023",
        message: "commerce_fulfillment_provider_stock_consumed_requires_label",
      },
    });
    const port = createSupabaseOmnipackReconciliationPort(client as unknown as OmnipackReconciliationSupabaseClient);

    const error = await port.markProviderStockConsumed({
      idempotencyKey: "picked-key",
      fulfillmentOrderId: "ful-1",
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(OmnipackReconciliationWriteError);
    expect(error).toMatchObject({
      code: "22023",
      domainReason: "commerce_fulfillment_provider_stock_consumed_requires_label",
    });
    expect(String(error)).not.toContain("buyer@example.com");
  });

  it("records unknown fulfilments in inbound_provider_events as ignored reconciliation evidence", async () => {
    const client = fakeClient();
    const port = createSupabaseOmnipackReconciliationPort(client as unknown as OmnipackReconciliationSupabaseClient);

    await expect(port.recordQuarantine({
      idempotencyKey: "recon-key",
      reason: "omnipack_dispatch_ref_not_found",
      fulfilment: {
        provider: "omnipack",
        providerOrderId: null,
        fulfilmentNumber: "FUL-X",
        externalNumber: null,
        orderNumber: null,
        status: "shipped",
        subStatus: null,
        trackingNumbers: [],
      },
    })).resolves.toEqual({ replayed: false });

    expect(client.calls).toContainEqual(expect.objectContaining({
      table: "inbound_provider_events",
      op: "insert",
      values: expect.objectContaining({
        provider: "omnipack",
        provider_event_id: "recon-key",
        processing_status: "ignored",
        received_via: "omnipack.reconciliation.v0",
      }),
    }));
  });
});

function fakeClient(options: {
  orderRow?: Record<string, unknown> | null;
  dispatchRef?: Record<string, unknown> | null;
  trackingReadBack?: Record<string, unknown> | null;
  fulfillmentRow?: Record<string, unknown> | null;
  rpcResult?: Record<string, unknown>;
  rpcError?: { code?: string; message?: string };
} = {}) {
  const calls: Array<{
    table: string;
    op: string;
    values?: Record<string, unknown>;
    filters?: Record<string, unknown>;
  }> = [];
  const client = {
    calls,
    from(table: string) {
      const state = {
        table,
        op: "select",
        values: undefined as Record<string, unknown> | undefined,
        filters: {} as Record<string, unknown>,
      };
      const builder = {
        select: vi.fn(() => builder),
        eq: vi.fn((column: string, value: unknown) => {
          state.filters[column] = value;
          return builder;
        }),
        order: vi.fn(() => builder),
        // limit is chainable: dispatch-ref lookup resolves via .order().limit(1).maybeSingle().
        limit: vi.fn(() => builder),
        insert: vi.fn((values: Record<string, unknown>) => {
          state.op = "insert";
          state.values = values;
          return builder;
        }),
        upsert: vi.fn((values: Record<string, unknown>) => {
          state.op = "upsert";
          state.values = values;
          return builder;
        }),
        maybeSingle: vi.fn(() => {
          calls.push({ table, op: state.op, values: state.values, filters: state.filters });
          if (table === "commerce_orders" && state.op === "select") {
            return Promise.resolve(result(options.orderRow ?? null));
          }
          if (table === "omnipack_dispatch_refs") {
            return Promise.resolve(result(options.dispatchRef ?? null));
          }
          if (table === "shipment_external_refs" && state.op === "select") {
            return Promise.resolve(result(options.trackingReadBack ?? null));
          }
          if (table === "commerce_fulfillment_orders" && state.op === "select") {
            return Promise.resolve(result(options.fulfillmentRow ?? null));
          }
          if (table === "inbound_provider_events" && state.op === "select") return Promise.resolve(result(null));
          return Promise.resolve(result({ id: "row-1" }));
        }),
        then: undefined,
      };
      return builder;
    },
    rpc: vi.fn(async () => ({
      data: options.rpcResult ?? { replayed: false },
      error: options.rpcError ?? null,
    })),
  };
  return client;
}

function result(data: unknown) {
  return { data, error: null };
}
