// Subscription lifecycle outbox event types. Kept in the subscription domain (the
// producer), mirroring src/domains/commerce/outboxEventContracts.ts. The shared
// outbox dispatcher claims these once their handler registers (claim allowlist =
// registry keys), so an event sits inert until its handler ships.

// commerce-side note: these are consumed by the same outbox dispatcher, but the
// handler + content live in the subscription domain and plug in via the job's
// extraHandlers seam (the commerce registry never imports subscription code).

// subscription.cancelled — emitted by the subscription_emit_cancelled_outbox
// trigger (20260618110000_subscription_cancelled_outbox_event.sql) when a
// subscription transitions to status='cancelled'. Payload carries the client id
// (recipient resolution) + subscription id; no payment/provider coupling.
export const SUBSCRIPTION_CANCELLED_EVENT_TYPE = "subscription.cancelled";

// subscription.created — emitted by the subscription_emit_created_outbox trigger
// (20260619110000_subscription_created_outbox_event.sql) on INSERT of a new
// subscription. Payload carries the client id (recipient), subscription id,
// cadence (days) and next charge timestamp so the welcome email can state the
// schedule. Distinct from the order-paid receipt: onboarding, not a receipt.
export const SUBSCRIPTION_CREATED_EVENT_TYPE = "subscription.created";

// Enqueued once after a paid Tpay Model O first cycle has spent 30 minutes
// without a reusable mandate. The handler rechecks live gap truth before send.
export const SUBSCRIPTION_ACTIVATION_ACTION_REQUIRED_EVENT_TYPE =
  "subscription.activation_action_required";

// subscription.pause_reminder_due — queued by the Wave 3 timed-pause runtime
// when a timed pause is close to its resume timestamp. Payload carries the
// client id, subscription id, pause-window id, preset, and resume timestamp.
export const SUBSCRIPTION_PAUSE_REMINDER_DUE_EVENT_TYPE = "subscription.pause_reminder_due";

// subscription.paused / subscription.resumed — emitted by the
// subscription_emit_self_service_account_event trigger
// (20260704170003_subscription_self_service_notify_emails.sql) when a self-service
// pause / resume (or timed auto-resume) is recorded. Payload carries the client id
// (recipient) + subscription id; no payment/provider coupling. Drives the
// pause/resume confirmation emails.
export const SUBSCRIPTION_PAUSED_EVENT_TYPE = "subscription.paused";
export const SUBSCRIPTION_RESUMED_EVENT_TYPE = "subscription.resumed";

// subscription.delivery_rescheduled / cycle_skipped / address_changed /
// package_changed — emitted by the same subscription_emit_self_service_account_event
// trigger (20260707100000_subscription_change_notify_emails.sql) for the four
// remaining customer-initiated change actions. Payload carries the client id
// (recipient), subscription id, originating `action`, and current `nextCycleAt`
// (so the reschedule email can state the new delivery date). Each drives a
// change-confirmation email and is gated per-slug by comms_notification_controls.
export const SUBSCRIPTION_DELIVERY_RESCHEDULED_EVENT_TYPE = "subscription.delivery_rescheduled";
export const SUBSCRIPTION_CYCLE_SKIPPED_EVENT_TYPE = "subscription.cycle_skipped";
export const SUBSCRIPTION_ADDRESS_CHANGED_EVENT_TYPE = "subscription.address_changed";
export const SUBSCRIPTION_PACKAGE_CHANGED_EVENT_TYPE = "subscription.package_changed";

// subscription.renewal_upcoming — queued by enqueue_subscription_renewal_reminders
// after the scan has matched the billing-authoritative renewal candidate set
// (active subscription + active payment method + unchanged reminder window).
// Payload carries client id, subscription id, renewalAt, and a shared email
// dedupeKey so the shadow outbox path cannot double-send after the legacy worker.
export const SUBSCRIPTION_RENEWAL_UPCOMING_EVENT_TYPE = "subscription.renewal_upcoming";
