import { createHash } from "node:crypto";
import type { DispatchEvidence, DispatchRecord, FulfillmentDispatchRequest, FulfillmentDispatchResult, FulfillmentOperationError } from "./contracts/index.js";

/** Machine identities only: arbitrary exception prose, URLs and credentials are omitted. */
export function safeDiagnosticCode(value: unknown): string | null {
  return reference(value) && typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_]{0,95}$/u.test(value) ? value : null;
}
export function localFailureReason(stage: string, error: unknown, privacy = durableStrings()): string {
  if (!error || typeof error !== "object") return stage;
  const fields = error as { code?: unknown; causeCode?: unknown; causeMessage?: unknown; message?: unknown };
  const diagnostic = (value: unknown) => typeof value === "string" ? privacy.token(value, safeDiagnosticCode) : null;
  const ownCode = diagnostic(fields.code), causeCode = diagnostic(fields.causeCode), causeMessage = diagnostic(fields.causeMessage);
  const messagePattern = /^([A-Za-z][A-Za-z0-9_]*)(?::([A-Z0-9]{5}))?$/u;
  const safeMessage = typeof fields.message === "string" ? privacy.token(fields.message, value => messagePattern.test(value) ? value : null) : null;
  const message = safeMessage?.match(messagePattern);
  const cause = causeMessage ?? (message && (message[2] || /_(?:failed|down|missing|invalid|conflict|not_found)$/u.test(message[1]!)) ? safeDiagnosticCode(message[1]) : null);
  const code = causeCode ?? ownCode ?? message?.[2];
  return [stage, cause, code].filter(Boolean).join(":");
}
export function operationError(error: Omit<FulfillmentOperationError, "cause"> & { cause?: unknown }): FulfillmentOperationError {
  const privacy = durableStrings(error.redactedFieldCount);
  const code = privacy.token(error.code, safeDiagnosticCode) ?? "operation_failed";
  const cause = typeof error.cause === "string" ? privacy.token(error.cause,
    value => /^ack(?::[A-Za-z0-9_]{1,96}){0,2}$/u.test(value) ? value.slice(0,180) : null) : null;
  return { code, status: Number.isInteger(error.status) && error.status! >= 100 && error.status! <= 599 ? error.status : null,
    retryable: error.retryable === true, mayHaveSucceeded: error.mayHaveSucceeded === true,
    ...(typeof error.submissionAttempted === "boolean" ? { submissionAttempted: error.submissionAttempted } : {}),
    ...(typeof error.responseBodyRead === "boolean" ? { responseBodyRead: error.responseBodyRead } : {}),
    ...(cause ? { cause } : {}), ...(privacy.redactedFieldCount ? { redactedFieldCount: privacy.redactedFieldCount } : {}) };
}
// The fulfillment opaque-ID rule; never accept free-form metadata as a reference.
export const reference = (value: unknown): string | null => typeof value === "string"
  && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value) ? value : null;
/** Opaque by default; an explicit allowlist can admit wider incumbent references. */
export function admittedReference(value: string | null | undefined, approve?: (value: string) => boolean): string | null {
  if (typeof value !== "string" || /[\p{Cc}\p{Cf}]/u.test(value)) return null;
  const admitted = approve ? approve(value) : reference(value) !== null;
  const text = value.trim();
  return admitted && text && text.length <= 256 && !/[@]|[a-z][a-z0-9+.-]*:\/\//iu.test(text) ? text : null;
}
const isoDate = (value: string | null | undefined): string | null => typeof value === "string"
  && /^\d{4}-\d\d-\d\d$/u.test(value) && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString().slice(0, 10) === value ? value : null;
