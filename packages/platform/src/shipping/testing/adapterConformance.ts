import { createHash } from "node:crypto";
import { types } from "node:util";
import {
  CARRIER_RATE_QUOTE_CONTRACT_VERSION,
  carrierRateCapabilitiesSchema,
  carrierRateQuoteResultSchema,
  projectCarrierRateStaticCapabilities,
} from "../carrierRate.js";
import type {
  CarrierRateCapabilities,
  CarrierRateQuotePort,
  CarrierRateQuoteRequest,
  CarrierRateQuoteResult,
  CarrierRateRefusalReason,
} from "../contracts/carrierRate.js";
import {
  readScriptedShippingRateFaultLog,
  type RecordedShippingRateFault,
} from "./scriptedFake.js";

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
  readonly unsupportedOriginCountryRequest?: () => CarrierRateQuoteRequest;
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

const FALLBACK_UNSUPPORTED_CURRENCIES = ["XTS", "JPY", "CHF", "KWD", "BHD", "UYU", "ISK", "CLP"] as const;

function fail(code: string, message: string, location: string): never {
  throw new Error(
    `SHIPPING_RATE_CONFORMANCE:${code}. ${message} Recheck with runShippingRateAdapterConformance. Location: ${location}`,
  );
}

function rejectProxy(value: unknown, location: string): void {
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    if (types.isProxy(value)) {
      fail("proxy_rejected", "Proxy subjects, harnesses, adapters, or results are forbidden in conformance certification.", location);
    }
  }
}

function containsSensitiveValue(text: string, sensitiveValues: readonly string[]): boolean {
  const lower = text.toLowerCase();
  for (const secret of sensitiveValues) {
    if (secret.length < 4) continue;
    if (text.includes(secret)) return true;
    const encoded = encodeURIComponent(secret);
    if (text.includes(encoded) || lower.includes(encoded.toLowerCase())) return true;
  }
  return false;
}

function assertNoSensitiveLeak(
  payload: unknown,
  sensitiveValues: readonly string[] | undefined,
  location: string,
): void {
  if (!sensitiveValues || sensitiveValues.length === 0) return;
  const seen = new WeakSet<object>();

  const walk = (value: unknown): void => {
    if (value === null || value === undefined) return;
    if (typeof value === "string") {
      if (containsSensitiveValue(value, sensitiveValues)) {
        fail(
          "secret_leak",
          "A sensitive canary value appeared in adapter output or error diagnostics. Redact credentials and PII before returning.",
          location,
        );
      }
      return;
    }
    if (typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }

    if (value instanceof Error) {
      walk(value.name);
      walk(value.message);
      walk(value.stack);
      if ("cause" in value) walk((value as Error & { cause?: unknown }).cause);
    }

    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === "string") walk(key);
      let propValue: unknown;
      try {
        propValue = Reflect.get(value, key);
      } catch {
        continue;
      }
      walk(propValue);
    }
  };

  walk(payload);
}

function snapshotCapabilities(adapter: CarrierRateQuotePort, location: string): {
  readonly capabilities: CarrierRateCapabilities;
  readonly digest: string;
} {
  rejectProxy(adapter, location);
  rejectProxy(adapter.quoteRates, location);
  const rawCaps = adapter.capabilities;
  rejectProxy(rawCaps, location);
  const parsed = carrierRateCapabilitiesSchema.safeParse(rawCaps);
  if (!parsed.success) {
    fail(
      "invalid_capabilities",
      `capabilities failed schema validation (${parsed.error.issues[0]?.path.join(".") || "$"}: ${parsed.error.issues[0]?.message ?? "invalid"}).`,
      location,
    );
  }
  const projected = projectCarrierRateStaticCapabilities(parsed.data);
  const digest = createHash("sha256").update(JSON.stringify(projected)).digest("hex");
  return { capabilities: parsed.data, digest };
}

function readValidIoCount(harness: ShippingRateScenarioHarness, location: string): number {
  const count = harness.readIoCount();
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
    fail("invalid_io_count", "readIoCount() must return a non-negative safe integer.", location);
  }
  return count;
}

