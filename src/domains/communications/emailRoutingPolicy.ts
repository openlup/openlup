// Communications owns the email route manifest but must not re-declare sibling
// domain literals. Source the event-type constants from the boundary-neutral
// src/lib hub (NOT sibling domain contracts) so producer↔routing can never drift.
import { COMMERCE_ORDER_DRAFT_CREATED_EVENT_TYPE, COMMERCE_ORDER_PAID_EMAIL_EVENT_TYPE, COMMERCE_PAYMENT_FAILED_EVENT_TYPE, COMMERCE_CHECKOUT_EXPIRED_EVENT_TYPE, COMMERCE_ORDER_CANCELED_EVENT_TYPE, COMMERCE_ORDER_REFUNDED_EVENT_TYPE, COMMERCE_RETURN_APPROVED_EVENT_TYPE, COMMERCE_RETURN_REJECTED_EVENT_TYPE, COMMERCE_SHIPMENT_DISPATCHED_EVENT_TYPE, COMMERCE_SHIPMENT_DELIVERED_EVENT_TYPE, COMMERCE_SHIPMENT_EXCEPTION_EVENT_TYPE, COMMERCE_ORDER_REVIEW_REQUEST_EVENT_TYPE, COMMERCE_ORDER_REVIEW_EFFECTS_EVENT_TYPE, COMMERCE_PRODUCT_BACK_IN_STOCK_EVENT_TYPE, COMMERCE_ORDER_DRAFT_ABANDONED_1H_EVENT_TYPE, COMMERCE_ORDER_DRAFT_ABANDONED_24H_EVENT_TYPE, COMMERCE_ORDER_DRAFT_ABANDONED_72H_EVENT_TYPE, COMMERCE_ORDER_REORDER_REMINDER_EVENT_TYPE, COMMERCE_CHECKOUT_RECOVERY_EVENT_TYPE, SUBSCRIPTION_CANCELLED_EVENT_TYPE, SUBSCRIPTION_CREATED_EVENT_TYPE, SUBSCRIPTION_ACTIVATION_ACTION_REQUIRED_EVENT_TYPE, SUBSCRIPTION_PAUSE_REMINDER_DUE_EVENT_TYPE, SUBSCRIPTION_PAUSED_EVENT_TYPE, SUBSCRIPTION_RESUMED_EVENT_TYPE, SUBSCRIPTION_DELIVERY_RESCHEDULED_EVENT_TYPE, SUBSCRIPTION_CYCLE_SKIPPED_EVENT_TYPE, SUBSCRIPTION_ADDRESS_CHANGED_EVENT_TYPE, SUBSCRIPTION_PACKAGE_CHANGED_EVENT_TYPE, SUBSCRIPTION_RENEWAL_UPCOMING_EVENT_TYPE } from "../../lib/outboxKnownEventTypes.js";
import {
  LEDGER,
  admin,
  direct,
  outbox,
  type CommunicationEmailDynamicRoutingPolicyEntry,
  type CommunicationEmailRoutingPolicyEntry,
} from "./emailRoutingPolicyTypes.js";
import { emailRegistryProjection } from "#email-registry-projection";
export type {
  CommunicationEmailClaimability,
  CommunicationEmailDynamicRoutingPolicyEntry,
  CommunicationEmailLatencyAnchor,
  CommunicationEmailLedgerRequirement,
  CommunicationEmailMergeGate,
  CommunicationEmailRouteKind,
  CommunicationEmailRoutingPolicyEntry,
  CommunicationEmailSlaCategory,
} from "./emailRoutingPolicyTypes.js";

