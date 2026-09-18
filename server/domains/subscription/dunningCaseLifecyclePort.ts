// The four writes that move a dunning CASE, as one neutral port.
//
// The dispatch worker owns the notice; nothing owned the case itself. Opening
// it, advancing it after another refusal, closing it when the money finally
// moves and issuing the repair link were each buried in a different composition,
// which is why a second runtime could hold the notices and still not run the
// lifecycle.
//
// The ladder is NOT here. `nextRetryAt` arrives already computed from the one
// canonical cadence, and `null` IS the terminating answer: an implementation
// that receives it must expire the case and pause the subscription rather than
// invent one more slot. Keeping the decision on the caller's side is what stops
// a second copy of the schedule from growing inside a store.

/** Why a case write could not be applied, in vocabulary that names no vendor. */
export type DunningCaseRefusalCode =
  /** The case is no longer open, so this transition has nothing to move. */
  | "case_not_open"
  /** No still-unpaid order stands behind this case, so no repair link exists. */
  | "recoverable_order_unavailable";

export interface DunningCaseOpened {
  caseId: string;
  caseStatus: string;
  /** True when this key had already been accepted; nothing was queued again. */
  replayed: boolean;
  notificationId: string | null;
}

export interface DunningCaseAdvanced {
  caseId: string;
  caseStatus: string;
  notificationId: string | null;
  retryAttempt: number | null;
  /** True when the ladder ended here and the subscription was paused. */
  paused: boolean;
  pauseWindowId: string | null;
  /** True when the case can accept no further attempt. */
  terminal: boolean;
}

export type DunningCaseRecovered =
  | { outcome: "recovered"; caseId: string; caseStatus: string; replayed: boolean; notificationId: string | null }
  | { outcome: "refused"; caseId: string; caseStatus: string; refusalCode: DunningCaseRefusalCode };

export type DunningRecoveryLinkIssued =
  | { outcome: "issued"; orderId: string }
  | { outcome: "refused"; refusalCode: DunningCaseRefusalCode };

export interface DunningCaseOpenInput {
  idempotencyKey: string;
  subscriptionId: string;
  cycleId: string | null;
  clientId: string;
  retryAttempt: number;
  /** Already computed by the canonical ladder; `null` opens an exhausted case. */
  nextRetryAt: string | null;
  failureClass: string | null;
  failureReason: string | null;
  occurredAt: string;
  amountMinor: number | null;
  currency: string | null;
  templateSlug: string;
  recoveryUrlPath: string | null;
}

export interface DunningCaseFailureInput {
  caseId: string;
  occurredAt: string;
  failureClass: string | null;
  failureReason: string | null;
  retryAttempt: number;
  /** `null` terminates the ladder: expire the case and pause the subscription. */
  nextRetryAt: string | null;
  templateSlug: string;
  recoveryUrlPath: string | null;
}

export interface DunningCaseLifecyclePort {
  openCase(input: DunningCaseOpenInput): Promise<DunningCaseOpened>;
  recordFailedAttempt(input: DunningCaseFailureInput): Promise<DunningCaseAdvanced>;
  recordRecovery(input: {
    caseId: string;
    recoveredAt: string;
    templateSlug: string;
  }): Promise<DunningCaseRecovered>;
  issueRecoveryLink(input: {
    caseId: string;
    tokenHash: string;
    expiresAt: string;
  }): Promise<DunningRecoveryLinkIssued>;
}
