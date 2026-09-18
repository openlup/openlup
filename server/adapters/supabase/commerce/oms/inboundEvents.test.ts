import { describe, expect, it } from "vitest";
import type { OmsOrderRow } from "../../../../../src/domains/commerce/omsReadModel.js";
import { CommerceOmsPersistenceError } from "../../../../../src/domains/commerce/omsPorts.js";
import { ORDER_A } from "./readQueries.fixtures.js";
import { FakeOmsClient } from "./readQueriesTestKit.js";
import { readOmnipackInboundEvents } from "./inboundEvents.js";

const ORDER_ROW = ORDER_A as OmsOrderRow;

describe("supabase commerce OMS inbound provider event helper", () => {
  it("reads recent OmniPack inbound events and filters them to the OMS order evidence", async () => {
    const client = new FakeOmsClient({
      rpcData: {},
      rows: {
        inbound_provider_events: [
          {
            id: "evt-1",
            provider: "omnipack",
            provider_event_id: "order.shipped:provider-order-1",
            event_type: "order.shipped",
            processing_status: "ignored",
            payload: { providerOrderId: "provider-order-1", orderNumber: ORDER_A.order_number },
            error: { reason: "omnipack_dispatch_ref_not_found" },
            created_at: "2026-06-05T10:40:00+00:00",
          },
          {
            id: "evt-2",
            provider: "omnipack",
            provider_event_id: "other",
            event_type: "order.shipped",
            processing_status: "processed",
            payload: { providerOrderId: "other" },
            error: null,
            created_at: "2026-06-05T10:41:00+00:00",
          },
        ],
      },
    });

    const rows = await readOmnipackInboundEvents(client, {
      order: ORDER_ROW,
      dispatchRefs: [{ fulfillment_order_id: "fulfillment-1", provider_order_id: "provider-order-1" }],
    });

    expect(rows.map((row) => row.id)).toEqual(["evt-1"]);
    expect(client.filters).toContainEqual({
      table: "inbound_provider_events",
      kind: "eq",
      column: "provider",
      value: "omnipack",
    });
    expect(client.rangeCalls).toContainEqual({ table: "inbound_provider_events", from: 0, to: 49 });
  });

  it("treats missing optional inbound provider event storage as empty evidence", async () => {
    const client = new FakeOmsClient({
      rpcData: {},
      rows: {},
      selectErrors: [{
        table: "inbound_provider_events",
        whenColumnsInclude: "provider_event_id",
        error: { code: "42P01", message: "relation inbound_provider_events does not exist" },
      }],
    });

    await expect(readOmnipackInboundEvents(client, { order: ORDER_ROW, dispatchRefs: [] })).resolves.toEqual([]);
  });

  it("raises OMS persistence errors for non-optional inbound read failures", async () => {
    const client = new FakeOmsClient({
      rpcData: {},
      rows: {},
      selectErrors: [{
        table: "inbound_provider_events",
        whenColumnsInclude: "provider_event_id",
        error: { code: "XX000", message: "boom" },
      }],
    });

    await expect(readOmnipackInboundEvents(client, { order: ORDER_ROW, dispatchRefs: [] })).rejects.toBeInstanceOf(
      CommerceOmsPersistenceError,
    );
  });
});
