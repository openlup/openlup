import type { PaymentMethodLifecycleEvent } from "@openlup/core/payment";
import type { PaymentMethodHandoff, PaymentRefusalEnvelope } from "./adapter.js";

/** Configured integer-minor money; currency bytes pass through unchanged. */
export type PaymentMoney = { amountMinor: number; currency: string };
/** Exact attempt identity for readback, close and absence lookups. */
export type PaymentAttemptIdentity = {
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
  /** Adapter-filtered provider facts for host audit/repair readers. Never raw bodies,
   * transient secrets, handoffs or customer authorization; excluded from identity/fingerprint.
   * Typed evidence takes precedence over overlapping audit facts. */
  providerAuditPayload?: Readonly<Record<string, unknown>>;
};

/** Original payment money and stable operation identity accompany every reversal. */
export type PaymentRefundObservation = {
  operationId: string;
  originalPaymentMoney: PaymentMoney;
} & (
  | { kind: "cumulative-snapshot"; refundedMoney: PaymentMoney }
  | { kind: "event-delta"; refundedMoney: PaymentMoney }
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
  outcome: "succeeded" | "failed" | "pending" | "refunded" | "disputed";
  money: PaymentMoney | null;
  refusal?: PaymentRefusalEnvelope;
  refund?: PaymentRefundObservation;
};

/**
 * Method lifecycle facts, separate from the money-outcome union; setup is never money success.
 * Outcomes follow the core method lifecycle kinds plus setup failure and required customer action.
 */
export type VerifiedMethodEvidence = VerifiedIdentity & {
  kind: "method";
  outcome: "registered" | "updated" | "revoked" | "expired" | "suspended" | "failed" | "requires-action";
  methodLifecycle?: PaymentMethodLifecycleEvent;
  /** Registration facts only. The host resolves client/subscription ownership. */
  reusableMethod?: {
    providerCustomerRef?: string | null;
    providerMethodRef: string;
    providerMandateRef?: string | null;
    methodKind: string;
    status: "pending_verification" | "active" | "inactive" | "expired" | "revoked";
  };
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
  identity: PaymentAttemptIdentity;
  expectedMoney: PaymentMoney;
} & (
  | { kind: "absent"; evidence: { exact: true; complete: true; lookupReference: string } }
  | { kind: "unknown"; reason: "timeout" | "truncated" | "indeterminate" }
  | { kind: "unsupported" }
);

/** Unknown is neither absence nor unsupported. Timeout/truncation stays unknown. */
export type PaymentReadbackEnvelope = {
  identity: PaymentAttemptIdentity;
  expectedMoney: PaymentMoney;
  purpose: ProviderReadPurpose;
} & (
  | { kind: "succeeded" | "failed" | "pending"; observedMoney: PaymentMoney; providerOccurredAt: string | null;
      refusal?: PaymentRefusalEnvelope; handoff?: PaymentMethodHandoff }
  | { kind: "unknown"; reason: "timeout" | "truncated" | "indeterminate" }
  | { kind: "absent"; evidence: Extract<PaymentAbsenceEnvelope, { kind: "absent" }>["evidence"] }
  | { kind: "unsupported" }
);

/** Exact readback of one attempt; a browser return or provider silence is never money truth. */
export interface PaymentReadbackPort {
  readPayment(input: {
    identity: PaymentAttemptIdentity;
    expectedMoney: PaymentMoney;
    purpose: ProviderReadPurpose;
  }): Promise<PaymentReadbackEnvelope>;
  /** Present only when capabilities declare close supported; returns the post-close readback. */
  close?(input: {
    identity: PaymentAttemptIdentity;
    expectedMoney: PaymentMoney;
    purpose: ProviderReadPurpose;
  }): Promise<PaymentReadbackEnvelope>;
}

/** Present only when capabilities declare exact absence supported. */
export interface PaymentAbsencePort {
  proveAbsence(input: {
    identity: PaymentAttemptIdentity;
    expectedMoney: PaymentMoney;
  }): Promise<PaymentAbsenceEnvelope>;
}

/** Transport-neutral acknowledgement; hosts write their own HTTP response. */
export interface PaymentIngressPort {
  receive(input: Parameters<PaymentVerifyNormalizePort["verifyAndNormalize"]>[0]): Promise<{
    status: 200 | 400 | 409 | 503;
    data: Record<string, unknown>;
  }>;
}
