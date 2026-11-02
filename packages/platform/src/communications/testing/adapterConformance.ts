import type { EmailMessage, EmailSendResult, EmailTransport } from "../emailTransport.js";
import type { MarketingSyncProvider, SyncRequest, SyncResult } from "../contracts/marketingSync.js";

type Fixture<Input, Result> = {
  readonly input: Input;
  readonly expected: Result;
  /** Total external mutations performed by this one invocation. */
  readonly expectedEffects: number;
};
type OfflineAdapter<Adapter> = { readonly adapter: Adapter; readonly readEffectCount: () => number };
type EmailSubject = {
  readonly kind: "email";
  readonly subjectId: string;
  /** Fresh offline adapter and counter for each fixture; never use live credentials. */
  readonly create: (input: EmailMessage) => OfflineAdapter<EmailTransport> | Promise<OfflineAdapter<EmailTransport>>;
  readonly fixtures: readonly Fixture<EmailMessage, EmailSendResult>[];
};
type SyncFixture = { [O in SyncRequest["operation"]]: Fixture<SyncRequest<O>, SyncResult<O>> & {
  /** Reinvoke this exact mutation and prove no second external effect. */
  readonly replay?: boolean;
} }[SyncRequest["operation"]];
type MarketingSubject = {
  readonly kind: "marketing-sync";
  readonly subjectId: string;
  readonly create: (input: SyncRequest) => OfflineAdapter<MarketingSyncProvider> | Promise<OfflineAdapter<MarketingSyncProvider>>;
  readonly fixtures: readonly SyncFixture[];
};
export type CommunicationsAdapterConformanceSubject = EmailSubject | MarketingSubject;
export interface CommunicationsAdapterConformanceEvidence {
  readonly subjects: readonly {
    readonly subjectId: string;
    readonly kind: CommunicationsAdapterConformanceSubject["kind"];
    readonly cases: readonly string[];
  }[];
}

