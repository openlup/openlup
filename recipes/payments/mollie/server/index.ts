/**
 * Inert server entry point for the OpenLup Mollie Payments API v2 Provider Recipe.
 * Importing this file executes zero network I/O, reads zero environment
 * variables, and registers no routes or schedules (ADR-001).
 */

export {
  createMolliePaymentAdapter,
  molliePaymentCapabilities,
  projectMollieStaticCapabilities,
} from "./adapter.js";
export type { MolliePaymentAdapterConfig } from "./adapter.js";

export {
  MOLLIE_API_ORIGIN,
  MollieTransportError,
  assertMollieKeyMatchesMode,
  assertSafeMolliePaymentId,
  createMollieHttpClient,
  majorStringToMinor,
  minorToMajorString,
  resolveCurrencyExponent,
  toSafeDiagnosticCode,
} from "./client-contract.js";
export type {
  MollieAmount,
  MollieClient,
  MollieCreatePaymentRequest,
  MollieCreateRefundRequest,
  MollieFetchLike,
  MollieHttpClientConfig,
  MolliePaymentLinks,
  MolliePaymentResource,
  MolliePaymentStatus,
  MollieRefundResource,
  MollieRequestOptions,
  MollieSequenceType,
} from "./client-contract.js";

export {
  createMollieWebhookVerifier,
  deriveMollieFailureHints,
  mapMollieRefusal,
  parseStrictMollieMoney,
} from "./webhook.js";
export type { MollieWebhookVerifierConfig } from "./webhook.js";
