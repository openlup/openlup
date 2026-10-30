import type { ChannelComponentMoneyGroup } from "./contracts/index.js";
export type { ChannelComponentMoneyGroup } from "./contracts/index.js";
import type { BundleAllocatedLine } from "@openlup/core/pricing";


/** Intersect the final and discount partitions, keeping every integer unit amount exact. */
export function channelComponentMoneyRows(
  component: { skuId: string; skuCode: string; quantity: number },
  final: readonly BundleAllocatedLine[], discount: readonly BundleAllocatedLine[],
): ChannelComponentMoneyGroup[] {
  const partitions = [final, discount].map(input => input.filter(row => row.sku === component.skuCode)
    .sort((left, right) => right.effectiveUnitPriceMinor - left.effectiveUnitPriceMinor));
  for (const rows of partitions) {
    if (rows.length < 1 || rows.length > 2 || rows.reduce((sum, row) => sum + row.quantity, 0) !== component.quantity) {
      throw new RangeError("channel_money_partition_invalid");
    }
  }
  const groups: ChannelComponentMoneyGroup[] = [];
  let finalIndex = 0, discountIndex = 0;
  let finalLeft = partitions[0][0].quantity, discountLeft = partitions[1][0].quantity;
  while (finalIndex < partitions[0].length && discountIndex < partitions[1].length) {
    const quantity = Math.min(finalLeft, discountLeft);
    const unitFinalMinor = partitions[0][finalIndex].effectiveUnitPriceMinor;
    const unitDiscountMinor = partitions[1][discountIndex].effectiveUnitPriceMinor;
    const unitGrossMinor = unitFinalMinor + unitDiscountMinor;
    const gross = BigInt(unitGrossMinor) * BigInt(quantity);
    if (!Number.isSafeInteger(unitGrossMinor) || gross > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("channel_money_unsafe");
    groups.push({ skuId: component.skuId, skuCode: component.skuCode, groupIndex: groups.length,
      quantity, unitFinalMinor, unitDiscountMinor, unitGrossMinor,
      lineFinalMinor: unitFinalMinor * quantity, lineDiscountMinor: unitDiscountMinor * quantity, lineGrossMinor: Number(gross) });
    finalLeft -= quantity; discountLeft -= quantity;
    if (finalLeft === 0 && ++finalIndex < partitions[0].length) finalLeft = partitions[0][finalIndex].quantity;
    if (discountLeft === 0 && ++discountIndex < partitions[1].length) discountLeft = partitions[1][discountIndex].quantity;
  }
  if (groups.length > 3) throw new RangeError("channel_money_partition_invalid");
  return groups;
}
