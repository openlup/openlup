import { describe, expect, it, vi } from "vitest";
import type { VercelResponse } from "../../_lib/types/vercel.js";
import { applyAgentCustomerReadGate } from "./agentCustomerReadGovernance.js";

function createResponse(): VercelResponse {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() } as unknown as VercelResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}

describe("applyAgentCustomerReadGate (clients)", () => {
  const baseArgs = {
    res: createResponse(),
    route: "/api/bff/admin/clients/search",
    query: { query: "jan" },
  };

  it("passes a human through untouched (no block, identity mask, no-op audit)", async () => {
    const auditClient = { rpc: vi.fn() };
    const gate = applyAgentCustomerReadGate({
      ...baseArgs,
      authorization: { ok: true, userId: "u1", isMachineActor: false },
      governance: { flagEnabled: false, auditClient },
    });
    expect(gate.blocked).toBe(false);
    expect(gate.isMachine).toBe(false);
    const result = { candidates: [{ email: "a@b.io", phone: "123" }] };
    expect(gate.maskSearch(result)).toBe(result);
    await gate.audit(["c1"]);
    expect(auditClient.rpc).not.toHaveBeenCalled();
  });

  it("blocks a machine actor when governance is absent (no service-role env) — fail-closed", () => {
    const res = createResponse();
    const gate = applyAgentCustomerReadGate({
      ...baseArgs,
      res,
      authorization: { ok: true, userId: "u1", isMachineActor: true },
      governance: undefined,
    });
    expect(gate.blocked).toBe(true);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      ok: false,
      error: expect.objectContaining({
        details: { reason: "feature_flag_disabled", featureFlag: "COMMERCE_AGENT_CUSTOMER_READ_ENABLED" },
      }),
    });
  });

  it("passes a human through even when governance is absent (backward-compat)", () => {
    const gate = applyAgentCustomerReadGate({
      ...baseArgs,
      authorization: { ok: true, userId: "u1", isMachineActor: false },
      governance: undefined,
    });
    expect(gate.blocked).toBe(false);
  });

  it("blocks a machine actor + flag OFF and sends the disabled envelope", () => {
    const res = createResponse();
    const gate = applyAgentCustomerReadGate({
      ...baseArgs,
      res,
      authorization: { ok: true, userId: "u1", isMachineActor: true },
      governance: { flagEnabled: false, auditClient: { rpc: vi.fn() } },
    });
    expect(gate.blocked).toBe(true);
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it("machine + flag ON masks search PII and audits with the resolved actor", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: "row", error: null });
    const gate = applyAgentCustomerReadGate({
      ...baseArgs,
      authorization: { ok: true, userId: "u1", isMachineActor: true },
      governance: { flagEnabled: true, auditClient: { rpc } },
    });
    expect(gate.blocked).toBe(false);
    const masked = gate.maskSearch({ candidates: [{ email: "jan@example.com", phone: "+48123456123" }] });
    expect(masked.candidates[0].email).toBe("j***@example.com");
    await gate.audit(["c1"]);
    expect(rpc).toHaveBeenCalledWith(
      "record_admin_audit_event",
      expect.objectContaining({ p_actor_id: "u1", p_action: "customer_read" }),
    );
  });
});
