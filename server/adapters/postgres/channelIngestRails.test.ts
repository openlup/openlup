import { describe, expect, it } from "vitest";
import {
  createPostgresChannelIngestOrderItemRead,
  createPostgresChannelIngestPayments,
  createPostgresChannelIngestRails,
  createPostgresChannelIngestReservations,
} from "./channelIngestRails.js";
import type { ManagedChannelRailsClient } from "../supabase/channelIngestRails.js";

// The value of this lane is what it REFUSES, so that is what is pinned. A future edit that made a
// missing capability return a fabricated id would let an order reach `paid` with no stock held, and
// these cases are what stands between that edit and a shipped parcel.

function runner(rows: unknown[]) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    order: () => builder,
    then: (onfulfilled: (value: { data: unknown; error: null }) => unknown) =>
      Promise.resolve(onfulfilled({ data: rows, error: null })),
  } as unknown as ReturnType<ManagedChannelRailsClient["from"]>;
  const client = {
    from: () => builder,
    rpc: () => Promise.resolve({ data: null, error: null }),
  } as ManagedChannelRailsClient;
  return <T>(work: (given: ManagedChannelRailsClient) => Promise<T>): Promise<T> => work(client);
}

describe("direct-postgres channel ingest rails", () => {
  it("binds the order-item read, because this catalogue authors that table", async () => {
    const read = createPostgresChannelIngestOrderItemRead(
      runner([{ id: "item-1", sku_id: "sku-1", quantity: 4 }]),
    );
    await expect(read.readOrderItems("order-1")).resolves.toEqual([
      { orderItemId: "item-1", skuId: "sku-1", quantity: 4 },
    ]);
  });

  it("refuses reservations by the name of the boundary this catalogue does not author", async () => {
    await expect(
      createPostgresChannelIngestReservations().reserveChannelOrderItems({
        idempotencyKey: "k-12345678",
        orderId: "order-1",
        items: [],
        providerKind: null,
      }),
    ).rejects.toThrow(/inventory_reserve_order_items/);
  });

  it("refuses every payment-control call by name", async () => {
    const payments = createPostgresChannelIngestPayments();
    await expect(
      payments.createIntent({ idempotencyKey: "k-12345678", orderId: "o", amountMinor: 1, currency: "EUR", metadata: {} }),
    ).rejects.toThrow(/commerce_payment_control_create_intent/);
    await expect(
      payments.recordAttempt({
        idempotencyKey: "k-12345678",
        paymentIntentId: "i",
        provider: "channel_settlement",
        providerAttemptId: "p",
        requestPayload: {},
        responsePayload: {},
      }),
    ).rejects.toThrow(/commerce_payment_control_record_attempt/);
    await expect(
      payments.ingestSettlementEvent({
        provider: "channel_settlement",
        providerEventId: "e",
        providerPaymentId: "p",
        paymentIntentId: "i",
        amountMinor: 1,
        currency: "EUR",
        payload: {},
      }),
    ).rejects.toThrow(/commerce_payment_control_ingest_event/);
    await expect(
      payments.applySucceeded({
        idempotencyKey: "k-12345678",
        orderId: "o",
        paymentIntentId: "i",
        paymentEventId: "e",
        occurredAt: "2026-08-14T09:05:00Z",
      }),
    ).rejects.toThrow(/commerce_payment_control_apply_result/);
  });

  it("says WHY it refuses, not just that it does", async () => {
    await expect(
      createPostgresChannelIngestReservations().reserveChannelOrderItems({
        idempotencyKey: "k-12345678",
        orderId: "order-1",
        items: [],
        providerKind: null,
      }),
    ).rejects.toThrow(/not authored in the platform migration catalogue/);
  });

  it("binds one rail and refuses two", () => {
    const rails = createPostgresChannelIngestRails(runner([]));
    expect(typeof rails.orderItems.readOrderItems).toBe("function");
    expect(typeof rails.reservations.reserveChannelOrderItems).toBe("function");
    expect(typeof rails.payments.createIntent).toBe("function");
  });
});
