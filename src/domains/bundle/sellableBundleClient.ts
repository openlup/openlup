import { requestBff, type BffRequestOptions } from "@/lib/bff/client";

import {
  sellableBundleListResponseSchema,
  type SellableBundleListResponse,
} from "./sellableBundleContracts";

/**
 * Browser -> BFF client for the PUBLIC sellable-bundle feed.
 *
 * It is deliberately not part of the admin client: that one is bearer-authed and
 * speaks the write contracts; this one carries no credential at all, because the
 * feed is the storefront's read and adding an Authorization header here would be
 * the first step towards a surface that answers differently when signed in.
 *
 * The response is parsed through the same `.strict()` contract the handler
 * validates before sending, so both ends refuse the same drift.
 */
const SELLABLE_BUNDLE_BFF_PATH = "/api/bff/catalog/bundles";

export function fetchSellableBundles(
  options: BffRequestOptions = {},
): Promise<SellableBundleListResponse> {
  return requestBff(SELLABLE_BUNDLE_BFF_PATH, sellableBundleListResponseSchema, {
    ...options,
    method: "GET",
  });
}
