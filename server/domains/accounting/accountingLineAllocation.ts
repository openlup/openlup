// Independent document-boundary allocation. The database writer performs its
// own SQL allocation; this copy deliberately verifies persisted results rather
// than sharing an implementation with the order writer.
export function allocateChargedGrossTotals(lineTotals: number[], chargedTotal: number): number[] {
  if (!Number.isInteger(chargedTotal) || chargedTotal < 0) {
    throw new Error(`accounting_invoice_charged_total_invalid charged=${chargedTotal}`);
  }
  if (lineTotals.some((total) => !Number.isInteger(total) || total < 0)) {
    throw new Error("accounting_invoice_line_totals_invalid");
  }
  const linesTotal = lineTotals.reduce((sum, total) => sum + total, 0);
  if (linesTotal === chargedTotal) return lineTotals;
  if (linesTotal < chargedTotal) {
    throw new Error(
      `accounting_invoice_lines_below_charged_total lines=${linesTotal} charged=${chargedTotal}`,
    );
  }
  const scaled = lineTotals.map((total) => (total * chargedTotal) / linesTotal);
  const allocated = scaled.map((value) => Math.floor(value));
  let remainder = chargedTotal - allocated.reduce((sum, total) => sum + total, 0);
  const byFraction = scaled
    .map((value, index) => ({ index, fraction: value - allocated[index] }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (const { index } of byFraction) {
    if (remainder <= 0) break;
    allocated[index] += 1;
    remainder -= 1;
  }
  return allocated;
}

// Mirrors the order writer's discount allocation rule for verification only:
// allocate the discount (not the charged total) by largest remainder, then
// subtract it from each catalog line. Allocating the charged total directly
// reverses the deterministic tie-break for equal lines.
export function allocateDiscountedGrossTotals(lineTotals: number[], chargedTotal: number): number[] {
  const linesTotal = lineTotals.reduce((sum, total) => sum + total, 0);
  const discount = linesTotal - chargedTotal;
  if (!Number.isInteger(chargedTotal) || chargedTotal < 0 || discount < 0) {
    throw new Error(`accounting_invoice_charged_total_invalid charged=${chargedTotal}`);
  }
  if (lineTotals.some((total) => !Number.isInteger(total) || total < 0)) {
    throw new Error("accounting_invoice_line_totals_invalid");
  }
  if (discount === 0) return lineTotals;
  if (linesTotal === 0) {
    throw new Error("accounting_invoice_discount_allocation_zero_spread");
  }

  const sumExact = BigInt(linesTotal);
  const discountExact = BigInt(discount);
  const scaledDiscounts = lineTotals.map((total) => {
    const product = BigInt(total) * discountExact;
    return { base: product / sumExact, remainder: product % sumExact };
  });
  const allocatedDiscounts = scaledDiscounts.map(({ base }) => Number(base));
  let remainder = discount - allocatedDiscounts.reduce((sum, total) => sum + total, 0);
  const byFraction = scaledDiscounts
    .map((value, index) => ({ index, fraction: value.remainder }))
    .sort((a, b) => a.fraction === b.fraction
      ? a.index - b.index
      : a.fraction > b.fraction ? -1 : 1);
  for (const { index } of byFraction) {
    if (remainder <= 0) break;
    allocatedDiscounts[index] += 1;
    remainder -= 1;
  }
  return lineTotals.map((total, index) => total - allocatedDiscounts[index]);
}
