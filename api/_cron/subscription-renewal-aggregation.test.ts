import { describe, expect, it } from "vitest";
import {
  buildRenewalBudgetFailureResponse,
  buildRenewalRunReason,
  rowErrorReasonKey,
  summariseRenewalResults,
} from "./subscription-renewal-aggregation.js";

describe("subscription renewal aggregation", () => {
  it("counts renewal outcomes and dunning cases without provider details", () => {
    expect(summariseRenewalResults([
      result("charged"),
      result("requires_action", "case-1"),
      result("failed", "case-2"),
      result("skipped"),
    ], [{ subscription_id: "sub-error", reason: "rpc_failed" }])).toEqual({
      processed: 4,
      charged: 1,
      requires_action: 1,
      failed: 1,
      skipped: 1,
      errors: 1,
      dunning_cases_opened: 2,
    });
  });

  it("keeps durable job-run reasons compact and parseable", () => {
    expect(buildRenewalRunReason(
      { subscription_cycle_order_idempotency_conflict: 2 },
      { stripe_provider_not_configured: 1, tpay_provider_not_configured: 1 },
      { payment_method_cross_client: 1 },
    )).toBe(
      "provider_config_blocked:stripe_provider_not_configured=1,tpay_provider_not_configured=1;" +
      "payment_integrity_blocked:payment_method_cross_client=1;" +
      "row_errors:subscription_cycle_order_idempotency_conflict=2",
    );
    expect(rowErrorReasonKey("subscription_create_cycle_order failed: rpc=bad, semi;eq=value")).toBe(
      "rpc_bad_semi_eq_value",
    );
  });

  it("prefers lost-lease failure and otherwise exposes zero-progress budget exhaustion", () => {
    const aggregation = summariseRenewalResults([], []);
    expect(buildRenewalBudgetFailureResponse({
      released: false,
      exhaustedBeforeFirstRow: true,
      scanned: 2,
      startedRows: 0,
      deferredByBudget: 2,
      aggregation,
    })).toEqual({
      status: 409,
      body: expect.objectContaining({ ok: false, error: "renewal_lease_lost" }),
    });
    expect(buildRenewalBudgetFailureResponse({
      released: true,
      exhaustedBeforeFirstRow: true,
      scanned: 2,
      startedRows: 0,
      deferredByBudget: 2,
      aggregation,
    })).toEqual({
      status: 503,
      body: expect.objectContaining({ ok: false, error: "renewal_budget_exhausted_before_work" }),
    });
  });
});

function result(outcome: "charged" | "requires_action" | "failed" | "skipped", dunningCaseId?: string) {
  return {
    subscriptionId: "sub-1",
    outcome,
    cycleId: "cycle-1",
    cycleNumber: 1,
    orderId: "order-1",
    paymentIntentId: "pi-1",
    attemptStatus: outcome === "charged"
      ? "processing"
      : outcome === "skipped"
        ? null
        : outcome,
    replayed: false,
    dunningCaseId,
  } as const;
}
