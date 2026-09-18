import { describe, expect, it } from "vitest";
import {
  calculateOmnipackProviderOpsSla,
  deriveOmnipackProviderOps,
} from "./omnipackProviderOps.js";

describe("OmniPack provider ops SLA", () => {
  it("skips Saturday when Friday dispatch would otherwise breach during the pause", () => {
    const sla = calculateOmnipackProviderOpsSla({
      dispatchedAt: "2026-07-03T10:00:00.000Z",
      now: new Date("2026-07-04T12:00:00.000Z"),
    });

    expect(sla).toMatchObject({
      status: "paused_non_shipping_day",
      deadlineAt: "2026-07-05T10:00:00.000Z",
    });
  });

  it("does not mark Saturday dispatch as critical while Saturday is paused", () => {
    const sla = calculateOmnipackProviderOpsSla({
      dispatchedAt: "2026-07-04T09:00:00.000Z",
      now: new Date("2026-07-04T18:00:00.000Z"),
    });

    expect(sla).toMatchObject({
      status: "paused_non_shipping_day",
      deadlineAt: "2026-07-05T22:00:00.000Z",
    });
  });

  it("counts Sunday as an operational day", () => {
    const sla = calculateOmnipackProviderOpsSla({
      dispatchedAt: "2026-07-05T09:00:00.000Z",
      now: new Date("2026-07-06T08:00:00.000Z"),
    });

    expect(sla).toMatchObject({
      status: "watch",
      deadlineAt: "2026-07-06T09:00:00.000Z",
      remainingOperationalMinutes: 60,
    });
  });
});

describe("OmniPack provider ops status", () => {
  const fulfillmentOrder = {
    id: "fulfillment-1",
    order_id: "order-1",
    status: "label_created" as const,
    provider_kind: "omnipack",
  };
  const dispatchRef = {
    fulfillment_order_id: "fulfillment-1",
    provider_order_id: "OP-1001",
    dispatch_mode: "stage",
    status: "created",
    error: null,
    created_at: "2026-07-05T09:00:00.000Z",
    updated_at: "2026-07-05T09:00:00.000Z",
  };

  it("marks dispatched OmniPack orders without picked evidence as pending pick", () => {
    expect(deriveOmnipackProviderOps({
      fulfillmentOrders: [fulfillmentOrder],
      dispatchRefs: [dispatchRef],
      statusEvidence: [],
      now: new Date("2026-07-05T10:00:00.000Z"),
    })).toMatchObject({
      status: "omnipack_dispatched_not_picked",
      providerOrderId: "OP-1001",
      sla: { status: "ok" },
    });
  });

  it("moves picked orders out of dispatched-not-picked without treating them as shipped", () => {
    expect(deriveOmnipackProviderOps({
      fulfillmentOrders: [fulfillmentOrder],
      dispatchRefs: [dispatchRef],
      statusEvidence: [{
        fulfillment_order_id: "fulfillment-1",
        provider_status: "packed",
        provider_sub_status: "order.picked",
        local_status: "packed",
        evidence_kind: "webhook",
        occurred_at: "2026-07-05T10:00:00.000Z",
        created_at: "2026-07-05T10:00:00.000Z",
      }],
    })).toMatchObject({
      status: "omnipack_picked_not_shipped",
      providerOrderId: "OP-1001",
      sla: null,
    });
  });
});
