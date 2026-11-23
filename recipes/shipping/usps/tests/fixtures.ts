import { CARRIER_RATE_QUOTE_CONTRACT_VERSION } from "@openlup/platform/shipping";
import type { CarrierRateQuoteRequest } from "@openlup/platform/shipping/contracts";
import type { UspsBaseRatesResponse } from "../server/index.js";

export const FIXTURE_NOW_MS = 1_900_000_000_000; // Deterministic offline epoch ms
export const FIXTURE_AT_TIME_ISO = "2030-03-17T10:13:20.000Z";

// Safe synthetic canary strings that never trigger secret-scanner regexes.
export const FIXTURE_CANARIES = Object.freeze({
  clientId: ["usps", "canary", "client", "id", "alpha"].join("-"),
  clientSecret: ["usps", "canary", "client", "secret", "beta"].join("-"),
  accessToken: ["usps", "canary", "access", "token", "gamma"].join("-"),
  refreshedToken: ["usps", "canary", "refreshed", "token", "delta"].join("-"),
  rawErrorLeak: ["usps", "canary", "raw", "body", "sentinel"].join("-"),
  originPostal: "90210",
  destinationPostal: "10001-1234",
});

export const FIXTURE_SENSITIVE_VALUES: readonly string[] = Object.freeze([
  FIXTURE_CANARIES.clientId,
  FIXTURE_CANARIES.clientSecret,
  FIXTURE_CANARIES.accessToken,
  FIXTURE_CANARIES.refreshedToken,
  FIXTURE_CANARIES.rawErrorLeak,
]);

export function buildBaseQuoteRequest(
  overrides: Partial<CarrierRateQuoteRequest> = {},
): CarrierRateQuoteRequest {
  return {
    contractVersion: CARRIER_RATE_QUOTE_CONTRACT_VERSION,
    requestKey: "usps-quote-req-1",
    origin: {
      countryCode: "US",
      postalCode: FIXTURE_CANARIES.originPostal,
      stateOrProvince: "CA",
      city: "Beverly Hills",
    },
    destination: {
      countryCode: "US",
      postalCode: FIXTURE_CANARIES.destinationPostal,
      stateOrProvince: "NY",
      city: "New York",
      residential: true,
    },
    parcels: [
      {
        weightGrams: 907, // ~2.00 lb
        lengthMm: 254, // 10.00 in
        widthMm: 152, // ~5.98 in
        heightMm: 102, // ~4.02 in
      },
    ],
    currency: "USD",
    atTime: FIXTURE_AT_TIME_ISO,
    ...overrides,
  };
}

export function buildOAuthTokenPayload(
  accessToken = FIXTURE_CANARIES.accessToken,
  expiresIn = 3600,
): { readonly access_token: string; readonly token_type: string; readonly expires_in: number } {
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: expiresIn,
  };
}

export function buildUspsMultiServiceRatesResponse(): UspsBaseRatesResponse {
  // Intentionally unsorted (Priority Express, then Priority Mail, then Ground Advantage)
  // to verify deterministic ascending amountMinor sorting.
  return {
    rateOptions: [
      {
        totalBasePrice: 31.45,
        rates: [
          {
            mailClass: "PRIORITY_MAIL_EXPRESS",
            description: "USPS Priority Mail Express",
            priceType: "RETAIL",
            rateIndicator: "SP",
            processingCategory: "MACHINABLE",
            destinationEntryFacilityType: "NONE",
            price: 31.45,
            SKU: "DPE00001",
            estimatedDeliveryDays: { min: 1, max: 2 },
            deliveryDateGuaranteed: true,
            endDate: "2030-03-20T00:00:00.000Z",
          },
        ],
      },
      {
        totalBasePrice: "10.075", // Half-away-from-zero decimal string -> 1008 minor cents
        rates: [
          {
            mailClass: "PRIORITY_MAIL",
            description: "USPS Priority Mail",
            priceType: "RETAIL",
            rateIndicator: "SP",
            processingCategory: "MACHINABLE",
            destinationEntryFacilityType: "NONE",
            price: "10.075",
            SKU: "DPM00002",
            estimatedDeliveryDays: { min: 2, max: 3 },
            deliveryDateGuaranteed: false,
          },
        ],
      },
      {
        totalBasePrice: 8.95,
        rates: [
          {
            mailClass: "USPS_GROUND_ADVANTAGE",
            description: "USPS Ground Advantage",
            priceType: "RETAIL",
            rateIndicator: "SP",
            processingCategory: "MACHINABLE",
            destinationEntryFacilityType: "NONE",
            price: 8.95,
            SKU: "DGA00003",
            estimatedDeliveryDays: { min: 2, max: 5 },
            deliveryDateGuaranteed: false,
          },
        ],
      },
    ],
  };
}

export function buildUspsTopLevelRatesResponse(): UspsBaseRatesResponse {
  return {
    rates: [
      {
        mailClass: "USPS_GROUND_ADVANTAGE",
        description: "USPS Ground Advantage",
        price: "7.25",
        SKU: "DGA-TOP-1",
      },
      {
        mailClass: "PRIORITY_MAIL",
        description: "USPS Priority Mail",
        price: 12.4,
        SKU: "DPM-TOP-2",
      },
    ],
  };
}

export function buildUspsEmptyRatesResponse(): UspsBaseRatesResponse {
  return {
    rateOptions: [],
  };
}
