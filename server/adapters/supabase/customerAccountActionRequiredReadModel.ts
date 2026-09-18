import { customerCauseForFailureClass, type PaymentFailureCustomerCause } from "@openlup/core/payment";

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  CustomerAccountActionRequired,
  CustomerAccountV2Response,
} from "../../../src/domains/customers/accountV2Contracts.js";
import { canUsePaymentMethodForRenewal } from "../../../src/domains/subscription/contracts.js";
import { SUBSCRIPTION_ACTIVATION_GRACE_MS } from "../../../src/domains/payment/contracts.js";

type Row = Record<string, unknown>;
type Subscription = CustomerAccountV2Response["subscriptions"][number];

export type SubscriptionActionState = {
  subscriptionId: string;
  orderId: string | null;
  blockedReason: CustomerAccountActionRequired["blockedReason"];
  /** Payer-facing cause, mapped from the case's recorded class at the read edge. */
  failureCause: PaymentFailureCustomerCause;
  recoveryEligible: boolean;
  dueAt: string | null;
  nextRetryAt: string | null;
};

export async function readSubscriptionActionStates(
  serviceClient: SupabaseClient,
  subscriptionIds: string[],
): Promise<Map<string, SubscriptionActionState>> {
  const ids = Array.from(new Set(subscriptionIds.filter(Boolean)));
  const states = new Map<string, SubscriptionActionState>();
  if (ids.length === 0) return states;

  const { data: activationGapRows, error: activationGapError } = await serviceClient
    .from("subscription_paid_activation_gaps")
    .select("subscription_id, order_id, paid_at")
    .in("subscription_id", ids)
    .lte("paid_at", new Date(Date.now() - SUBSCRIPTION_ACTIVATION_GRACE_MS).toISOString());
  if (activationGapError) throw activationGapError;
  for (const row of (activationGapRows ?? []) as Row[]) {
    const subscriptionId = text(row.subscription_id);
    if (!subscriptionId || states.has(subscriptionId)) continue;
    states.set(subscriptionId, {
      subscriptionId,
      orderId: nullableText(row.order_id),
      blockedReason: "subscription_activation_missing_mandate",
      failureCause: "unknown" as const,
      recoveryEligible: false,
      dueAt: nullableText(row.paid_at),
      nextRetryAt: null,
    });
  }

  // Open first, then expired. An open case outranks history; an expired one is
  // terminal (the ladder is spent, nothing is retrying, the subscription was
  // paused for it) and must still be read BEFORE the failed-cycle scan below,
  // whose `payment_failed` entry would otherwise describe the abandoned cycle
  // and hide the fact that the whole journey ended.
  for (const status of ["open", "expired"] as const) {
    const { data, error } = await serviceClient
      .from("subscription_dunning_cases")
      .select("id, subscription_id, order_id, status, next_retry_at, expired_at, opened_at, updated_at, failure_class")
      .in("subscription_id", ids)
      .eq("status", status)
      .order("updated_at", { ascending: false });
    if (error) throw error;

    const caseRows = (data ?? []) as Row[];
    const activeCaseIds = await readActiveRecoveryCaseIds(serviceClient, caseRows.map((row) => text(row.id)));
    for (const row of caseRows) {
      const subscriptionId = text(row.subscription_id);
      if (!subscriptionId || states.has(subscriptionId)) continue;
      // A terminal case has no next attempt by definition; its deadline is when
      // the journey ended, not when something is due to be tried.
      const nextRetryAt = status === "open" ? nullableText(row.next_retry_at) : null;
      states.set(subscriptionId, {
        subscriptionId,
        orderId: nullableText(row.order_id),
        blockedReason: status === "open" ? "payment_blocked" : "payment_expired",
        recoveryEligible: activeCaseIds.has(text(row.id)),
        failureCause: customerCauseForFailureClass(nullableText(row.failure_class)),
        dueAt:
          (status === "open" ? nextRetryAt : nullableText(row.expired_at)) ??
          nullableText(row.updated_at) ??
          nullableText(row.opened_at),
        nextRetryAt,
      });
    }
  }

  const { data: cycleRows, error: cycleError } = await serviceClient
    .from("subscription_cycles")
    .select("subscription_id, status, next_retry_at, updated_at, scheduled_at")
    .in("subscription_id", ids)
    .in("status", ["payment_failed", "retry_scheduled"])
    .order("updated_at", { ascending: false });
  if (cycleError) throw cycleError;
  for (const row of (cycleRows ?? []) as Row[]) {
    const subscriptionId = text(row.subscription_id);
    if (!subscriptionId || states.has(subscriptionId)) continue;
    const nextRetryAt = nullableText(row.next_retry_at);
    states.set(subscriptionId, {
      subscriptionId,
      orderId: null,
      blockedReason: "payment_failed",
      failureCause: "unknown" as const,
      recoveryEligible: false,
      dueAt: nextRetryAt ?? nullableText(row.updated_at) ?? nullableText(row.scheduled_at),
      nextRetryAt,
    });
  }

  return states;
}

