import { describe, expect, it, vi, beforeEach } from "vitest";

const { requestBff } = vi.hoisted(() => ({ requestBff: vi.fn() }));
vi.mock("@/lib/bff/client", () => ({ requestBff }));

import { getCustomerMe } from "./customerMeClient";

const PROFILE = {
  clientId: "11111111-1111-1111-1111-111111111111",
  email: "buyer@example.com",
  firstName: "Bart",
  lastName: null,
  lifecycleStage: "customer" as const,
};

describe("getCustomerMe", () => {
  beforeEach(() => {
    requestBff.mockReset();
    requestBff.mockResolvedValue(PROFILE);
  });

  it("GETs /api/bff/customers/me with the bearer token and returns the profile", async () => {
    const result = await getCustomerMe("access-token-123");

    expect(result).toEqual(PROFILE);
    expect(requestBff).toHaveBeenCalledTimes(1);
    const [path, , options] = requestBff.mock.calls[0];
    expect(path).toBe("/api/bff/customers/me");
    expect(options.method).toBe("GET");
    const headers = options.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer access-token-123");
  });
});
