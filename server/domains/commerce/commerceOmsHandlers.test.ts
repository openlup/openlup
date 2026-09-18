import { describe, expect, it, vi } from "vitest";
import { CommerceOmsConflictError } from "../../../src/domains/commerce/omsPorts.js";
import { deliveryContactFixture } from "../../../src/domains/commerce/omsClient.fixtures.js";
import { adminCommerceOrderDetailResponseSchema } from "../../../src/domains/commerce/omsContracts.js";
import {
  createAdminCommerceOrderDetailHandler,
  createAdminCommerceOrderHoldHandler,
  createAdminCommerceOrdersListHandler,
} from "./commerceOmsHandlers.js";
import { authorize, holdRequest, holdResponse, listResponse, request, response } from "./commerceOmsHandlersTestKit.js";
import { detailResponse as clientDetailResponse } from "../../../src/domains/commerce/omsClient.fixtures.js";

describe("admin commerce OMS handlers", () => {
  it("returns hidden order list through the shared envelope", async () => {
    const res = response();
    const port = { listOrders: vi.fn().mockResolvedValue(listResponse()) };

    await createAdminCommerceOrdersListHandler({
      omsPort: port,
      authorizeAdmin: authorize(),
    })(request("POST", { page: 1 }), res);

    expect(port.listOrders).toHaveBeenCalledWith({ page: 1, pageSize: 25, sort: "created_desc" });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true, data: listResponse() });
  });

  it("accepts GET query params for the staging OMS smoke contract", async () => {
    const res = response();
    const port = { listOrders: vi.fn().mockResolvedValue(listResponse()) };

    await createAdminCommerceOrdersListHandler({
      omsPort: port,
      authorizeAdmin: authorize(),
    })(request("GET", undefined, { page: "2", pageSize: "10", search: "HP-OMS-smoke" }), res);

    expect(port.listOrders).toHaveBeenCalledWith({
      page: 2,
      pageSize: 10,
      search: "HP-OMS-smoke",
      sort: "created_desc",
    });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("rejects non-admin reads before touching the port", async () => {
    const res = response();
    const port = { listOrders: vi.fn() };

    await createAdminCommerceOrdersListHandler({
      omsPort: port,
      authorizeAdmin: authorize({ ok: false, code: "FORBIDDEN", message: "Admin role required" }),
    })(request("POST"), res);

    expect(port.listOrders).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("returns not found for missing order detail", async () => {
    const res = response();
    await createAdminCommerceOrderDetailHandler({
      omsPort: { getOrderDetail: vi.fn().mockResolvedValue(null) },
      authorizeAdmin: authorize(),
    })(request("GET", undefined, { orderId: "42222222-2222-4222-8222-222222222221" }), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });


  it("maps hold conflicts to BFF CONFLICT when mutations are explicitly enabled", async () => {
    const res = response();
    await createAdminCommerceOrderHoldHandler({
      omsPort: {
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

    await createAdminCommerceOrderHoldHandler({
      omsPort: port,
      authorizeAdmin: authorize(),
    })(request("POST", holdRequest()), res);

    expect(port.createHold).toHaveBeenCalledWith({
      ...holdRequest(),
      actorUserId: "admin-user-1",
    });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  describe("Wave 7a — actor-kind-aware governance (customer reads)", () => {
    function machineAuth() {
      return authorize({ ok: true, userId: "admin-user-1", isMachineActor: true } as never);
    }
    function humanAuth() {
      return authorize({ ok: true, userId: "admin-user-1", isMachineActor: false } as never);
    }
    function listWithCustomer() {
      const base = listResponse();
      return {
        ...base,
        orders: [
          {
            ...base.orders[0],
            clientId: "52222222-2222-4222-8222-222222222221",
            customer: {
              id: "52222222-2222-4222-8222-222222222221",
              email: "jan@example.com",
              firstName: "Jan",
              lastName: "Kowalski",
              phone: "+48123456123",
              lifecycleStage: "customer",
            },
          },
        ],
      };
    }

    it("machine + flag OFF → feature_flag_disabled envelope, port never touched", async () => {
      const res = response();
      const port = { listOrders: vi.fn() };
      await createAdminCommerceOrdersListHandler({
        omsPort: port,
        authorizeAdmin: machineAuth(),
        governance: { flagEnabled: false, auditClient: { rpc: vi.fn() } },
      })(request("POST", { page: 1 }), res);
      expect(port.listOrders).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            details: { reason: "feature_flag_disabled", featureFlag: "COMMERCE_AGENT_CUSTOMER_READ_ENABLED" },
          }),
        }),
      );
    });

    it("machine + flag ON → masks customer email/phone on the list + audits", async () => {
      const res = response();
      const rpc = vi.fn().mockResolvedValue({ data: "row", error: null });
      await createAdminCommerceOrdersListHandler({
        omsPort: { listOrders: vi.fn().mockResolvedValue(listWithCustomer()) },
        authorizeAdmin: machineAuth(),
        governance: { flagEnabled: true, auditClient: { rpc } },
      })(request("POST", { page: 1, search: "jan@example.com" }), res);
      expect(res.status).toHaveBeenCalledWith(200);
      const body = vi.mocked(res.json).mock.calls[0][0] as { data: { orders: { customer: { email: string; phone: string } }[] } };
      expect(body.data.orders[0].customer.email).toBe("j***@example.com");
      // Was "+48***123": the gate no longer hands the machine actor a country
      // prefix that the SQL preview of the same number never showed.
      expect(body.data.orders[0].customer.phone).toBe("***123");
      expect(rpc).toHaveBeenCalledWith(
        "record_admin_audit_event",
        expect.objectContaining({
          p_action: "customer_read",
          p_source: "mcp_agent",
          p_new: expect.objectContaining({
            query: expect.objectContaining({ search: "[redacted]" }),
          }),
        }),
      );
      expect(JSON.stringify(rpc.mock.calls)).not.toContain("jan@example.com");
    });

    it("HUMAN → full customer PII, no audit, flag ignored", async () => {
      const res = response();
      const rpc = vi.fn();
      await createAdminCommerceOrdersListHandler({
        omsPort: { listOrders: vi.fn().mockResolvedValue(listWithCustomer()) },
        authorizeAdmin: humanAuth(),
        governance: { flagEnabled: false, auditClient: { rpc } },
      })(request("POST", { page: 1 }), res);
      expect(res.status).toHaveBeenCalledWith(200);
      const body = vi.mocked(res.json).mock.calls[0][0] as { data: { orders: { customer: { email: string } }[] } };
      expect(body.data.orders[0].customer.email).toBe("jan@example.com");
      expect(rpc).not.toHaveBeenCalled();
    });

    it("machine detail masks order-owned baseline and effective contact", async () => {
      const res = response();
      const rpc = vi.fn().mockResolvedValue({ data: "row", error: null });
      const detail = adminCommerceOrderDetailResponseSchema.parse(clientDetailResponse());
      detail.order.clientId = "c2222222-2222-4222-8222-222222222222";
      detail.order.customer = {
        id: "c2222222-2222-4222-8222-222222222222",
        email: "customer@example.com",
        firstName: "Jan",
        lastName: "Kowalski",
        phone: "+48123456123",
        lifecycleStage: null,
      };
      detail.order.deliveryContact = {
        baseline: deliveryContact("baseline@example.com", "+48111222333", 1),
        effective: deliveryContact("parcel@example.com", "+48444555666", 2),
        scope: "parcel",
        source: "operator_parcel_override",
        revision: 2,
        digest: "0123456789abcdef0123456789abcdef",
        frozen: false,
        providerSubmissionState: "draft",
        correctionAllowed: true,
      };
      const { contactEmail: _contactEmail, ...shippingContact } = deliveryContactFixture({
        recipientName: "Jan Kowalski", line1: "Testowa 1",
      }).address;
      detail.order.shippingAddress = {
        ...shippingContact,
        id: "a2222222-2222-4222-8222-222222222222",
        label: null,
        contactPhone: "+48777888999",
        companyName: null,
        taxId: null,
        deliveryNotes: null,
        courierInstructions: null,
      };
      detail.order.billingAddress = {
        ...detail.order.shippingAddress,
        id: "a3222222-2222-4222-8222-222222222222",
        contactPhone: "+48666777888",
      };

      await createAdminCommerceOrderDetailHandler({
        omsPort: { getOrderDetail: vi.fn().mockResolvedValue(detail) },
        authorizeAdmin: machineAuth(),
        governance: { flagEnabled: true, auditClient: { rpc } },
      })(request("GET", undefined, { orderId: detail.order.orderId }), res);

      const body = vi.mocked(res.json).mock.calls[0][0] as {
        data: { order: { deliveryContact: { baseline: { contactEmail: string; contactPhone: string }; effective: { contactEmail: string; contactPhone: string } } } };
      };
      expect(body.data.order.deliveryContact.baseline).toMatchObject({
        contactEmail: "b***@example.com",
        contactPhone: "***333",
      });
      expect(body.data.order.deliveryContact.effective).toMatchObject({
        contactEmail: "p***@example.com",
        contactPhone: "***666",
      });
      expect((body.data.order.deliveryContact as { digest?: string | null }).digest).toBeNull();
      const serialized = JSON.stringify(body.data.order);
      expect(serialized).not.toContain("baseline@example.com");
      expect(serialized).not.toContain("parcel@example.com");
      expect(serialized).not.toContain("+48111222333");
      expect(serialized).not.toContain("+48444555666");
      expect(serialized).not.toContain("+48777888999");
      expect(serialized).not.toContain("customer@example.com");
      expect(serialized).not.toContain("+48123456123");
      expect(serialized).not.toContain("+48666777888");
    });
  });

});

function deliveryContact(contactEmail: string, contactPhone: string, revision: number) {
  return deliveryContactFixture({
    source: revision === 1 ? "checkout_submission" : "operator_parcel_override",
    revision,
    recipientName: "Jan Kowalski",
    contactEmail,
    contactPhone,
    line1: "Testowa 1",
  }).canonical;
}
