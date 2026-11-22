import { createHash } from "node:crypto";
import { types } from "node:util";
import { guardEmailTransport } from "./emailEgress.js";
import type { EmailMessage, EmailSendResult, EmailTransport } from "./emailTransport.js";
import type { MarketingSyncProvider, SyncRequest, SyncResult } from "./contracts/marketingSync.js";
import {
  readScriptedCommunicationsFaultLog,
  type RecordedCommunicationsFault,
} from "./scriptedCommunicationsFake.js";

type Fixture<Input, Result> = {
  readonly input: Input;
  readonly expected: Result;
  /** Total external mutations performed by this one invocation. */
  readonly expectedEffects: number;
};

type OfflineAdapter<Adapter> = {
  readonly adapter: Adapter;
  readonly readEffectCount: () => number;
  readonly readFaultLog?: () => object;
};

export interface EmailFaultCertificationHarness {
  readonly input: EmailMessage;
  readonly adapter: EmailTransport;
  readonly readEffectCount: () => number;
  readonly readFaultLog: () => object;
}

export interface EmailFullCertificationScenarios {
  readonly http5xx: () => EmailFaultCertificationHarness | Promise<EmailFaultCertificationHarness>;
  readonly httpAuthFailure: () => EmailFaultCertificationHarness | Promise<EmailFaultCertificationHarness>;
  readonly rateLimited429: () => EmailFaultCertificationHarness | Promise<EmailFaultCertificationHarness>;
  readonly timeout: () => EmailFaultCertificationHarness | Promise<EmailFaultCertificationHarness>;
  readonly transportError: () => EmailFaultCertificationHarness | Promise<EmailFaultCertificationHarness>;
}

type EmailSubject = {
  readonly kind: "email";
  readonly subjectId: string;
  /** Fresh offline adapter and counter for each fixture; never use live credentials. */
  readonly create: (input: EmailMessage) => OfflineAdapter<EmailTransport> | Promise<OfflineAdapter<EmailTransport>>;
  readonly fixtures: readonly Fixture<EmailMessage, EmailSendResult>[];
  readonly sensitiveValues?: readonly string[];
  readonly certification?: EmailFullCertificationScenarios;
};

type SyncFixture = {
  [O in SyncRequest["operation"]]: Fixture<SyncRequest<O>, SyncResult<O>> & {
    /** Reinvoke this exact mutation and prove no second external effect. */
    readonly replay?: boolean;
  };
}[SyncRequest["operation"]];

type MarketingSubject = {
  readonly kind: "marketing-sync";
  readonly subjectId: string;
  readonly create: (input: SyncRequest) => OfflineAdapter<MarketingSyncProvider> | Promise<OfflineAdapter<MarketingSyncProvider>>;
  readonly fixtures: readonly SyncFixture[];
  readonly sensitiveValues?: readonly string[];
};

export type CommunicationsAdapterConformanceSubject = EmailSubject | MarketingSubject;

export interface CommunicationsConformanceOptions {
  readonly mode?: "baseline" | "full";
}

export interface CommunicationsQualificationLedgerEntry {
  readonly scenario: string;
  readonly role: "fixture" | "egress-admission" | "transport-fault";
  readonly ioDelta: number;
  readonly faultLogDelta: number | null;
}

export interface CommunicationsQualification {
  readonly subjectId: string;
  readonly kind: CommunicationsAdapterConformanceSubject["kind"];
  readonly mode: "baseline" | "full";
  readonly capabilityDigest: string;
  readonly ledger: readonly CommunicationsQualificationLedgerEntry[];
}

export interface CommunicationsAdapterConformanceEvidence {
  readonly subjects: readonly {
    readonly subjectId: string;
    readonly kind: CommunicationsAdapterConformanceSubject["kind"];
    readonly cases: readonly string[];
  }[];
  readonly qualifications?: readonly CommunicationsQualification[];
}

class ContractFailure extends Error {}

