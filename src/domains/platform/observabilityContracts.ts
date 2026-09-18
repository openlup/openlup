import type { OmniPackFulfillmentHealthSnapshot } from "./omnipackFulfillmentHealthContracts.js";
import type { SubscriptionExceptionEvidence } from "./subscriptionObservabilityContracts.js";
import type {
  JobControlSnapshot,
  JobRunSnapshot,
  RuntimeFlagName,
} from "./jobObservabilityContracts.js";
export type {
  JobCatalogEntry,
  JobControlSnapshot,
  JobRunSnapshot,
  NoLedgerJobException,
  RuntimeFlagName,
} from "./jobObservabilityContracts.js";
export type {
  SubscriptionDueCycleWithoutOrderEvidence,
  SubscriptionExceptionEvidence,
  SubscriptionExceptionSnapshotSummary,
  SubscriptionExceptionTriageContext,
  SubscriptionFulfillmentEligibilityReason,
  SubscriptionFulfillmentRecoveryPosture,
  SubscriptionPaidRenewalWithoutFulfillmentEvidence,
} from "./subscriptionObservabilityContracts.js";

export const ALERT_SEVERITIES = ["p0", "p1", "p2", "p3"] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];
export const ALERT_CHANNELS = ["webhook", "resend"] as const;
export type AlertChannel = (typeof ALERT_CHANNELS)[number];

export type QueueHealthSnapshot = {
  queueName: string;
  jobName?: string;
  queuedCount: number;
  oldestQueuedAt: string | null;
  failedCount: number;
  skippedCount: number;
  criticalFailedCount?: number;
  criticalSkippedCount?: number;
};

export type RecipientHealthSnapshot = {
  notificationType: string;
  activeCount: number;
  requiredWhenFlag?: RuntimeFlagName;
};

export type DunningHealthSnapshot = {
  overdueRetryCount: number;
  expiredWithoutCustomerNoticeCount: number;
  failureWithoutAdminAlertCount: number;
  failedAdminNotificationCount: number;
  skippedAdminNotificationCount: number;
  expiredCount24h: number;
  recoveredCount24h: number;
};

export type SubscriptionDeliveryAlignmentOverdueEvidence = {
  subscriptionId: string; nextCycleAt: string; ageSeconds: number;
};

export type SubscriptionHealthSnapshot = {
  dueCycleWithoutOrderCount: number;
  // Pageable escalation of dueCycleWithoutOrderCount, on the same rows: real
  // (non-fixture) subscriptions more than 6h past their due date with no charge
  // attempt at all, plus the oldest of them so the page names its subjects.
  // Both optional so older fixtures stay valid.
  dueCycleUnattemptedCount?: number;
  dueCycleUnattemptedEvidence?: SubscriptionDeliveryAlignmentOverdueEvidence[];
  upcomingDeliveryReminderMissingCount: number;
  paidRenewalWithoutFulfillmentCount?: number;
  // Active subscriptions with no chargeable payment_method_ref (the renewal
  // due-RPC's mandate condition) — the early-warning form of
  // dueCycleWithoutOrderCount. Optional so older fixtures stay valid.
  activeWithoutPaymentMethodCount?: number;
  // Subscriptions stuck in pending_activation well past the activation payment
  // window — ghosts that accumulate exactly when the activation sweep is
  // disabled or not firing, so the alert is flag-independent.
  pendingActivationOverdueCount?: number;
  // Active subscriptions with zero subscription_lines rows — a recurring order
  // with nothing to ship or charge. The 20260801120100 trigger makes this
  // unreachable through any UPDATE, so a non-zero count means a writer got
  // around the table-boundary guard. Optional so older fixtures stay valid.
  zeroLineActiveCount?: number;
  // Cycles the renewal lane is skipping behind a LIVE quarantine window after
  // three identical row failures — rows that are quiet right now, not rows that
  // once failed. Optional so older fixtures stay valid.
  renewalRowQuarantinedCount?: number;
  // Open delivery-protection cases still unresolved 24h after the observed
  // renewal boundary. Optional so older snapshot fixtures remain valid.
  deliveryAlignmentOverdueCount?: number;
  // Oldest distinct overdue subjects, bounded by the collector. This keeps the
  // full count honest while making one deduped alert actionable.
  deliveryAlignmentOverdueEvidence?: SubscriptionDeliveryAlignmentOverdueEvidence[];
  // Active subscriptions whose stored mandate declares an autopayment model
  // that cannot be charged unattended — renewals that are already certain to be
  // refused on their due date, counted before that date arrives. Distinct from
  // activeWithoutPaymentMethodCount: these HAVE an active method, and every
  // other check passes. Optional so older fixtures stay valid.
  methodHealthUnchargeableCount?: number;
  // Activation gaps NOT already owned by the narrow paid-activation detector
  // behind pendingActivationOverdueCount. The complement is deliberate: the
  // rows that detector matches are subtracted, so one root cause cannot raise
  // two pagers. Optional so older fixtures stay valid.
  methodHealthActivationGapCount?: number;
  // The subset of the above that has been waiting more than 72 hours. An
  // ESCALATION of the p2, never a replacement: the p2 keeps counting presence.
  methodHealthActivationGapOverdueCount?: number;
  evidence?: SubscriptionExceptionEvidence[];
};

