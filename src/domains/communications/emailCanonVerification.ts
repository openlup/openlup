import type {
  EmailCanonDynamicPattern,
  EmailCanonEntry,
  EmailCanonMechanism,
  EmailCanonTriggerRef,
  EmailCanonVerifiedFlag,
} from "./emailCanon.js";
import { emailRegistryProjection, insertProjectedEntries } from "#email-registry-projection";

type EmailCanonVerification = {
  mechanism: EmailCanonMechanism;
  triggerRef: EmailCanonTriggerRef;
  verifiedFlag: EmailCanonVerifiedFlag;
  verifiedAt: "2026-07-03";
};

const verifiedAt = "2026-07-03" as const;

function v(
  mechanism: EmailCanonMechanism,
  triggerRef: EmailCanonTriggerRef,
  verifiedFlag: EmailCanonVerifiedFlag,
): EmailCanonVerification {
  return { mechanism, triggerRef, verifiedFlag, verifiedAt };
}

const EMAIL_CANON_VERIFICATION_BY_SLUG_BASE = {
  "commerce-order-confirmation": v("outbox_event", "supabase/migrations/20260711170008_order_draft_saved_email_truth.sql:165", "green"),
  "commerce-order-paid": v("outbox_event", "supabase/migrations/20260614120000_order_paid_email_outbox_event.sql:63", "green"),
  "commerce-invoice-document": v("scheduled_worker", "server/domains/accounting/accountingInvoiceDeliveryJob.ts:12", "green"),
  "commerce-payment-failed": v("outbox_event", "supabase/migrations/20260711170022_checkout_expired_recoverable_failed_and_webhook_dunning.sql:124", "yellow"),
  "commerce-checkout-expired": v("outbox_event", "supabase/migrations/20260722090000_checkout_expired_recovery_token.sql:11", "green"),
  "commerce-order-canceled": v("outbox_event", "supabase/migrations/20260615120000_order_canceled_outbox_event.sql:37", "red"),
  "commerce-order-refunded": v("outbox_event", "supabase/migrations/20260711170015_order_refunded_same_currency_sum.sql:75", "green"),
  "commerce-shipment-dispatched": v("outbox_event", "supabase/migrations/20260711170013_shipment_dispatched_ref_arrival_recheck.sql:68", "green"),
  "commerce-shipment-delivered": v("outbox_event", "supabase/migrations/20260710103000_omnipack_tracking_truth.sql:188", "green"),
  "commerce-shipment-exception": v("outbox_event", "supabase/migrations/20260711170016_shipment_exception_live_scope.sql:40", "yellow"),
  "commerce-abandoned-cart-1h": v("outbox_scan", "supabase/migrations/20260704110000_abandoned_cart_24h_upper_bound.sql:83", "green"),
  "commerce-abandoned-cart-24h": v("outbox_scan", "supabase/migrations/20260704110000_abandoned_cart_24h_upper_bound.sql:121", "yellow"),
  "commerce-abandoned-cart-72h": v("outbox_scan", "supabase/migrations/20260704110000_abandoned_cart_24h_upper_bound.sql:163", "green"),
  "commerce-reorder-reminder": v("outbox_scan", "supabase/migrations/20260711170009_reorder_reminder_delivery_provenance.sql:65", "yellow"),
  "commerce-checkout-recovery": v("outbox_scan", "supabase/migrations/20260711170006_checkout_recovery_payment_activity_gate.sql:10", "green"),
  "commerce-order-review-request": v("outbox_scan", "supabase/migrations/20260711170010_review_request_delivery_provenance.sql:71", "yellow"),
  "commerce-back-in-stock": v("outbox_event", "supabase/migrations/20260629160000_outbox_operational_hardening.sql:192", "red"),
  "commerce-order-review-effects": v("outbox_scan", "supabase/migrations/20260711170011_review_effects_delivery_health.sql:83", "yellow"),
  "commerce-return-approved": v("outbox_event", "supabase/migrations/20260708130000_commerce_returns_promote_runtime.sql:43", "yellow"),
  "commerce-return-rejected": v("outbox_event", "supabase/migrations/20260708130000_commerce_returns_promote_runtime.sql:43", "green"),
  "subscription-welcome": v("outbox_event", "supabase/migrations/20260704140000_subscription_welcome_skip_resume.sql:44", "green"),
  "subscription-activation-action-required": v("outbox_scan", "supabase/migrations/20260722120000_paid_subscription_activation_gap.sql:385", "yellow"),
  "subscription-cancelled": v("outbox_event", "supabase/migrations/20260711170014_subscription_cancelled_fail_closed_source.sql:80", "green"),
  "subscription-paused": v("outbox_event", "supabase/migrations/20260707100000_subscription_change_notify_emails.sql:89", "green"),
  "subscription-resumed": v("outbox_event", "supabase/migrations/20260707100000_subscription_change_notify_emails.sql:89", "green"),
  "subscription-pause-reminder": v("outbox_scan", "supabase/migrations/20260711170017_subscription_pause_reminder_next_delivery.sql:72", "green"),
  "subscription-renewal-upcoming": v("outbox_scan", "supabase/migrations/20260711170001_subscription_renewal_upcoming_outbox.sql:15", "yellow"),
  "subscription-winback": v("scheduled_worker", "supabase/migrations/20260711170005_subscription_winback_customer_source.sql:10", "green"),
  "subscription-delivery-rescheduled": v("outbox_event", "supabase/migrations/20260710100000_subscription_account_event_order_now_reactivate.sql:82", "green"),
  "subscription-cycle-skipped": v("outbox_event", "supabase/migrations/20260710100000_subscription_account_event_order_now_reactivate.sql:82", "green"),
  "subscription-address-changed": v("outbox_event", "supabase/migrations/20260710100000_subscription_account_event_order_now_reactivate.sql:82", "green"),
  "subscription-package-changed": v("outbox_event", "supabase/migrations/20260711170020_subscription_package_changed_noop_truth.sql:75", "green"),
  "subscription-payment-expired": v("dunning_worker", "supabase/migrations/20260709130000_subscription_dunning_qp_safe_token.sql:190", "yellow"),
  // The trigger is a STATE scan, not a SQL producer: no migration writes this
  // email's cue, so the anchor is the scan itself. That is the point of the
  // design — it fires for every writer that can set `recovered`.
  "subscription-payment-recovered": v("dunning_worker", "server/domains/subscription/subscriptionPaymentRecoveredWorker.ts:79", "green"),
  // Same reason as its sibling above: the trigger is a STATE scan over the
  // method-health view, not a SQL producer, so the anchor is the scan itself.
  "subscription-renewal-at-risk": v("dunning_worker", "server/domains/subscription/subscriptionRenewalAtRiskWorker.ts:166", "green"),
  "b2b_confirmation": v("bff_route", "server/adapters/email/privateLabelB2BInquiryPresenter.ts:58", "green"),
  "account-deletion-confirmation": v("admin_direct", "not_applicable", "yellow"),
  "subscription-card-expiring": v("admin_direct", "not_applicable", "yellow"),
  "subscription-dunning-admin-escalation": v("admin_direct", "not_applicable", "yellow"),
  "b2b_admin_notification": v("bff_route", "server/adapters/email/privateLabelB2BInquiryPresenter.ts:59", "green"),
  "admin-user-role-granted": v("bff_route", "server/adapters/email/adminRoleNotificationPort.ts:118", "green"),
  "daily-report": v("edge_function", "not_applicable", "yellow"),
} as const satisfies Record<string, EmailCanonVerification>;
export const EMAIL_CANON_VERIFICATION_BY_SLUG = {
  ...Object.fromEntries(insertProjectedEntries(
    Object.entries(EMAIL_CANON_VERIFICATION_BY_SLUG_BASE),
    emailRegistryProjection.staticVerificationInsertions,
    ([slug]) => slug,
  )),
} as Readonly<Record<string, EmailCanonVerification>>;

