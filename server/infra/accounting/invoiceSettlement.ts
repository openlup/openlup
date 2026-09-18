// An invoice is only ever issued for an order that has already been paid, so a
// document that prints as awaiting payment is always wrong. Left unset, the
// provider defaults to issued / 0,00 and computes a due date, which is what the
// customer and the bookkeeper currently see.

// Marking the document settled. `paid` must equal the document total or the
// provider reports a partial payment, so the caller passes the sum of the
// positions rather than the order header: the two are already reconciled, and
// the positions are the amounts this document actually charges.
export function settlementFields(paidGross: number, paidDate: string): {
  status: string;
  paid: number;
  paid_date: string;
  payment_to_kind: string;
} {
  return {
    status: "paid",
    paid: paidGross,
    paid_date: paidDate,
    // A settled sale has no payment deadline; without this the document still
    // prints one.
    payment_to_kind: "off",
  };
}
