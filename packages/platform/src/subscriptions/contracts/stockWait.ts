import type { RenewalFrozenSnapshot, RenewalReadback, RenewalSchedule } from "./renewal.js";
export interface StockWaitRecoveryBinding {
  caseId: string | null; cycleId: string | null; orderId: string | null;
  paymentId: string | null; engineIdempotencyKey: string | null;
}
export interface StockWaitDeficit {
  skuId: string; sku: string; displayName: string; size: string | null;
  required: number; reserved: number; available: number; missing: number;
}
export interface StockWaitCase extends RenewalSchedule {
  caseId: string; clientId: string; state: "waiting" | "stock_secured" | "resumed" | "closed";
  frozenSnapshot: RenewalFrozenSnapshot; frozenFingerprint: string;
  binding: StockWaitRecoveryBinding; deficits: readonly StockWaitDeficit[];
  fulfillmentRef: string | null; blockReason: string | null;
  openedAt: string; checkedAt: string | null; selectedAt: string | null;
  securedAt: string | null; resumedAt: string | null; closedAt: string | null;
  startedNoticeKey: string; resumedNoticeKey: string; noticeEligible: boolean;
}
/** All-line reserve/reacquire and the wait transition share a DB transaction.
 * A shortage rolls back the subtransaction, retaining previous commitments;
 * record the wait outside that failed subtransaction. Technical failure is unknown.
 */
export interface StockWaitStorePort {
  listCandidates(input: { limit: number; asOf: string }): Promise<StockWaitCase[]>;
  readFrozenCase(input: StockWaitRecoveryBinding): Promise<StockWaitCase | null>;
  reserveAndTransition(input: { caseId: string; frozenFingerprint: string; now: string }): Promise<StockWaitCase>;
  /** Only elapsed, unprepared, unacknowledged, stock-only refusals may reset.
   * Requires unchanged schedule/fingerprint and no payment artifacts or outcomes.
   * Rotate fencing generation atomically with reacquisition. Never reset ambiguity.
   */
  recoverRefusedSchedule(input: { operationId: string; caseId: string; claimGeneration: number; frozenFingerprint: string; scheduledAt: string; now: string }): Promise<
    | { outcome: "recovered"; operation: RenewalReadback; replayed: boolean }
    | { outcome: "refused"; reason: "not_stock_only" | "external_ownership" | "stale_snapshot" | "lease_active" | "inventory_unavailable" }>;
}
