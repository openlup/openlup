export interface DunningCaseOpenInput {
  idempotencyKey: string; subscriptionId: string; cycleId: string | null; clientId: string;
  retryAttempt: number; nextRetryAt: string | null; failureClass: string | null;
  failureReason: string | null; occurredAt: string; amountMinor: number | null;
  currency: string | null; templateSlug: string; recoveryUrlPath: string | null;
}
export interface DunningCaseOpened {
  caseId: string; caseStatus: string; replayed: boolean; notificationId: string | null;
}
export interface DunningCaseAdvanced {
  caseId: string; caseStatus: string; notificationId: string | null;
  retryAttempt: number | null; paused: false; pauseWindowId: null; terminal: boolean;
}
export type DunningRefusalCode = "case_not_open" | "recoverable_order_unavailable";
export interface DunningCaseLifecyclePort {
  openCase(input: DunningCaseOpenInput): Promise<DunningCaseOpened>;
  recordFailedAttempt(input: { caseId: string; occurredAt: string; failureClass: string | null; failureReason: string | null; retryAttempt: number; nextRetryAt: string | null; templateSlug: string; recoveryUrlPath: string | null }): Promise<DunningCaseAdvanced>;
  recordRecovery(input: { caseId: string; recoveredAt: string; templateSlug: string }): Promise<
    | { outcome: "recovered"; caseId: string; caseStatus: string; replayed: boolean; notificationId: string | null }
    | { outcome: "refused"; caseId: string; caseStatus: string; refusalCode: DunningRefusalCode }>;
  issueRecoveryLink(input: { caseId: string; tokenHash: string; expiresAt: string }): Promise<
    | { outcome: "issued"; orderId: string }
    | { outcome: "refused"; refusalCode: DunningRefusalCode }>;
}
export interface RenewalRetryState {
  rowPresent: boolean; retryAttempt: number | null; nextRetryAt: string | null;
}
export interface RenewalRetryObligation {
  operationId: string; subscriptionId: string; cycleId: string; orderId: string;
  settlementIntentId: string; logicalCycleNumber: number; nativeRenewalCounter: number;
  retryAttempt: number; externalAttemptSequence: number; nextRetryAt: string | null;
  failureClass: string | null; failureReason: string | null; occurredAt: string;
  identityKey: string; requestFingerprint: string;
  disposition: "retry_scheduled" | "payment_failed" | "paid";
}
export interface RenewalRecoveryAuthorization {
  tokenId: string; tokenHash: string; caseId: string; clientId: string;
  authUserId: string | null; subscriptionId: string; cycleId: string; orderId: string;
  payerAccountRef: string | null; purpose: "repair_payment" | "resume_subscription";
  retryAttempt: number; paymentMethodRef: string; paymentMethodKind: string;
  expiresAt: string; usedAt: string | null; revokedAt: string | null; requestedAt: string;
}
export interface RenewalFailureHandoffPort {
  handoffFailure(input: { idempotencyKey: string; subscriptionId: string; clientId: string;
    cycleId: string; orderId: string; paymentIntentId: string; retryAttempt: number;
    failureClass: string; failureReason: string; nextRetryAt: string | null;
    occurredAt: string; amountMinor: number | null; currency: string | null }): Promise<{ caseId: string | null; replayed: boolean }>;
}
