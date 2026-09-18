import { describe, expect, it, vi } from "vitest";
import { createPaidEmailOutboxAfterProcessed } from "./paidEmailOutboxAfterProcessed.js";

describe("paid email outbox after-processed hook", () => {
  it("dispatches paid order and subscription welcome aggregates after a succeeded payment", async () => {
    const readScope = vi.fn(async () => ({ orderId: "order-1", subscriptionId: "sub-1" }));
    const dispatchAggregate = vi.fn(async () => {});
    const hook = createPaidEmailOutboxAfterProcessed({
      enabled: () => true,
      readScope,
      dispatchAggregate,
    });

    await hook({
      event: {} as never,
      ingested: { paymentEventId: "event-1", paymentIntentId: "intent-1", paymentAttemptId: null, replayed: false },
      resultStatus: "succeeded",
    });

    expect(readScope).toHaveBeenCalledWith("intent-1");
    expect(dispatchAggregate).toHaveBeenCalledWith({ aggregateType: "commerce_order", aggregateId: "order-1" });
    expect(dispatchAggregate).toHaveBeenCalledWith({ aggregateType: "subscription", aggregateId: "sub-1" });
  });

  it("skips non-succeeded, missing-intent and disabled cases", async () => {
    const readScope = vi.fn(async () => ({ orderId: "order-1", subscriptionId: null }));
    const dispatchAggregate = vi.fn(async () => {});
    const hook = createPaidEmailOutboxAfterProcessed({
      enabled: () => false,
      readScope,
      dispatchAggregate,
    });

    await hook({ event: {} as never, ingested: { paymentEventId: "e", paymentIntentId: "i", paymentAttemptId: null, replayed: false }, resultStatus: "succeeded" });
    await createPaidEmailOutboxAfterProcessed({ enabled: () => true, readScope, dispatchAggregate })({
      event: {} as never,
      ingested: { paymentEventId: "e", paymentIntentId: null, paymentAttemptId: null, replayed: false },
      resultStatus: "succeeded",
    });
    await createPaidEmailOutboxAfterProcessed({ enabled: () => true, readScope, dispatchAggregate })({
      event: {} as never,
      ingested: { paymentEventId: "e", paymentIntentId: "i", paymentAttemptId: null, replayed: false },
      resultStatus: "failed",
    });

    expect(readScope).not.toHaveBeenCalled();
    expect(dispatchAggregate).not.toHaveBeenCalled();
  });

  it("does not throw when scope read or dispatch fails, leaving cron as backstop", async () => {
    const warn = vi.fn();
    const hook = createPaidEmailOutboxAfterProcessed({
      enabled: () => true,
      readScope: vi.fn(async () => ({ orderId: "order-1", subscriptionId: null })),
      dispatchAggregate: vi.fn(async () => {
        throw new Error("resend down");
      }),
      warn,
    });

    await expect(hook({
      event: {} as never,
      ingested: { paymentEventId: "event-1", paymentIntentId: "intent-1", paymentAttemptId: null, replayed: false },
      resultStatus: "succeeded",
    })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("paid_email_immediate_dispatch_failed", expect.objectContaining({
      paymentIntentId: "intent-1",
      message: "resend down",
    }));
  });
});
