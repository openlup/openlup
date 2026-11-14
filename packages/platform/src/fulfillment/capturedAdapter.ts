import { createHash } from "node:crypto";
import type { DispatchEvidence, FulfillmentCapabilityDescriptor, FulfillmentDispatchPort, FulfillmentDispatchRequest, FulfillmentDispatchResult } from "./contracts/index.js";
import { dispatchEvidence, reference } from "./dispatchProjection.js";
import { readFulfillmentCapabilities } from "./providerCapabilities.js";

const capturedAdapters = new WeakMap<object, FulfillmentDispatchPort>();
/** Internal profile brand; capability declarations cannot select the captured profile. */
export function isCapturedFulfillmentAdapter(adapter: object, port: FulfillmentDispatchPort, prepare: FulfillmentDispatchPort["prepare"], dispatch: FulfillmentDispatchPort["dispatch"]): boolean {
  const original = capturedAdapters.get(adapter);
  return original === port && original.prepare === prepare && original.dispatch === dispatch;
}

/** Synthetic, host-owned captures only. No command is sent to a provider. */
export interface CapturedFulfillmentCommand {
  request: FulfillmentDispatchRequest;
  outcome: { kind: "accepted"; externalRef: string } | { kind: "not_dispatched" } | { kind: "unknown" };
}

/** An offline adapter, selected explicitly; captures are immutable after construction. */
export function createCapturedFulfillmentAdapter(options: {
  providerRef: string;
  selected?: boolean;
  captures: readonly CapturedFulfillmentCommand[];
}): { capabilities: FulfillmentCapabilityDescriptor; dispatch: FulfillmentDispatchPort; readSubmissionCount(): number } {
  const providerRef = options.providerRef;
  if (!reference(providerRef) || providerRef !== providerRef.toLowerCase()) throw new Error("captured_fulfillment_provider_invalid");
  const no = { supported: false, reason: "not_exposed" } as const;
  const capabilities: FulfillmentCapabilityDescriptor = {
    providerRef, role: "simulator", defaultOff: true, selected: options.selected === true, readiness: { ready: true },
    operations: { dispatch: { supported: true }, readback: no, exactAbsence: no, verifyObservation: no,
      syncStock: no, syncProducts: no, labelCreate: no, labelRead: no, labelVoid: no, cancel: no, pickupPoint: no, courierPickup: no },
    authentication: "none", freshness: "not_available", ownsDeliveredNotification: false,
    stockAuthority: "local_atp", labelReadOwner: "none",
    actionPolicy: { providerSpecificAdminActions: false, genericAdminActions: false, mutationSurface: "none" },
  };
  const captures = new Map<string, { fingerprint: string; evidence: DispatchEvidence; result: FulfillmentDispatchResult }>();
  for (const value of options.captures) {
    const { request, outcome } = structuredClone(value);
    if (!reference(request.requestKey) || request.selection.providerRef !== providerRef || !request.lines.length
      || request.lines.some(line => !Number.isSafeInteger(line.quantity) || line.quantity <= 0)
      || !reference(request.contactRevision.source) || !Number.isSafeInteger(request.contactRevision.schemaVersion)
      || request.contactRevision.schemaVersion < 1 || !Number.isSafeInteger(request.contactRevision.revision)
      || request.contactRevision.revision < 0 || captures.has(request.requestKey)
      || (outcome.kind === "accepted" && !reference(outcome.externalRef))) {
      throw new Error("captured_fulfillment_command_invalid");
    }
    // These exact canonical JSON bytes are the synthetic command. Only its digest
    // and the existing durable evidence allowlist are retained by this adapter.
    const fingerprint = commandFingerprint(request);
    const evidence = dispatchEvidence({ commandFingerprint: fingerprint, contactRevision: request.contactRevision,
      providerRef, carrierRef: request.selection.carrierRef, serviceRef: request.selection.serviceRef });
    const result: FulfillmentDispatchResult = outcome.kind === "accepted"
      ? { kind: "accepted", externalRef: outcome.externalRef, evidence,
        providerAttemptKey: `captured-attempt:${fingerprint}`, labelKey: `captured-receipt:${fingerprint}` }
      : outcome.kind === "unknown"
        ? { kind: "unknown", effectMayHaveSucceeded: true, refusal: { reason: "io_failure", phase: "dispatch", retryable: true } }
        : { kind: "not_dispatched", effectMayHaveSucceeded: false, refusal: { reason: "not_dispatchable", phase: "dispatch", retryable: false } };
    captures.set(request.requestKey, { fingerprint, evidence, result });
  }
  const prepared = new Set<string>(), submitted = new Set<string>();
  function match(request: FulfillmentDispatchRequest) {
    const captured = captures.get(request.requestKey);
    return captured?.fingerprint === commandFingerprint(request) ? captured : undefined;
  }
  const dispatch: FulfillmentDispatchPort = {
    async prepare(request) {
      const selection = readFulfillmentCapabilities([capabilities], request.selection);
      if (selection.kind === "refused") return selection;
      const captured = match(request);
      if (!captured) return { kind: "refused", refusal: { reason: "not_dispatchable", phase: "prepare", retryable: false } };
      prepared.add(captured.fingerprint);
      return { kind: "prepared", evidence: structuredClone(captured.evidence) };
    },
    async dispatch(request, evidence) {
      const captured = match(request);
      const selection = readFulfillmentCapabilities([capabilities], request.selection);
      if (selection.kind === "refused" || !captured || !prepared.has(captured.fingerprint)
        || canonical(evidence) !== canonical(captured.evidence)) {
        return { kind: "not_dispatched", effectMayHaveSucceeded: false,
          refusal: { reason: "not_dispatchable", phase: "dispatch", retryable: false } };
      }
      // Replay, including an unknown outcome, never becomes a second submission.
      submitted.add(captured.fingerprint);
      return structuredClone(captured.result);
    },
  };
  const adapter = { capabilities, dispatch, readSubmissionCount: () => submitted.size };
  capturedAdapters.set(adapter, dispatch);
  return freezeCapture(adapter);
}

function freezeCapture<T>(value: T): T {
  if (value && (typeof value === "object" || typeof value === "function")) {
    Object.values(value).forEach(freezeCapture); Object.freeze(value);
  }
  return value;
}

function commandFingerprint(request: FulfillmentDispatchRequest): string {
  return createHash("sha256").update(canonical(request)).digest("hex");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
