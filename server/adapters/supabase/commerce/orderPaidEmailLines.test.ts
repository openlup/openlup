import { describe, expect, it, vi } from "vitest";
import {
  ORDER_HEADER_MONEY_COLUMNS,
  ORDER_ITEM_MONEY_COLUMNS,
} from "../../../../src/domains/commerce/orderMoney.js";
import {
  createSupabaseOrderPaidEmailLinesPort,
  type OrderPaidLinesSupabaseClient,
} from "./orderPaidEmailLines.js";

type Result = { data: unknown; error: { code?: string; message?: string } | null };
type OrderCall = { table: string; column: string; ascending: boolean };

const TABLE_COLUMNS: Record<string, ReadonlySet<string>> = {
  commerce_orders: new Set([
    "id", "currency", "subtotal_cents", "discount_cents", "shipping_cents",
    "shipping_discount_cents", "tax_cents", "total_cents", "metadata",
  ]),
  commerce_order_items: new Set([
    "order_id", "quantity", "unit_price_cents", "total_cents",
    "discount_allocated_cents", "effective_total_cents", "effective_net_cents",
    "vat_rate_bps", "product_snapshot",
    "variant_snapshot",
  ]),
};

function builder(
  table: string,
  single: Result,
  list: Result,
  selects: Map<string, string>,
  orders: OrderCall[],
) {
  const b = {
    select: (columns: string) => {
      validateSelectedColumns(table, columns);
      selects.set(table, columns);
      return b;
    },
    eq: () => b,
    order: (column: string, options: { ascending: boolean }) => {
      if (column !== "created_at") {
        throw new Error(`unexpected ${table} order column ${column}`);
      }
      orders.push({ table, column, ascending: options.ascending });
      return b;
    },
    maybeSingle: async () => single,
    then: (resolve: (v: Result) => unknown) => Promise.resolve(list).then(resolve),
  };
  return b;
}