function requireFact(value: unknown, code: string, fix: string): asserts value {
  if (!value) {
    throw new ContractFailure(
      `COMMUNICATIONS_CONFORMANCE:${code}. ${fix}. Recheck with runCommunicationsAdapterConformance using the corrected offline fixture.`,
    );
  }
}

function rejectProxy(value: unknown, code = "proxy_rejected"): void {
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    requireFact(!types.isProxy(value), code, "Supply plain non-Proxy subjects, adapters, harnesses, and results");
  }
}

function containsSensitive(text: string, sensitiveValues: readonly string[]): boolean {
  const lower = text.toLowerCase();
  for (const secret of sensitiveValues) {
    if (secret.length < 4) continue;
    if (text.includes(secret)) return true;
    const encoded = encodeURIComponent(secret);
    if (text.includes(encoded) || lower.includes(encoded.toLowerCase())) return true;
  }
  return false;
}

function assertNoSensitiveLeak(payload: unknown, sensitiveValues: readonly string[] | undefined): void {
  if (!sensitiveValues || sensitiveValues.length === 0) return;
  const seen = new WeakSet<object>();

  const walk = (value: unknown): void => {
    if (value === null || value === undefined) return;
    if (typeof value === "string") {
      requireFact(
        !containsSensitive(value, sensitiveValues),
        "secret_leak",
        "Redact credentials, tokens, and sensitive canary values before returning or throwing",
      );
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

function same(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object" || Array.isArray(left) !== Array.isArray(right)) return false;
  const a = Object.keys(left), b = Object.keys(right);
  return a.length === b.length && a.every((key) => Object.hasOwn(right, key) && same((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

function count(read: () => number): number {
  const value = read();
  requireFact(Number.isSafeInteger(value) && value >= 0, "effect_counter", "Supply a nonnegative external mutation counter covering every injected transport");
  return value;
}

function effects(read: () => number, before: number, expected: number): number {
  const delta = count(read) - before;
  requireFact(
    Number.isSafeInteger(expected) && expected >= 0 && delta === expected,
    "effect_count",
    "Match the declared mutation count and refuse before external effects",
  );
  return delta;
}

async function dispatch(adapter: MarketingSyncProvider, request: SyncRequest): Promise<SyncResult> {
  switch (request.operation) {
    case "profile.sync": return adapter.profiles.sync(request);
    case "consent.read": return adapter.consent.read(request);
    case "erasure.request": return adapter.erasure.request(request);
    case "erasure.read": return adapter.erasure.read(request);
  }
}

function syncResult(input: SyncRequest, result: SyncResult): void {
  for (const key of ["binding", "operation", "subjectReference", "requestId", "generation"] as const) {
    requireFact(same(result[key], input[key]), "result_identity", "Echo the exact request binding, operation, subject, request ID and generation");
  }
  requireFact(["accepted", "acknowledged", "completed", "refused", "retryable", "unknown"].includes(result.kind),
    "result_kind", "Return a declared marketing-sync result kind");
  if (result.kind === "accepted" || result.kind === "acknowledged" || result.kind === "completed") {
    requireFact(result.journal === "confirmed" || result.journal === "unknown", "journal", "Retain journal uncertainty separately from provider acceptance");
    requireFact(input.operation !== "consent.read" || result.kind === "completed",
      "read_result", "Return completed consent readback or an explicit failure");
    requireFact(input.operation !== "profile.sync" && input.operation !== "erasure.request" || result.kind !== "completed",
      "acceptance_not_completion", "Return accepted or acknowledged for mutations; acknowledgement is not completed erasure");
    requireFact(input.operation === "consent.read" || "receipt" in result,
      "receipt_required", "Return the original admitted mutation receipt for mutation and erasure read results");
    if ("receipt" in result) {
      const original = input.operation === "erasure.read" ? input.payload.receipt.request : input;
      // Replay refreshes the call's fences, not the original admission receipt.
      const sameMutation = (["binding", "operation", "subjectReference", "requestId", "audience", "payload"] as const)
        .every((key) => same(result.receipt.request[key], original[key]));
      requireFact((input.operation === "erasure.read" ? same(result.receipt.request, original) : sameMutation)
        && result.receipt.operation === original.operation,
      "receipt_identity", "Retain the original admitted mutation in the receipt");
    }
  }
  if (result.kind === "retryable") {
    requireFact(Number.isFinite(result.afterSeconds) && result.afterSeconds > 0, "retry_delay", "Return a finite positive retry delay");
  }
  if (result.kind === "completed" && result.operation === "consent.read") {
    requireFact(same(result.value.audience, input.audience), "feedback_scope", "Retain the requested audience on consent readback");
    const outcomes = {
      unsubscribe: "deny_permission", complaint: "deny_permission", manual_block: "deny_permission",
      hard_bounce: "deny_delivery", invalid_address: "deny_delivery",
    };
    for (const feedback of result.value.feedback) {
      requireFact(Object.hasOwn(outcomes, feedback.kind) && outcomes[feedback.kind] === feedback.outcome,
        "negative_feedback", "Map feedback to deny_permission or deny_delivery; remote subscription never grants local permission");
    }
  }
  if (result.kind === "completed" && result.operation === "erasure.read") {
    requireFact(result.evidence.readRequestId === input.requestId && result.evidence.evidenceReference.trim().length > 0
      && ["provider_record_deleted", "provider_erasure_confirmed"].includes(result.evidence.assurance),
    "erasure_evidence", "Require authenticated read evidence for completed erasure; absence or acknowledgement alone cannot complete it");
  }
}

function validateEmailResultShape(result: EmailSendResult): void {
  rejectProxy(result);
  const outcome = result.outcome;
  requireFact(
    typeof outcome.ok === "boolean" &&
      typeof outcome.aborted === "boolean" &&
      (outcome.resendId === null || typeof outcome.resendId === "string") &&
      (outcome.providerError === null || typeof outcome.providerError === "string") &&
      Number.isInteger(outcome.httpStatus) &&
      outcome.httpStatus >= 0 &&
      outcome.httpStatus <= 599,
    "email_result",
    "Return the EmailSendResult outcome fields with their declared types",
  );
}

/** Offline fixture proof, following the payment/invoice/fulfillment runners.
 * No provider access, fixture discovery or test framework is supplied here.
 * Only subject labels and passed case labels leave the runner; raw results and
 * adapter exceptions are never included in findings.
 */
export async function runCommunicationsAdapterConformance(
  subjects: readonly CommunicationsAdapterConformanceSubject[],
  options?: CommunicationsConformanceOptions,
): Promise<CommunicationsAdapterConformanceEvidence> {
  const mode = options?.mode ?? "baseline";
  const evidence: CommunicationsAdapterConformanceEvidence["subjects"][number][] = [];
  const qualifications: CommunicationsQualification[] = [];
  let location = "subject selection";
  try {
    rejectProxy(subjects);
    requireFact(subjects.length > 0, "subject_required", "Supply at least one offline adapter subject");
    for (const [subjectIndex, subject] of subjects.entries()) {
      location = `subject ${subjectIndex + 1}`;
      rejectProxy(subject);
      requireFact(subject.subjectId.trim().length > 0, "subject_id", "Supply an opaque non-sensitive subject label");
      assertNoSensitiveLeak(subject.subjectId, subject.sensitiveValues);
      const cases: string[] = [];
      const ledger: CommunicationsQualificationLedgerEntry[] = [];
      let digestSource: unknown = { kind: subject.kind };

      if (subject.kind === "email") {
        requireFact(
          subject.fixtures.some((row) => row.expected.outcome.ok && !row.expected.outcome.suppressed) &&
            subject.fixtures.some((row) => !row.expected.outcome.ok && !row.expected.outcome.suppressed) &&
            subject.fixtures.some((row) => row.expected.outcome.suppressed === "drop"),
          "email_fixtures",
          "Supply accepted, failed and suppressed email fixtures",
        );
        let certifiedProviderKind: string | null = null;
        for (const [fixtureIndex, row] of subject.fixtures.entries()) {
          location = `subject ${subjectIndex + 1}, fixture ${fixtureIndex + 1}`;
          const created = await subject.create(row.input);
          rejectProxy(created);
          const { adapter, readEffectCount } = created;
          rejectProxy(adapter);
          rejectProxy(adapter.send);
          const before = count(readEffectCount);
          requireFact(adapter.providerKind.trim().length > 0, "provider_kind", "Declare the email transport provider kind");
          if (certifiedProviderKind === null) {
            certifiedProviderKind = adapter.providerKind;
            digestSource = { kind: "email", providerKind: certifiedProviderKind };
          } else {
            requireFact(
              adapter.providerKind === certifiedProviderKind,
              "provider_kind_drift",
              "Keep a consistent providerKind across all email fixtures for the same subject",
            );
          }
          if (mode === "full") {
            requireFact(
              guardEmailTransport(adapter) === adapter,
              "egress_unadmitted",
              "Wrap email transports with createGuardedEmailTransport so guardEmailTransport admits them",
            );
          }
          let result: EmailSendResult;
          try {
            result = await adapter.send(row.input);
          } catch (err) {
            assertNoSensitiveLeak(err, subject.sensitiveValues);
            throw err;
          }
          assertNoSensitiveLeak(result, subject.sensitiveValues);
          validateEmailResultShape(result);
          const outcome = result.outcome;
          requireFact(same(result, row.expected), "email_fixture", "Match the expected email outcome and provider response in the failing fixture");
          if (outcome.suppressed === "drop") effects(readEffectCount, before, 0);
          const ioDelta = effects(readEffectCount, before, row.expectedEffects);
          const caseLabel = outcome.suppressed === "drop" ? "email:suppressed" : outcome.ok ? "email:accepted" : "email:failed";
          cases.push(caseLabel);
          ledger.push({ scenario: `${caseLabel}#${fixtureIndex + 1}`, role: "fixture", ioDelta, faultLogDelta: null });
        }

        if (mode === "full") {
          ledger.push({ scenario: "egress-admission", role: "egress-admission", ioDelta: 0, faultLogDelta: null });
          requireFact(
            subject.certification !== undefined,
            "missing_certification_scenarios",
            "mode: 'full' for email subjects requires subject.certification backed by createScriptedCommunicationsFake",
          );
          rejectProxy(subject.certification);

          const faultCases: readonly {
            readonly name: string;
            readonly factory: () => EmailFaultCertificationHarness | Promise<EmailFaultCertificationHarness>;
            readonly verify: (fault: RecordedCommunicationsFault, result: EmailSendResult) => void;
          }[] = [
            {
              name: "http-5xx",
              factory: subject.certification.http5xx,
              verify: (fault, result) => {
                requireFact(
                  fault.kind === "http-failure" && fault.status !== undefined && fault.status >= 500 && fault.status <= 599,
                  "fault_kind_mismatch",
                  "Script an authenticated http-failure with status 500..599 for http-5xx",
                );
                requireFact(
                  !result.outcome.ok && result.outcome.httpStatus >= 500 && result.outcome.httpStatus <= 599 && !result.outcome.aborted,
                  "http_5xx_outcome",
                  "Return ok: false with HTTP 5xx status and aborted: false on provider 5xx",
                );
              },
            },
            {
              name: "http-auth-failure",
              factory: subject.certification.httpAuthFailure,
              verify: (fault, result) => {
                requireFact(
                  fault.kind === "http-failure" && (fault.status === 401 || fault.status === 403),
                  "fault_kind_mismatch",
                  "Script an authenticated http-failure with status 401 or 403 for http-auth-failure",
                );
                requireFact(
                  !result.outcome.ok && (result.outcome.httpStatus === 401 || result.outcome.httpStatus === 403) && !result.outcome.aborted,
                  "http_auth_outcome",
                  "Return ok: false with HTTP 401/403 status and aborted: false on authentication failure",
                );
              },
            },
            {
              name: "rate-limited-429",
              factory: subject.certification.rateLimited429,
              verify: (fault, result) => {
                requireFact(
                  fault.kind === "rate-limited-429",
                  "fault_kind_mismatch",
                  "Script an authenticated rate-limited-429 outcome for rate-limited-429",
                );
                requireFact(
                  !result.outcome.ok && result.outcome.httpStatus === 429 && !result.outcome.aborted,
                  "rate_limit_outcome",
                  "Return ok: false with httpStatus: 429 and aborted: false on rate limit",
                );
              },
            },
            {
              name: "timeout",
              factory: subject.certification.timeout,
              verify: (fault, result) => {
                requireFact(
                  fault.kind === "timeout",
                  "fault_kind_mismatch",
                  "Script an authenticated timeout outcome for timeout",
                );
                requireFact(
                  !result.outcome.ok && result.outcome.httpStatus === 0 && result.outcome.aborted === true,
                  "timeout_outcome",
                  "Return ok: false, httpStatus: 0, and aborted: true when a send aborts or times out",
                );
              },
            },
            {
              name: "transport-error",
              factory: subject.certification.transportError,
              verify: (fault, result) => {
                requireFact(
                  fault.kind === "transport-error",
                  "fault_kind_mismatch",
                  "Script an authenticated transport-error outcome for transport-error",
                );
                requireFact(
                  !result.outcome.ok && result.outcome.httpStatus === 0 && result.outcome.aborted === false,
                  "transport_error_outcome",
                  "Return ok: false, httpStatus: 0, and aborted: false on non-abort transport failures",
                );
              },
            },
          ];

          for (const tc of faultCases) {
            location = `subject ${subjectIndex + 1}, certification:${tc.name}`;
            const harness = await tc.factory();
            rejectProxy(harness);
            rejectProxy(harness.adapter);
            rejectProxy(harness.adapter.send);
            requireFact(
              harness.adapter.providerKind === certifiedProviderKind,
              "provider_kind_drift",
              "Keep a consistent providerKind across certification fault harnesses",
            );
            requireFact(
              guardEmailTransport(harness.adapter) === harness.adapter,
              "egress_unadmitted",
              "Wrap certification email transports with createGuardedEmailTransport",
            );
            const ioBefore = count(harness.readEffectCount);
            // Pin one authenticated handle before invocation to prevent handle-swap forgery.
            const faultHandle = harness.readFaultLog();
            const faultBefore = readScriptedCommunicationsFaultLog(faultHandle).length;
            let result: EmailSendResult;
            try {
              result = await harness.adapter.send(harness.input);
            } catch (err) {
              assertNoSensitiveLeak(err, subject.sensitiveValues);
              throw err;
            }
            assertNoSensitiveLeak(result, subject.sensitiveValues);
            validateEmailResultShape(result);
            const ioDelta = effects(harness.readEffectCount, ioBefore, 1);
            const afterFaults = readScriptedCommunicationsFaultLog(faultHandle);
            const added = afterFaults.slice(faultBefore);
            requireFact(
              added.length === 1,
              "fault_io_mismatch",
              "Execute exactly one authenticated scripted transport fault per certification scenario",
            );
            tc.verify(added[0]!, result);
            cases.push(`email:fault:${tc.name}`);
            ledger.push({ scenario: tc.name, role: "transport-fault", ioDelta, faultLogDelta: added.length });
          }
        }
      } else {
        const supported = new Set<SyncRequest["operation"]>();
        for (const operation of ["profile.sync", "consent.read", "erasure.request", "erasure.read"] as const) {
          requireFact(subject.fixtures.some((row) => row.input.operation === operation), "sync_fixtures", "Supply fixtures for all four marketing-sync operations, including unsupported ones");
        }
        requireFact(subject.fixtures.some((row) => row.expected.kind === "refused"), "refusal_fixture", "Supply a refused marketing-sync request with zero external effects");
        for (const [fixtureIndex, row] of subject.fixtures.entries()) {
          location = `subject ${subjectIndex + 1}, fixture ${fixtureIndex + 1}`;
          const created = await subject.create(row.input);
          rejectProxy(created);
          const { adapter, readEffectCount } = created;
          rejectProxy(adapter);
          const before = count(readEffectCount);
          const capability = adapter.capabilities.operations[row.input.operation];
          if (capability.state === "supported") supported.add(row.input.operation);
          digestSource = { kind: "marketing-sync", capabilities: adapter.capabilities };
          let result: SyncResult;
          try {
            result = await dispatch(adapter, row.input);
          } catch (err) {
            assertNoSensitiveLeak(err, subject.sensitiveValues);
            throw err;
          }
          assertNoSensitiveLeak(result, subject.sensitiveValues);
          syncResult(row.input, result);
          requireFact(
            (same(row.input.binding, adapter.capabilities.binding) && same(row.input.audience, adapter.capabilities.audience)) ||
              result.kind === "refused",
            "capability_scope",
            "Refuse requests outside the adapter's declared binding and audience before effects",
          );
          requireFact(
            capability.state === "supported" ||
              (result.kind === "refused" &&
                subject.fixtures.some(
                  (fixture) =>
                    fixture.input.operation === row.input.operation &&
                    fixture.expected.kind === "refused" &&
                    fixture.expected.reason === capability.state,
                )),
            "declared_capability",
            "Refuse unavailable operations and supply a refusal fixture with the declared unsupported or verification_pending reason",
          );
          requireFact(same(result, row.expected), "sync_fixture", "Match the expected marketing-sync result in the failing fixture");
          if (result.kind === "refused" || row.input.operation === "consent.read" || row.input.operation === "erasure.read") {
            effects(readEffectCount, before, 0);
          }
          const ioDelta = effects(readEffectCount, before, row.expectedEffects);
          if (row.replay) {
            requireFact(
              (row.input.operation === "profile.sync" || row.input.operation === "erasure.request") &&
                (result.kind === "accepted" || result.kind === "acknowledged"),
              "replay_fixture",
              "Replay an accepted or acknowledged mutation fixture",
            );
            const replayBefore = count(readEffectCount), replay = await dispatch(adapter, row.input);
            assertNoSensitiveLeak(replay, subject.sensitiveValues);
            requireFact(same(replay, result), "replay_result", "Return the original receipt and result for the same request");
            effects(readEffectCount, replayBefore, 0);
          }
          const caseLabel = `${row.input.operation}:${result.kind}${row.replay ? ":replay" : ""}`;
          cases.push(caseLabel);
          ledger.push({ scenario: caseLabel, role: "fixture", ioDelta, faultLogDelta: null });
        }
        for (const operation of supported) {
          if (operation === "profile.sync" || operation === "erasure.request") {
            requireFact(subject.fixtures.some((row) => row.input.operation === operation && row.replay),
              "replay_required", "Supply a successful replay fixture for each supported marketing mutation");
          } else {
            requireFact(subject.fixtures.some((row) => row.input.operation === operation && row.expected.kind === "completed"),
              "read_success_required", "Supply a completed read fixture for each supported marketing read operation");
          }
        }
      }

      evidence.push({ subjectId: subject.subjectId, kind: subject.kind, cases });
      if (mode === "full") {
        qualifications.push({
          subjectId: subject.subjectId,
          kind: subject.kind,
          mode,
          capabilityDigest: createHash("sha256").update(JSON.stringify(digestSource)).digest("hex"),
          ledger,
        });
      }
    }
    return mode === "full" ? { subjects: evidence, qualifications } : { subjects: evidence };
  } catch (error) {
    if (error instanceof ContractFailure) {
      error.message += ` Location: ${location}.`;
      throw error;
    }
    if (error instanceof Error && error.message.startsWith("COMMUNICATIONS_CONFORMANCE:")) {
      throw new ContractFailure(`${error.message}. Location: ${location}.`);
    }
    throw new ContractFailure(
      `COMMUNICATIONS_CONFORMANCE:adapter_threw. Inspect the adapter privately for an exception or malformed result. Recheck with runCommunicationsAdapterConformance using the corrected offline fixture. Location: ${location}.`,
    );
  }
}
