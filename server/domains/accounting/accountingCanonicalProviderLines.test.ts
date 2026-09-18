import { describe, expect, it } from "vitest";

import type { ClaimedAccountingInvoiceIssue } from "../../../src/domains/accounting/ports.js";
import { mapInvoiceClaimToProviderSnapshot } from "./accountingProviderSnapshot.js";

describe("canonical accounting provider positions", () => {
  it("passes effective item and discounted delivery positions through with allocator delta zero", () => {
    const snapshot = mapInvoiceClaimToProviderSnapshot(claim(), {});

    expect(snapshot.lines).toEqual([
      expect.objectContaining({ name: "Food A", totalGrossMinor: 1000, totalNetMinor: 926 }),
      expect.objectContaining({ name: "Food B", totalGrossMinor: 1001, totalNetMinor: 927 }),
      expect.objectContaining({ name: "Dostawa", totalGrossMinor: 1000, totalNetMinor: 926 }),
    ]);
    expect(snapshot.lines.reduce((sum, line) => sum + (line.totalGrossMinor ?? 0), 0)).toBe(3001);
    expect(snapshot.lines.reduce((sum, line) => sum + (line.totalNetMinor ?? 0), 0)).toBe(2779);
  });

  it("fails when SQL and the independent largest-remainder tie break disagree", () => {
    const drifted = claim();
    const lines = drifted.invoice.linesSnapshot as Array<Record<string, unknown>>;
    lines[0] = { ...lines[0], totalGrossMinor: 1001, discountAllocatedMinor: 0, totalNetMinor: 927 };
    lines[1] = { ...lines[1], totalGrossMinor: 1000, discountAllocatedMinor: 1, totalNetMinor: 926 };

    expect(() => mapInvoiceClaimToProviderSnapshot(drifted, {})).toThrow(
      "accounting_invoice_canonical_allocator_delta_nonzero",
    );
  });

  it.each([
    ["missing canonical field", (value: Record<string, unknown>) => { delete value.totalNetMinor; }, "accounting_invoice_canonical_total_net_invalid"],
    ["wrong delivery residual", (value: Record<string, unknown>) => { value.totalGrossMinor = 999; value.totalNetMinor = 925; }, "accounting_invoice_canonical_delivery_mismatch"],
    ["wrong VAT net", (value: Record<string, unknown>) => { value.totalNetMinor = 925; }, "accounting_invoice_canonical_position_vat_mismatch"],
    ["wrong VAT label", (value: Record<string, unknown>) => { value.vatRate = "23"; }, "accounting_invoice_canonical_position_vat_label_mismatch"],
  ])("fails closed on %s", (_name, mutate, code) => {
    const drifted = claim();
    const lines = drifted.invoice.linesSnapshot as Array<Record<string, unknown>>;
    mutate(_name === "wrong delivery residual" ? lines[2] : lines[0]);
    expect(() => mapInvoiceClaimToProviderSnapshot(drifted, {})).toThrow(code);
  });
});

function claim(): ClaimedAccountingInvoiceIssue {
  const item = (name: string, gross: number, net: number, discount: number) => ({
    positionKind: "item",
    name,
    quantity: 1,
    unitGrossMinor: gross,
    totalGrossMinor: gross,
    unitNetMinor: net,
    totalNetMinor: net,
    vatRate: "8",
    vatRateBps: 800,
    catalogTotalGrossMinor: 1001,
    discountAllocatedMinor: discount,
  });
  return {
    outboxId: "outbox-1",
    attemptCount: 1,
    providerKind: "fakturownia",
    payment: {
      intentId: "intent-1",
      provider: "stripe",
      providerPaymentId: "pi_1",
      amountCents: 3001,
      currency: "PLN",
      localSettlementState: "matched",
    },
    invoice: {
      id: "invoice-1",
      orderId: "order-1",
      orderRef: "ORDER-1",
      invoiceRef: "ORDER-1:base",
      documentKind: "b2c_named",
      ksefRequired: false,
      currency: "PLN",
      buyerSnapshot: { name: "Client", email: null, taxId: null },
      orderSnapshot: {},
      taxSnapshot: {},
      linesSnapshot: [
        item("Food A", 1000, 926, 1),
        item("Food B", 1001, 927, 0),
        {
          positionKind: "delivery",
          name: "Dostawa",
          quantity: 1,
          unitGrossMinor: 1000,
          totalGrossMinor: 1000,
          unitNetMinor: 926,
          totalNetMinor: 926,
          vatRate: "8",
          vatRateBps: 800,
          shippingGrossMinor: 1500,
          shippingDiscountMinor: 500,
        },
      ],
      totalNetCents: 2779,
      totalGrossCents: 3001,
      orderMoney: null,
      paymentCompletedAt: "2026-07-14T10:00:00.000Z",
      packageShippedAt: null,
      providerPaymentId: "pi_1",
      metadata: { paymentProvider: "stripe" },
    },
  };
}
