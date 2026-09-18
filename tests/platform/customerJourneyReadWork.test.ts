import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ORDER_HEADER_MONEY_COLUMNS } from "../../src/domains/commerce/orderMoney.js";
import {
  getCommerceOmsOrderDetail,
  getCommerceOmsOrderDetails,
} from "../../server/adapters/supabase/commerce/oms/readQueries.js";
import { order, paymentIntent } from "../../server/adapters/supabase/commerce/oms/readQueries.fixtures.js";
import { FakeOmsClient } from "../../server/adapters/supabase/commerce/oms/readQueriesTestKit.js";
import { createSupabaseCustomerJourneySnapshotPort } from "../../server/adapters/supabase/support/supabaseCustomerJourneySnapshotPort.js";

const CANONICAL_ORDER_COLUMNS = `id, order_number, client_id, status, mode, ${ORDER_HEADER_MONEY_COLUMNS}, metadata, created_at, updated_at, subscription_id, subscription_cycle_id, shipping_address_id, pet_id, source_kind, source_order_ref, sales_channels(slug)`;
const CLIENT_A = "10000000-0000-4000-8000-000000000001";
const CLIENT_B = "10000000-0000-4000-8000-000000000002";
const ORIGINAL_PARCEL = "50000000-0000-4000-8000-000000000001";
const REPLACEMENT_PARCEL = "50000000-0000-4000-8000-000000000002";
const ACTION_FLAGS = {
  holdMutationsEnabled: true,
  supportMutationsEnabled: false,
  fulfillmentMutationsEnabled: true,
  refundMutationsEnabled: false,
  orderCancellationEnabled: true,
};

