import { CARRIER_RATE_QUOTE_CONTRACT_VERSION } from "@openlup/platform/shipping";
import type { CarrierRateQuoteRequest } from "@openlup/platform/shipping/contracts";
import type { EasyPostShipmentResponse } from "../server/index.js";

export const EASYPOST_TEST_CANARIES = Object.freeze({
  apiKey: "ep-canary-alpha-marker",
  altApiKey: "ep-canary-beta-marker",
  rawErrorSecret: "ep-canary-body-secret-token",
});

export const EASYPOST_TEST_AT_TIME = "2000-06-01T12:00:00.000Z";

export const EASYPOST_BASE_REQUEST: CarrierRateQuoteRequest = {
  contractVersion: CARRIER_RATE_QUOTE_CONTRACT_VERSION,
  requestKey: "ep-quote-req-001",
  origin: {
    countryCode: "US",
    postalCode: "94107",
    stateOrProvince: "CA",
    city: "San Francisco",
  },
  destination: {
    countryCode: "US",
    postalCode: "10001",
    stateOrProvince: "NY",
    city: "New York",
    residential: true,
  },
  parcels: [
    {
      weightGrams: 850,
      lengthMm: 254,
      widthMm: 203,
      heightMm: 102,
    },
  ],
  currency: "USD",
  atTime: EASYPOST_TEST_AT_TIME,
};

export function createHappyMultiCarrierShipmentResponse(): EasyPostShipmentResponse {
  return {
    id: "shp_ep_fixture_001",
    rates: [
      {
        id: "rate_fedex_2day",
        carrier: "FedEx",
        service: "2Day",
        rate: "18.50",
        currency: "USD",
        delivery_days: 2,
        delivery_date_guaranteed: true,
      },
      {
        id: "rate_usps_priority",
        carrier: "USPS",
        service: "Priority",
        rate: "7.95",
        currency: "USD",
        est_delivery_days: 3,
        delivery_date_guaranteed: false,
      },
      {
        id: "rate_ups_ground",
        carrier: "UPS",
        service: "Ground",
        rate: "11.40",
        currency: "USD",
        delivery_days: 4,
        delivery_date_guaranteed: false,
      },
      {
        id: "rate_intl_foreign_currency",
        carrier: "FedEx",
        service: "ExpressWorldwide",
        rate: "42.00",
        currency: "EUR",
        delivery_days: 2,
      },
    ],
  };
}

export function createEmptyRatesShipmentResponse(): EasyPostShipmentResponse {
  return {
    id: "shp_ep_empty_001",
    rates: [],
  };
}

export const EASYPOST_DECIMAL_MONEY_CASES: readonly {
  readonly raw: string;
  readonly currency: string;
  readonly expectedMinor: number | null;
}[] = [
  { raw: "7.95", currency: "USD", expectedMinor: 795 },
  { raw: "7.9", currency: "USD", expectedMinor: 790 },
  { raw: "7", currency: "USD", expectedMinor: 700 },
  { raw: "0.05", currency: "USD", expectedMinor: 5 },
  { raw: "0.00", currency: "USD", expectedMinor: 0 },
  { raw: "7.950", currency: "USD", expectedMinor: 795 },
  { raw: "1000", currency: "JPY", expectedMinor: 1000 },
  { raw: "1000.00", currency: "JPY", expectedMinor: 1000 },
  { raw: "1.500", currency: "KWD", expectedMinor: 1500 },
  { raw: "1.5", currency: "KWD", expectedMinor: 1500 },
  { raw: "7.955", currency: "USD", expectedMinor: null },
  { raw: "1000.5", currency: "JPY", expectedMinor: null },
  { raw: "-7.95", currency: "USD", expectedMinor: null },
  { raw: "+7.95", currency: "USD", expectedMinor: null },
  { raw: "07.95", currency: "USD", expectedMinor: null },
  { raw: " 7.95", currency: "USD", expectedMinor: null },
  { raw: "7.95 ", currency: "USD", expectedMinor: null },
  { raw: "1e2", currency: "USD", expectedMinor: null },
  { raw: "9999999999999999.99", currency: "USD", expectedMinor: null },
  { raw: "7.95", currency: "usd", expectedMinor: null },
];
