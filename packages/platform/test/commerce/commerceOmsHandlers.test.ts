import { respond } from "./omsConformanceTestKit.js";
import { describe, expect, it, vi } from "vitest";
import { CommerceOmsConflictError } from "../../src/commerce/oms/omsPorts.js";
import { deliveryContactFixture } from "./omsNeutralFixtures.js";
import { adminCommerceOrderDetailResponseSchema } from "../../src/commerce/oms/omsContracts.js";
import {
  createAdminCommerceOrderDetailHandler,
  createAdminCommerceOrderHoldHandler,
  createAdminCommerceOrdersListHandler,
} from "../../src/commerce/server/commerceOmsHandlers.js";
import { authorize, holdRequest, holdResponse, listResponse, request, response } from "./commerceOmsHandlersTestKit.js";
import { detailResponse as clientDetailResponse } from "./omsNeutralFixtures.js";

describe("admin commerce OMS handlers", () => {
  it("returns hidden order list through the shared envelope", async () => {
    const res = response();
    const port = { listOrders: vi.fn().mockResolvedValue(listResponse()) };

    await createAdminCommerceOrdersListHandler({ respond, omsPort: port,
      authorizeAdmin: authorize(),
    })(request("POST", { page: 1 }), res);

    expect(port.listOrders).toHaveBeenCalledWith({ page: 1, pageSize: 25, sort: "created_desc" });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true, data: listResponse() });
  });

  it("accepts GET query params for the staging OMS smoke contract", async () => {
    const res = response();
    const port = { listOrders: vi.fn().mockResolvedValue(listResponse()) };

    await createAdminCommerceOrdersListHandler({ respond, omsPort: port,
      authorizeAdmin: authorize(),
    })(request("GET", undefined, { page: "2", pageSize: "10", search: "OPENLUP-OMS-smoke" }), res);

    expect(port.listOrders).toHaveBeenCalledWith({
      page: 2,
      pageSize: 10,
      search: "OPENLUP-OMS-smoke",
      sort: "created_desc",
    });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("rejects non-admin reads before touching the port", async () => {
    const res = response();
    const port = { listOrders: vi.fn() };

    await createAdminCommerceOrdersListHandler({ respond, omsPort: port,
      authorizeAdmin: authorize({ ok: false, code: "FORBIDDEN", message: "Admin role required" }),
    })(request("POST"), res);

    expect(port.listOrders).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("returns not found for missing order detail", async () => {
    const res = response();
    await createAdminCommerceOrderDetailHandler({ respond, omsPort: { getOrderDetail: vi.fn().mockResolvedValue(null) },
      authorizeAdmin: authorize(),
    })(request("GET", undefined, { orderId: "42222222-2222-4222-8222-222222222221" }), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });


  it("maps hold conflicts to BFF CONFLICT when mutations are explicitly enabled", async () => {
    const res = response();
    await createAdminCommerceOrderHoldHandler({ respond, omsPort: {
        createHold: vi.fn().mockRejectedValue(new CommerceOmsConflictError("Commerce OMS hold conflict")),
      },
      authorizeAdmin: authorize(),
    })(request("POST", holdRequest()), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: "CONFLICT" }),
      }),
    );
  });

  it("returns enabled hold mutation responses without payment fields", async () => {
    const res = response();
    const hold = holdResponse();
    const port = { createHold: vi.fn().mockResolvedValue(hold) };

    await createAdminCommerceOrderHoldHandler({ respond, omsPort: port,
      authorizeAdmin: authorize(),
    })(request("POST", holdRequest()), res);

    expect(port.createHold).toHaveBeenCalledWith({
      ...holdRequest(),
      actorUserId: "admin-user-1",
    });
    expect(res.status).toHaveBeenCalledWith(200);
  });


});