describe("bounded customer journey detail header work", () => {
  beforeEach(() => {
    // Both read strategies must observe the same instant for derived health ages.
    // Keep scheduling real; only the wall clock is part of this fixture.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-05T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does no header work for an empty batch and refuses more than 25 ids", async () => {
    const client = omsClient(detailRows([]));

    await expect(getCommerceOmsOrderDetails(client, [])).resolves.toEqual([]);
    expect(headerSelects(client)).toEqual([]);

    const tooMany = Array.from({ length: 26 }, (_, index) => orderId(index));
    await expect(getCommerceOmsOrderDetails(client, tooMany))
      .rejects.toThrow("Commerce OMS detail batch exceeds 25 orders");
    expect(headerSelects(client)).toEqual([]);
  });

  it("uses one exact canonical header query and maps duplicates and missing rows back in request order", async () => {
    const first = order(orderId(1), "OMS-BATCH-1", { client_id: CLIENT_A });
    const second = order(orderId(2), "OMS-BATCH-2", { client_id: CLIENT_B });
    const missing = orderId(99);
    const client = omsClient(detailRows([first, second]));

    const result = await getCommerceOmsOrderDetails(client, [second.id, first.id, second.id, missing]);

    expect(result.map((entry) => entry?.order.orderId ?? null))
      .toEqual([second.id, first.id, second.id, null]);
    expect(result[0]?.order.customer?.id).toBe(CLIENT_B);
    expect(result[1]?.order.customer?.id).toBe(CLIENT_A);
    expect(headerSelects(client)).toEqual([CANONICAL_ORDER_COLUMNS]);
    expect(client.filters.filter((filter) => filter.table === "commerce_orders" && filter.column === "id"))
      .toEqual([{ table: "commerce_orders", kind: "in", column: "id", value: [second.id, first.id, missing] }]);
  });

  it.each([1, 25])("returns the complete same details as %i single-order reads", async (count) => {
    const orders = Array.from({ length: count }, (_, index) => order(orderId(index), `OMS-EQ-${index}`, {
      client_id: index % 2 === 0 ? CLIENT_A : CLIENT_B,
      source_kind: index % 2 === 0 ? "storefront" : "operator",
      sales_channels: { slug: index % 2 === 0 ? "web" : "support" },
    }));
    const rows = detailRows(orders);
    const batchedClient = omsClient(rows);
    const singlesClient = omsClient(rows);

    const batched = await getCommerceOmsOrderDetails(
      batchedClient,
      orders.map((entry) => entry.id),
      { actionFlags: ACTION_FLAGS },
    );
    const singles = await Promise.all(orders.map((entry) =>
      getCommerceOmsOrderDetail(singlesClient, { orderId: entry.id }, { actionFlags: ACTION_FLAGS })));

    expect(batched).toEqual(singles);
    expect(headerSelects(batchedClient)).toHaveLength(1);
    expect(headerSelects(singlesClient)).toHaveLength(count);
  });

  it("preserves payment histories, replacement parcels, tracking attribution, and optional subscription degradation", async () => {
    const subscriptionId = "60000000-0000-4000-8000-000000000001";
    const subjectOrder = order(orderId(7), "OMS-HISTORY-7", {
      client_id: CLIENT_A,
      subscription_id: subscriptionId,
    });
    const rows = historyRows(subjectOrder, subscriptionId);
    const options = {
      rpcData: {},
      rows,
      selectErrors: [{
        table: "subscriptions",
        whenColumnsInclude: "next_cycle_at",
        error: { code: "42501", message: "permission denied for table subscriptions" },
      }],
    };
    const batchedClient = new FakeOmsClient(options);
    const singleClient = new FakeOmsClient(options);

    const [batched] = await getCommerceOmsOrderDetails(batchedClient, [subjectOrder.id]);
    const single = await getCommerceOmsOrderDetail(singleClient, { orderId: subjectOrder.id });

    expect(batched).toEqual(single);
    expect(batched?.order.paymentAttempts).toHaveLength(1);
    expect(batched?.order.paymentTransitions).toHaveLength(1);
    expect(batched?.order.subscription.nextCycleAt).toBeNull();
    expect(batched?.order.fulfillment.providerTrackingId).toBe("TRACK-CURRENT");
    expect(batched?.order.replacementChain.supersededParcels[0]?.trackingReferences)
      .toEqual([expect.objectContaining({ trackingNumber: "TRACK-ORIGINAL" })]);
  });

  it("preserves canonical header failures and the named currency refusal", async () => {
    const accepted = order(orderId(8), "OMS-HEADER-8");
    const headerFailure = new FakeOmsClient({
      rpcData: {},
      rows: detailRows([accepted]),
      selectErrors: [{
        table: "commerce_orders",
        whenColumnsInclude: "sales_channels(slug)",
        error: { code: "42501", message: "header read refused" },
      }],
    });
    await expect(getCommerceOmsOrderDetails(headerFailure, [accepted.id]))
      .rejects.toThrow("Commerce OMS order detail read failed");

    const requiredRelationFailure = {
      rpcData: {},
      rows: detailRows([accepted]),
      selectErrors: [{
        table: "commerce_order_operations",
        whenColumnsInclude: "operation_type",
        error: { code: "42501", message: "operation history refused" },
      }],
    };
    await expect(getCommerceOmsOrderDetails(new FakeOmsClient(requiredRelationFailure), [accepted.id]))
      .rejects.toThrow("Commerce OMS related detail read failed");
    await expect(getCommerceOmsOrderDetail(new FakeOmsClient(requiredRelationFailure), { orderId: accepted.id }))
      .rejects.toThrow("Commerce OMS related detail read failed");

    const foreign = order(orderId(9), "OMS-EUR-9", { currency: "EUR" });
    await expect(getCommerceOmsOrderDetails(omsClient(detailRows([foreign])), [foreign.id]))
      .rejects.toThrow(`order ${foreign.id} has currency EUR, not accepted by this deployment`);
  });

  it("makes the mounted snapshot consume one batch header while keeping visible evidence", async () => {
    const subscriptionId = "60000000-0000-4000-8000-000000000002";
    const subjectOrder = order(orderId(10), "OMS-SNAPSHOT-10", {
      client_id: CLIENT_A,
      subscription_id: subscriptionId,
    });
    const client = omsClient(historyRows(subjectOrder, subscriptionId));
    const port = createSupabaseCustomerJourneySnapshotPort(client as never);

    const snapshot = await port.snapshot({ clientId: CLIENT_A, pageSize: 25 });

    expect(snapshot?.customer.clientId).toBe(CLIENT_A);
    expect(snapshot?.orders.map((entry) => entry.orderId)).toEqual([subjectOrder.id]);
    expect(snapshot?.payment.attempts).toEqual([
      expect.objectContaining({ orderId: subjectOrder.id, status: "succeeded" }),
    ]);
    expect(snapshot?.payment.transitions).toEqual([
      expect.objectContaining({ orderId: subjectOrder.id, toStatus: "succeeded" }),
    ]);
    expect(snapshot?.orders[0]?.fulfillment.providerTrackingId).toBe("TRACK-CURRENT");
    expect(headerSelects(client)).toEqual([CANONICAL_ORDER_COLUMNS]);
    expect(client.filters).not.toContainEqual(expect.objectContaining({
      table: "commerce_orders", kind: "eq", column: "id", value: subjectOrder.id,
    }));
  });
});

