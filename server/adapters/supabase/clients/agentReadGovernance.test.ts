import { describe, expect, it, vi } from "vitest";
import { createClientsAgentReadGovernance } from "./agentReadGovernance.js";

describe("createClientsAgentReadGovernance", () => {
  it("keeps service-role audit client construction behind the clients gateway", () => {
    const previousFlag = process.env.COMMERCE_AGENT_CUSTOMER_READ_ENABLED;
    process.env.COMMERCE_AGENT_CUSTOMER_READ_ENABLED = "true";
    try {
      const client = { rpc: vi.fn() };
      const clientFactory = vi.fn(() => client);
      const governance = createClientsAgentReadGovernance(env(), { clientFactory });

      expect(governance.flagEnabled).toBe(true);
      expect(governance.auditClient).toBe(client);
      expect(clientFactory).toHaveBeenCalledWith(env());
    } finally {
      process.env.COMMERCE_AGENT_CUSTOMER_READ_ENABLED = previousFlag;
    }
  });
});

function env() {
  return { url: "https://example.supabase.co", serviceRoleKey: "service" };
}
