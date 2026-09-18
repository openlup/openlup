import { describe, expect, it } from "vitest";
import {
  ORDER_A,
  invoice,
  order,
  orderItem,
  paymentIntent,
} from "./readQueries.fixtures.js";

describe("OMS read-query fixtures", () => {
  it("produces internally consistent canonical order money", () => {
    const item = orderItem(ORDER_A.id, "line-1");
    expect(item).toMatchObject({
      total_cents: ORDER_A.subtotal_cents,
      discount_allocated_cents: 0,
      effective_total_cents: ORDER_A.total_cents,
      effective_net_cents: ORDER_A.total_cents - ORDER_A.tax_cents,
      vat_rate_bps: 800,
    });
  });

  it("keeps generated ledger identifiers tied to the order", () => {
    const custom = order("42222222-2222-4222-8222-333333333333", "OMS-2001");
    expect(paymentIntent(custom.id).order_id).toBe(custom.id);
    expect(invoice(custom.id, "invoice-1")).toMatchObject({
      order_id: custom.id,
      total_gross_cents: custom.total_cents,
    });
  });
});
