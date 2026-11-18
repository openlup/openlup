/** @experimental Informational catalogue entries owned by invoicing. */
export const invoicingSettingBoundaries: readonly (readonly [key: string, kind: "cap" | "invariant", goal: string, reason: string])[] = [
  ["partialInvoiceCorrections", "cap", "Issue a partial invoice correction.", "The native correction contract supports full reversal."],
  ["invoicePaymentMatch", "invariant", "Require the invoice amount and currency to agree with the payment.", "An invoice relies on matching durable payment evidence."],
];
