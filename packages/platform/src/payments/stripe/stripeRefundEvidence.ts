/** A Charge observation is cumulative; its amount never replaces payment amount. */
export function stripeRefundEvidence(eventType: string, charge: Record<string, unknown>): {
  refundKind: "full" | "partial" | null;
  snapshot: { chargeId: string; amountRefundedMinor: number } | null;
} {
  if (eventType !== "charge.refunded") return { refundKind: null, snapshot: null };
  const amount = charge.amount;
  const refunded = charge.amount_refunded;
  const chargeId = charge.id;
  if (typeof chargeId !== "string" || !chargeId.trim()
    || typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0
    || typeof refunded !== "number" || !Number.isSafeInteger(refunded) || refunded <= 0 || refunded > amount) {
    return { refundKind: null, snapshot: null };
  }
  return {
    refundKind: refunded === amount ? "full" : "partial",
    snapshot: { chargeId, amountRefundedMinor: refunded },
  };
}
