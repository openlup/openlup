export type SubscriptionExceptionSnapshotSummary = {
  status: string | null;
  scheduledAt: string | null;
  nextCycleAt: string | null;
  templateVersion: number | null;
  lineCount: number | null;
  totalQuantity: number | null;
};

export type SubscriptionFulfillmentRecoveryPosture =
  | "wait_for_outbox"
  | "existing_outbox_replay_required"
  | "manual_review"
  | "not_retryable";

export type SubscriptionFulfillmentEligibilityReason =
  | "cycle_order_missing"
  | "payment_provider_ack_missing"
  | "paid_cycle_order_without_fulfillment"
  | "local_payment_not_succeeded"
  | "subscription_cycle_not_paid"
  | "order_paid_outbox_missing"
  | "order_paid_outbox_pending"
  | "order_paid_outbox_failed_retrying"
  | "order_paid_outbox_discarded"
  | "order_paid_outbox_processed_without_fulfillment";

export type SubscriptionExceptionTriageContext = {
  localPaymentStatus: string | null;
  subscriptionCycleStatus: string | null;
  orderStatus: string | null;
  outboxStatus: string | null;
  outboxAvailableAt: string | null;
  outboxAttempts: number | null;
  fulfillmentEligibilityReason: SubscriptionFulfillmentEligibilityReason;
  fulfillmentRecoveryPosture: SubscriptionFulfillmentRecoveryPosture;
  lockedCycleSummary: SubscriptionExceptionSnapshotSummary | null;
  futureTemplateSummary: SubscriptionExceptionSnapshotSummary | null;
};

export type SubscriptionDueCycleWithoutOrderEvidence = {
  kind: "due_cycle_without_order";
  subscriptionId: string;
  nextCycleAt: string;
  reason: "active_subscription_due_without_order_evidence";
  ageSeconds: number;
  owner: "commerce/subscription-support";
  customerSafeStatus: "operator_review_required";
  operatorNextAction: "inspect_subscription_scheduler";
  observedAt: string;
  triageContext: SubscriptionExceptionTriageContext;
};

export type SubscriptionPaidRenewalWithoutFulfillmentEvidence = {
  kind: "paid_renewal_without_fulfillment";
  subscriptionId: string;
  subscriptionCycleId: string;
  orderId: string;
  reason: string;
  ageSeconds: number;
  owner: "commerce/fulfillment";
  customerSafeStatus: "paid_fulfillment_pending";
  operatorNextAction: "inspect_fulfillment_dispatch";
  observedAt: string;
  triageContext: SubscriptionExceptionTriageContext;
};

export type SubscriptionExceptionEvidence =
  | SubscriptionDueCycleWithoutOrderEvidence
  | SubscriptionPaidRenewalWithoutFulfillmentEvidence;
