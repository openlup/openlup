import type { AlertDecision } from "./observabilityContracts.js";
import type { OrderMoneyMismatchCode } from "./orderMoneyReconciliationContracts.js";

export type PromotionClaimTransition = "reserved" | "redeemed" | "released" | "late_paid";

type PromotionHealthEvidenceBase = { observedAt: string };

export type PromotionHealthEvidence =
  | (PromotionHealthEvidenceBase & {
      kind: "global_capacity_excess" | "customer_capacity_excess";
      promotionCodeId: string;
      scope: "global" | "customer";
      count: number;
      limit: number;
      claimId?: string;
      orderId?: string;
    })
  | (PromotionHealthEvidenceBase & {
      kind: "lifecycle_mismatch" | "orphan_claim";
      claimId: string;
      orderId: string;
      promotionCodeId?: string;
    })
  | (PromotionHealthEvidenceBase & {
      kind: "missing_claim";
      orderId: string;
    })
  | (PromotionHealthEvidenceBase & {
      kind: "stale_reservation" | "late_paid";
      claimId: string;
      promotionCodeId?: string;
      orderId?: string;
      blockingCapacity?: boolean;
    });

export type PromotionHealthSnapshot = {
  enabled: boolean;
  checkedClaimCount: number;
  transitionCounts24h: Record<PromotionClaimTransition, number>;
  reservedCount: number;
  redeemedCount: number;
  releasedCount: number;
  staleReservationCount: number;
  staleBlockingCapacityCount: number;
  lifecycleMismatchCount: number;
  missingClaimCount: number;
  latePaidCount24h: number;
  capacityExcessCount: number;
  promotionMoneyMismatchCount: number;
  evidence: PromotionHealthEvidence[];
};

/** Provider-neutral readback consumed by the promotion-health summarizer. */
export type PromotionHealthReadback = {
  aggregates: {
    claims: {
      reserved: number;
      redeemed: number;
      released: number;
      staleReserved: number;
      staleBlockingCapacity: number;
    };
    capacity: { overLimitCodes: number };
    lifecycleMismatchCount: number;
    missingClaimOrderCount: number;
    orphanClaimCount: number;
    promotionMoneyMismatchCount: number;
  };
  transitionCounts24h: Record<PromotionClaimTransition, number>;
  evidence: Array<
    | (PromotionHealthEvidenceBase & {
        kind: "capacity_exceeded";
        promotionCodeId: string;
        scope: "global" | "customer";
        count: number;
        limit: number;
        claimId?: string;
        orderId?: string;
      })
    | (PromotionHealthEvidenceBase & {
        kind: "lifecycle_mismatch" | "orphan_claim";
        claimId: string;
        orderId: string;
        promotionCodeId?: string;
      })
    | (PromotionHealthEvidenceBase & {
        kind: "missing_claim";
        orderId: string;
      })
    | (PromotionHealthEvidenceBase & {
        kind: "stale_reserved" | "late_paid";
        claimId: string;
        promotionCodeId?: string;
        orderId?: string;
        blockingCapacity?: boolean;
      })
  >;
  moneyEvidence: Array<{
    orderId: string;
    mismatchCodes: OrderMoneyMismatchCode[];
  }>;
};

const RUNBOOK = "/docs/platform/RUNTIME_AND_SELF_HOSTING.md";

export function collectPromotionHealthAlerts(
  decisions: AlertDecision[],
  snapshot: PromotionHealthSnapshot | undefined,
): void {
  if (!snapshot?.enabled) return;

  if (snapshot.capacityExcessCount > 0) {
    decisions.push({
      dedupeKey: "promotion_code_capacity_excess",
      severity: "p1",
      owner: "commerce/promotions",
      runbookUrl: RUNBOOK,
      title: "Promotion-code capacity exceeded",
      message: `${snapshot.capacityExcessCount} promotion code(s) exceed configured global or customer capacity.`,
      channels: ["webhook"],
      payload: {
        count: snapshot.capacityExcessCount,
        evidence: snapshot.evidence.filter((item) =>
          item.kind === "global_capacity_excess" || item.kind === "customer_capacity_excess").slice(0, 25),
      },
    });
  }
  const lifecycleCount = snapshot.lifecycleMismatchCount + snapshot.missingClaimCount;
  if (lifecycleCount > 0) {
    decisions.push({
      dedupeKey: "promotion_code_lifecycle_mismatch",
      severity: "p1",
      owner: "commerce/promotions",
      runbookUrl: RUNBOOK,
      title: "Promotion-code claim lifecycle mismatch",
      message: `${lifecycleCount} promotion claim/order lifecycle mismatch(es) exist.`,
      channels: ["webhook"],
      payload: {
        count: lifecycleCount,
        evidence: snapshot.evidence.filter((item) =>
          item.kind === "lifecycle_mismatch" || item.kind === "missing_claim" ||
          item.kind === "orphan_claim").slice(0, 25),
      },
    });
  }

  // v2 promotion checkout is permanently on (its ISSUE/HONOR rollout flags were
  // retired in PR 2243), so stale claims that block capacity are always a real
  // customer-facing block and always page.
  if (snapshot.staleBlockingCapacityCount > 0) {
    decisions.push({
      dedupeKey: "promotion_code_stale_blocking_capacity",
      severity: "p1",
      owner: "commerce/promotions",
      runbookUrl: RUNBOOK,
      title: "Stale promotion claims block checkout capacity",
      message: `${snapshot.staleBlockingCapacityCount} stale promotion reservation(s) block an active global or customer limit.`,
      channels: ["webhook"],
      payload: {
        count: snapshot.staleBlockingCapacityCount,
        evidence: snapshot.evidence.filter((item) =>
          item.kind === "stale_reservation" && item.blockingCapacity === true).slice(0, 25),
      },
    });
  }

  const diagnosticStaleCount = Math.max(
    0,
    snapshot.staleReservationCount - snapshot.staleBlockingCapacityCount,
  );
  if (diagnosticStaleCount > 0) {
    decisions.push({
      dedupeKey: "promotion_code_stale_reservations",
      severity: "p2",
      paging: "never",
      owner: "commerce/promotions",
      runbookUrl: RUNBOOK,
      title: "Promotion-code reservations are stale",
      message: `${diagnosticStaleCount} promotion-code reservation(s) exceeded expiry and grace without blocking active checkout capacity.`,
      channels: ["webhook"],
      payload: {
        count: diagnosticStaleCount,
        evidence: snapshot.evidence.filter((item) =>
          item.kind === "stale_reservation" && item.blockingCapacity !== true).slice(0, 25),
      },
    });
  }
  if (snapshot.latePaidCount24h > 0) {
    decisions.push({
      dedupeKey: "promotion_code_late_paid",
      severity: "p2",
      paging: "never",
      owner: "commerce/promotions",
      runbookUrl: RUNBOOK,
      title: "Released promotion claim paid late",
      message: `${snapshot.latePaidCount24h} released claim(s) transitioned to redeemed in the last 24 hours.`,
      channels: ["webhook"],
      payload: {
        count: snapshot.latePaidCount24h,
        evidence: snapshot.evidence.filter((item) => item.kind === "late_paid").slice(0, 25),
      },
    });
  }
}
