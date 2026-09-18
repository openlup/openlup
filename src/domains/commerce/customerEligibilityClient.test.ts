import { beforeEach, describe, expect, it, vi } from "vitest";

const { requestBff } = vi.hoisted(() => ({ requestBff: vi.fn() }));
vi.mock("@/lib/bff/client", () => ({ requestBff }));

import { lookupCustomerEligibility } from "./customerEligibilityClient";

const RESPONSE = {
  contractVersion: "customer_eligibility.lookup.v1" as const,
  recognized: true,
  firstOrderEligible: false,
};

describe("customer eligibility client", () => {
  beforeEach(() => {
    requestBff.mockReset();
    requestBff.mockResolvedValue(RESPONSE);
  });

  it("POSTs a normalized email lookup to the eligibility endpoint", async () => {
    const result = await lookupCustomerEligibility({
      email: "  Anna@Example.COM ",
      visitorId: "vid-1",
    });

    const [path, , options] = requestBff.mock.calls[0];
    expect(path).toBe("/api/bff/commerce/customer-eligibility");
    expect(options.method).toBe("POST");
    // Request schema trims + lowercases the email before sending.
    expect(options.body).toEqual({ email: "anna@example.com", visitorId: "vid-1" });
    expect(result).toEqual(RESPONSE);
  });

  it("rejects a malformed email before calling the endpoint", () => {
    // The request schema parses synchronously inside the client, so the throw
    // happens before any promise is returned.
    expect(() => lookupCustomerEligibility({ email: "not-an-email" })).toThrow();
    expect(requestBff).not.toHaveBeenCalled();
  });
});
