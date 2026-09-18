import { describe, expect, it, vi } from "vitest";
import {
  createSupabaseOmnipackWebhookPort,
  type OmnipackWebhookSupabaseClient,
} from "./omnipackWebhookPort.js";

describe("Supabase OmniPack webhook port", () => {
  it("replays existing inbound events before insert", async () => {
    const client = fakeClient({
      inboundExisting: { id: "evt-1" },
    });
    const port = createSupabaseOmnipackWebhookPort(client as unknown as OmnipackWebhookSupabaseClient);

    await expect(port.ingestInboundEvent({
      providerEventId: "order.shipped:openlup:FUL:now",
      eventType: "order.shipped",
      processingStatus: "received",
      payload: { sanitized: true },
      error: {},
    })).resolves.toEqual({ inboundProviderEventId: "evt-1", replayed: true });

    expect(client.calls.some((call) => call.table === "inbound_provider_events" && call.op === "insert")).toBe(false);
  });

  it("matches dispatch refs deterministically by indexed provider order id", async () => {
    const client = fakeClient({
      dispatchRef: {
        id: "ref-1",
        fulfillment_order_id: "ful-1",
        order_id: "order-1",
        provider_order_id: "provider-order-1",
      },
    });
    const port = createSupabaseOmnipackWebhookPort(client as unknown as OmnipackWebhookSupabaseClient);

    await expect(port.findDispatchRef({
      provider: "omnipack",
      event: "order.shipped",
      providerOrderId: "provider-order-1",
      orderNumber: null,
      fulfilmentNumber: "FUL-1001",
      occurredAt: "2026-06-10T09:00:00+00:00",
      trackingNumbers: [],
      shippingMethods: [],
    })).resolves.toEqual({
      dispatchRefId: "ref-1",
      fulfillmentOrderId: "ful-1",
      orderId: "order-1",
      providerOrderId: "provider-order-1",
    });

    expect(client.calls).toContainEqual(expect.objectContaining({
      table: "omnipack_dispatch_refs",
      op: "select",
      filters: expect.objectContaining({
        provider_kind: "omnipack",
        provider_order_id: "provider-order-1",
      }),
    }));
  });

  it("does not scan sanitized dispatch evidence when provider order id is missing", async () => {
    const client = fakeClient({
      dispatchRef: {
        id: "ref-1",
        fulfillment_order_id: "ful-1",
        order_id: "order-1",
        provider_order_id: "provider-order-1",
      },
    });
    const port = createSupabaseOmnipackWebhookPort(client as unknown as OmnipackWebhookSupabaseClient);

    await expect(port.findDispatchRef({
      provider: "omnipack",
      event: "order.shipped",
      providerOrderId: null,
      orderNumber: null,
      fulfilmentNumber: "FUL-1001",
      occurredAt: "2026-06-10T09:00:00+00:00",
      trackingNumbers: [],
      shippingMethods: [],
    })).resolves.toBeNull();

    expect(client.calls.some((call) => call.table === "omnipack_dispatch_refs")).toBe(false);
  });

  it("records status evidence through the service-role RPC", async () => {
    const client = fakeClient({
      rpcResult: { statusEvidenceId: "status-1", replayed: true },
    });
    const port = createSupabaseOmnipackWebhookPort(client as unknown as OmnipackWebhookSupabaseClient);

    await expect(port.recordStatusEvidence({
      idempotencyKey: "key-1",
      fulfillmentOrderId: "ful-1",
      dispatchRefId: "ref-1",
      providerStatus: "shipping",
      providerSubStatus: "order.shipped",
      localStatus: "in_transit",
      occurredAt: "2026-06-10T09:00:00+00:00",
      inboundProviderEventId: "evt-1",
      sanitizedPayload: { sanitized: true },
    })).resolves.toEqual({ statusEvidenceId: "status-1", replayed: true });

    expect(client.rpc).toHaveBeenCalledWith("omnipack_record_status_evidence", expect.objectContaining({
      p_idempotency_key: "key-1",
      p_fulfillment_order_id: "ful-1",
      p_dispatch_ref_id: "ref-1",
      p_provider_status: "shipping",
      p_evidence_kind: "webhook",
      p_inbound_provider_event_id: "evt-1",
    }));
  });

  it("upserts webhook tracking refs with carrier metadata and records tracking events", async () => {
    const client = fakeClient({
      trackingReadBack: {
        order_id: "order-1",
        provider_kind: "omnipack",
        provider_tracking_id: "INPOST-TRACK-1001",
        tracking_url: "https://inpost.example/track/INPOST-TRACK-1001",
        carrier_kind: "inpost",
        service: "INPOST_PACZKOMAT",
        active: true,
      },
      rpcResult: { replayed: false },
    });
    const port = createSupabaseOmnipackWebhookPort(client as unknown as OmnipackWebhookSupabaseClient);

    await expect(port.recordTrackingReference({
      idempotencyKey: "tracking-key-1",
      orderId: "order-1",
      fulfillmentOrderId: "ful-1",
      trackingNumber: "INPOST-TRACK-1001",
      trackingUrl: "https://inpost.example/track/INPOST-TRACK-1001",
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
        provider_tracking_id: "INPOST-TRACK-1001",
        tracking_url: "https://inpost.example/track/INPOST-TRACK-1001",
        carrier_kind: "inpost",
        service: "INPOST_PACZKOMAT",
        active: true,
      }),
    }));
    expect(client.rpc).toHaveBeenCalledWith("commerce_fulfillment_record_tracking_event", expect.objectContaining({
      p_idempotency_key: "tracking-key-1",
      p_fulfillment_order_id: "ful-1",
      p_status: "in_transit",
      p_provider_tracking_id: "INPOST-TRACK-1001",
      p_metadata: { source: "omnipack_webhook" },
    }));
  });

  it("marks provider stock consumed through the finished-picking RPC without tracking writes", async () => {
    const client = fakeClient({ rpcResult: { status: "packed", replayed: false } });
    const port = createSupabaseOmnipackWebhookPort(client as unknown as OmnipackWebhookSupabaseClient);

    await expect(port.markProviderStockConsumed({
      idempotencyKey: "picked-key",
      fulfillmentOrderId: "ful-1",
    })).resolves.toEqual({ status: "packed", replayed: false });

    expect(client.rpc).toHaveBeenCalledWith("commerce_fulfillment_mark_provider_stock_consumed", expect.objectContaining({
      p_idempotency_key: "picked-key",
      p_fulfillment_order_id: "ful-1",
      p_metadata: { source: "omnipack_webhook", providerEvent: "finished_picking" },
    }));
    expect(client.calls.some((call) => call.table === "shipment_external_refs")).toBe(false);
  });
});

