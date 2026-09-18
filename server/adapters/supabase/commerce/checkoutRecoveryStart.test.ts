import { describe, expect, it } from "vitest";
import {
  createSupabaseCheckoutRecoveryStartPort,
  type CheckoutRecoveryStartSupabaseClient,
} from "./checkoutRecoveryStart.js";

const USER_ID = "44444444-4444-4444-8444-444444444444";
const CLIENT_ID = "33333333-3333-4333-8333-333333333333";
const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const SUBSCRIPTION_ID = "55555555-5555-4555-8555-555555555555";

type Row = Record<string, unknown>;

/** Records the eq() filters applied so the test can assert the ownership scope. */
function fakeClient(opts: {
  client?: Row | null;
  clientError?: string;
  orders?: Row[];
  subscriptions?: Row[];
  orderError?: string;
  subscriptionError?: string;
  eqLog?: Array<[string, unknown]>;
  inLog?: Array<[string, readonly unknown[]]>;
}): CheckoutRecoveryStartSupabaseClient {
  function builder(table: string) {
    const chain = {
      select: () => chain,
      eq: (column: string, value: unknown) => {
        opts.eqLog?.push([`${table}.${column}`, value]);
        return chain;
      },
      in: (column: string, values: readonly unknown[]) => {
        opts.inLog?.push([`${table}.${column}`, values]);
        return chain;
      },
      order: () => chain,
      maybeSingle: async () =>
        opts.clientError
          ? { data: null, error: { message: opts.clientError } }
          : { data: opts.client ?? null, error: null },
      limit: async () =>
        table === "subscriptions" && opts.subscriptionError
          ? { data: null, error: { message: opts.subscriptionError } }
          : opts.orderError && table !== "subscriptions"
            ? { data: null, error: { message: opts.orderError } }
          : { data: table === "subscriptions" ? opts.subscriptions ?? [] : opts.orders ?? [], error: null },
    };
    return chain as never;
  }
  return { from: (table: string) => builder(table) as never };
}

function orderRow(overrides: Row = {}): Row {
  return {
    id: ORDER_ID,
    created_at: "2026-06-25T10:00:00.000Z",
    mode: "subscription_cycle",
    status: "pending_payment",
    subscription_id: null,
    ...overrides,
  };
}

function buildPort(opts: Parameters<typeof fakeClient>[0]) {
  // customerClient resolves the client row; serviceClient reads the order.
  const customerClient = fakeClient({ client: opts.client, clientError: opts.clientError });
  const serviceClient = fakeClient({
    orders: opts.orders,
    subscriptions: opts.subscriptions,
    orderError: opts.orderError,
    subscriptionError: opts.subscriptionError,
    eqLog: opts.eqLog,
    inLog: opts.inLog,
  });
  return createSupabaseCheckoutRecoveryStartPort({ customerClient, serviceClient });
}

