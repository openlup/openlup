import { describe, expect, it } from "vitest";
import { sumCanonicalInvoicePositions } from "./invoicePositionSnapshot.js";
import { compareCanonicalInvoicePositionsToOrder } from "./orderMoneyInvoiceComparison.js";
import type { OrderItemMoneyRow, PaidOrderMoneyRow } from "../../adapters/supabase/platform/orderMoneyReconciliationRows.js";

describe("canonical invoice/order comparison", () => {
  it("matches the frozen order header and item allocation", () => {
    expect(compare()).toEqual([]);
  });

  it.each([
    ["catalog", (order: PaidOrderMoneyRow) => { order.subtotal_cents += 1; }, "invoice_positions_catalog"],
    ["discount", (order: PaidOrderMoneyRow) => { order.discount_cents += 1; }, "invoice_positions_discount"],
    ["shipping", (order: PaidOrderMoneyRow) => { order.shipping_cents += 1; }, "invoice_positions_shipping"],
    ["shipping discount", (order: PaidOrderMoneyRow) => { order.shipping_discount_cents += 1; }, "invoice_positions_shipping_discount"],
    ["tax/net", (order: PaidOrderMoneyRow) => { order.tax_cents += 1; }, "invoice_positions_net"],
  ])("detects %s drift from the order header", (_label, mutate, code) => {
    expect(compare(mutate)).toContain(code);
  });

  it("detects an invoice position that no longer matches its frozen order item", () => {
    const rows = orderItems();
    rows[0].effective_total_cents += 1;

    expect(compare(undefined, rows)).toContain("invoice_positions_order_items");
  });

  it("accepts fully discounted shipping omitted by the canonical SQL snapshot", () => {
    const order = orderHeader();
    order.shipping_cents = 500;
    order.shipping_discount_cents = 500;
    order.total_cents = 2001;
    order.tax_cents = 148;
    const positions = sumCanonicalInvoicePositions(lines().slice(0, 2));
    if (!positions.valid) throw new Error("test fixture must stay canonical");
    const mismatches: Parameters<typeof compareCanonicalInvoicePositionsToOrder>[0]["mismatches"] = [];

    compareCanonicalInvoicePositionsToOrder({ order, orderItems: orderItems(), positions, mismatches });

    expect(mismatches).toEqual([]);
  });
});

function compare(
  mutateOrder?: (order: PaidOrderMoneyRow) => void,
  rows = orderItems(),
) {
  const order = orderHeader();
  mutateOrder?.(order);
  const positions = sumCanonicalInvoicePositions(lines());
  if (!positions.valid) throw new Error("test fixture must stay canonical");
  const mismatches: Parameters<typeof compareCanonicalInvoicePositionsToOrder>[0]["mismatches"] = [];
  compareCanonicalInvoicePositionsToOrder({ order, orderItems: rows, positions, mismatches });
  return mismatches;
}

function orderHeader(): PaidOrderMoneyRow {
  return {
    id: "order-1", order_number: "OPENLUP-1", mode: "one_time", status: "paid",
    subtotal_cents: 2002, discount_cents: 1, shipping_cents: 1500,
    shipping_discount_cents: 500, tax_cents: 222, total_cents: 3001,
    currency: "PLN", subscription_cycle_id: null, updated_at: "2026-07-14T10:00:00.000Z",
  };
}

function orderItems(): OrderItemMoneyRow[] {
  return [
    { id: "item-1", order_id: "order-1", allocation_ordinal: 1, quantity: 1, total_cents: 1001, discount_allocated_cents: 1, effective_total_cents: 1000, effective_net_cents: 926, vat_rate_bps: 800 },
    { id: "item-2", order_id: "order-1", allocation_ordinal: 2, quantity: 1, total_cents: 1001, discount_allocated_cents: 0, effective_total_cents: 1001, effective_net_cents: 927, vat_rate_bps: 800 },
  ];
}

function lines() {
  return [
    { positionKind: "item", orderItemId: "item-1", allocationOrdinal: 1, name: "A", quantity: 1, unitGrossMinor: 1000, totalGrossMinor: 1000, unitNetMinor: 926, totalNetMinor: 926, vatRate: "8", vatRateBps: 800, discountAllocatedMinor: 1, catalogTotalGrossMinor: 1001 },
    { positionKind: "item", orderItemId: "item-2", allocationOrdinal: 2, name: "B", quantity: 1, unitGrossMinor: 1001, totalGrossMinor: 1001, unitNetMinor: 927, totalNetMinor: 927, vatRate: "8", vatRateBps: 800, discountAllocatedMinor: 0, catalogTotalGrossMinor: 1001 },
    { positionKind: "delivery", orderItemId: null, name: "Dostawa", quantity: 1, unitGrossMinor: 1000, totalGrossMinor: 1000, unitNetMinor: 926, totalNetMinor: 926, vatRate: "8", vatRateBps: 800, shippingGrossMinor: 1500, shippingDiscountMinor: 500 },
  ];
}
