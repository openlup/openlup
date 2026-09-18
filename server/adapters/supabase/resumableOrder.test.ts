import { describe, expect, it } from "vitest";

import {
  createSupabaseResumableOrderPort,
  type ResumableOrderClient,
} from "./resumableOrder.js";

const JOURNEY_KEY = "checkout:11111111-1111-4111-8111-111111111111";

/** One construction site for the port under test. */
const resumablePort = (client: ResumableOrderClient) => createSupabaseResumableOrderPort(client);

describe("supabase resumable order port", () => {
  it("returns the newest in-flight order and skips settled orders", async () => {
    const { client } = recordingClient({
      commerce_orders: [
        {
          data: [
            { id: "paid-order", status: "paid", created_at: "2026-06-19T12:00:00.000Z", metadata: { selectedDelivery: { providerKind: "dhl" } } },
            { id: "action-order", status: "payment_pending", created_at: "2026-06-19T11:59:00.000Z", metadata: { selectedDelivery: { providerKind: "dhl" } } },
          ],
          error: null,
        },
      ],
      commerce_payment_intents: [
        { data: [{ id: "paid-intent", status: "succeeded", active_attempt_id: "paid-attempt" }], error: null },
        { data: [{ id: "action-intent", status: "requires_action", active_attempt_id: "action-attempt" }], error: null },
      ],
      commerce_payment_attempts: [
        { data: [{ status: "succeeded" }], error: null },
        { data: [{ status: "requires_action" }], error: null },
      ],
    });

    await expect(
      resumablePort(client).findResumableOrderForClient({
        clientId: "client-id",
        withinMinutes: 60,
        now: new Date("2026-06-19T12:00:00.000Z"),
        journeyKey: JOURNEY_KEY,
      }),
    ).resolves.toEqual({
      orderId: "action-order",
      paymentIntentId: "action-intent",
      status: "requires_action",
      metadata: { selectedDelivery: { providerKind: "dhl" } },
      // No key row was stubbed, so this journey produced no order: not mine.
      sameJourney: false,
    });
  });

  it("returns null when the newest order has already settled (paid)", async () => {
    const { client } = recordingClient({
      commerce_orders: [
        { data: [{ id: "paid-order", status: "paid", created_at: "2026-06-19T11:59:00.000Z" }], error: null },
      ],
      commerce_payment_intents: [
        { data: [{ id: "paid-intent", status: "succeeded", active_attempt_id: null }], error: null },
      ],
    });

    await expect(
      resumablePort(client).findResumableOrderForClient({
        clientId: "client-id",
        withinMinutes: 60,
        now: new Date("2026-06-19T12:00:00.000Z"),
        journeyKey: JOURNEY_KEY,
      }),
    ).resolves.toBeNull();
  });

  it("returns null when the newest order's payment has failed", async () => {
    const { client } = recordingClient({
      commerce_orders: [
        { data: [{ id: "failed-order", status: "payment_pending", created_at: "2026-06-19T11:59:00.000Z" }], error: null },
      ],
      commerce_payment_intents: [
        { data: [{ id: "failed-intent", status: "failed", active_attempt_id: "failed-attempt" }], error: null },
      ],
      commerce_payment_attempts: [{ data: [{ status: "failed" }], error: null }],
    });

    await expect(
      resumablePort(client).findResumableOrderForClient({
        clientId: "client-id",
        withinMinutes: 60,
        now: new Date("2026-06-19T12:00:00.000Z"),
        journeyKey: JOURNEY_KEY,
      }),
    ).resolves.toBeNull();
  });

  it("returns null when the client has no recent orders", async () => {
    const { client, calls } = recordingClient({
      commerce_orders: [{ data: [], error: null }],
    });

    await expect(
      resumablePort(client).findResumableOrderForClient({
        clientId: "client-id",
        withinMinutes: 60,
        now: new Date("2026-06-19T12:00:00.000Z"),
        journeyKey: JOURNEY_KEY,
      }),
    ).resolves.toBeNull();

    // The journey lookup is resolved once, up front; no orders means we never
    // go on to intents/attempts.
    expect(calls.map((call) => call.table)).toEqual([
      "commerce_idempotency_keys",
      "commerce_orders",
    ]);
  });

  it.each([
    ["this journey produced it", "order_action-order", true],
    ["another journey produced it", "order_some-other-order", false],
    ["this journey produced nothing yet", undefined, false],
  ])("sets sameJourney when %s", async (_label, storedOrderId, expected) => {
    // The producer records the order id in a PREFIXED form,
    // `'order_' || v_order_id::text` (20260816164246...sql:578), while the order
    // row carries the bare uuid. Getting that wrong makes every journey look
    // foreign — the PERMISSIVE direction — so the exact stored shape is pinned
    // here rather than assumed.
    const { client } = recordingClient({
      commerce_idempotency_keys: [{
        data: storedOrderId === undefined ? [] : [{ metadata: { orderId: storedOrderId } }],
        error: null,
      }],
      commerce_orders: [{
        data: [{ id: "action-order", status: "payment_pending", created_at: "2026-06-19T11:59:00.000Z", metadata: {} }],
        error: null,
      }],
      commerce_payment_intents: [
        { data: [{ id: "action-intent", status: "requires_action", active_attempt_id: "action-attempt" }], error: null },
      ],
      commerce_payment_attempts: [{ data: [{ status: "requires_action" }], error: null }],
    });

    await expect(
      resumablePort(client).findResumableOrderForClient({
        clientId: "client-id",
        withinMinutes: 60,
        now: new Date("2026-06-19T12:00:00.000Z"),
        journeyKey: JOURNEY_KEY,
      }),
    ).resolves.toMatchObject({ sameJourney: expected });
  });

  it("queries the journey key on its unique (scope, idempotency_key) index", async () => {
    const { client, calls } = recordingClient({
      commerce_idempotency_keys: [{ data: [], error: null }],
      commerce_orders: [{ data: [], error: null }],
    });

    await resumablePort(client).findResumableOrderForClient({
      clientId: "client-id",
      withinMinutes: 60,
      now: new Date("2026-06-19T12:00:00.000Z"),
      journeyKey: JOURNEY_KEY,
    });

    expect(calls.find((call) => call.table === "commerce_idempotency_keys")).toMatchObject({
      columns: "metadata",
      filters: [
        { op: "eq", column: "scope", value: "commerce.order_draft.create" },
        { op: "eq", column: "idempotency_key", value: JOURNEY_KEY },
      ],
      limit: 1,
    });
  });

  it("reads a failed journey lookup as NOT this journey, without throwing", async () => {
    // Deliberately the permissive-looking direction, and safe because of where
    // it lands: "not my journey" routes the guard into the cart comparison,
    // which is the STRICTER path. A lookup failure can cost an extra
    // comparison; it can never authorize a resume.
    const { client } = recordingClient({
      commerce_idempotency_keys: [{ data: null, error: { message: "timeout" } }],
      commerce_orders: [{
        data: [{ id: "action-order", status: "payment_pending", created_at: "2026-06-19T11:59:00.000Z", metadata: {} }],
        error: null,
      }],
      commerce_payment_intents: [
        { data: [{ id: "action-intent", status: "requires_action", active_attempt_id: "action-attempt" }], error: null },
      ],
      commerce_payment_attempts: [{ data: [{ status: "requires_action" }], error: null }],
    });

    await expect(
      resumablePort(client).findResumableOrderForClient({
        clientId: "client-id",
        withinMinutes: 60,
        now: new Date("2026-06-19T12:00:00.000Z"),
        journeyKey: JOURNEY_KEY,
      }),
    ).resolves.toMatchObject({ sameJourney: false });
  });

  it("applies the withinMinutes window as a gte on created_at", async () => {
    const { client, calls } = recordingClient({
      commerce_orders: [{ data: [], error: null }],
    });

    await resumablePort(client).findResumableOrderForClient({
      clientId: "client-id",
      withinMinutes: 30,
      now: new Date("2026-06-19T12:00:00.000Z"),
      journeyKey: JOURNEY_KEY,
    });

    const ordersQuery = calls.find((call) => call.table === "commerce_orders");
    expect(ordersQuery).toMatchObject({
      table: "commerce_orders",
      columns: "id, status, created_at, metadata",
      filters: [
        { op: "eq", column: "client_id", value: "client-id" },
        // now (12:00:00Z) minus 30 minutes.
        { op: "gte", column: "created_at", value: "2026-06-19T11:30:00.000Z" },
      ],
      order: { column: "created_at", ascending: false },
      limit: 5,
    });
  });

  it("throws transport errors so the checkout guard can fail open", async () => {
    const { client } = recordingClient({
      commerce_orders: [{ data: null, error: { message: "timeout" } }],
    });

    await expect(
      resumablePort(client).findResumableOrderForClient({
        clientId: "client-id",
        withinMinutes: 60,
        now: new Date("2026-06-19T12:00:00.000Z"),
        journeyKey: JOURNEY_KEY,
      }),
    ).rejects.toThrow("commerce_orders: timeout");
  });
});

