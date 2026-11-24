/**
 * Inert server entry point for the OpenLup ShipEngine REST v1 Rates Provider Recipe.
 * Importing this file executes zero network I/O, reads zero environment
 * variables, and registers no routes or schedules (provider recipe contract).
 */

export {
  createShipEngineRateAdapter,
  projectShipEngineStaticCapabilities,
  shipEngineRateCapabilities,
} from "./adapter.js";
export type { ShipEngineRateAdapterConfig } from "./adapter.js";

export {
  assertValidShipEngineApiKey,
  createShipEngineHttpClient,
  decimalAmountToMinor,
  minorToMajorNumber,
  resolveCurrencyExponent,
  SHIPENGINE_API_ORIGIN,
  ShipEngineTransportError,
  toSafeDiagnosticCode,
} from "./client-contract.js";
export type {
  ShipEngineAddress,
  ShipEngineClient,
  ShipEngineFetchLike,
  ShipEngineHttpClientConfig,
  ShipEngineMonetaryAmount,
  ShipEnginePackage,
  ShipEngineRateItem,
  ShipEngineRatesRequest,
  ShipEngineRatesResponse,
  ShipEngineTransportErrorKind,
} from "./client-contract.js";
