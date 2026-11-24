/**
 * Inert server entry point for the OpenLup PayPal Orders API v2 Provider Recipe.
 * Importing this file executes zero network I/O, reads zero environment
 * variables, and registers no routes or schedules (provider recipe contract).
 */

export {
  createPayPalPaymentAdapter,
  paypalPaymentCapabilities,
  projectPayPalStaticCapabilities,
} from "./adapter.js";
export type { PayPalPaymentAdapterConfig } from "./adapter.js";

export {
  assertPayPalCredentials,
  assertSafePayPalOrderId,
  createPayPalHttpClient,
  majorStringToMinor,
  minorToMajorString,
  PAYPAL_API_ORIGINS,
  PayPalTransportError,
  resolveCurrencyExponent,
  toSafeDiagnosticCode,
} from "./client-contract.js";
export type {
  PayPalAmount,
  PayPalCaptureResource,
  PayPalCaptureStatus,
  PayPalClient,
  PayPalCreateOrderRequest,
  PayPalCredentials,
  PayPalFetchLike,
  PayPalHttpClientConfig,
  PayPalLink,
  PayPalMode,
  PayPalOrderResource,
  PayPalOrderStatus,
  PayPalPurchaseUnit,
  PayPalRefundResource,
  PayPalRefundStatus,
  PayPalRequestOptions,
  PayPalWebhookSignatureVerificationRequest,
  PayPalWebhookSignatureVerificationResponse,
} from "./client-contract.js";

export {
  createPayPalWebhookVerifier,
  derivePayPalFailureHints,
  mapPayPalRefusal,
  parseStrictPayPalMoney,
} from "./webhook.js";
export type { PayPalWebhookVerifierConfig } from "./webhook.js";
