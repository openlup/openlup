import type { ObservabilityEvidencePort } from "../../../../src/domains/platform/observabilityPorts.js";
import {
  mergePromotionMoneyEvidence,
  summarizePromotionObservability,
} from "../../../domains/platform/promotionObservabilityEvidence.js";
import { readPromotionHealthSnapshot } from "./promotionObservabilityRows.js";
import type { SupabaseObservabilityClient } from "./observabilityEvidenceQueries.js";

export function withPromotionObservabilityEvidence(
  base: ObservabilityEvidencePort,
  client: SupabaseObservabilityClient,
  controls: { healthEnabled: boolean },
): ObservabilityEvidencePort {
  return {
    async collectSnapshot(now) {
      const snapshot = await base.collectSnapshot(now);
      if (!snapshot.orderMoneyReconciliation) return snapshot;
      const health = await readPromotionHealthSnapshot(client as never, now, controls.healthEnabled);
      if (!controls.healthEnabled) {
        return {
          ...snapshot,
          orderMoneyReconciliation: mergePromotionMoneyEvidence(
            snapshot.orderMoneyReconciliation,
            health.moneyEvidence,
            health.aggregates.promotionMoneyMismatchCount,
          ),
        };
      }
      const promotion = summarizePromotionObservability({
        health,
        orderMoney: snapshot.orderMoneyReconciliation,
      });
      console.info(JSON.stringify({
        event: "promotion_code_health_snapshot",
        checkedAt: now.toISOString(),
        checkedClaimCount: promotion.promotionHealth.checkedClaimCount,
        transitionCounts24h: promotion.promotionHealth.transitionCounts24h,
        reservedCount: promotion.promotionHealth.reservedCount,
        redeemedCount: promotion.promotionHealth.redeemedCount,
        releasedCount: promotion.promotionHealth.releasedCount,
        staleReservationCount: promotion.promotionHealth.staleReservationCount,
        staleBlockingCapacityCount: promotion.promotionHealth.staleBlockingCapacityCount,
        lifecycleMismatchCount: promotion.promotionHealth.lifecycleMismatchCount,
        missingClaimCount: promotion.promotionHealth.missingClaimCount,
        latePaidCount24h: promotion.promotionHealth.latePaidCount24h,
        capacityExcessCount: promotion.promotionHealth.capacityExcessCount,
        promotionMoneyMismatchCount: promotion.promotionHealth.promotionMoneyMismatchCount,
      }));
      return {
        ...snapshot,
        orderMoneyReconciliation: promotion.orderMoneyReconciliation,
        promotionHealth: promotion.promotionHealth,
      };
    },
  };
}
