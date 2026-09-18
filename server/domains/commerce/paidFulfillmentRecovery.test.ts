import { describe, expect, it } from "vitest";
import {
  collectPaidFulfillmentRecoveryCandidates,
} from "./paidFulfillmentRecovery.js";
import { requeueDiscardedOrderPaidOutboxEvents } from "../../adapters/supabase/paidFulfillmentRecoveryOpsPort.js";
import {
  paidFulfillmentRecoveryActionSchema,
  paidFulfillmentRecoveryReasonSchema,
} from "../../../src/domains/commerce/recoveryOpsContracts.js";

const now = new Date("2026-07-12T12:00:00.000Z");

describe("paid fulfillment recovery", () => {
  it("accepts direct-dispatch values and rejects retired command aliases", () => {
    expect(paidFulfillmentRecoveryActionSchema.safeParse("inspect_missing_provider_command").success).toBe(false);
    expect(paidFulfillmentRecoveryReasonSchema.safeParse("omnipack_fulfillment_without_provider_command").success).toBe(false);
    expect(paidFulfillmentRecoveryActionSchema.parse("inspect_missing_dispatch_ref"))
      .toBe("inspect_missing_dispatch_ref");
    expect(paidFulfillmentRecoveryReasonSchema.parse("omnipack_fulfillment_without_dispatch_ref"))
      .toBe("omnipack_fulfillment_without_dispatch_ref");
  });

  it("classifies discarded order-paid rows as safe local requeue candidates", () => {
    const plan = collectPaidFulfillmentRecoveryCandidates({
      now,
      orders: [{
        id: "order_1",
        status: "paid",
        mode: "one_time",
        updated_at: "2026-07-12T10:30:00.000Z",
      }],
      fulfillmentOrders: [],
      orderPaidOutboxEvents: [{
        id: "outbox_1",
        event_type: "commerce.order.paid",
        aggregate_id: "order_1",
        status: "discarded",
        attempts: 8,
        created_at: "2026-07-12T10:31:00.000Z",
      }],
    });

    expect(plan.checkedOrders).toBe(1);
    expect(plan.candidates).toEqual([{
      orderId: "order_1",
      orderStatus: "paid",
      orderMode: "one_time",
      fulfillmentOrderId: null,
      providerKind: null,
      dispatchRefId: null,
      dispatchStatus: null,
      outboxEventId: "outbox_1",
      outboxStatus: "discarded",
      outboxAttempts: 8,
      reason: "order_paid_outbox_discarded",
      recommendedAction: "requeue_discarded_order_paid_outbox",
      recoveryPosture: "automatic_local_requeue_safe",
      ageSeconds: 5400,
    }]);
  });

  it("keeps missing and processed order-paid evidence in operator review, not blind replay", () => {
    const plan = collectPaidFulfillmentRecoveryCandidates({
      now,
      orders: [
        { id: "missing_outbox", status: "paid", updated_at: "2026-07-12T10:00:00.000Z" },
        { id: "processed_without_effect", status: "fulfillment_pending", updated_at: "2026-07-12T10:05:00.000Z" },
      ],
      fulfillmentOrders: [],
      orderPaidOutboxEvents: [{
        id: "outbox_processed",
        event_type: "commerce.order.paid",
        aggregate_id: "processed_without_effect",
        status: "processed",
        attempts: 1,
        created_at: "2026-07-12T10:06:00.000Z",
      }],
    });

    expect(plan.candidates.map((candidate) => ({
      orderId: candidate.orderId,
      reason: candidate.reason,
      recommendedAction: candidate.recommendedAction,
      recoveryPosture: candidate.recoveryPosture,
    }))).toEqual([
      {
        orderId: "missing_outbox",
        reason: "order_paid_outbox_missing",
        recommendedAction: "inspect_missing_order_paid_outbox",
        recoveryPosture: "operator_review_required",
      },
      {
        orderId: "processed_without_effect",
        reason: "order_paid_outbox_processed_without_fulfillment",
        recommendedAction: "inspect_processed_without_effect",
        recoveryPosture: "operator_review_required",
      },
    ]);
  });

  it("flags OmniPack fulfillment rows without dispatch refs", () => {
    const plan = collectPaidFulfillmentRecoveryCandidates({
      now,
      orders: [{ id: "order_omni", status: "paid", updated_at: "2026-07-12T10:00:00.000Z" }],
      fulfillmentOrders: [{
        id: "ful_omni",
        order_id: "order_omni",
        provider_kind: "omnipack",
        status: "created",
        updated_at: "2026-07-12T10:02:00.000Z",
      }],
      orderPaidOutboxEvents: [{
        id: "outbox_omni",
        event_type: "commerce.order.paid",
        aggregate_id: "order_omni",
        status: "discarded",
        attempts: 8,
        created_at: "2026-07-12T10:01:00.000Z",
      }],
    });

    expect(plan.candidates).toEqual([expect.objectContaining({
      orderId: "order_omni",
      fulfillmentOrderId: "ful_omni",
      providerKind: "omnipack",
      dispatchRefId: null,
      dispatchStatus: null,
      reason: "omnipack_fulfillment_without_dispatch_ref",
      recommendedAction: "inspect_missing_dispatch_ref",
      recoveryPosture: "operator_review_required",
    })]);
  });

  it("does not escalate a freshly created obligation before the dispatch grace expires", () => {
    const plan = collectPaidFulfillmentRecoveryCandidates({
      now,
      orders: [{ id: "order_fresh_obligation", status: "paid", updated_at: "2026-07-12T10:00:00.000Z" }],
      fulfillmentOrders: [{
        id: "ful_fresh_obligation",
        order_id: "order_fresh_obligation",
        provider_kind: "omnipack",
        status: "created",
        updated_at: "2026-07-12T11:59:00.000Z",
      }],
      omnipackDispatchRefs: [],
      orderPaidOutboxEvents: [],
    });

    expect(plan.checkedOrders).toBe(1);
    expect(plan.candidates).toEqual([]);
  });

  it.each([
    {
      name: "fresh draft",
      ref: dispatchRef({ status: "draft", updated_at: "2026-07-12T11:59:00.000Z" }),
      reason: "omnipack_dispatch_in_progress",
      action: "monitor_dispatch",
      posture: "wait_for_existing_automation",
    },
    {
      name: "fresh submitting",
      ref: dispatchRef({ status: "submitting", updated_at: "2026-07-12T11:55:01.000Z" }),
      reason: "omnipack_dispatch_in_progress",
      action: "monitor_dispatch",
      posture: "wait_for_existing_automation",
    },
    {
      name: "stale submitting",
      ref: dispatchRef({ status: "submitting", updated_at: "2026-07-12T11:54:59.000Z" }),
      reason: "omnipack_dispatch_submission_stale",
      action: "inspect_stale_dispatch_submission",
      posture: "operator_review_required",
    },
    {
      name: "uncertain",
      ref: dispatchRef({ status: "uncertain" }),
      reason: "omnipack_dispatch_outcome_uncertain",
      action: "inspect_uncertain_dispatch",
      posture: "operator_review_required",
    },
    {
      name: "failed",
      ref: dispatchRef({ status: "failed" }),
      reason: "omnipack_dispatch_failed",
      action: "inspect_failed_dispatch",
      posture: "operator_review_required",
    },
    {
      name: "created without provider identity",
      ref: dispatchRef({ status: "created", provider_order_id: null }),
      reason: "omnipack_dispatch_created_without_provider_order_id",
      action: "inspect_created_dispatch_without_provider_order_id",
      posture: "operator_review_required",
    },
  ])("classifies $name from dispatch evidence without offering provider retry", ({ ref, reason, action, posture }) => {
    const plan = omnipackPlan([ref]);

    expect(plan.candidates).toEqual([expect.objectContaining({
      dispatchRefId: "82222222-2222-4222-8222-222222222221",
      dispatchStatus: ref.status,
      reason,
      recommendedAction: action,
      recoveryPosture: posture,
    })]);
  });

  it("treats created dispatch with provider identity as healthy", () => {
      const plan = omnipackPlan([
        dispatchRef({ status: "created", provider_order_id: "omnipack-order-1" }),
      ]);

      expect(plan.checkedOrders).toBe(1);
      expect(plan.candidates).toEqual([]);
  });

  it("does not flag fresh orders, fulfilled orders, or healthy direct dispatches", () => {
    const plan = collectPaidFulfillmentRecoveryCandidates({
      now,
      orders: [
        { id: "fresh", status: "paid", updated_at: "2026-07-12T11:45:00.000Z" },
        { id: "delivered", status: "fulfilled", updated_at: "2026-07-12T10:00:00.000Z" },
        { id: "simulator", status: "paid", updated_at: "2026-07-12T10:00:00.000Z" },
        { id: "omni_ok", status: "paid", updated_at: "2026-07-12T10:00:00.000Z" },
      ],
      fulfillmentOrders: [
        { id: "ful_sim", order_id: "simulator", provider_kind: "simulator", updated_at: "2026-07-12T10:02:00.000Z" },
        { id: "ful_ok", order_id: "omni_ok", provider_kind: "omnipack", updated_at: "2026-07-12T10:02:00.000Z" },
      ],
      omnipackDispatchRefs: [dispatchRef({
        fulfillment_order_id: "ful_ok",
        status: "created",
        provider_order_id: "omnipack-order-ok",
      })],
      orderPaidOutboxEvents: [],
    });

    expect(plan.candidates).toEqual([]);
  });

  it("requeues only selected discarded commerce.order.paid rows through the existing DLQ RPC", async () => {
    const calls: Array<{ functionName: string; args: Record<string, unknown> }> = [];
    const result = await requeueDiscardedOrderPaidOutboxEvents({
      rpc: async (functionName, args) => {
        calls.push({ functionName, args });
        return {
          data: [{ id: "event_1" }, { id: "event_2" }],
          error: null,
        };
      },
    }, {
      eventIds: ["event_1", "event_1", "event_2"],
      requeuedBy: "paid_fulfillment_reconciler",
      reason: "order_paid_outbox_discarded",
    });

    expect(result).toEqual({ requeuedCount: 2, eventIds: ["event_1", "event_2"] });
    expect(calls).toEqual([{
      functionName: "outbox_requeue_discarded",
      args: {
        p_event_ids: ["event_1", "event_2"],
        p_event_type: "commerce.order.paid",
        p_limit: 2,
        p_requeued_by: "paid_fulfillment_reconciler",
        p_reason: "order_paid_outbox_discarded",
      },
    }]);
  });
});

function omnipackPlan(dispatchRefs: ReturnType<typeof dispatchRef>[]) {
  return collectPaidFulfillmentRecoveryCandidates({
    now,
    orders: [{ id: "order_dispatch", status: "paid", updated_at: "2026-07-12T10:00:00.000Z" }],
    fulfillmentOrders: [{
      id: "ful_dispatch",
      order_id: "order_dispatch",
      provider_kind: "omnipack",
      status: "created",
      updated_at: "2026-07-12T10:02:00.000Z",
    }],
    omnipackDispatchRefs: dispatchRefs,
    orderPaidOutboxEvents: [],
  });
}

function dispatchRef(overrides: {
  id?: string | null;
  fulfillment_order_id?: string;
  provider_order_id?: string | null;
  status?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
} = {}) {
  return {
    id: "82222222-2222-4222-8222-222222222221",
    fulfillment_order_id: "ful_dispatch",
    provider_order_id: null,
    status: "draft",
    created_at: "2026-07-12T11:50:00.000Z",
    updated_at: "2026-07-12T11:50:00.000Z",
    ...overrides,
  };
}