describe("supabaseCheckoutRecoveryStartPort (W5)", () => {
  it("returns the newest pending order scoped to the resolved client", async () => {
    const eqLog: Array<[string, unknown]> = [];
    const port = buildPort({ client: { id: CLIENT_ID }, orders: [orderRow()], eqLog });

    const result = await port.findRecoverableOrder({
      userId: USER_ID,
      subscriptionId: SUBSCRIPTION_ID,
    });

    expect(result).toEqual({
      orderId: ORDER_ID,
      createdAt: "2026-06-25T10:00:00.000Z",
      mode: "subscription_cycle",
      subscriptionId: null,
      clientHasLiveOrPendingSubscription: true,
    });
    // Ownership: the order read filters on the resolved client id + status.
    expect(eqLog).toContainEqual(["commerce_orders.client_id", CLIENT_ID]);
    expect(eqLog).toContainEqual(["commerce_orders.subscription_id", SUBSCRIPTION_ID]);
    expect(eqLog).toContainEqual(["commerce_orders.status", "pending_payment"]);
  });

  it("returns null when the auth user has no linked client", async () => {
    const port = buildPort({ client: null, orders: [orderRow()] });
    const result = await port.findRecoverableOrder({ userId: USER_ID, subscriptionId: SUBSCRIPTION_ID });
    expect(result).toBeNull();
  });

  it("returns null when there is no pending order for the subscription", async () => {
    const port = buildPort({ client: { id: CLIENT_ID }, orders: [] });
    const result = await port.findRecoverableOrder({ userId: USER_ID, subscriptionId: SUBSCRIPTION_ID });
    expect(result).toBeNull();
  });

  it("defaults a one_time_order row's mode through", async () => {
    const port = buildPort({
      client: { id: CLIENT_ID },
      orders: [orderRow({ mode: "one_time_order" })],
    });
    const result = await port.findRecoverableOrder({ userId: USER_ID, subscriptionId: SUBSCRIPTION_ID });
    expect(result?.mode).toBe("one_time_order");
  });

  it("throws when the client lookup errors", async () => {
    const port = buildPort({ clientError: "rls denied" });
    await expect(
      port.findRecoverableOrder({ userId: USER_ID, subscriptionId: SUBSCRIPTION_ID }),
    ).rejects.toThrow(/clients: rls denied/);
  });

  it("throws when the order read errors", async () => {
    const port = buildPort({ client: { id: CLIENT_ID }, orderError: "boom" });
    await expect(
      port.findRecoverableOrder({ userId: USER_ID, subscriptionId: SUBSCRIPTION_ID }),
    ).rejects.toThrow(/commerce_orders: boom/);
  });

  it("returns null when the order row is missing an id or created_at", async () => {
    const port = buildPort({ client: { id: CLIENT_ID }, orders: [orderRow({ id: null })] });
    expect(await port.findRecoverableOrder({ userId: USER_ID, subscriptionId: SUBSCRIPTION_ID })).toBeNull();
  });

  describe("findRecoverableOrderById (orders-list CTA)", () => {
    it("returns the order scoped to the resolved client + status, filtered by order id", async () => {
      const eqLog: Array<[string, unknown]> = [];
      const port = buildPort({
        client: { id: CLIENT_ID },
        orders: [orderRow({ mode: "one_time_order" })],
        eqLog,
      });

      const result = await port.findRecoverableOrderById({ userId: USER_ID, orderId: ORDER_ID });

      expect(result).toEqual({
        orderId: ORDER_ID,
        createdAt: "2026-06-25T10:00:00.000Z",
        mode: "one_time_order",
        subscriptionId: null,
        clientHasLiveOrPendingSubscription: false,
      });
      expect(eqLog).toContainEqual(["commerce_orders.id", ORDER_ID]);
      expect(eqLog).toContainEqual(["commerce_orders.client_id", CLIENT_ID]);
      expect(eqLog).toContainEqual(["commerce_orders.status", "pending_payment"]);
    });

    it("keeps a subscription_cycle row's mode (first-cycle order in the list)", async () => {
      const port = buildPort({
        client: { id: CLIENT_ID },
        orders: [orderRow({ mode: "subscription_cycle", subscription_id: SUBSCRIPTION_ID })],
      });
      const result = await port.findRecoverableOrderById({ userId: USER_ID, orderId: ORDER_ID });
      expect(result?.mode).toBe("subscription_cycle");
      expect(result?.subscriptionId).toBe(SUBSCRIPTION_ID);
    });

    it("marks an order-id result as account-context when the client has a live subscription", async () => {
      const inLog: Array<[string, readonly unknown[]]> = [];
      const port = buildPort({
        client: { id: CLIENT_ID },
        orders: [orderRow({ mode: "one_time_order", subscription_id: null })],
        subscriptions: [{ id: SUBSCRIPTION_ID }],
        inLog,
      });

      const result = await port.findRecoverableOrderById({ userId: USER_ID, orderId: ORDER_ID });

      expect(result?.clientHasLiveOrPendingSubscription).toBe(true);
      expect(inLog[0]?.[0]).toBe("subscriptions.status");
      expect(inLog[0]?.[1]).toEqual([
        "pending_activation",
        "active",
        "paused",
        "activation_failed",
      ]);
    });

    it("returns null when the auth user has no linked client (ownership)", async () => {
      const port = buildPort({ client: null, orders: [orderRow()] });
      expect(await port.findRecoverableOrderById({ userId: USER_ID, orderId: ORDER_ID })).toBeNull();
    });

    it("returns null when the order is not pending/owned (no row)", async () => {
      const port = buildPort({ client: { id: CLIENT_ID }, orders: [] });
      expect(await port.findRecoverableOrderById({ userId: USER_ID, orderId: ORDER_ID })).toBeNull();
    });

    it("reads owned non-recoverable order context without filtering on status", async () => {
      const eqLog: Array<[string, unknown]> = [];
      const port = buildPort({
        client: { id: CLIENT_ID },
        orders: [orderRow({ mode: "subscription_cycle", status: "cancelled", subscription_id: SUBSCRIPTION_ID })],
        eqLog,
      });

      await expect(port.findOwnedOrderContextById({ userId: USER_ID, orderId: ORDER_ID })).resolves.toEqual({
        orderId: ORDER_ID,
        mode: "subscription_cycle",
        subscriptionId: SUBSCRIPTION_ID,
        clientHasLiveOrPendingSubscription: false,
      });
      expect(eqLog).toContainEqual(["commerce_orders.id", ORDER_ID]);
      expect(eqLog).toContainEqual(["commerce_orders.client_id", CLIENT_ID]);
      expect(eqLog).not.toContainEqual(["commerce_orders.status", "pending_payment"]);
    });

    it("can answer customer subscription context even when there is no order", async () => {
      const port = buildPort({
        client: { id: CLIENT_ID },
        orders: [],
        subscriptions: [{ id: SUBSCRIPTION_ID }],
      });
      await expect(port.clientHasLiveOrPendingSubscription({ userId: USER_ID })).resolves.toBe(true);
    });
  });
});
