import {
  CARRIER_RATE_QUOTE_CONTRACT_VERSION,
  projectCarrierRateStaticCapabilities,
  sortCarrierRateOptions,
  validateCarrierRateRequestAgainstCapabilities,
  type CarrierRateAddress,
  type CarrierRateCapabilities,
  type CarrierRateOption,
  type CarrierRateQuotePort,
  type CarrierRateQuoteRequest,
  type CarrierRateQuoteResult,
} from "@openlup/platform/shipping";
import {
  decimalAmountToMinor,
  minorToMajorNumber,
  resolveCurrencyExponent,
  ShipEngineTransportError,
  toSafeDiagnosticCode,
  type ShipEngineAddress,
  type ShipEngineClient,
  type ShipEngineMonetaryAmount,
  type ShipEnginePackage,
  type ShipEngineRateItem,
  type ShipEngineRatesRequest,
} from "./client-contract.js";

export interface ShipEngineRateAdapterConfig {
  /** Narrow structural client (use createShipEngineHttpClient for zero-SDK REST v1). */
  client: ShipEngineClient;
  /** ShipEngine carrier IDs configured on the host account (e.g. ["se-123456"]). */
  carrierIds: readonly string[];
  /** Host-configured canonical 3-letter ISO-4217 uppercase currency codes. */
  supportedCurrencies: readonly string[];
  /** Optional ShipEngine address validation mode (default "no_validation"). */
  validateAddress?: "no_validation" | "validate_only" | "validate_and_clean";
}

const CURRENCY_PATTERN = /^[A-Z]{3}$/u;

/** Static protocol capability descriptor; host supplies supportedCurrencies at construction. */
export const shipEngineRateCapabilities: Readonly<CarrierRateCapabilities> =
  Object.freeze<CarrierRateCapabilities>({
    contractVersion: CARRIER_RATE_QUOTE_CONTRACT_VERSION,
    providerKind: "shipengine",
    multiParcel: true,
    dimensionsRequired: false,
    supportedOriginCountries: "any",
    supportedDestinationCountries: "any",
    /** Host-configured via ShipEngineRateAdapterConfig.supportedCurrencies. */
    supportedCurrencies: Object.freeze([]),
    deliveryKinds: Object.freeze(["courier"] as const),
    requiresCredentials: true,
  });

/**
 * Deterministic serializable projection of static capabilities (redacting host-configured
 * `supportedCurrencies`), cross-checked mechanically against `recipe.json#staticCapabilities`.
 */
export function projectShipEngineStaticCapabilities(
  capabilities: CarrierRateCapabilities = shipEngineRateCapabilities,
): CarrierRateCapabilities {
  return projectCarrierRateStaticCapabilities(capabilities, {
    redactSupportedCurrencies: true,
  });
}

function toShipEngineAddress(address: CarrierRateAddress): ShipEngineAddress {
  return {
    address_line1: "Rate Quote Address",
    city_locality: address.city?.trim() || "City",
    ...(address.stateOrProvince?.trim() ? { state_province: address.stateOrProvince.trim() } : {}),
    postal_code: address.postalCode.trim(),
    country_code: address.countryCode,
    address_residential_indicator:
      address.residential === true ? "yes" : address.residential === false ? "no" : "unknown",
  };
}

function mmToCentimeters(mm: number): number {
  const whole = Math.floor(mm / 10);
  const tenths = mm % 10;
  return Number(`${whole}.${tenths}`);
}

function sumRateChargesMinor(
  rate: ShipEngineRateItem,
  expectedCurrency: string,
): number | null {
  const baseMinor =
    rate.shipping_amount && rate.shipping_amount.currency?.toUpperCase() === expectedCurrency
      ? decimalAmountToMinor(rate.shipping_amount.amount, expectedCurrency)
      : null;
  if (baseMinor === null) {
    return null;
  }

  let total = BigInt(baseMinor);
  const extras: readonly (ShipEngineMonetaryAmount | null | undefined)[] = [
    rate.insurance_amount,
    rate.confirmation_amount,
    rate.other_amount,
  ];
  for (const extra of extras) {
    if (!extra) continue;
    if (extra.currency?.toUpperCase() !== expectedCurrency) {
      return null;
    }
    const minor = decimalAmountToMinor(extra.amount, expectedCurrency);
    if (minor === null) {
      return null;
    }
    total += BigInt(minor);
  }
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null;
  }
  return Number(total);
}