function validateResult(
  result: unknown,
  certifiedCaps: CarrierRateCapabilities,
  requestCurrency: string,
  location: string,
): CarrierRateQuoteResult {
  rejectProxy(result, location);
  const parsed = carrierRateQuoteResultSchema.safeParse(result);
  if (!parsed.success) {
    fail(
      "invalid_result_shape",
      `Result failed strict CarrierRateQuoteResult schema validation (${parsed.error.issues[0]?.path.join(".") || "$"}: ${parsed.error.issues[0]?.message ?? "invalid"}).`,
      location,
    );
  }
  if (parsed.data.providerKind !== certifiedCaps.providerKind) {
    fail(
      "provider_kind_mismatch",
      `Expected providerKind "${certifiedCaps.providerKind}", received "${parsed.data.providerKind}".`,
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
      if (!certifiedCaps.deliveryKinds.includes(rate.deliveryKind)) {
        fail(
          "undeclared_delivery_kind",
          `Rate option "${rate.serviceCode}" returned deliveryKind "${rate.deliveryKind}" which is not declared in capabilities.deliveryKinds.`,
          location,
        );
      }
    }
  }
  return parsed.data;
}

function cloneRequestWithKey(request: CarrierRateQuoteRequest, suffix: string): CarrierRateQuoteRequest {
  return {
    ...request,
    requestKey: `${request.requestKey}::${suffix}`,
    origin: { ...request.origin },
    destination: { ...request.destination },
    parcels: request.parcels.map((p) => ({ ...p })),
    ...(request.serviceFilter !== undefined ? { serviceFilter: [...request.serviceFilter] } : {}),
  };
}

interface CheckedInvocation {
  readonly result: CarrierRateQuoteResult;
  readonly ioDelta: number;
  readonly faultLogDelta: number | null;
  readonly addedFaults: readonly RecordedShippingRateFault[];
}

async function invokeChecked(
  harness: ShippingRateScenarioHarness,
  request: CarrierRateQuoteRequest,
  certifiedCaps: CarrierRateCapabilities,
  certifiedDigest: string,
  sensitiveValues: readonly string[] | undefined,
  location: string,
): Promise<CheckedInvocation> {
  rejectProxy(harness, location);
  rejectProxy(harness.request, location);
  rejectProxy(request, location);
  const { capabilities: harnessCaps, digest: harnessDigest } = snapshotCapabilities(harness.adapter, location);
  if (harnessCaps.providerKind !== certifiedCaps.providerKind || harnessDigest !== certifiedDigest) {
    fail(
      "capability_drift",
      "Every scenario harness for a subject must expose identical capabilities and providerKind.",
      location,
    );
  }

  const ioBefore = readValidIoCount(harness, location);
  // Pin one authenticated fault-log handle before invocation to prevent dual-handle forgery.
  const faultHandle = harness.readFaultLog ? harness.readFaultLog() : null;
  const faultBefore = faultHandle ? readScriptedShippingRateFaultLog(faultHandle).length : null;

  let rawResult: unknown;
  try {
    rawResult = await harness.adapter.quoteRates(request);
  } catch (error) {
    assertNoSensitiveLeak(error, sensitiveValues, location);
    fail("uncaught_throw", "quoteRates() threw an uncaught exception instead of returning a structured CarrierRateQuoteResult.", location);
  }
  assertNoSensitiveLeak(rawResult, sensitiveValues, location);
  const result = validateResult(rawResult, certifiedCaps, request.currency, location);

  const ioAfter = readValidIoCount(harness, location);
  const ioDelta = ioAfter - ioBefore;
  if (ioDelta < 0) {
    fail("negative_io_delta", "readIoCount() decreased during quoteRates() invocation.", location);
  }

  let faultLogDelta: number | null = null;
  let addedFaults: readonly RecordedShippingRateFault[] = [];
  if (faultHandle !== null && faultBefore !== null) {
    const afterLog = readScriptedShippingRateFaultLog(faultHandle);
    faultLogDelta = afterLog.length - faultBefore;
    addedFaults = afterLog.slice(faultBefore);
  }
  return { result, ioDelta, faultLogDelta, addedFaults };
}

