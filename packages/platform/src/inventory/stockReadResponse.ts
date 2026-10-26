import type { NewPurchaseStockRow } from "./contracts/newPurchaseStock.js";

export function stockObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("inventory_stock_response_invalid");
  return value as Record<string, unknown>;
}
export function stockQuantity(value: unknown): number {
  if ((typeof value !== "number" && typeof value !== "string") || String(value).trim() === "") throw new Error("inventory_stock_quantity_invalid");
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("inventory_stock_quantity_invalid");
  return n;
}

export function parseStockReadResponse(value: unknown): Map<string, NewPurchaseStockRow> {
  if (!Array.isArray(value)) throw new Error("inventory_stock_response_invalid");
  return new Map(value.map(value => {
    const row = stockObject(value);
    if (typeof row.sku !== "string" || !["provider", "missing"].includes(String(row.source)) || typeof row.stale !== "boolean") throw new Error("inventory_stock_response_invalid");
    const result: NewPurchaseStockRow = { sku: row.sku, catalogSkuId: row.catalogSkuId == null ? null : String(row.catalogSkuId),
      source: row.source as "provider" | "missing", providerForSale: row.providerForSale == null ? null : stockQuantity(row.providerForSale),
      activeHolds: stockQuantity(row.activeHolds), safetyStock: stockQuantity(row.safetyStock), available: stockQuantity(row.available), stale: row.stale,
      renewalDemand: stockQuantity(row.renewalDemand), availableForNewPurchases: stockQuantity(row.availableForNewPurchases), excludedOrderHolds: stockQuantity(row.excludedOrderHolds) };
    return [result.sku, result];
  }));
}
