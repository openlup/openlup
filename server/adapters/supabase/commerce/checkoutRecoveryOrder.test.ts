import { describe, expect, it } from "vitest";
import {
  createSupabaseCheckoutRecoveryOrderPort,
  type CheckoutRecoveryOrderSupabaseClient,
} from "./checkoutRecoveryOrder.js";

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const INTENT_ID = "22222222-2222-4222-8222-222222222222";

type Row = Record<string, unknown>;

function fakeClient(opts: {
  order?: Row | null;
  orderError?: string;
  items?: Row[];
  itemError?: string;
  intents?: Row[];
  intentError?: string;
  attempt?: Row | null;
}): CheckoutRecoveryOrderSupabaseClient {
  function builder(table: string) {
    const rows = table === "commerce_order_items" ? opts.items ?? [itemRow()] : [];
    const rowsError = table === "commerce_order_items" ? opts.itemError : undefined;
    const chain = {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      then: <TResult1 = unknown, TResult2 = never>(
        onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ) => Promise.resolve(
        rowsError
          ? { data: null, error: { message: rowsError } }
          : { data: rows, error: null },
      ).then(onfulfilled, onrejected),
      maybeSingle: async () =>
        table === "commerce_payment_attempts"
          ? { data: opts.attempt ?? null, error: null }
          : opts.orderError
          ? { data: null, error: { message: opts.orderError } }
          : { data: opts.order ?? null, error: null },
      limit: async () =>
        opts.intentError
          ? { data: null, error: { message: opts.intentError } }
          : { data: opts.intents ?? [], error: null },
    };
    void table;
    return chain as never;
  }
  return { from: <T>(table: string) => builder(table) as T };
}

function itemRow(overrides: Row = {}): Row {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    quantity: 1,
    unit_price_cents: 14900,
    total_cents: 14900,
    discount_allocated_cents: 0,
    effective_total_cents: 14900,
    effective_net_cents: 13796,
    vat_rate_bps: 800,
    ...overrides,
  };
}

function orderRow(overrides: Row = {}): Row {
  return {
    id: ORDER_ID,
    order_number: "OPENLUP-11111111",
    status: "pending_payment",
    currency: "PLN",
    subtotal_cents: 14900,
    discount_cents: 0,
    shipping_cents: 0,
    shipping_discount_cents: 0,
    tax_cents: 1104,
    total_cents: 14900,
    created_at: "2026-06-25T10:00:00.000Z",
    metadata: { petName: "Lidka", cadenceDays: 30 },
    mode: "subscription_cycle",
    subscription_id: "sub-1",
    ...overrides,
  };
}

function intentRow(overrides: Row = {}): Row {
  return {
    id: INTENT_ID,
    status: "failed",
    subscription_cycle_id: "cycle-1",
    updated_at: "2026-06-25T10:05:00.000Z",
    ...overrides,
  };
}

