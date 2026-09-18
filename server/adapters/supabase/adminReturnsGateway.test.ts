import { describe, expect, it, vi } from "vitest";
import { createSupabaseAdminReturnsGateway } from "./adminReturnsGateway.js";

describe("createSupabaseAdminReturnsGateway", () => {
  it("lazily builds the returns port from a service-role client", () => {
    const clientFactory = vi.fn(() => ({ rpc: vi.fn() }));
    const gateway = createSupabaseAdminReturnsGateway(env(), { clientFactory });

    expect(gateway.returnsPort()).toBe(gateway.returnsPort());
    expect(gateway.returnsPort().approve).toBeTypeOf("function");
    expect(clientFactory).toHaveBeenCalledTimes(1);
  });
});

function env() {
  return { url: "https://example.supabase.co", serviceRoleKey: "service" };
}
