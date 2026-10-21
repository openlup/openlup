import type { PaymentRecoveryMethod, PaymentRecoveryOperation } from "@openlup/core/payment";

export type FailureObservationSource = "execution" | "webhook" | "readback";
export type FailureObservationDisposition = "present" | "absent" | "unreadable" | "read_failed" | "read_timeout";

/** Protected provider facts, not a customer message or a retry-policy input. */
export interface PaymentFailureEvidence {
  version: 1;
  source: FailureObservationSource;
  disposition: FailureObservationDisposition;
  refusalVerified: boolean;
  providerPaymentId: string | null;
  providerChargeId: string | null;
  code: string | null;
  declineCode: string | null;
  adviceCode: string | null;
  adviceOrigin: "provider" | "inferred" | "unknown";
  operation: PaymentRecoveryOperation | null;
  method: PaymentRecoveryMethod | null;
  methodSource: "provider" | "execution_contract" | "unknown";
}

/** Bounded machine tokens only. Free-form response fields never cross this seam. */
export function evidenceToken(value: unknown): string | null {
  return typeof value === "string" && /^[a-zA-Z0-9_:.-]{1,96}$/.test(value) ? value : null;
}

export function evidenceRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

/** Explicit construction prevents accidental payload expansion by object spreading. */
export function serializeFailureEvidence(input: PaymentFailureEvidence): PaymentFailureEvidence {
  const method = input.method;
  const kind = evidenceToken(method?.kind);
  const recoveryMethodKey = evidenceToken(method?.recoveryMethodKey);
  return {
    version: 1,
    source: input.source,
    disposition: input.disposition,
    refusalVerified: input.refusalVerified,
    providerPaymentId: evidenceToken(input.providerPaymentId),
    providerChargeId: evidenceToken(input.providerChargeId),
    code: evidenceToken(input.code),
    declineCode: evidenceToken(input.declineCode),
    adviceCode: evidenceToken(input.adviceCode),
    adviceOrigin: input.adviceOrigin,
    operation: input.operation,
    method: kind && recoveryMethodKey && method ? { kind, recoveryMethodKey, interaction: method.interaction } : null,
    methodSource: kind && recoveryMethodKey ? input.methodSource : "unknown",
  };
}

/** Persist beside legacy fields; never merge the diagnostic codes into them. */
export function failureEvidencePayload(evidence: PaymentFailureEvidence | null | undefined): Record<string, unknown> {
  return evidence ? { failureEvidence: serializeFailureEvidence(evidence) } : {};
}
