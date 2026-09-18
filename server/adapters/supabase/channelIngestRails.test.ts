import { describe, expect, it } from "vitest";
import {
  createManagedChannelIngestOrderItemRead,
  createManagedChannelIngestPayments,
  createManagedChannelIngestRails,
  createManagedChannelIngestReservations,
  type ManagedChannelRailsClient,
} from "./channelIngestRails.js";

// These cases pin the three judgments the shim makes — the reservation lane, the state that
// justifies the hold, and the attempt status — because they are the whole reason this file exists
// rather than a reuse of the checkout ports. A container run proves the SQL accepts them; this
// proves nothing quietly changes them.

type Call = { name: string; args: Record<string, unknown> };

function client(
  responses: Record<string, unknown>,
  calls: Call[],
  rows: unknown[] = [],
  failure: Record<string, { code?: string; message?: string }> = {},
): ManagedChannelRailsClient {
  const builder = {
    select: () => builder,
    eq: () => builder,
    order: () => builder,
    then: (onfulfilled: (value: { data: unknown; error: null }) => unknown) =>
      Promise.resolve(onfulfilled({ data: rows, error: null })),
  } as unknown as ReturnType<ManagedChannelRailsClient["from"]>;
  return {
    from: () => builder,
    rpc(name, args) {
      calls.push({ name, args });
      const error = failure[name] ?? null;
      return Promise.resolve({ data: error ? null : responses[name] ?? null, error });
    },
  };
}

