import { beforeEach, describe, expect, it, vi } from "vitest";

const { requestBff } = vi.hoisted(() => ({ requestBff: vi.fn() }));
vi.mock("@/lib/bff/client", () => ({ requestBff }));

import { redeemPaymentRecovery } from "./paymentRecoveryClient";

const REQUEST = {
  idempotencyKey: "payment-recovery:test-1",
  recoveryToken: "r".repeat(64),
  paymentMethodRef: "pm_provider_reusable",
  paymentMethodKind: "card",
  requestedAt: "2026-06-08T10:00:00+00:00",
};

const RESPONSE = {
  contractVersion: "payment.recovery.v1" as const,
  recovery: {
    caseId: "11111111-1111-1111-1111-111111111111",
    subscriptionId: "22222222-2222-2222-2222-222222222222",
    cycleId: "33333333-3333-3333-3333-333333333333",
    orderId: "44444444-4444-4444-4444-444444444444",
    purpose: "repair_payment" as const,
    nextAction: "retry_existing_cycle" as const,
    replayed: false,
  },
};

describe("payment recovery client", () => {
  beforeEach(() => {
    requestBff.mockReset();
    requestBff.mockResolvedValue(RESPONSE);
  });

  it("POSTs recovery redemption with the customer bearer token", async () => {
    await expect(redeemPaymentRecovery("access-token-123", REQUEST)).resolves.toEqual(RESPONSE);

    const [path, , options] = requestBff.mock.calls[0];
    expect(path).toBe("/api/bff/customers/payment-recovery/redeem");
    expect(options.method).toBe("POST");
    expect(options.body).toEqual(REQUEST);
    expect((options.headers as Headers).get("Authorization")).toBe("Bearer access-token-123");
  });
});
