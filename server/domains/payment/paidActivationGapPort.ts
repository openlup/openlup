/**
 * The neutral paid-activation-gap surface the domain depends on: a bounded scan
 * that repairs whatever it finds, and a single question about one subscription
 * that a reminder must ask before it writes to a payer.
 *
 * The two methods are the MANAGED shape exactly as its callers already use it —
 * the port names no client, table, routine or provider. It is deliberately NOT
 * the union of every bundle's gap vocabulary: the direct-Postgres spine
 * (`server/adapters/postgres/subscriptionActivation.ts`) keys gap-openness by
 * ORDER, because a provisional activation there exists before any subscription
 * does, and it repairs rather than enqueues. Those are different questions with
 * different answers, so that adapter keeps its own richer interface and does not
 * implement this port. Widening this one to cover both would be a parity claim
 * neither side could honour.
 */
export interface PaidActivationGapPort {
  /** Scan at most `limit` open gaps, enqueueing a reminder for each and counting the overdue. */
  reconcile(limit?: number): Promise<{ enqueued: number; overdue: number }>;
  /** Whether this subscription's paid-activation gap is still open right now. */
  isStillOpen(subscriptionId: string): Promise<boolean>;
}
