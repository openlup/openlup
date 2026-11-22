import { createHash } from "node:crypto";
import { types } from "node:util";
import {
  CARRIER_RATE_QUOTE_CONTRACT_VERSION,
  carrierRateCapabilitiesSchema,
  carrierRateQuoteResultSchema,
  projectCarrierRateStaticCapabilities,
} from "../carrierRate.js";
import type {
  CarrierRateQuotePort,
  CarrierRateQuoteRequest,
  CarrierRateQuoteResult,
  CarrierRateRefusalReason,
} from "../contracts/carrierRate.js";
import { readScriptedShippingRateFaultLog } from "./scriptedFake.js";

export type ShippingRateTransportFaultScenario =
  | "http-5xx"
  | "http-auth-failure"
  | "rate-limited-429"
  | "timeout"
  | "transport-error";

export interface ShippingRateScenarioHarness {
  readonly adapter: CarrierRateQuotePort;
  readonly request: CarrierRateQuoteRequest;
  readIoCount(): number;
  readFaultLog?(): object;
}

export interface ShippingRateFullCertificationScenarios {
  readonly http5xx: () => ShippingRateScenarioHarness;
  readonly httpAuthFailure: () => ShippingRateScenarioHarness;
  readonly rateLimited429: () => ShippingRateScenarioHarness;
  readonly timeout: () => ShippingRateScenarioHarness;
  readonly transportError: () => ShippingRateScenarioHarness;
}

export interface ShippingRateAdapterTestSubject {
  readonly id: string;
  readonly happyQuote: () => ShippingRateScenarioHarness;
  readonly noRatesQuote: () => ShippingRateScenarioHarness;
  readonly unsupportedCountryRequest?: () => CarrierRateQuoteRequest;
  readonly unsupportedCurrencyRequest?: () => CarrierRateQuoteRequest;
  readonly sensitiveValues?: readonly string[];
  readonly certification?: ShippingRateFullCertificationScenarios;
}

export interface ShippingRateConformanceOptions {
  readonly mode?: "baseline" | "full";
}

export interface ShippingRateLedgerEntry {
  readonly scenario: string;
  readonly role: "happy" | "zero-io-refusal" | "transport-fault";
  readonly ioDelta: number;
  readonly faultLogDelta: number | null;
}

export interface ShippingRateQualification {
  readonly subjectId: string;
  readonly providerKind: string;
  readonly mode: "baseline" | "full";
  readonly capabilityDigest: string;
  readonly ledger: readonly ShippingRateLedgerEntry[];
}

export interface ShippingRateConformanceEvidence {
  readonly contractVersion: typeof CARRIER_RATE_QUOTE_CONTRACT_VERSION;
  readonly mode: "baseline" | "full";
  readonly qualifications: readonly ShippingRateQualification[];
}

function fail(code: string, message: string, location: string): never {
  throw new Error(
    `SHIPPING_RATE_CONFORMANCE:${code}. ${message} Recheck with runShippingRateAdapterConformance. Location: ${location}`,
  );
}

function rejectProxy(value: unknown, location: string): void {
  if (typeof value === "object" && value !== null && types.isProxy(value)) {
    fail("proxy_rejected", "Proxy subjects or adapters are forbidden in conformance certification.", location);
  }
}

function assertNoSensitiveLeak(
  payload: unknown,
  sensitiveValues: readonly string[] | undefined,
  location: string,
): void {
  if (!sensitiveValues || sensitiveValues.length === 0) return;
  const serialized = typeof payload === "string" ? payload : JSON.stringify(payload);
  for (const secret of sensitiveValues) {
    if (secret.length < 4) continue;
    const encoded = encodeURIComponent(secret);
    if (serialized.includes(secret) || serialized.includes(encoded)) {
      fail(
        "secret_leak",
        "A sensitive canary value appeared in adapter output or error diagnostics. Redact credentials and PII before returning.",
        location,
      );
    }
  }
}

function computeCapabilityDigest(adapter: CarrierRateQuotePort): string {
  const staticProjection = projectCarrierRateStaticCapabilities(adapter.capabilities);
  return createHash("sha256").update(JSON.stringify(staticProjection)).digest("hex");
}