function orderId(index: number): string {
  return `40000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function omsClient(rows: Record<string, unknown[]>): FakeOmsClient {
  return new FakeOmsClient({ rpcData: {}, rows });
}

function headerSelects(client: FakeOmsClient): string[] {
  return client.selects
    .filter((selection) => selection.table === "commerce_orders" && selection.columns === CANONICAL_ORDER_COLUMNS)
    .map((selection) => selection.columns);
}

function detailRows(orders: Array<Record<string, unknown>>): Record<string, unknown[]> {
  return {
    commerce_orders: orders,
    commerce_payment_intents: orders.map((entry) => paymentIntent(String(entry.id))),
    commerce_payment_attempts: [],
    commerce_payment_state_transitions: [],
    commerce_order_holds: [],
    commerce_order_operations: [],
    commerce_order_items: [],
    subscription_cycles: [],
    subscriptions: [],
    inventory_reservations: [],
    commerce_fulfillment_orders: [],
    shipment_external_refs: [],
    clients: [clientRow(CLIENT_A, "Ada"), clientRow(CLIENT_B, "Bea")],
    pets: [],
    addresses: [],
    accounting_invoices: [],
    accounting_invoice_issue_outbox: [],
    communication_email_deliveries: [],
    outbox_events: [],
    inbound_provider_events: [],
  };
}

function historyRows(subjectOrder: Record<string, unknown>, subscriptionId: string): Record<string, unknown[]> {
  const rows = detailRows([subjectOrder]);
  const intent = paymentIntent(String(subjectOrder.id));
  return {
    ...rows,
    commerce_payment_attempts: [{
      id: "70000000-0000-4000-8000-000000000001",
      payment_intent_id: intent.id,
      status: "succeeded",
      provider: "stripe",
      provider_attempt_id: "pi_attempt_1",
      next_action_kind: null,
      updated_at: "2026-06-05T10:02:00+00:00",
    }],
    commerce_payment_state_transitions: [{
      id: "70000000-0000-4000-8000-000000000002",
      payment_intent_id: intent.id,
      transition_kind: "provider_webhook",
      from_status: "processing",
      to_status: "succeeded",
      reason: "confirmed",
      occurred_at: "2026-06-05T10:02:00+00:00",
    }],
    subscriptions: [{ id: subscriptionId, next_cycle_at: "2026-07-05T10:00:00+00:00" }],
    commerce_fulfillment_orders: [
      parcel(String(subjectOrder.id), ORIGINAL_PARCEL),
      parcel(String(subjectOrder.id), REPLACEMENT_PARCEL, {
        sequence_no: 1,
        status: "packed",
        replaces_fulfillment_order_id: ORIGINAL_PARCEL,
        replacement_reason: "lost",
      }),
    ],
    shipment_external_refs: [
      tracking(String(subjectOrder.id), ORIGINAL_PARCEL, "TRACK-ORIGINAL", "2026-06-05T10:03:00+00:00"),
      tracking(String(subjectOrder.id), REPLACEMENT_PARCEL, "TRACK-CURRENT", "2026-06-05T11:03:00+00:00"),
    ],
  };
}

function clientRow(id: string, name: string): Record<string, unknown> {
  return {
    id,
    email: `${name.toLowerCase()}@example.test`,
    first_name: name,
    last_name: "Example",
    phone: null,
    lifecycle_stage: "customer",
    auth_user_id: null,
    created_at: "2026-06-01T10:00:00+00:00",
    updated_at: "2026-06-05T10:00:00+00:00",
  };
}

function parcel(orderIdValue: string, id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    order_id: orderIdValue,
    sequence_no: 0,
    status: "created",
    provider_kind: "omnipack",
    shipping_address_snapshot: null,
    handed_over_at: null,
    delivered_at: null,
    created_at: "2026-06-05T10:00:00+00:00",
    updated_at: "2026-06-05T10:00:00+00:00",
    ...overrides,
  };
}

function tracking(orderIdValue: string, parcelId: string, number: string, at: string): Record<string, unknown> {
  return {
    order_id: orderIdValue,
    fulfillment_order_id: parcelId,
    provider_tracking_id: number,
    active: true,
    provider_kind: "test_carrier",
    carrier_kind: "test_carrier",
    service: "standard",
    tracking_url: null,
    created_at: at,
    updated_at: at,
  };
}
