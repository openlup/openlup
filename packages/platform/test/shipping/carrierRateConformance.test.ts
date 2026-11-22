import { describe, expect, it } from "vitest";
import {
  CARRIER_RATE_QUOTE_CONTRACT_VERSION,
  projectCarrierRateStaticCapabilities,
  selectCheapestCarrierRate,
  sortCarrierRateOptions,
  validateCarrierRateRequestAgainstCapabilities,
  type CarrierRateCapabilities,
  type CarrierRateOption,
  type CarrierRateQuotePort,
  type CarrierRateQuoteRequest,
  type CarrierRateQuoteResult,
} from "../../src/shipping/index.js";
import {
  createScriptedShippingRateFake,
  runShippingRateAdapterConformance,
  ScriptedShippingRateTransportError,
  type ScriptedShippingRateOutcome,
  type ShippingRateScenarioHarness,
} from "../../src/shipping/testing/index.js";

type SyntheticCalls = {
  quote: readonly CarrierRateOption[];
};

const BASE_CAPABILITIES: CarrierRateCapabilities = {
  contractVersion: CARRIER_RATE_QUOTE_CONTRACT_VERSION,
  providerKind: "synthetic_carrier",
  multiParcel: false,
  dimensionsRequired: true,
  supportedOriginCountries: ["US"],
  supportedDestinationCountries: ["US", "CA"],
  supportedCurrencies: ["USD", "CAD"],
  deliveryKinds: ["courier"],
  requiresCredentials: true,
};

const BASE_REQUEST: CarrierRateQuoteRequest = {
  contractVersion: CARRIER_RATE_QUOTE_CONTRACT_VERSION,
  requestKey: "quote-req-001",
  origin: { countryCode: "US", postalCode: "94107", stateOrProvince: "CA", city: "San Francisco" },
  destination: { countryCode: "US", postalCode: "10001", stateOrProvince: "NY", city: "New York" },
  parcels: [{ weightGrams: 500, lengthMm: 200, widthMm: 150, heightMm: 100 }],
  currency: "USD",
};

const CANARY_VALUE = "sensitive-canary-marker-one";

function createSyntheticCarrierHarness(
  outcome: ScriptedShippingRateOutcome<readonly CarrierRateOption[]>,
  overrides?: {
    readonly mutateResult?: (res: CarrierRateQuoteResult) => CarrierRateQuoteResult;
    readonly skipPreValidation?: boolean;
    readonly forgeFaultLog?: boolean;
  },
): ShippingRateScenarioHarness {
  const fake = createScriptedShippingRateFake<SyntheticCalls>();
  fake.enqueue("quote", outcome);

  const adapter: CarrierRateQuotePort = {
    capabilities: BASE_CAPABILITIES,
    async quoteRates(request): Promise<CarrierRateQuoteResult> {
      if (!overrides?.skipPreValidation) {
        const refusal = validateCarrierRateRequestAgainstCapabilities(request, BASE_CAPABILITIES);
        if (refusal) return refusal;
      }
      try {
        const rates = await fake.invoke("quote");
        const result: CarrierRateQuoteResult =
          rates.length === 0
            ? { kind: "no_rates", providerKind: BASE_CAPABILITIES.providerKind, diagnosticCode: "NO_ELIGIBLE_RATES" }
            : {
                kind: "quoted",
                providerKind: BASE_CAPABILITIES.providerKind,
                currency: request.currency,
                rates: sortCarrierRateOptions(rates),
                providerShipmentRef: "shp_syn_001",
              };
        return overrides?.mutateResult ? overrides.mutateResult(result) : result;
      } catch (error) {
        if (error instanceof ScriptedShippingRateTransportError) {
          if (error.kind === "timeout") {
            return {
              kind: "refused",
              providerKind: BASE_CAPABILITIES.providerKind,
              reason: "timeout",
              retryable: true,
              diagnosticCode: "CARRIER_TIMEOUT",
            };
          }
          if (error.kind === "rate-limited-429") {
            return {
              kind: "refused",
              providerKind: BASE_CAPABILITIES.providerKind,
              reason: "rate_limited",
              retryable: true,
              diagnosticCode: "CARRIER_RATE_LIMITED",
              ...(error.retryAfterSeconds !== undefined
                ? { retryAfterSeconds: error.retryAfterSeconds }
                : {}),
            };
          }
          if (error.kind === "http-failure" && (error.status === 401 || error.status === 403)) {
            return {
              kind: "refused",
              providerKind: BASE_CAPABILITIES.providerKind,
              reason: "authentication_failed",
              retryable: false,
              diagnosticCode: "CARRIER_AUTH_FAILED",
            };
          }
          return {
            kind: "refused",
            providerKind: BASE_CAPABILITIES.providerKind,
            reason: "provider_unavailable",
            retryable: true,
            diagnosticCode: "CARRIER_UNAVAILABLE",
          };
        }
        return {
          kind: "refused",
          providerKind: BASE_CAPABILITIES.providerKind,
          reason: "provider_error",
          retryable: false,
          diagnosticCode: "CARRIER_UNEXPECTED_ERROR",
        };
      }
    },
  };

  return {
    adapter,
    request: BASE_REQUEST,
    readIoCount: () => fake.calls.length,
    readFaultLog: () => (overrides?.forgeFaultLog ? [{ call: "quote", kind: outcome.kind }] : fake.calls),
  };
}