export function buildActionRequired(
  subscriptions: Subscription[],
  orders: CustomerAccountV2Response["recentOrders"],
  subscriptionActionStates = new Map<string, SubscriptionActionState>(),
): CustomerAccountActionRequired[] {
  const actions: CustomerAccountActionRequired[] = [];

  for (const subscription of subscriptions) {
    const actionState = subscriptionActionStates.get(subscription.subscriptionId);
    if (actionState?.blockedReason === "subscription_activation_missing_mandate") {
      actions.push({
        actionId: `subscription:${subscription.subscriptionId}:activation_missing_mandate`,
        kind: "payment_method_missing",
        severity: "critical",
        entityType: "subscription",
        entityId: subscription.subscriptionId,
        subscriptionId: subscription.subscriptionId,
        orderId: actionState.orderId,
        messageCode: "subscription_activation_missing_mandate",
        // No classified refusal behind this entry, so it claims no cause.
        failureCause: "unknown" as const,
        blockedReason: "subscription_activation_missing_mandate",
        title: "First order paid, subscription needs a payment method",
        body: "The first order is paid. Add a card to enable future renewals without charging that order again.",
        cta: "repair_payment",
        recoveryEligible: false,
        dueAt: actionState.dueAt,
        nextRetryAt: null,
      });
      continue;
    }

    if (subscription.status !== "active" && subscription.status !== "paused") continue;

    if (actionState?.blockedReason === "payment_expired") {
      actions.push({
        actionId: `subscription:${subscription.subscriptionId}:payment_expired`,
        kind: "payment_recovery",
        severity: "critical",
        entityType: "subscription",
        entityId: subscription.subscriptionId,
        subscriptionId: subscription.subscriptionId,
        orderId: actionState.orderId,
        messageCode: "payment_expired",
        failureCause: actionState.failureCause,
        blockedReason: "payment_expired",
        title: "Subscription paused after payment could not be collected",
        body: "Every retry has been used, so nothing else will be attempted. Update the payment method to resume; the unpaid cycle is skipped and a new one starts from the resume date.",
        cta: "repair_payment",
        recoveryEligible: actionState.recoveryEligible,
        dueAt: actionState.dueAt,
        nextRetryAt: null,
      });
      continue;
    }

    if (actionState) {
      actions.push({
        actionId: `subscription:${subscription.subscriptionId}:payment_blocked`,
        kind: actionState.recoveryEligible ? "payment_recovery" : "subscription_blocked",
        severity: "critical",
        entityType: "subscription",
        entityId: subscription.subscriptionId,
        subscriptionId: subscription.subscriptionId,
        orderId: actionState.orderId,
        messageCode: actionState.blockedReason ?? "payment_blocked",
        failureCause: actionState.failureCause,
        blockedReason: actionState.blockedReason,
        title: "Payment needs attention",
        body: actionState.recoveryEligible
          ? "Your subscription is blocked until the payment method is recovered."
          : "Your subscription has a payment issue that needs support review.",
        cta: actionState.recoveryEligible ? "repair_payment" : "contact_support",
        recoveryEligible: actionState.recoveryEligible,
        dueAt: actionState.dueAt ?? subscription.nextCycleAt,
        nextRetryAt: actionState.nextRetryAt,
      });
      continue;
    }

    const hasUsablePaymentMethod = subscription.paymentMethodStatus
      ? canUsePaymentMethodForRenewal(subscription.paymentMethodStatus)
      : Boolean(subscription.paymentMethodKind);
    if (!hasUsablePaymentMethod) {
      actions.push({
        actionId: `subscription:${subscription.subscriptionId}:payment_method_missing`,
        kind: "payment_method_missing",
        severity: "warning",
        entityType: "subscription",
        entityId: subscription.subscriptionId,
        subscriptionId: subscription.subscriptionId,
        orderId: null,
        messageCode: "missing_payment_method",
        // No classified refusal behind this entry, so it claims no cause.
        failureCause: "unknown" as const,
        blockedReason: "missing_payment_method",
        title: "Payment method missing",
        body: "Add or recover a payment method before the next subscription cycle.",
        cta: "contact_support",
        recoveryEligible: false,
        dueAt: subscription.nextCycleAt,
        nextRetryAt: null,
      });
    }
  }

  for (const order of orders) {
    const paymentStatus = order.paymentStatus?.toLowerCase() ?? "";
    const failed = ["failed", "payment_failed", "requires_payment_method"].includes(paymentStatus);
    const requiresAction = ["requires_action", "requires_confirmation"].includes(paymentStatus);
    if (failed || requiresAction) {
      actions.push({
        actionId: `order:${order.orderId}:${requiresAction ? "requires_action" : "payment_failed"}`,
        kind: "order_attention",
        // An order-level entry has no dunning case behind it, so no class to quote.
        failureCause: "unknown" as const,
        severity: "critical",
        entityType: "order",
        entityId: order.orderId,
        subscriptionId: null,
        orderId: order.orderId,
        messageCode: requiresAction ? "payment_requires_action" : "payment_failed",
        blockedReason: requiresAction ? "payment_requires_action" : "payment_failed",
        title: requiresAction ? "Payment requires action" : "Payment failed",
        body: "Open the order details to review the payment status and next step.",
        cta: "view_order",
        recoveryEligible: false,
        dueAt: order.updatedAt,
        nextRetryAt: null,
      });
    }

    if (order.invoice && !order.invoice.downloadAvailable && ["issued", "accepted"].includes(order.invoice.status)) {
      actions.push({
        actionId: `invoice:${order.invoice.invoiceId}:pdf_unavailable`,
        kind: "invoice_attention",
        severity: "info",
        entityType: "invoice",
        entityId: order.invoice.invoiceId,
        subscriptionId: null,
        orderId: order.orderId,
        messageCode: "invoice_pdf_unavailable",
        // No classified refusal behind this entry, so it claims no cause.
        failureCause: "unknown" as const,
        blockedReason: "invoice_pdf_unavailable",
        title: "Invoice PDF unavailable",
        body: "The invoice is visible, but the PDF cannot be downloaded from the account yet.",
        cta: "contact_support",
        recoveryEligible: false,
        dueAt: order.invoice.issuedAt ?? order.invoice.createdAt,
        nextRetryAt: null,
      });
    }
  }

  return actions.slice(0, 8);
}

async function readActiveRecoveryCaseIds(
  serviceClient: SupabaseClient,
  caseIds: string[],
): Promise<Set<string>> {
  const ids = Array.from(new Set(caseIds.filter(Boolean)));
  const active = new Set<string>();
  if (ids.length === 0) return active;
  const { data, error } = await serviceClient
    .from("subscription_payment_recovery_tokens")
    .select("case_id")
    .in("case_id", ids)
    .is("used_at", null)
    .is("revoked_at", null)
    .gt("expires_at", new Date().toISOString());
  if (error) throw error;
  for (const row of (data ?? []) as Row[]) active.add(text(row.case_id));
  return active;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}
