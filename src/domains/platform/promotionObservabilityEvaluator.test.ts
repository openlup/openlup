import { describe, expect, it } from "vitest";
import type { AlertDecision } from "./observabilityContracts.js";
import { collectPromotionHealthAlerts } from "./promotionObservabilityEvaluator.js";
import type { PromotionHealthSnapshot } from "./promotionObservabilityEvaluator.js";

describe("promotion observability evaluator", () => {
  it("pages confirmed lifecycle/cap anomalies and stale capacity that can block an active rollout", () => {
    const decisions: AlertDecision[] = [];
    collectPromotionHealthAlerts(decisions, snapshot());

    expect(decisions.map((decision) => [decision.dedupeKey, decision.severity, decision.paging])).toEqual([
      ["promotion_code_capacity_excess", "p1", undefined],
      ["promotion_code_lifecycle_mismatch", "p1", undefined],
      ["promotion_code_stale_blocking_capacity", "p1", undefined],
      ["promotion_code_late_paid", "p2", "never"],
    ]);
  });

  it("pages aggregate count truth even when the bounded evidence sample is empty", () => {
    const decisions: AlertDecision[] = [];
    collectPromotionHealthAlerts(decisions, {
      ...snapshot(),
      evidence: [],
      staleReservationCount: 0,
      staleBlockingCapacityCount: 0,
      latePaidCount24h: 0,
    });
    expect(decisions.map((decision) => decision.dedupeKey)).toEqual([
      "promotion_code_capacity_excess",
      "promotion_code_lifecycle_mismatch",
    ]);
  });

  it("emits nothing while the promotion observer is disabled", () => {
    const decisions: AlertDecision[] = [];
    collectPromotionHealthAlerts(decisions, { ...snapshot(), enabled: false });
    expect(decisions).toEqual([]);
  });

  it("always pages on stale claims that block checkout capacity", () => {
    // v2 promotion checkout is permanent (ISSUE/HONOR retired in PR 2243), so a
    // claim blocking an active limit is always a real customer-facing block.
    // Previously this downgraded to a non-paging p2 whenever both flags read
    // false — which, after retirement, would have been forever.
    const decisions: AlertDecision[] = [];
    collectPromotionHealthAlerts(decisions, { ...snapshot() });

    expect(decisions.map((decision) => decision.dedupeKey)).toContain(
      "promotion_code_stale_blocking_capacity",
    );
    expect(decisions.map((decision) => decision.dedupeKey)).not.toContain(
      "promotion_code_stale_reservations",
    );
  });

  it("reports a non-blocking stale reservation as the non-paging diagnostic", () => {
    const decisions: AlertDecision[] = [];
    collectPromotionHealthAlerts(decisions, {
      ...snapshot(),
      staleBlockingCapacityCount: 0,
      evidence: snapshot().evidence.map((item) =>
        item.kind === "stale_reservation" ? { ...item, blockingCapacity: false } : item),
    });

    const stale = decisions.find((decision) =>
      decision.dedupeKey === "promotion_code_stale_reservations");
    expect(stale?.severity).toBe("p2");
    expect(stale?.paging).toBe("never");
    expect(decisions.map((decision) => decision.dedupeKey)).not.toContain(
      "promotion_code_stale_blocking_capacity",
    );
  });
});

function snapshot(): PromotionHealthSnapshot {
  return {
    enabled: true,
    checkedClaimCount: 2,
    transitionCounts24h: { reserved: 0, redeemed: 0, released: 0, late_paid: 1 },
    reservedCount: 1,
    redeemedCount: 1,
    releasedCount: 0,
    staleReservationCount: 1,
    staleBlockingCapacityCount: 1,
    lifecycleMismatchCount: 1,
    missingClaimCount: 0,
    latePaidCount24h: 1,
    capacityExcessCount: 1,
    promotionMoneyMismatchCount: 0,
    evidence: [
      { kind: "global_capacity_excess", promotionCodeId: "code-1", scope: "global", count: 2, limit: 1, observedAt: "2026-07-15T12:00:00.000Z" },
      { kind: "lifecycle_mismatch", claimId: "claim-1", orderId: "order-1", observedAt: "2026-07-15T12:00:00.000Z" },
      { kind: "stale_reservation", claimId: "claim-1", orderId: "order-1", blockingCapacity: true, observedAt: "2026-07-15T12:00:00.000Z" },
      { kind: "late_paid", claimId: "claim-2", orderId: "order-2", observedAt: "2026-07-15T12:00:00.000Z" },
    ],
  };
}
