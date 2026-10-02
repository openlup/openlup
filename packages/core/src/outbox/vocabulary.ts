// The platform event-type vocabulary: every event type OpenLup's platform SQL
// writes into the outbox, in both of its migration chains, as the SQL emits it.
// Names are persisted and are never corrected here, so a spelling split stays
// as emitted: the managed baseline emits `commerce.order.canceled` and
// `subscription.cancelled`, and the portable chain emits
// `commerce.order.cancelled`.

/**
 * One platform event type. `owner` is the namespace the emitted name declares.
 * A package that emits the type claims it through its manifest.
 * @beta
 */
export interface OutboxEventTypeEntry {
  readonly eventType: string;
  readonly owner: string;
}

/** @beta */
export type OutboxEventTypeDeclarationState = "ignored" | "dormant";

/**
 * An application's statement that an event type has no handler on purpose.
 * `ignored`: this deployment never consumes it. `dormant`: rows may exist and
 * wait for a handler that has not shipped. An `eventType` ending in `.` is a
 * prefix and covers every type that starts with it. An application may compute
 * its declarations at composition time, for example for a handler group an
 * environment switch turns off.
 * @beta
 */
export interface OutboxEventTypeDeclaration {
  readonly eventType: string;
  readonly state: OutboxEventTypeDeclarationState;
  readonly owner: string;
  readonly reason: string;
}

const entry = (eventType: string): OutboxEventTypeEntry => ({
  eventType,
  owner: eventType.slice(0, eventType.indexOf(".")),
});

/**
 * The platform vocabulary, sorted by event type.
 * @beta
 */
export const PLATFORM_OUTBOX_EVENT_TYPES: ReadonlyArray<OutboxEventTypeEntry> = Object.freeze([
  "channel.order.ingested",
  "commerce.checkout.expired",
  "commerce.checkout_recovery",
  "commerce.fulfillment.handed_over",
  "commerce.order.canceled",
  "commerce.order.cancelled",
  "commerce.order.paid",
  "commerce.order.paid.email",
  "commerce.order.refunded",
  "commerce.order.reorder_reminder",
  "commerce.order.review_effects",
  "commerce.order.review_request",
  "commerce.order_draft.abandoned.1h",
  "commerce.order_draft.abandoned.24h",
  "commerce.order_draft.abandoned.72h",
  "commerce.order_draft.created",
  "commerce.payment.failed",
  "commerce.payment_attempt.requested",
  "commerce.product.back_in_stock",
  "commerce.return.approved",
  "commerce.return.rejected",
  "commerce.settlement.settled",
  "commerce.shipment.delivered",
  "commerce.shipment.dispatched",
  "commerce.shipment.exception",
  "commerce.subscription_payment.requested",
  "commerce.subscription_payment.retry_requested",
  "personalization.declension_requested",
  "subscription.activation_action_required",
  "subscription.address_changed",
  "subscription.cancelled",
  "subscription.created",
  "subscription.cycle_skipped",
  "subscription.delivery_rescheduled",
  "subscription.package_changed",
  "subscription.pause_reminder_due",
  "subscription.paused",
  "subscription.renewal_upcoming",
  "subscription.resumed",
].map((eventType) => Object.freeze(entry(eventType))));

/**
 * The declaration that covers `eventType`: an exact declaration first, then the
 * longest matching prefix. Returns `undefined` when none covers it.
 * @beta
 */
export function matchOutboxEventTypeDeclaration(
  eventType: string,
  declarations: ReadonlyArray<OutboxEventTypeDeclaration>,
): OutboxEventTypeDeclaration | undefined {
  let match: OutboxEventTypeDeclaration | undefined;
  for (const declaration of declarations) {
    if (declaration.eventType === eventType) return declaration;
    if (
      declaration.eventType.endsWith(".") &&
      eventType.startsWith(declaration.eventType) &&
      (!match || declaration.eventType.length > match.eventType.length)
    ) {
      match = declaration;
    }
  }
  return match;
}
