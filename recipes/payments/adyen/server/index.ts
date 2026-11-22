/**
 * Inert server entry point for the OpenLup Adyen Checkout v71 Provider Recipe.
 * Importing this file executes zero network I/O, reads zero environment
 * variables, and registers no routes or schedules (ADR-001).
 */

export {
  adyenPaymentCapabilities,
  createAdyenPaymentAdapter,
  projectAdyenStaticCapabilities,
} from "./adapter.js";
export type { AdyenPaymentAdapterConfig } from "./adapter.js";

export {
  ADYEN_TEST_CHECKOUT_ORIGIN,
  AdyenTransportError,
  assertSafeAdyenPathSegment,
  createAdyenHttpClient,
  resolveAdyenCheckoutBaseUrl,
  toSafeDiagnosticCode,
} from "./client-contract.js";
export type {
  AdyenAmount,
  AdyenCancelPaymentRequest,
  AdyenCancelPaymentResponse,
  AdyenCheckoutClient,
  AdyenCreatePaymentRequest,
  AdyenCreatePaymentResponse,
  AdyenCreateSessionRequest,
  AdyenCreateSessionResponse,
  AdyenFetchLike,
  AdyenHttpClientConfig,
  AdyenRequestOptions,
} from "./client-contract.js";

export {
  computeAdyenNotificationHmac,
  createAdyenWebhookVerifier,
  escapeAdyenHmacField,
} from "./webhook.js";
export type {
  AdyenCanonicalHmacFields,
  AdyenCaptureMode,
  AdyenWebhookVerifierConfig,
} from "./webhook.js";
