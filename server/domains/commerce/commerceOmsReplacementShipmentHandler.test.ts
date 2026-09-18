import { describe, expect, it, vi } from "vitest";
import { CommerceOmsConflictError } from "../../../src/domains/commerce/omsPorts.js";
import { COMMERCE_CONTRACT_VERSION } from "../../../src/domains/commerce/types.js";
import { createAdminCommerceOrderRequestReplacementShipmentHandler } from "./commerceOmsReplacementShipmentHandler.js";
import { authorize, request, response } from "./commerceOmsHandlersTestKit.js";

const ORDER_ID = "42222222-2222-4222-8222-222222222221";
const HOLD_ID = "b1111111-1111-4111-8111-111111111111";
const FULFILLMENT_ID = "c1111111-1111-4111-8111-111111111111";
const PREDECESSOR_ID = "d1111111-1111-4111-8111-111111111111";

function replacementRequest() {
  return { idempotencyKey: "oms-replacement-1", orderId: ORDER_ID, reason: "lost" as const };
}

function replacementResponse() {
  return {
    contractVersion: COMMERCE_CONTRACT_VERSION,
    operation: {
      id: "e1111111-1111-4111-8111-111111111111",
      orderId: ORDER_ID,
      type: "replacement_shipment_requested" as const,
      holdId: HOLD_ID,
      actorUserId: null,
      occurredAt: "2026-08-19T10:00:00.000Z",
      payload: { reason: "lost" },
    },
    replacement: {
      fulfillmentOrderId: FULFILLMENT_ID,
      orderId: ORDER_ID,
      sequenceNo: 1,
      replacesFulfillmentOrderId: PREDECESSOR_ID,
      reason: "lost" as const,
      status: "created",
    },
    releasedHoldIds: [HOLD_ID],
    replayed: false,
  };
}

describe("admin commerce replacement shipment handler", () => {
  it("passes the operator identity to the port and returns the released holds", async () => {
    const res = response();
    const port = { requestReplacementShipment: vi.fn().mockResolvedValue(replacementResponse()) };

    await createAdminCommerceOrderRequestReplacementShipmentHandler({
      omsPort: port,
      authorizeAdmin: authorize(),
    })(request("POST", replacementRequest()), res);

    expect(port.requestReplacementShipment).toHaveBeenCalledWith({
      ...replacementRequest(),
      actorUserId: "admin-user-1",
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true, data: replacementResponse() });
  });

  // The operation type is only useful if the contract admits it. It was absent from
  // omsOperationTypeSchema while the migration's CHECK already carried it, which
  // made every real success answer fail the response schema.
  it("admits the replacement_shipment_requested operation type", async () => {
    const res = response();
    await createAdminCommerceOrderRequestReplacementShipmentHandler({
      omsPort: { requestReplacementShipment: vi.fn().mockResolvedValue(replacementResponse()) },
      authorizeAdmin: authorize(),
    })(request("POST", replacementRequest()), res);

    expect(res.json).not.toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: "INVALID_RESPONSE" }) }),
    );
  });

  it("rejects a non-admin before touching the port", async () => {
    const res = response();
    const port = { requestReplacementShipment: vi.fn() };

    await createAdminCommerceOrderRequestReplacementShipmentHandler({
      omsPort: port,
      authorizeAdmin: authorize({ ok: false, code: "FORBIDDEN", message: "Admin role required" }),
    })(request("POST", replacementRequest()), res);

    expect(port.requestReplacementShipment).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("rejects a reason the database CHECK would refuse, before the RPC", async () => {
    const res = response();
    const port = { requestReplacementShipment: vi.fn() };

    await createAdminCommerceOrderRequestReplacementShipmentHandler({
      omsPort: port,
      authorizeAdmin: authorize(),
    })(request("POST", { ...replacementRequest(), reason: "operator_felt_like_it" }), res);

    expect(port.requestReplacementShipment).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("refuses non-POST", async () => {
    const res = response();
    await createAdminCommerceOrderRequestReplacementShipmentHandler({
      omsPort: { requestReplacementShipment: vi.fn() },
      authorizeAdmin: authorize(),
    })(request("GET"), res);

    expect(res.status).toHaveBeenCalledWith(405);
  });

  // The wave's point: a blocking hold arrives at the operator as a reason it can
  // read, and the reason survives the handler untouched.
  it("passes a named hold refusal through as CONFLICT with its reason", async () => {
    const res = response();
    await createAdminCommerceOrderRequestReplacementShipmentHandler({
      omsPort: {
        requestReplacementShipment: vi.fn().mockRejectedValue(
          new CommerceOmsConflictError("Commerce OMS replacement request refused", {
            reason: "blocked_by_risk_review_hold",
          }),
        ),
      },
      authorizeAdmin: authorize(),
    })(request("POST", replacementRequest()), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: "CONFLICT",
          details: { reason: "blocked_by_risk_review_hold" },
        }),
      }),
    );
  });

  it("degrades a non-refusal upstream failure without leaking it", async () => {
    const res = response();
    await createAdminCommerceOrderRequestReplacementShipmentHandler({
      omsPort: {
        requestReplacementShipment: vi.fn().mockRejectedValue(new Error("connection to server at 10.0.0.1 failed")),
      },
      authorizeAdmin: authorize(),
    })(request("POST", replacementRequest()), res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(JSON.stringify(vi.mocked(res.json).mock.calls)).not.toContain("10.0.0.1");
  });
});
