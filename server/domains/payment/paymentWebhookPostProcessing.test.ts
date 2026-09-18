import { describe, expect, it, vi } from "vitest";
import { handoffExplicitPaymentRefusal } from "./paymentWebhookPostProcessing.js";

const input = {
  outcome: "refused" as const,
  idempotencyKey: "payment-refusal:event-1",
  paymentIntentId: "intent-1",
  sourceEventId: "event-1",
  failureReason: "insufficient_funds",
  occurredAt: "2026-08-15T12:00:00.000Z",
};

describe("payment webhook post-processing", () => {
  it("hands an explicit refusal to dunning exactly once", async () => {
    const openFromExplicitRefusal = vi.fn(async () => undefined);
    await handoffExplicitPaymentRefusal(input, { openFromExplicitRefusal });
    expect(openFromExplicitRefusal).toHaveBeenCalledOnce();
    expect(openFromExplicitRefusal).toHaveBeenCalledWith({
      idempotencyKey: input.idempotencyKey,
      paymentIntentId: input.paymentIntentId,
      sourceEventId: input.sourceEventId,
      failureReason: input.failureReason,
      occurredAt: input.occurredAt,
    });
  });

  it.each(["not_refused" as const])("does not convert %s evidence to dunning", async (outcome) => {
    const openFromExplicitRefusal = vi.fn(async () => undefined);
    await handoffExplicitPaymentRefusal({ ...input, outcome }, { openFromExplicitRefusal });
    expect(openFromExplicitRefusal).not.toHaveBeenCalled();
  });

  it("does not hand off an unowned payment", async () => {
    const openFromExplicitRefusal = vi.fn(async () => undefined);
    await handoffExplicitPaymentRefusal({ ...input, paymentIntentId: null }, { openFromExplicitRefusal });
    expect(openFromExplicitRefusal).not.toHaveBeenCalled();
  });
});
