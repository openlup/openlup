import type { ChannelMoneyAllocationInput, ChannelMoneyAllocation } from "./contracts/index.js";
export type { ChannelFrozenMoneyComponent, ChannelMoneyAllocationInput, ChannelMoneyAllocation } from "./contracts/index.js";
import { allocateBundleTargetPrice } from "@openlup/core/pricing";
import { channelComponentMoneyRows, type ChannelComponentMoneyGroup } from "./channelComponentMoneyRows.js";


const maximum = BigInt(Number.MAX_SAFE_INTEGER);
function checkedInteger(value: number, minimum: number): bigint {
  if (!Number.isSafeInteger(value) || value < minimum) throw new RangeError("channel_money_invalid");
  return BigInt(value);
}

/** Normalize weights once, then let the existing pricing owner perform both allocations. */
export function allocateChannelMoney(input: ChannelMoneyAllocationInput): ChannelMoneyAllocation {
  const final = checkedInteger(input.finalMinor, 0), discount = checkedInteger(input.discountMinor, 0);
  const sets = checkedInteger(input.purchasedSets, 1);
  if (final + discount > maximum || input.components.length < 1 || input.components.length > 100) throw new RangeError("channel_money_unsafe");
  if (new Set(input.components.map(row => row.skuId)).size !== input.components.length ||
      new Set(input.components.map(row => row.skuCode)).size !== input.components.length) throw new RangeError("channel_money_invalid");
  const components = [...input.components].sort((a, b) => a.skuCode < b.skuCode ? -1 : a.skuCode > b.skuCode ? 1 : 0).map(row => {
    if (!row.skuId || !row.skuCode || row.skuCode.trim() !== row.skuCode) throw new RangeError("channel_money_invalid");
    const quantity = checkedInteger(row.quantityPerSet, 1) * sets;
    const weight = checkedInteger(row.weightMinor, 1);
    if (quantity > maximum || quantity * weight > maximum) throw new RangeError("channel_money_unsafe");
    return { ...row, quantity: Number(quantity) };
  });
  const reference = components.reduce((sum, row) => sum + BigInt(row.quantity) * BigInt(row.weightMinor), 0n);
  if (reference > maximum) throw new RangeError("channel_money_unsafe");
  const target = final > discount ? final : discount;
  const factor = target > reference ? (target + reference - 1n) / reference : 1n;
  if (factor > maximum || reference * factor > maximum) throw new RangeError("channel_money_unsafe");
  const weighted = components.map(row => ({ sku: row.skuCode, quantity: row.quantity, unitPriceMinor: Number(BigInt(row.weightMinor) * factor) }));
  const allocate = (amount: number) => {
    const result = allocateBundleTargetPrice({ components: weighted, targetPriceMinor: amount, minimumUnitPayableMinor: 0 });
    if (result.ok === false) throw new RangeError("channel_money_allocation_refused");
    return result.lines;
  };
  const finalRows = allocate(input.finalMinor), discountRows = allocate(input.discountMinor);
  const groups = components.flatMap(row => channelComponentMoneyRows(row, finalRows, discountRows));
  const sum = (field: "lineFinalMinor" | "lineDiscountMinor" | "lineGrossMinor") => groups.reduce((total, row) => total + BigInt(row[field]), 0n);
  if (sum("lineFinalMinor") !== final || sum("lineDiscountMinor") !== discount || sum("lineGrossMinor") !== final + discount) {
    throw new RangeError("channel_money_conservation_failed");
  }
  return { normalizationFactor: Number(factor), rawComponents: components.map(({ quantity: _quantity, ...row }) => row), groups };
}
