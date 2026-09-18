import { createHash } from "node:crypto";

export type PaymentTruthOutcome = "captured" | "refused" | "indeterminate";

/**
 * How a refusal looked to the settlement source that reported it.
 *
 * NOT the retry taxonomy. `PaymentFailureClass` in `@openlup/core/payment` is a
 * different vocabulary with no value in common: that one answers "may this be
 * retried, and how", and is what `commerce_payment_attempts.failure_class`
 * persists. This one answers "what did the source say happened" and never leaves
 * this module's reconciliation ledger. They shared a name until this wave, which
 * meant an import could quietly resolve to the wrong five strings.
 */
export type PaymentTruthRefusalClass =
  | "authorization_refused"
  | "insufficient_funds"
  | "method_unavailable"
  | "risk_refused"
  | "unknown_refusal";

const PAYMENT_TRUTH_REFUSAL_CLASSES: readonly PaymentTruthRefusalClass[] = [
  "authorization_refused",
  "insufficient_funds",
  "method_unavailable",
  "risk_refused",
  "unknown_refusal",
];

export type PaymentSourceEvidence = {
  sourceKind: "accepted_event" | "reconciliation_read";
  sourceReference: string;
  observedStatus: string;
  observedAt: string;
  payloadFingerprint: string;
};

export type PaymentTruthEvent = {
  sourceEventId: string;
  idempotencyKey: string;
  settlementIntentId: string;
  outcome: PaymentTruthOutcome;
  amountMinor: number;
  currency: string;
  occurredAt: string;
  failure: { classification: PaymentTruthRefusalClass; reason: string | null } | null;
  evidence: PaymentSourceEvidence;
};

export type PaymentReconciliationResult = {
  eventId: string;
  idempotencyKey: string;
  evidenceStatus: "observed" | "failed";
  outcome: PaymentTruthOutcome;
  occurredAt: string;
  failure: PaymentTruthEvent["failure"];
  evidence: PaymentSourceEvidence;
};

export function paymentReconciliationFingerprint(input: PaymentReconciliationResult): string {
  if (!input.eventId.trim() || input.idempotencyKey.trim().length < 8 || !isInstant(input.occurredAt)) {
    throw new Error("payment_reconciliation_input_invalid");
  }
  if (input.evidenceStatus === "failed" && input.outcome !== "indeterminate") {
    throw new Error("payment_reconciliation_failure_cannot_terminalize");
  }
  if (input.outcome === "refused" && !input.failure) {
    throw new Error("payment_truth_refusal_classification_required");
  }
  if (input.outcome !== "refused" && input.failure) {
    throw new Error("payment_truth_failure_only_for_refusal");
  }
  assertPaymentFailure(input.failure);
  assertPaymentSourceEvidence(input.evidence);
  return digest({
    eventId: input.eventId,
    evidenceStatus: input.evidenceStatus,
    outcome: input.outcome,
    occurredAt: input.occurredAt,
    failure: input.failure,
    evidence: input.evidence,
  });
}

export type PaymentTruthReadback = {
  event: {
    id: string;
    sourceEventId: string;
    fingerprint: string;
    state: "open" | "settled";
    outcome: PaymentTruthOutcome;
    replayed: boolean;
  };
  effects: {
    paymentResultRecorded: boolean;
    dunningOpened: boolean;
    accountingRequested: boolean;
  };
  financial: {
    settlementStatus: string | null;
    orderStatus: string | null;
    subscriptionStatus: string | null;
    accountingStatus: string | null;
    amountMinor: number;
    currency: string;
  };
};

export interface PaymentTruthPort {
  ingestEvent(input: PaymentTruthEvent): Promise<PaymentTruthReadback>;
  recordReconciliation(input: PaymentReconciliationResult): Promise<PaymentTruthReadback>;
  sweepOpenEvents(input: { now: string; limit: number }): Promise<{
    claimed: number;
    settledIgnored: number;
    eventIds: string[];
  }>;
  readEvent(eventId: string): Promise<PaymentTruthReadback | null>;
}

