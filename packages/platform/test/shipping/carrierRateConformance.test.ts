import { describe, expect, it } from "vitest";
import {
  CARRIER_RATE_QUOTE_CONTRACT_VERSION,
  carrierRateQuoteResultSchema,
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

const CANARY_VALUE = "sensitive-canary/marker+one";

function createSyntheticCarrierHarness(
  outcome: ScriptedShippingRateOutcome<readonly CarrierRateOption[]>,
  overrides?: {
    readonly mutateResult?: (res: CarrierRateQuoteResult) => CarrierRateQuoteResult;
    readonly capabilities?: CarrierRateCapabilities;
    readonly dropRetryAfter?: boolean;
    readonly forgeFaultLog?: boolean;
    readonly swapFaultLogHandles?: boolean;
    readonly throwObject?: unknown;
    readonly returnRaw?: unknown;
  },
): ShippingRateScenarioHarness {
  const fake = createScriptedShippingRateFake<SyntheticCalls>();
  fake.enqueue("quote", outcome);
  const caps = overrides?.capabilities ?? BASE_CAPABILITIES;

  const swapFakeB = createScriptedShippingRateFake<SyntheticCalls>();
  swapFakeB.enqueue("quote", { kind: "http-failure", status: 503 });
  let faultLogReads = 0;

  const adapter: CarrierRateQuotePort = {
    capabilities: caps,
    async quoteRates(request): Promise<CarrierRateQuoteResult> {
      const refusal = validateCarrierRateRequestAgainstCapabilities(request, caps);
      if (refusal) return refusal;
      if (overrides?.throwObject !== undefined) {
        throw overrides.throwObject;
      }
      if (overrides?.returnRaw !== undefined) {
        return overrides.returnRaw as CarrierRateQuoteResult;
      }
      if (overrides?.swapFaultLogHandles) {
        // Pre-invoke swapFakeB only if not yet invoked; adapter itself never invokes `fake`.
        try {
          await swapFakeB.invoke("quote");
        } catch {
          // intentional
        }
        return {
          kind: "refused",
          providerKind: caps.providerKind,
          reason: "provider_unavailable",
          retryable: true,
          diagnosticCode: "CARRIER_UNAVAILABLE",
        };
      }
      try {
        const rates = await fake.invoke("quote");
        const result: CarrierRateQuoteResult =
          rates.length === 0
            ? { kind: "no_rates", providerKind: caps.providerKind, diagnosticCode: "NO_ELIGIBLE_RATES" }
            : {
                kind: "quoted",
                providerKind: caps.providerKind,
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
              providerKind: caps.providerKind,
              reason: "timeout",
              retryable: true,
              diagnosticCode: "CARRIER_TIMEOUT",
            };
          }
          if (error.kind === "rate-limited-429") {
            return {
              kind: "refused",
              providerKind: caps.providerKind,
              reason: "rate_limited",
              retryable: true,
              diagnosticCode: "CARRIER_RATE_LIMITED",
              ...(!overrides?.dropRetryAfter && error.retryAfterSeconds !== undefined
                ? { retryAfterSeconds: error.retryAfterSeconds }
                : {}),
            };
          }
          if (error.kind === "http-failure" && (error.status === 401 || error.status === 403)) {
            return {
              kind: "refused",
              providerKind: caps.providerKind,
              reason: "authentication_failed",
              retryable: false,
              diagnosticCode: "CARRIER_AUTH_FAILED",
            };
          }
          return {
            kind: "refused",
            providerKind: caps.providerKind,
            reason: "provider_unavailable",
            retryable: true,
            diagnosticCode: "CARRIER_UNAVAILABLE",
          };
        }
        return {
          kind: "refused",
          providerKind: caps.providerKind,
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
    readIoCount: () => (overrides?.swapFaultLogHandles ? swapFakeB.calls.length : fake.calls.length),
    readFaultLog: () => {
      if (overrides?.forgeFaultLog) return [{ call: "quote", kind: outcome.kind }];
      if (overrides?.swapFaultLogHandles) {
        faultLogReads += 1;
        return faultLogReads === 1 ? fake.calls : swapFakeB.calls;
      }
      return fake.calls;
    },
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
    const refusals = qual.ledger.filter((e) => e.role === "zero-io-refusal");
    expect(refusals.some((e) => e.scenario === "unsupported_origin_country")).toBe(true);
    expect(refusals.every((e) => e.ioDelta === 0)).toBe(true);
    expect(qual.ledger.filter((e) => e.role === "transport-fault")).toHaveLength(5);
    expect(qual.ledger.filter((e) => e.role === "transport-fault").every((e) => e.faultLogDelta === 1)).toBe(true);
  });

  it("sorts rates deterministically, selects cheapest, and validates request edge cases", () => {
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

    // Boundary validation unit tests
    expect(
      validateCarrierRateRequestAgainstCapabilities(
        { ...BASE_REQUEST, origin: { countryCode: "us", postalCode: "94107" } },
        BASE_CAPABILITIES,
      )?.reason,
    ).toBe("invalid_address");
    expect(
      validateCarrierRateRequestAgainstCapabilities(
        { ...BASE_REQUEST, destination: { countryCode: "US", postalCode: "   " } },
        BASE_CAPABILITIES,
      )?.reason,
    ).toBe("invalid_address");
    expect(
      validateCarrierRateRequestAgainstCapabilities(
        { ...BASE_REQUEST, parcels: [{ weightGrams: Number.NaN, lengthMm: 100, widthMm: 100, heightMm: 100 }] },
        BASE_CAPABILITIES,
      )?.reason,
    ).toBe("invalid_parcel");
    expect(
      validateCarrierRateRequestAgainstCapabilities(
        { ...BASE_REQUEST, parcels: [{ weightGrams: 12.5, lengthMm: 100, widthMm: 100, heightMm: 100 }] },
        BASE_CAPABILITIES,
      )?.reason,
    ).toBe("invalid_parcel");
    expect(
      validateCarrierRateRequestAgainstCapabilities(
        { ...BASE_REQUEST, parcels: [{ weightGrams: 100, lengthMm: 100 }] },
        { ...BASE_CAPABILITIES, dimensionsRequired: false },
      )?.reason,
    ).toBe("invalid_parcel");
    expect(
      validateCarrierRateRequestAgainstCapabilities(
        { ...BASE_REQUEST, serviceFilter: ["  "] },
        BASE_CAPABILITIES,
      )?.reason,
    ).toBe("service_unsupported");
    expect(
      validateCarrierRateRequestAgainstCapabilities(
        { ...BASE_REQUEST, atTime: "not-a-timestamp" },
        BASE_CAPABILITIES,
      )?.reason,
    ).toBe("provider_error");
    expect(
      validateCarrierRateRequestAgainstCapabilities(
        null as unknown as CarrierRateQuoteRequest,
        BASE_CAPABILITIES,
      )?.reason,
    ).toBe("provider_error");

    // Non-retryable refusal with retryAfterSeconds is rejected by strict schema.
    expect(
      carrierRateQuoteResultSchema.safeParse({
        kind: "refused",
        providerKind: "synthetic_carrier",
        reason: "invalid_address",
        retryable: false,
        diagnosticCode: "BAD_ADDR",
        retryAfterSeconds: 10,
      }).success,
    ).toBe(false);
  });

  it("rejects Proxy adapters and forged/swapped fault-log handles (negative controls)", async () => {
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

    const swapped = {
      ...base,
      certification: {
        ...base.certification,
        http5xx: () =>
          createSyntheticCarrierHarness(
            { kind: "http-failure", status: 503 },
            { swapFaultLogHandles: true },
          ),
      },
    };
    await expect(runShippingRateAdapterConformance([swapped], { mode: "full" })).rejects.toThrow(
      /SHIPPING_RATE_CONFORMANCE:fault_io_mismatch/,
    );
  });

  it("rejects fault-kind spoofing, wrong HTTP status, and dropped retryAfterSeconds (negative controls)", async () => {
    const base = makeFullSubject();

    const spoofedSuccess = {
      ...base,
      certification: {
        ...base.certification,
        http5xx: () =>
          createSyntheticCarrierHarness(
            { kind: "success", value: [] },
            {
              mutateResult: () => ({
                kind: "refused",
                providerKind: BASE_CAPABILITIES.providerKind,
                reason: "provider_unavailable",
                retryable: true,
                diagnosticCode: "FAKE_5XX",
              }),
            },
          ),
      },
    };
    await expect(runShippingRateAdapterConformance([spoofedSuccess], { mode: "full" })).rejects.toThrow(
      /SHIPPING_RATE_CONFORMANCE:fault_kind_mismatch/,
    );

    const wrongStatus = {
      ...base,
      certification: {
        ...base.certification,
        http5xx: () => createSyntheticCarrierHarness({ kind: "http-failure", status: 404 }),
      },
    };
    await expect(runShippingRateAdapterConformance([wrongStatus], { mode: "full" })).rejects.toThrow(
      /SHIPPING_RATE_CONFORMANCE:fault_kind_mismatch/,
    );

    const droppedRetryAfter = {
      ...base,
      certification: {
        ...base.certification,
        rateLimited429: () =>
          createSyntheticCarrierHarness(
            { kind: "rate-limited-429", retryAfterSeconds: 45 },
            { dropRetryAfter: true },
          ),
      },
    };
    await expect(runShippingRateAdapterConformance([droppedRetryAfter], { mode: "full" })).rejects.toThrow(
      /SHIPPING_RATE_CONFORMANCE:retry_after_mismatch/,
    );
  });

  it("fails on zero-I/O violations, currency/deliveryKind mismatch, and cross-harness capability drift", async () => {
    const base = makeFullSubject();
    const leaky = {
      ...base,
      happyQuote: () => {
        const fake = createScriptedShippingRateFake<SyntheticCalls>();
        const okRate: readonly CarrierRateOption[] = [
          { carrierCode: "a", serviceCode: "G", serviceName: "G", deliveryKind: "courier", amountMinor: 500, currency: "USD" },
        ];
        fake.enqueue("quote", { kind: "success", value: okRate });
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

    const badCurrency = {
      ...base,
      happyQuote: () =>
        createSyntheticCarrierHarness({
          kind: "success",
          value: [
            { carrierCode: "alpha", serviceCode: "G", serviceName: "Ground", deliveryKind: "courier", amountMinor: 500, currency: "EUR" },
          ],
        }),
    };
    await expect(runShippingRateAdapterConformance([badCurrency])).rejects.toThrow(
      /SHIPPING_RATE_CONFORMANCE:rate_currency_mismatch/,
    );

    const undeclaredDelivery = {
      ...base,
      happyQuote: () =>
        createSyntheticCarrierHarness({
          kind: "success",
          value: [
            { carrierCode: "alpha", serviceCode: "L", serviceName: "Locker", deliveryKind: "parcel-locker", amountMinor: 500, currency: "USD" },
          ],
        }),
    };
    await expect(runShippingRateAdapterConformance([undeclaredDelivery])).rejects.toThrow(
      /SHIPPING_RATE_CONFORMANCE:undeclared_delivery_kind/,
    );

    const driftedHarness = {
      ...base,
      noRatesQuote: () =>
        createSyntheticCarrierHarness(
          { kind: "success", value: [] },
          { capabilities: { ...BASE_CAPABILITIES, multiParcel: true } },
        ),
    };
    await expect(runShippingRateAdapterConformance([driftedHarness])).rejects.toThrow(
      /SHIPPING_RATE_CONFORMANCE:capability_drift/,
    );
  });

  it("detects raw, URL-encoded, and thrown-cause canary leaks and handles undefined/circular returns safely", async () => {
    const base = makeFullSubject();

    const encodedLeak = {
      ...base,
      happyQuote: () =>
        createSyntheticCarrierHarness({
          kind: "success",
          value: [
            {
              carrierCode: "alpha",
              serviceCode: "GROUND",
              serviceName: `Ground ${encodeURIComponent(CANARY_VALUE).toLowerCase()}`,
              deliveryKind: "courier",
              amountMinor: 500,
              currency: "USD",
            },
          ],
        }),
    };
    await expect(runShippingRateAdapterConformance([encodedLeak])).rejects.toThrow(
      /SHIPPING_RATE_CONFORMANCE:secret_leak/,
    );

    const causeLeak = {
      ...base,
      happyQuote: () =>
        createSyntheticCarrierHarness(
          { kind: "success", value: [] },
          { throwObject: new Error("upstream failed", { cause: { token: CANARY_VALUE } }) },
        ),
    };
    await expect(runShippingRateAdapterConformance([causeLeak])).rejects.toThrow(
      /SHIPPING_RATE_CONFORMANCE:secret_leak/,
    );

    const plainThrownLeak = {
      ...base,
      happyQuote: () =>
        createSyntheticCarrierHarness(
          { kind: "success", value: [] },
          { throwObject: { nested: [CANARY_VALUE] } },
        ),
    };
    await expect(runShippingRateAdapterConformance([plainThrownLeak])).rejects.toThrow(
      /SHIPPING_RATE_CONFORMANCE:secret_leak/,
    );

    const circular: Record<string, unknown> = { kind: "quoted" };
    circular.self = circular;
    const circularReturn = {
      ...base,
      happyQuote: () =>
        createSyntheticCarrierHarness({ kind: "success", value: [] }, { returnRaw: circular }),
    };
    await expect(runShippingRateAdapterConformance([circularReturn])).rejects.toThrow(
      /SHIPPING_RATE_CONFORMANCE:invalid_result_shape/,
    );
  });
});