function mapShipEngineRate(
  rate: ShipEngineRateItem,
  expectedCurrency: string,
): CarrierRateOption | null {
  if (rate.validation_status === "invalid") {
    return null;
  }
  const amountMinor = sumRateChargesMinor(rate, expectedCurrency);
  if (amountMinor === null) {
    return null;
  }
  const carrierCode = rate.carrier_code?.trim() || rate.carrier_id?.trim() || "shipengine";
  const serviceCode = rate.service_code?.trim() || rate.service_type?.trim();
  const serviceName = rate.service_type?.trim() || serviceCode;
  if (!serviceCode || !serviceName) {
    return null;
  }

  const estimatedTransitDays =
    typeof rate.delivery_days === "number"
    && Number.isInteger(rate.delivery_days)
    && rate.delivery_days >= 0
      ? { min: rate.delivery_days, max: rate.delivery_days }
      : undefined;

  return {
    carrierCode: carrierCode.slice(0, 64),
    serviceCode: serviceCode.slice(0, 128),
    serviceName: serviceName.slice(0, 160),
    deliveryKind: "courier",
    amountMinor,
    currency: expectedCurrency,
    ...(estimatedTransitDays ? { estimatedTransitDays } : {}),
    ...(typeof rate.guaranteed_service === "boolean"
      ? { deliveryDateGuaranteed: rate.guaranteed_service }
      : {}),
    ...(rate.rate_id?.trim() ? { providerRateRef: rate.rate_id.trim().slice(0, 160) } : {}),
  };
}

function mapFailureToRefusal(error: unknown): Extract<CarrierRateQuoteResult, { kind: "refused" }> {
  // Never echo raw error.message or headers into diagnostics.
  if (error instanceof ShipEngineTransportError) {
    if (error.kind === "authentication_failed") {
      return {
        kind: "refused",
        providerKind: "shipengine",
        reason: "authentication_failed",
        retryable: false,
        diagnosticCode: error.diagnosticCode,
      };
    }
    if (error.kind === "rate_limited") {
      return {
        kind: "refused",
        providerKind: "shipengine",
        reason: "rate_limited",
        retryable: true,
        diagnosticCode: error.diagnosticCode,
        ...(error.retryAfterSeconds !== undefined
          ? { retryAfterSeconds: error.retryAfterSeconds }
          : {}),
      };
    }
    if (error.kind === "timeout") {
      return {
        kind: "refused",
        providerKind: "shipengine",
        reason: "timeout",
        retryable: true,
        diagnosticCode: error.diagnosticCode,
      };
    }
    if (error.kind === "provider_unavailable") {
      return {
        kind: "refused",
        providerKind: "shipengine",
        reason: "provider_unavailable",
        retryable: true,
        diagnosticCode: error.diagnosticCode,
      };
    }
    return {
      kind: "refused",
      providerKind: "shipengine",
      reason: "provider_error",
      retryable: false,
      diagnosticCode: toSafeDiagnosticCode(error.diagnosticCode, "SHIPENGINE_PROVIDER_ERROR"),
    };
  }

  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return {
      kind: "refused",
      providerKind: "shipengine",
      reason: "timeout",
      retryable: true,
      diagnosticCode: "SHIPENGINE_TIMEOUT",
    };
  }

  return {
    kind: "refused",
    providerKind: "shipengine",
    reason: "provider_unavailable",
    retryable: true,
    diagnosticCode: "SHIPENGINE_TRANSPORT_ERROR",
  };
}

/**
 * Explicit factory for the ShipEngine REST v1 CarrierRateQuotePort.
 * Importing this module performs zero I/O, reads zero environment variables,
 * and registers no routes, schedules, or global state.
 */
