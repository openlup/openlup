import { requestBff, type BffRequestOptions } from "@/lib/bff/client";
import {
  catalogAllergenListResponseSchema,
  catalogProductListResponseSchema,
  catalogProductReadResponseSchema,
  sellableCatalogListResponseSchema,
  type CatalogAllergenListResponse,
  type CatalogProductListResponse,
  type CatalogProductReadResponse,
  type SellableCatalogListResponse,
} from "./contracts";
import type { CatalogProductSlug } from "./types";

export function listCatalogProducts(
  options: BffRequestOptions = {},
): Promise<CatalogProductListResponse> {
  return requestBff("/api/bff/catalog/products", catalogProductListResponseSchema, {
    ...options,
    method: "GET",
  });
}

export function getCatalogProduct(
  slug: CatalogProductSlug,
  options: BffRequestOptions = {},
): Promise<CatalogProductReadResponse> {
  return requestBff(
    `/api/bff/catalog/products/${slug}`,
    catalogProductReadResponseSchema,
    {
      ...options,
      method: "GET",
    },
  );
}

export function listCatalogAllergens(
  options: BffRequestOptions = {},
): Promise<CatalogAllergenListResponse> {
  return requestBff("/api/bff/catalog/allergens", catalogAllergenListResponseSchema, {
    ...options,
    method: "GET",
  });
}

/** Local-profile-only neutral catalog; production returns the standard 404 envelope. */
export function listReferenceStoreItems(
  options: BffRequestOptions = {},
): Promise<SellableCatalogListResponse> {
  return requestBff("/api/bff/catalog/items", sellableCatalogListResponseSchema, {
    ...options,
    method: "GET",
  });
}