export type CanonicalPaymentSource = {
  sourceEventId: string;
  eventKind: string;
  settlementIntentId: string | null;
  amountMinor: number | null;
  currency: string | null;
  occurredAt: string | null;
  payloadFingerprint: string;
};

/** Fingerprint accepted at a provider boundary before local ownership is known. */
export function paymentSourceFingerprint(input: CanonicalPaymentSource): string {
  if (!input.sourceEventId.trim() || !input.eventKind.trim()
    || (input.occurredAt !== null && !isInstant(input.occurredAt))) {
    throw new Error("payment_source_fingerprint_input_invalid");
  }
  if (!/^[0-9a-f]{64}$/.test(input.payloadFingerprint)) {
    throw new Error("payment_truth_payload_fingerprint_invalid");
  }
  return digest(input);
}

export function paymentPayloadFingerprint(payload: unknown): string {
  return digest(payload);
}

/** Canonical identity for one normalized event; idempotency is deliberately not part of it. */
export function paymentTruthFingerprint(input: PaymentTruthEvent): string {
  assertPaymentTruthEvent(input);
  return digest({
    sourceEventId: input.sourceEventId,
    settlementIntentId: input.settlementIntentId,
    outcome: input.outcome,
    amountMinor: input.amountMinor,
    currency: input.currency,
    occurredAt: input.occurredAt,
    failure: input.failure,
    evidence: input.evidence,
  });
}

export function assertPaymentTruthEvent(input: PaymentTruthEvent): void {
  if (!input.sourceEventId.trim()) throw new Error("payment_truth_source_event_id_required");
  if (input.idempotencyKey.trim().length < 8) throw new Error("payment_truth_idempotency_key_invalid");
  if (!input.settlementIntentId.trim()) throw new Error("payment_truth_settlement_intent_required");
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new Error("payment_truth_amount_invalid");
  }
  if (!/^[A-Z]{3}$/.test(input.currency)) throw new Error("payment_truth_currency_invalid");
  if (!isInstant(input.occurredAt) || !isInstant(input.evidence.observedAt)) {
    throw new Error("payment_truth_time_invalid");
  }
  if (!input.evidence.sourceReference.trim() || !input.evidence.observedStatus.trim()) {
    throw new Error("payment_truth_source_evidence_invalid");
  }
  if (!/^[0-9a-f]{64}$/.test(input.evidence.payloadFingerprint)) {
    throw new Error("payment_truth_payload_fingerprint_invalid");
  }
  if (input.outcome === "refused" && !input.failure) {
    throw new Error("payment_truth_refusal_classification_required");
  }
  if (input.outcome !== "refused" && input.failure) {
    throw new Error("payment_truth_failure_only_for_refusal");
  }
  assertPaymentFailure(input.failure);
  assertPaymentSourceEvidence(input.evidence);
}

function isInstant(value: string): boolean {
  return value.trim().length > 0 && Number.isFinite(Date.parse(value));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertPaymentFailure(failure: PaymentTruthEvent["failure"]): void {
  if (failure && !PAYMENT_TRUTH_REFUSAL_CLASSES.includes(failure.classification)) {
    throw new Error("payment_truth_failure_class_invalid");
  }
}

function assertPaymentSourceEvidence(evidence: PaymentSourceEvidence): void {
  if (evidence.sourceKind !== "accepted_event" && evidence.sourceKind !== "reconciliation_read") {
    throw new Error("payment_truth_source_kind_invalid");
  }
  if (!evidence.sourceReference.trim() || !evidence.observedStatus.trim()) {
    throw new Error("payment_truth_source_evidence_invalid");
  }
  if (!isInstant(evidence.observedAt)) throw new Error("payment_truth_time_invalid");
  if (!/^[0-9a-f]{64}$/.test(evidence.payloadFingerprint)) {
    throw new Error("payment_truth_payload_fingerprint_invalid");
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}
