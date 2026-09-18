import { describe, expect, it, vi } from "vitest";

import { classifyTechnicalExpiryForRedeem } from "./checkoutRecoveryTechnicalExpiry.js";
import type { CheckoutRecoveryTokenContext } from "./checkoutRecoveryToken.js";
import type { CheckoutRecoveryOrderSnapshot } from "./checkoutRecoveryOrderPort.js";

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const CLIENT_ID = "33333333-3333-4333-8333-333333333333";

const context: CheckoutRecoveryTokenContext = {
  tokenId: "token-1",
  orderId: ORDER_ID,
  clientId: CLIENT_ID,
  mode: "one_time_order",
  status: "pending_payment",
};

function order(overrides: Partial<CheckoutRecoveryOrderSnapshot> = {}): CheckoutRecoveryOrderSnapshot {
  return {
    orderId: ORDER_ID,
    orderRef: `order_${ORDER_ID}`,
    orderNumber: "OPENLUP-11111111",
    clientId: CLIENT_ID,
    status: "pending_payment",
    mode: "one_time_order",
    totalMinor: 14900,
    currency: "PLN",
    petName: null,
    cadenceDays: null,
    createdAt: "2026-07-21T10:00:00.000Z",
    customerEmail: "anna@example.com",
    customerName: "Anna Kowalska",
    paymentIntentId: "22222222-2222-4222-8222-222222222222",
    paymentIntentStatus: "failed",
    subscriptionId: null,
    subscriptionCycleId: null,
    shippingAddressId: "shipping-address-1",
    quoteSnapshot: { quote: { lines: [] } } as never,
    technicallyExpired: true,
    ...overrides,
  };
}

function deps(snapshot: CheckoutRecoveryOrderSnapshot, unchanged = true) {
  return {
    rawToken: "raw-token",
    context,
    tokenPort: {
      issue: vi.fn(async () => "token-1"),
      validate: vi.fn(async () => context),
      inspect: vi.fn(async () => null),
    },
    orderPort: {
      getRecoveryOrder: vi.fn(async () => snapshot),
      getLatestRecoveryOrder: vi.fn(async () => snapshot),
    },
    expiredRecoveryService: {
      validate: vi.fn(async () => unchanged),
      recreate: vi.fn(),
    },
    now: new Date("2026-07-22T10:00:00.000Z"),
  };
}

describe("checkout recovery technical expiry classification", () => {
  it("fails closed for non-canonical pending technical expiry from active token authority", async () => {
    const input = deps(order());
    const outcome = await classifyTechnicalExpiryForRedeem(input);

    expect(outcome.kind).toBe("order_changed");
    expect(input.tokenPort.inspect).toHaveBeenCalledWith("raw-token");
    expect(input.expiredRecoveryService.validate).not.toHaveBeenCalled();
  });

  it("retries only a newest descendant whose intent is not technically expired", async () => {
    const descendant = order({
      orderId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      technicallyExpired: false,
    });
    const input = deps(descendant);

    await expect(classifyTechnicalExpiryForRedeem(input)).resolves.toMatchObject({
      kind: "retry_existing",
      snapshot: { orderId: descendant.orderId },
    });
    expect(input.expiredRecoveryService.validate).not.toHaveBeenCalled();
  });

  it("fails closed when quote or shipping evidence is missing", async () => {
    const input = deps(order({ quoteSnapshot: null, shippingAddressId: null }));

    await expect(classifyTechnicalExpiryForRedeem(input)).resolves.toMatchObject({
      kind: "order_changed",
    });
    expect(input.expiredRecoveryService.validate).not.toHaveBeenCalled();
  });

  it("classifies a latest paid order as terminal", async () => {
    const input = deps(order({ status: "paid", technicallyExpired: false }));
    await expect(classifyTechnicalExpiryForRedeem(input)).resolves.toMatchObject({ kind: "paid" });
  });
});