export const COMMUNICATION_EMAIL_ROUTING_POLICY = [
  outbox("commerce-order-confirmation", COMMERCE_ORDER_DRAFT_CREATED_EVENT_TYPE, "order_draft", {
    owner: "commerce",
  }),
  outbox("commerce-order-paid", COMMERCE_ORDER_PAID_EMAIL_EVENT_TYPE, "order_paid_email", {
    owner: "commerce",
  }),
  direct("commerce-invoice-document", "scheduled_direct", {
    owner: "commerce",
    sources: ["accounting-invoice-delivery"],
    controllingFlags: ["ACCOUNTING_EMAIL_ENABLED"],
    exceptionReason: "the existing invoice-delivery outbox is claimed by the accounting document-delivery worker, not global outbox_events",
  }),
  outbox("commerce-payment-failed", COMMERCE_PAYMENT_FAILED_EVENT_TYPE, "payment_failed", { owner: "commerce" }),
  outbox("commerce-checkout-expired", COMMERCE_CHECKOUT_EXPIRED_EVENT_TYPE, "checkout_expired", {
    owner: "commerce",
  }),
  {
    templateSlug: "commerce-order-canceled",
    routeKind: "dormant",
    ledger: LEDGER,
    owner: "commerce",
    sources: ["outbox-dispatch"],
    slaCategory: "dormant_planned",
    targetSlaSeconds: null,
    latencyAnchor: "not_applicable",
    mergeGate: "must_not_send",
    claimability: "dormant_not_claimable",
    controllingFlags: ["COMMERCE_OUTBOX_DISPATCH_ENABLED"],
    outboxEventTypes: [COMMERCE_ORDER_CANCELED_EVENT_TYPE],
    outboxMatrixCaseIds: [],
    exceptionReason:
      "dormant until a real paid-order cancellation plus refund producer updates commerce_orders.status intentionally",
  },
  outbox("commerce-order-refunded", COMMERCE_ORDER_REFUNDED_EVENT_TYPE, "order_refunded", { owner: "commerce" }),
  outbox("commerce-return-approved", COMMERCE_RETURN_APPROVED_EVENT_TYPE, "return_approved", { owner: "commerce", controllingFlags: ["COMMERCE_RETURNS_ENABLED"] }),
  outbox("commerce-return-rejected", COMMERCE_RETURN_REJECTED_EVENT_TYPE, "return_rejected", { owner: "commerce", controllingFlags: ["COMMERCE_RETURNS_ENABLED"] }),
  outbox("commerce-shipment-dispatched", COMMERCE_SHIPMENT_DISPATCHED_EVENT_TYPE, "shipment_dispatched", {
    owner: "fulfillment",
  }),
  outbox("commerce-shipment-delivered", COMMERCE_SHIPMENT_DELIVERED_EVENT_TYPE, "shipment_delivered", {
    owner: "fulfillment",
  }),
  outbox("commerce-shipment-exception", COMMERCE_SHIPMENT_EXCEPTION_EVENT_TYPE, "shipment_exception", { owner: "fulfillment" }),
  outbox("commerce-checkout-recovery", COMMERCE_CHECKOUT_RECOVERY_EVENT_TYPE, "checkout_recovery", {
    owner: "commerce",
    slaCategory: "scheduled_business_time",
    controllingFlags: ["COMMERCE_CHECKOUT_RECOVERY_ENABLED"],
  }),
  outbox("commerce-abandoned-cart-1h", COMMERCE_ORDER_DRAFT_ABANDONED_1H_EVENT_TYPE, "abandoned_cart_1h", {
    owner: "commerce-marketing",
    slaCategory: "scheduled_business_time",
    source: "marketing-dispatch",
    controllingFlags: ["COMMERCE_ABANDONED_CART_ENABLED"],
  }),
  outbox("commerce-abandoned-cart-24h", COMMERCE_ORDER_DRAFT_ABANDONED_24H_EVENT_TYPE, "abandoned_cart_24h", {
    owner: "commerce-marketing",
    slaCategory: "scheduled_business_time",
    source: "marketing-dispatch",
    controllingFlags: ["COMMERCE_ABANDONED_CART_ENABLED"],
  }),
  outbox("commerce-abandoned-cart-72h", COMMERCE_ORDER_DRAFT_ABANDONED_72H_EVENT_TYPE, "abandoned_cart_72h", {
    owner: "commerce-marketing",
    slaCategory: "scheduled_business_time",
    source: "marketing-dispatch",
    controllingFlags: ["COMMERCE_ABANDONED_CART_ENABLED"],
  }),
  outbox("commerce-reorder-reminder", COMMERCE_ORDER_REORDER_REMINDER_EVENT_TYPE, "reorder_reminder", {
    owner: "commerce-marketing",
    slaCategory: "scheduled_business_time",
    source: "marketing-dispatch",
    controllingFlags: ["COMMERCE_REORDER_REMINDER_ENABLED"],
  }),
  outbox("commerce-order-review-request", COMMERCE_ORDER_REVIEW_REQUEST_EVENT_TYPE, "review_request", {
    owner: "commerce-marketing",
    slaCategory: "scheduled_business_time",
    source: "marketing-dispatch",
    controllingFlags: ["COMMERCE_REVIEW_REQUEST_ENABLED"],
  }),
  outbox("commerce-order-review-effects", COMMERCE_ORDER_REVIEW_EFFECTS_EVENT_TYPE, "review_effects", {
    owner: "commerce-marketing",
    slaCategory: "scheduled_business_time",
    source: "marketing-dispatch",
    controllingFlags: ["COMMERCE_REVIEW_REQUEST_ENABLED"],
  }),
  {
    templateSlug: "commerce-back-in-stock",
    routeKind: "dormant",
    ledger: LEDGER,
    owner: "commerce-marketing",
    sources: ["marketing-dispatch"],
    slaCategory: "dormant_planned",
    targetSlaSeconds: null,
    latencyAnchor: "not_applicable",
    mergeGate: "must_not_send",
    claimability: "dormant_not_claimable",
    controllingFlags: ["COMMERCE_BACK_IN_STOCK_ENABLED"],
    outboxEventTypes: [COMMERCE_PRODUCT_BACK_IN_STOCK_EVENT_TYPE],
    outboxMatrixCaseIds: [],
    exceptionReason: "dormant for the downstream app until public notify-me UI and restock producer are activated",
  },
  outbox("subscription-welcome", SUBSCRIPTION_CREATED_EVENT_TYPE, "subscription_created", { owner: "subscriptions" }),
  outbox("subscription-activation-action-required", SUBSCRIPTION_ACTIVATION_ACTION_REQUIRED_EVENT_TYPE, "subscription_activation_action_required", {
    owner: "subscriptions",
    slaCategory: "scheduled_business_time",
  }),
  outbox("subscription-cancelled", SUBSCRIPTION_CANCELLED_EVENT_TYPE, "subscription_cancelled", { owner: "subscriptions" }),
  outbox("subscription-pause-reminder", SUBSCRIPTION_PAUSE_REMINDER_DUE_EVENT_TYPE, "subscription_pause_reminder", {
    owner: "subscriptions",
    slaCategory: "scheduled_business_time",
    controllingFlags: ["COMMERCE_SUBSCRIPTION_PAUSE_REMINDERS_ENABLED"],
  }),
  outbox("subscription-paused", SUBSCRIPTION_PAUSED_EVENT_TYPE, "subscription_paused", { owner: "subscriptions" }),
  outbox("subscription-resumed", SUBSCRIPTION_RESUMED_EVENT_TYPE, "subscription_resumed", { owner: "subscriptions" }),
  outbox("subscription-delivery-rescheduled", SUBSCRIPTION_DELIVERY_RESCHEDULED_EVENT_TYPE, "subscription_delivery_rescheduled", { owner: "subscriptions" }),
  outbox("subscription-cycle-skipped", SUBSCRIPTION_CYCLE_SKIPPED_EVENT_TYPE, "subscription_cycle_skipped", { owner: "subscriptions" }),
  outbox("subscription-address-changed", SUBSCRIPTION_ADDRESS_CHANGED_EVENT_TYPE, "subscription_address_changed", { owner: "subscriptions" }),
  outbox("subscription-package-changed", SUBSCRIPTION_PACKAGE_CHANGED_EVENT_TYPE, "subscription_package_changed", { owner: "subscriptions" }),
  outbox("subscription-renewal-upcoming", SUBSCRIPTION_RENEWAL_UPCOMING_EVENT_TYPE, "subscription_renewal_upcoming", {
    owner: "subscriptions",
    slaCategory: "scheduled_business_time",
    controllingFlags: [
      "SUBSCRIPTION_RENEWAL_REMINDER_ENABLED",
      "SUBSCRIPTION_RENEWAL_OUTBOX_ENABLED",
      "COMMERCE_OUTBOX_DISPATCH_ENABLED",
    ],
  }),
  direct("subscription-winback", "scheduled_direct", {
    owner: "subscriptions",
    sources: ["subscription-winback"],
    controllingFlags: ["COMMERCE_SUBSCRIPTION_WINBACK_ENABLED"],
    exceptionReason: "canonical direct cancelled win-back cron; not an outbox event",
  }),
  direct("subscription-renewal-at-risk", "scheduled_direct", {
    owner: "subscriptions",
    sources: ["subscription-dunning-dispatch"],
    controllingFlags: ["COMMERCE_DUNNING_EMAILS_ENABLED"],
    exceptionReason: "unchargeable renewals are scanned as state on the dunning cron; no notification row and no outbox event exists for them",
  }),
  direct("subscription-payment-recovered", "scheduled_direct", {
    owner: "subscriptions",
    sources: ["subscription-dunning-dispatch"],
    controllingFlags: ["COMMERCE_DUNNING_EMAILS_ENABLED"],
    exceptionReason: "recovered dunning cases are scanned as state on the dunning cron; no notification row and no outbox event exists for them",
  }),
  direct("subscription-payment-expired", "scheduled_direct", {
    owner: "subscriptions",
    sources: ["subscription-dunning-dispatch"],
    controllingFlags: ["COMMERCE_DUNNING_EMAILS_ENABLED"],
    exceptionReason: "subscription dunning queue is claimed from subscription_dunning_notifications",
  }),
  direct("b2b_confirmation", "bff_route", {
    owner: "growth",
    sources: ["/api/bff/partners/b2b-inquiries"],
    exceptionReason: "B2B confirmation is sent directly by the application BFF after inquiry submission",
  }),
  admin("b2b_admin_notification", ["/api/bff/partners/b2b-inquiries"]),
  admin("admin-user-role-granted", ["invite-admin-user"]),
] as const satisfies readonly CommunicationEmailRoutingPolicyEntry[];