export type EmailHealthSnapshot = {
  criticalFailedCount: number;
  failedBySource: Record<string, number>;
  customerTimelineFailedCount: number;
  customerTimelineMissedCount: number;
  customerTimelineOverdueCount: number;
  failedByPurpose: Record<string, number>;
  auditIncompleteCount: number;
  previewProductionDomainLinkCount: number;
  webhookGapCount: number;
  communicationOutboxFailedCount: number;
  // Highest number of SENT deliveries to any single recipient in the window — the
  // signal that catches a per-recipient flood/loop. Optional so existing snapshot
  // fixtures stay valid; absent ⇒ treated as 0 by the evaluator.
  maxSendsPerRecipient?: number;
  // Customer emails settled WITHOUT sending: `status='processed'` carrying
  // `metadata.skipped`. Invisible to every other counter here, since the
  // failed/due queries read only pending/failed/processing — which is how a
  // lost decline notice went unnoticed on 2026-08-20. Absent ⇒ 0.
  customerNoticeSkippedCount?: number;
  // Same population by `metadata.skipped`. The reason is what separates a
  // correct silence (`order_already_paid`) from a defect.
  skippedByReason?: Record<string, number>;
};

export type PaymentEvidenceKind =
  | "provider_paid_local_unpaid"
  | "local_paid_provider_unpaid"
  | "prepared_without_provider_ack"
  | "webhook_missing"
  | "stuck_processing"
  // A payment the reconciler settled because nobody ever tried to pay it, and an
  // unpaid order that outlived the 24h recovery rail (26h). Both
  // flag-independent; the first counts a durable outcome, never an age.
  | "abandoned_before_confirmation" | "pending_payment_past_recovery_window"
  | "amount_currency_mismatch"
  | "signature_failure"
  | "recovery_missing";

export type PaymentMismatchEvidence = {
  kind: PaymentEvidenceKind;
  provider?: string | null;
  paymentIntentId?: string | null;
  paymentAttemptId?: string | null;
  orderId?: string | null;
  subscriptionId?: string | null;
  subscriptionCycleId?: string | null;
  providerPaymentId?: string | null;
  providerEventId?: string | null;
  ageSeconds?: number;
  owner?: "commerce/payment";
  customerSafeStatus?: "operator_review_required";
  operatorNextAction?: "inspect_provider_before_retry";
  reason: string;
  observedAt: string;
};

