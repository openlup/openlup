import { describe, expect, it } from "vitest";
import {
  createSupabaseCommerceFulfillmentPort,
  type CommerceFulfillmentSupabaseClient,
  type RpcError,
} from "./commerceFulfillmentPort.js";

type QueryResult = { data: unknown; error: RpcError | null; count?: number | null };
type RowsByTable = Record<string, Array<Record<string, unknown>>>;

const ORDER_ID = "42222222-2222-4222-8222-222222222221";
const FULFILLMENT_ORDER_ID = "52222222-2222-4222-8222-222222222221";
// Deliberately BELOW `FULFILLMENT_ORDER_ID` in id order, so `sequence_no` has to be what decides.
const REPLACEMENT_FULFILLMENT_ID = "52222222-2222-4222-8222-222222222211";
const LOCATION_ID = "b2222222-2222-4222-8222-222222222221";

describe("supabase commerce fulfillment port", () => {
  it("hydrates fulfillment detail inventory location codes without embedded Supabase relations", async () => {
    const selected: Record<string, string> = {};
    const port = createSupabaseCommerceFulfillmentPort(fakeClient({ rows: baseRows(), selected }));

    await expect(port.getCommerceFulfillmentOrderDetail({ orderId: ORDER_ID })).resolves.toMatchObject({
      order: {
        id: FULFILLMENT_ORDER_ID,
        orderId: ORDER_ID,
        inventory: {
          locationId: LOCATION_ID,
          locationCode: "pl-main",
        },
      },
    });

    expect(selected.inventory_reservations).toBe("id, order_id, status, expires_at, location_id");
    expect(selected.inventory_reservations).not.toContain("inventory_locations");
    expect(selected.inventory_locations).toBe("id, code");
  });

  it("keeps fulfillment detail readable when optional inventory location lookup fails", async () => {
    const port = createSupabaseCommerceFulfillmentPort(
      fakeClient({
        rows: baseRows(),
        errors: { inventory_locations: { message: "relationship lookup failed" } },
      }),
    );

    await expect(port.getCommerceFulfillmentOrderDetail({ orderId: ORDER_ID })).resolves.toMatchObject({
      order: {
        id: FULFILLMENT_ORDER_ID,
        inventory: {
          locationId: LOCATION_ID,
          locationCode: null,
        },
      },
    });
  });

  // An order may now hold the original parcel at `sequence_no` 0 and a replacement at 1, 2, ...
  // Each case below pins BOTH answers: the one-row answer, which every order has today and which
  // must not move, and the two-row answer - the highest `sequence_no`, tie-broken by `id`. The
  // replacement's id sorts BELOW the original's, so an `id`-only rule would fail these.
  describe("an order holding a second fulfilment row", () => {
    it("would still fail the by-order read as a single object, which is why it no longer asks for one", async () => {
      const rows = withReplacementParcel(baseRows());
      const client = fakeClient({ rows });

      const asSingleObject = await client
        .from("commerce_fulfillment_orders")
        .select("id, order_id, sequence_no")
        .eq("order_id", ORDER_ID)
        .maybeSingle();

      expect(asSingleObject.error).toMatchObject({ code: "PGRST116" });
      await expect(
        createSupabaseCommerceFulfillmentPort(client).getCommerceFulfillmentOrderDetail({ orderId: ORDER_ID }),
      ).resolves.not.toBeNull();
    });

    it("resolves the by-order read to the only parcel with one row and to the replacement with two", async () => {
      const withOne = createSupabaseCommerceFulfillmentPort(fakeClient({ rows: baseRows() }));
      const withTwo = createSupabaseCommerceFulfillmentPort(
        fakeClient({ rows: withReplacementParcel(baseRows()) }),
      );

      await expect(withOne.getCommerceFulfillmentOrderDetail({ orderId: ORDER_ID })).resolves.toMatchObject({
        order: { id: FULFILLMENT_ORDER_ID, status: "created" },
      });
      await expect(withTwo.getCommerceFulfillmentOrderDetail({ orderId: ORDER_ID })).resolves.toMatchObject({
        order: { id: REPLACEMENT_FULFILLMENT_ID, status: "packed" },
      });
    });

    it("still returns the parcel asked for by id, replacement or not", async () => {
      const port = createSupabaseCommerceFulfillmentPort(fakeClient({ rows: withReplacementParcel(baseRows()) }));

      await expect(
        port.getCommerceFulfillmentOrderDetail({ orderId: ORDER_ID, fulfillmentOrderId: FULFILLMENT_ORDER_ID }),
      ).resolves.toMatchObject({ order: { id: FULFILLMENT_ORDER_ID, status: "created" } });
    });

    it("breaks a sequence tie on id so two parcels can never resolve arbitrarily", async () => {
      const rows = withReplacementParcel(baseRows());
      rows.commerce_fulfillment_orders[1].sequence_no = 0;
      const port = createSupabaseCommerceFulfillmentPort(fakeClient({ rows }));

      await expect(port.getCommerceFulfillmentOrderDetail({ orderId: ORDER_ID })).resolves.toMatchObject({
        order: { id: FULFILLMENT_ORDER_ID },
      });
    });
  });
});

