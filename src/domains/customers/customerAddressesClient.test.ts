import { beforeEach, describe, expect, it, vi } from "vitest";

const { requestBff } = vi.hoisted(() => ({ requestBff: vi.fn() }));
vi.mock("@/lib/bff/client", () => ({ requestBff }));

import { getCustomerAddresses } from "./customerAddressesClient";

const ADDRESSES = {
  contractVersion: "customer.addresses.v1" as const,
  ordererProfiles: [],
  addresses: [],
};

describe("customer addresses client", () => {
  beforeEach(() => {
    requestBff.mockReset();
    requestBff.mockResolvedValue(ADDRESSES);
  });

  it("GETs customer address facts with the customer bearer token", async () => {
    await expect(getCustomerAddresses("access-token-123")).resolves.toEqual(ADDRESSES);

    const [path, , options] = requestBff.mock.calls[0];
    expect(path).toBe("/api/bff/customers/addresses");
    expect(options.method).toBe("GET");
    expect((options.headers as Headers).get("Authorization")).toBe("Bearer access-token-123");
  });
});