function makeFullSubject() {
  const sampleRates: readonly CarrierRateOption[] = [
    {
      carrierCode: "alpha",
      serviceCode: "EXPRESS",
      serviceName: "Alpha Express",
      deliveryKind: "courier",
      amountMinor: 1495,
      currency: "USD",
      estimatedTransitDays: { min: 1, max: 2 },
    },
    {
      carrierCode: "alpha",
      serviceCode: "GROUND",
      serviceName: "Alpha Ground",
      deliveryKind: "courier",
      amountMinor: 695,
      currency: "USD",
      estimatedTransitDays: { min: 3, max: 5 },
    },
  ];
  return {
    id: "synthetic-carrier",
    sensitiveValues: [CANARY_VALUE],
    happyQuote: () => createSyntheticCarrierHarness({ kind: "success", value: sampleRates }),
    noRatesQuote: () => createSyntheticCarrierHarness({ kind: "success", value: [] }),
    certification: {
      http5xx: () => createSyntheticCarrierHarness({ kind: "http-failure", status: 503 }),
      httpAuthFailure: () => createSyntheticCarrierHarness({ kind: "http-failure", status: 401 }),
      rateLimited429: () => createSyntheticCarrierHarness({ kind: "rate-limited-429", retryAfterSeconds: 30 }),
      timeout: () => createSyntheticCarrierHarness({ kind: "timeout" }),
      transportError: () => createSyntheticCarrierHarness({ kind: "transport-error" }),
    },
  };
}

