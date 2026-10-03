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

function freezeEntries<const T extends ReadonlyArray<OutboxEventTypeEntry>>(entries: T): T {
  for (const entry of entries) Object.freeze(entry);
  return Object.freeze(entries);
}

/**
 * The platform vocabulary, sorted by event type. Its type lists every entry, so
 * the API snapshot changes when a type is added or removed.
 * @beta
 */
export const PLATFORM_OUTBOX_EVENT_TYPES = freezeEntries([
  { eventType: "channel.order.ingested", owner: "channel" },
  { eventType: "commerce.checkout.expired", owner: "commerce" },
  { eventType: "commerce.checkout_recovery", owner: "commerce" },
  { eventType: "commerce.fulfillment.handed_over", owner: "commerce" },
  { eventType: "commerce.order.canceled", owner: "commerce" },
  { eventType: "commerce.order.cancelled", owner: "commerce" },
  { eventType: "commerce.order.paid", owner: "commerce" },
  { eventType: "commerce.order.paid.email", owner: "commerce" },
  { eventType: "commerce.order.refunded", owner: "commerce" },
  { eventType: "commerce.order.reorder_reminder", owner: "commerce" },
  { eventType: "commerce.order.review_effects", owner: "commerce" },
  { eventType: "commerce.order.review_request", owner: "commerce" },
  { eventType: "commerce.order_draft.abandoned.1h", owner: "commerce" },
  { eventType: "commerce.order_draft.abandoned.24h", owner: "commerce" },
  { eventType: "commerce.order_draft.abandoned.72h", owner: "commerce" },
  { eventType: "commerce.order_draft.created", owner: "commerce" },
  { eventType: "commerce.payment.failed", owner: "commerce" },
  { eventType: "commerce.payment_attempt.requested", owner: "commerce" },
  { eventType: "commerce.product.back_in_stock", owner: "commerce" },
  { eventType: "commerce.return.approved", owner: "commerce" },
  { eventType: "commerce.return.rejected", owner: "commerce" },
  { eventType: "commerce.settlement.settled", owner: "commerce" },
  { eventType: "commerce.shipment.delivered", owner: "commerce" },
  { eventType: "commerce.shipment.dispatched", owner: "commerce" },
  { eventType: "commerce.shipment.exception", owner: "commerce" },
  { eventType: "commerce.subscription_payment.requested", owner: "commerce" },
  { eventType: "commerce.subscription_payment.retry_requested", owner: "commerce" },
  { eventType: "personalization.declension_requested", owner: "personalization" },
  { eventType: "subscription.activation_action_required", owner: "subscription" },
  { eventType: "subscription.address_changed", owner: "subscription" },
  { eventType: "subscription.cancelled", owner: "subscription" },
  { eventType: "subscription.created", owner: "subscription" },
  { eventType: "subscription.cycle_skipped", owner: "subscription" },
  { eventType: "subscription.delivery_rescheduled", owner: "subscription" },
  { eventType: "subscription.package_changed", owner: "subscription" },
  { eventType: "subscription.pause_reminder_due", owner: "subscription" },
  { eventType: "subscription.paused", owner: "subscription" },
  { eventType: "subscription.renewal_upcoming", owner: "subscription" },
  { eventType: "subscription.resumed", owner: "subscription" },
] as const satisfies ReadonlyArray<OutboxEventTypeEntry>);

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
