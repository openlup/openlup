import type { StockWaitDeficit } from "./stockWait.js";

export type SubscriptionLifecycleFact = {
  factId: string; idempotencyKey: string; subscriptionId: string; clientId: string;
  cycleId: string | null; caseId: string | null; orderId: string | null;
  occurredAt: string; firstRecordedAt: string;
} & (
  | { kind: "payment_failed" | "payment_expired"; retryAttempt: number; nextRetryAt: string | null; failureClass: string | null; amountMinor: number | null; currency: string | null }
  | { kind: "payment_recovered"; paymentEvidenceRef: string }
  | { kind: "stock_wait_started" | "stock_wait_resumed"; frozenFingerprint: string;
      /** Checked native observation used by rendering.
       * @experimental
       */
      deficits?: readonly StockWaitDeficit[] }
  | { kind: "winback_eligible"; cancelledAt: string; paymentMethodRef: string }
  /** @experimental */
  | { kind: "predecessor_withdrawn"; frozenFingerprint: string; withdrawalPublicationId: string; predecessors: { skuId: string; skuCode: string }[] }
  /** @experimental */
  | { kind: "successor_offered"; proposalId: string; predecessorSkuId: string; successorSkuId: string; quoteHash: string; expiresAt: string }
);
/** M04 receives a descriptor; host owns copy, recipient, consent and transport. */
export interface SubscriptionLifecycleMessageDescriptor {
  fact: SubscriptionLifecycleFact; messageKey: string; templateSlug: string;
  recipientRef: string; locale: string; recoveryUrlPath: string | null;
}
export interface SubscriptionLifecycleMessagePort {
  enqueue(descriptor: SubscriptionLifecycleMessageDescriptor): Promise<{ notificationId: string; replayed: boolean }>;
}
