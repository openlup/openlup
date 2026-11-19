import type {
  ProviderReadPurpose,
  ProviderReconciliationStatusKind,
  SilenceWindowLookup,
} from "@openlup/platform/payments/contracts";

export type {
  PaymentProviderReconciliationWorkerResult,
  ProviderReadPurpose,
  ProviderReconciliationStatusKind,
  SilenceWindowLookup,
} from "@openlup/platform/payments/contracts";

export type ReconciliationProviderKind = "stripe" | "tpay";

export interface ProviderReconciliationStatus {
  status: ProviderReconciliationStatusKind;
  providerStatus: string;
  occurredAt: string | null;
  failureReason: string | null;
  amountMinor: number | null;
  currency: string | null;
  rawPayload: Record<string, unknown>;
}

export interface PaymentProviderReconciliationProvider {
  /** An omitted purpose selects reconciliation readback. Checkout selects its own purpose. */
  readPayment(input: {
    providerPaymentId: string;
    attempt?: ClaimedPaymentAttempt;
    purpose?: ProviderReadPurpose;
  }): Promise<ProviderReconciliationStatus>;
  /** Atomically close an incomplete provider object before minting a replacement. */
  closePayment?(input: { providerPaymentId: string }): Promise<ProviderReconciliationStatus>;
  /**
   * Genuine provider-side absence probe for a prepared attempt that never
   * recorded a provider payment id. "absent" means the provider has NO payment
   * object correlated to our local payment intent (e.g. Stripe metadata
   * search), so the crash-after-charge window is ruled out and the prepared
   * attempt can be reopened safely. Optional: providers that cannot prove
   * absence (Tpay has no intent-correlated lookup) leave this undefined and
   * stay operator-manual.
   */
  findPaymentByLocalIntent?(input: {
    attempt: ClaimedPaymentAttempt;
  }): Promise<"found" | "absent">;
}

export interface ClaimedPaymentAttempt {
  paymentAttemptId: string;
  paymentIntentId: string;
  paymentId: string;
  orderId: string;
  subscriptionId: string | null;
  subscriptionCycleId: string | null;
  provider: ReconciliationProviderKind;
  providerPaymentId: string | null;
  providerAttemptId: string | null;
  providerSessionId: string | null;
  attemptStatus: string;
  intentStatus: string;
  amountMinor: number;
  currency: string;
  orderMode: "one_time" | "subscription_cycle";
  cycleRetryAttempt: number;
  cycleNextRetryAt: string | null;
  localUpdatedAt: string;
}

/**
 * The manual rail deliberately carries only enumerated proof facts. Operator
 * notes, provider prose, customer/payment references, tokens, PAYIDs and BLIK
 * material must never cross this boundary; the linked rows carry identity.
 */
export type ManualInteractivePreparedAttemptAbsenceEvidence = {
  providerAbsenceConfirmed: true;
  watchdogEvidence: true;
  evidenceCode: "operator_verified_absence" | "operator_documented_absence";
};

export interface InteractivePreparedAttemptReopenResult {
  paymentAttemptId: string;
  paymentIntentId: string;
  paymentAttemptStatus: "failed";
  paymentIntentStatus: "failed";
  replayed: boolean;
}

