import { describe, expect, it, vi } from "vitest";

import {
  classifyDecline,
  DECLINE_FAILURE_REASONS,
  finalizeDeclinedAttempt,
} from "./finalizeDeclinedAttempt.js";

function portSpy() {
  return {
    applyResult: vi.fn(async (_request: { failureReason?: string | null }) => ({
      paymentIntentId: "intent-1",
      paymentAttemptId: "attempt-1",
      paymentId: "payment-1",
      orderId: "order-1",
      status: "failed" as const,
      kind: "payment_failed",
      replayed: false,
    })),
  };
}

const baseArgs = {
  idempotencyKey: "key:payment-declined",
  orderId: "order-1",
  paymentIntentId: "intent-1",
  fallbackAttemptId: "attempt-1",
  now: () => new Date("2026-07-20T18:32:47.000Z"),
};

describe("finalizeDeclinedAttempt", () => {
  it("closes the attempt as failed when the payer's bank cannot register a mandate", async () => {
    const port = portSpy();
    // Shape of the real production rejection observed on 2026-07-20 (mBank):
    // generic `payment_failed` code, with the bank verdict carried separately
    // because the code alone cannot distinguish an incapable bank from a typo.
    const result = await finalizeDeclinedAttempt(port, {
      ...baseArgs,
      decline: { code: "payment_failed", mandateUnsupported: true },
    });

    expect(port.applyResult).toHaveBeenCalledWith(
      expect.objectContaining({
        resultStatus: "failed",
        failureReason: DECLINE_FAILURE_REASONS.mandateUnsupported,
      }),
    );
    expect(result.status).toBe("failed");
  });

  it("falls back to a generic reason when the provider did not say the bank was at fault", async () => {
    const port = portSpy();
    await finalizeDeclinedAttempt(port, {
      ...baseArgs,
      decline: { code: "payment_failed", mandateUnsupported: false },
    });

    expect(port.applyResult).toHaveBeenCalledWith(
      expect.objectContaining({ failureReason: DECLINE_FAILURE_REASONS.generic }),
    );
  });

  it("never forwards provider prose as the failure reason", async () => {
    const port = portSpy();
    await finalizeDeclinedAttempt(port, {
      ...baseArgs,
      // Tpay's own message for this case is free-form Polish. Only codes are
      // persisted, so payer-identifying text can never leak into the column.
      decline: { code: "payment_failed", mandateUnsupported: true },
    });

    const reason = port.applyResult.mock.calls[0]?.[0]?.failureReason;
    expect(Object.values(DECLINE_FAILURE_REASONS)).toContain(reason);
  });

  it("carries the classification to the control plane alongside the reason", async () => {
    const port = portSpy();
    await finalizeDeclinedAttempt(port, {
      ...baseArgs,
      decline: { code: "payment_failed", mandateUnsupported: true },
    });

    expect(port.applyResult).toHaveBeenCalledWith(
      expect.objectContaining({
        failureClassification: { failureClass: "mandate_dead", decidedBy: "neutral_hint" },
      }),
    );
  });
});

describe("classifyDecline", () => {
  it("closes the taxonomy's declared gap: the mandate flag yields mandate_dead", () => {
    // The kernel maps the scheme-named reason key this flag produces to nothing,
    // deliberately — a scheme name may not enter the neutral package. Asserting
    // the neutral hint here is what supplies the verdict on the correct side of
    // that boundary.
    expect(classifyDecline({ code: "payment_failed", mandateUnsupported: true }))
      .toEqual({ failureClass: "mandate_dead", decidedBy: "neutral_hint" });
  });

  it("lets the issuer's advice outrank a hint the adapter asserted", () => {
    expect(classifyDecline({
      code: "card_declined",
      mandateUnsupported: false,
      adviceCode: "do_not_try_again",
      neutralReasonHints: ["transient"],
    })).toEqual({ failureClass: "hard_do_not_retry", decidedBy: "advice_code" });
  });

  it("reads the hints the adapter already translated", () => {
    expect(classifyDecline({
      code: "card_declined",
      mandateUnsupported: false,
      neutralReasonHints: ["limitExceeded"],
    })).toEqual({ failureClass: "soft_retry_delayed", decidedBy: "neutral_hint" });
  });

  it("answers indeterminate rather than guessing when the adapter asserted nothing", () => {
    // The generic reason key is the only evidence left, and it records THAT the
    // charge failed, never WHY. `indeterminate` is the honest reading.
    expect(classifyDecline({ code: "payment_failed", mandateUnsupported: false }))
      .toEqual({ failureClass: "indeterminate", decidedBy: "failure_reason_key" });
  });

  it("classifies against the reason key the CALLING rail actually persists", () => {
    // The reconciliation rail stores its own adapter-prefixed key on the
    // attempt, not `provider_declined`. That key decides nothing, so the honest
    // answer is `default` — claiming `failure_reason_key` would name a key the
    // row does not carry and make the verdict unreproducible from stored
    // evidence.
    expect(classifyDecline(
      { code: "card_declined", mandateUnsupported: false },
      { failureReasonKey: "reconciled_card_declined" },
    )).toEqual({ failureClass: "indeterminate", decidedBy: "default" });
  });

  it("leaves the override powerless against evidence that outranks a reason key", () => {
    expect(classifyDecline(
      { code: "card_declined", mandateUnsupported: false, neutralReasonHints: ["credentialDead"] },
      { failureReasonKey: "reconciled_card_declined" },
    )).toEqual({ failureClass: "hard_do_not_retry", decidedBy: "neutral_hint" });
  });

  it("keeps the seam's own reason key when no rail supplies one", () => {
    expect(classifyDecline({ code: "payment_failed", mandateUnsupported: false }, {}))
      .toEqual({ failureClass: "indeterminate", decidedBy: "failure_reason_key" });
  });
});
