import { beforeEach, describe, expect, it, vi } from "vitest";
import { referenceCheckoutResponseSchema } from "./checkoutCommandContracts";

const { requestBff } = vi.hoisted(() => ({ requestBff: vi.fn() }));
vi.mock("@/lib/bff/client", () => ({ requestBff }));

import { submitReferenceCheckout } from "./referenceCommerceClient";

const request = {
  command: {
    version: "commerce.checkout_command.v1" as const,
    idempotencyKey: "reference-client:happy",
    mode: "one_time" as const,
    lines: [{ sku: "REFERENCE-001", quantity: 1 }],
    customer: { firstName: "Ada", lastName: "Lovelace", email: "ada@example.test", phone: "+10000000000" },
    shippingAddress: { street: "Journey Lane", postalCode: "00000", city: "Local", country: "DE" },
    currency: "EUR",
  },
};
const response = {
  version: "commerce.reference_checkout.v1",
  orderId: "11111111-1111-4111-8111-111111111111",
};

describe("reference commerce client", () => {
  beforeEach(() => { requestBff.mockReset(); requestBff.mockResolvedValue(response); });

  it("uses the reference endpoint, response schema, timeout, POST, and body", async () => {
    await expect(submitReferenceCheckout(request)).resolves.toBe(response);
    expect(requestBff).toHaveBeenCalledWith(
      "/api/bff/commerce/checkouts",
      referenceCheckoutResponseSchema,
      { timeoutMs: 25_000, method: "POST", body: request },
    );
  });

  it("allows caller options to override timeout but not method or body", async () => {
    await submitReferenceCheckout(request, { timeoutMs: 1_500, method: "DELETE", body: { unsafe: true }, headers: { "x-reference": "test" } });
    expect(requestBff.mock.calls[0]?.[2]).toEqual({ timeoutMs: 1_500, method: "POST", body: request, headers: { "x-reference": "test" } });
  });
});