describe("supabase checkout-recovery order port (W4)", () => {
  it("returns null when the order is missing", async () => {
    const port = createSupabaseCheckoutRecoveryOrderPort(fakeClient({ order: null }));
    expect(await port.getRecoveryOrder({ orderId: ORDER_ID })).toBeNull();
  });

  it("throws when the order read errors", async () => {
    const port = createSupabaseCheckoutRecoveryOrderPort(fakeClient({ orderError: "boom" }));
    await expect(port.getRecoveryOrder({ orderId: ORDER_ID })).rejects.toThrow(/commerce_orders/);
  });

  it("fails closed before recovery payment when frozen header money is unreconciled", async () => {
    const port = createSupabaseCheckoutRecoveryOrderPort(
      fakeClient({
        order: orderRow({
          subtotal_cents: 10_000,
          discount_cents: 1_000,
          total_cents: 10_000,
        }),
        intents: [intentRow()],
      }),
    );

    await expect(port.getRecoveryOrder({ orderId: ORDER_ID })).rejects.toThrow(
      "checkout_recovery_order_money_unreconciled:header_equation_mismatch",
    );
  });

  it("fails closed before reading the intent when an item canonical trio is missing", async () => {
    const port = createSupabaseCheckoutRecoveryOrderPort(
      fakeClient({
        order: orderRow(),
        items: [itemRow({ effective_total_cents: null })],
        intentError: "intent must not be read",
      }),
    );

    await expect(port.getRecoveryOrder({ orderId: ORDER_ID })).rejects.toThrow(
      /checkout_recovery_order_money_unreconciled:missing_item_canonical_money/,
    );
  });

  it("reads a subscription order + its newest open intent", async () => {
    const port = createSupabaseCheckoutRecoveryOrderPort(
      fakeClient({ order: orderRow(), intents: [intentRow()] }),
    );
    const snap = await port.getRecoveryOrder({ orderId: ORDER_ID });
    expect(snap).toMatchObject({
      orderId: ORDER_ID,
      mode: "subscription_cycle",
      totalMinor: 14900,
      currency: "PLN",
      petName: "Lidka",
      cadenceDays: 30,
      paymentIntentId: INTENT_ID,
      paymentIntentStatus: "failed",
      subscriptionCycleId: "cycle-1",
    });
  });

  it("classifies a non-subscription order as one_time_order", async () => {
    const port = createSupabaseCheckoutRecoveryOrderPort(
      fakeClient({
        order: orderRow({ mode: "one_time", subscription_id: null }),
        intents: [intentRow({ subscription_cycle_id: null })],
      }),
    );
    const snap = await port.getRecoveryOrder({ orderId: ORDER_ID });
    expect(snap?.mode).toBe("one_time_order");
  });

  it("yields no intent when the newest intent is terminal (swept order)", async () => {
    const port = createSupabaseCheckoutRecoveryOrderPort(
      fakeClient({ order: orderRow(), intents: [intentRow({ status: "expired" })] }),
    );
    const snap = await port.getRecoveryOrder({ orderId: ORDER_ID });
    expect(snap?.paymentIntentId).toBeNull();
    expect(snap?.paymentIntentStatus).toBeNull();
  });

  it("marks pending_payment orders with expired payment metadata as technically expired", async () => {
    const port = createSupabaseCheckoutRecoveryOrderPort(
      fakeClient({
        order: orderRow({
          status: "pending_payment",
          metadata: { paymentStatus: "expired", failureReason: "simulator_expired" },
        }),
        intents: [intentRow()],
      }),
    );
    const snap = await port.getRecoveryOrder({ orderId: ORDER_ID });
    expect(snap?.status).toBe("pending_payment");
    expect(snap?.technicallyExpired).toBe(true);
  });

  it("retains terminal provider evidence for the pre-recreation PSP readback", async () => {
    const port = createSupabaseCheckoutRecoveryOrderPort(fakeClient({
      order: orderRow(),
      intents: [intentRow({
        status: "expired",
        active_attempt_id: "44444444-4444-4444-8444-444444444444",
        provider_payment_id: "pi_expired",
      })],
      attempt: {
        id: "44444444-4444-4444-8444-444444444444",
        provider: "stripe",
        provider_attempt_id: "pi_expired",
      },
    }));

    expect((await port.getRecoveryOrder({ orderId: ORDER_ID }))?.priorPaymentEvidence).toEqual({
      paymentIntentId: INTENT_ID,
      paymentAttemptId: "44444444-4444-4444-8444-444444444444",
      provider: "stripe",
      providerPaymentId: "pi_expired",
      idempotencyKey: undefined,
      retryRequestId: null,
    });
  });

  it("reads the buyer contact from the finalized invoiceBuyerSnapshot (for the re-pay payer)", async () => {
    const port = createSupabaseCheckoutRecoveryOrderPort(
      fakeClient({
        order: orderRow({
          metadata: {
            petName: "Lidka",
            runtimeFinalize: { invoiceBuyerSnapshot: { email: "anna@example.com", name: "Anna Kowalska" } },
          },
        }),
        intents: [intentRow()],
      }),
    );
    const snap = await port.getRecoveryOrder({ orderId: ORDER_ID });
    expect(snap?.customerEmail).toBe("anna@example.com");
    expect(snap?.customerName).toBe("Anna Kowalska");
    expect(snap?.invoiceBuyerSnapshot).toEqual({ email: "anna@example.com", name: "Anna Kowalska" });
  });

  it("falls back to a top-level invoiceBuyerSnapshot and nulls when absent", async () => {
    const withFlat = createSupabaseCheckoutRecoveryOrderPort(
      fakeClient({
        order: orderRow({ metadata: { invoiceBuyerSnapshot: { email: "b@example.com", name: "Bo" } } }),
        intents: [intentRow()],
      }),
    );
    expect((await withFlat.getRecoveryOrder({ orderId: ORDER_ID }))?.customerEmail).toBe("b@example.com");

    const without = createSupabaseCheckoutRecoveryOrderPort(
      fakeClient({ order: orderRow({ metadata: {} }), intents: [intentRow()] }),
    );
    const snap = await without.getRecoveryOrder({ orderId: ORDER_ID });
    expect(snap?.customerEmail).toBeNull();
    expect(snap?.customerName).toBeNull();
  });
});
