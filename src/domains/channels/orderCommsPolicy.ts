// Pure buyer-comms policy for orders by sales source. Consumed by the outbox
// email-handler suppression wrapper (wave B6): marketplaces normally own buyer
// communication, so customer-facing transactional emails are skipped when the
// order's channel declares `buyer_comms_owner = 'channel'`.
//
// Suppression MUST stay handler-level: the checkout email reconciler
// back-fills paid-email outbox events for any paid order missing them, so a
// trigger-level suppression would be silently undone on the next reconcile.

export interface OrderBuyerCommsPolicy {
  sourceKind: string;
  buyerCommsOwner: string;
}

/**
 * True when the platform should send buyer-facing transactional email for the
 * order. `null` means the order has no channel policy row (a storefront order
 * or a pre-channel legacy order) — the platform owns comms, unchanged.
 */
export function platformOwnsBuyerEmail(
  policy: OrderBuyerCommsPolicy | null,
): boolean {
  return policy === null || policy.buyerCommsOwner !== "channel";
}
