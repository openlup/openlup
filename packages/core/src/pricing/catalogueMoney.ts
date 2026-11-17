/**
 * Included-VAT net for an already validated position's gross minor amount.
 * Caller supplies a nonnegative safe integer gross and an integer rate in
 * 0..10000 basis points, in the position's selected currency.
 * Source revision 5a89d18b0574583080ee9ff5ef5758890fbd0408,
 * server/domains/platform/invoicePositionSnapshot.ts:183-185 (unchanged body).
 * @beta
 * @experimental
 */
export function cataloguePositionNetFromGross(gross: number, vatRateBps: number): number {
  const denominator = BigInt(10_000 + vatRateBps);
  return Number((BigInt(gross) * 10_000n + denominator / 2n) / denominator);
}

/**
 * Allocate a discount, then return effective gross amounts in input order.
 * Caller preserves position order and supplies totals in one selected currency.
 * Source revision 5a89d18b0574583080ee9ff5ef5758890fbd0408,
 * server/domains/platform/invoicePositionSnapshot.ts:211-239 (unchanged body).
 * @beta
 * @experimental
 */
export function allocateCatalogueDiscountedGrossTotals(lineTotals: number[], chargedTotal: number): number[] {
  const linesTotal = lineTotals.reduce((sum, total) => sum + total, 0);
  const discount = linesTotal - chargedTotal;
  if (!Number.isSafeInteger(chargedTotal) || chargedTotal < 0 || discount < 0 ||
    lineTotals.some((total) => !Number.isSafeInteger(total) || total < 0)) {
    throw new Error("order_money_invoice_allocation_invalid");
  }
  if (discount === 0) return lineTotals;
  if (linesTotal === 0) throw new Error("order_money_invoice_allocation_zero_spread");

  const denominator = BigInt(linesTotal);
  const discountExact = BigInt(discount);
  const scaled = lineTotals.map((total) => {
    const product = BigInt(total) * discountExact;
    return { base: product / denominator, remainder: product % denominator };
  });
  const allocations = scaled.map(({ base }) => Number(base));
  let remainder = discount - allocations.reduce((sum, total) => sum + total, 0);
  const order = scaled
    .map((value, index) => ({ index, fraction: value.remainder }))
    .sort((left, right) => left.fraction === right.fraction
      ? left.index - right.index
      : left.fraction > right.fraction ? -1 : 1);
  for (const { index } of order) {
    if (remainder <= 0) break;
    allocations[index] += 1;
    remainder -= 1;
  }
  return lineTotals.map((total, index) => total - allocations[index]);
}
