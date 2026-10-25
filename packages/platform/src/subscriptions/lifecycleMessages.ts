import type { SubscriptionLifecycleMessageDescriptor, SubscriptionLifecycleMessagePort } from "./contracts/messages.js";

/** Matches M5 and the existing M04 lifecycle templates. A mapping is not a send. */
const templates: Readonly<Record<string, string>> = Object.freeze({
  "subscription.created": "subscription-welcome",
  "subscription.activation_action_required": "subscription-activation-action-required",
  "subscription.cancelled": "subscription-cancelled",
  "subscription.paused": "subscription-paused",
  "subscription.resumed": "subscription-resumed",
  "subscription.pause_reminder_due": "subscription-pause-reminder",
  "subscription.delivery_rescheduled": "subscription-delivery-rescheduled",
  "subscription.cycle_skipped": "subscription-cycle-skipped",
  "subscription.address_changed": "subscription-address-changed",
  "subscription.package_changed": "subscription-package-changed",
  "subscription.renewal_upcoming": "subscription-renewal-upcoming",
  "subscription_stock_wait.started": "subscription-stock-wait-started",
  "subscription_stock_wait.resumed": "subscription-stock-wait-resumed",
  payment_failed: "subscription-payment-failed", payment_expired: "subscription-payment-expired",
  payment_recovered: "subscription-payment-recovered", winback_eligible: "subscription-winback",
  stock_wait_started: "subscription-stock-wait-started", stock_wait_resumed: "subscription-stock-wait-resumed",
});
export function subscriptionLifecycleTemplate(eventType: string): string | null {
  return Object.hasOwn(templates, eventType) ? templates[eventType]! : null;
}
/** M04 owns delivery, consent, rendering and durable replay. M10 never synthesizes a pause. */
export function createSubscriptionLifecycleMessages(delivery: SubscriptionLifecycleMessagePort) {
  return {
    deliver(input: Omit<SubscriptionLifecycleMessageDescriptor, "templateSlug">) {
      const templateSlug = subscriptionLifecycleTemplate(input.fact.kind);
      if (!templateSlug) throw new Error("subscription_lifecycle_message_unsupported");
      if (input.messageKey !== input.fact.idempotencyKey) throw new Error("subscription_lifecycle_message_identity_mismatch");
      return delivery.enqueue({ ...input, templateSlug });
    },
  };
}
