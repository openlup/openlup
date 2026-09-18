import { describe, expect, it, vi } from "vitest";

import { applyPaymentResultRpc, resolvedFailureClassification } from "./applyPaymentResultRpc.js";

describe("applyPaymentResultRpc", () => {
  it("calls the apply_result RPC with the exact eight p_ args", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { paymentResult: { replayed: false } }, error: null });

    await applyPaymentResultRpc(
      { rpc },
      {
        idempotencyKey: "provider-webhook:stripe:evt_1:apply",
        paymentIntentId: "intent_1",
        paymentEventId: "evt_internal_1",
        resultStatus: "succeeded",
        occurredAt: "2026-06-29T12:00:00Z",
        failureReason: null,
      },
    );

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("commerce_payment_control_apply_result", {
      p_idempotency_key: "provider-webhook:stripe:evt_1:apply",
      p_payment_intent_id: "intent_1",
      p_payment_event_id: "evt_internal_1",
      p_result_status: "succeeded",
      p_occurred_at: "2026-06-29T12:00:00Z",
      p_failure_reason: null,
      // Additive and unclassified: a caller with no refusal in hand writes NULL
      // into both new parameters, which is what makes them additive.
      p_failure_class: null,
      p_failure_class_decided_by: null,
    });
  });

  it("forwards null paymentEventId and a failure reason verbatim (off-session failure shape)", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { paymentResult: {} }, error: null });

    await applyPaymentResultRpc(
      { rpc },
      {
        idempotencyKey: "subscription:sub_1:cycle:2026-07-01T00:00:00Z:payment-execution:apply-result",
        paymentIntentId: "intent_2",
        paymentEventId: null,
        resultStatus: "failed",
        occurredAt: "2026-06-29T12:00:00Z",
        failureReason: "card_declined",
      },
    );

    expect(rpc).toHaveBeenCalledWith("commerce_payment_control_apply_result", {
      p_idempotency_key: "subscription:sub_1:cycle:2026-07-01T00:00:00Z:payment-execution:apply-result",
      p_payment_intent_id: "intent_2",
      p_payment_event_id: null,
      p_result_status: "failed",
      p_occurred_at: "2026-06-29T12:00:00Z",
      p_failure_reason: "card_declined",
      p_failure_class: null,
      p_failure_class_decided_by: null,
    });
  });

  it("forwards a supplied classification into the two additive p_ args", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { paymentResult: {} }, error: null });

    await applyPaymentResultRpc(
      { rpc },
      {
        idempotencyKey: "k",
        paymentIntentId: "intent_4",
        paymentEventId: null,
        resultStatus: "failed",
        occurredAt: "2026-06-29T12:00:00Z",
        failureReason: "provider_declined",
        failureClassification: { failureClass: "mandate_dead", decidedBy: "neutral_hint" },
      },
    );

    expect(rpc).toHaveBeenCalledWith("commerce_payment_control_apply_result", {
      p_idempotency_key: "k",
      p_payment_intent_id: "intent_4",
      p_payment_event_id: null,
      p_result_status: "failed",
      p_occurred_at: "2026-06-29T12:00:00Z",
      p_failure_reason: "provider_declined",
      p_failure_class: "mandate_dead",
      p_failure_class_decided_by: "neutral_hint",
    });
  });

  it("returns the client's {data,error} result untouched — including a raw error for caller handling", async () => {
    const rawError = { code: "23505", message: "commerce_idempotency_conflict" };
    const rpc = vi.fn().mockResolvedValue({ data: null, error: rawError });

    const result = await applyPaymentResultRpc(
      { rpc },
      {
        idempotencyKey: "k",
        paymentIntentId: "intent_3",
        paymentEventId: "evt_3",
        resultStatus: "succeeded",
        occurredAt: "2026-06-29T12:00:00Z",
        failureReason: null,
      },
    );

    // The helper never wraps/classifies — the caller still sees the raw error
    // object (load-bearing: the webhook handler regex-matches error.message).
    expect(result).toEqual({ data: null, error: rawError });
    expect((result as { error: unknown }).error).toBe(rawError);
  });
});

describe("resolvedFailureClassification", () => {
  it("keeps a supplied classification untouched", () => {
    // The refusal paths classify from an advice code or a neutral hint, both of
    // which outrank a reason key. Re-deriving would LOSE that: the scheme-named
    // reason keys those paths persist are deliberately absent from the kernel.
    expect(
      resolvedFailureClassification(
        { failureClass: "mandate_dead", decidedBy: "neutral_hint" },
        "blik_recurring_unsupported_bank",
      ),
    ).toEqual({ failureClass: "mandate_dead", decidedBy: "neutral_hint" });
  });

  it("derives from the reason key when the caller has no refusal evidence", () => {
    expect(resolvedFailureClassification(null, "off_session_sca_required")).toEqual({
      failureClass: "sca_required",
      decidedBy: "failure_reason_key",
    });
    expect(resolvedFailureClassification(undefined, "payment_method_revoked")).toEqual({
      failureClass: "hard_do_not_retry",
      decidedBy: "failure_reason_key",
    });
  });

  it("answers `indeterminate` rather than nothing for an unmapped reason", () => {
    expect(resolvedFailureClassification(null, "a_reason_nobody_mapped")).toEqual({
      failureClass: "indeterminate",
      decidedBy: "default",
    });
  });
});
