import { describe, expect, it, vi } from "vitest";
import {
  AGENT_CUSTOMER_READ_FLAG,
  auditAgentCustomerRead,
  commerceAgentCustomerReadEnabled,
  enforceAgentCustomerRead,
  maskClientSearchPii,
  maskEmail,
  maskPhone,
} from "./agentCustomerReadGuard.js";

describe("agentCustomerReadGuard — flag + gate", () => {
  it("commerceAgentCustomerReadEnabled reads the env flag", () => {
    const prev = process.env.COMMERCE_AGENT_CUSTOMER_READ_ENABLED;
    process.env.COMMERCE_AGENT_CUSTOMER_READ_ENABLED = "true";
    expect(commerceAgentCustomerReadEnabled()).toBe(true);
    process.env.COMMERCE_AGENT_CUSTOMER_READ_ENABLED = "false";
    expect(commerceAgentCustomerReadEnabled()).toBe(false);
    delete process.env.COMMERCE_AGENT_CUSTOMER_READ_ENABLED;
    expect(commerceAgentCustomerReadEnabled()).toBe(false);
    if (prev === undefined) delete process.env.COMMERCE_AGENT_CUSTOMER_READ_ENABLED;
    else process.env.COMMERCE_AGENT_CUSTOMER_READ_ENABLED = prev;
  });

  it("blocks ONLY a machine actor when the flag is off; humans never blocked", () => {
    expect(enforceAgentCustomerRead({ isMachineActor: true, flagEnabled: false }).blocked).toBe(true);
    expect(enforceAgentCustomerRead({ isMachineActor: true, flagEnabled: true }).blocked).toBe(false);
    expect(enforceAgentCustomerRead({ isMachineActor: false, flagEnabled: false }).blocked).toBe(false);
    expect(enforceAgentCustomerRead({ isMachineActor: false, flagEnabled: true }).blocked).toBe(false);
    expect(AGENT_CUSTOMER_READ_FLAG).toBe("COMMERCE_AGENT_CUSTOMER_READ_ENABLED");
  });
});

describe("agentCustomerReadGuard — maskEmail", () => {
  it("keeps the first local char + full domain, redacts the rest", () => {
    expect(maskEmail("jan@example.com")).toBe("j***@example.com");
    expect(maskEmail("jola.kowalska@gmail.com")).toBe("j***@gmail.com");
  });

  it("handles edge cases: no @, single char, empty, null/undefined", () => {
    // Was "n***" — a value with no domain is not an address; keeping its first
    // letter revealed a character for nothing. Matches the SQL '[redacted]'.
    expect(maskEmail("nodomain")).toBe("[redacted]");
    expect(maskEmail("a@b.io")).toBe("a***@b.io");
    expect(maskEmail("")).toBe("");
    expect(maskEmail(null)).toBeNull();
    expect(maskEmail(undefined)).toBeNull();
  });

  it("reveals nothing extra from a malformed address", () => {
    // Was "***@x.com": an empty local part left the domain fully exposed.
    expect(maskEmail("@x.com")).toBe("[redacted]");
    // Was "a***@b@c.com": everything after the first @ was treated as domain.
    expect(maskEmail("a@b@c.com")).toBe("a***@b");
    expect(maskEmail("  jan@example.com  ")).toBe("j***@example.com");
  });

  it("is idempotent over the SQL preview, which keeps 2 local chars", () => {
    expect(maskEmail("ja***@example.com")).toBe("j***@example.com");
    expect(maskEmail(maskEmail("jan@example.com"))).toBe("j***@example.com");
  });
});

describe("agentCustomerReadGuard — maskPhone", () => {
  it("keeps only the last 3 digits; the country prefix is not a free reveal", () => {
    // Was "+48***123" / "12***789": the head leaked the country (and, on a
    // national number, the first operator digits) that SQL never showed.
    expect(maskPhone("+48123456123")).toBe("***123");
    expect(maskPhone("123456789")).toBe("***789");
  });

  it("reads digits, not characters, so formatting cannot shift the window", () => {
    // Was "+4***789" — the tail counted the separators, not the digits.
    expect(maskPhone("+48 123 456 789")).toBe("***789");
    expect(maskPhone("(48) 123-456-789")).toBe("***789");
  });

  it("handles short, digit-free, empty, null/undefined", () => {
    expect(maskPhone("12")).toBe("***2");
    // Was "***a": a value carrying no digits is not a number to preview at all.
    expect(maskPhone("n/a")).toBeNull();
    expect(maskPhone("")).toBe("");
    expect(maskPhone(null)).toBeNull();
    expect(maskPhone(undefined)).toBeNull();
  });

  it("is idempotent over the SQL preview", () => {
    expect(maskPhone("***123")).toBe("***123");
    expect(maskPhone(maskPhone("+48123456123"))).toBe("***123");
  });
});

describe("agentCustomerReadGuard — maskClientSearchPii", () => {
  const result = {
    candidates: [
      { clientId: "c1", email: "jan@example.com", phone: "+48123456123" },
      { clientId: "c2", email: null, phone: null },
    ],
  };

  it("masks every candidate's email/phone when mask=true", () => {
    const masked = maskClientSearchPii(result, true);
    expect(masked.candidates[0].email).toBe("j***@example.com");
    expect(masked.candidates[0].phone).toBe("***123"); // was "+48***123"
    expect(masked.candidates[1].email).toBeNull();
    // original is untouched (no mutation)
    expect(result.candidates[0].email).toBe("jan@example.com");
  });

  it("is an identity no-op when mask=false (human path byte-identical)", () => {
    expect(maskClientSearchPii(result, false)).toBe(result);
  });
});

describe("agentCustomerReadGuard — auditAgentCustomerRead", () => {
  it("calls record_admin_audit_event with action=customer_read + source=mcp_agent", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: "row-1", error: null });
    await auditAgentCustomerRead(
      { rpc },
      { actorId: "actor-1", route: "/api/bff/admin/clients/search", query: { query: "jan" }, customerIds: ["c1"] },
    );
    expect(rpc).toHaveBeenCalledWith("record_admin_audit_event", {
      p_actor_id: "actor-1",
      p_action: "customer_read",
      p_source: "mcp_agent",
      p_entity_type: "customer_read",
      p_entity_id: null,
      p_old: null,
      p_new: { route: "/api/bff/admin/clients/search", query: { query: "jan" }, customer_ids: ["c1"] },
    });
  });

  it("is best-effort: an RPC error is reported via onError, never thrown", async () => {
    const onError = vi.fn();
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(
      auditAgentCustomerRead({ rpc }, { actorId: "a", route: "/r", query: {}, customerIds: [] }, onError),
    ).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith({ message: "boom" });
  });

  it("is best-effort: a thrown RPC is swallowed + reported", async () => {
    const onError = vi.fn();
    const rpc = vi.fn().mockRejectedValue(new Error("network"));
    await expect(
      auditAgentCustomerRead({ rpc }, { actorId: "a", route: "/r", query: {}, customerIds: [] }, onError),
    ).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
