export function omnipackHandoffAccountingInvoiceIdempotencyKey(
  fulfillmentOrderId: string,
): string {
  // Keep the original webhook key as the channel-neutral handoff key. The
  // webhook and reconciliation poller can observe the same provider transition,
  // so both must converge on one accounting request identity.
  return `omnipack:webhook:${fulfillmentOrderId}:accounting-invoice`;
}
