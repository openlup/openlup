import type {
  JobControlSnapshot,
  JobRunSnapshot,
  ObservabilitySnapshot,
  RuntimeFlagName,
} from "../../../../src/domains/platform/observabilityContracts.js";
import type { ObservabilityEvidencePort } from "../../../../src/domains/platform/observabilityPorts.js";
import {
  summarizePayments, type CheckoutRecoveryTokenEvidenceRow, type PaymentAttemptEvidenceRow,
  type PaymentEventEvidenceRow, type PaymentIntentEvidenceRow, type PaymentReconciliationEvidenceRow,
  type PendingPaymentOrderEvidenceRow,
} from "../../../domains/platform/paymentObservabilityEvidence.js";
import {
  summarizeAccountingEvidence,
  type AccountingDeliveryOutboxEvidenceRow,
  type AccountingCorrectionOutboxEvidenceRow,
  type AccountingInvoiceEvidenceRow,
  type AccountingInvoiceOutboxEvidenceRow,
  type FulfillmentOrderEvidenceRow,
} from "../../../domains/platform/accountingObservabilityEvidence.js";
import {
  summarizeOmniPackEvidence,
  type OmniPackDispatchEvidenceRow,
  type OmniPackLowStockEvidenceRow,
  type OmniPackOrderEvidenceRow,
  type OmniPackProviderStockCurrentEvidenceRow,
  type OmniPackStatusEvidenceRow,
  type OmniPackStockCursorEvidenceRow,
} from "../../../domains/platform/omnipackObservabilityEvidence.js";
import { summarizeOutboxQueue, type OutboxEventEvidenceRow } from "../../../domains/platform/outboxObservabilityEvidence.js";
import { selectMethodHealthRows, summarizeMethodHealth, type MethodHealthEvidenceRow } from "./subscriptionMethodHealthEvidence.js";
import {
  DUNNING_ATTENTION_NOTIFICATION_STATUSES,
  DUNNING_CASE_COLUMNS,
  DUNNING_NOTIFICATION_COLUMNS,
  DUNNING_TERMINAL_CASE_STATUSES,
  selectDunningCaseNotifications,
  summarizeDunning,
  summarizeDunningQueue,
  type DunningCaseEvidenceRow,
  type DunningNotificationEvidenceRow,
} from "./dunningObservabilityEvidence.js";
import { excludeDormantOutboxEvents, selectRecentOmniPackQuarantine, SKIPPABLE_CUSTOMER_NOTICE_EVENT_TYPES } from "./observabilityEvidenceQueryScopes.js";
import {
  summarizeEmailEvidence,
  type CommunicationEmailDeliveryEvidenceRow,
  type EmailEventEvidenceRow,
  type EmailSendEvidenceRow,
} from "../../../domains/platform/emailObservabilityEvidence.js";
import {
  summarizeSubscriptionEvidence,
  type DeliveryAlignmentCaseEvidenceRow,
  type SubscriptionCycleEvidenceRow,
  type SubscriptionEventEvidenceRow,
  type PaymentMethodRefEvidenceRow, type SubscriptionEvidenceRow,
} from "../../../domains/platform/subscriptionObservabilityEvidence.js";
import { summarizeReservedBalanceDrift, type InventoryBalanceEvidenceRow, type ReservedLeaseEvidenceRow } from "../../../domains/platform/inventoryObservabilityEvidence.js";
import { selectCount, selectRows, type ObservabilityEvidenceClient, type SupabaseObservabilityClient } from "./observabilityEvidenceQueries.js";
import { latestSuccessfulOmnipackStateConflictCount, selectRecentPaymentReconciliationRuns } from "./observabilityReconciliationEvidence.js";

