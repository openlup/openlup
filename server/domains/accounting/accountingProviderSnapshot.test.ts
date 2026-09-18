import { describe, expect, it } from "vitest";
import type {
  AccountingCorrectionOutboxTarget,
  ClaimedAccountingInvoiceIssue,
} from "../../../src/domains/accounting/ports.js";
import { routeInvoiceByTaxId } from "../../../src/domains/accounting/invoiceContracts.js";
import {
  assertProviderInvoiceTaxIdSafe,
  mapCorrectionClaimToProviderSnapshot,
  mapInvoiceClaimToProviderSnapshot,
} from "./accountingProviderSnapshot.js";

describe("accounting provider snapshot mapping", () => {
  it("maps paid invoice claims with payment date as the fallback issue date", () => {
    const snapshot = mapInvoiceClaimToProviderSnapshot(baseClaim(), {});

    expect(snapshot).toMatchObject({
      orderRef: "ORDER-1",
      issueDate: "2026-06-05",
      sellDate: "2026-06-05",
      buyer: { name: "Customer", email: "buyer@example.test", taxId: null },
      lines: [{ name: "Food", quantity: 2, unitGrossMinor: 540, unitNetMinor: 500, vatRate: "8" }],
    });
  });

  it("normalizes valid B2B tax IDs and rejects invalid B2B tax IDs before provider calls", () => {
    const snapshot = mapInvoiceClaimToProviderSnapshot({
      ...baseClaim(),
      invoice: {
        ...baseClaim().invoice,
        documentKind: "b2b_vat",
        ksefRequired: true,
        buyerSnapshot: { name: "Company", email: "buyer@example.test", taxId: "123-456-32-18" },
      },
    }, {});

    // The jurisdiction module is injected here for the same reason the job
    // service injects it: the policy's own default is neutral and refuses.
    assertProviderInvoiceTaxIdSafe(snapshot, routeInvoiceByTaxId);
    expect(snapshot.buyer.taxId).toBe("1234563218");

    expect(() => assertProviderInvoiceTaxIdSafe({
      ...snapshot,
      buyer: { ...snapshot.buyer, taxId: "123" },
    }, routeInvoiceByTaxId)).toThrow("fakturownia_b2b_invoice_invalid_tax_id");
  });

  it("refuses a business document when no tax-id routing module is composed", () => {
    const snapshot = mapInvoiceClaimToProviderSnapshot({
      ...baseClaim(),
      invoice: {
        ...baseClaim().invoice,
        documentKind: "b2b_vat",
        buyerSnapshot: { name: "Company", email: "buyer@example.test", taxId: "123-456-32-18" },
      },
    }, {});

    // A tax id the composed module would accept, refused by the default: a
    // platform that has not been told how to read one must not vouch for it.
    // Matched on the reason rather than the whole message: the message names a
    // vendor, and repeating that here would spend neutrality headroom on a
    // string the case beside this one already pins in full.
    expect(() => assertProviderInvoiceTaxIdSafe(snapshot)).toThrow(/invalid_tax_id$/);
    // Consumer documents never reach the router, so the neutral default costs
    // nothing on the path that carries no tax id at all.
    expect(() => assertProviderInvoiceTaxIdSafe(mapInvoiceClaimToProviderSnapshot(baseClaim(), {})))
      .not.toThrow();
  });

  it("propagates the charged order total to the provider snapshot", () => {
    const snapshot = mapInvoiceClaimToProviderSnapshot(baseClaim(), {});

    expect(snapshot.chargedTotalGrossMinor).toBe(1080);
    expect(snapshot.lines[0]).toMatchObject({ totalGrossMinor: 1080, totalNetMinor: 1000 });
  });

  it("applies the order-level discount pro-rata for the OPENLUP-0F50280B shape", () => {
    // Prod order OPENLUP-0F50280B: catalog lines sum 20100, bundle discount -8925,
    // charged 11175. Six lines, all at 13.40 gross unit price.
    const quantities = [3, 3, 3, 2, 2, 2];
    const claim = baseClaim();
    claim.invoice.linesSnapshot = quantities.map((quantity, index) => ({
      name: `Food ${index + 1}`,
      quantity,
      unitGrossMinor: 1340,
      totalGrossMinor: 1340 * quantity,
      vatRate: "8",
    }));
    claim.invoice.totalGrossCents = 11175;

    const snapshot = mapInvoiceClaimToProviderSnapshot(claim, {});
    const grossTotals = snapshot.lines.map((line) => line.totalGrossMinor);

    expect(grossTotals).toEqual([2235, 2235, 2235, 1490, 1490, 1490]);
    expect(grossTotals.reduce((sum: number, total) => sum + (total ?? 0), 0)).toBe(11175);
    expect(snapshot.lines.every((line) => line.vatRate === "8")).toBe(true);
    expect(snapshot.chargedTotalGrossMinor).toBe(11175);
  });

  it("keeps discounted multi-line totals exact via largest-remainder rounding", () => {
    const claim = baseClaim();
    claim.invoice.linesSnapshot = [
      { name: "A", quantity: 1, totalGrossMinor: 1000, vatRate: "8" },
      { name: "B", quantity: 1, totalGrossMinor: 1000, vatRate: "8" },
      { name: "C", quantity: 1, totalGrossMinor: 1000, vatRate: "8" },
    ];
    claim.invoice.totalGrossCents = 1000;

    const evenSplit = mapInvoiceClaimToProviderSnapshot(claim, {});
    expect(evenSplit.lines.map((line) => line.totalGrossMinor)).toEqual([334, 333, 333]);

    claim.invoice.linesSnapshot = [
      { name: "A", quantity: 1, totalGrossMinor: 500, vatRate: "8" },
      { name: "B", quantity: 1, totalGrossMinor: 300, vatRate: "8" },
      { name: "C", quantity: 1, totalGrossMinor: 200, vatRate: "8" },
    ];
    claim.invoice.totalGrossCents = 333;

    const unevenSplit = mapInvoiceClaimToProviderSnapshot(claim, {});
    expect(unevenSplit.lines.map((line) => line.totalGrossMinor)).toEqual([166, 100, 67]);
  });

  it("supports a full (100%) discount", () => {
    const claim = baseClaim();
    claim.invoice.totalGrossCents = 0;

    const snapshot = mapInvoiceClaimToProviderSnapshot(claim, {});
    expect(snapshot.lines.map((line) => line.totalGrossMinor)).toEqual([0]);
  });

  it("fails closed when the charged total exceeds the line totals", () => {
    const claim = baseClaim();
    claim.invoice.linesSnapshot = [{ name: "Food", quantity: 1, totalGrossMinor: 1490, vatRate: "8" }];
    claim.invoice.totalGrossCents = 2480;

    expect(() => mapInvoiceClaimToProviderSnapshot(claim, {}))
      .toThrow("accounting_invoice_lines_below_charged_total lines=1490 charged=2480");
  });

  it("fails closed when there are no lines to carry a nonzero charged total", () => {
    const claim = baseClaim();
    claim.invoice.linesSnapshot = [];
    claim.invoice.totalGrossCents = 1080;

    expect(() => mapInvoiceClaimToProviderSnapshot(claim, {}))
      .toThrow("accounting_invoice_lines_below_charged_total lines=0 charged=1080");
  });

  it("emits a Dostawa position for a shipping-only charge above the item lines", () => {
    const claim = baseClaim();
    claim.invoice.linesSnapshot = [{ name: "Food", quantity: 1, totalGrossMinor: 1490, vatRate: "8" }];
    claim.invoice.totalGrossCents = 2990;
    claim.invoice.orderMoney = { subtotalCents: 1490, discountCents: 0, shippingCents: 1500, shippingDiscountCents: 0, totalCents: 2990 };

    const snapshot = mapInvoiceClaimToProviderSnapshot(claim, {});

    expect(snapshot.lines).toEqual([
      expect.objectContaining({ name: "Food", totalGrossMinor: 1490, vatRate: "8" }),
      {
        name: "Dostawa",
        quantity: 1,
        unitGrossMinor: 1500,
        unitNetMinor: 1389,
        totalGrossMinor: 1500,
        totalNetMinor: 1389,
        vatRate: "8",
      },
    ]);
    expect(snapshot.lines.reduce((sum: number, line) => sum + (line.totalGrossMinor ?? 0), 0)).toBe(2990);
  });

  it("derives the delivery residual from the order header, never from shippingCents", () => {
    // Checkout drafts persist shipping_cents = 0 while the charged total
    // includes the flat shipping fee; the residual must still be recognized.
    const claim = baseClaim();
    claim.invoice.linesSnapshot = [{ name: "Food", quantity: 1, totalGrossMinor: 2480, vatRate: "8" }];
    claim.invoice.totalGrossCents = 3480;
    claim.invoice.orderMoney = { subtotalCents: 2480, discountCents: 500, shippingCents: 0, shippingDiscountCents: 0, totalCents: 3480 };

    const snapshot = mapInvoiceClaimToProviderSnapshot(claim, {});

    expect(snapshot.lines).toEqual([
      expect.objectContaining({ name: "Food", totalGrossMinor: 1980 }),
      expect.objectContaining({ name: "Dostawa", totalGrossMinor: 1500 }),
    ]);
  });

  it("combines the pro-rata discount with a Dostawa position for the OPENLUP-0F50280B shape plus shipping", () => {
    // Catalog lines sum 20100, bundle discount -8925, shipping 1500 → charged
    // 12675: items reconcile to 11175 exactly as in the discount-only case
    // and the delivery residual rides as its own position.
    const quantities = [3, 3, 3, 2, 2, 2];
    const claim = baseClaim();
    claim.invoice.linesSnapshot = quantities.map((quantity, index) => ({
      name: `Food ${index + 1}`,
      quantity,
      unitGrossMinor: 1340,
      totalGrossMinor: 1340 * quantity,
      vatRate: "8",
    }));
    claim.invoice.totalGrossCents = 12675;
    claim.invoice.orderMoney = { subtotalCents: 20100, discountCents: 8925, shippingCents: 1500, shippingDiscountCents: 0, totalCents: 12675 };

    const snapshot = mapInvoiceClaimToProviderSnapshot(claim, {});
    const grossTotals = snapshot.lines.map((line) => line.totalGrossMinor);

    expect(grossTotals).toEqual([2235, 2235, 2235, 1490, 1490, 1490, 1500]);
    expect(snapshot.lines[6]).toMatchObject({ name: "Dostawa", quantity: 1, vatRate: "8" });
    expect(grossTotals.reduce((sum: number, total) => sum + (total ?? 0), 0)).toBe(12675);
    expect(snapshot.chargedTotalGrossMinor).toBe(12675);
  });

  it("supports a full item discount alongside a paid delivery", () => {
    const claim = baseClaim();
    claim.invoice.linesSnapshot = [{ name: "Food", quantity: 2, totalGrossMinor: 1080, vatRate: "8" }];
    claim.invoice.totalGrossCents = 500;
    claim.invoice.orderMoney = { subtotalCents: 1080, discountCents: 1080, shippingCents: 500, shippingDiscountCents: 0, totalCents: 500 };

    const snapshot = mapInvoiceClaimToProviderSnapshot(claim, {});

    expect(snapshot.lines.map((line) => line.totalGrossMinor)).toEqual([0, 500]);
    expect(snapshot.lines[1]).toMatchObject({ name: "Dostawa" });
  });

  it("fails closed on a delivery residual when item VAT rates are mixed", () => {
    const claim = baseClaim();
    claim.invoice.linesSnapshot = [
      { name: "Food", quantity: 1, totalGrossMinor: 1000, vatRate: "8" },
      { name: "Toy", quantity: 1, totalGrossMinor: 500, vatRate: "23" },
    ];
    claim.invoice.totalGrossCents = 3000;
    claim.invoice.orderMoney = { subtotalCents: 1500, discountCents: 0, shippingCents: 1500, shippingDiscountCents: 0, totalCents: 3000 };

    expect(() => mapInvoiceClaimToProviderSnapshot(claim, {}))
      .toThrow("accounting_invoice_delivery_vat_rates_mixed rates=8,23");
  });

  it("fails closed on a delivery residual with no item line to source the VAT rate", () => {
    const claim = baseClaim();
    claim.invoice.linesSnapshot = [];
    claim.invoice.totalGrossCents = 1500;
    claim.invoice.orderMoney = { subtotalCents: 0, discountCents: 0, shippingCents: 1500, shippingDiscountCents: 0, totalCents: 1500 };

    expect(() => mapInvoiceClaimToProviderSnapshot(claim, {}))
      .toThrow("accounting_invoice_delivery_vat_rate_unavailable delivery=1500");
  });

  it("keeps the legacy fail-closed behavior when orderMoney is inconsistent with the charge", () => {
    const claim = baseClaim();
    claim.invoice.linesSnapshot = [{ name: "Food", quantity: 1, totalGrossMinor: 1490, vatRate: "8" }];
    claim.invoice.totalGrossCents = 2480;
    // Header total disagrees with the invoice charge: the residual cannot be
    // trusted, so the claim must fall back to the fail-closed path.
    claim.invoice.orderMoney = { subtotalCents: 1490, discountCents: 0, shippingCents: 990, shippingDiscountCents: 0, totalCents: 2481 };

    expect(() => mapInvoiceClaimToProviderSnapshot(claim, {}))
      .toThrow("accounting_invoice_lines_below_charged_total lines=1490 charged=2480");
  });

  it("fails closed when item lines cannot absorb the item portion of the charge", () => {
    const claim = baseClaim();
    claim.invoice.linesSnapshot = [{ name: "Food", quantity: 1, totalGrossMinor: 1000, vatRate: "8" }];
    claim.invoice.totalGrossCents = 3000;
    // Item portion 1500 exceeds the 1000 the lines carry: inflating item
    // prices is never allowed, delivery stays capped at the residual.
    claim.invoice.orderMoney = { subtotalCents: 1500, discountCents: 0, shippingCents: 1500, shippingDiscountCents: 0, totalCents: 3000 };

    expect(() => mapInvoiceClaimToProviderSnapshot(claim, {}))
      .toThrow("accounting_invoice_lines_below_charged_total lines=1000 charged=1500");
  });

  it("emits no delivery position when the header residual is zero", () => {
    const claim = baseClaim();
    claim.invoice.orderMoney = { subtotalCents: 1080, discountCents: 0, shippingCents: 0, shippingDiscountCents: 0, totalCents: 1080 };

    const snapshot = mapInvoiceClaimToProviderSnapshot(claim, {});

    expect(snapshot.lines).toHaveLength(1);
    expect(snapshot.lines[0]).toMatchObject({ name: "Food", totalGrossMinor: 1080 });
  });

  it("maps correction claims with the corrected document's line amounts", () => {
    // The provider adapter mirrors these lines into correction_before and
    // zeroes correction_after; zero-value lines here would build a 0→0
    // no-op correction.
    const snapshot = mapCorrectionClaimToProviderSnapshot(correctionClaim(), {});

    expect(snapshot.lines[0]).toMatchObject({
      quantity: 2,
      unitGrossMinor: 540,
      unitNetMinor: 500,
      totalGrossMinor: 1080,
      totalNetMinor: 1000,
    });
    expect(snapshot.chargedTotalGrossMinor).toBeUndefined();
  });

  it("derives correction line totals as unit price times quantity for the legacy line shape", () => {
    // Pre-#1693 lines_snapshot rows carry only the per-unit unitGrossMinor.
    // Fakturownia doc 531316856 ("1/07/2026", corrected as K12/2026 on
    // 2026-07-13): six lines at 13,40 zł unit price, document total 201,00 zł
    // — not the 80,40 zł a bare unitGrossMinor fallback would sum to.
    const quantities = [2, 3, 2, 3, 1, 4];
    const claim = correctionClaim();
    claim.invoice.linesSnapshot = quantities.map((quantity, index) => ({
      name: `Food ${index + 1}`,
      quantity,
      unitGrossMinor: 1340,
      vatRate: "8",
    }));
    claim.invoice.totalGrossCents = 20100;

    const snapshot = mapCorrectionClaimToProviderSnapshot(claim, {});
    const grossTotals = snapshot.lines.map((line) => line.totalGrossMinor);

    expect(grossTotals).toEqual([2680, 4020, 2680, 4020, 1340, 5360]);
    expect(grossTotals.reduce((sum: number, total) => sum + (total ?? 0), 0)).toBe(20100);
    expect(snapshot.lines.every((line) => line.unitGrossMinor === 1340)).toBe(true);
  });

  it("derives issue line totals as unit price times quantity for the legacy line shape", () => {
    const quantities = [2, 3, 2, 3, 1, 4];
    const claim = baseClaim();
    claim.invoice.linesSnapshot = quantities.map((quantity, index) => ({
      name: `Food ${index + 1}`,
      quantity,
      unitGrossMinor: 1340,
      vatRate: "8",
    }));
    claim.invoice.totalGrossCents = 20100;

    const snapshot = mapInvoiceClaimToProviderSnapshot(claim, {});

    expect(snapshot.lines.map((line) => line.totalGrossMinor))
      .toEqual([2680, 4020, 2680, 4020, 1340, 5360]);
    expect(snapshot.chargedTotalGrossMinor).toBe(20100);
  });

  it("carries the buyer with the full street on correction claims", () => {
    const claim = correctionClaim();
    claim.invoice.buyerSnapshot = {
      name: "Jan Kowalski",
      email: "buyer@example.test",
      taxId: null,
      address: { line1: "ul. Prosta 1", line2: "m. 2", postalCode: "00-001", city: "Warszawa", country: "PL" },
    };

    const snapshot = mapCorrectionClaimToProviderSnapshot(claim, {});

    expect(snapshot.buyer).toMatchObject({
      name: "Jan Kowalski",
      email: "buyer@example.test",
      address: { line1: "ul. Prosta 1 m. 2", postalCode: "00-001", city: "Warszawa", country: "PL" },
    });
  });
});