function validateResult(
  result: unknown,
  expectedProviderKind: string,
  requestCurrency: string,
  location: string,
): CarrierRateQuoteResult {
  const parsed = carrierRateQuoteResultSchema.safeParse(result);
  if (!parsed.success) {
    fail(
      "invalid_result_shape",
      `Result failed strict CarrierRateQuoteResult schema validation (${parsed.error.issues[0]?.path.join(".") || "$"}: ${parsed.error.issues[0]?.message ?? "invalid"}).`,
      location,
    );
  }
  if (parsed.data.providerKind !== expectedProviderKind) {
    fail(
      "provider_kind_mismatch",
      `Expected providerKind "${expectedProviderKind}", received "${parsed.data.providerKind}".`,
      location,
    );
  }
  if (parsed.data.kind === "quoted") {
    if (parsed.data.currency !== requestCurrency) {
      fail(
        "currency_mismatch",
        `Quoted currency "${parsed.data.currency}" does not match requested currency "${requestCurrency}".`,
        location,
      );
    }
    for (const rate of parsed.data.rates) {
      if (rate.currency !== requestCurrency) {
        fail(
          "rate_currency_mismatch",
          `Rate option "${rate.serviceCode}" currency "${rate.currency}" does not match requested currency "${requestCurrency}".`,
          location,
        );
      }
    }
  }
  return parsed.data;
}

async function invokeChecked(
  harness: ShippingRateScenarioHarness,
  request: CarrierRateQuoteRequest,
  sensitiveValues: readonly string[] | undefined,
  location: string,
): Promise<{ result: CarrierRateQuoteResult; ioDelta: number; faultLogDelta: number | null }> {
  rejectProxy(harness, location);
  rejectProxy(harness.adapter, location);
  const ioBefore = harness.readIoCount();
  const faultBefore = harness.readFaultLog ? readScriptedShippingRateFaultLog(harness.readFaultLog()).length : null;
  let rawResult: CarrierRateQuoteResult;
  try {
    rawResult = await harness.adapter.quoteRates(request);
  } catch (error) {
    assertNoSensitiveLeak(error instanceof Error ? `${error.name}: ${error.message}` : String(error), sensitiveValues, location);
    fail("uncaught_throw", "quoteRates() threw an uncaught exception instead of returning a structured CarrierRateQuoteResult.", location);
  }
  assertNoSensitiveLeak(rawResult, sensitiveValues, location);
  const result = validateResult(rawResult, harness.adapter.capabilities.providerKind, request.currency, location);
  const ioDelta = harness.readIoCount() - ioBefore;
  const faultLogDelta =
    harness.readFaultLog && faultBefore !== null
      ? readScriptedShippingRateFaultLog(harness.readFaultLog()).length - faultBefore
      : null;
  return { result, ioDelta, faultLogDelta };
}

function assertZeroIoRefusal(
  scenario: string,
  outcome: { result: CarrierRateQuoteResult; ioDelta: number; faultLogDelta: number | null },
  allowedReasons: readonly CarrierRateRefusalReason[],
  location: string,
  ledger: ShippingRateLedgerEntry[],
): void {
  if (outcome.ioDelta !== 0) {
    fail("zero_io_violation", `Expected 0 provider I/O calls on refusal scenario "${scenario}", observed ${outcome.ioDelta}.`, location);
  }
  if (outcome.result.kind !== "refused") {
    fail("expected_refusal", `Expected kind "refused" on "${scenario}", observed "${outcome.result.kind}".`, location);
  }
  if (outcome.result.retryable) {
    fail("refusal_must_not_retry", `Zero-I/O refusal "${scenario}" must set retryable: false.`, location);
  }
  if (!allowedReasons.includes(outcome.result.reason)) {
    fail(
      "unexpected_refusal_reason",
      `Expected reason in [${allowedReasons.join(", ")}] on "${scenario}", observed "${outcome.result.reason}".`,
      location,
    );
  }
  ledger.push({ scenario, role: "zero-io-refusal", ioDelta: outcome.ioDelta, faultLogDelta: outcome.faultLogDelta });
}