/** One counted sanitizer for durable projections; codecs are explicit host policy. */
export function durableStrings(priorCount = 0) {
  let count = Number.isSafeInteger(priorCount) && priorCount > 0 ? priorCount : 0;
  return {
    token(value: string | null | undefined, codec: (value: string) => string | null = reference) {
      if (value == null) return null;
      const safe = codec(value);
      if (safe === null) count += 1;
      return safe;
    },
    get redactedFieldCount() { return count; },
  };
}
/** Copy only the durable allowlist, including when an adapter object has extra runtime properties. */
export function dispatchEvidence(evidence: DispatchEvidence): DispatchEvidence {
  const privacy = durableStrings(evidence.redactedFieldCount ?? evidence.transcript?.redactedFieldCount);
  const sanitize = privacy.token;
  const commandFingerprint = evidence.commandFingerprint;
  const source = evidence.contactRevision.source;
  const providerRef = sanitize(evidence.providerRef) ?? "redacted", carrierRef = sanitize(evidence.carrierRef), serviceRef = sanitize(evidence.serviceRef);
  const mode = evidence.mapping ? (sanitize(evidence.mapping.mode) ?? "shadow") as NonNullable<DispatchEvidence["mapping"]>["mode"] : null;
  const transcript = evidence.transcript ? {
    itemCount: evidence.transcript.items.length,
    items: evidence.transcript.items.map(item => ({ skuRef: sanitize(item.skuRef) ?? "redacted", quantity: Number.isSafeInteger(item.quantity) && item.quantity > 0 ? item.quantity : 0,
      lotRef: sanitize(item.lotRef), expirationDate: sanitize(item.expirationDate, isoDate) })),
    deliveryKind: evidence.transcript.deliveryKind === "parcel-locker" ? "parcel-locker" as const : "courier" as const,
    pickupPointRef: sanitize(evidence.transcript.pickupPointRef),
    ...(privacy.redactedFieldCount > 0 ? { redactedFieldCount: privacy.redactedFieldCount } : {}),
  } : null;
  return {
    commandFingerprint,
    contactRevision: { schemaVersion: evidence.contactRevision.schemaVersion, source, revision: evidence.contactRevision.revision },
    providerRef, carrierRef, serviceRef,
    ...(transcript ? { transcript } : privacy.redactedFieldCount ? { redactedFieldCount: privacy.redactedFieldCount } : {}),
    ...(evidence.mapping ? { mapping: { source: "dispatch_worker" as const, mode: mode!, shadowMode: evidence.mapping.mode === "shadow" } } : {}),
  };
}
/** Shadow has a local command identity; it never invokes a provider or resolves credentials. */
export function shadowDispatchEvidence(request: FulfillmentDispatchRequest, commandFingerprint?: string): DispatchEvidence {
  if (!request.selection.providerRef || !request.lines.length || request.lines.some(line => !Number.isSafeInteger(line.quantity) || line.quantity <= 0)) throw new Error("dispatch_shadow_command_invalid");
  return dispatchEvidence({ commandFingerprint: commandFingerprint ?? createHash("sha256").update(JSON.stringify(request)).digest("hex"),
    contactRevision: request.contactRevision, providerRef: request.selection.providerRef,
    carrierRef: request.selection.carrierRef, serviceRef: request.selection.serviceRef,
    transcript: { itemCount: request.lines.length, items: request.lines.map(line => ({ skuRef: line.skuRef, quantity: line.quantity,
      lotRef: line.lotRef ?? null, expirationDate: line.expirationDate ?? null })),
      deliveryKind: request.selection.deliveryKind, pickupPointRef: request.selection.pickupPoint?.id ?? null } });
}
export function dispatchResult(result: FulfillmentDispatchResult): FulfillmentDispatchResult {
  const privacy = durableStrings(result.redactedFieldCount);
  const externalRef = result.kind === "accepted" ? privacy.token(result.externalRef) ?? "redacted" : null;
  const refusal = result.kind !== "accepted" ? { reason: (privacy.token(result.refusal.reason) ?? "malformed") as typeof result.refusal.reason,
    phase: (privacy.token(result.refusal.phase) ?? "normalize") as typeof result.refusal.phase, retryable: result.refusal.retryable } : null;
  const redactions = privacy.redactedFieldCount ? { redactedFieldCount: privacy.redactedFieldCount } : {};
  const error = result.error ? { error: operationError({ ...result.error, mayHaveSucceeded: result.kind !== "not_dispatched" }) } : {};
  switch (result.kind) {
    case "accepted": return { kind: "accepted", externalRef: externalRef!, providerAttemptKey: result.providerAttemptKey, labelKey: result.labelKey, ...redactions, evidence: dispatchEvidence(result.evidence), ...error,
      ...(result.recovery ? { recovery: { source: "persisted_acceptance", proof: "persisted_external_ref", noProviderPost: true } } : {}) };
    case "not_dispatched": return { kind: "not_dispatched", effectMayHaveSucceeded: false, refusal: refusal!, ...redactions, ...error };
    case "unknown": return { kind: "unknown", effectMayHaveSucceeded: true, refusal: refusal!, ...redactions, ...error };
  }
}
export function acceptedProviderProof(record: DispatchRecord | null): record is DispatchRecord & { externalRef: string } {
  return Boolean(record?.externalRef && (record.status === "created" || record.status === "uncertain"));
}
