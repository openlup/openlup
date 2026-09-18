import { beforeEach, describe, expect, it, vi } from "vitest";

const { requestBff } = vi.hoisted(() => ({ requestBff: vi.fn() }));
vi.mock("@/lib/bff/client", () => ({ requestBff }));

import { getCustomerPaymentMethods } from "./customerPaymentMethodsClient";

const PAYMENT_METHODS = {
  contractVersion: "customer.payment_methods.v1" as const,
  paymentMethods: [
    {
      id: "22222222-2222-4222-8222-222222222222",
      provider: "tpay" as const,
      methodKind: "blik_payid" as const,
      status: "active" as const,
      usableFor: ["one_time", "subscription"] as const,
      label: "BLIK w aplikacji bankowej",
    },
  ],
};

describe("customer payment methods client", () => {
  beforeEach(() => {
    requestBff.mockReset();
  });

  it("GETs saved payment methods with the customer bearer token", async () => {
    requestBff.mockResolvedValue(PAYMENT_METHODS);

    await expect(getCustomerPaymentMethods("access-token-123")).resolves.toEqual(PAYMENT_METHODS);

    const [path, , options] = requestBff.mock.calls[0];
    expect(path).toBe("/api/bff/customers/payment-methods");
    expect(options.method).toBe("GET");
    expect((options.headers as Headers).get("Authorization")).toBe("Bearer access-token-123");
  });
});