export const COMMUNICATION_EMAIL_DYNAMIC_ROUTING_POLICY = [
  {
    patternId: "auth-actions",
    templatePattern: /^auth-[a-z_]+$/,
    routeKind: "auth_hook",
    ledger: LEDGER,
    owner: "customer-account",
    sources: ["auth-send-email"],
    slaCategory: "direct_auth",
    targetSlaSeconds: 10,
    latencyAnchor: "request_start",
    mergeGate: "required",
    claimability: "direct_exception",
    exceptionReason: "Supabase auth hook direct-send; no outbox producer exists for auth action links",
  },
  {
    patternId: "subscription-payment-failed-attempts",
    templatePattern: /^subscription-payment-failed-\d+$/,
    routeKind: "scheduled_direct",
    ledger: LEDGER,
    owner: "subscriptions",
    sources: ["subscription-dunning-dispatch"],
    slaCategory: "scheduled_business_time",
    targetSlaSeconds: 60,
    latencyAnchor: "due_at",
    mergeGate: "required",
    claimability: "direct_exception",
    controllingFlags: ["COMMERCE_DUNNING_EMAILS_ENABLED"],
    exceptionReason: "subscription dunning queue is claimed from subscription_dunning_notifications",
  },
  ...emailRegistryProjection.dynamicRoutingEntries,
] as const satisfies readonly CommunicationEmailDynamicRoutingPolicyEntry[];

export function getImmediateOutboxEmailSlaPolicies(): readonly CommunicationEmailRoutingPolicyEntry[] {
  return COMMUNICATION_EMAIL_ROUTING_POLICY.filter((entry) =>
    entry.routeKind === "outbox" &&
    entry.claimability === "outbox_claimable" &&
    entry.slaCategory === "immediate_transactional" &&
    entry.mergeGate === "required" &&
    (entry.targetSlaSeconds ?? Number.POSITIVE_INFINITY) <= 60
  );
}

export function findCommunicationEmailRoutingPolicy(
  templateSlug: string,
): CommunicationEmailRoutingPolicyEntry | CommunicationEmailDynamicRoutingPolicyEntry | null {
  const exact = COMMUNICATION_EMAIL_ROUTING_POLICY.find((entry) => entry.templateSlug === templateSlug);
  if (exact) return exact;
  return COMMUNICATION_EMAIL_DYNAMIC_ROUTING_POLICY.find((entry) => entry.templatePattern.test(templateSlug)) ?? null;
}
