import { describe, expect, it, vi } from "vitest";
import { createSupabaseAdminAccountingGateway } from "./adminAccountingGateway.js";

describe("createSupabaseAdminAccountingGateway", () => {
  it("lazily reuses the service-role client across accounting ports", () => {
    const clientFactory = vi.fn(() => ({ from: vi.fn(), rpc: vi.fn() }));
    const gateway = createSupabaseAdminAccountingGateway(env(), { clientFactory });

    expect(gateway.controlPort()).toBe(gateway.controlPort());
    expect(gateway.readPort()).toBe(gateway.readPort());
    expect(gateway.invoicePort()).toBe(gateway.invoicePort());
    expect(clientFactory).toHaveBeenCalledTimes(1);
  });
});

function env() {
  return { url: "https://example.supabase.co", serviceRoleKey: "service" };
}