function withReplacementParcel(rows: RowsByTable): RowsByTable {
  const original = rows.commerce_fulfillment_orders[0];
  rows.commerce_fulfillment_orders = [
    original,
    { ...original, id: REPLACEMENT_FULFILLMENT_ID, sequence_no: 1, status: "packed" },
  ];
  rows.commerce_fulfillment_order_lines = [
    ...rows.commerce_fulfillment_order_lines,
    {
      ...rows.commerce_fulfillment_order_lines[0],
      id: "62222222-2222-4222-8222-222222222211",
      fulfillment_order_id: REPLACEMENT_FULFILLMENT_ID,
    },
  ];
  return rows;
}

function fakeClient({
  rows,
  errors = {},
  selected = {},
}: {
  rows: RowsByTable;
  errors?: Record<string, RpcError>;
  selected?: Record<string, string>;
}): CommerceFulfillmentSupabaseClient {
  return {
    from(table: string) {
      const state: {
        eq: Array<{ column: string; value: unknown }>;
        in: Array<{ column: string; values: unknown[] }>;
      } = { eq: [], in: [] };
      const builder = {
        select(columns: string) {
          selected[table] = columns;
          return builder;
        },
        order() {
          return builder;
        },
        eq(column: string, value: unknown) {
          state.eq.push({ column, value });
          return builder;
        },
        in(column: string, values: unknown[]) {
          state.in.push({ column, values });
          return builder;
        },
        range() {
          return Promise.resolve(resolveRows(table, rows, errors, state));
        },
        // PostgREST does not pick a row when a single-object read matches more than one - it
        // fails the request. The fake has to fail the same way, or a read that asks for one
        // object where an order can now hold two parcels would look safe here and break live.
        maybeSingle() {
          const result = resolveRows(table, rows, errors, state);
          if (Array.isArray(result.data) && result.data.length > 1) {
            return Promise.resolve({
              data: null,
              error: {
                code: "PGRST116",
                message: "JSON object requested, multiple (or no) rows returned",
                details: "Results contain more than 1 row",
              },
            });
          }
          return Promise.resolve({
            data: Array.isArray(result.data) ? result.data[0] ?? null : result.data,
            error: result.error,
          });
        },
        then<TResult1 = QueryResult, TResult2 = never>(
          onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ) {
          return Promise.resolve(resolveRows(table, rows, errors, state)).then(onfulfilled, onrejected);
        },
      };
      return builder;
    },
    rpc() {
      return Promise.resolve({ data: null, error: null });
    },
  };
}

function resolveRows(
  table: string,
  rows: RowsByTable,
  errors: Record<string, RpcError>,
  state: {
    eq: Array<{ column: string; value: unknown }>;
    in: Array<{ column: string; values: unknown[] }>;
  },
): QueryResult {
  const error = errors[table] ?? null;
  if (error) return { data: null, error };
  const data = (rows[table] ?? [])
    .filter((row) => state.eq.every(({ column, value }) => row[column] === value))
    .filter((row) => state.in.every(({ column, values }) => values.includes(row[column])));
  return { data, error: null, count: data.length };
}

function baseRows(): RowsByTable {
  return {
    commerce_fulfillment_orders: [{
      id: FULFILLMENT_ORDER_ID,
      order_id: ORDER_ID,
      sequence_no: 0,
      client_id: "12222222-2222-4222-8222-222222222221",
      status: "created",
      provider_kind: null,
      shipping_address_snapshot: {
        addressId: "32222222-2222-4222-8222-222222222221",
        clientId: "12222222-2222-4222-8222-222222222221",
        label: "Home",
        line1: "Prosta 1",
      line2: null,
      city: "Warszawa",
      postalCode: "00-001",
      country: "PL",
      recipientName: "Admin OMS Preview Updated",
      contactPhone: "+48123456789",
      companyName: null,
      taxId: null,
      deliveryNotes: "updated in OMS",
      courierInstructions: "preview correction",
    },
      created_at: "2026-06-05T10:00:00+00:00",
      updated_at: "2026-06-05T10:00:00+00:00",
    }],
    commerce_fulfillment_order_lines: [{
      id: "62222222-2222-4222-8222-222222222221",
      fulfillment_order_id: FULFILLMENT_ORDER_ID,
      order_item_id: "72222222-2222-4222-8222-222222222221",
      sku_id: "82222222-2222-4222-8222-222222222221",
      sku: "OPENLUP-DOG-LAMB-CAN-400G",
      title: "Lamb 400g",
      quantity: 2,
      inventory_reservation_ids: ["92222222-2222-4222-8222-222222222221"],
      product_snapshot: {},
    }],
    commerce_fulfillment_operations: [{
      id: "c2222222-2222-4222-8222-222222222221",
      fulfillment_order_id: FULFILLMENT_ORDER_ID,
      operation_type: "created",
      actor_user_id: null,
      occurred_at: "2026-06-05T10:00:00+00:00",
      payload: {},
    }],
    commerce_orders: [{
      id: ORDER_ID,
      status: "paid",
      mode: "one_time",
      shipping_address_id: "32222222-2222-4222-8222-222222222221",
      subscription_cycle_id: null,
    }],
    commerce_payment_intents: [{
      id: "a2222222-2222-4222-8222-222222222221",
      order_id: ORDER_ID,
      status: "succeeded",
      provider_payment_id: "pay_1",
    }],
    inventory_reservations: [{
      id: "92222222-2222-4222-8222-222222222221",
      order_id: ORDER_ID,
      status: "reserved",
      expires_at: "2026-06-05T10:30:00+00:00",
      location_id: LOCATION_ID,
    }],
    inventory_locations: [{
      id: LOCATION_ID,
      code: "pl-main",
    }],
    shipment_external_refs: [],
    commerce_order_holds: [],
  };
}