const dynamicVerificationById = {
  "auth-actions": v("supabase_auth", "server/domains/auth/authSendEmailHook.ts:243", "yellow"),
  "subscription-payment-failed-attempts": v("dunning_worker", "supabase/migrations/20260709130000_subscription_dunning_qp_safe_token.sql:193", "yellow"),
  ...emailRegistryProjection.dynamicVerificationById,
} as const satisfies Record<string, EmailCanonVerification>;

const verificationBySlug: Record<string, EmailCanonVerification> = EMAIL_CANON_VERIFICATION_BY_SLUG;
const verificationByDynamicId: Record<string, EmailCanonVerification> = dynamicVerificationById;

export function applyEmailCanonVerification<T extends Omit<EmailCanonEntry, keyof EmailCanonVerification>>(
  entry: T,
): T & EmailCanonVerification {
  const verification = verificationBySlug[entry.slug];
  if (!verification) throw new Error(`Missing email canon verification for ${entry.slug}`);
  return { ...entry, ...verification };
}

export function applyEmailCanonDynamicVerification<T extends Omit<EmailCanonDynamicPattern, keyof EmailCanonVerification>>(
  entry: T,
): T & EmailCanonVerification {
  const verification = verificationByDynamicId[entry.id];
  if (!verification) throw new Error(`Missing email canon dynamic verification for ${entry.id}`);
  return { ...entry, ...verification };
}