function baseClaim(): ClaimedAccountingInvoiceIssue {
  return {
    outboxId: "outbox-1",
    attemptCount: 1,
    providerKind: "fakturownia",
    payment: {
      intentId: "intent-1",
      provider: "stripe",
      providerPaymentId: "pi_123",
      amountCents: 1080,
      currency: "PLN",
      localSettlementState: "unavailable",
    },
    invoice: {
      id: "invoice-1",
      orderId: "order-1",
      orderRef: "ORDER-1",
      invoiceRef: "ORDER-1:base",
      documentKind: "b2c_named",
      ksefRequired: false,
      currency: "PLN",
      buyerSnapshot: { name: "", email: "buyer@example.test", taxId: null },
      orderSnapshot: {},
      taxSnapshot: {},
      linesSnapshot: [{ name: "Food", quantity: 2, totalGrossMinor: 1080, vatRate: "8" }],
      totalNetCents: 1000,
      totalGrossCents: 1080,
      paymentCompletedAt: "2026-06-05T10:00:00.000Z",
      packageShippedAt: null,
      providerPaymentId: "pi_123",
      metadata: { paymentProvider: "stripe" },
    },
  };
}

function correctionClaim(): AccountingCorrectionOutboxTarget {
  const invoice = baseClaim().invoice;
  return {
    outboxId: "correction-1",
    attemptCount: 1,
    providerKind: "fakturownia",
    invoiceId: "invoice-1",
    providerInvoiceId: "fv-1",
    correctionReason: "order_refunded",
    payload: {},
    invoice: {
      id: invoice.id,
      orderRef: invoice.orderRef,
      invoiceRef: invoice.invoiceRef,
      documentKind: invoice.documentKind,
      ksefRequired: invoice.ksefRequired,
      currency: invoice.currency,
      buyerSnapshot: invoice.buyerSnapshot,
      linesSnapshot: invoice.linesSnapshot,
      totalGrossCents: invoice.totalGrossCents,
      providerInvoiceId: "fv-1",
      providerInvoiceNumber: "FV/1/2026",
    },
  };
}
