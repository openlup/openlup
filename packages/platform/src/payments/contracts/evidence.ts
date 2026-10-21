import type { PaymentMethodHandoff, PaymentRefusalEnvelope } from "./adapter.js";

type Money = { amountMinor: number; currency: string };
type Identity = {
  provider: string;
  /** Null permits an exact intent lookup when dispatch acknowledgement was lost. */
  providerPaymentRef: string | null;
  intentRef: string;
  attemptRef: string;
};
type VerifiedIdentity = {
  provider: string;
  /** Adapter-derived; includes outcome/status class, never transaction identity alone. */
  providerEventId: string;
  /** Provider-asserted time or null; never substitute receipt time. */
  providerOccurredAt: string | null;
  /** Stable normalized evidence fingerprint; excludes receipt time and secrets. */
  fingerprint: string;
};

/** Original payment money and stable operation identity accompany every reversal. */
export type PaymentRefundObservation = {
  operationId: string;
  originalPaymentMoney: Money;
} & (
  | { kind: "cumulative-snapshot"; refundedMoney: Money }
  | { kind: "event-delta"; refundedMoney: Money }
  | { kind: "full-reversal"; reason: "refund" | "chargeback" }
);

/** Type-only policy: require-evidence is default; legacy behavior needs explicit opt-in. */
export type RefundEvidencePolicy = "require-evidence" | "legacy-assume-full";

/** Verified money facts; authorization alone is never settled money. */
export type VerifiedPaymentEvidence = VerifiedIdentity & {
  kind: "money";
  providerPaymentRef: string;
  intentRef: string | null;
  attemptRef: string | null;
  outcome: "succeeded" | "failed" | "pending" | "refunded";
  money: Money | null;
  refusal?: PaymentRefusalEnvelope;
  refund?: PaymentRefundObservation;
};

/** Method registration/expiry is separate from the money-outcome union. */
export type VerifiedMethodEvidence = VerifiedIdentity & {
  kind: "method";
  outcome: "registered" | "expired";
  methodRef: string;
  setupRef: string | null;
  intentRef: string | null;
};

/** Verification uses injected I/O and original bytes; never reserialize rawBody. */
export interface PaymentVerifyNormalizePort {
  verifyAndNormalize(input: {
    rawBody: Uint8Array;
    headers: Readonly<Record<string, string | readonly string[] | undefined>>;
    /** Freshness only; never part of identity or fingerprint. */
    receivedAt: string;
  }): Promise<VerifiedPaymentEvidence | VerifiedMethodEvidence | {
    kind: "refusal";
    reason: "signature" | "stale" | "malformed" | "unsupported-event";
  }>;
}

/** Existing purpose bytes are preserved for reference reconciliation callers. */
export type ProviderReadPurpose = "active_checkout" | "recovery";

/** Absence requires a complete bounded lookup of exact identity and configured money. */
export type PaymentAbsenceEnvelope = {
  identity: Identity;
  expectedMoney: Money;
} & (
  | { kind: "absent"; evidence: { exact: true; complete: true; lookupReference: string } }
  | { kind: "unknown"; reason: "timeout" | "truncated" | "indeterminate" }
  | { kind: "unsupported" }
);

/** Unknown is neither absence nor unsupported. Timeout/truncation stays unknown. */
export type PaymentReadbackEnvelope = {
  identity: Identity;
  expectedMoney: Money;
  purpose: ProviderReadPurpose;
} & (
  | { kind: "succeeded" | "failed" | "pending"; observedMoney: Money; providerOccurredAt: string | null;
      refusal?: PaymentRefusalEnvelope; handoff?: PaymentMethodHandoff }
  | { kind: "unknown"; reason: "timeout" | "truncated" | "indeterminate" }
  | { kind: "absent"; evidence: Extract<PaymentAbsenceEnvelope, { kind: "absent" }>["evidence"] }
  | { kind: "unsupported" }
);