export type { SupabaseObservabilityClient };
type RuntimeFlags = Partial<Record<RuntimeFlagName, boolean>>;
export function createSupabaseObservabilityEvidencePort(
  client: ObservabilityEvidenceClient,
  runtimeFlags: RuntimeFlags,
  options: { emailProductionHosts?: readonly string[]; readOpenDeliveryAlignmentCases?: () => Promise<DeliveryAlignmentCaseEvidenceRow[]> } = {},
): ObservabilityEvidencePort {
  return {
    async collectSnapshot(now) {
      const since24h = hoursAgo(now, 24);
      const [jobControls, recentJobRuns, queuedDunningNotifications, attentionDunningNotifications, openDunningCases, terminalDunningCases, outboxEvents, orderPaidOutboxEvents, skippedNoticeOutboxEvents, outboxDueCount, outboxFailedCount, recipients, emailSends, emailEvents, communicationEmailDeliveries, subscriptions, paymentMethodRefs, cycles, events, paymentIntents, paymentAttempts, paymentEvents, checkoutRecoveryTokens, paymentReconciliationRuns, leakedCheckoutReservationCount, leakedSubscriptionRetryReservationCount, pendingActivationOverdueCount, zeroLineActiveCount, inventoryBalances, reservedLeases, invoices, invoiceOutbox, correctionOutbox, deliveryOutbox, fulfillmentOrders, omnipackOrders, omnipackDispatchRefs, omnipackStatusEvidence, omnipackStockCursors, omnipackProviderStockCurrent, omnipackLowStockEvidence, omnipackInboundEvents, methodHealthRows, pendingPaymentOrders] = await Promise.all([
        selectRows<JobControlRow>(client.from<JobControlRow>("platform_job_controls").select("*").limit(200), "platform_job_controls"),
        selectRows<JobRunRow>(
          client.from<JobRunRow>("platform_job_runs").select("*").gte("started_at", since24h).order("started_at", { ascending: false }).limit(1000),
          "platform_job_runs",
        ),
        // Queue health reads the live queue oldest-first, so the longest-waiting notice survives truncation.
        selectRows<DunningNotificationEvidenceRow>(
          client.from<DunningNotificationEvidenceRow>("subscription_dunning_notifications").select(DUNNING_NOTIFICATION_COLUMNS).eq("status", "queued").order("scheduled_at", { ascending: true }).limit(2000),
          "subscription_dunning_notifications_queued",
        ),
        // Failed/skipped notices are never pruned, so they are read recency-first and kept out of the queued read.
        selectRows<DunningNotificationEvidenceRow>(
          client.from<DunningNotificationEvidenceRow>("subscription_dunning_notifications").select(DUNNING_NOTIFICATION_COLUMNS).in("status", DUNNING_ATTENTION_NOTIFICATION_STATUSES).order("created_at", { ascending: false }).limit(2000),
          "subscription_dunning_notifications_attention",
        ),
        // Open cases are the live set: bounded by the retry ladder, ordered so the most overdue is never the row that falls off.
        selectRows<DunningCaseEvidenceRow>(
          client.from<DunningCaseEvidenceRow>("subscription_dunning_cases").select(DUNNING_CASE_COLUMNS).eq("status", "open").order("next_retry_at", { ascending: true }).limit(2000),
          "subscription_dunning_cases_open",
        ),
        // Closed cases accumulate forever; every writer that closes one also touches updated_at, so recency-first keeps the 24h counters whole.
        selectRows<DunningCaseEvidenceRow>(
          client.from<DunningCaseEvidenceRow>("subscription_dunning_cases").select(DUNNING_CASE_COLUMNS).in("status", DUNNING_TERMINAL_CASE_STATUSES).order("updated_at", { ascending: false }).limit(2000),
          "subscription_dunning_cases_terminal",
        ),
        selectRows<OutboxEventEvidenceRow>(excludeDormantOutboxEvents(client.from<OutboxEventEvidenceRow>("outbox_events").select("id,status,event_type,aggregate_type,aggregate_id,available_at,created_at,processed_at,attempts").in("status", ["pending", "failed", "processing"]).lte("available_at", now.toISOString())).order("available_at", { ascending: true }).limit(2000), "outbox_events"),
        selectRows<OutboxEventEvidenceRow>(client.from<OutboxEventEvidenceRow>("outbox_events").select("id,status,event_type,aggregate_type,aggregate_id,available_at,created_at,processed_at,attempts").eq("event_type", "commerce.order.paid").order("created_at", { ascending: false }).limit(2000), "outbox_events_order_paid"),
        selectRows<OutboxEventEvidenceRow>(client.from<OutboxEventEvidenceRow>("outbox_events").select("id,status,event_type,created_at,metadata").eq("status", "processed").in("event_type", [...SKIPPABLE_CUSTOMER_NOTICE_EVENT_TYPES]).not("metadata->>skipped", "is", null).gte("created_at", since24h).limit(2000), "outbox_events_skipped_notices"),
        selectCount(
          excludeDormantOutboxEvents(client.from("outbox_events").select("id", { count: "exact", head: true }).in("status", ["pending", "failed", "processing"]).lte("available_at", now.toISOString())),
          "outbox_events_due_count",
        ),
        selectCount(
          excludeDormantOutboxEvents(client.from("outbox_events").select("id", { count: "exact", head: true }).eq("status", "failed").lte("available_at", now.toISOString())),
          "outbox_events_failed_count",
        ),
        selectRows<RecipientRow>(client.from<RecipientRow>("notification_recipients").select("*").eq("active", true).limit(1000), "notification_recipients"),
        // Window on created_at, not sent_at: failed sends carry sent_at=NULL and
        // would otherwise drop out of the window entirely (invisible failures).
        selectRows<EmailSendEvidenceRow>(client.from<EmailSendEvidenceRow>("email_sends").select("*").gte("created_at", since24h).limit(2000), "email_sends"),
        selectRows<EmailEventEvidenceRow>(
          client.from<EmailEventEvidenceRow>("email_events").select("send_id,event_type,timestamp").gte("timestamp", since24h).limit(2000),
          "email_events",
        ),
        selectRows<CommunicationEmailDeliveryEvidenceRow>(
          client.from<CommunicationEmailDeliveryEvidenceRow>("communication_email_deliveries").select("*").in("status", ["planned", "queued", "processing", "delivery_delayed", "bounced", "complained", "failed", "missed"]).limit(2000),
          "communication_email_deliveries",
        ),
        selectRows<SubscriptionEvidenceRow>(client.from<SubscriptionEvidenceRow>("subscriptions").select("*").eq("status", "active").limit(2000), "subscriptions"),
        // Chargeable-mandate evidence, pre-filtered to the renewal due-RPC's shape (countActiveWithoutPaymentMethod documents the predicate).
        selectRows<PaymentMethodRefEvidenceRow>(client.from<PaymentMethodRefEvidenceRow>("commerce_payment_method_refs").select("subscription_id,client_id,status,active").not("subscription_id", "is", null).eq("active", true).eq("status", "active").limit(2000), "commerce_payment_method_refs"),
        selectRows<SubscriptionCycleEvidenceRow>(client.from<SubscriptionCycleEvidenceRow>("subscription_cycles").select("*").in("status", ["payment_pending", "paid", "payment_failed", "retry_scheduled"]).order("scheduled_at", { ascending: false }).limit(2000), "subscription_cycles"),
        selectRows<SubscriptionEventEvidenceRow>(client.from<SubscriptionEventEvidenceRow>("subscription_events").select("*").gte("occurred_at", since24h).limit(2000), "subscription_events"),
        selectRows<PaymentIntentEvidenceRow>(client.from<PaymentIntentEvidenceRow>("commerce_payment_intents").select("*").order("updated_at", { ascending: false }).limit(2000), "commerce_payment_intents"),
        selectRows<PaymentAttemptEvidenceRow>(client.from<PaymentAttemptEvidenceRow>("commerce_payment_attempts").select("*").order("updated_at", { ascending: false }).limit(2000), "commerce_payment_attempts"),
        selectRows<PaymentEventEvidenceRow>(client.from<PaymentEventEvidenceRow>("inbound_provider_events").select("*").in("provider", ["stripe", "tpay"]).order("received_at", { ascending: false }).limit(2000), "inbound_provider_events"),
        // Orders offered a way back into an unfinished checkout; any token state counts.
        // Windowed because rows are never pruned; `collectRecoveryMissingEvidence` carries
        // the matching 24h bound so truncation cannot invent a missing path.
        selectRows<CheckoutRecoveryTokenEvidenceRow>(client.from<CheckoutRecoveryTokenEvidenceRow>("commerce_checkout_recovery_tokens").select("order_id").gte("created_at", since24h).order("created_at", { ascending: false }).limit(2000), "commerce_checkout_recovery_tokens"),
        selectRecentPaymentReconciliationRuns(client, since24h),
        // Checkout holds reserved >1h past expiry (sweep runs ~15m): a non-zero count means the sweep is disabled/stalled.
        selectCount(client.from("inventory_reservations").select("order_id", { count: "exact", head: true }).eq("status", "reserved").eq("kind", "checkout_payment_window").lte("expires_at", new Date(now.getTime() - 60 * 60 * 1000).toISOString()), "inventory_reservations_leaked_count"),
        // Retry-hold leak sibling — remediation is release-only (never cancels the subscription or its dunning case).
        selectCount(client.from("inventory_reservations").select("order_id", { count: "exact", head: true }).eq("status", "reserved").eq("kind", "subscription_retry_window").lte("expires_at", new Date(now.getTime() - 60 * 60 * 1000).toISOString()), "inventory_reservations_retry_leaked_count"),
        // Two precise P1 probes, both view-backed. Paid-activation gap: paid first cycle + succeeded Tpay Model O active attempt + no active subscription method (unpaid checkout ghosts are excluded).
        // Zero-line active: a guard-bypass signal, not a drift counter — migration 20260801120100 blocks every UPDATE into that state, so a row means a service-role INSERT or manual SQL wrote it. No time window: one row is one subscription that can never renew and cannot self-heal.
        selectCount(client.from("subscription_paid_activation_gaps").select("subscription_id", { count: "exact", head: true }).lte("paid_at", new Date(now.getTime() - 4 * 60 * 60 * 1000).toISOString()), "subscriptions_paid_activation_missing_mandate_overdue"), selectCount(client.from("subscription_zero_line_active").select("subscription_id", { count: "exact", head: true }), "subscriptions_zero_line_active"),
        selectRows<InventoryBalanceEvidenceRow>(client.from<InventoryBalanceEvidenceRow>("inventory_balances").select("sku_id,location_id,lot_key,reserved").limit(2000), "inventory_balances"),
        selectRows<ReservedLeaseEvidenceRow>(client.from<ReservedLeaseEvidenceRow>("inventory_reservations").select("sku_id,location_id,lot_key,quantity,expires_at").eq("status", "reserved").limit(2000), "inventory_reservations_reserved"),
        selectRows<AccountingInvoiceEvidenceRow>(client.from<AccountingInvoiceEvidenceRow>("accounting_invoices").select("*").limit(2000), "accounting_invoices"),
        selectRows<AccountingInvoiceOutboxEvidenceRow>(client.from<AccountingInvoiceOutboxEvidenceRow>("accounting_invoice_issue_outbox").select("*").limit(2000), "accounting_invoice_issue_outbox"),
        selectRows<AccountingCorrectionOutboxEvidenceRow>(client.from<AccountingCorrectionOutboxEvidenceRow>("accounting_invoice_correction_outbox").select("*").limit(2000), "accounting_invoice_correction_outbox"),
        selectRows<AccountingDeliveryOutboxEvidenceRow>(client.from<AccountingDeliveryOutboxEvidenceRow>("accounting_invoice_delivery_outbox").select("*").limit(2000), "accounting_invoice_delivery_outbox"),
        selectRows<FulfillmentOrderEvidenceRow>(
          client.from<FulfillmentOrderEvidenceRow>("commerce_fulfillment_orders").select("*").order("updated_at", { ascending: false }).limit(2000),
          "commerce_fulfillment_orders",
        ),
        selectRows<OmniPackOrderEvidenceRow>(
          client.from<OmniPackOrderEvidenceRow>("commerce_orders")
            .select("id,status,metadata,mode,subscription_id,subscription_cycle_id,created_at,updated_at")
            .in("status", ["paid", "fulfillment_pending", "fulfilled"]).order("updated_at", { ascending: false }).limit(2000),
          "commerce_orders_omnipack_health",
        ),
        selectRows<OmniPackDispatchEvidenceRow>(
          client.from<OmniPackDispatchEvidenceRow>("omnipack_dispatch_refs").select("*").order("updated_at", { ascending: false }).limit(1000),
          "omnipack_dispatch_refs",
        ),
        selectRows<OmniPackStatusEvidenceRow>(client.from<OmniPackStatusEvidenceRow>("omnipack_status_evidence").select("*").limit(1000), "omnipack_status_evidence"),
        selectRows<OmniPackStockCursorEvidenceRow>(client.from<OmniPackStockCursorEvidenceRow>("omnipack_stock_sync_cursors").select("*").limit(50), "omnipack_stock_sync_cursors"),
        selectRows<OmniPackProviderStockCurrentEvidenceRow>(
          client.from<OmniPackProviderStockCurrentEvidenceRow>("fulfillment_provider_stock_current")
            .select("sku,inventory_class,stale_after")
            .eq("provider_kind", "omnipack")
            .limit(2000),
          "fulfillment_provider_stock_current_omnipack_observability",
        ),
        selectRows<OmniPackLowStockEvidenceRow>(client.from<OmniPackLowStockEvidenceRow>("omnipack_low_stock_evidence").select("*").limit(2000), "omnipack_low_stock_evidence"),
        selectRecentOmniPackQuarantine(client, since24h),
        // Standing method health: the two states that mean a renewal cannot be charged when it comes due. Two bounded reads (the view carries no age); all three counters fold out of them.
        selectMethodHealthRows(client),
        // Orders past the recovery rail's own 24h ceiling. Oldest-first so truncation can understate the count but never hide the worst offender, and unwindowed on purpose: an order nobody chased does not stop mattering after a day.
        selectRows<PendingPaymentOrderEvidenceRow>(client.from<PendingPaymentOrderEvidenceRow>("commerce_orders").select("id,created_at").eq("status", "pending_payment").order("created_at", { ascending: true }).limit(2000), "commerce_orders_pending_payment_overdue"),
      ]);
      // Window healthy rows separately so they do not compete with the actionable CED query budget.
      const successfulCommunicationEmailDeliveries = await selectRows<CommunicationEmailDeliveryEvidenceRow>(
        client.from<CommunicationEmailDeliveryEvidenceRow>("communication_email_deliveries").select("id,status,purpose,template_slug,recipient_fingerprint,aggregate_type,aggregate_id,email_send_id,provider_message_id,sent_at,delivered_at,updated_at,created_at").in("status", ["sent", "delivered"]).gte("sent_at", since24h).limit(2000),
        "communication_email_deliveries_successful",
      );
      const deliveryAlignmentCases = await (options.readOpenDeliveryAlignmentCases?.() ?? Promise.resolve([]));
      const dunningCases = [...openDunningCases, ...terminalDunningCases];
      return buildSnapshot({
        now,
        runtimeFlags,
        jobControls,
        recentJobRuns,
        dunningQueueNotifications: [...queuedDunningNotifications, ...attentionDunningNotifications],
        dunningCaseNotifications: await selectDunningCaseNotifications(client, dunningCases),
        dunningCases,
        outboxEvents,
        orderPaidOutboxEvents,
        skippedNoticeOutboxEvents,
        outboxDueCount,
        outboxFailedCount,
        recipients, emailSends, emailEvents,
        communicationEmailDeliveries: [...communicationEmailDeliveries, ...successfulCommunicationEmailDeliveries],
        sentRecipientFingerprints: successfulCommunicationEmailDeliveries.map((row) => row.recipient_fingerprint),
        subscriptions, paymentMethodRefs,
        emailProductionHosts: options.emailProductionHosts,
        cycles,
        events,
        paymentIntents,
        paymentAttempts,
        paymentEvents,
        checkoutRecoveryTokens,
        paymentReconciliationRuns,
        leakedCheckoutReservationCount,
        leakedSubscriptionRetryReservationCount, pendingActivationOverdueCount, zeroLineActiveCount, inventoryBalances, reservedLeases,
        invoices, invoiceOutbox, correctionOutbox,
        deliveryOutbox, fulfillmentOrders, omnipackOrders,
        omnipackDispatchRefs,
        omnipackStatusEvidence,
        omnipackStockCursors,
        omnipackProviderStockCurrent,
        omnipackLowStockEvidence,
        omnipackInboundEvents,
        methodHealthRows, pendingPaymentOrders,
        deliveryAlignmentCases,
      });
    },
  };
}
function buildSnapshot(input: SnapshotInput): ObservabilitySnapshot {
  const { now, dunningCases, recipients, subscriptions, cycles, events } = input;
  const dunningQueue = summarizeDunningQueue(input.dunningQueueNotifications);
  const outboxQueue = summarizeOutboxQueue(input.outboxEvents, input.outboxDueCount, input.outboxFailedCount);
  return {
    checkedAt: now.toISOString(),
    runtimeFlags: input.runtimeFlags,
    jobControls: input.jobControls.map(mapJobControl),
    recentJobRuns: input.recentJobRuns.map(mapJobRun),
    queues: [dunningQueue, outboxQueue],
    recipients: [{
      notificationType: "commerce_payment_critical",
      activeCount: recipients.filter((row) => row.notification_type === "commerce_payment_critical").length,
      requiredWhenFlag: "COMMERCE_DUNNING_EMAILS_ENABLED",
    }],
    dunning: summarizeDunning(dunningCases, input.dunningCaseNotifications, now),
    subscriptions: { ...summarizeSubscriptionEvidence(subscriptions, cycles, events, input.omnipackOrders, input.fulfillmentOrders, now, input.paymentIntents, input.orderPaidOutboxEvents, input.paymentMethodRefs, input.deliveryAlignmentCases), pendingActivationOverdueCount: input.pendingActivationOverdueCount, zeroLineActiveCount: input.zeroLineActiveCount, ...summarizeMethodHealth(input.methodHealthRows, now) },
    emails: summarizeEmailEvidence({
      emailSends: input.emailSends,
      emailEvents: input.emailEvents,
      communicationEmailDeliveries: input.communicationEmailDeliveries,
      outboxEvents: input.outboxEvents,
      skippedOutboxEvents: input.skippedNoticeOutboxEvents,
      sentRecipientFingerprints: input.sentRecipientFingerprints,
      productionHosts: input.emailProductionHosts,
      now,
    }),
    payments: { ...summarizePayments(input.paymentIntents, input.paymentAttempts, input.paymentEvents, now, input.paymentReconciliationRuns, new Set(input.checkoutRecoveryTokens.map((row) => row.order_id).filter((id): id is string => Boolean(id))), input.dunningCases, input.pendingPaymentOrders), leakedCheckoutReservationCount: input.leakedCheckoutReservationCount, leakedSubscriptionRetryReservationCount: input.leakedSubscriptionRetryReservationCount, ...summarizeReservedBalanceDrift(input.inventoryBalances, input.reservedLeases, now) },
    accounting: summarizeAccountingEvidence(input.invoices, input.invoiceOutbox, input.correctionOutbox, input.deliveryOutbox, input.fulfillmentOrders, now),
    omnipack: summarizeOmniPackEvidence({
      dispatchRefs: input.omnipackDispatchRefs,
      statusEvidence: input.omnipackStatusEvidence,
      stockCursors: input.omnipackStockCursors,
      providerStockCurrent: input.omnipackProviderStockCurrent,
      lowStockEvidence: input.omnipackLowStockEvidence,
      orders: input.omnipackOrders,
      fulfillmentOrders: input.fulfillmentOrders,
      orderPaidOutboxEvents: input.orderPaidOutboxEvents,
      inboundEvents: input.omnipackInboundEvents,
      reconciliationStateConflictCount: latestSuccessfulOmnipackStateConflictCount(input.recentJobRuns),
      now,
    }),
  };
}
function mapJobControl(row: JobControlRow): JobControlSnapshot {
  return {
    jobName: row.job_name,
    enabled: row.enabled !== false,
    lastSuccessAt: row.last_success_at ?? null,
    lastStartedAt: row.last_started_at ?? null,
    lastFinishedAt: row.last_finished_at ?? null,
    lastStatus: row.last_status ?? null,
    leaseUntil: row.lease_until ?? row.lease_expires_at ?? null,
  };
}
function mapJobRun(row: JobRunRow): JobRunSnapshot {
  return {
    jobName: row.job_name,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? null,
    error: row.error ?? null,
    supportCode: row.support_code ?? null,
  };
}
function hoursAgo(now: Date, hours: number): string {
  return new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString();
}
type SnapshotInput = { now: Date; runtimeFlags: RuntimeFlags; jobControls: JobControlRow[]; recentJobRuns: JobRunRow[]; dunningQueueNotifications: DunningNotificationEvidenceRow[]; dunningCaseNotifications: DunningNotificationEvidenceRow[]; dunningCases: DunningCaseEvidenceRow[]; outboxEvents: OutboxEventEvidenceRow[]; orderPaidOutboxEvents: OutboxEventEvidenceRow[]; skippedNoticeOutboxEvents: OutboxEventEvidenceRow[]; outboxDueCount: number; outboxFailedCount: number; recipients: RecipientRow[]; emailSends: EmailSendEvidenceRow[]; emailEvents: EmailEventEvidenceRow[]; communicationEmailDeliveries: CommunicationEmailDeliveryEvidenceRow[]; sentRecipientFingerprints: (string | null | undefined)[]; emailProductionHosts?: readonly string[]; subscriptions: SubscriptionEvidenceRow[]; paymentMethodRefs: PaymentMethodRefEvidenceRow[]; cycles: SubscriptionCycleEvidenceRow[]; events: SubscriptionEventEvidenceRow[]; paymentIntents: PaymentIntentEvidenceRow[]; paymentAttempts: PaymentAttemptEvidenceRow[]; paymentEvents: PaymentEventEvidenceRow[]; checkoutRecoveryTokens: CheckoutRecoveryTokenEvidenceRow[]; paymentReconciliationRuns: PaymentReconciliationEvidenceRow[]; leakedCheckoutReservationCount: number; leakedSubscriptionRetryReservationCount: number; pendingActivationOverdueCount: number; zeroLineActiveCount: number; inventoryBalances: InventoryBalanceEvidenceRow[]; reservedLeases: ReservedLeaseEvidenceRow[]; invoices: AccountingInvoiceEvidenceRow[]; invoiceOutbox: AccountingInvoiceOutboxEvidenceRow[]; correctionOutbox: AccountingCorrectionOutboxEvidenceRow[]; deliveryOutbox: AccountingDeliveryOutboxEvidenceRow[]; fulfillmentOrders: FulfillmentOrderEvidenceRow[]; omnipackOrders: OmniPackOrderEvidenceRow[]; omnipackDispatchRefs: OmniPackDispatchEvidenceRow[]; omnipackStatusEvidence: OmniPackStatusEvidenceRow[]; omnipackStockCursors: OmniPackStockCursorEvidenceRow[]; omnipackProviderStockCurrent: OmniPackProviderStockCurrentEvidenceRow[]; omnipackLowStockEvidence: OmniPackLowStockEvidenceRow[]; omnipackInboundEvents: import("../../../domains/platform/omnipackObservabilityEvidence.js").OmniPackInboundEventRow[]; methodHealthRows: MethodHealthEvidenceRow[]; pendingPaymentOrders: PendingPaymentOrderEvidenceRow[]; deliveryAlignmentCases: DeliveryAlignmentCaseEvidenceRow[] };
type JobControlRow = Record<string, unknown> & { job_name: string; enabled?: boolean; last_success_at?: string | null; last_started_at?: string | null; last_finished_at?: string | null; last_status?: string | null; lease_until?: string | null; lease_expires_at?: string | null };

type JobRunRow = Record<string, unknown> & { job_name: string; status: string; started_at: string; finished_at?: string | null; error?: string | null; support_code?: string | null; metadata?: Record<string, unknown> | null };

type RecipientRow = Record<string, unknown> & { notification_type: string };