describe("managed channel ingest rails", () => {
  it("reserves on the channel lane, under the state that justifies the hold", async () => {
    const calls: Call[] = [];
    const rails = createManagedChannelIngestReservations(
      client({ inventory_reserve_order_items: { reservations: [{}, {}] } }, calls),
    );
    const result = await rails.reserveChannelOrderItems({
      idempotencyKey: "ch:c1:ord:E1:inventory",
      orderId: "order-1",
      items: [{ orderItemId: "item-1", skuId: "sku-1", quantity: 2 }],
      metadata: { source: "channels.ingest.v0" },
      providerKind: "simulator",
    });

    expect(result.reservedItemCount).toBe(2);
    expect(calls[0].name).toBe("inventory_reserve_order_items");
    expect(calls[0].args.p_kind).toBe("channel_order_window");
    expect(calls[0].args.p_payment_status).toBe("succeeded");
    expect(calls[0].args.p_expires_at).toBeNull();
    expect(calls[0].args.p_subscription_cycle_id).toBeNull();
  });

  it("lets the stock refusal through with its raised name intact", async () => {
    const calls: Call[] = [];
    const rails = createManagedChannelIngestReservations(
      client({}, calls, [], {
        inventory_reserve_order_items: {
          code: "23514",
          message: "inventory_reservation_insufficient_available_stock",
        },
      }),
    );
    await expect(
      rails.reserveChannelOrderItems({
        idempotencyKey: "k-12345678",
        orderId: "o",
        items: [],
        providerKind: null,
      }),
    ).rejects.toThrow(/inventory_reservation_insufficient_available_stock/);
  });

  it("reads the order's items in allocation order and refuses one without a SKU", async () => {
    const calls: Call[] = [];
    const read = createManagedChannelIngestOrderItemRead(
      client({}, calls, [{ id: "item-1", sku_id: "sku-1", quantity: 3 }]),
    );
    await expect(read.readOrderItems("order-1")).resolves.toEqual([
      { orderItemId: "item-1", skuId: "sku-1", quantity: 3 },
    ]);

    const broken = createManagedChannelIngestOrderItemRead(
      client({}, calls, [{ id: "item-1", sku_id: null, quantity: 3 }]),
    );
    await expect(broken.readOrderItems("order-1")).rejects.toThrow(/order_item_without_sku/);
  });

  it("records the attempt as processing, with the channel's settlement kind as its provider", async () => {
    const calls: Call[] = [];
    const payments = createManagedChannelIngestPayments(
      client({ commerce_payment_control_record_attempt: { paymentAttempt: { id: "attempt-1" } } }, calls),
    );
    const result = await payments.recordAttempt({
      idempotencyKey: "ch:c1:ord:E1:payment-attempt",
      paymentIntentId: "intent-1",
      provider: "channel_settlement",
      providerAttemptId: "PAY-1",
      requestPayload: {},
      responsePayload: { providerCall: false },
    });

    expect(result.paymentAttemptId).toBe("attempt-1");
    expect(calls[0].args.p_attempt_status).toBe("processing");
    expect(calls[0].args.p_provider).toBe("channel_settlement");
    expect(calls[0].args.p_provider_session_id).toBeNull();
    expect(calls[0].args.p_next_action_kind).toBeNull();
  });

  it("ingests the settlement event as already verified, under the channel's own provider", async () => {
    const calls: Call[] = [];
    const payments = createManagedChannelIngestPayments(
      client({ commerce_payment_control_ingest_event: { paymentEvent: { id: "event-1" } } }, calls),
    );
    const result = await payments.ingestSettlementEvent({
      provider: "channel_settlement",
      providerEventId: "PAY-1:settlement",
      providerPaymentId: "PAY-1",
      paymentIntentId: "intent-1",
      amountMinor: 2400,
      currency: "EUR",
      payload: {},
    });

    expect(result.paymentEventId).toBe("event-1");
    expect(calls[0].args.p_event_type).toBe("payment.succeeded");
    expect(calls[0].args.p_signature_verified).toBe(true);
    expect(calls[0].args.p_provider).toBe("channel_settlement");
  });

  it("creates the intent as a one-time order with no subscription anywhere in sight", async () => {
    const calls: Call[] = [];
    const payments = createManagedChannelIngestPayments(
      client(
        { commerce_payment_control_create_intent: { paymentIntent: { id: "intent-1", paymentId: "pay-1", status: "created" } } },
        calls,
      ),
    );
    await expect(
      payments.createIntent({
        idempotencyKey: "ch:c1:ord:E1:payment-intent",
        orderId: "order-1",
        amountMinor: 2400,
        currency: "EUR",
        metadata: {},
      }),
    ).resolves.toEqual({ paymentIntentId: "intent-1" });
    expect(calls[0].args.p_target_kind).toBe("one_time_order");
    expect(calls[0].args.p_subscription_id).toBeNull();
    expect(calls[0].args.p_subscription_cycle_id).toBeNull();
  });

  it("applies the settlement as succeeded, naming the order it belongs to", async () => {
    const calls: Call[] = [];
    const payments = createManagedChannelIngestPayments(
      client(
        {
          commerce_payment_control_apply_result: {
            paymentResult: {
              paymentIntentId: "intent-1",
              paymentAttemptId: "attempt-1",
              paymentId: "pay-1",
              orderId: "order-1",
              status: "succeeded",
              kind: "one_time_order",
            },
          },
        },
        calls,
      ),
    );
    await expect(
      payments.applySucceeded({
        idempotencyKey: "ch:c1:ord:E1:payment-result",
        orderId: "order-1",
        paymentIntentId: "intent-1",
        paymentEventId: "event-1",
        occurredAt: "2026-08-14T09:05:00Z",
      }),
    ).resolves.toEqual({ orderId: "order-1" });
    expect(calls[0].args.p_result_status).toBe("succeeded");
  });

  it("binds all four rails together", () => {
    const rails = createManagedChannelIngestRails(client({}, []));
    expect(typeof rails.reservations.reserveChannelOrderItems).toBe("function");
    expect(typeof rails.orderItems.readOrderItems).toBe("function");
    expect(typeof rails.payments.createIntent).toBe("function");
    expect(typeof rails.bundles?.readActiveBundleCompositions).toBe("function");
  });
});
