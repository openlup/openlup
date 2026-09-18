import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { COMMERCE_FULFILLMENT_CONTRACT_VERSION } from "../../../src/domains/fulfillment/commerceFulfillmentContracts.js";
import { CommerceFulfillmentConflictError } from "../../../src/domains/fulfillment/commerceFulfillmentPorts.js";
import {
  createAdminCommerceFulfillmentCreateOrderHandler,
  createAdminCommerceFulfillmentOrdersListHandler,
  createAdminCommerceFulfillmentRecordLabelHandler,
} from "./commerceFulfillmentHandlers.js";

describe("admin commerce fulfillment handlers", () => {
  it("returns hidden commerce fulfillment reads through the shared envelope", async () => {
    const res = response();
    const port = { listCommerceFulfillmentOrders: vi.fn().mockResolvedValue(listResponse()) };

    await createAdminCommerceFulfillmentOrdersListHandler({
      fulfillmentPort: port,
      authorizeAdmin: authorize(),
    })(request("GET", undefined, { page: "1" }), res);

    expect(port.listCommerceFulfillmentOrders).toHaveBeenCalledWith({ page: 1, pageSize: 25 });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true, data: listResponse() });
  });

  it("rejects non-admin reads before touching the port", async () => {
    const res = response();
    const portFactory = vi.fn(() => ({ listCommerceFulfillmentOrders: vi.fn() }));

    await createAdminCommerceFulfillmentOrdersListHandler({
      fulfillmentPort: portFactory,
      authorizeAdmin: authorize({ ok: false, code: "FORBIDDEN", message: "Admin role required" }),
    })(request("GET"), res);

    expect(portFactory).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });


  it("rejects invalid mutation payloads before constructing the fulfillment port", async () => {
    const res = response();
    const portFactory = vi.fn(() => ({ createCommerceFulfillmentOrder: vi.fn() }));

    await createAdminCommerceFulfillmentCreateOrderHandler({
      fulfillmentPort: portFactory,
      authorizeAdmin: authorize(),
    })(request("POST", { idempotencyKey: "" }), res);

    expect(portFactory).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("rejects unsupported methods before auth or fulfillment port construction", async () => {
    const res = response();
    const authorizeAdmin = authorize();
    const portFactory = vi.fn(() => ({ createCommerceFulfillmentOrder: vi.fn() }));

    await createAdminCommerceFulfillmentCreateOrderHandler({
      fulfillmentPort: portFactory,
      authorizeAdmin,
    })(request("GET", createRequest()), res);

    expect(authorizeAdmin).not.toHaveBeenCalled();
    expect(portFactory).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(405);
  });

  it("passes actor user into enabled mutations", async () => {
    const res = response();
    const port = { recordCommerceFulfillmentLabel: vi.fn().mockResolvedValue(mutationResponse("label_created")) };

    await createAdminCommerceFulfillmentRecordLabelHandler({
      fulfillmentPort: port,
      authorizeAdmin: authorize(),
    })(request("POST", labelRequest()), res);

    expect(port.recordCommerceFulfillmentLabel).toHaveBeenCalledWith({
      ...labelRequest(),
      rawProviderPayload: {},
      actorUserId: "admin-user-1",
    });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("maps enabled fulfillment conflicts to BFF CONFLICT", async () => {
    const res = response();

    await createAdminCommerceFulfillmentCreateOrderHandler({
      fulfillmentPort: {
        createCommerceFulfillmentOrder: vi.fn().mockRejectedValue(
          new CommerceFulfillmentConflictError("Commerce fulfillment mutation conflict"),
        ),
      },
      authorizeAdmin: authorize(),
    })(request("POST", createRequest()), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: "CONFLICT" }),
      }),
    );
  });

  it("adds a stable reason to enabled fulfillment upstream failures", async () => {
    const res = response();

    await createAdminCommerceFulfillmentCreateOrderHandler({
      fulfillmentPort: {
        createCommerceFulfillmentOrder: vi.fn().mockRejectedValue(new Error("rpc failed")),
      },
      authorizeAdmin: authorize(),
    })(request("POST", createRequest()), res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: "UPSTREAM_UNAVAILABLE",
          details: { reason: "fulfillment_mutation_failed" },
        }),
      }),
    );
  });
});

function request(method: string, body?: unknown, query: Record<string, unknown> = {}): VercelRequest {
  return { method, body, query, headers: {} } as VercelRequest;
}

function response(): VercelResponse {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() } as unknown as VercelResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}

function authorize(
  result:
    | { ok: true; userId: string }
    | { ok: false; code: "UNAUTHORIZED" | "FORBIDDEN"; message: string } = {
    ok: true,
    userId: "admin-user-1",
  },
) {
  return vi.fn().mockResolvedValue(result);
}

function listResponse() {
  return {
    contractVersion: COMMERCE_FULFILLMENT_CONTRACT_VERSION,
    orders: [commerceFulfillmentOrder()],
    totalCount: 1,
    page: 1,
    pageSize: 25,
  };
}

function commerceFulfillmentOrder() {
  return {
    id: "52222222-2222-4222-8222-222222222221",
    orderId: "42222222-2222-4222-8222-222222222221",
    clientId: "12222222-2222-4222-8222-222222222221",
    status: "created",
    providerKind: null,
    providerTrackingId: null,
    shippingAddress: {
      addressId: "32222222-2222-4222-8222-222222222221",
      clientId: "12222222-2222-4222-8222-222222222221",
      label: "Home",
      line1: "Prosta 1",
      line2: null,
      city: "Warszawa",
      postalCode: "00-001",
      country: "PL",
    },
    lines: [{
      id: "62222222-2222-4222-8222-222222222221",
      orderItemId: "72222222-2222-4222-8222-222222222221",
      skuId: "82222222-2222-4222-8222-222222222221",
      sku: "OPENLUP-DOG-LAMB-CAN-400G",
      title: "Lamb 400g",
      quantity: 2,
      inventoryReservationIds: ["92222222-2222-4222-8222-222222222221"],
      productSnapshot: {},
    }],
    payment: {
      paymentIntentId: "a2222222-2222-4222-8222-222222222221",
      paymentStatus: "succeeded",
      providerPaymentId: "pay_1",
    },
    inventory: {
      status: "reserved",
      reservationId: "92222222-2222-4222-8222-222222222221",
      reservationStatus: "reserved",
      expiresAt: "2026-06-05T10:30:00+00:00",
      locationId: "b2222222-2222-4222-8222-222222222221",
      locationCode: "pl-main",
    },
    omsEligibility: { allowed: true, reason: null },
    latestOperation: null,
    createdAt: "2026-06-05T10:00:00+00:00",
    updatedAt: "2026-06-05T10:00:00+00:00",
  };
}

function createRequest() {
  return {
    idempotencyKey: "fulfillment-create-1",
    orderId: "42222222-2222-4222-8222-222222222221",
  };
}

function labelRequest() {
  return {
    idempotencyKey: "fulfillment-label-1",
    fulfillmentOrderId: "52222222-2222-4222-8222-222222222221",
    providerKind: "noop_shipping",
    providerTrackingId: "NOOP-1",
  };
}

function mutationResponse(status: "created" | "label_created") {
  return {
    contractVersion: COMMERCE_FULFILLMENT_CONTRACT_VERSION,
    fulfillmentOrderId: "52222222-2222-4222-8222-222222222221",
    orderId: "42222222-2222-4222-8222-222222222221",
    status,
    replayed: false,
  };
}
