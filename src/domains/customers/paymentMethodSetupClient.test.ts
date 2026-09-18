import { beforeEach, describe, expect, it, vi } from "vitest";

const { requestBff } = vi.hoisted(() => ({ requestBff: vi.fn() }));
vi.mock("@/lib/bff/client", () => ({ requestBff }));

import { startCustomerCardSetup } from "./paymentMethodSetupClient";

describe("customer payment method setup client", () => {
  beforeEach(() => {
    requestBff.mockReset();
  });

  it("parses and sends only the subscription-scoped Stripe setup request", async () => {
    const response = {
      contractVersion: "customer.payment-method-setup.v1" as const,
      setup: {
        clientSecret: "seti_secret",
        setupIntentId: "seti_123",
        subscriptionId: "33333333-3333-4333-8333-333333333333",
      },
    };
    requestBff.mockResolvedValue(response);

    await expect(
      startCustomerCardSetup("access-token-123", {
        idempotencyKey: "card-setup-1",
        subscriptionId: "33333333-3333-4333-8333-333333333333",
      }),
    ).resolves.toEqual(response);

    const [path, , options] = requestBff.mock.calls[0];
    expect(path).toBe("/api/bff/customers/payment-method/setup");
    expect(options.method).toBe("POST");
    expect(options.body).toEqual({
      idempotencyKey: "card-setup-1",
      subscriptionId: "33333333-3333-4333-8333-333333333333",
    });
  });

  it("rejects unexpected Stripe setup fields before the BFF request", async () => {
    expect(() =>
      startCustomerCardSetup("access-token-123", {
        idempotencyKey: "card-setup-1",
        subscriptionId: "33333333-3333-4333-8333-333333333333",
        cardNumber: "4242424242424242",
      } as never),
    ).toThrow();

    expect(requestBff).not.toHaveBeenCalled();
  });
});