export type PaymentHealthSnapshot = {
  providerPaidLocalUnpaidCount: number;
  localPaidProviderUnpaidCount: number;
  preparedWithoutProviderAckCount?: number;
  webhookMissingCount: number;
  stuckProcessingCount: number;
  amountCurrencyMismatchCount: number;
  signatureFailureCount: number;
  recoveryRequiredWithoutLinkCount: number;
  evidence: PaymentMismatchEvidence[];
  // Checkout payment-window inventory holds left `reserved` well past their
  // `expires_at` — the data-level signature of a stalled/disabled
  // commerce-reservation-sweep. While these hold, the order stays in
  // `pending_payment` and never reaches `expired`, so its payment-failed
  // recovery email never fires and the stock stays locked. Flag-independent on
  // purpose: a leaked hold is bad regardless of which gate is misconfigured.
  // Optional so existing snapshot literals stay valid; absent means 0.
  leakedCheckoutReservationCount?: number;
  // Sibling of the above for `subscription_retry_window` holds. Remediation is
  // release-only: the owning subscription stays active and its dunning case
  // stays open — a naive sweep that cancels either would break live renewals.
  leakedSubscriptionRetryReservationCount?: number;
  // Materialized inventory_balances.reserved minus the summed quantity of live
  // `reserved` leases, per (sku, location, lot). Positive drift inflates the
  // ATP read-model (onHand - reserved - unavailable - safetyStock) and shows as
  // false sold-out even while runtime availability stays correct.
  reservedBalanceDriftCount?: number;
  reservedBalanceDriftEvidence?: ReservedBalanceDriftEvidence[];
};

export type ReservedBalanceDriftEvidence = {
  skuId: string; locationId: string; lotKey: string | null;
  balanceReserved: number; activeReserved: number; drift: number;
};

export type AccountingHealthSnapshot = {
  shippedWithoutInvoiceCount: number;
  missingInvoiceHandoffs: AccountingMissingInvoiceHandoffEvidence[];
  issueRequestedCount?: number;
  providerCreatedCount?: number;
  pendingOutboxCount: number;
  failedOutboxCount: number;
  failedCorrectionOutboxCount: number;
  deliveryPendingCount?: number;
  deliveryFailedCount?: number;
  b2bWaitingKsefCount?: number;
  ksefPendingTooLongCount: number;
  ksefRejectedCount: number;
  correctionKsefPendingTooLongCount: number;
  correctionKsefRejectedCount: number;
  b2cEmailFailedCount: number;
  blockedInvoiceCount?: number;
  invalidTaxIdBlockedCount?: number;
  // Provider invoice exists but the customer email is not `sent` >24h later —
  // the end-to-end customer-receipt boundary (Wave 7). Optional for fixtures.
  issuedWithoutCustomerDeliveryCount?: number;
};

export type AccountingMissingInvoiceHandoffEvidence = {
  kind: "handoff_missing_invoice_request";
  fulfillmentOrderId: string;
  orderId: string;
  status: string;
  handedOverAt: string;
  ageSeconds: number;
  reason: "no_accounting_invoice_for_fulfillment_handoff";
  recoveryAction: "replay_accounting_invoice_issue_request_from_handoff";
  observedAt: string;
};

