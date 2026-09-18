import { describe, expect, it } from "vitest";
import { reconcileOrderInvoice } from "./orderMoneyInvoiceEvidence.js";

describe("order money invoice expectation", () => {
  it("requires a missing handoff invoice only after the shared grace period", () => {
    const mismatches: Array<"base_invoice_count"> = [];
    const evidence = reconcileOrderInvoice({
      order: {
        id: "order-1", order_number: "OPENLUP-1", mode: "one_time", status: "paid",
        subtotal_cents: 1_000, discount_cents: 0, shipping_cents: 0,
        shipping_discount_cents: 0, tax_cents: 74, total_cents: 1_000,
        currency: "PLN", subscription_cycle_id: null, updated_at: "2026-07-14T10:00:00.000Z",
      },
      orderItems: [],
      paymentConfirmedAt: "2026-07-14T10:00:00.000Z",
      invoices: [],
      fulfillment: [{
        id: "fulfillment-1", order_id: "order-1", status: "exception",
        handed_over_at: "2026-07-14T10:00:00.000Z",
      }],
      issueTrigger: "handoff",
      now: new Date("2026-07-14T11:00:01.000Z"),
      mismatches,
    });

    expect(evidence.expectation).toMatchObject({ state: "required", issueTrigger: "handoff" });
    expect(mismatches).toEqual(["base_invoice_count"]);
  });
});