describe("CarrierRateQuotePort and @openlup/platform/shipping/testing", () => {
  it("certifies a conforming carrier adapter in full mode with deterministic qualification ledger", async () => {
    const evidence = await runShippingRateAdapterConformance([makeFullSubject()], { mode: "full" });
    expect(evidence.contractVersion).toBe(CARRIER_RATE_QUOTE_CONTRACT_VERSION);
    expect(evidence.mode).toBe("full");
    expect(evidence.qualifications).toHaveLength(1);
    const qual = evidence.qualifications[0]!;
    expect(qual.providerKind).toBe("synthetic_carrier");
    expect(qual.capabilityDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(qual.ledger.filter((e) => e.role === "zero-io-refusal").every((e) => e.ioDelta === 0)).toBe(true);
    expect(qual.ledger.filter((e) => e.role === "transport-fault")).toHaveLength(5);
    expect(qual.ledger.filter((e) => e.role === "transport-fault").every((e) => e.faultLogDelta === 1)).toBe(true);
  });

  it("sorts rates deterministically and selects the cheapest rate", () => {
    const rates: CarrierRateOption[] = [
      { carrierCode: "b", serviceCode: "STD", serviceName: "B Std", deliveryKind: "courier", amountMinor: 800, currency: "USD" },
      { carrierCode: "a", serviceCode: "STD", serviceName: "A Std", deliveryKind: "courier", amountMinor: 800, currency: "USD" },
      { carrierCode: "c", serviceCode: "ECO", serviceName: "C Eco", deliveryKind: "courier", amountMinor: 500, currency: "USD" },
    ];
    expect(sortCarrierRateOptions(rates).map((r) => `${r.carrierCode}:${r.serviceCode}`)).toEqual([
      "c:ECO",
      "a:STD",
      "b:STD",
    ]);
    expect(selectCheapestCarrierRate(rates)?.carrierCode).toBe("c");
    expect(selectCheapestCarrierRate([])).toBeNull();

    const projected = projectCarrierRateStaticCapabilities(BASE_CAPABILITIES, {
      redactSupportedCurrencies: true,
    });
    expect(projected.supportedCurrencies).toEqual([]);
    expect(projected.supportedDestinationCountries).toEqual(["CA", "US"]);
  });

  it("rejects Proxy adapters (negative control)", async () => {
    const base = makeFullSubject();
    const proxied = {
      ...base,
      happyQuote: () => {
        const h = base.happyQuote();
        return { ...h, adapter: new Proxy(h.adapter, {}) };
      },
    };
    await expect(runShippingRateAdapterConformance([proxied])).rejects.toThrow(
      /SHIPPING_RATE_CONFORMANCE:proxy_rejected/,
    );
  });

  it("rejects forged fault-log handles in full mode (negative control)", async () => {
    const base = makeFullSubject();
    const forged = {
      ...base,
      certification: {
        ...base.certification,
        http5xx: () =>
          createSyntheticCarrierHarness({ kind: "http-failure", status: 503 }, { forgeFaultLog: true }),
      },
    };
    await expect(runShippingRateAdapterConformance([forged], { mode: "full" })).rejects.toThrow(
      /SHIPPING_RATE_CONFORMANCE:invalid_fault_log/,
    );
  });

  it("fails when zero-I/O refusal dispatches provider I/O (negative control)", async () => {
    const base = makeFullSubject();
    const leaky = {
      ...base,
      happyQuote: () => {
        const fake = createScriptedShippingRateFake<SyntheticCalls>();
        const okRate: readonly CarrierRateOption[] = [
          { carrierCode: "a", serviceCode: "G", serviceName: "G", deliveryKind: "courier", amountMinor: 500, currency: "USD" },
        ];
        fake.enqueue("quote", { kind: "success", value: okRate }, { kind: "success", value: okRate });
        const adapter: CarrierRateQuotePort = {
          capabilities: BASE_CAPABILITIES,
          async quoteRates(request): Promise<CarrierRateQuoteResult> {
            const rates = await fake.invoke("quote");
            return { kind: "quoted", providerKind: BASE_CAPABILITIES.providerKind, currency: request.currency, rates };
          },
        };
        return { adapter, request: BASE_REQUEST, readIoCount: () => fake.calls.length, readFaultLog: () => fake.calls };
      },
    };
    await expect(runShippingRateAdapterConformance([leaky])).rejects.toThrow(
      /SHIPPING_RATE_CONFORMANCE:zero_io_violation/,
    );
  });

  it("fails when a rate currency mismatches the request currency (negative control)", async () => {
    const base = makeFullSubject();
    const badCurrency = {
      ...base,
      happyQuote: () =>
        createSyntheticCarrierHarness({
          kind: "success",
          value: [
            {
              carrierCode: "alpha",
              serviceCode: "GROUND",
              serviceName: "Ground",
              deliveryKind: "courier",
              amountMinor: 500,
              currency: "EUR",
            },
          ],
        }),
    };
    await expect(runShippingRateAdapterConformance([badCurrency])).rejects.toThrow(
      /SHIPPING_RATE_CONFORMANCE:rate_currency_mismatch/,
    );
  });

  it("fails when a sensitive canary leaks into adapter output (negative control)", async () => {
    const base = makeFullSubject();
    const leakySecret = {
      ...base,
      happyQuote: () =>
        createSyntheticCarrierHarness(
          {
            kind: "success",
            value: [
              {
                carrierCode: "alpha",
                serviceCode: "GROUND",
                serviceName: `Ground ${CANARY_VALUE}`,
                deliveryKind: "courier",
                amountMinor: 500,
                currency: "USD",
              },
            ],
          },
        ),
    };
    await expect(runShippingRateAdapterConformance([leakySecret])).rejects.toThrow(
      /SHIPPING_RATE_CONFORMANCE:secret_leak/,
    );
  });
});
