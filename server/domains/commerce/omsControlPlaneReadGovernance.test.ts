/**
 * The audit contract of BOTH branches of `/api/bff/admin/commerce/orders` and
 * `/api/bff/admin/commerce/orders/detail`, pinned side by side.
 *
 * The routes fork on `?view=control_plane_v1`. The V0 branch is governed by
 * `applyOmsAgentCustomerReadGate` — a machine actor is flag-gated, audited as a
 * `customer_read`, and served masked PII. The `control_plane_v1` branch is
 * DELIBERATELY outside that gate, because `commerce.oms_control_plane.v1` carries
 * no customer identity at all, because the gate's audit would then record a
 * customer read of zero customers, and because the portable `node-postgres`
 * branch of the same contract has neither an actor kind nor an audit client to
 * run it with. Reasoning and its precondition: docs/BFF_CONTRACTS.md, Admin
 * Commerce.
 *
 * That exemption is conditional, so the condition is pinned here too: if the
 * projection ever gains a customer fact, these tests fail in the same change
 * that widens it, instead of letting the new fact inherit the exemption.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createAdminCommerceOrderDetailHandler,
  createAdminCommerceOrdersListHandler,
} from "./commerceOmsHandlers.js";
import {
  createCommerceOmsControlPlaneDetailHandler,
  createCommerceOmsControlPlaneListHandler,
} from "./commerceOmsControlPlaneHandlers.js";
import { listResponse, request, response } from "./commerceOmsHandlersTestKit.js";
import {
  OMS_CONTROL_PLANE_VERSION,
  OMS_CONTROL_PLANE_VIEW,
  omsControlPlaneActions,
  omsControlPlaneDetailResponseSchema,
  omsControlPlaneListResponseSchema,
  omsControlPlaneOrderSchema,
} from "../../../src/domains/commerce/omsControlPlane.js";

const ORDER_ID = "42222222-2222-4222-8222-222222222221";

function machineAuth() {
  return vi.fn().mockResolvedValue({ ok: true, userId: "admin-user-1", isMachineActor: true });
}
function humanAuth() {
  return vi.fn().mockResolvedValue({ ok: true, userId: "admin-user-1", isMachineActor: false });
}

function controlPlaneOrder() {
  return {
    orderId: ORDER_ID,
    status: "paid" as const,
    sourceKind: "storefront",
    sourceOrderRef: null,
    // XTS is the ISO 4217 test code, as in `src/domains/commerce/omsControlPlane.test.ts`:
    // this projection is currency-neutral and a real code would cost an OSS ratchet token.
    money: { amountMinor: 12900, currency: "XTS" },
    shipmentStatus: null,
    activeHoldCount: 0,
    activeHoldReasons: [],
    actions: omsControlPlaneActions("paid", 0),
    createdAt: "2026-06-05T10:00:00.000Z",
    updatedAt: "2026-06-05T10:01:00.000Z",
  };
}
function controlPlaneList() {
  return {
    contractVersion: OMS_CONTROL_PLANE_VERSION,
    orders: [controlPlaneOrder()],
    totalCount: 1,
    page: 1,
    pageSize: 25,
  };
}
function controlPlaneDetail() {
  return {
    contractVersion: OMS_CONTROL_PLANE_VERSION,
    order: controlPlaneOrder(),
    holds: [],
    operations: [],
  };
}

type AuditRpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;

/** The exact governance a route hands the V0 branch, with the kill-switch down. */
function governanceWithFlagOff(rpc: AuditRpc = vi.fn<AuditRpc>()) {
  return { flagEnabled: false, auditClient: { rpc } };
}

