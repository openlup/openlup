import {
  CARRIER_RATE_QUOTE_CONTRACT_VERSION,
  type CarrierRateQuoteRequest,
} from "@openlup/platform/shipping";
import {
  createScriptedShippingRateFake,
  type ScriptedShippingRateOutcome,
  type ShippingRateAdapterTestSubject,
  type ShippingRateScenarioHarness,
} from "@openlup/platform/shipping/testing";
import {
  createShipEngineHttpClient,
  createShipEngineRateAdapter,
} from "../server/index.js";

/** Synthetic high-visibility canaries used to prove zero secret/PII leakage (provider recipe contract). */
export const SHIPENGINE_TEST_CANARIES = Object.freeze({
  marker: "shipengine-canary-marker/alpha+01",
  apiKey: "shipengine_canary_api_key_0001",
  street: "742 Canary Terrace",
  buyerName: "ShipEngine Canary Recipient",
});

export const SHIPENGINE_BASE_REQUEST: CarrierRateQuoteRequest = {
  contractVersion: CARRIER_RATE_QUOTE_CONTRACT_VERSION,
  requestKey: "se-quote-req-001",
  origin: {
    countryCode: "US",
    postalCode: "78756",
    stateOrProvince: "TX",
    city: "Austin",
    residential: false,
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
      weightGrams: 1200,
      lengthMm: 250,
      widthMm: 180,
      heightMm: 120,
      declaredValueMinor: 5000,
    },
  ],
  currency: "USD",
};

export const SHIPENGINE_HAPPY_PAYLOAD = {
  rate_response: {
    status: "completed",
    shipment_id: "se-shp-10001",
    rate_request_id: "se-req-10001",
    rates: [
      {
        rate_id: "se-rate-exp-1",
        carrier_id: "se-123456",
        carrier_code: "ups",
        service_code: "ups_next_day_air",
        service_type: "UPS Next Day Air",
        shipping_amount: { currency: "usd", amount: 29.95 },
        delivery_days: 1,
        guaranteed_service: true,
        validation_status: "valid",
      },
      {
        rate_id: "se-rate-gnd-1",
        carrier_id: "se-123456",
        carrier_code: "ups",
        service_code: "ups_ground",
        service_type: "UPS Ground",
        shipping_amount: { currency: "usd", amount: 9.45 },
        insurance_amount: { currency: "usd", amount: 1.5 },
        delivery_days: 4,
        guaranteed_service: false,
        validation_status: "valid",
      },
    ],
  },
};

export const SHIPENGINE_NO_RATES_PAYLOAD = {
  rate_response: {
    status: "completed",
    shipment_id: "se-shp-empty",
    rates: [],
  },
};

type FakeCalls = {
  getRates: Response;
};

export function createShipEngineScenarioHarness(
  outcome: ScriptedShippingRateOutcome<Response>,
  options?: {
    readonly supportedCurrencies?: readonly string[];
    readonly apiKey?: string;
  },
): ShippingRateScenarioHarness {
  const fake = createScriptedShippingRateFake<FakeCalls>();
  fake.enqueue("getRates", outcome);

  const client = createShipEngineHttpClient({
    apiKey: options?.apiKey ?? SHIPENGINE_TEST_CANARIES.apiKey,
    fetchImpl: async () => await fake.invoke("getRates"),
  });

  const adapter = createShipEngineRateAdapter({
    client,
    carrierIds: ["se-123456"],
    supportedCurrencies: options?.supportedCurrencies ?? ["USD", "EUR"],
  });

  return {
    adapter,
    request: SHIPENGINE_BASE_REQUEST,
    readIoCount: () => fake.calls.length,
    readFaultLog: () => fake.calls,
  };
}

export function createShipEngineFullSubject(): ShippingRateAdapterTestSubject {
  return {
    id: "shipengine-rest-v1",
    sensitiveValues: [
      SHIPENGINE_TEST_CANARIES.marker,
      SHIPENGINE_TEST_CANARIES.apiKey,
      SHIPENGINE_TEST_CANARIES.street,
      SHIPENGINE_TEST_CANARIES.buyerName,
    ],
    happyQuote: () =>
      createShipEngineScenarioHarness({
        kind: "success",
        value: new Response(JSON.stringify(SHIPENGINE_HAPPY_PAYLOAD), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      }),
    noRatesQuote: () =>
      createShipEngineScenarioHarness({
        kind: "success",
        value: new Response(JSON.stringify(SHIPENGINE_NO_RATES_PAYLOAD), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      }),
    certification: {
      http5xx: () =>
        createShipEngineScenarioHarness({
          kind: "http-failure",
          status: 503,
          response: new Response(
            JSON.stringify({
              errors: [{ message: `leak ${SHIPENGINE_TEST_CANARIES.apiKey} ${SHIPENGINE_TEST_CANARIES.marker}` }],
            }),
            { status: 503 },
          ),
        }),
      httpAuthFailure: () =>
        createShipEngineScenarioHarness({
          kind: "http-failure",
          status: 401,
          response: new Response(
            JSON.stringify({ message: `bad key ${SHIPENGINE_TEST_CANARIES.apiKey}` }),
            { status: 401 },
          ),
        }),
      rateLimited429: () =>
        createShipEngineScenarioHarness({
          kind: "rate-limited-429",
          retryAfterSeconds: 37,
          response: new Response(
            JSON.stringify({ message: "Too Many Requests" }),
            { status: 429, headers: { "retry-after": "37" } },
          ),
        }),
      timeout: () =>
        createShipEngineScenarioHarness({
          kind: "timeout",
        }),
      transportError: () =>
        createShipEngineScenarioHarness({
          kind: "transport-error",
        }),
    },
  };
}
