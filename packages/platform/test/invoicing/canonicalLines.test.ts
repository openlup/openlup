import { expect, it } from "vitest";
import { mapCanonicalIssueLines, mapInvoiceClaimToProviderSnapshot } from "../../src/invoicing/index.js";

const item = { positionKind: "item", name: "Saved item", quantity: 1, unitGrossMinor: 1080, unitNetMinor: 1000, totalGrossMinor: 1080, totalNetMinor: 1000, vatRate: "8", vatRateBps: 800, catalogTotalGrossMinor: 1180, discountAllocatedMinor: 100 };
const delivery = { positionKind: "delivery", name: "Host delivery", quantity: 1, unitGrossMinor: 108, unitNetMinor: 100, totalGrossMinor: 108, totalNetMinor: 100, vatRate: "8", vatRateBps: 800, shippingGrossMinor: 208, shippingDiscountMinor: 100 };
const options = { defaultLineLabel: "Host item", defaultBuyerLabel: "Host buyer", deliveryLabel: "Host delivery", defaultTaxRate: "8" };
const input = { orderRef: "ORDER", issueDate: "2026-10-22", sellDate: "2026-10-21", currency: "XTS", seller: { name: "Host seller" }, buyerSnapshot: { name: " Saved buyer ", email: "buyer@example.test", taxId: null }, documentKind: "host-consumer", governmentClearanceRequired: false, payment: { provider: "money-a", providerPaymentId: "saved-payment", paymentCompletedAt: "2026-10-21" }, linesSnapshot: [item, delivery], totalGrossMinor: 1188, totalNetMinor: 1100, orderMoney: null };

it("keeps canonical ordered positions and the entire projected snapshot with injected host captions", () => {
  const lines = [
    { name: "Saved item", quantity: 1, unitGrossMinor: 1080, unitNetMinor: 1000, totalGrossMinor: 1080, totalNetMinor: 1000, vatRate: "8" },
    { name: "Host delivery", quantity: 1, unitGrossMinor: 108, unitNetMinor: 100, totalGrossMinor: 108, totalNetMinor: 100, vatRate: "8" },
  ];
  expect(mapCanonicalIssueLines([item, delivery], 1188, 1100, options.defaultLineLabel)).toEqual(lines);
  const snapshot = mapInvoiceClaimToProviderSnapshot(input, options);
  const expected = {
    orderRef: "ORDER", issueDate: "2026-10-22", sellDate: "2026-10-21", currency: "XTS", seller: input.seller,
    buyer: { name: "Saved buyer", email: "buyer@example.test", taxId: null, companyName: null, address: { line1: null, postalCode: null, city: null, country: null } },
    documentKind: "host-consumer", governmentClearanceRequired: false, payment: input.payment, lines, chargedTotalGrossMinor: 1188,
  };
  expect(snapshot).toEqual(expected);
  expect(JSON.stringify(snapshot)).toBe(JSON.stringify(expected));
  const legacy = mapInvoiceClaimToProviderSnapshot({ ...input, buyerSnapshot: {}, linesSnapshot: [{ quantity: 1, totalGrossMinor: 1080 }], orderMoney: { subtotalCents: 1080, discountCents: 0, totalCents: 1188 } }, options);
  expect(legacy.buyer.name).toBe("Host buyer");
  expect(legacy.lines).toEqual([{ ...lines[0], name: "Host item" }, lines[1]]);
});

it("refuses unproved canonical amounts, mixed legacy kinds, bad delivery and header drift", () => {
  for (const lines of [
    [{ ...item, totalNetMinor: 999 }, delivery],
    [{ ...item, vatRate: "7" }, delivery],
    [{ ...item, discountAllocatedMinor: 99 }, delivery],
    [item, { ...delivery, shippingDiscountMinor: 99 }],
    [item, { ...delivery, positionKind: undefined }],
  ]) expect(() => mapInvoiceClaimToProviderSnapshot({ ...input, linesSnapshot: lines }, options)).toThrow(/accounting_invoice_canonical_/);
  expect(() => mapCanonicalIssueLines([item, delivery], 1188, 1099, "Host item")).toThrow(/header_mismatch/);
});
