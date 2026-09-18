import { requestBff, type BffRequestOptions } from "@/lib/bff/client";

import {
  adminCatalogSkuPacksResponseSchema,
  type AdminCatalogSkuPacksResponse,
} from "./contracts";
import { adminProductReconciliationResponseSchema } from "@/domains/fulfillment/contracts";

// Browser → BFF read client for the admin CatalogPage packs panel (Wave H). Read-only: it lists
// the catalog_sku_eans packs per SKU and the open product-reconciliation count (a badge). Both
// endpoints are admin-only (bearer-authed).
function authHeaders(accessToken: string, options: BffRequestOptions): Headers {
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  return headers;
}

export function getCatalogSkuPacks(
  accessToken: string,
  options: BffRequestOptions = {},
): Promise<AdminCatalogSkuPacksResponse> {
  return requestBff("/api/bff/admin/commerce/catalog/sku-eans", adminCatalogSkuPacksResponseSchema, {
    ...options,
    method: "GET",
    headers: authHeaders(accessToken, options),
  });
}

export async function getOpenProductReconciliationCount(
  accessToken: string,
  options: BffRequestOptions = {},
): Promise<number> {
  const result = await requestBff(
    "/api/bff/admin/fulfillment/product-reconciliation-evidence?statusFilter=open",
    adminProductReconciliationResponseSchema,
    { ...options, method: "GET", headers: authHeaders(accessToken, options) },
  );
  return result.openCount;
}
