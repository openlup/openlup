import { describe, expect, it } from "vitest";
import {
  mapCustomerOrderLines,
  toOrderMoneyHeader,
  toOrderMoneyItem,
} from "./customerOrderHistoryMoney.js";

/**
 * Deliberately NOT the platform default. The mapper's contract is that a line is
 * denominated in the currency stored on its order, so a test that passed "PLN" could not
 * tell a working implementation from the hard-coded stamp this wave removed.
 */
const STORED_CURRENCY = "EUR";

describe("customer order-history canonical-money mapping", () => {
  it("preserves the catalog total and unit price on the customer contract", () => {
    const [line] = mapCustomerOrderLines(
      [{
        id: "line-1",
        sku_id: "sku-1",
        quantity: 1,
        unit_price_cents: 1_000,
        total_cents: 1_000,
        product_snapshot: { title: "Wołowina" },
        variant_snapshot: null,
      }],
      [{
        id: "line-1",
        quantity: 1,
        catalogUnit: 1_000,
        catalogTotal: 1_000,
        discountAllocated: 100,
        effectiveGross: 900,
        effectiveNet: 833,
        vatRateBps: 800,
      }],
      STORED_CURRENCY,
    );

    expect(line).toMatchObject({
      unitPrice: { amountMinor: 1_000, currency: STORED_CURRENCY },
      total: { amountMinor: 1_000, currency: STORED_CURRENCY },
    });
  });

  it("maps the complete frozen header and rollback-only nullable trio", () => {
    expect(toOrderMoneyHeader({
      id: "order-1",
      currency: "PLN",
      subtotal_cents: 1_000,
      discount_cents: 100,
      shipping_cents: 200,
      shipping_discount_cents: 200,
      tax_cents: 67,
      total_cents: 900,
    })).toMatchObject({ shipping_discount_cents: 200, total_cents: 900 });
    expect(toOrderMoneyItem({
      id: "line-1",
      quantity: 1,
      unit_price_cents: 1_000,
      total_cents: 1_000,
      discount_allocated_cents: null,
      effective_total_cents: null,
      effective_net_cents: null,
      vat_rate_bps: 800,
    })).toMatchObject({ discount_allocated_cents: null });
  });
});
