import { createHash } from "node:crypto";
import type { DispatchEvidence, DispatchRecord, FulfillmentDispatchRequest, FulfillmentDispatchResult, FulfillmentOperationError } from "./contracts/index.js";

/** Machine identities only: arbitrary exception prose, URLs and credentials are omitted. */
export function safeDiagnosticCode(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_]{0,95}$/u.test(value) ? value : null;
}
export function localFailureReason(stage: string, error: unknown): string {
  if (!error || typeof error !== "object") return stage;
  const fields = error as { code?: unknown; causeCode?: unknown; causeMessage?: unknown; message?: unknown };
  const message = typeof fields.message === "string" ? fields.message.match(/^([A-Za-z][A-Za-z0-9_]*)(?::([A-Z0-9]{5}))?$/u) : null;
  const cause = safeDiagnosticCode(fields.causeMessage) ?? (message && (message[2] || /_(?:failed|down|missing|invalid|conflict|not_found)$/u.test(message[1]!)) ? safeDiagnosticCode(message[1]) : null);
  const code = safeDiagnosticCode(fields.causeCode) ?? safeDiagnosticCode(fields.code) ?? message?.[2];
  return [stage, cause, code].filter(Boolean).join(":");
}
export function operationError(error: Omit<FulfillmentOperationError, "cause"> & { cause?: unknown }): FulfillmentOperationError {
  return { code: safeDiagnosticCode(error.code) ?? "operation_failed", status: Number.isInteger(error.status) && error.status! >= 100 && error.status! <= 599 ? error.status : null,
    retryable: error.retryable === true, mayHaveSucceeded: error.mayHaveSucceeded === true,
    ...(typeof error.cause === "string" && /^ack(?::[A-Za-z0-9_]{1,96}){0,2}$/u.test(error.cause) ? { cause: error.cause.slice(0,180) } : {}) };
}
const reference = (value: string | null | undefined): string | null => typeof value === "string" && value.length <= 256
  && !/[@\r\n]|[a-z][a-z0-9+.-]*:\/\//iu.test(value) ? value : null;
/** Copy only the durable allowlist, including when an adapter object has extra runtime properties. */
export function dispatchEvidence(evidence: DispatchEvidence): DispatchEvidence {
  return {
    commandFingerprint: evidence.commandFingerprint,
    contactRevision: { schemaVersion: evidence.contactRevision.schemaVersion, source: evidence.contactRevision.source, revision: evidence.contactRevision.revision },
    providerRef: evidence.providerRef, carrierRef: evidence.carrierRef, serviceRef: evidence.serviceRef,
    ...(evidence.transcript ? { transcript: {
      itemCount: evidence.transcript.items.length,
      items: evidence.transcript.items.map(item => ({ skuRef: reference(item.skuRef) ?? "redacted", quantity: Number.isSafeInteger(item.quantity) && item.quantity > 0 ? item.quantity : 0,
        lotRef: reference(item.lotRef), expirationDate: reference(item.expirationDate) })),
      deliveryKind: evidence.transcript.deliveryKind === "parcel-locker" ? "parcel-locker" : "courier", pickupPointRef: reference(evidence.transcript.pickupPointRef),
    } } : {}),
    ...(evidence.mapping ? { mapping: { source: "dispatch_worker" as const, mode: evidence.mapping.mode, shadowMode: evidence.mapping.mode === "shadow" } } : {}),
  };
}
/** Shadow has a local command identity; it never invokes a provider or resolves credentials. */
export function shadowDispatchEvidence(request: FulfillmentDispatchRequest): DispatchEvidence {
  if (!request.selection.providerRef || !request.lines.length || request.lines.some(line => !Number.isSafeInteger(line.quantity) || line.quantity <= 0)) throw new Error("dispatch_shadow_command_invalid");
  return dispatchEvidence({ commandFingerprint: createHash("sha256").update(JSON.stringify(request)).digest("hex"),
    contactRevision: request.contactRevision, providerRef: request.selection.providerRef,
    carrierRef: request.selection.carrierRef, serviceRef: request.selection.serviceRef,
    transcript: { itemCount: request.lines.length, items: request.lines.map(line => ({ skuRef: line.skuRef, quantity: line.quantity,
      lotRef: line.lotRef ?? null, expirationDate: line.expirationDate ?? null })),
      deliveryKind: request.selection.deliveryKind, pickupPointRef: request.selection.pickupPoint?.id ?? null } });
}
export function dispatchResult(result: FulfillmentDispatchResult): FulfillmentDispatchResult {
  const error = result.error ? { error: operationError({ ...result.error, mayHaveSucceeded: result.kind !== "not_dispatched" }) } : {};
  switch (result.kind) {
    case "accepted": return { kind: "accepted", externalRef: result.externalRef, providerAttemptKey: result.providerAttemptKey, labelKey: result.labelKey, evidence: dispatchEvidence(result.evidence), ...error,
      ...(result.recovery ? { recovery: { source: "persisted_acceptance", proof: "persisted_external_ref", noProviderPost: true } } : {}) };
    case "not_dispatched": return { kind: "not_dispatched", effectMayHaveSucceeded: false, refusal: { reason: result.refusal.reason, phase: result.refusal.phase, retryable: result.refusal.retryable }, ...error };
    case "unknown": return { kind: "unknown", effectMayHaveSucceeded: true, refusal: { reason: result.refusal.reason, phase: result.refusal.phase, retryable: result.refusal.retryable }, ...error };
  }
}
export function acceptedProviderProof(record: DispatchRecord | null): record is DispatchRecord & { externalRef: string } {
  return Boolean(record?.externalRef && (record.status === "created" || record.status === "uncertain"));
}
