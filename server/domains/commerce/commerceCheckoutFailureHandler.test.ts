import { afterEach, describe, expect, it, vi } from "vitest";
import { CommerceRuntimeConflictError } from "../../../src/domains/commerce/runtimePorts.js";
import type { VercelResponse } from "../../_lib/types/vercel.js";
import { CheckoutOrchestrationError } from "./commerceCheckoutOrchestration.js";
import { respondToCheckoutFailure } from "./commerceCheckoutFailureHandler.js";
import { mapStartRuntimeFailure } from "./commerceCheckoutStartRuntimeFailure.js";
import { intent, ORDER_ID, quoteSnapshot } from "./commerceCheckoutHandler.testFixtures.js";
import { ProviderAttemptInFlightError } from "../../shared/preparedProviderAttempt.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("checkout failure handler", () => {
  it("compensates before emitting a sanitized generic failure envelope", async () => {
    const events: string[] = [];
    const res = response(events);
    const compensationPort = {
      releaseOrderReservations: vi.fn(async () => {
        events.push("release");
        return { releasedCount: 1 };
      }),
      cancelUnstartedPromotionOrder: vi.fn(async () => {
        events.push("cancel-promotion-draft");
        return { cancelled: true };
      }),
      cancelAbandonedOrder: vi.fn().mockResolvedValue({ cancelled: true }),
    };
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {
      events.push("error-log");
    });

    const outcome = await respondToCheckoutFailure({
      error: new CheckoutOrchestrationError(
        "provider alice@example.com token=unsafe-value",
        ORDER_ID,
      ),
      compensationPort,
      intent: intent(),
      res,
      quotePort: { createQuote: vi.fn() },
      provisioned: provisioned(),
      checkoutKind: "one_time",
      acceptedQuoteSnapshot: null,
      recordQuote: async <T>(operation: () => Promise<T>) => operation(),
    });

    expect(outcome).toBe("error");
    expect(events.slice(0, 4)).toEqual([
      "release", "cancel-promotion-draft", "error-log", "status:503",
    ]);
    expect(compensationPort.releaseOrderReservations).toHaveBeenCalledWith({
      idempotencyKey: `${intent().idempotencyKey}:checkout-compensation`,
      orderId: ORDER_ID,
      reason: "checkout_orchestration_failed",
    });
    expect(res.json).toHaveBeenCalledWith({
      ok: false,
      error: {
        code: "UPSTREAM_UNAVAILABLE",
        message: "Checkout failed",
        details: { feature: "checkout", stage: "orchestrate_order" },
      },
    });
    const logged = JSON.stringify(errorLog.mock.calls);
    expect(logged).toContain("[redacted-email]");
    expect(logged).toContain("token=[redacted]");
    expect(logged).not.toContain("alice@example.com");
    expect(logged).not.toContain("unsafe-value");
  });

  it("maps an in-flight provider attempt to the existing conflict contract without compensation", async () => {
    const res = response([]);
    const compensationPort = {
      releaseOrderReservations: vi.fn(),
      cancelUnstartedPromotionOrder: vi.fn(),
      cancelAbandonedOrder: vi.fn(),
    };

    const outcome = await respondToCheckoutFailure({
      error: new CheckoutOrchestrationError(
        "provider attempt remains in flight",
        null,
        "provider_attempt_in_flight",
      ),
      compensationPort,
      intent: intent(),
      res,
      quotePort: { createQuote: vi.fn() },
      provisioned: provisioned(),
      checkoutKind: "one_time",
      acceptedQuoteSnapshot: null,
      recordQuote: async <T>(operation: () => Promise<T>) => operation(),
    });

    expect(outcome).toBe("rejected");
    expect(compensationPort.releaseOrderReservations).not.toHaveBeenCalled();
    expect(compensationPort.cancelUnstartedPromotionOrder).not.toHaveBeenCalled();
    expect(compensationPort.cancelAbandonedOrder).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({
        code: "CONFLICT",
        details: {
          feature: "checkout",
          stage: "start_runtime",
          reason: "provider_attempt_in_flight",
        },
      }),
    }));
  });

  it("maps the named D8 prepare conflict to 409 without releasing or cancelling the aggregate", async () => {
    const res = response([]);
    const compensationPort = {
      releaseOrderReservations: vi.fn(),
      cancelUnstartedPromotionOrder: vi.fn(),
      cancelAbandonedOrder: vi.fn(),
    };
    const error = mapStartRuntimeFailure(new CommerceRuntimeConflictError(
      "Payment-control prepare attempt idempotency conflict",
      { code: "23505", reason: "payment_control_provider_attempt_prepare_idempotency_conflict" },
    ), ORDER_ID);

    const outcome = await respondToCheckoutFailure({
      error,
      compensationPort,
      intent: intent(),
      res,
      quotePort: { createQuote: vi.fn() },
      provisioned: provisioned(),
      checkoutKind: "one_time",
      acceptedQuoteSnapshot: null,
      recordQuote: async <T>(operation: () => Promise<T>) => operation(),
    });

    expect(outcome).toBe("rejected");
    expect(compensationPort.releaseOrderReservations).not.toHaveBeenCalled();
    expect(compensationPort.cancelUnstartedPromotionOrder).not.toHaveBeenCalled();
    expect(compensationPort.cancelAbandonedOrder).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({
        code: "CONFLICT",
        details: { feature: "checkout", stage: "start_runtime", reason: "provider_attempt_in_flight" },
      }),
    }));
  });

  it("logs sanitized prepared-attempt facts before its in-flight conflict response", async () => {
    const res = response([]);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const compensationPort = {
      releaseOrderReservations: vi.fn(),
      cancelUnstartedPromotionOrder: vi.fn(),
      cancelAbandonedOrder: vi.fn(),
    };
    const error = mapStartRuntimeFailure(new ProviderAttemptInFlightError({
      paymentAttemptId: "attempt-internal-1",
      status: "processing",
      providerAttemptId: null,
      providerSessionId: null,
    }), ORDER_ID);

    const outcome = await respondToCheckoutFailure({
      error,
      compensationPort,
      intent: intent(),
      res,
      quotePort: { createQuote: vi.fn() },
      provisioned: provisioned(),
      checkoutKind: "one_time",
      acceptedQuoteSnapshot: null,
      recordQuote: async <T>(operation: () => Promise<T>) => operation(),
    });

    expect(outcome).toBe("rejected");
    expect(compensationPort.releaseOrderReservations).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(errorLog).toHaveBeenCalledWith(
      "checkout_provider_attempt_failure",
      expect.stringContaining('"paymentAttemptId":"attempt-internal-1"'),
    );
    const logged = JSON.parse(String(errorLog.mock.calls[0]?.[1]));
    expect(logged).toMatchObject({ phase: "transaction_dispatch", dispatchState: "unknown" });
    expect(JSON.stringify(logged)).not.toContain("provider prose");
  });

  it("preserves an order with a dispatch-uncertain prepared attempt", async () => {
    const res = response([]);
    const compensationPort = {
      releaseOrderReservations: vi.fn(),
      cancelUnstartedPromotionOrder: vi.fn(),
      cancelAbandonedOrder: vi.fn(),
    };

    const outcome = await respondToCheckoutFailure({
      error: new CheckoutOrchestrationError(
        "provider execution timed out after prepare",
        ORDER_ID,
        "provider_attempt_in_flight",
      ),
      compensationPort,
      intent: intent(),
      res,
      quotePort: { createQuote: vi.fn() },
      provisioned: provisioned(),
      checkoutKind: "one_time",
      acceptedQuoteSnapshot: null,
      recordQuote: async <T>(operation: () => Promise<T>) => operation(),
    });

    expect(outcome).toBe("rejected");
    expect(compensationPort.releaseOrderReservations).not.toHaveBeenCalled();
    expect(compensationPort.cancelUnstartedPromotionOrder).not.toHaveBeenCalled();
    expect(compensationPort.cancelAbandonedOrder).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({
        code: "CONFLICT",
        details: {
          feature: "checkout",
          stage: "start_runtime",
          reason: "provider_attempt_in_flight",
        },
      }),
    }));
  });

  it("re-quotes an atomic promotion price change before returning rejected", async () => {
    const res = response([]);
    const compensationPort = {
      releaseOrderReservations: vi.fn(),
      cancelUnstartedPromotionOrder: vi.fn(),
      cancelAbandonedOrder: vi.fn(),
    };
    const createQuote = vi.fn().mockResolvedValue(
      quoteSnapshot({ amountMinor: 5_000, currency: "PLN" }),
    );

    const outcome = await respondToCheckoutFailure({
      error: new CheckoutOrchestrationError(
        "promotion code price changed",
        null,
        "promotion_code_price_changed",
      ),
      compensationPort,
      intent: { ...intent(), promoCodes: ["SAVE80"] },
      res,
      quotePort: { createQuote },
      provisioned: provisioned(),
      checkoutKind: "one_time",
      acceptedQuoteSnapshot: quoteSnapshot({ amountMinor: 2_000, currency: "PLN" }),
      expectedQuote: { totalGross: { amountMinor: 2_000, currency: "PLN" } },
      recordQuote: async <T>(operation: () => Promise<T>) => operation(),
    });

    expect(outcome).toBe("rejected");
    expect(createQuote).toHaveBeenCalledOnce();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "price_changed" }),
    }));
  });

  it("maps inventory conflicts after compensation and cancels the abandoned order", async () => {
    const events: string[] = [];
    const res = response(events);
    const compensationPort = {
      releaseOrderReservations: vi.fn(async () => {
        events.push("release");
        return { releasedCount: 1 };
      }),
      cancelUnstartedPromotionOrder: vi.fn(async () => {
        events.push("cancel-promotion-draft");
        return { cancelled: false };
      }),
      cancelAbandonedOrder: vi.fn(async () => {
        events.push("cancel-abandoned");
        return { cancelled: true };
      }),
    };

    const outcome = await respondToCheckoutFailure({
      error: new CheckoutOrchestrationError(
        "start_runtime: Inventory reservation conflict",
        ORDER_ID,
      ),
      compensationPort,
      intent: intent(),
      res,
      quotePort: { createQuote: vi.fn() },
      provisioned: provisioned(),
      checkoutKind: "one_time",
      acceptedQuoteSnapshot: null,
      recordQuote: async <T>(operation: () => Promise<T>) => operation(),
    });

    expect(outcome).toBe("rejected");
    expect(events.slice(0, 4)).toEqual([
      "release", "cancel-promotion-draft", "cancel-abandoned", "status:409",
    ]);
    expect(compensationPort.cancelAbandonedOrder).toHaveBeenCalledWith({
      idempotencyKey: intent().idempotencyKey,
      orderId: ORDER_ID,
      reason: "checkout_stock_unavailable",
    });
    expect(compensationPort.cancelUnstartedPromotionOrder).toHaveBeenCalledWith({
      idempotencyKey: intent().idempotencyKey,
      orderId: ORDER_ID,
      reason: "checkout_stock_unavailable",
    });
    expect(compensationPort.cancelAbandonedOrder).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({
        code: "CONFLICT",
        details: { feature: "checkout", stage: "start_runtime", reason: "stock_unavailable" },
      }),
    }));
  });

  it("maps the consumed-journey conflict to CONFLICT/journey_consumed and cancels the abandoned draft", async () => {
    const events: string[] = [];
    const res = response(events);
    const compensationPort = {
      releaseOrderReservations: vi.fn(async () => {
        events.push("release");
        return { releasedCount: 0 };
      }),
      cancelUnstartedPromotionOrder: vi.fn(async () => {
        events.push("cancel-promotion-draft");
        return { cancelled: false };
      }),
      cancelAbandonedOrder: vi.fn(async () => {
        events.push("cancel-abandoned");
        return { cancelled: true };
      }),
    };

    const outcome = await respondToCheckoutFailure({
      error: new CheckoutOrchestrationError(
        "start_runtime: Commerce checkout journey already completed",
        ORDER_ID,
        "journey_consumed",
      ),
      compensationPort,
      intent: intent(),
      res,
      quotePort: { createQuote: vi.fn() },
      provisioned: provisioned(),
      checkoutKind: "one_time",
      acceptedQuoteSnapshot: null,
      recordQuote: async <T>(operation: () => Promise<T>) => operation(),
    });

    expect(outcome).toBe("rejected");
    expect(events.slice(0, 4)).toEqual([
      "release", "cancel-promotion-draft", "cancel-abandoned", "status:409",
    ]);
    expect(compensationPort.cancelAbandonedOrder).toHaveBeenCalledWith({
      idempotencyKey: intent().idempotencyKey,
      orderId: ORDER_ID,
      reason: "checkout_journey_consumed",
    });
    expect(compensationPort.cancelUnstartedPromotionOrder).toHaveBeenCalledWith({
      idempotencyKey: intent().idempotencyKey,
      orderId: ORDER_ID,
      reason: "checkout_journey_consumed",
    });
    expect(compensationPort.cancelAbandonedOrder).toHaveBeenCalledTimes(1);
    expect(events).toContain("status:409");
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({
        code: "CONFLICT",
        details: { feature: "checkout", stage: "start_runtime", reason: "journey_consumed" },
      }),
    }));
  });
});

function response(events: string[]): VercelResponse {
  const res = {
    setHeader: vi.fn(),
    status: vi.fn((status: number) => {
      events.push(`status:${status}`);
      return res;
    }),
    json: vi.fn(() => res),
  };
  return res as unknown as VercelResponse;
}

function provisioned() {
  return {
    contractVersion: "commerce.configurator_intent_persistence.v1" as const,
    intentVersion: "commerce.configurator_intent.v1" as const,
    idempotencyKey: intent().idempotencyKey,
    clientId: "client-1",
    petId: "pet-1",
    addressId: "address-1",
    replayed: false,
  };
}
