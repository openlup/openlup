import type { OmsOrderDetail } from "./omsContracts.js";
import type { OmsOrderItemRow } from "./omsReadModelRows.js";
import type { CanonicalOrderMoneyLine } from "./orderMoney.js";
import type { CommerceCurrency } from "./types.js";

export function mapOmsOrderLine(
  item: OmsOrderItemRow,
  currency: CommerceCurrency,
  moneyLine: CanonicalOrderMoneyLine,
): OmsOrderDetail["lines"][number] {
  const productSnapshot = item.product_snapshot ?? {};
  const variantSnapshot = item.variant_snapshot ?? null;
  return {
    id: item.id,
    skuId: item.sku_id ?? null,
    sku: item.sku ?? readSnapshotText(productSnapshot, "sku"),
    title: item.title
      ?? readSnapshotText(productSnapshot, "title")
      ?? readSnapshotText(productSnapshot, "name"),
    quantity: item.quantity,
    unitPrice: { amountMinor: moneyLine.catalogUnit, currency },
    total: { amountMinor: moneyLine.catalogTotal, currency },
    discountAllocated: { amountMinor: moneyLine.discountAllocated, currency },
    effectiveTotal: { amountMinor: moneyLine.effectiveGross, currency },
    effectiveNet: { amountMinor: moneyLine.effectiveNet, currency },
    vatRateBps: moneyLine.vatRateBps,
    productSnapshot,
    variantSnapshot,
  };
}

function readSnapshotText(snapshot: Record<string, unknown>, key: string): string | null {
  const value = snapshot[key];
  return typeof value === "string" && value.trim() ? value : null;
}
