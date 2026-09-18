import { describe, expect, it, vi } from "vitest";
import { createAdminPaidFulfillmentRecoveryOpsHandler } from "./paidFulfillmentRecoveryOpsHandler.js";
import { authorize, request, response } from "./commerceOmsHandlersTestKit.js";

const NOW = new Date("2026-07-12T12:00:00.000Z");

describe("createAdminPaidFulfillmentRecoveryOpsHandler", () => {
  it("previews stale paid fulfillment recovery candidates without executing mutations", async () => {
    const res = response();
    const recoveryPort = {
      readRecoveryInputs: vi.fn().mockResolvedValue({
        orders: [
          {
            id: "42222222-2222-4222-8222-222222222221",
            status: "paid",
            mode: "one_time",
            created_at: "2026-07-12T10:00:00.000Z",
            updated_at: "2026-07-12T10:00:00.000Z",
          },
        ],
        fulfillmentOrders: [],
        orderPaidOutboxEvents: [
          {
            id: "52222222-2222-4222-8222-222222222221",
            event_type: "commerce.order.paid",
            status: "discarded",
            aggregate_id: "42222222-2222-4222-8222-222222222221",
            created_at: "2026-07-12T10:00:00.000Z",
            attempts: 5,
          },
        ],
      }),
      requeueDiscardedOrderPaidOutboxEvents: vi.fn(),
    };

    await createAdminPaidFulfillmentRecoveryOpsHandler({
      recoveryPort,
      authorizeAdmin: authorize(),
      mutationsEnabled: () => false,
      now: () => NOW,
    })(request("POST", { operation: "preview", minimumAgeSeconds: 1800, limit: 25 }), res);

    expect(recoveryPort.readRecoveryInputs).toHaveBeenCalledWith({
      minimumAgeSeconds: 1800,
      limit: 25,
      now: NOW,
      orderIds: [],
    });
    expect(recoveryPort.requeueDiscardedOrderPaidOutboxEvents).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      data: expect.objectContaining({
        checkedOrders: 1,
        candidates: [
          expect.objectContaining({
            orderId: "42222222-2222-4222-8222-222222222221",
            outboxEventId: "52222222-2222-4222-8222-222222222221",
            recommendedAction: "requeue_discarded_order_paid_outbox",
            recoveryPosture: "automatic_local_requeue_safe",
          }),
        ],
      }),
    });
  });

  it("scopes preview reads to explicit order IDs for OMS detail recovery", async () => {
    const res = response();
    const recoveryPort = {
      readRecoveryInputs: vi.fn().mockResolvedValue(safeRecoveryInputs()),
      requeueDiscardedOrderPaidOutboxEvents: vi.fn(),
    };

    await createAdminPaidFulfillmentRecoveryOpsHandler({
      recoveryPort,
      authorizeAdmin: authorize(),
      mutationsEnabled: () => false,
      now: () => NOW,
    })(request("POST", {
      operation: "preview",
      orderIds: ["42222222-2222-4222-8222-222222222221"],
      minimumAgeSeconds: 1800,
      limit: 25,
    }), res);

    expect(recoveryPort.readRecoveryInputs).toHaveBeenCalledWith({
      minimumAgeSeconds: 1800,
      limit: 25,
      now: NOW,
      orderIds: ["42222222-2222-4222-8222-222222222221"],
    });
    expect(recoveryPort.requeueDiscardedOrderPaidOutboxEvents).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("returns direct dispatch recovery evidence", async () => {
    const res = response();
    const recoveryPort = {
      readRecoveryInputs: vi.fn().mockResolvedValue({
        orders: [{
          id: "42222222-2222-4222-8222-222222222221",
          status: "paid",
          updated_at: "2026-07-12T10:00:00.000Z",
        }],
        fulfillmentOrders: [{
          id: "62222222-2222-4222-8222-222222222221",
          order_id: "42222222-2222-4222-8222-222222222221",
          provider_kind: "omnipack",
          status: "created",
        }],
        omnipackDispatchRefs: [{
          id: "82222222-2222-4222-8222-222222222221",
          fulfillment_order_id: "62222222-2222-4222-8222-222222222221",
          status: "uncertain",
          updated_at: "2026-07-12T11:50:00.000Z",
        }],
        orderPaidOutboxEvents: [],
      }),
      requeueDiscardedOrderPaidOutboxEvents: vi.fn(),
    };

    await createAdminPaidFulfillmentRecoveryOpsHandler({
      recoveryPort,
      authorizeAdmin: authorize(),
      mutationsEnabled: () => false,
      now: () => NOW,
    })(request("POST", { operation: "preview", minimumAgeSeconds: 1800, limit: 25 }), res);

    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      data: expect.objectContaining({
        candidates: [expect.objectContaining({
          dispatchRefId: "82222222-2222-4222-8222-222222222221",
          dispatchStatus: "uncertain",
          reason: "omnipack_dispatch_outcome_uncertain",
          recommendedAction: "inspect_uncertain_dispatch",
        })],
      }),
    });
    expect(recoveryPort.requeueDiscardedOrderPaidOutboxEvents).not.toHaveBeenCalled();
  });

  it("keeps execute behind the existing fulfillment mutation gate", async () => {
    const res = response();
    const recoveryPort = {
      readRecoveryInputs: vi.fn(),
      requeueDiscardedOrderPaidOutboxEvents: vi.fn(),
    };

    await createAdminPaidFulfillmentRecoveryOpsHandler({
      recoveryPort,
      authorizeAdmin: authorize(),
      mutationsEnabled: () => false,
      now: () => NOW,
    })(request("POST", {
      operation: "execute",
      action: "requeue_discarded_order_paid_outbox",
      eventIds: ["52222222-2222-4222-8222-222222222221"],
      reason: "operator confirmed local discarded order-paid event",
    }), res);

    expect(recoveryPort.requeueDiscardedOrderPaidOutboxEvents).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("executes only the allowlisted local requeue action with actor audit context", async () => {
    const res = response();
    const recoveryPort = {
      readRecoveryInputs: vi.fn().mockResolvedValue(safeRecoveryInputs()),
      requeueDiscardedOrderPaidOutboxEvents: vi.fn().mockResolvedValue({
        requeuedCount: 1,
        eventIds: ["52222222-2222-4222-8222-222222222221"],
      }),
    };

    await createAdminPaidFulfillmentRecoveryOpsHandler({
      recoveryPort,
      authorizeAdmin: authorize({ ok: true, userId: "72222222-2222-4222-8222-222222222221" }),
      mutationsEnabled: () => true,
      now: () => NOW,
    })(request("POST", {
      operation: "execute",
      action: "requeue_discarded_order_paid_outbox",
      eventIds: ["52222222-2222-4222-8222-222222222221"],
      reason: "operator confirmed local discarded order-paid event",
    }), res);

    expect(recoveryPort.requeueDiscardedOrderPaidOutboxEvents).toHaveBeenCalledWith({
      eventIds: ["52222222-2222-4222-8222-222222222221"],
      requeuedBy: "72222222-2222-4222-8222-222222222221",
      reason: "operator confirmed local discarded order-paid event",
      limit: 1,
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      data: {
        contractVersion: "commerce.v0",
        action: "requeue_discarded_order_paid_outbox",
        requeuedCount: 1,
        eventIds: ["52222222-2222-4222-8222-222222222221"],
      },
    });
  });

  it("recomputes execute state using the supplied order scope", async () => {
    const res = response();
    const recoveryPort = {
      readRecoveryInputs: vi.fn().mockResolvedValue(safeRecoveryInputs()),
      requeueDiscardedOrderPaidOutboxEvents: vi.fn().mockResolvedValue({
        requeuedCount: 1,
        eventIds: ["52222222-2222-4222-8222-222222222221"],
      }),
    };

    await createAdminPaidFulfillmentRecoveryOpsHandler({
      recoveryPort,
      authorizeAdmin: authorize({ ok: true, userId: "72222222-2222-4222-8222-222222222221" }),
      mutationsEnabled: () => true,
      now: () => NOW,
    })(request("POST", {
      operation: "execute",
      action: "requeue_discarded_order_paid_outbox",
      eventIds: ["52222222-2222-4222-8222-222222222221"],
      orderIds: ["42222222-2222-4222-8222-222222222221"],
      reason: "operator confirmed local discarded order-paid event",
    }), res);

    expect(recoveryPort.readRecoveryInputs).toHaveBeenCalledWith({
      minimumAgeSeconds: 1800,
      limit: 100,
      now: NOW,
      orderIds: ["42222222-2222-4222-8222-222222222221"],
    });
    expect(recoveryPort.requeueDiscardedOrderPaidOutboxEvents).toHaveBeenCalledOnce();
  });

  it("recomputes current recovery state and refuses unsafe stale event IDs before RPC", async () => {
    const res = response();
    const recoveryPort = {
      readRecoveryInputs: vi.fn().mockResolvedValue({
        orders: [],
        fulfillmentOrders: [],
        orderPaidOutboxEvents: [],
      }),
      requeueDiscardedOrderPaidOutboxEvents: vi.fn(),
    };

    await createAdminPaidFulfillmentRecoveryOpsHandler({
      recoveryPort,
      authorizeAdmin: authorize({ ok: true, userId: "72222222-2222-4222-8222-222222222221" }),
      mutationsEnabled: () => true,
      now: () => NOW,
    })(request("POST", {
      operation: "execute",
      action: "requeue_discarded_order_paid_outbox",
      eventIds: ["52222222-2222-4222-8222-222222222221"],
      reason: "operator confirmed local discarded order-paid event",
    }), res);

    expect(recoveryPort.requeueDiscardedOrderPaidOutboxEvents).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: "CONFLICT",
          details: { unsafeEventIds: ["52222222-2222-4222-8222-222222222221"] },
        }),
      }),
    );
  });

  it("does not requeue discarded order-paid events for existing OmniPack fulfillments without dispatch refs", async () => {
    const res = response();
    const recoveryPort = {
      readRecoveryInputs: vi.fn().mockResolvedValue({
        orders: [
          {
            id: "42222222-2222-4222-8222-222222222221",
            status: "paid",
            mode: "one_time",
            created_at: "2026-07-12T10:00:00.000Z",
            updated_at: "2026-07-12T10:00:00.000Z",
          },
        ],
        fulfillmentOrders: [
          {
            id: "62222222-2222-4222-8222-222222222221",
            order_id: "42222222-2222-4222-8222-222222222221",
            provider_kind: "omnipack",
            status: "created",
            created_at: "2026-07-12T10:05:00.000Z",
            updated_at: "2026-07-12T10:05:00.000Z",
          },
        ],
        orderPaidOutboxEvents: [
          {
            id: "52222222-2222-4222-8222-222222222221",
            event_type: "commerce.order.paid",
            status: "discarded",
            aggregate_id: "42222222-2222-4222-8222-222222222221",
            created_at: "2026-07-12T10:00:00.000Z",
            attempts: 5,
          },
        ],
      }),
      requeueDiscardedOrderPaidOutboxEvents: vi.fn(),
    };

    await createAdminPaidFulfillmentRecoveryOpsHandler({
      recoveryPort,
      authorizeAdmin: authorize({ ok: true, userId: "72222222-2222-4222-8222-222222222221" }),
      mutationsEnabled: () => true,
      now: () => NOW,
    })(request("POST", {
      operation: "execute",
      action: "requeue_discarded_order_paid_outbox",
      eventIds: ["52222222-2222-4222-8222-222222222221"],
      orderIds: ["42222222-2222-4222-8222-222222222221"],
      reason: "operator confirmed local discarded order-paid event",
    }), res);

    expect(recoveryPort.requeueDiscardedOrderPaidOutboxEvents).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
  });

  it("rejects non-allowlisted execute actions during contract validation", async () => {
    const res = response();
    const recoveryPort = {
      readRecoveryInputs: vi.fn(),
      requeueDiscardedOrderPaidOutboxEvents: vi.fn(),
    };

    await createAdminPaidFulfillmentRecoveryOpsHandler({
      recoveryPort,
      authorizeAdmin: authorize(),
      mutationsEnabled: () => true,
      now: () => NOW,
    })(request("POST", {
      operation: "execute",
      action: "inspect_missing_order_paid_outbox",
      eventIds: ["52222222-2222-4222-8222-222222222221"],
      reason: "operator asked for an unsafe replay",
    }), res);

    expect(recoveryPort.requeueDiscardedOrderPaidOutboxEvents).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

function safeRecoveryInputs() {
  return {
    orders: [
      {
        id: "42222222-2222-4222-8222-222222222221",
        status: "paid",
        mode: "one_time",
        created_at: "2026-07-12T10:00:00.000Z",
        updated_at: "2026-07-12T10:00:00.000Z",
      },
    ],
    fulfillmentOrders: [],
    orderPaidOutboxEvents: [
      {
        id: "52222222-2222-4222-8222-222222222221",
        event_type: "commerce.order.paid",
        status: "discarded",
        aggregate_id: "42222222-2222-4222-8222-222222222221",
        created_at: "2026-07-12T10:00:00.000Z",
        attempts: 5,
      },
    ],
  };
}
