import { describe, expect, it, vi } from "vitest";
import { createSupabaseAdminRiskGateway } from "./adminRiskGateway.js";

describe("createSupabaseAdminRiskGateway", () => {
  it("shares one service-role backed risk port for reads and writes", () => {
    const clientFactory = vi.fn(() => ({ from: vi.fn(), rpc: vi.fn() }));
    const gateway = createSupabaseAdminRiskGateway(env(), { clientFactory });

    expect(gateway.readPort()).toBe(gateway.writePort());
    expect(gateway.readPort().listCases).toBeTypeOf("function");
    expect(gateway.writePort().decideCase).toBeTypeOf("function");
    expect(clientFactory).toHaveBeenCalledTimes(1);
  });
});

function env() {
  return { url: "https://example.supabase.co", serviceRoleKey: "service" };
}