export type OmniPackHealthSnapshot = {
  dispatchFailureCount: number;
  paidOrderMissingDispatchRefCount?: number;
  wrongFulfillmentProviderCount?: number;
  staleDispatchRefCount?: number;
  missingProviderOrderIdCount?: number;
  payloadMismatchCount?: number;
  staleStockSyncCount: number;
  actionableShortageEvidenceCount: number;
  reservationCoverageCount?: number;
  reservationCoverageEvidence?: OmniPackReservationCoverageEvidence[];
  unknownStockSkuCount?: number;
  // Historical only; active alerting no longer compares provider stock with its local mirror.
  providerLowerMismatchCount?: number;
  providerHigherMismatchCount?: number;
  // Unmatched inbound events in the last 24h; older rows remain audit-only.
  recentQuarantinedInboundCount: number;
  reconciliationStateConflictCount?: number;
  // Fulfillment orders stuck in a mid-pipeline status (packed/label_pending)
  // past the frozen SLA with no update — the signature of picking/shipping
  // webhooks not arriving AND the reconciliation fallback not advancing them.
  // Flag-independent (a paid order stuck in fulfillment is a data-integrity
  // problem regardless of which observability gate is on). Optional so older
  // fixtures stay valid.
  frozenFulfillmentCount?: number;
  // `label_created` held separately from frozenFulfillmentCount because it needs
  // a much longer SLA, not because it is a different kind of failure: the label
  // exists but the carrier has not collected. A label minted Friday 18:00 is not
  // collected until Monday ~09:00 (~63h), so reusing the 6h frozen cutoff here
  // would fire every weekend.
  frozenLabelCreatedCount?: number;
  // Fulfillments the provider reported as shipped while `shipment_external_refs`
  // stayed empty. The dispatched-email trigger RETURNs when there is no active
  // ref (20260711170013_*.sql), so no outbox row and therefore no planned
  // communication_email_deliveries row is ever written — meaning
  // customer_email_delivery_missed cannot fire for this case by construction.
  // The customer sees "W drodze" with no email and no tracking link.
  handedOverWithoutTrackingRefCount?: number;
  latestStatusEvidenceAt: string | null;
  latestStockSyncAt: string | null;
} & OmniPackFulfillmentHealthSnapshot;

export type OmniPackReservationCoverageEvidence = {
  sku: string;
  providerForSaleQuantity: number | null;
  localAvailableQuantity: number | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
};

export type ObservabilitySnapshot = {
  checkedAt: string;
  runtimeFlags: Partial<Record<RuntimeFlagName, boolean>>;
  jobControls: JobControlSnapshot[];
  recentJobRuns: JobRunSnapshot[];
  queues: QueueHealthSnapshot[];
  recipients: RecipientHealthSnapshot[];
  dunning: DunningHealthSnapshot;
  subscriptions: SubscriptionHealthSnapshot;
  emails: EmailHealthSnapshot;
  payments: PaymentHealthSnapshot;
  accounting: AccountingHealthSnapshot;
  omnipack: OmniPackHealthSnapshot;
  orderMoneyReconciliation?: import("./orderMoneyReconciliationContracts.js").OrderMoneyReconciliationSnapshot;
  promotionHealth?: import("./promotionObservabilityEvaluator.js").PromotionHealthSnapshot;
};

export type AlertDecision = {
  dedupeKey: string;
  severity: AlertSeverity;
  owner: string;
  runbookUrl: string;
  title: string;
  message: string; humanContext?: import("./alertHumanContext.js").AlertHumanContext;
  channels: AlertChannel[];
  payload: Record<string, unknown>; paging?: "default" | "never";
};

export type OpenAlert = {
  id: string;
  dedupeKey: string;
  status: "open" | "acknowledged";
  severity: AlertSeverity;
  lastNotifiedAt: string | null;
  /** Most recent watchdog delivery decision, including skipped/failed attempts. */
  lastNotificationAttemptAt?: string | null;
  lastNotificationStatus?: AlertNotificationOutcome["status"] | null;
  /** Earliest time the watchdog may create another delivery-attempt ledger row. */
  nextNotificationAttemptAt?: string | null;
  /** Consecutive failed webhook attempts; reset by sent/skipped outcomes. */
  notificationFailureCount?: number;
  /** Operator silence window; when set and in the future, paging is suppressed. */
  snoozedUntil?: string | null;
};

export type AlertNotificationOutcome = {
  channel: AlertChannel;
  status: "sent" | "failed" | "skipped";
  provider?: string | null;
  providerResponse?: Record<string, unknown> | null;
  error?: string | null;
};
