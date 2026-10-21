

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