type QueryResult = { data: unknown[] | null; error: { message?: string } | null };

type RecordedFilter = { op: "eq" | "gte"; column: string; value: unknown };

type RecordedCall = {
  table: string;
  columns: string;
  filters: RecordedFilter[];
  order: { column: string; ascending: boolean } | null;
  limit: number | null;
};

/**
 * In-memory {@link ResumableOrderClient} that records every chained
 * filter/order/limit per `from(table).select(...)` so tests can assert the
 * query shape (e.g. the `gte` window), and returns canned `{ data, error }`
 * results from a per-table FIFO queue.
 */
function recordingClient(responses: Record<string, QueryResult[]>): {
  client: ResumableOrderClient;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const client = {
    from(table: string) {
      return {
        select(columns: string) {
          const call: RecordedCall = { table, columns, filters: [], order: null, limit: null };
          const queue = responses[table] ?? [];
          const builder = {
            eq(column: string, value: unknown) {
              call.filters.push({ op: "eq", column, value });
              return builder;
            },
            gte(column: string, value: unknown) {
              call.filters.push({ op: "gte", column, value });
              return builder;
            },
            order(column: string, options: { ascending: boolean }) {
              call.order = { column, ascending: options.ascending };
              return builder;
            },
            async limit(count: number) {
              call.limit = count;
              calls.push(call);
              return queue.shift() ?? { data: [], error: null };
            },
          };
          return builder;
        },
      };
    },
  } as ResumableOrderClient;
  return { client, calls };
}
