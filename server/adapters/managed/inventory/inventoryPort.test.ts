import { describe, expect, it } from "vitest";
import {
  createManagedInventoryPort,
} from "./inventoryPort.js";

describe("createManagedInventoryPort", () => {
  it("exposes subscription forecasting through the read port", () => {
    expect(createManagedInventoryPort({} as never).forecastSubscriptions).toBeTypeOf("function");
  });

  it("maps stock rows and filters unavailable zero rows", async () => {
    const port = createManagedInventoryPort(client({
      inventory_balances: [
        stockRow({ sku_id: "sku-1", on_hand: 10, reserved: 2, unavailable: 1 }),
        stockRow({ sku_id: "sku-2", on_hand: 0, reserved: 0, unavailable: 0 }),
      ],
    }) as never);

    const stock = await port.listStock({ page: 1, pageSize: 25, includeZero: false });

    expect(stock.totalCount).toBe(2);
    expect(stock.stock).toEqual([
      expect.objectContaining({
        skuId: "sku-1",
        sku: "SKU-001",
        availableNow: 7,
      }),
    ]);
  });
});

function stockRow(overrides: Partial<Record<string, unknown>>) {
  return {
    sku_id: "sku-1",
    location_id: "loc-1",
    lot_id: null,
    on_hand: 10,
    reserved: 0,
    unavailable: 0,
    incoming: 0,
    safety_stock: 0,
    catalog_skus: { sku: "SKU-001" },
    inventory_locations: { code: "primary", kind: "internal_warehouse", status: "active", fulfillable: true },
    inventory_lots: null,
    ...overrides,
  };
}

function client(tables: Record<string, Array<Record<string, unknown>>>) {
  return {
    from(table: string) {
      return query(tables[table] ?? []);
    },
    rpc: async () => ({ data: null, error: null }),
  };
}

function query(rows: Array<Record<string, unknown>>) {
  const filters: Array<{ column: string; value: unknown }> = [];
  const inFilters: Array<{ column: string; values: unknown[] }> = [];
  const builder = {
    select: () => builder,
    eq: (column: string, value: unknown) => {
      filters.push({ column, value });
      return builder;
    },
    in: (column: string, values: unknown[]) => {
      inFilters.push({ column, values });
      return builder;
    },
    order: () => builder,
    range: (from: number, to: number) => {
      const data = applyFilters().slice(from, to + 1);
      return Promise.resolve({ data, error: null, count: applyFilters().length });
    },
    then: (resolve: (value: { data: unknown[]; error: null }) => unknown) =>
      Promise.resolve({ data: applyFilters(), error: null }).then(resolve),
  };

  function applyFilters() {
    return rows.filter((row) =>
      filters.every((filter) => row[filter.column] === filter.value)
      && inFilters.every((filter) => filter.values.includes(row[filter.column]))
    );
  }

  return builder;
}