describe("OMS order reads — the customer-read gate applies to V0 and not to control_plane_v1", () => {
  describe("V0 branch — governed", () => {
    it("blocks the machine actor on list when the flag is down, before the port", async () => {
      const res = response();
      const rpc = vi.fn<AuditRpc>();
      const port = { listOrders: vi.fn() };

      await createAdminCommerceOrdersListHandler({
        omsPort: port,
        authorizeAdmin: machineAuth(),
        governance: governanceWithFlagOff(rpc),
      })(request("POST", { page: 1 }), res);

      expect(port.listOrders).not.toHaveBeenCalled();
      // A refused read is not a read, so it is not audited either.
      expect(rpc).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            details: { reason: "feature_flag_disabled", featureFlag: "COMMERCE_AGENT_CUSTOMER_READ_ENABLED" },
          }),
        }),
      );
    });

    it("blocks the machine actor on detail when the flag is down, before the port", async () => {
      const res = response();
      const port = { getOrderDetail: vi.fn() };

      await createAdminCommerceOrderDetailHandler({
        omsPort: port,
        authorizeAdmin: machineAuth(),
        governance: governanceWithFlagOff(vi.fn()),
      })(request("GET", undefined, { orderId: ORDER_ID }), res);

      expect(port.getOrderDetail).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(503);
    });

    it("serves the human actor the same read the flag denies the machine", async () => {
      const res = response();

      await createAdminCommerceOrdersListHandler({
        omsPort: { listOrders: vi.fn().mockResolvedValue(listResponse()) },
        authorizeAdmin: humanAuth(),
        governance: governanceWithFlagOff(vi.fn()),
      })(request("POST", { page: 1 }), res);

      expect(res.status).toHaveBeenCalledWith(200);
    });
  });

  describe("control_plane_v1 branch — deliberately ungoverned", () => {
    it("answers the machine actor identically to the human actor on list", async () => {
      const query = { view: OMS_CONTROL_PLANE_VIEW, page: "1", pageSize: "25" };

      const machineRes = response();
      await createCommerceOmsControlPlaneListHandler({
        port: { listOrders: vi.fn().mockResolvedValue(controlPlaneList()), getOrderDetail: vi.fn() },
        authorizeAdmin: machineAuth(),
      })(request("GET", undefined, query), machineRes);

      const humanRes = response();
      await createCommerceOmsControlPlaneListHandler({
        port: { listOrders: vi.fn().mockResolvedValue(controlPlaneList()), getOrderDetail: vi.fn() },
        authorizeAdmin: humanAuth(),
      })(request("GET", undefined, query), humanRes);

      // Identical bodies are the pin: wiring the gate in would make the machine
      // actor diverge from the human one (503 vs 200, or masked vs unmasked).
      expect(machineRes.status).toHaveBeenCalledWith(200);
      expect(vi.mocked(machineRes.json).mock.calls).toEqual(vi.mocked(humanRes.json).mock.calls);
    });

    it("answers the machine actor identically to the human actor on detail", async () => {
      const query = { view: OMS_CONTROL_PLANE_VIEW, orderId: ORDER_ID };

      const machineRes = response();
      await createCommerceOmsControlPlaneDetailHandler({
        port: { listOrders: vi.fn(), getOrderDetail: vi.fn().mockResolvedValue(controlPlaneDetail()) },
        authorizeAdmin: machineAuth(),
      })(request("GET", undefined, query), machineRes);

      const humanRes = response();
      await createCommerceOmsControlPlaneDetailHandler({
        port: { listOrders: vi.fn(), getOrderDetail: vi.fn().mockResolvedValue(controlPlaneDetail()) },
        authorizeAdmin: humanAuth(),
      })(request("GET", undefined, query), humanRes);

      expect(machineRes.status).toHaveBeenCalledWith(200);
      expect(vi.mocked(machineRes.json).mock.calls).toEqual(vi.mocked(humanRes.json).mock.calls);
    });

    it("still refuses an unauthorized caller — the exemption is from the gate, not from admin auth", async () => {
      const res = response();
      const port = { listOrders: vi.fn(), getOrderDetail: vi.fn() };

      await createCommerceOmsControlPlaneListHandler({
        port,
        authorizeAdmin: vi.fn().mockResolvedValue({ ok: false, code: "FORBIDDEN", message: "Admin role required" }),
      })(request("GET", undefined, { view: OMS_CONTROL_PLANE_VIEW }), res);

      expect(port.listOrders).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    });
  });

  describe("the precondition the exemption rests on", () => {
    const CUSTOMER_IDENTITY_FIELDS: Record<string, unknown> = {
      clientId: "52222222-2222-4222-8222-222222222221",
      customer: { email: "private@example.invalid" },
      email: "private@example.invalid",
      phone: "+48123456123",
      shippingAddress: { line1: "Prosta 1" },
    };

    it.each(Object.keys(CUSTOMER_IDENTITY_FIELDS))(
      "rejects `%s` on the control-plane order projection",
      (field) => {
        expect(() =>
          omsControlPlaneOrderSchema.parse({ ...controlPlaneOrder(), [field]: CUSTOMER_IDENTITY_FIELDS[field] }),
        ).toThrow();
      },
    );

    it("rejects a customer fact smuggled through either response envelope", () => {
      expect(() =>
        omsControlPlaneListResponseSchema.parse({
          ...controlPlaneList(),
          orders: [{ ...controlPlaneOrder(), clientId: "52222222-2222-4222-8222-222222222221" }],
        }),
      ).toThrow();
      expect(() =>
        omsControlPlaneDetailResponseSchema.parse({ ...controlPlaneDetail(), customer: { email: "private@example.invalid" } }),
      ).toThrow();
    });

    it("accepts the customer-free projection unchanged, so the tripwire is not vacuous", () => {
      expect(omsControlPlaneListResponseSchema.parse(controlPlaneList())).toEqual(controlPlaneList());
      expect(omsControlPlaneDetailResponseSchema.parse(controlPlaneDetail())).toEqual(controlPlaneDetail());
    });
  });
});
