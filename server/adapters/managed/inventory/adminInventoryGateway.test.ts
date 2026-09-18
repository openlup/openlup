import { describe, expect, it, vi } from "vitest";
import {
  createManagedAdminInventoryGateway,
} from "./adminInventoryGateway.js";

describe("createManagedAdminInventoryGateway", () => {
  it("shares one service-role backed inventory port for reads and mutations", () => {
    const clientFactory = vi.fn(() => ({ from: vi.fn(), rpc: vi.fn() }));
    const gateway = createManagedAdminInventoryGateway(env(), { clientFactory });

    expect(gateway.readPort()).toBe(gateway.mutationPort());
    expect(gateway.readPort().listStock).toBeTypeOf("function");
    expect(gateway.mutationPort().adjustStock).toBeTypeOf("function");
    expect(clientFactory).toHaveBeenCalledTimes(1);
  });
});

function env() {
  return { url: "https://example.invalid", serviceRoleKey: "service" };
}
