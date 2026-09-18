import { describe, expect, it } from "vitest";
import {
  buildDueCycleTriageContext,
  buildPaidFulfillmentTriageContext,
  isoOrNull,
  latestBy,
} from "./subscriptionRenewalTriageContext.js";

describe("subscription renewal triage context", () => {
  it("summarizes future templates without leaking raw subscription metadata", () => {
    const context = buildDueCycleTriageContext({
      id: "sub_1",
      status: "active",
      next_cycle_at: "2026-07-03T11:00:00.000Z",
      template_version: "4",
      package_template: { lines: [{ qty: 1 }, { quantity: 2 }] },
      metadata: { paymentMethodRef: "secret_pm_ref" },
    });

    expect(context).toMatchObject({
      localPaymentStatus: null,
      fulfillmentEligibilityReason: "cycle_order_missing",
      fulfillmentRecoveryPosture: "not_retryable",
      outboxAvailableAt: null,
      outboxAttempts: null,
      futureTemplateSummary: {
        status: "active",
        nextCycleAt: "2026-07-03T11:00:00.000Z",
        templateVersion: 4,
        lineCount: 2,
        totalQuantity: 3,
      },
    });
    expect(JSON.stringify(context)).not.toContain("secret_pm_ref");
    expect(JSON.stringify(context)).not.toContain("paymentMethodRef");
  });

  it("classifies failed order-paid outbox rows as automatic retry/watch", () => {
    const failed = buildPaidFulfillmentTriageContext({
      order: {
        id: "order_1",
        mode: "subscription_cycle",
        status: "paid",
        subscription_id: "sub_1",
        subscription_cycle_id: "cycle_1",
        metadata: { lines: [{ quantity: 2 }] },
      },
      subscription: { id: "sub_1", status: "active", next_cycle_at: "2026-08-03T11:00:00.000Z" },
      cycle: {
        id: "cycle_1",
        subscription_id: "sub_1",
        status: "paid",
        order_id: "order_1",
        scheduled_at: "2026-07-03T11:00:00.000Z",
      },
      paymentIntent: { order_id: "order_1", status: "succeeded" },
      outboxEvent: {
        id: "outbox_1",
        event_type: "commerce.order.paid",
        aggregate_id: "order_1",
        status: "failed",
        available_at: "2026-07-03T11:16:00.000Z",
        created_at: "2026-07-03T11:01:00.000Z",
        attempts: 3,
      },
    });

    expect(failed).toMatchObject({
      localPaymentStatus: "succeeded",
      subscriptionCycleStatus: "paid",
      orderStatus: "paid",
      outboxStatus: "failed",
      outboxAvailableAt: "2026-07-03T11:16:00.000Z",
      outboxAttempts: 3,
      fulfillmentEligibilityReason: "order_paid_outbox_failed_retrying",
      fulfillmentRecoveryPosture: "wait_for_outbox",
      lockedCycleSummary: { status: "paid", lineCount: 1, totalQuantity: 2 },
    });
  });

  it("classifies terminal outbox states without implying unsafe replay", () => {
    const discarded = buildPaidFulfillmentTriageContext({
      ...basePaidInput(),
      outboxEvent: {
        id: "outbox_discarded",
        event_type: "commerce.order.paid",
        aggregate_id: "order_1",
        status: "discarded",
        available_at: "2026-07-03T11:16:00.000Z",
        created_at: "2026-07-03T11:01:00.000Z",
        attempts: 8,
      },
    });

    expect(discarded).toMatchObject({
      outboxStatus: "discarded",
      outboxAvailableAt: "2026-07-03T11:16:00.000Z",
      outboxAttempts: 8,
      fulfillmentEligibilityReason: "order_paid_outbox_discarded",
      fulfillmentRecoveryPosture: "existing_outbox_replay_required",
    });

    const processed = buildPaidFulfillmentTriageContext({
      ...basePaidInput(),
      outboxEvent: {
        id: "outbox_2",
        event_type: "commerce.order.paid",
        aggregate_id: "order_1",
        status: "processed",
        created_at: "2026-07-03T11:01:00.000Z",
      },
    });
    expect(processed.fulfillmentRecoveryPosture).toBe("manual_review");
    expect(processed.fulfillmentEligibilityReason).toBe("order_paid_outbox_processed_without_fulfillment");
  });

  it("keeps live and missing outbox rows separate for operators", () => {
    const pending = buildPaidFulfillmentTriageContext({
      ...basePaidInput(),
      outboxEvent: {
        id: "outbox_pending",
        event_type: "commerce.order.paid",
        aggregate_id: "order_1",
        status: "pending",
        available_at: "2026-07-03T11:02:00.000Z",
        created_at: "2026-07-03T11:01:00.000Z",
        attempts: 0,
      },
    });
    expect(pending).toMatchObject({
      outboxStatus: "pending",
      outboxAvailableAt: "2026-07-03T11:02:00.000Z",
      outboxAttempts: 0,
      fulfillmentEligibilityReason: "order_paid_outbox_pending",
      fulfillmentRecoveryPosture: "wait_for_outbox",
    });

    const missing = buildPaidFulfillmentTriageContext(basePaidInput());
    expect(missing).toMatchObject({
      outboxStatus: "missing",
      outboxAvailableAt: null,
      outboxAttempts: null,
      fulfillmentEligibilityReason: "order_paid_outbox_missing",
      fulfillmentRecoveryPosture: "manual_review",
    });
  });

  it("keeps latest row selection and ISO parsing deterministic", () => {
    expect(isoOrNull("not-a-date")).toBeNull();
    expect(isoOrNull("2026-07-03T11:00:00Z")).toBe("2026-07-03T11:00:00.000Z");

    const rows = latestBy([
      { id: "old", order_id: "order_1", updated_at: "2026-07-03T10:00:00.000Z" },
      { id: "new", order_id: "order_1", updated_at: "2026-07-03T11:00:00.000Z" },
    ], (row) => row.order_id);
    expect(rows.get("order_1")?.id).toBe("new");
  });
});

function basePaidInput(): Parameters<typeof buildPaidFulfillmentTriageContext>[0] {
  return {
    order: {
      id: "order_1",
      mode: "subscription_cycle",
      status: "paid",
      subscription_id: "sub_1",
      subscription_cycle_id: "cycle_1",
    },
    subscription: { id: "sub_1", status: "active", next_cycle_at: "2026-08-03T11:00:00.000Z" },
    cycle: {
      id: "cycle_1",
      subscription_id: "sub_1",
      status: "paid",
      order_id: "order_1",
      scheduled_at: "2026-07-03T11:00:00.000Z",
    },
    paymentIntent: { order_id: "order_1", status: "succeeded" },
    outboxEvent: undefined,
  };
}
