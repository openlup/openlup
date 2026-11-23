/**
 * Inert server entry point for the OpenLup EasyPost Multi-Carrier Rates (REST v2)
 * Provider Recipe. Importing this file executes zero network I/O, reads zero
 * environment variables, and registers no routes or schedules (ADR-001).
 */

export {
  createEasyPostCarrierRateAdapter,
  easypostCarrierRateCapabilities,
  gramsToOunces,
  mmToInches,
  parseExactDecimalToMinor,
  projectEasyPostStaticCapabilities,
  resolveCurrencyExponent,
} from "./adapter.js";
export type { EasyPostCarrierRateAdapterConfig } from "./adapter.js";

export {
  EASYPOST_API_ORIGIN,
  EASYPOST_SHIPMENTS_URL,
  EasyPostTransportError,
  createEasyPostHttpClient,
  parseRetryAfterHeader,
} from "./client-contract.js";
export type {
  EasyPostAddressInput,
  EasyPostCreateShipmentInput,
  EasyPostFetchLike,
  EasyPostHttpClientConfig,
  EasyPostParcelInput,
  EasyPostRateClient,
  EasyPostRateRecord,
  EasyPostRequestOptions,
  EasyPostShipmentResponse,
  EasyPostTransportErrorKind,
} from "./client-contract.js";