function fakeClient(options: {
  inboundExisting?: Record<string, unknown> | null;
  dispatchRef?: Record<string, unknown> | null;
  trackingReadBack?: Record<string, unknown> | null;
  rpcResult?: Record<string, unknown>;
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
        limit: vi.fn(() => {
          if (table === "omnipack_dispatch_refs") {
            throw new Error("dispatch_ref_scan_forbidden");
          }
          calls.push({ table, op: state.op, values: state.values, filters: state.filters });
          return Promise.resolve(result([]));
        }),
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
        update: vi.fn((values: Record<string, unknown>) => {
          state.op = "update";
          state.values = values;
          return builder;
        }),
        maybeSingle: vi.fn(() => {
          calls.push({ table, op: state.op, values: state.values, filters: state.filters });
          if (table === "inbound_provider_events" && state.op === "select") {
            return Promise.resolve(result(options.inboundExisting ?? null));
          }
          if (table === "inbound_provider_events" && state.op === "insert") {
            return Promise.resolve(result({ id: "evt-inserted" }));
          }
          if (table === "omnipack_dispatch_refs") {
            return Promise.resolve(result(options.dispatchRef ?? null));
          }
          if (table === "shipment_external_refs" && state.op === "select") {
            return Promise.resolve(result(options.trackingReadBack ?? null));
          }
          return Promise.resolve(result({ id: "evt-updated" }));
        }),
        then: undefined,
      };
      return builder;
    },
    rpc: vi.fn(async () => ({ data: options.rpcResult ?? { statusEvidenceId: "status-1", replayed: false }, error: null })),
  };
  return client;
}

function result(data: unknown) {
  return { data, error: null };
}
