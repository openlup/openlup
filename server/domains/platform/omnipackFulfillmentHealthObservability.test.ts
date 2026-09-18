import { describe, expect, it } from "vitest";
import {
  collectFulfillmentHealthAttentionEvidence,
  maxFulfillmentHealthAge,
} from "./omnipackFulfillmentHealthObservability.js";

const now = new Date("2026-06-10T12:00:00.000Z");

describe("OmniPack fulfillment health observability companion", () => {
  it("derives missing commitment only from fulfillment orders and dispatch refs", () => {
    const input = {
      now,
      dispatchRefs: [],
      statusEvidence: [],
      orders: [
        paidOrder("order-missing-local", "2026-06-10T10:00:00.000Z"),
        paidOrder("order-missing-ref", "2026-06-10T10:30:00.000Z"),
        paidOrder("order-fresh-ref", "2026-06-10T11:59:00.000Z"),
        paidOrder("order-wrong-provider", "2026-06-10T10:30:00.000Z"),
      ],
      fulfillmentOrders: [
        fulfillment("ful-missing-ref", "order-missing-ref", "created", "2026-06-10T10:30:00.000Z"),
        fulfillment("ful-fresh-ref", "order-fresh-ref", "created", "2026-06-10T11:59:00.000Z"),
        {
          ...fulfillment("ful-wrong-provider", "order-wrong-provider", "created", "2026-06-10T10:30:00.000Z"),
          provider_kind: "simulator",
        },
      ],
      orderPaidOutboxEvents: [{
        id: "outbox-discarded",
        aggregate_id: "order-missing-local",
        event_type: "commerce.order.paid",
        status: "discarded",
        updated_at: "2026-06-10T09:00:00.000Z",
      }],
      // Legacy rows may still exist for audit, but they are not an input to health.
      providerCommands: [{
        id: "legacy-command-uncertain",
        fulfillment_order_id: "ful-missing-ref",
        provider_kind: "omnipack",
        command_kind: "dispatch_create",
        status: "uncertain",
      }],
    };

    const evidence = collectFulfillmentHealthAttentionEvidence(input);

    expect(evidence).toEqual([
      expect.objectContaining({
        orderId: "order-missing-local",
        fulfillmentOrderId: null,
        outboxEventId: "outbox-discarded",
        healthStatus: "missing_local_commitment",
        attentionReasons: ["order_paid_outbox_discarded"],
        oldestAgeSeconds: 10800,
      }),
      expect.objectContaining({
        orderId: "order-missing-ref",
        fulfillmentOrderId: "ful-missing-ref",
        dispatchRefFulfillmentOrderId: null,
        healthStatus: "missing_local_commitment",
        attentionReasons: ["paid_order_missing_dispatch_ref"],
        oldestAgeSeconds: 5400,
      }),
    ]);
    expect(JSON.stringify(evidence)).not.toContain("legacy-command-uncertain");
    expect(evidence.map((row) => row.orderId)).not.toContain("order-fresh-ref");
  });

  it("classifies stale submitting, uncertain, failed, and created refs without duplicate health pages", () => {
    const evidence = collectFulfillmentHealthAttentionEvidence({
      now,
      orders: [
        paidOrder("order-stale-submitting"),
        paidOrder("order-fresh-submitting"),
        paidOrder("order-uncertain"),
        paidOrder("order-failed"),
        paidOrder("order-created-without-id"),
        paidOrder("order-provider-ahead"),
        paidOrder("order-created-fresh"),
        paidOrder("order-acknowledged"),
      ],
      fulfillmentOrders: [
        fulfillment("ful-stale-submitting", "order-stale-submitting"),
        fulfillment("ful-fresh-submitting", "order-fresh-submitting"),
        fulfillment("ful-uncertain", "order-uncertain"),
        fulfillment("ful-failed", "order-failed"),
        fulfillment("ful-created-without-id", "order-created-without-id"),
        fulfillment("ful-provider-ahead", "order-provider-ahead"),
        fulfillment("ful-created-fresh", "order-created-fresh"),
        fulfillment("ful-acknowledged", "order-acknowledged", "label_created"),
      ],
      dispatchRefs: [
        dispatchRef("ful-stale-submitting", "submitting", "2026-06-10T11:54:59.000Z"),
        dispatchRef("ful-fresh-submitting", "submitting", "2026-06-10T11:55:00.000Z"),
        dispatchRef("ful-uncertain", "uncertain", "2026-06-10T11:59:00.000Z"),
        dispatchRef("ful-failed", "failed", "2026-06-10T11:58:00.000Z"),
        dispatchRef("ful-created-without-id", "created", "2026-06-10T11:57:00.000Z"),
        dispatchRef("ful-provider-ahead", "created", "2026-06-10T11:54:59.000Z", "omnipack-order-1"),
        dispatchRef("ful-created-fresh", "created", "2026-06-10T11:59:00.000Z", "omnipack-order-2"),
        dispatchRef("ful-acknowledged", "created", "2026-06-10T10:00:00.000Z", "omnipack-order-3"),
      ],
      statusEvidence: [],
    });

    expect(evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        orderId: "order-stale-submitting",
        healthStatus: "blocked_uncertain",
        attentionReasons: ["dispatch_ref_stale_submitting"],
        oldestAgeSeconds: 301,
      }),
      expect.objectContaining({
        orderId: "order-uncertain",
        healthStatus: "blocked_uncertain",
        attentionReasons: ["dispatch_ref_uncertain"],
        oldestAgeSeconds: 60,
      }),
      expect.objectContaining({
        orderId: "order-failed",
        healthStatus: "needs_attention",
        attentionReasons: ["dispatch_ref_failed"],
        oldestAgeSeconds: 120,
      }),
      expect.objectContaining({
        orderId: "order-created-without-id",
        healthStatus: "needs_attention",
        attentionReasons: ["dispatch_ref_created_without_provider_order_id"],
        oldestAgeSeconds: 180,
      }),
      expect.objectContaining({
        orderId: "order-provider-ahead",
        healthStatus: "provider_ahead",
        attentionReasons: ["provider_accepted_local_label_ack_missing"],
        oldestAgeSeconds: 301,
      }),
    ]));
    expect(evidence.map((row) => row.orderId)).not.toEqual(expect.arrayContaining([
      "order-fresh-submitting",
      "order-created-fresh",
      "order-acknowledged",
    ]));
    expect(evidence.every((row) => !("providerCommandId" in row))).toBe(true);
  });

  it("preserves status-evidence local-ahead classification after the grace window", () => {
    const evidence = collectFulfillmentHealthAttentionEvidence({
      now,
      orders: [
        paidOrder("order-local-ahead"),
        paidOrder("order-fresh-local-ahead"),
      ],
      fulfillmentOrders: [
        fulfillment("ful-local-ahead", "order-local-ahead", "handed_over", "2026-06-10T10:00:00.000Z"),
        fulfillment("ful-fresh-local-ahead", "order-fresh-local-ahead", "handed_over", "2026-06-10T11:45:00.000Z"),
      ],
      dispatchRefs: [
        dispatchRef("ful-local-ahead", "created", "2026-06-10T09:30:00.000Z", "omnipack-order-local-ahead"),
        dispatchRef("ful-fresh-local-ahead", "created", "2026-06-10T11:45:00.000Z", "omnipack-order-fresh-local-ahead"),
      ],
      statusEvidence: [
        {
          fulfillment_order_id: "ful-local-ahead",
          local_status: "provider_received",
          occurred_at: "2026-06-10T10:00:00.000Z",
        },
        {
          fulfillment_order_id: "ful-fresh-local-ahead",
          local_status: "provider_received",
          occurred_at: "2026-06-10T11:45:00.000Z",
        },
      ],
    });

    expect(evidence).toEqual([expect.objectContaining({
      orderId: "order-local-ahead",
      fulfillmentOrderId: "ful-local-ahead",
      dispatchRefFulfillmentOrderId: "ful-local-ahead",
      latestEvidenceFulfillmentOrderId: "ful-local-ahead",
      healthStatus: "local_ahead",
      attentionReasons: ["local_status_ahead_of_provider"],
      oldestAgeSeconds: 7200,
    })]);
  });

  it("uses only the newest dispatch ref for a fulfillment order", () => {
    const evidence = collectFulfillmentHealthAttentionEvidence({
      now,
      orders: [paidOrder("order-recovered")],
      fulfillmentOrders: [fulfillment("ful-recovered", "order-recovered", "label_created")],
      dispatchRefs: [
        dispatchRef("ful-recovered", "failed", "2026-06-10T10:00:00.000Z"),
        dispatchRef("ful-recovered", "created", "2026-06-10T11:00:00.000Z", "omnipack-order-recovered"),
      ],
      statusEvidence: [],
    });

    expect(evidence).toEqual([]);
  });

  it("keeps empty-system semantics and nullable age aggregation explicit", () => {
    expect(collectFulfillmentHealthAttentionEvidence({
      now,
      dispatchRefs: [],
      statusEvidence: [],
      orders: [],
      fulfillmentOrders: [],
      orderPaidOutboxEvents: [],
    })).toEqual([]);
    expect(maxFulfillmentHealthAge([null, undefined])).toBeNull();
    expect(maxFulfillmentHealthAge([5, null, 30, undefined])).toBe(30);
  });
});

function paidOrder(id: string, updatedAt = "2026-06-10T10:00:00.000Z") {
  return {
    id,
    status: "paid",
    updated_at: updatedAt,
    metadata: {
      selectedDelivery: { providerKind: "omnipack" },
      customerEmail: "buyer@example.com",
    },
  };
}

function fulfillment(
  id: string,
  orderId: string,
  status = "created",
  updatedAt = "2026-06-10T10:00:00.000Z",
) {
  return {
    id,
    order_id: orderId,
    provider_kind: "omnipack",
    status,
    updated_at: updatedAt,
  };
}

function dispatchRef(
  fulfillmentOrderId: string,
  status: string,
  updatedAt: string,
  providerOrderId: string | null = null,
) {
  return {
    fulfillment_order_id: fulfillmentOrderId,
    provider_order_id: providerOrderId,
    status,
    updated_at: updatedAt,
  };
}
