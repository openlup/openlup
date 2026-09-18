import { describe, expect, it, vi } from "vitest";

import { createCommerceRuntimeService } from "./commerceRuntimeService.js";
import {
  makeInventoryPort,
  makeOrderPort,
  makePaymentPort,
  makeReadinessPort,
  orderDraftSummary,
} from "./commerceRuntimeService.fixtures.js";

describe("commerce runtime synchronous decline", () => {
  it("closes a fresh retry attempt and keeps its recoverable reservation", async () => {
    const paymentPort = makePaymentPort();
    paymentPort.applyResult.mockResolvedValueOnce({
      paymentIntentId: "88888888-8888-4888-8888-888888888888",
      paymentAttemptId: "55555555-5555-4555-8555-555555555555",
      paymentId: "99999999-9999-4999-8999-999999999999",
      orderId: "11111111-1111-4111-8111-111111111111",
      status: "failed",
      kind: "recoverable_decline",
      replayed: false,
    });
    const inventoryPort = makeInventoryPort();
    inventoryPort.releaseOrderReservations.mockResolvedValueOnce({ releasedCount: 1 });
    const execute = vi.fn().mockResolvedValue({
      provider: "tpay",
      providerAttemptId: "tpay-declined-1",
      providerSessionId: null,
      attemptStatus: "processing",
      nextActionKind: null,
      requestPayload: {},
      responsePayload: { providerErrorCodes: ["payment_failed"] },
      providerDecline: { code: "payment_failed", mandateUnsupported: true },
    });
    const service = createCommerceRuntimeService({
      orderPort: makeOrderPort(),
      inventoryPort,
      paymentPort,
      readinessPort: makeReadinessPort(),
      executionPort: { execute },
    });

    const response = await service.startRuntime({
      idempotencyKey: "wave1-runtime-tpay-retry",
      paymentAttemptSequence: 2,
      mode: "one_time",
      clientId: "22222222-2222-4222-8222-222222222222",
      shippingAddressId: "33333333-3333-4333-8333-333333333333",
      orderDraft: orderDraftSummary(),
      paymentProvider: "tpay",
      providerFlow: "blik_one_time",
      paymentExecution: { provider: "tpay", flow: "blik_one_time", blikToken: "000000" },
      metadata: {},
    });

    expect(paymentPort.prepareProviderAttempt).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "wave1-runtime-tpay-retry:payment-execution:attempt:2:prepare-attempt",
    }));
    expect(paymentPort.applyResult).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "wave1-runtime-tpay-retry:payment-execution:attempt:2:payment-declined",
      resultStatus: "failed",
      failureReason: "blik_recurring_unsupported_bank",
    }));
    expect(inventoryPort.releaseOrderReservations).not.toHaveBeenCalled();
    expect(response.runtime.payment.attemptStatus).toBe("failed");
  });
});
