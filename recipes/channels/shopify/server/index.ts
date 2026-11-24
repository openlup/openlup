/**
 * Inert server entry point for the OpenLup Shopify Storefront Channel Recipe.
 * Importing this file executes zero network I/O, reads zero environment
 * variables, and registers no routes or schedules (provider recipe contract).
 */

export {
  createShopifyChannelAdapter,
  shopifyChannelCapabilities,
} from "./adapter.js";
export type { ShopifyChannelAdapterConfig } from "./adapter.js";

export {
  assertValidShopifyAccessToken,
  assertValidShopifyShopDomain,
  createShopifyHttpClient,
  parseShopifyDecimalToMinor,
  parseShopifyNextPageCursor,
  resolveCurrencyExponent,
  SHOPIFY_API_VERSION,
  SHOPIFY_SHOP_DOMAIN_PATTERN,
  ShopifyTransportError,
  toSafeDiagnosticCode,
} from "./client-contract.js";
export type {
  ShopifyAddress,
  ShopifyAdminClient,
  ShopifyCustomer,
  ShopifyDiscountAllocation,
  ShopifyFetchLike,
  ShopifyHttpClientConfig,
  ShopifyLineItem,
  ShopifyListOrdersInput,
  ShopifyListOrdersPage,
  ShopifyMoneyAmount,
  ShopifyOrderResource,
  ShopifyShippingLine,
  ShopifyTaxLine,
  ShopifyTransportErrorKind,
} from "./client-contract.js";
