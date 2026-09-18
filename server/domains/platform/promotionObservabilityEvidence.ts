import type {
  OrderMoneyReconciliationEvidence,
  OrderMoneyReconciliationSnapshot,
} from "../../../src/domains/platform/orderMoneyReconciliationContracts.js";
import type {
  PromotionHealthEvidence,
  PromotionHealthReadback,
  PromotionHealthSnapshot,
} from "../../../src/domains/platform/promotionObservabilityEvaluator.js";

export function summarizePromotionObservability(input: {
  health: PromotionHealthReadback;
  orderMoney: OrderMoneyReconciliationSnapshot;
}): {
  orderMoneyReconciliation: OrderMoneyReconciliationSnapshot;
  promotionHealth: PromotionHealthSnapshot;
} {
  const orderMoneyReconciliation = mergePromotionMoneyEvidence(
    input.orderMoney,
    input.health.moneyEvidence,
    input.health.aggregates.promotionMoneyMismatchCount,
  );
  return {
    orderMoneyReconciliation,
    promotionHealth: {
      enabled: true,
      checkedClaimCount: input.health.aggregates.claims.reserved +
        input.health.aggregates.claims.redeemed + input.health.aggregates.claims.released,
      transitionCounts24h: input.health.transitionCounts24h,
      reservedCount: input.health.aggregates.claims.reserved,
      redeemedCount: input.health.aggregates.claims.redeemed,
      releasedCount: input.health.aggregates.claims.released,
      staleReservationCount: input.health.aggregates.claims.staleReserved,
      staleBlockingCapacityCount: input.health.aggregates.claims.staleBlockingCapacity,
      lifecycleMismatchCount: input.health.aggregates.lifecycleMismatchCount +
        input.health.aggregates.orphanClaimCount,
      missingClaimCount: input.health.aggregates.missingClaimOrderCount,
      latePaidCount24h: input.health.transitionCounts24h.late_paid,
      capacityExcessCount: input.health.aggregates.capacity.overLimitCodes,
      promotionMoneyMismatchCount: input.health.aggregates.promotionMoneyMismatchCount,
      evidence: input.health.evidence.map(mapEvidence),
    },
  };
}

export function mergePromotionMoneyEvidence(
  orderMoney: OrderMoneyReconciliationSnapshot,
  moneyEvidence: PromotionHealthReadback["moneyEvidence"],
  totalMismatchCount: number,
): OrderMoneyReconciliationSnapshot {
  const mismatchesByOrder = new Map(moneyEvidence.map((item) => [
    item.orderId,
    item.mismatchCodes,
  ]));
  const evidence = orderMoney.evidence.map((row) => {
    const promotionMismatches = mismatchesByOrder.get(row.orderId) ?? [];
    return promotionMismatches.length === 0 ? row : {
      ...row,
      mismatchCodes: [...new Set([...row.mismatchCodes, ...promotionMismatches])],
    };
  });
  const orderIds = new Set(orderMoney.evidence.map((row) => row.orderId));
  return {
    ...rebuildOrderMoneySnapshot(orderMoney, evidence),
    promotionMoneyMismatchCount: totalMismatchCount,
    promotionMoneyEvidenceCount: moneyEvidence.length,
    unmatchedPromotionMoneyEvidence: moneyEvidence.filter((row) => !orderIds.has(row.orderId)),
  };
}

function mapEvidence(value: PromotionHealthReadback["evidence"][number]): PromotionHealthEvidence {
  switch (value.kind) {
    case "capacity_exceeded":
      return {
        ...value,
        kind: value.scope === "customer" ? "customer_capacity_excess" : "global_capacity_excess",
      };
    case "stale_reserved":
      return { ...value, kind: "stale_reservation" };
    case "late_paid":
      return { ...value, kind: "late_paid" };
    case "lifecycle_mismatch":
    case "orphan_claim":
    case "missing_claim":
      return value;
  }
}

function rebuildOrderMoneySnapshot(
  original: OrderMoneyReconciliationSnapshot,
  evidence: OrderMoneyReconciliationEvidence[],
): OrderMoneyReconciliationSnapshot {
  return {
    ...original,
    mismatchCount: evidence.filter((row) => row.mismatchCodes.length > 0).length,
    byMode: Object.fromEntries(Object.keys(original.byMode).map((mode) => {
      const typedMode = mode as keyof typeof original.byMode;
      const matching = evidence.filter((row) => row.mode === typedMode);
      return [typedMode, {
        ...original.byMode[typedMode],
        checkedCount: matching.length,
        mismatchCount: matching.filter((row) => row.mismatchCodes.length > 0).length,
      }];
    })) as OrderMoneyReconciliationSnapshot["byMode"],
    evidence,
  };
}