function clientFor(order: Result, items: Result): {
  client: OrderPaidLinesSupabaseClient;
  selects: Map<string, string>;
  orders: OrderCall[];
} {
  const selects = new Map<string, string>();
  const orders: OrderCall[] = [];
  const client: OrderPaidLinesSupabaseClient = {
    from(table: string) {
      if (table === "commerce_orders") {
        return builder(table, order, { data: null, error: null }, selects, orders) as never;
      }
      if (table === "commerce_order_items") {
        return builder(table, { data: null, error: null }, items, selects, orders) as never;
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return { client, selects, orders };
}

function validateSelectedColumns(table: string, columns: string): void {
  const allowed = TABLE_COLUMNS[table];
  if (!allowed) throw new Error(`unexpected table ${table}`);
  for (const column of columns.split(",").map((value) => value.trim()).filter(Boolean)) {
    if (!allowed.has(column)) {
      throw new Error(`unexpected ${table} select column ${column}`);
    }
  }
}

const signal = new AbortController().signal;

describe("supabaseOrderPaidEmailLinesPort", () => {
  it("keeps catalog lines and the Rabat row for a discounted free-shipping order", async () => {
    const { client, selects, orders } = clientFor(
      {
        data: {
          currency: "PLN",
          subtotal_cents: 14000,
          discount_cents: 1655,
          shipping_cents: 1500,
          shipping_discount_cents: 1500,
          tax_cents: 914,
          total_cents: 12345,
        },
        error: null,
      },
      {
        data: [
          {
            quantity: 2,
            unit_price_cents: 5000,
            total_cents: 10000,
            discount_allocated_cents: 1182,
            effective_total_cents: 8818,
            effective_net_cents: 8165,
            vat_rate_bps: 800,
            product_snapshot: { productSlug: "lamb", sku: "SKU-1", title: "Legacy title" },
            variant_snapshot: { title: "Frozen variant title", name: "Ignored variant name" },
          },
          {
            quantity: 1,
            unit_price_cents: 4000,
            total_cents: 4000,
            discount_allocated_cents: 473,
            effective_total_cents: 3527,
            effective_net_cents: 3266,
            vat_rate_bps: 800,
            product_snapshot: { sku: "SKU-2", name: "Frozen item name" },
            variant_snapshot: {},
          },
          {
            quantity: 0,
            unit_price_cents: 999,
            total_cents: 999,
            discount_allocated_cents: 0,
            effective_total_cents: 999,
            effective_net_cents: 925,
            vat_rate_bps: 800,
            product_snapshot: {},
            variant_snapshot: {},
          },
        ],
        error: null,
      },
    );

    const data = await createSupabaseOrderPaidEmailLinesPort(client).read("order-uuid", signal);

    expect(data).toEqual({
      currency: "PLN",
      subtotalMinor: 14000,
      discountMinor: 1655,
      totalMinor: 12345,
      firstSubscriptionPricePresentation: null,
      lines: [
        { label: "Frozen variant title", quantity: 2, lineTotalMinor: 10000 },
        { label: "Frozen item name", quantity: 1, lineTotalMinor: 4000 },
      ],
    });
    expect(selects.get("commerce_orders")).toBe(`${ORDER_HEADER_MONEY_COLUMNS}, metadata`);
    expect(selects.get("commerce_order_items")).toBe(
      `quantity, product_snapshot, variant_snapshot, ${ORDER_ITEM_MONEY_COLUMNS}`,
    );
    expect(orders).toEqual([
      { table: "commerce_order_items", column: "created_at", ascending: true },
    ]);
  });

  it("keeps the same catalog output when paid shipping is part of the total", async () => {
    const { client } = clientFor(
      {
        data: {
          currency: "PLN",
          subtotal_cents: 12000,
          discount_cents: 0,
          shipping_cents: 1500,
          shipping_discount_cents: 0,
          tax_cents: 1000,
          total_cents: 13500,
        },
        error: null,
      },
      {
        data: [
          {
            quantity: 2,
            unit_price_cents: 5000,
            total_cents: 10000,
            discount_allocated_cents: 0,
            effective_total_cents: 10000,
            effective_net_cents: 9259,
            vat_rate_bps: 800,
            product_snapshot: { productSlug: "lamb", sku: "SKU-1", name: "Frozen item name" },
            variant_snapshot: {},
          },
          {
            quantity: 1,
            unit_price_cents: 2000,
            total_cents: 2000,
            discount_allocated_cents: 0,
            effective_total_cents: 2000,
            effective_net_cents: 1852,
            vat_rate_bps: 800,
            product_snapshot: { sku: "SKU-2" },
            variant_snapshot: {},
          },
        ],
        error: null,
      },
    );

    await expect(createSupabaseOrderPaidEmailLinesPort(client).read("order-uuid", signal))
      .resolves.toEqual({
        currency: "PLN",
        subtotalMinor: 12000,
        discountMinor: 0,
        totalMinor: 13500,
        firstSubscriptionPricePresentation: null,
        lines: [
          { label: "Frozen item name", quantity: 2, lineTotalMinor: 10000 },
          { label: null, quantity: 1, lineTotalMinor: 2000 },
        ],
      });
  });

  it("keeps the fake Supabase schema strict for selected columns", () => {
    expect(() =>
      clientFor({ data: null, error: null }, { data: [], error: null }).client
        .from("commerce_orders")
        .select("currency, totalGross"),
    ).toThrow(/unexpected commerce_orders select column totalGross/);

    expect(() =>
      clientFor({ data: null, error: null }, { data: [], error: null }).client
        .from("commerce_order_items")
        .order("updated_at", { ascending: true }),
    ).toThrow(/unexpected commerce_order_items order column updated_at/);
  });

  it("returns null when the order row is missing", async () => {
    const { client } = clientFor({ data: null, error: null }, { data: [], error: null });
    await expect(
      createSupabaseOrderPaidEmailLinesPort(client).read("missing", signal),
    ).resolves.toBeNull();
  });

  it("throws when a read errors", async () => {
    const orderError = clientFor(
      { data: null, error: { message: "order down" } },
      { data: [], error: null },
    ).client;
    await expect(
      createSupabaseOrderPaidEmailLinesPort(orderError).read("o", signal),
    ).rejects.toThrow(/order_paid_lines_order_read_failed.*order down/);

    const itemsError = clientFor(
      {
        data: {
          currency: "PLN",
          subtotal_cents: 0,
          discount_cents: 0,
          shipping_cents: 0,
          shipping_discount_cents: 0,
          tax_cents: 0,
          total_cents: 0,
        },
        error: null,
      },
      { data: null, error: { message: "items down" } },
    ).client;
    await expect(
      createSupabaseOrderPaidEmailLinesPort(itemsError).read("o", signal),
    ).rejects.toThrow(/order_paid_lines_items_read_failed.*items down/);
  });

  it("lets deriveOrderMoney own the rollback-only NULL-trio diagnostic", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { client } = clientFor(
      {
        data: {
          currency: "PLN",
          subtotal_cents: 10000,
          discount_cents: 1000,
          shipping_cents: 0,
          shipping_discount_cents: 0,
          tax_cents: 667,
          total_cents: 9000,
        },
        error: null,
      },
      {
        data: [{
          quantity: 2,
          unit_price_cents: 5000,
          total_cents: 10000,
          discount_allocated_cents: null,
          effective_total_cents: null,
          effective_net_cents: null,
          vat_rate_bps: 800,
          product_snapshot: { productSlug: "lamb", sku: "SKU-1" },
          variant_snapshot: {},
        }],
        error: null,
      },
    );

    await expect(createSupabaseOrderPaidEmailLinesPort(client).read("order-uuid", signal))
      .resolves.toMatchObject({
        subtotalMinor: 10000,
        discountMinor: 1000,
        totalMinor: 9000,
        lines: [{ lineTotalMinor: 10000 }],
      });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      "commerce_order_money_unreconciled",
      expect.stringContaining('"issueCodes":["missing_item_canonical_money"'),
    );
    warn.mockRestore();
  });
});
