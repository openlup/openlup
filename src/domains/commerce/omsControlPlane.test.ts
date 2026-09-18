import { describe, expect, it } from "vitest";
import {
  omsControlPlaneActions,
  omsControlPlaneListRequestSchema,
  omsControlPlaneOrderSchema,
} from "./omsControlPlane.js";

describe("OMS control-plane contract", () => {
  it("accepts only the explicit versioned view and bounded paging", () => {
    expect(omsControlPlaneListRequestSchema.parse({ view: "control_plane_v1" }))
      .toEqual({ view: "control_plane_v1", page: 1, pageSize: 25 });
    expect(() => omsControlPlaneListRequestSchema.parse({ view: "legacy" })).toThrow();
    expect(() => omsControlPlaneListRequestSchema.parse({ view: "control_plane_v1", provider: "private" })).toThrow();
  });

  it("keeps provider, customer and address facts outside the strict projection", () => {
    const neutral = {
      orderId: "42222222-2222-4222-8222-222222222221", status: "paid", sourceKind: "storefront",
      sourceOrderRef: null, money: { amountMinor: 1000, currency: "XTS" }, shipmentStatus: null,
      activeHoldCount: 0, activeHoldReasons: [], actions: omsControlPlaneActions("paid", 0),
      createdAt: "2026-08-17T07:00:00.000Z", updatedAt: "2026-08-17T08:00:00.000Z",
    };
    expect(omsControlPlaneOrderSchema.parse(neutral)).toEqual(neutral);
    expect(() => omsControlPlaneOrderSchema.parse({ ...neutral, customer: { email: "private@example.invalid" } })).toThrow();
    expect(() => omsControlPlaneOrderSchema.parse({ ...neutral, providerOrderId: "private-provider-id" })).toThrow();
  });
});