function assertZeroIoRefusal(
  scenario: string,
  outcome: CheckedInvocation,
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
    if (typeof subject.id !== "string" || subject.id.trim().length === 0) {
      fail("invalid_subject_id", "Provide a non-empty opaque subject.id.", "subject");
    }
    assertNoSensitiveLeak(subject.id, subject.sensitiveValues, `subject:${subject.id}`);
    const ledger: ShippingRateLedgerEntry[] = [];
    const loc = (scenario: string) => `${subject.id}:${scenario}`;

    // 1. Validate capabilities & happy path
    const happyHarness = subject.happyQuote();
    rejectProxy(happyHarness, loc("happyQuote"));
    const { capabilities: caps, digest: capabilityDigest } = snapshotCapabilities(
      happyHarness.adapter,
      loc("capabilities"),
    );
    const baseRequest = cloneRequestWithKey(happyHarness.request, "base");

    const happy = await invokeChecked(
      happyHarness,
      happyHarness.request,
      caps,
      capabilityDigest,
      subject.sensitiveValues,
      loc("happyQuote"),
    );
    if (happy.result.kind !== "quoted") {
      fail("happy_not_quoted", `Expected kind "quoted" on happyQuote, observed "${happy.result.kind}".`, loc("happyQuote"));
    }
    if (happy.ioDelta !== 1) {
      fail("happy_io_delta", `Expected exactly 1 provider I/O call on happyQuote, observed ${happy.ioDelta}.`, loc("happyQuote"));
    }
    ledger.push({ scenario: "happyQuote", role: "happy", ioDelta: happy.ioDelta, faultLogDelta: happy.faultLogDelta });

    // 2. No-rates witness
    const noRatesHarness = subject.noRatesQuote();
    const noRates = await invokeChecked(
      noRatesHarness,
      noRatesHarness.request,
      caps,
      capabilityDigest,
      subject.sensitiveValues,
      loc("noRatesQuote"),
    );
    if (noRates.result.kind !== "no_rates") {
      fail("no_rates_mismatch", `Expected kind "no_rates" on noRatesQuote, observed "${noRates.result.kind}".`, loc("noRatesQuote"));
    }
    if (noRates.ioDelta !== 1) {
      fail("no_rates_io_delta", `Expected exactly 1 provider I/O call on noRatesQuote, observed ${noRates.ioDelta}.`, loc("noRatesQuote"));
    }
    ledger.push({ scenario: "noRatesQuote", role: "happy", ioDelta: noRates.ioDelta, faultLogDelta: noRates.faultLogDelta });

    // 3. Zero-I/O refusals (fresh harness & distinct requestKey per probe)
    const runProbe = async (
      scenario: string,
      request: CarrierRateQuoteRequest,
      allowedReasons: readonly CarrierRateRefusalReason[],
    ): Promise<void> => {
      const freshHarness = subject.happyQuote();
      const outcome = await invokeChecked(
        freshHarness,
        request,
        caps,
        capabilityDigest,
        subject.sensitiveValues,
        loc(scenario),
      );
      assertZeroIoRefusal(scenario, outcome, allowedReasons, loc(scenario), ledger);
    };

    await runProbe(
      "zero_weight_parcel",
      {
        ...cloneRequestWithKey(baseRequest, "zero-weight"),
        parcels: [{ ...(baseRequest.parcels[0] ?? { weightGrams: 100 }), weightGrams: 0 }],
      },
      ["invalid_parcel"],
    );

    await runProbe(
      "empty_parcels",
      { ...cloneRequestWithKey(baseRequest, "empty-parcels"), parcels: [] },
      ["invalid_parcel"],
    );

    if (!caps.multiParcel && baseRequest.parcels.length > 0) {
      const firstParcel = baseRequest.parcels[0]!;
      await runProbe(
        "multi_parcel_unsupported",
        { ...cloneRequestWithKey(baseRequest, "multi-parcel"), parcels: [{ ...firstParcel }, { ...firstParcel }] },
        ["multi_parcel_unsupported"],
      );
    }

    if (caps.dimensionsRequired && baseRequest.parcels.length > 0) {
      const firstParcel = baseRequest.parcels[0]!;
      await runProbe(
        "dimensions_required",
        { ...cloneRequestWithKey(baseRequest, "missing-dims"), parcels: [{ weightGrams: firstParcel.weightGrams }] },
        ["invalid_parcel"],
      );
    }

    if (caps.supportedOriginCountries !== "any") {
      const req =
        subject.unsupportedOriginCountryRequest?.() ?? {
          ...cloneRequestWithKey(baseRequest, "unsupported-origin"),
          origin: { ...baseRequest.origin, countryCode: caps.supportedOriginCountries.includes("AQ") ? "BV" : "AQ" },
        };
      await runProbe("unsupported_origin_country", req, ["unsupported_country"]);
    }

    if (caps.supportedDestinationCountries !== "any") {
      const req =
        subject.unsupportedCountryRequest?.() ?? {
          ...cloneRequestWithKey(baseRequest, "unsupported-dest"),
          destination: {
            ...baseRequest.destination,
            countryCode: caps.supportedDestinationCountries.includes("AQ") ? "BV" : "AQ",
          },
        };
      await runProbe("unsupported_country", req, ["unsupported_country"]);
    }

    if (caps.supportedCurrencies.length > 0) {
      let req = subject.unsupportedCurrencyRequest?.();
      if (!req) {
        const candidate = FALLBACK_UNSUPPORTED_CURRENCIES.find((c) => !caps.supportedCurrencies.includes(c));
        if (!candidate) {
          fail(
            "unsupported_currency_probe_required",
            "All fallback unsupported currencies are declared supported; supply subject.unsupportedCurrencyRequest().",
            loc("unsupported_currency"),
          );
        }
        req = { ...cloneRequestWithKey(baseRequest, "unsupported-currency"), currency: candidate };
      }
      await runProbe("unsupported_currency", req, ["unsupported_currency"]);
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
      rejectProxy(subject.certification, loc("certification"));

      const faultCases: readonly {
        readonly name: ShippingRateTransportFaultScenario;
        readonly factory: () => ShippingRateScenarioHarness;
        readonly reasons: readonly CarrierRateRefusalReason[];
        readonly retryable: boolean;
        readonly verifyFault: (fault: RecordedShippingRateFault, result: Extract<CarrierRateQuoteResult, { kind: "refused" }>) => void;
      }[] = [
        {
          name: "http-5xx",
          factory: subject.certification.http5xx,
          reasons: ["provider_unavailable"],
          retryable: true,
          verifyFault: (fault) => {
            if (fault.kind !== "http-failure" || fault.status === undefined || fault.status < 500 || fault.status > 599) {
              fail(
                "fault_kind_mismatch",
                `Scenario "http-5xx" must script an authenticated http-failure with status 500..599 (observed ${fault.kind}/${String(fault.status)}).`,
                loc("http-5xx"),
              );
            }
          },
        },
        {
          name: "http-auth-failure",
          factory: subject.certification.httpAuthFailure,
          reasons: ["authentication_failed"],
          retryable: false,
          verifyFault: (fault) => {
            if (fault.kind !== "http-failure" || (fault.status !== 401 && fault.status !== 403)) {
              fail(
                "fault_kind_mismatch",
                `Scenario "http-auth-failure" must script an authenticated http-failure with status 401 or 403 (observed ${fault.kind}/${String(fault.status)}).`,
                loc("http-auth-failure"),
              );
            }
          },
        },
        {
          name: "rate-limited-429",
          factory: subject.certification.rateLimited429,
          reasons: ["rate_limited"],
          retryable: true,
          verifyFault: (fault, result) => {
            if (fault.kind !== "rate-limited-429" || fault.retryAfterSeconds === undefined) {
              fail(
                "fault_kind_mismatch",
                `Scenario "rate-limited-429" must script an authenticated rate-limited-429 with positive retryAfterSeconds.`,
                loc("rate-limited-429"),
              );
            }
            if (result.retryAfterSeconds !== fault.retryAfterSeconds) {
              fail(
                "retry_after_mismatch",
                `Adapter must preserve retryAfterSeconds=${fault.retryAfterSeconds} on HTTP 429 (observed ${String(result.retryAfterSeconds)}).`,
                loc("rate-limited-429"),
              );
            }
          },
        },
        {
          name: "timeout",
          factory: subject.certification.timeout,
          reasons: ["timeout"],
          retryable: true,
          verifyFault: (fault) => {
            if (fault.kind !== "timeout") {
              fail(
                "fault_kind_mismatch",
                `Scenario "timeout" must script an authenticated timeout fault (observed ${fault.kind}).`,
                loc("timeout"),
              );
            }
          },
        },
        {
          name: "transport-error",
          factory: subject.certification.transportError,
          reasons: ["provider_unavailable", "timeout"],
          retryable: true,
          verifyFault: (fault) => {
            if (fault.kind !== "transport-error") {
              fail(
                "fault_kind_mismatch",
                `Scenario "transport-error" must script an authenticated transport-error fault (observed ${fault.kind}).`,
                loc("transport-error"),
              );
            }
          },
        },
      ];

      for (const tc of faultCases) {
        const harness = tc.factory();
        if (!harness.readFaultLog) {
          fail(
            "missing_fault_log_handle",
            "mode: 'full' requires harness.readFaultLog() returning fake.calls from createScriptedShippingRateFake.",
            loc(tc.name),
          );
        }
        const outcome = await invokeChecked(
          harness,
          harness.request,
          caps,
          capabilityDigest,
          subject.sensitiveValues,
          loc(tc.name),
        );
        if (outcome.ioDelta !== 1 || outcome.faultLogDelta !== 1 || outcome.addedFaults.length !== 1) {
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
        tc.verifyFault(outcome.addedFaults[0]!, outcome.result);
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