export function createShipEngineRateAdapter(
  config: ShipEngineRateAdapterConfig,
): CarrierRateQuotePort {
  if (
    !Array.isArray(config.carrierIds)
    || config.carrierIds.length === 0
    || !config.carrierIds.every((id) => typeof id === "string" && id.trim().length > 0)
  ) {
    throw new Error("ShipEngine adapter requires a non-empty list of carrierIds");
  }
  if (
    !Array.isArray(config.supportedCurrencies)
    || config.supportedCurrencies.length === 0
    || !config.supportedCurrencies.every(
      (c) =>
        typeof c === "string"
        && CURRENCY_PATTERN.test(c)
        && resolveCurrencyExponent(c) !== null,
    )
  ) {
    throw new Error(
      "ShipEngine adapter requires a non-empty list of valid 3-letter ISO-4217 supportedCurrencies",
    );
  }

  const carrierIds = Object.freeze(config.carrierIds.map((id) => id.trim()));
  const supportedCurrencies = Object.freeze([...new Set(config.supportedCurrencies)].sort());
  const capabilities: CarrierRateCapabilities = Object.freeze({
    ...shipEngineRateCapabilities,
    supportedCurrencies,
  });

  return {
    capabilities,
    async quoteRates(request: CarrierRateQuoteRequest): Promise<CarrierRateQuoteResult> {
      const preDispatchRefusal = validateCarrierRateRequestAgainstCapabilities(request, capabilities);
      if (preDispatchRefusal) {
        return preDispatchRefusal;
      }

      const packages: ShipEnginePackage[] = request.parcels.map((parcel) => ({
        weight: { value: parcel.weightGrams, unit: "gram" },
        ...(parcel.lengthMm !== undefined && parcel.widthMm !== undefined && parcel.heightMm !== undefined
          ? {
              dimensions: {
                unit: "centimeter",
                length: mmToCentimeters(parcel.lengthMm),
                width: mmToCentimeters(parcel.widthMm),
                height: mmToCentimeters(parcel.heightMm),
              },
            }
          : {}),
        ...(parcel.declaredValueMinor !== undefined
          ? {
              insured_value: {
                currency: request.currency.toLowerCase(),
                amount: minorToMajorNumber(parcel.declaredValueMinor, request.currency),
              },
            }
          : {}),
      }));

      const payload: ShipEngineRatesRequest = {
        rate_options: {
          carrier_ids: carrierIds,
          ...(request.serviceFilter ? { service_codes: request.serviceFilter } : {}),
        },
        shipment: {
          validate_address: config.validateAddress ?? "no_validation",
          ship_to: toShipEngineAddress(request.destination),
          ship_from: toShipEngineAddress(request.origin),
          packages,
          ...(request.atTime ? { ship_date: request.atTime } : {}),
        },
      };

      try {
        const response = await config.client.getRates(payload, { signal: request.signal });
        const rawRates = response?.rate_response?.rates;
        if (!Array.isArray(rawRates) || rawRates.length === 0) {
          return {
            kind: "no_rates",
            providerKind: "shipengine",
            diagnosticCode: "SHIPENGINE_NO_RATES",
          };
        }

        const mapped: CarrierRateOption[] = [];
        for (const item of rawRates) {
          if (!item || typeof item !== "object") continue;
          const option = mapShipEngineRate(item, request.currency);
          if (option) mapped.push(option);
        }

        if (mapped.length === 0) {
          return {
            kind: "no_rates",
            providerKind: "shipengine",
            diagnosticCode: "SHIPENGINE_NO_ELIGIBLE_RATES",
          };
        }

        const shipmentRef = response.rate_response?.shipment_id?.trim();
        return {
          kind: "quoted",
          providerKind: "shipengine",
          currency: request.currency,
          rates: sortCarrierRateOptions(mapped),
          ...(shipmentRef ? { providerShipmentRef: shipmentRef.slice(0, 160) } : {}),
        };
      } catch (error) {
        return mapFailureToRefusal(error);
      }
    },
  };
}