export async function runShippingRateAdapterConformance(
  subjects: readonly ShippingRateAdapterTestSubject[],
  options?: ShippingRateConformanceOptions,
): Promise<ShippingRateConformanceEvidence> {
  rejectProxy(subjects, "subjects");
  if (!Array.isArray(subjects) || subjects.length === 0) {
    fail("empty_subjects", "Provide at least one ShippingRateAdapterTestSubject.", "subjects");
  }
  const mode = options?.mode ?? "baseline";
  const qualifications: ShippingRateQualification[] = [];

  for (const subject of subjects) {
    rejectProxy(subject, `subject:${subject?.id ?? "unknown"}`);
    const ledger: ShippingRateLedgerEntry[] = [];
    const loc = (scenario: string) => `${subject.id}:${scenario}`;

    // 1. Validate capabilities & happy path
    const happyHarness = subject.happyQuote();
    rejectProxy(happyHarness, loc("happyQuote"));
    rejectProxy(happyHarness.adapter, loc("happyQuote"));
    const capsParsed = carrierRateCapabilitiesSchema.safeParse(happyHarness.adapter.capabilities);
    if (!capsParsed.success) {
      fail(
        "invalid_capabilities",
        `capabilities failed schema validation (${capsParsed.error.issues[0]?.path.join(".") || "$"}: ${capsParsed.error.issues[0]?.message ?? "invalid"}).`,
        loc("capabilities"),
      );
    }
    const caps = capsParsed.data;
    const capabilityDigest = computeCapabilityDigest(happyHarness.adapter);

    const happy = await invokeChecked(happyHarness, happyHarness.request, subject.sensitiveValues, loc("happyQuote"));
    if (happy.result.kind !== "quoted") {
      fail("happy_not_quoted", `Expected kind "quoted" on happyQuote, observed "${happy.result.kind}".`, loc("happyQuote"));
    }
    if (happy.ioDelta !== 1) {
      fail("happy_io_delta", `Expected exactly 1 provider I/O call on happyQuote, observed ${happy.ioDelta}.`, loc("happyQuote"));
    }
    ledger.push({ scenario: "happyQuote", role: "happy", ioDelta: happy.ioDelta, faultLogDelta: happy.faultLogDelta });

    // 2. No-rates witness
    const noRatesHarness = subject.noRatesQuote();
    const noRates = await invokeChecked(noRatesHarness, noRatesHarness.request, subject.sensitiveValues, loc("noRatesQuote"));
    if (noRates.result.kind !== "no_rates") {
      fail("no_rates_mismatch", `Expected kind "no_rates" on noRatesQuote, observed "${noRates.result.kind}".`, loc("noRatesQuote"));
    }
    if (noRates.ioDelta !== 1) {
      fail("no_rates_io_delta", `Expected exactly 1 provider I/O call on noRatesQuote, observed ${noRates.ioDelta}.`, loc("noRatesQuote"));
    }
    ledger.push({ scenario: "noRatesQuote", role: "happy", ioDelta: noRates.ioDelta, faultLogDelta: noRates.faultLogDelta });

    // 3. Zero-I/O refusals
    const zeroWeightReq: CarrierRateQuoteRequest = {
      ...happyHarness.request,
      parcels: [{ ...(happyHarness.request.parcels[0] ?? { weightGrams: 100 }), weightGrams: 0 }],
    };
    assertZeroIoRefusal(
      "zero_weight_parcel",
      await invokeChecked(happyHarness, zeroWeightReq, subject.sensitiveValues, loc("zero_weight_parcel")),
      ["invalid_parcel"],
      loc("zero_weight_parcel"),
      ledger,
    );

    const emptyParcelsReq: CarrierRateQuoteRequest = { ...happyHarness.request, parcels: [] };
    assertZeroIoRefusal(
      "empty_parcels",
      await invokeChecked(happyHarness, emptyParcelsReq, subject.sensitiveValues, loc("empty_parcels")),
      ["invalid_parcel"],
      loc("empty_parcels"),
      ledger,
    );

    if (!caps.multiParcel && happyHarness.request.parcels.length > 0) {
      const firstParcel = happyHarness.request.parcels[0]!;
      const multiParcelReq: CarrierRateQuoteRequest = {
        ...happyHarness.request,
        parcels: [firstParcel, firstParcel],
      };
      assertZeroIoRefusal(
        "multi_parcel_unsupported",
        await invokeChecked(happyHarness, multiParcelReq, subject.sensitiveValues, loc("multi_parcel_unsupported")),
        ["multi_parcel_unsupported"],
        loc("multi_parcel_unsupported"),
        ledger,
      );
    }

    if (caps.dimensionsRequired && happyHarness.request.parcels.length > 0) {
      const firstParcel = happyHarness.request.parcels[0]!;
      const missingDimsReq: CarrierRateQuoteRequest = {
        ...happyHarness.request,
        parcels: [{ weightGrams: firstParcel.weightGrams }],
      };
      assertZeroIoRefusal(
        "dimensions_required",
        await invokeChecked(happyHarness, missingDimsReq, subject.sensitiveValues, loc("dimensions_required")),
        ["invalid_parcel"],
        loc("dimensions_required"),
        ledger,
      );
    }

    if (caps.supportedDestinationCountries !== "any") {
      const req =
        subject.unsupportedCountryRequest?.() ?? {
          ...happyHarness.request,
          destination: { ...happyHarness.request.destination, countryCode: "AQ" },
        };
      assertZeroIoRefusal(
        "unsupported_country",
        await invokeChecked(happyHarness, req, subject.sensitiveValues, loc("unsupported_country")),
        ["unsupported_country"],
        loc("unsupported_country"),
        ledger,
      );
    }

    if (caps.supportedCurrencies.length > 0) {
      const req =
        subject.unsupportedCurrencyRequest?.() ?? {
          ...happyHarness.request,
          currency: caps.supportedCurrencies.includes("JPY") ? "CHF" : "JPY",
        };
      assertZeroIoRefusal(
        "unsupported_currency",
        await invokeChecked(happyHarness, req, subject.sensitiveValues, loc("unsupported_currency")),
        ["unsupported_currency"],
        loc("unsupported_currency"),
        ledger,
      );
    }

    // 4. Full-mode authenticated transport fault certification
    if (mode === "full") {
      if (!subject.certification) {
        fail(
          "missing_certification_scenarios",
          "mode: 'full' requires subject.certification transport fault harnesses backed by createScriptedShippingRateFake.",
          loc("certification"),
        );
      }
      const faultCases: readonly {
        readonly name: ShippingRateTransportFaultScenario;
        readonly factory: () => ShippingRateScenarioHarness;
        readonly reasons: readonly CarrierRateRefusalReason[];
        readonly retryable: boolean;
      }[] = [
        { name: "http-5xx", factory: subject.certification.http5xx, reasons: ["provider_unavailable"], retryable: true },
        { name: "http-auth-failure", factory: subject.certification.httpAuthFailure, reasons: ["authentication_failed"], retryable: false },
        { name: "rate-limited-429", factory: subject.certification.rateLimited429, reasons: ["rate_limited"], retryable: true },
        { name: "timeout", factory: subject.certification.timeout, reasons: ["timeout"], retryable: true },
        { name: "transport-error", factory: subject.certification.transportError, reasons: ["provider_unavailable", "timeout"], retryable: true },
      ];

      for (const tc of faultCases) {
        const harness = tc.factory();
        if (!harness.readFaultLog) {
          fail(
            "missing_fault_log_handle",
            `mode: 'full' requires harness.readFaultLog() returning fake.calls from createScriptedShippingRateFake.`,
            loc(tc.name),
          );
        }
        const outcome = await invokeChecked(harness, harness.request, subject.sensitiveValues, loc(tc.name));
        if (outcome.ioDelta !== 1 || outcome.faultLogDelta !== 1) {
          fail(
            "fault_io_mismatch",
            `Expected ioDelta === 1 and authenticated faultLogDelta === 1 on "${tc.name}", observed ioDelta=${outcome.ioDelta}, faultLogDelta=${String(outcome.faultLogDelta)}.`,
            loc(tc.name),
          );
        }
        if (outcome.result.kind !== "refused") {
          fail("fault_not_refused", `Expected kind "refused" on "${tc.name}", observed "${outcome.result.kind}".`, loc(tc.name));
        }
        if (outcome.result.retryable !== tc.retryable) {
          fail("fault_retryable_mismatch", `Expected retryable=${String(tc.retryable)} on "${tc.name}", observed ${String(outcome.result.retryable)}.`, loc(tc.name));
        }
        if (!tc.reasons.includes(outcome.result.reason)) {
          fail(
            "fault_reason_mismatch",
            `Expected reason in [${tc.reasons.join(", ")}] on "${tc.name}", observed "${outcome.result.reason}".`,
            loc(tc.name),
          );
        }
        ledger.push({ scenario: tc.name, role: "transport-fault", ioDelta: outcome.ioDelta, faultLogDelta: outcome.faultLogDelta });
      }
    }

    qualifications.push({
      subjectId: subject.id,
      providerKind: caps.providerKind,
      mode,
      capabilityDigest,
      ledger,
    });
  }

  return {
    contractVersion: CARRIER_RATE_QUOTE_CONTRACT_VERSION,
    mode,
    qualifications,
  };
}
