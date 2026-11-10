import type { PaymentIngressPort } from "./evidence.js";
import type { PostgresPaymentTruthOptions } from "./truth.js";

export type SandboxPaymentOutcome = "captured" | "refused" | "expired" | "indeterminate";
/** Synthetic references only; these confer no real mandate or method-setup capability. */
export interface SandboxMethodFacts {
  authorizationRef: string;
  unattendedChargeAuthorizedAt: string;
  payerAccountRef: string | null;
  methodRef: string;
  methodEvidenceRef: string;
}
export interface SandboxPaymentObservation {
  id: string;
  eventKey: string;
  fingerprint: string;
  outcome: SandboxPaymentOutcome;
  occurredAt: string;
  recordedAt: string;
}
export interface SandboxPaymentAttempt {
  id: string;
  settlementIntentId: string;
  orderId: string;
  settlementChannelKey: "sandbox";
  orderStatus: string;
  settlementStatus: string;
  requestKey: string;
  requestFingerprint: string;
  active: boolean;
  state: "dispatched" | SandboxPaymentOutcome;
  dispatchedAt: string;
  methodFacts: SandboxMethodFacts;
  latestObservation: SandboxPaymentObservation | null;
}
export interface SandboxPaymentSimulator {
  /** A fresh row conservatively records dispatch. Replayed rows never authorize redispatch. */
  beginAttempt(input: { settlementIntentId: string; idempotencyKey: string; requestFingerprint: string;
    methodFacts?: SandboxMethodFacts;
    inlineRetry?: { orderId: string; clientId: string; expectedAttemptId: string; context: Record<string, unknown> };
    checkoutRecovery?: { orderId: string; clientId: string; recoveryTokenId: string }; at: string }): Promise<SandboxPaymentAttempt & { replayed: boolean }>;
  /** Host-authorized synthetic source. Recording alone never pays an order. */
  recordObservation(input: { attemptId: string; idempotencyKey: string; outcome: SandboxPaymentOutcome;
    occurredAt: string }): Promise<{ id: string; replayed: boolean }>;
  readAttempt(input: { settlementIntentId: string; attemptId?: string }): Promise<SandboxPaymentAttempt | null>;
  /** Original body identifies { settlementIntentId, attemptId, observationId }; no browser status is accepted. */
  ingress: PaymentIngressPort;
}
export type SandboxPaymentSimulatorOptions = PostgresPaymentTruthOptions;