class ContractFailure extends Error {}
function requireFact(value: unknown, code: string, fix: string): asserts value {
  if (!value) throw new ContractFailure(`COMMUNICATIONS_CONFORMANCE:${code}. ${fix}. Recheck with runCommunicationsAdapterConformance using the corrected offline fixture.`);
}
function same(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object" || Array.isArray(left) !== Array.isArray(right)) return false;
  const a = Object.keys(left), b = Object.keys(right);
  return a.length === b.length && a.every(key => Object.hasOwn(right, key) && same((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}
function count(read: () => number): number {
  const value = read();
  requireFact(Number.isSafeInteger(value) && value >= 0, "effect_counter", "Supply a nonnegative external mutation counter covering every injected transport");
  return value;
}
function effects(read: () => number, before: number, expected: number): void {
  requireFact(Number.isSafeInteger(expected) && expected >= 0 && count(read) - before === expected,
    "effect_count", "Match the declared mutation count and refuse before external effects");
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
        .every(key => same(result.receipt.request[key], original[key]));
      requireFact((input.operation === "erasure.read" ? same(result.receipt.request, original) : sameMutation)
        && result.receipt.operation === original.operation,
        "receipt_identity", "Retain the original admitted mutation in the receipt");
    }
  }
  if (result.kind === "retryable") requireFact(Number.isFinite(result.afterSeconds) && result.afterSeconds > 0,
    "retry_delay", "Return a finite positive retry delay");
  if (result.kind === "completed" && result.operation === "consent.read") {
    requireFact(same(result.value.audience, input.audience), "feedback_scope", "Retain the requested audience on consent readback");
    const outcomes = { unsubscribe: "deny_permission", complaint: "deny_permission", manual_block: "deny_permission",
      hard_bounce: "deny_delivery", invalid_address: "deny_delivery" };
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

/** Offline fixture proof, following the payment/invoice/fulfillment runners.
 * No provider access, fixture discovery or test framework is supplied here.
 * Only subject labels and passed case labels leave the runner; raw results and
 * adapter exceptions are never included in findings. Not full provider qualification.
 */
export async function runCommunicationsAdapterConformance(
  subjects: readonly CommunicationsAdapterConformanceSubject[],
): Promise<CommunicationsAdapterConformanceEvidence> {
  const evidence: CommunicationsAdapterConformanceEvidence["subjects"][number][] = [];
  let location = "subject selection";
  try {
    requireFact(subjects.length > 0, "subject_required", "Supply at least one offline adapter subject");
    for (const [subjectIndex, subject] of subjects.entries()) {
      location = `subject ${subjectIndex + 1}`;
      requireFact(subject.subjectId.trim().length > 0, "subject_id", "Supply an opaque non-sensitive subject label");
      const cases: string[] = [];
      if (subject.kind === "email") {
        requireFact(subject.fixtures.some(row => row.expected.outcome.ok && !row.expected.outcome.suppressed)
          && subject.fixtures.some(row => !row.expected.outcome.ok && !row.expected.outcome.suppressed)
          && subject.fixtures.some(row => row.expected.outcome.suppressed === "drop"),
        "email_fixtures", "Supply accepted, failed and suppressed email fixtures");
        for (const [fixtureIndex, row] of subject.fixtures.entries()) {
          location = `subject ${subjectIndex + 1}, fixture ${fixtureIndex + 1}`;
          const { adapter, readEffectCount } = await subject.create(row.input), before = count(readEffectCount);
          requireFact(adapter.providerKind.trim().length > 0, "provider_kind", "Declare the email transport provider kind");
          const result = await adapter.send(row.input), outcome = result.outcome;
          requireFact(typeof outcome.ok === "boolean" && typeof outcome.aborted === "boolean"
            && (outcome.resendId === null || typeof outcome.resendId === "string")
            && (outcome.providerError === null || typeof outcome.providerError === "string")
            && Number.isInteger(outcome.httpStatus) && outcome.httpStatus >= 0 && outcome.httpStatus <= 599,
          "email_result", "Return the EmailSendResult outcome fields with their declared types");
          requireFact(same(result, row.expected), "email_fixture", "Match the expected email outcome and provider response in the failing fixture");
          if (outcome.suppressed === "drop") effects(readEffectCount, before, 0);
          effects(readEffectCount, before, row.expectedEffects);
          cases.push(outcome.suppressed === "drop" ? "email:suppressed" : outcome.ok ? "email:accepted" : "email:failed");
        }
      } else {
        const supported = new Set<SyncRequest["operation"]>();
        for (const operation of ["profile.sync", "consent.read", "erasure.request", "erasure.read"] as const) {
          requireFact(subject.fixtures.some(row => row.input.operation === operation), "sync_fixtures", "Supply fixtures for all four marketing-sync operations, including unsupported ones");
        }
        requireFact(subject.fixtures.some(row => row.expected.kind === "refused"), "refusal_fixture", "Supply a refused marketing-sync request with zero external effects");
        for (const [fixtureIndex, row] of subject.fixtures.entries()) {
          location = `subject ${subjectIndex + 1}, fixture ${fixtureIndex + 1}`;
          const { adapter, readEffectCount } = await subject.create(row.input), before = count(readEffectCount);
          const capability = adapter.capabilities.operations[row.input.operation];
          if (capability.state === "supported") supported.add(row.input.operation);
          const result = await dispatch(adapter, row.input);
          syncResult(row.input, result);
          requireFact(same(row.input.binding, adapter.capabilities.binding) && same(row.input.audience, adapter.capabilities.audience)
            || result.kind === "refused", "capability_scope", "Refuse requests outside the adapter's declared binding and audience before effects");
          requireFact(capability.state === "supported" || result.kind === "refused" && subject.fixtures.some(fixture =>
            fixture.input.operation === row.input.operation && fixture.expected.kind === "refused" && fixture.expected.reason === capability.state),
          "declared_capability", "Refuse unavailable operations and supply a refusal fixture with the declared unsupported or verification_pending reason");
          requireFact(same(result, row.expected), "sync_fixture", "Match the expected marketing-sync result in the failing fixture");
          if (result.kind === "refused" || row.input.operation === "consent.read" || row.input.operation === "erasure.read") effects(readEffectCount, before, 0);
          effects(readEffectCount, before, row.expectedEffects);
          if (row.replay) {
            requireFact((row.input.operation === "profile.sync" || row.input.operation === "erasure.request")
              && (result.kind === "accepted" || result.kind === "acknowledged"), "replay_fixture", "Replay an accepted or acknowledged mutation fixture");
            const replayBefore = count(readEffectCount), replay = await dispatch(adapter, row.input);
            requireFact(same(replay, result), "replay_result", "Return the original receipt and result for the same request");
            effects(readEffectCount, replayBefore, 0);
          }
          cases.push(`${row.input.operation}:${result.kind}${row.replay ? ":replay" : ""}`);
        }
        for (const operation of supported) {
          if (operation === "profile.sync" || operation === "erasure.request") {
            requireFact(subject.fixtures.some(row => row.input.operation === operation && row.replay),
              "replay_required", "Supply a successful replay fixture for each supported marketing mutation");
          } else {
            requireFact(subject.fixtures.some(row => row.input.operation === operation && row.expected.kind === "completed"),
              "read_success_required", "Supply a completed read fixture for each supported marketing read operation");
          }
        }
      }
      evidence.push({ subjectId: subject.subjectId, kind: subject.kind, cases });
    }
    return { subjects: evidence };
  } catch (error) {
    if (error instanceof ContractFailure) {
      error.message += ` Location: ${location}.`;
      throw error;
    }
    throw new ContractFailure(`COMMUNICATIONS_CONFORMANCE:adapter_threw. Inspect the adapter privately for an exception or malformed result. Recheck with runCommunicationsAdapterConformance using the corrected offline fixture. Location: ${location}.`);
  }
}
