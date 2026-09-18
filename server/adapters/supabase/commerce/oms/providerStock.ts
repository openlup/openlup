import type { OmsFulfillmentProviderStockCurrentRow } from "../../../../../src/domains/commerce/omsFulfillmentDebug.js";
import type { OmsOrderItemRow } from "../../../../../src/domains/commerce/omsReadModel.js";
import { CommerceOmsPersistenceError } from "../../../../../src/domains/commerce/omsPorts.js";
import { distinctIds, type CommerceOmsClient } from "./types.js";

export async function readProviderStockCurrent(
  client: CommerceOmsClient,
  orderItems: OmsOrderItemRow[],
): Promise<OmsFulfillmentProviderStockCurrentRow[]> {
  const skuIds = distinctIds(orderItems.map((item) => item.sku_id ?? null));
  if (!skuIds.length) return [];
  const result = await client
    .from("fulfillment_provider_stock_current")
    .select("provider_kind, sku, provider_for_sale_quantity, provider_total_quantity, last_synced_at, stale_after")
    .eq("provider_kind", "omnipack")
    .in("catalog_sku_id", skuIds);
  if (result.error) {
    if (isOptionalProviderStockError(result.error)) return [];
    throw new CommerceOmsPersistenceError("Commerce OMS provider stock current read failed");
  }
  return (result.data ?? []) as OmsFulfillmentProviderStockCurrentRow[];
}

function isOptionalProviderStockError(error: { code?: string; message?: string; details?: string; hint?: string } | null): boolean {
  if (!error) return false;
  const text = `${error.message ?? ""} ${error.details ?? ""} ${error.hint ?? ""}`.toLowerCase();
  return ["fulfillment_provider_stock_current", "provider_kind"].some((column) => text.includes(column));
}
