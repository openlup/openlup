import { requestBff, type BffRequestOptions } from "@/lib/bff/client";

import {
  activateCatalogProductResponseSchema,
  archiveCatalogSkuResponseSchema,
  createCatalogDraftResponseSchema,
  setCatalogPriceResponseSchema,
  type ActivateCatalogProductRequest,
  type ActivateCatalogProductResponse,
  type ArchiveCatalogSkuRequest,
  type ArchiveCatalogSkuResponse,
  type CreateCatalogDraftRequest,
  type CreateCatalogDraftResponse,
  type SetCatalogPriceRequest,
  type SetCatalogPriceResponse,
} from "./adminCatalogContracts";
import {
  getCatalogProductResponseSchema,
  listCatalogProductsResponseSchema,
  type GetCatalogProductResponse,
  type ListCatalogProductsRequest,
  type ListCatalogProductsResponse,
} from "./adminCatalogReadContracts";

/**
 * Browser → BFF client for the admin "Katalog" surface — the React head of the
 * agent-operable catalog (Wave 5.5). It speaks the SAME Wave-4a write contracts the
 * MCP agent head uses (the multi-head pattern: one contract, two heads). Bearer-authed
 * admin only; `activate` (publish) is human-only — agents are draft-only.
 */
function authHeaders(accessToken: string, options: BffRequestOptions): Headers {
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  return headers;
}

export function createCatalogDraft(
  accessToken: string,
  request: CreateCatalogDraftRequest,
  options: BffRequestOptions = {},
): Promise<CreateCatalogDraftResponse> {
  return requestBff("/api/bff/admin/commerce/catalog/create", createCatalogDraftResponseSchema, {
    ...options,
    method: "POST",
    headers: authHeaders(accessToken, options),
    body: request,
  });
}

export function setCatalogPrice(
  accessToken: string,
  request: SetCatalogPriceRequest,
  options: BffRequestOptions = {},
): Promise<SetCatalogPriceResponse> {
  return requestBff("/api/bff/admin/commerce/catalog/set-price", setCatalogPriceResponseSchema, {
    ...options,
    method: "POST",
    headers: authHeaders(accessToken, options),
    body: request,
  });
}

export function archiveCatalogSku(
  accessToken: string,
  request: ArchiveCatalogSkuRequest,
  options: BffRequestOptions = {},
): Promise<ArchiveCatalogSkuResponse> {
  return requestBff("/api/bff/admin/commerce/catalog/archive", archiveCatalogSkuResponseSchema, {
    ...options,
    method: "POST",
    headers: authHeaders(accessToken, options),
    body: request,
  });
}

/**
 * Publish a draft product (draft → active). Human-only: the BFF route is gated on
 * `COMMERCE_CATALOG_ACTIVATION_ENABLED` and the underlying RPC RAISEs for machine
 * actors. This is the button the MCP agent head deliberately does not have.
 */
export function activateCatalogProduct(
  accessToken: string,
  request: ActivateCatalogProductRequest,
  options: BffRequestOptions = {},
): Promise<ActivateCatalogProductResponse> {
  return requestBff("/api/bff/admin/commerce/catalog/activate", activateCatalogProductResponseSchema, {
    ...options,
    method: "POST",
    headers: authHeaders(accessToken, options),
    body: request,
  });
}

/**
 * The two catalog READS the bundle composition editor needs to offer a unit picker.
 *
 * A bundle component is a SKU, but the list route answers PRODUCTS — SKUs live one
 * level down, in the product detail. So the picker is deliberately two steps
 * (choose an active product, then one of its active SKUs) rather than one flat
 * list: a flat list would need a fan-out `get` per product on every page load, and
 * the flat SKU projection that does exist (`catalog/sku-eans`) is a barcode
 * projection that only contains units someone registered an EAN for.
 *
 * Both are GETs; the routes parse `req.query` and refuse any other method.
 */
export function listCatalogProducts(
  accessToken: string,
  request: Partial<ListCatalogProductsRequest> = {},
  options: BffRequestOptions = {},
): Promise<ListCatalogProductsResponse> {
  const query = new URLSearchParams(
    Object.entries(request)
      .filter(([, value]) => value !== undefined && value !== "")
      .map(([key, value]) => [key, String(value)]),
  ).toString();
  return requestBff(
    `/api/bff/admin/commerce/catalog/list${query ? `?${query}` : ""}`,
    listCatalogProductsResponseSchema,
    { ...options, method: "GET", headers: authHeaders(accessToken, options) },
  );
}

export function getCatalogProduct(
  accessToken: string,
  slug: string,
  options: BffRequestOptions = {},
): Promise<GetCatalogProductResponse> {
  return requestBff(
    `/api/bff/admin/commerce/catalog/get?slug=${encodeURIComponent(slug)}`,
    getCatalogProductResponseSchema,
    { ...options, method: "GET", headers: authHeaders(accessToken, options) },
  );
}
