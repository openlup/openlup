import type { AlertChannel, AlertSeverity } from "./observabilityContracts.js";

export type RuntimeFlagName =
  | "CHANNEL_ORDER_PULL_ENABLED"
  | "COMMERCE_ABANDONED_CART_ENABLED"
  | "COMMERCE_CHECKOUT_RECOVERY_ENABLED"
  | "COMMERCE_ACCOUNTING_OBSERVABILITY_ENABLED"
  | "COMMERCE_CUSTOMER_DIAGNOSTIC_PRUNE_ENABLED"
  | "COMMERCE_DHL_ONLY_DELIVERY"
  | "COMMERCE_DUNNING_EMAILS_ENABLED"
  | "COMMERCE_OMNIPACK_OBSERVABILITY_ENABLED"
  | "COMMERCE_OUTBOX_DISPATCH_ENABLED"
  | "COMMERCE_OUTBOX_PRUNE_ENABLED"
  | "COMMERCE_PAYMENT_EVENT_SWEEP_ENABLED"
  | "COMMERCE_PROMOTION_CLAIM_SWEEP_ENABLED"
  | "COMMERCE_PSP_OBSERVABILITY_ENABLED"
  | "COMMERCE_REORDER_REMINDER_ENABLED"
  | "COMMERCE_REVIEW_REQUEST_ENABLED"
  | "COMMERCE_RESEND_DELIVERY_RECONCILIATION_ENABLED"
  | "COMMERCE_RESERVATION_AUTO_EXPIRY_ENABLED"
  | "COMMERCE_RESERVATION_SWEEP_ENABLED"
  | "COMMERCE_SUBSCRIPTION_RENEWAL_RUNTIME_ENABLED"
  | "COMMERCE_SUBSCRIPTION_SWEEP_ENABLED"
  | "COMMERCE_SUBSCRIPTION_DELIVERY_REMINDERS_ENABLED"
  | "COMMERCE_SUBSCRIPTION_PAUSE_REMINDERS_ENABLED"
  | "COMMERCE_SUBSCRIPTION_WINBACK_ENABLED"
  | "COMMUNICATION_SYNC_DISPATCH_ENABLED"
  | "COMMUNICATION_SYNC_RECONCILE_ENABLED"
  | "SUBSCRIPTION_RENEWAL_REMINDER_ENABLED";

export type JobCatalogEntry = {
  jobName: string;
  owner: string;
  severity: AlertSeverity;
  monitoringState?: "active" | "legacy_out_of_scope";
  evidenceModel?: "ledger" | "effect_only";
  expectedEverySeconds?: number;
  startGraceSeconds: number;
  finishGraceSeconds: number;
  queueBacklogGraceSeconds?: number;
  runbookUrl: string;
  alertChannels: AlertChannel[];
  requiresFlag?: RuntimeFlagName;
};

export type NoLedgerJobException = {
  id: string;
  path: string;
  reason: string;
  evidence: string;
};

export type JobControlSnapshot = {
  jobName: string;
  enabled: boolean;
  lastSuccessAt: string | null;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastStatus: "running" | "success" | "failed" | "skipped" | string | null;
  leaseUntil: string | null;
};

export type JobRunSnapshot = {
  jobName: string;
  status: "running" | "success" | "failed" | "skipped" | string;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  supportCode: string | null;
};
