import { describe, expect, it, vi } from "vitest";
import type { VercelResponse } from "../types/vercel.js";
import { applyOmsAgentCustomerReadGate } from "./customerReadGovernance.js";

function createResponse(): VercelResponse {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() } as unknown as VercelResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}

const ordersFixture = {
  orders: [
    {
      orderId: "o1",
      clientId: "c1",
      customer: { email: "jan@example.com", phone: "+48123456123" },
      // SQL already masked this preview for every caller — with 2 local chars.
      match: { field: "email", label: "Email", valuePreview: "ja***@example.com" },
      deliveryContact: {
        baseline: { contactEmail: "baseline@example.com", contactPhone: "+48111222333" },
        effective: { contactEmail: "parcel@example.com", contactPhone: "+48444555666" },
        digest: "0123456789abcdef0123456789abcdef",
        // The unmasked read model reports correction as allowed whenever an
        // effective contact and its digest exist and nothing froze them.
        correctionAllowed: true,
      },
      shippingAddress: { contactPhone: "+48777888999" },
      billingAddress: { contactPhone: "+48123456789" },
    },
    { orderId: "o2", clientId: null, customer: null },
  ],
};

describe("applyOmsAgentCustomerReadGate", () => {
  const base = { res: createResponse(), route: "/api/bff/admin/commerce/orders", query: { page: 1 } };

  it("human → passthrough: identity mask, no-op audit", async () => {
    const rpc = vi.fn();
    const gate = applyOmsAgentCustomerReadGate({
      ...base,
      authorization: { ok: true, userId: "u1", isMachineActor: false },
      governance: { flagEnabled: false, auditClient: { rpc } },
    });
    expect(gate.blocked).toBe(false);
    expect(gate.maskOrders(ordersFixture)).toBe(ordersFixture);
    await gate.audit(["c1"]);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("machine + flag OFF → blocked + disabled envelope", () => {
    const res = createResponse();
    const gate = applyOmsAgentCustomerReadGate({
      ...base,
      res,
      authorization: { ok: true, userId: "u1", isMachineActor: true },
      governance: { flagEnabled: false, auditClient: { rpc: vi.fn() } },
    });
    expect(gate.blocked).toBe(true);
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it("machine + flag ON → masks each order's customer email/phone + audits", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: "row", error: null });
    const gate = applyOmsAgentCustomerReadGate({
      ...base,
      authorization: { ok: true, userId: "u1", isMachineActor: true },
      governance: { flagEnabled: true, auditClient: { rpc } },
    });
    const masked = gate.maskOrders(ordersFixture);
    expect(masked.orders[0].customer?.email).toBe("j***@example.com");
    expect(masked.orders[0].customer?.phone).toBe("***123"); // was "+48***123"
    expect(masked.orders[0].deliveryContact?.baseline?.contactEmail).toBe("b***@example.com");
    expect(masked.orders[0].deliveryContact?.baseline?.contactPhone).toBe("***333");
    expect(masked.orders[0].deliveryContact?.effective?.contactEmail).toBe("p***@example.com");
    expect(masked.orders[0].deliveryContact?.effective?.contactPhone).toBe("***666");
    expect(masked.orders[0].deliveryContact?.digest).toBeNull();
    // The digest is the only token that satisfies the correction fence, so a
    // reader that cannot see it cannot correct the address either. Reporting
    // `true` here promised a machine actor an action the fence always refuses.
    expect(masked.orders[0].deliveryContact?.correctionAllowed).toBe(false);
    expect(masked.orders[0].shippingAddress?.contactPhone).toBe("***999");
    expect(masked.orders[0].billingAddress?.contactPhone).toBe("***789");
    expect(masked.orders[1].customer).toBeNull();
    await gate.audit(["c1"]);
    expect(rpc).toHaveBeenCalledWith(
      "record_admin_audit_event",
      expect.objectContaining({ p_source: "mcp_agent", p_action: "customer_read" }),
    );
  });

  it("machine + flag ON → the search preview cannot outrank the masked customer field", () => {
    const gate = applyOmsAgentCustomerReadGate({
      ...base,
      authorization: { ok: true, userId: "u1", isMachineActor: true },
      governance: { flagEnabled: true, auditClient: { rpc: vi.fn() } },
    });
    const masked = gate.maskOrders(ordersFixture);
    // Was "ja***@example.com" — one response showed the same address twice, at
    // two redaction levels. Both halves now agree, at the stricter one.
    expect(masked.orders[0].match?.valuePreview).toBe("j***@example.com");
    expect(masked.orders[0].match?.valuePreview).toBe(masked.orders[0].customer?.email);
    expect(masked.orders[0].match?.field).toBe("email");
    expect(masked.orders[0].match?.label).toBe("Email");
    // The fixture is not mutated.
    expect(ordersFixture.orders[0]?.match?.valuePreview).toBe("ja***@example.com");
  });

  it("masks a phone preview and leaves non-PII match previews alone", () => {
    const gate = applyOmsAgentCustomerReadGate({
      ...base,
      authorization: { ok: true, userId: "u1", isMachineActor: true },
      governance: { flagEnabled: true, auditClient: { rpc: vi.fn() } },
    });
    const masked = gate.maskOrders({
      orders: [
        { orderId: "p", clientId: "c", customer: null, match: { field: "phone", label: "Phone", valuePreview: "***123" } },
        { orderId: "n", clientId: "c", customer: null, match: { field: "order_number", label: "Order", valuePreview: "VP-1042" } },
        { orderId: "t", clientId: "c", customer: null, match: { field: "tracking", label: "Tracking", valuePreview: "6900123456" } },
      ],
    });
    expect(masked.orders[0].match?.valuePreview).toBe("***123");
    expect(masked.orders[1].match?.valuePreview).toBe("VP-1042");
    expect(masked.orders[2].match?.valuePreview).toBe("6900123456");
  });

  it("human → the search preview is byte-identical to what SQL returned", () => {
    const gate = applyOmsAgentCustomerReadGate({
      ...base,
      authorization: { ok: true, userId: "u1", isMachineActor: false },
      governance: { flagEnabled: true, auditClient: { rpc: vi.fn() } },
    });
    expect(gate.maskOrders(ordersFixture).orders[0].match?.valuePreview).toBe("ja***@example.com");
  });

  it("human → the delivery-contact digest and correction verdict are untouched", () => {
    const gate = applyOmsAgentCustomerReadGate({
      ...base,
      authorization: { ok: true, userId: "u1", isMachineActor: false },
      governance: { flagEnabled: true, auditClient: { rpc: vi.fn() } },
    });
    const passed = gate.maskOrders(ordersFixture).orders[0].deliveryContact;
    expect(passed?.digest).toBe("0123456789abcdef0123456789abcdef");
    expect(passed?.correctionAllowed).toBe(true);
  });
});