export interface PaymentProviderReconciliationPort {
  claimPreparedAttempts(input: {
    now: string;
    staleAfterSeconds: number;
    limit: number;
    claimKey: string;
  }): Promise<ClaimedPaymentAttempt[]>;
  claimStaleAttempts(input: {
    now: string;
    staleAfterSeconds: number;
    limit: number;
    claimKey: string;
  }): Promise<ClaimedPaymentAttempt[]>;
  recordEvidence(input: {
    idempotencyKey: string;
    provider: ReconciliationProviderKind;
    providerPaymentId: string | null;
    paymentIntentId: string;
    paymentAttemptId: string;
    localStatus: string;
    providerStatus: string;
    correctionStatus: "observed" | "corrected" | "ignored" | "failed";
    checkedAt: string;
    payload: Record<string, unknown>;
  }): Promise<{ replayed: boolean }>;
  applyTerminalResult(input: {
    idempotencyKey: string;
    expectedOrderId: string;
    expectedPaymentIntentId: string;
    expectedPaymentAttemptId: string;
    expectedPaymentId: string;
    provider: ReconciliationProviderKind;
    providerPaymentId: string;
    localStatus: string;
    providerStatus: string;
    resultStatus: "succeeded" | "failed";
    occurredAt: string;
    failureReason: string | null;
    /**
     * The class the reading adapter already decided for this refusal, persisted
     * beside the refusal itself on both the attempt and the dunning case the
     * terminal write opens.
     *
     * OPTIONAL, and absence is a real state rather than a default: a caller that
     * omits it writes exactly what it wrote before this field existed, because
     * the RPC coalesces it to NULL and the SQL treats a NULL class as "stamp
     * nothing" rather than "stamp NULL". Two of this port's three consumers
     * (`paymentVerifyNowService`, `checkoutRecoveryPaymentResolver`) resolve a
     * payment without classifying it and are pinned to stay classification-absent.
     *
     * Shape mirrors `applyPaymentResultRpc` deliberately, so the synchronous
     * decline rail and this polling rail hand the control plane the same object.
     */
    failureClassification?: { failureClass: string; decidedBy: string } | null;
    checkedAt: string;
    payload: Record<string, unknown>;
  }): Promise<{
    replayed: boolean;
    paymentResult: {
      paymentIntentId: string;
      paymentAttemptId: string;
      paymentId: string;
      orderId: string;
      status: string;
      kind: string;
      replayed: boolean;
    };
    correctionStatus: "corrected" | "ignored";
    subscriptionWebhookDunning: {
      opened: boolean;
      replayed: boolean;
      caseId: string | null;
    } | null;
  }>;
  reopenPreparedAttemptAfterAbsence(input: {
    idempotencyKey: string;
    paymentAttemptId: string;
    expectedPaymentIntentId: string;
    expectedSubscriptionCycleId: string;
    operatorRef: string;
    absenceCheckedAt: string;
    nextRetryAt: string;
    absenceEvidence: Record<string, unknown>;
  }): Promise<{ replayed: boolean }>;
  /**
   * Optional because the automatic reconciliation worker and its provider
   * neutral fixtures must not acquire an operator-only interactive capability.
   * A caller that selects this rail must require the narrow interface below.
   */
  reopenInteractivePreparedAttemptAfterAbsence?(input: {
    idempotencyKey: string;
    paymentAttemptId: string;
    expectedPaymentIntentId: string;
    expectedOrderId: string;
    expectedSubscriptionId: string | null;
    expectedSubscriptionCycleId: string | null;
    operatorRef: string;
    absenceCheckedAt: string;
    absenceEvidence: ManualInteractivePreparedAttemptAbsenceEvidence;
  }): Promise<InteractivePreparedAttemptReopenResult>;
}

/**
 * Service-role operator boundary for an interactive checkout, distinct from
 * the renewal retry RPC. It terminalizes the local prepared attempt after a
 * human/provider absence confirmation; it never schedules dunning or cron.
 */
export interface InteractivePreparedAttemptManualReconciliationPort extends PaymentProviderReconciliationPort {
  reopenInteractivePreparedAttemptAfterAbsence(input: {
    idempotencyKey: string;
    paymentAttemptId: string;
    expectedPaymentIntentId: string;
    expectedOrderId: string;
    expectedSubscriptionId: string | null;
    expectedSubscriptionCycleId: string | null;
    operatorRef: string;
    absenceCheckedAt: string;
    absenceEvidence: ManualInteractivePreparedAttemptAbsenceEvidence;
  }): Promise<InteractivePreparedAttemptReopenResult>;
}

export interface PaymentProviderReconciliationWorkerInput {
  port: PaymentProviderReconciliationPort;
  providers: Partial<Record<ReconciliationProviderKind, PaymentProviderReconciliationProvider>>;
  now?: string;
  staleAfterSeconds?: number;
  batchSize?: number;
  claimKey?: string;
  /**
   * When true, prepared attempts whose provider proves absence (see
   * PaymentProviderReconciliationProvider.findPaymentByLocalIntent) and that
   * are at least MIN_PREPARED_ABSENCE_REOPEN_AGE_SECONDS old are automatically
   * reopened for cron retry via the operator RPC. Default false — the
   * stranded-attempt loop stays operator-manual unless the flag is on.
   */
  autoReopenPreparedAbsence?: boolean;
  /**
   * Published rail capabilities, read to learn how long a non-terminal answer
   * from each rail is still normal. Optional: without it no attempt is ever
   * counted overdue, so omitting it preserves today's behaviour exactly.
   */
  capabilities?: SilenceWindowLookup;
}
