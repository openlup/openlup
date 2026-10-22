import type { DispatchEvidence, DispatchRecord, FulfillmentDispatchResult } from "./contracts/index.js";

/** Copy only the durable allowlist, including when an adapter object has extra runtime properties. */
export function dispatchEvidence(evidence: DispatchEvidence): DispatchEvidence {
  return {
    commandFingerprint: evidence.commandFingerprint,
    contactRevision: { schemaVersion: evidence.contactRevision.schemaVersion, source: evidence.contactRevision.source, revision: evidence.contactRevision.revision },
    providerRef: evidence.providerRef, carrierRef: evidence.carrierRef, serviceRef: evidence.serviceRef,
  };
}
export function dispatchResult(result: FulfillmentDispatchResult): FulfillmentDispatchResult {
  switch (result.kind) {
    case "accepted": return { kind: "accepted", externalRef: result.externalRef, providerAttemptKey: result.providerAttemptKey, labelKey: result.labelKey, evidence: dispatchEvidence(result.evidence) };
    case "not_dispatched": return { kind: "not_dispatched", effectMayHaveSucceeded: false, refusal: { reason: result.refusal.reason, phase: result.refusal.phase, retryable: result.refusal.retryable } };
    case "unknown": return { kind: "unknown", effectMayHaveSucceeded: true, refusal: { reason: result.refusal.reason, phase: result.refusal.phase, retryable: result.refusal.retryable } };
  }
}
export function acceptedProviderProof(record: DispatchRecord | null): record is DispatchRecord & { externalRef: string } {
  return Boolean(record?.externalRef && (record.status === "created" || record.status === "uncertain"));
}
